import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { normalize, resolve } from "node:path";
import {
  applyOverride, assertPolicyOutsideWorkspace, ConfigError, DEFAULT_CONFIG, hostConfigPaths, hostConfigTargets, legacyConfigSources,
  normalizeConfigPath, parseEnvConfig, parseTomlConfig, readRawConfig, removeOverride,
  resolveConfig, toEffectiveToml, validateConfig, type ResolveConfigInput, type HostConfigPaths, type HostConfigTargets,
} from "./config.ts";
import { createSettingsSanitizer, type SettingsSanitizer } from "./settings-redaction.ts";
import { projectSettingsJson } from "./settings-json.ts";
import { COLLECTION_REMOVALS, SETTINGS_PATHS } from "./settings-metadata.ts";
import { classifySettingsEffect, type SettingsEffect } from "./settings-effect.ts";
import { SettingsConflictError } from "./settings-conflict.ts";
import { assertAnchor, atomicWrite, captureAnchor, readSource, type Source } from "./settings-storage.ts";
import type { Config, DeepPartial, ResolvedConfig } from "./types.ts";

export { COLLECTION_REMOVALS, SETTINGS_PATHS } from "./settings-metadata.ts";
export { classifySettingsEffect, LIVE_SETTINGS_KEYS, type SettingsEffect } from "./settings-effect.ts";
export { SettingsConflictError } from "./settings-conflict.ts";

export type SettingsScope = "temporary" | "project" | "global";
export interface SettingsChange { path: string; operation: "set" | "inherit"; before: unknown; after: unknown }
export interface SettingsPreview {
  changes: SettingsChange[];
  effect: SettingsEffect;
  effectiveToml: string;
  provenance: ResolvedConfig["provenance"];
  warnings: string[];
  /** Changed paths still owned by a higher-precedence layer after saving. */
  shadowed: string[];
  collections: SettingsCollectionIntent[];
}
export interface SettingsCollectionIntent {
  path: string;
  operation: "upsert" | "remove" | "replace" | "clear" | "inherit";
  identities: string[];
  previousIdentity?: string;
  source: string;
  sourcePath: string | null;
  promoted: boolean;
  shadowed: boolean;
}
/** Focused, sanitized display data; private comparisons happen before credentials are masked. */
export interface SettingsReviewDelta {
  entry?: string;
  field: string;
  before: unknown;
  after: unknown;
}
export interface SettingsReviewFocus {
  path: string;
  operation: "set" | "inherit" | "upsert" | "remove";
  identity?: string;
  previousIdentity?: string;
  targetBefore: "inherit" | "explicit";
  targetAfter: "inherit" | "explicit";
  baseline: "target" | "inherited";
  changed: boolean;
  effectiveChanged: boolean;
  deltas: SettingsReviewDelta[];
  inheritedDeltas: SettingsReviewDelta[];
  reconciledDeltas: SettingsReviewDelta[];
  shadowed: boolean;
  writableMount: boolean;
  hostCommand?: boolean;
  replacesEntry: boolean;
  hostBypass: string[];
}
interface EntryOrigin { source: string; path: string | null; rank: number }
interface EntryEdit {
  operation: "upsert" | "remove";
  identity: string;
  previousIdentity?: string;
  value?: unknown;
  origin: EntryOrigin;
}
interface DraftPatch { inherit: boolean; value?: unknown; entries?: EntryEdit[] }
const LAYER_RANK: Record<string, number> = { defaults: 0, global: 1, project: 1, env: 2, cli: 3, "host-default": 4, "host-project": 5, temporary: 7 };
const scopeRank = (scope: SettingsScope): number => scope === "global" ? 4 : scope === "project" ? 5 : 7;
const scopeSource = (scope: SettingsScope): string => scope === "global" ? "host-default" : scope === "project" ? "host-project" : "temporary";
function entryIdentity(path: string, entry: any): string {
  if (path === "secrets") return String(typeof entry === "object" ? entry?.env : entry);
  if (path === "mounts") {
    const guest = typeof entry === "object" ? entry?.guestPath ?? entry?.guest_path ?? ([undefined, "dir", "file"].includes(entry?.type) ? entry?.hostPath ?? entry?.host_path : undefined) : entry;
    return normalize(String(guest)).replace(/\/$/, "") || "/";
  }
  return String(entry);
}
function replayEntries(path: string, baseline: unknown[], edits: EntryEdit[]): unknown[] {
  let result = structuredClone(baseline);
  for (const edit of edits) {
    const index = result.findIndex((entry) => entryIdentity(path, entry) === (edit.previousIdentity ?? edit.identity));
    result = result.filter((entry) => ![edit.identity, edit.previousIdentity].includes(entryIdentity(path, entry)));
    if (edit.operation === "upsert") result.splice(index < 0 ? result.length : Math.min(index, result.length), 0, structuredClone(edit.value));
  }
  return result;
}
/** Collapse ordered CRUD into final entry intent, retaining rename lineage, not transient names. */
function finalEntryEdits(path: string, baseline: unknown[], edits: EntryEdit[]): EntryEdit[] {
  if (edits.length < 2) return edits;
  const original = new Map(baseline.map((value) => [entryIdentity(path, value), value]));
  const current = new Map([...original].map(([identity, value]) => [identity, { previousIdentity: identity, value, edit: undefined as EntryEdit | undefined }]));
  for (const edit of edits) {
    const selected = edit.previousIdentity ?? edit.identity;
    const prior = current.get(selected);
    current.delete(selected);
    current.delete(edit.identity);
    if (edit.operation === "upsert") current.set(edit.identity, {
      previousIdentity: prior?.previousIdentity ?? "",
      value: edit.value, edit: { ...edit, origin: prior?.edit?.origin ?? edit.origin },
    });
  }
  const final: EntryEdit[] = [];
  for (const [identity, entry] of current) {
    const before = original.get(entry.previousIdentity || identity);
    if (!entry.edit || before !== undefined && !reviewDeltas(path, [before], [entry.value]).length) continue;
    final.push({ ...entry.edit, identity, previousIdentity: entry.previousIdentity || identity, value: entry.value });
  }
  const retained = new Set([...current.values()].map((entry) => entry.previousIdentity));
  // A rename's focused comparison already includes an overwritten destination.
  for (const identity of original.keys()) if (!retained.has(identity) && !current.has(identity)) {
    const edit = edits.find((item) => item.identity === identity || item.previousIdentity === identity)!;
    final.push({ operation: "remove", identity, origin: edit.origin });
  }
  return final;
}
export interface SettingsSnapshot {
  scope: SettingsScope;
  path: string | null;
  revision: number;
  /** Raw target layer, with every secret source masked. */
  raw: Record<string, unknown>;
  effectiveToml: string;
  provenance: ResolvedConfig["provenance"];
  warnings: string[];
  automaticSandboxName: boolean;
}
export interface SettingsApplyResult extends SettingsPreview {
  saved: boolean;
  runtimeApplied: false;
  /** Private activation guard for an approval-bound commit; never serialize this result. */
  assertUnchanged?: () => Promise<void>;
}

const snake = (key: string): string => key.replace(/MiB/g, "Mib").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const canonical = (path: string): string => normalizeConfigPath(path).map(snake).join(".");
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function get(value: any, parts: string[]): any { for (const part of parts) value = value?.[part]; return value; }
const SECRET_SOURCES = ["textValue", "hostEnv", "hostCmd"] as const;
const maskedPlaceholder = (value: unknown): boolean => typeof value === "string" && /<redacted>|\[redacted\]/i.test(value);
const hasMaskedSource = (secret: Record<string, unknown>): boolean => SECRET_SOURCES.some((source) => maskedPlaceholder(secret[source]));
function masked(value: unknown, key = "", secret = false): any {
  const normalized = key.replace(/_/g, "").toLowerCase();
  if (normalized === "textvalue" || normalized === "value") return "<redacted>";
  if (Array.isArray(value)) return value.map((child) => masked(child, "", secret || normalized === "secrets"));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, masked(v, k, secret)]));
  return value;
}
/** Mask repeated literals too, without flattening machine-readable TOML. */
function sanitizePresentation<T extends { effectiveToml: string }>(value: T, sanitize: SettingsSanitizer, privateSources: unknown[]): T {
  const { effectiveToml, ...presentation } = value;
  return { ...sanitize(presentation, privateSources), effectiveToml: sanitize(effectiveToml, privateSources, "toml") } as T;
}
function rawValue(value: Record<string, unknown>, path: string[]): unknown {
  let current: any = value;
  for (const part of path) {
    if (!current || typeof current !== "object") return undefined;
    const key = Object.keys(current).find((key) => normalizeConfigPath(key)[0] === part);
    current = key === undefined ? undefined : current[key];
  }
  return current;
}
function patchRaw(raw: Record<string, unknown>, path: string[], value: unknown, inherit: boolean): void {
  const part = path[0]!;
  const key = Object.keys(raw).find((key) => normalizeConfigPath(key)[0] === part) ?? snake(part);
  if (path.length === 1) { if (inherit) delete raw[key]; else raw[key] = structuredClone(value); return; }
  if (!raw[key] || typeof raw[key] !== "object" || Array.isArray(raw[key])) raw[key] = {};
  patchRaw(raw[key] as Record<string, unknown>, path.slice(1), value, inherit);
}
/** Readable TOML retaining raw key spelling and unknown data, but not original comments/layout. */
export function serializeRaw(raw: Record<string, unknown>): string {
  const key = (name: string): string => /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
  const table = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const scalar = (value: unknown): string => {
    if (value === null || value === undefined) throw new ConfigError(["TOML cannot store null; use inherit instead"]);
    if (Array.isArray(value)) return `[${value.map(scalar).join(", ")}]`;
    if (table(value)) return `{ ${Object.entries(value).map(([k, v]) => `${key(k)} = ${scalar(v)}`).join(", ")} }`;
    return JSON.stringify(value);
  };
  // Empty tables must remain assignments: the reader only creates sections when a field is assigned.
  const section = (value: unknown): value is Record<string, unknown> => table(value) && Object.keys(value).length > 0;
  const blocks: string[] = [];
  const writeTable = (value: Record<string, unknown>, path: string[] = [], arrayEntry = false): void => {
    const entries = Object.entries(value);
    // Nested collections stay inline to match the reader's supported TOML subset.
    const arrayTable = (child: unknown): child is Record<string, unknown>[] => path.length === 0 && Array.isArray(child) && child.length > 0 && child.every(section);
    const fields = entries.filter(([, child]) => arrayEntry || (!section(child) && !arrayTable(child)))
      .map(([name, child]) => `${key(name)} = ${scalar(child)}`);
    const heading = path.map(key).join(".");
    blocks.push([...(path.length ? [arrayEntry ? `[[${heading}]]` : `[${heading}]`] : []), ...fields].join("\n"));
    if (arrayEntry) return;
    for (const [name, child] of entries) {
      if (section(child)) writeTable(child, [...path, name]);
      else if (arrayTable(child)) for (const item of child) writeTable(item, [...path, name], true);
    }
  };
  writeTable(raw);
  return blocks.filter(Boolean).join("\n\n") + "\n";
}
function reconcileRemovals(layer: Record<string, unknown>, collection: string, entries: unknown[]): SettingsChange | undefined {
  const path = COLLECTION_REMOVALS[collection];
  if (!path) return;
  const before = rawValue(layer, normalizeConfigPath(path));
  if (!Array.isArray(before)) return;
  const identity = (entry: unknown) => entryIdentity(collection, entry);
  const included = new Set(entries.map(identity));
  const after = before.filter((entry) => !included.has(identity(entry)));
  if (equal(before, after)) return;
  patchRaw(layer, normalizeConfigPath(path), after, false);
  return { path, operation: "set", before: masked(before), after: masked(after) };
}
function safeSettingsValue(path: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  const container: Record<string, unknown> = {};
  patchRaw(container, normalizeConfigPath(path), value, false);
  return rawValue(projectSettingsJson(container), normalizeConfigPath(path));
}
/** Compare private native values, emitting only changed supported fields with safe credentials. */
function reviewDeltas(path: string, before: unknown, after: unknown, previousIdentity?: string, identity?: string, entries?: EntryEdit[]): SettingsReviewDelta[] {
  const deltas: SettingsReviewDelta[] = [];
  if (path === "secrets" || path === "mounts") {
    const old = Array.isArray(before) ? before : [];
    const next = Array.isArray(after) ? after : [];
    if (before !== undefined && !Array.isArray(before)) deltas.push({ field: path, before: "<invalid>", after: undefined });
    const safeEntry = (entry: unknown): Record<string, unknown> | undefined => {
      if (entry === undefined) return undefined;
      const safe = (safeSettingsValue(path, [entry]) as unknown[])[0];
      return safe && typeof safe === "object" ? safe as Record<string, unknown> : undefined;
    };
    const safeIdentity = (entry: unknown): string => {
      const safe = safeEntry(entry);
      return safe ? entryIdentity(path, safe) : "<invalid>";
    };
    const remaining = new Set(old);
    for (const b of next) {
      const id = entryIdentity(path, b);
      const previous = entries?.find((entry) => entry.operation === "upsert" && entry.identity === id)?.previousIdentity;
      const a = old.find((item) => entryIdentity(path, item) === (previous ?? (id === identity ? previousIdentity ?? id : id)));
      remaining.delete(a);
      compare(a, b, safeIdentity(b));
    }
    for (const a of remaining) compare(a, undefined, safeIdentity(a));
    const oldOrder = old.map((item) => entryIdentity(path, item));
    const nextOrder = next.map((item) => entryIdentity(path, item));
    if (oldOrder.length === nextOrder.length && oldOrder.every((id) => nextOrder.includes(id)) && !equal(oldOrder, nextOrder)) deltas.push({ field: "entry order", before: old.map(safeIdentity), after: next.map(safeIdentity) });
    function compare(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined, entry: string) {
      const fields = path === "secrets" ? ["env", "allowHosts", ...SECRET_SOURCES] : ["type", "hostPath", "guestPath", "readonly", "options"];
      const safeBefore = safeEntry(a); const safeAfter = safeEntry(b);
      if (a !== undefined && !safeBefore) deltas.push({ entry, field: path, before: "<invalid>", after: undefined });
      for (const field of fields) if (!equal(a?.[field], b?.[field])) deltas.push({ entry, field: field === "textValue" ? "credential" : snake(field), before: safeBefore?.[snake(field)], after: safeAfter?.[snake(field)] });
    }
  } else if (!equal(before, after)) deltas.push({ field: path, before: safeSettingsValue(path, before), after: safeSettingsValue(path, after) });
  return deltas;
}
/** Recognize only the reader's single-line value subset; unsupported syntax needs a host edit. */
function assertRecoveryValue(input: string): void {
  let at = 0;
  const fail = (): never => { throw new ConfigError(["Manual host edit required: malformed or unsupported configuration syntax"]); };
  const space = () => { while (/\s/.test(input[at] ?? "") && at < input.length) at++; };
  const quoted = () => {
    const quote = input[at++]!;
    while (at < input.length) {
      const c = input[at++]!;
      if (c === quote) return;
      if (quote === '"' && c === "\\") {
        const escape = input[at++];
        if (!escape || !'btnfr"\\uU'.includes(escape)) fail();
        if (escape === "u" || escape === "U") {
          const count = escape === "u" ? 4 : 8;
          if (!new RegExp(`^[0-9a-fA-F]{${count}}$`).test(input.slice(at, at + count))) fail();
          at += count;
        }
      }
    }
    fail();
  };
  const key = () => {
    space();
    if (input[at] === '"' || input[at] === "'") quoted();
    else {
      const match = /^[A-Za-z0-9_-]+/.exec(input.slice(at));
      if (!match) fail();
      at += match![0].length;
    }
    space();
    if (input[at] === ".") { at++; key(); }
  };
  const value = (): void => {
    space();
    const c = input[at];
    if (c === '"' || c === "'") { quoted(); return; }
    if (c === "[" || c === "{") {
      at++;
      const end = c === "[" ? "]" : "}";
      space();
      while (input[at] !== end) {
        if (c === "{") { key(); if (input[at++] !== "=") fail(); }
        value(); space();
        if (input[at] === end) break;
        if (input[at++] !== ",") fail();
        space();
      }
      at++; return;
    }
    const match = /^(?:true|false|[+-]?(?:inf|nan|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))(?=\s|[,\]}]|$)/.exec(input.slice(at));
    if (!match) fail();
    at += match![0].length;
  };
  value(); space();
  if (at !== input.length) fail();
}
/** Conservative source syntax check: never reconstruct an unclosed TOML value. */
function recoveryRaw(text: string): Record<string, unknown> {
  for (const line of text.split(/\r?\n/)) {
    let quote = "";
    let assignment = -1;
    let end = line.length;
    const stack: string[] = [];
    for (let index = 0; index < line.length; index++) {
      const c = line[index]!;
      if (quote) {
        if (quote === '"' && c === "\\") { index++; continue; }
        if (c === quote) quote = "";
      } else if (c === "#") { end = index; break; }
      else if (c === "=" && !stack.length && assignment < 0) assignment = index;
      else if (c === '"' || c === "'") quote = c;
      else if (c === "[" || c === "{") stack.push(c);
      else if (c === "]" || c === "}") {
        if (stack.pop() !== (c === "]" ? "[" : "{")) throw new ConfigError(["Manual host edit required: malformed configuration syntax"]);
      }
    }
    if (quote || stack.length) throw new ConfigError(["Manual host edit required: malformed configuration syntax"]);
    if (assignment >= 0) assertRecoveryValue(line.slice(assignment + 1, end));
  }
  return readRawConfig(text);
}
/** Include overwritten assignments as private inputs, not only the parser's final values. */
function environmentPrivacy(env: NodeJS.ProcessEnv): unknown[] {
  return Object.entries(env).flatMap(([key, value]) => {
    if (!key.startsWith("PI_MSB_") || value === undefined) return [];
    if (/__(?:TEXT_?VALUE|VALUE)$/i.test(key)) return [{ textValue: value }];
    try { return [JSON.parse(value)]; } catch { return []; }
  });
}
function sourcePrivacy(texts: Array<string | null>): unknown[] {
  return texts.flatMap((text) => {
    const inputs: unknown[] = [];
    // Assignment tokens also catch repeated fields inside inline tables and quoted keys.
    const assignments = /("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,"'\[\]{}#]+)/g;
    for (const match of (text ?? "").matchAll(assignments)) {
      try {
        inputs.push(readRawConfig(`${match[1]} = ${match[2]}`));
        // Keep the exact token as well as its parsed (possibly rounded) value.
        const key = match[1]!.replace(/^["']|["']$/g, "").replace(/_/g, "").toLowerCase();
        if (key === "textvalue" || key === "value") inputs.push({ textValue: match[2] });
      } catch { /* No raw errors are public. */ }
    }
    for (const line of (text ?? "").split(/\r?\n/)) {
      try { inputs.push(readRawConfig(line)); } catch { /* Partial lines are privacy-only. */ }
    }
    return inputs;
  });
}
/** Sparse layers cannot decide cross-layer network policy. Full resolution still validates it. */
function validateLayerValues(value: DeepPartial<Config>): void {
  try { validateConfig(value); }
  catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    const issues = error.issues.filter((issue) => issue !== "network: allowlist needs a host or DNS permission");
    if (issues.length) throw new ConfigError(issues);
  }
}
/** Private raw/secret data stays in this object; snapshots and diffs are always masked. */
export class SettingsDraft {
  #editor: SettingsEditor;
  #source: Source;
  #revision: number;
  #contextRevision: number;
  #base: ResolvedConfig;
  #scopeBase?: ResolvedConfig;
  #recovery: boolean;
  #policyPaths: HostConfigPaths;
  #closed = false;
  #reviewState: string;
  #sanitize: SettingsSanitizer;
  #approval?: { state: string; patch: string; candidate: string; afterCommit: () => Promise<void> };
  #patch = new Map<string, DraftPatch>();
  readonly scope: SettingsScope;
  readonly path: string | null;
  constructor(editor: SettingsEditor, scope: SettingsScope, path: string | null, source: Source, revision: number, base: ResolvedConfig, policyPaths: HostConfigPaths, reviewState: string, sanitize: SettingsSanitizer, recovery = false) {
    this.#recovery = recovery;
    this.#editor = editor; this.scope = scope; this.path = path; this.#source = source; this.#revision = revision; this.#contextRevision = editor.contextRevision; this.#base = base; this.#policyPaths = policyPaths; this.#reviewState = reviewState; this.#sanitize = sanitize;
  }
  /** Report the lexical policy location independently of canonical I/O paths. */
  get #policyPath(): string | null { return this.scope === "temporary" ? null : this.#policyPaths[this.scope]!; }
  snapshot(): SettingsSnapshot {
    const raw = structuredClone(this.#source.raw);
    delete raw._repository;
    for (const [path, patch] of this.#patch) patchRaw(raw, normalizeConfigPath(path), patch.entries ? replayEntries(path, this.#ownCollection(path) ?? [], patch.entries) : patch.value, patch.inherit);
    return sanitizePresentation({ scope: this.scope, path: this.path, revision: this.#revision, raw: masked(raw), effectiveToml: this.#recovery ? "" : toEffectiveToml(this.#base), provenance: this.#recovery ? {} : { ...this.#base.provenance }, warnings: this.#recovery ? ["Configuration invalid; draft baseline excludes the selected target. Full validation is required before saving."] : [...this.#base.warnings], automaticSandboxName: this.#base.config.sandboxName === null }, this.#sanitize, [raw, this.#base.config]);
  }
  set(path: string, value: unknown): void {
    this.#assertOpen();
    const key = canonical(path);
    if (!SETTINGS_PATHS.includes(key)) throw new ConfigError(["unknown editable setting"]);
    // Assert prototype safety before retaining user data.
    applyOverride({}, key, value);
    if (value === undefined) throw new ConfigError(["use inherit to remove a setting"]);
    if (key === "secrets" && Array.isArray(value) && value.some((secret) => secret && hasMaskedSource(secret))) {
      throw new ConfigError(["masked secret placeholders cannot be saved; use secret CRUD to retain a value"]);
    }
    this.#patch.set(key, { inherit: false, value: structuredClone(value) });
  }
  inherit(path: string): void {
    this.#assertOpen();
    const key = canonical(path);
    if (!SETTINGS_PATHS.includes(key)) throw new ConfigError(["unknown editable setting"]);
    this.#patch.set(key, { inherit: true });
  }
  /** Refresh a retained draft after same-identity lifecycle actions, retaining private dirty edits. */
  async refresh(): Promise<SettingsDraft> {
    if (this.#closed) throw new ConfigError(["settings draft is closed"]);
    this.#editor.assertContextRevision(this.#contextRevision);
    await assertAnchor(this.#source.anchor);
    return this.#transfer(await this.#editor.open(this.scope));
  }
  sharedProject(): Promise<{ repositoryName: string } | undefined> { return this.#editor.sharedProject(); }
  /** Rebase only deliberate dirty edits onto another scope; original draft remains unchanged. */
  async forScope(scope: SettingsScope): Promise<SettingsDraft> {
    this.#assertOpen();
    await assertAnchor(this.#source.anchor);
    return this.#transfer(await this.#editor.open(scope));
  }
  async #transfer(target: SettingsDraft): Promise<SettingsDraft> {
    try {
      for (const [path, patch] of this.#patch) {
        if (patch.entries) {
          const entries = structuredClone(patch.entries);
          target.#patch.set(path, { inherit: false, entries });
        } else if (patch.inherit) target.inherit(path);
        else {
          const value = structuredClone(patch.value);
          target.set(path, value);
        }
      }
      this.#editor.assertContextRevision(this.#contextRevision);
      return target;
    } catch (error) { target.discard(); throw error; }
  }
  /** CRUD retains identity-level intent; it never exports unrelated effective entries across scopes. */
  upsertSecret(secret: Config["secrets"][number], previousEnv = secret.env): void {
    this.#assertOpen();
    // Reject removed sources before source retention can discard the supplied field.
    if (Object.keys(secret).some((key) => normalizeConfigPath(key)[0] === "value")) validateConfig({ secrets: [secret] });
    const visible = (this.#visibleCollection("secrets") as Config["secrets"]).find((entry) => entry.env === previousEnv);
    const patch = this.#patch.get("secrets");
    // A hidden target-owned credential may be retained, but never resurrect discarded intent.
    const mayRetainOwned = !patch || !!patch.entries && !patch.entries.some((entry) => entry.identity === previousEnv || entry.previousIdentity === previousEnv);
    const owned = !visible && mayRetainOwned ? (this.#ownCollection("secrets") as Config["secrets"] | undefined)?.find((entry) => entry.env === previousEnv) : undefined;
    const prior = visible ?? owned;
    const ownedOrigin: EntryOrigin | undefined = owned ? { source: scopeSource(this.scope), path: this.#policyPath, rank: scopeRank(this.scope) } : undefined;
    const suppliedSources = SECRET_SOURCES.filter((source) => Object.hasOwn(secret, source));
    if (suppliedSources.length > 1 || suppliedSources.some((source) => typeof secret[source] !== "string")) throw new ConfigError(["secrets require exactly one string source: textValue, hostEnv or hostCmd"]);
    const sourceEntry = suppliedSources.length ? secret : prior;
    const selectedSources = SECRET_SOURCES.filter((source) => sourceEntry?.[source] !== undefined);
    if (selectedSources.length !== 1) throw new ConfigError(["new secrets require exactly one source: textValue, hostEnv or hostCmd"]);
    const source = selectedSources[0]!;
    const previous = this.#latestEntry("secrets", previousEnv);
    this.#editEntry("secrets", {
      operation: "upsert", identity: secret.env, previousIdentity: previousEnv,
      value: { env: secret.env, allowHosts: secret.allowHosts, [source]: sourceEntry![source] },
      origin: previous?.origin ?? ownedOrigin ?? this.#origin("secrets", previousEnv),
    });
  }
  removeSecret(env: string): void { this.#removeEntry("secrets", env); }
  upsertMount(mount: Config["mounts"][number], previousGuest = mount.guestPath): void {
    this.#assertOpen();
    const identity = entryIdentity("mounts", mount);
    const previous = previousGuest === undefined ? identity : entryIdentity("mounts", previousGuest);
    this.#editEntry("mounts", { operation: "upsert", identity, previousIdentity: previous, value: mount, origin: this.#latestEntry("mounts", previous)?.origin ?? this.#origin("mounts", previous) });
  }
  removeMount(guest: string): void { this.#removeEntry("mounts", entryIdentity("mounts", guest)); }
  upsertListEntry(path: string, value: string, previousValue = value): void {
    this.#assertListPath(path);
    this.#editEntry(canonical(path), { operation: "upsert", identity: value, previousIdentity: previousValue, value, origin: this.#latestEntry(canonical(path), previousValue)?.origin ?? this.#origin(canonical(path), previousValue) });
  }
  removeListEntry(path: string, value: string): void { this.#assertListPath(path); this.#removeEntry(canonical(path), value); }
  #assertListPath(path: string): void {
    this.#assertOpen();
    if (!COLLECTION_REMOVALS[canonical(path)] || ["secrets", "mounts"].includes(canonical(path))) throw new ConfigError(["not an editable scalar list"]);
  }
  #latestEntry(path: string, identity: string): EntryEdit | undefined { return this.#patch.get(path)?.entries?.slice().reverse().find((entry) => entry.identity === identity && entry.operation === "upsert"); }
  #removeEntry(path: string, identity: string): void {
    this.#assertOpen();
    this.#editEntry(path, { operation: "remove", identity, origin: this.#latestEntry(path, identity)?.origin ?? this.#origin(path, identity) });
  }
  #editEntry(path: string, edit: EntryEdit): void {
    this.#assertOpen();
    applyOverride({}, path, edit.operation === "upsert" ? [edit.value] : []);
    if (path === "secrets" && edit.operation === "upsert" && hasMaskedSource(edit.value as unknown as Record<string, unknown>)) throw new ConfigError(["masked secret placeholders cannot be saved"]);
    const patch = this.#patch.get(path);
    if (patch && !patch.entries && !patch.inherit) {
      // An explicit replacement remains explicit when subsequently edited.
      this.set(path, replayEntries(path, patch.value as unknown[], [edit]));
    } else this.#patch.set(path, { inherit: false, entries: [...(patch?.entries ?? []), structuredClone(edit)] });
  }
  #origin(path: string, identity: string): EntryOrigin {
    if (!this.#visibleCollection(path).some((entry) => entryIdentity(path, entry) === identity)) return { source: "new entry", path: this.#policyPath, rank: 0 };
    const key = path === "secrets" || path === "mounts" ? `${path}[${identity}]` : normalizeConfigPath(path).join(".");
    const owned = this.#recovery && this.#ownCollection(path)?.some((entry) => entryIdentity(path, entry) === identity);
    const source = owned ? scopeSource(this.scope) : this.#base.provenance[key] ?? "defaults";
    return { source, path: source === "host-project" ? this.#policyPaths.project : source === "host-default" ? this.#policyPaths.global : null, rank: LAYER_RANK[source] ?? 0 };
  }
  #ownCollection(path: string): unknown[] | undefined {
    const ownRaw = rawValue(this.#source.raw, normalizeConfigPath(path));
    if (ownRaw === undefined) return;
    const container = {};
    patchRaw(container, normalizeConfigPath(path), ownRaw, false);
    return get(parseTomlConfig(serializeRaw(container), "global").value, normalizeConfigPath(path));
  }
  #baselineCollection(path: string, base: ResolvedConfig): unknown[] {
    const owned = this.#recovery ? this.#ownCollection(path) : undefined;
    const items = structuredClone(owned ?? get(base.config, normalizeConfigPath(path))) as any[];
    if (path === "secrets" || path === "mounts") {
      const own = this.#ownCollection(path);
      if (Array.isArray(own)) for (let index = 0; index < items.length; index++) {
        const identity = entryIdentity(path, items[index]);
        const expected = scopeSource(this.scope);
        const original = own.find((entry: unknown) => entryIdentity(path, entry) === identity);
        if (original && base.provenance[`${path}[${identity}]`] === expected) items[index] = { ...items[index], ...original };
      }
    }
    return items;
  }
  #visibleCollection(path: string): unknown[] {
    const patch = this.#patch.get(path);
    if (patch?.entries) return replayEntries(path, this.#baselineCollection(path, this.#base), patch.entries);
    if (patch && !patch.inherit) return structuredClone(patch.value) as unknown[];
    return this.#baselineCollection(path, this.#base);
  }
  #patchValue(path: string, patch: DraftPatch): unknown {
    return patch.entries ? replayEntries(path, this.#baselineCollection(path, this.#scopeBase!), patch.entries) : patch.value;
  }
  #assertOpen(): void {
    if (this.#closed) throw new ConfigError(["settings draft is closed"]);
    this.#editor.assertRevision(this.#revision);
  }
  discard(): void {
    this.#approval = undefined; this.#reviewState = ""; this.#sanitize = (value) => value;
    this.#patch.clear(); this.#source = { text: null, raw: {}, version: "closed" };
    this.#base = { config: structuredClone(DEFAULT_CONFIG) as Config, provenance: {}, warnings: [] };
    this.#scopeBase = this.#base;
    this.#closed = true;
  }
  async preview(runtimeBaseline?: Config): Promise<SettingsPreview> {
    const candidate = await this.#candidate(runtimeBaseline);
    return sanitizePresentation(candidate.preview, this.#sanitize, [this.#source.raw, this.#base.config, candidate.next.config]);
  }
  /** Private human-only appendix. Never serialize these raw command sources in tool results. */
  async hostCommandsForApproval(): Promise<string[]> {
    this.#assertOpen();
    const approval = this.#approval;
    if (!approval || approval.patch !== JSON.stringify([...this.#patch])) throw new SettingsConflictError();
    await this.#assertReviewState(approval.state);
    const candidate = await this.#candidate();
    if (approval !== this.#approval || approval.patch !== JSON.stringify([...this.#patch])
      || approval.candidate !== hash(JSON.stringify(candidate.next))) throw new SettingsConflictError();
    await this.#assertReviewState(approval.state);
    const patch = this.#patch.get("secrets");
    let secrets: unknown[] = this.#recovery ? candidate.next.config.secrets : patch?.entries
      ? patch.entries.filter((entry) => entry.operation === "upsert").map((entry) => entry.value)
      : Array.isArray(patch?.value) ? patch.value : [];
    if (patch?.inherit && !this.#recovery) secrets = (await this.#editor.resolveCandidate(this.path, this.path ? serializeRaw(candidate.raw) : null, {}, this.scope)).config.secrets;
    return [...new Set(secrets.flatMap((secret: any) => typeof secret?.hostCmd === "string" ? [secret.hostCmd] : []))];
  }
  /** Bind the complete source state and private intent to this exact review; never rebase approval. */
  async reviewForApproval(effect: SettingsEffect, adoptedRuntime?: unknown): Promise<Record<string, unknown>> {
    await this.#assertReviewState(this.#reviewState);
    const candidate = await this.#candidate();
    await this.#assertReviewState(this.#reviewState);
    this.#approval = {
      state: this.#reviewState, patch: JSON.stringify([...this.#patch]), candidate: hash(JSON.stringify(candidate.next)),
      afterCommit: await this.#editor.guardAfterCommit(this.#reviewState, this.path, this.path ? serializeRaw(candidate.raw) : null, candidate.next, this.#recovery ? this.scope : undefined),
    };
    const { effectiveToml: _privateToml, ...preview } = candidate.preview;
    preview.changes = preview.changes.map((change) => ({ ...change,
      before: safeSettingsValue(change.path, change.before) ?? null,
      after: safeSettingsValue(change.path, change.after) ?? null,
    }));
    const focus: SettingsReviewFocus[] = [];
    for (const [path, patch] of this.#patch) {
      const parts = normalizeConfigPath(path);
      const own = COLLECTION_REMOVALS[path] ? this.#ownCollection(path) : rawValue(this.#source.raw, parts);
      const after = patch.inherit ? undefined : this.#patchValue(path, patch);
      const entryBaseline = patch.entries ? this.#baselineCollection(path, this.#scopeBase!) : [];
      const natives = patch.entries ? finalEntryEdits(path, entryBaseline, patch.entries) : [];
      const oldOrder = entryBaseline.map((entry) => entryIdentity(path, entry));
      const nextOrder = patch.entries ? (after as unknown[]).map((entry) => entryIdentity(path, entry)) : [];
      const reordered = oldOrder.length === nextOrder.length && oldOrder.every((id) => nextOrder.includes(id)) && !equal(oldOrder, nextOrder);
      const native = natives.length === 1 && !reordered ? natives[0] : undefined;
      const batch = !!patch.entries && !native;
      let before = batch ? entryBaseline : own;
      let focusedAfter = after;
      let baseline: SettingsReviewFocus["baseline"] = "target";
      let replacesEntry = false;
      if (!patch.entries && COLLECTION_REMOVALS[path] && own === undefined && !patch.inherit) {
        const scopeBase = this.#recovery || this.scope === "temporary" ? this.#base : await this.#editor.resolveCandidate(null, null, {}, this.scope);
        before = get(scopeBase.config, parts);
        baseline = "inherited";
      }
      if (native) {
        const selected = native.previousIdentity ?? native.identity;
        const owned = (own as unknown[] | undefined)?.find((item) => entryIdentity(path, item) === selected);
        const inheritedEntries = this.#baselineCollection(path, this.#scopeBase!);
        const inherited = inheritedEntries.find((item) => entryIdentity(path, item) === selected);
        baseline = owned === undefined ? "inherited" : "target";
        const collision = native.identity !== selected ? ((own as unknown[] | undefined)?.find((item) => entryIdentity(path, item) === native.identity)
          ?? inheritedEntries.find((item) => entryIdentity(path, item) === native.identity)) : undefined;
        replacesEntry = collision !== undefined;
        before = [owned ?? inherited, collision].filter((item) => item !== undefined);
        focusedAfter = (after as unknown[]).filter((item) => entryIdentity(path, item) === native.identity);
      }
      if (batch) {
        baseline = own === undefined ? "inherited" : "target";
        replacesEntry = natives.some((entry) => entry.operation === "upsert" && entry.identity !== entry.previousIdentity
          && (before as unknown[]).some((item) => entryIdentity(path, item) === entry.identity));
      }
      const desiredBefore = this.#recovery ? own : get(this.#base.config, parts);
      const desiredAfter = get(candidate.next.config, parts);
      const bypassSetting = ["pass_through_tools", "block_third_party", "allow_skill_reads", "allow_host_execution", "fallback_mode"].includes(path);
      // Whole-collection comparison omits equal siblings; consequences must too.
      let consequenceAfter = batch ? (after as unknown[]).filter((item) => natives.some((entry) => entry.operation === "upsert" && entry.identity === entryIdentity(path, item))) : focusedAfter;
      if (patch.inherit && (["mounts", "secrets"].includes(path) || bypassSetting)) {
        // Review inherited target-scope policy even when higher layers currently shadow it.
        const inherited = this.scope === "temporary" ? candidate.next
          : await this.#editor.resolveCandidate(this.path, serializeRaw(candidate.raw), {}, this.scope);
        consequenceAfter = get(inherited.config, parts);
      }
      const changed = preview.changes.some((change) => change.path === path || change.path === COLLECTION_REMOVALS[path]);
      const dangerous = (value: unknown): boolean => path === "pass_through_tools" ? Array.isArray(value) && value.length > 0
        : path === "block_third_party" ? value === false : path === "fallback_mode" ? value === "host" : value === true;
      focus.push({
        path, operation: native?.operation ?? (patch.inherit ? "inherit" : "set"), identity: native?.identity, previousIdentity: native?.previousIdentity,
        targetBefore: own === undefined ? "inherit" : "explicit", targetAfter: patch.inherit || !changed && own === undefined ? "inherit" : "explicit", baseline,
        changed, replacesEntry, effectiveChanged: !equal(desiredBefore, desiredAfter),
        deltas: changed ? reviewDeltas(path, before, focusedAfter, native?.previousIdentity, native?.identity, batch ? natives : undefined) : [],
        inheritedDeltas: patch.inherit ? reviewDeltas(path, desiredBefore, desiredAfter) : [],
        reconciledDeltas: preview.changes.filter((change) => change.path === COLLECTION_REMOVALS[path]).map((change) => ({ field: change.path, before: change.before, after: change.after })),
        shadowed: (LAYER_RANK[candidate.next.provenance[parts.join(".")] ?? ""] ?? 0) > scopeRank(this.scope),
        writableMount: path === "mounts" && changed && Array.isArray(consequenceAfter) && consequenceAfter.some((mount) => ["dir", "file"].includes(mount.type) && !mount.readonly),
        hostCommand: path === "secrets" && changed && Array.isArray(consequenceAfter) && consequenceAfter.some((secret) => typeof secret.hostCmd === "string"),
        hostBypass: bypassSetting && (dangerous(consequenceAfter) || dangerous(after) || dangerous(desiredAfter) || dangerous(own)) ? [path] : [],
      });
    }
    await this.#assertReviewState(this.#reviewState);
    const activationPolicy = this.#recovery ? {
      ...projectSettingsJson(Object.fromEntries(["autoStart", "image", "network", "hostEnv", "mounts", "fallbackMode", "passThroughTools", "blockThirdParty", "allowHostExecution", "allowSkillReads"].map((key) => [key, candidate.next.config[key as keyof Config]]))),
      secrets: candidate.next.config.secrets.map((secret) => ({ env: secret.env, allow_hosts: [...secret.allowHosts],
        source: secret.hostCmd !== undefined ? "hostCmd" : secret.hostEnv !== undefined ? "hostEnv" : "literal",
        ...(secret.hostEnv !== undefined ? { host_env: secret.hostEnv } : {}),
      })),
      writable_mounts: projectSettingsJson({ mounts: candidate.next.config.mounts.filter((mount) => !mount.readonly) }).mounts,
      host_command_count: candidate.next.config.secrets.filter((secret) => typeof secret.hostCmd === "string").length,
    } : undefined;
    if (activationPolicy && !equal(activationPolicy, this.#sanitize(activationPolicy, [this.#source.raw, this.#base.config, candidate.raw, candidate.temporary, candidate.next.config]))) {
      this.#approval = undefined;
      throw new ConfigError(["Recovery activation policy cannot be fully disclosed safely; manually repair host configuration"]);
    }
    return this.#sanitize({
      focus, mayStart: candidate.next.config.autoStart && !!adoptedRuntime && typeof adoptedRuntime === "object" && "status" in adoptedRuntime && adoptedRuntime.status !== "active",
      adoptedRuntime, ...preview, effect, scope: this.scope === "temporary" ? "session" : this.scope,
      storage: { before: projectSettingsJson(this.#source.raw), changes: preview.changes },
      desired: { before: this.#recovery ? null : projectSettingsJson(this.#base.config), after: projectSettingsJson(candidate.next.config) },
      ...(this.#recovery ? { recovery: {
        configurationValid: false,
        reason: "Original configuration is invalid; before values describe exact target intent, not virtual defaults.",
        activationPolicy,
      } } : {}),
    }, [this.#source.raw, this.#base.config, candidate.raw, candidate.temporary, candidate.next.config]);
  }
  async #assertReviewState(expected: string): Promise<void> {
    try {
      this.#assertOpen();
      if (expected !== await this.#editor.reviewState(this.#recovery ? this.scope : undefined)) throw new SettingsConflictError();
      this.#assertOpen();
    } catch { throw new SettingsConflictError(); }
  }
  async apply(options?: { guard?: () => void }): Promise<SettingsApplyResult> {
    const guard = async (resolved?: ResolvedConfig) => {
      options?.guard?.();
      if (this.#approval) {
        if (this.#approval.patch !== JSON.stringify([...this.#patch])) throw new SettingsConflictError();
        await this.#assertReviewState(this.#approval.state);
        if (resolved && this.#approval.candidate !== hash(JSON.stringify(resolved))) throw new SettingsConflictError();
      }
      options?.guard?.();
    };
    await guard();
    const candidate = await this.#candidate();
    await guard(candidate.next);
    if (!candidate.preview.changes.length) return sanitizePresentation({ ...candidate.preview, saved: false, runtimeApplied: false as const }, this.#sanitize, [this.#source.raw, this.#base.config, candidate.next.config]);
    const next = await this.#editor.commit(this.#revision, this.scope, this.path, this.#source, candidate.raw, candidate.temporary, guard, this.#recovery);
    const preview = this.#preview(candidate.preview.changes, next);
    const assertUnchanged = this.#approval?.afterCommit;
    const result = sanitizePresentation({ ...preview, saved: true, runtimeApplied: false as const, assertUnchanged }, this.#sanitize, [this.#source.raw, this.#base.config, next.config]);
    this.discard();
    return result;
  }
  async #candidate(runtimeBaseline?: Config) {
    try { return await this.#candidatePrivate(runtimeBaseline); }
    catch (error) {
      if (error instanceof ConfigError) throw new ConfigError(this.#sanitize([...error.issues], [this.#source.raw, this.#base.config]));
      throw error;
    }
  }
  async #candidatePrivate(runtimeBaseline?: Config) {
    this.#assertOpen();
    await assertAnchor(this.#source.anchor);
    if ([...this.#patch.values()].some((patch) => patch.entries)) {
      this.#scopeBase = this.#recovery ? this.#base : this.scope === "temporary" ? this.#base : await this.#editor.resolveCandidate(null, null, {}, this.scope);
      this.#assertOpen();
    }
    const raw = structuredClone(this.#source.raw);
    let temporary = this.#editor.temporary();
    const changes: SettingsChange[] = [];
    for (const [path, patch] of this.#patch) {
      const parts = normalizeConfigPath(path);
      const before = this.scope === "temporary" ? get(temporary, parts) : rawValue(raw, parts);
      const value = this.#patchValue(path, patch);
      if (patch.entries && equal(value, this.#baselineCollection(path, this.#scopeBase!))) continue;
      if (patch.inherit && before === undefined) continue;
      const unchanged = !patch.inherit && equal(before, value);
      if (this.scope === "temporary") temporary = patch.inherit ? removeOverride(temporary, path) : applyOverride(temporary, path, value);
      else patchRaw(raw, parts, value, patch.inherit);
      if (!patch.inherit && Array.isArray(value)) {
        const layer = this.scope === "temporary" ? temporary as Record<string, unknown> : raw;
        const reconciliation = reconcileRemovals(layer, path, value);
        if (reconciliation) changes.push(reconciliation);
      }
      if (!unchanged) changes.push({ path, operation: patch.inherit ? "inherit" : "set", before: masked(before), after: masked(value, path === "secrets" ? "" : path) });
    }
    const text = this.scope === "temporary" ? null : serializeRaw(raw);
    // Validate the target even if a higher policy shadows an invalid value.
    validateLayerValues(this.scope === "temporary" ? temporary : parseTomlConfig(text!, "global").value);
    if (this.#recovery) await this.#editor.validateRecoveryLayers(this.scope, this.path, text, temporary);
    const next = await this.#editor.resolveCandidate(this.path, text, temporary);
    return { raw, temporary, next, preview: this.#preview(changes, next, runtimeBaseline) };
  }
  #preview(changes: SettingsChange[], next: ResolvedConfig, runtimeBaseline = this.#base.config): SettingsPreview {
    const targetRank = scopeRank(this.scope);
    const collections: SettingsCollectionIntent[] = [];
    for (const [path, patch] of this.#patch) {
      if (!COLLECTION_REMOVALS[path]) continue;
      const owner = (identity: string): string | undefined => next.provenance[path === "secrets" || path === "mounts" ? `${path}[${identity}]` : normalizeConfigPath(path).join(".")] ?? next.provenance[normalizeConfigPath(path).join(".")];
      const higher = (identity: string): boolean => (LAYER_RANK[owner(identity) ?? ""] ?? 0) > targetRank;
      if (patch.entries) for (const entry of finalEntryEdits(path, this.#baselineCollection(path, this.#scopeBase!), patch.entries)) {
        const present = (get(next.config, normalizeConfigPath(path)) as unknown[]).some((item) => entryIdentity(path, item) === entry.identity);
        collections.push({ path, operation: entry.operation, identities: [entry.identity], previousIdentity: entry.previousIdentity, source: entry.origin.source, sourcePath: entry.origin.path, promoted: entry.operation === "upsert" && entry.origin.rank > targetRank, shadowed: higher(entry.identity) && (entry.operation === "upsert" || present) });
      } else collections.push({ path, operation: patch.inherit ? "inherit" : (patch.value as unknown[]).length ? "replace" : "clear", identities: patch.inherit ? [] : (patch.value as unknown[]).map((entry) => entryIdentity(path, entry)), source: "explicit whole-list intent", sourcePath: this.#policyPath, promoted: false, shadowed: (LAYER_RANK[next.provenance[normalizeConfigPath(path).join(".")] ?? ""] ?? 0) > targetRank });
    }
    const shadowed = changes.filter((change) => {
      const path = normalizeConfigPath(change.path).join(".");
      const owner = next.provenance[path];
      return owner && (LAYER_RANK[owner] ?? 0) > targetRank;
    }).map((change) => change.path);
    for (const intent of collections) if (intent.shadowed) {
      const path = intent.identities.length === 1 ? `${intent.path}[${intent.identities[0]}]` : intent.path;
      if (!shadowed.includes(path)) shadowed.push(path);
    }
    return { changes, collections, effect: this.#recovery ? "restart" : classifySettingsEffect(runtimeBaseline, next.config), effectiveToml: toEffectiveToml(next), provenance: { ...next.provenance }, warnings: [...next.warnings], shadowed };
  }
}

/** One instance per integration, not per UI. Never serializes temporary state. */
export class SettingsEditor {
  #input: ResolveConfigInput;
  #temporary: DeepPartial<Config> = {};
  #revision = 0;
  #contextRevision = 0;
  #sessionId: string;
  #busy = false;
  #interaction?: AbortController;
  #workspaceIdentity: string;
  constructor(input: ResolveConfigInput, sessionId: string) { this.#input = input; this.#sessionId = sessionId; this.#workspaceIdentity = resolve(input.repoRoot ?? input.cwd); }
  /** Shared panel/tool modal lease. A competing caller fails rather than replacing a review. */
  acquireInteraction(): { signal: AbortSignal; release: () => void } | undefined {
    if (this.#interaction) return;
    const controller = new AbortController();
    this.#interaction = controller;
    return { signal: controller.signal, release: () => { if (this.#interaction === controller) this.#interaction = undefined; } };
  }
  get contextRevision(): number { return this.#contextRevision; }
  assertContextRevision(revision: number): void { if (revision !== this.#contextRevision) throw new ConfigError(["settings context changed; reopen the panel"]); }
  temporary(): DeepPartial<Config> { return structuredClone(this.#temporary); }
  /** Invalidates drafts and drops temporary state on identity change, even before workspace discovery succeeds. */
  beginSession(input: ResolveConfigInput, sessionId: string): void {
    if (this.#busy) throw new ConfigError(["settings apply in progress"]);
    if (sessionId !== this.#sessionId) { this.#temporary = {}; this.#contextRevision++; }
    else if (input.cwd !== this.#input.cwd) this.#contextRevision++;
    this.#interaction?.abort();
    this.#input = input; this.#sessionId = sessionId; this.#revision++;
  }
  assertSession(input: ResolveConfigInput, sessionId: string): void {
    if (sessionId !== this.#sessionId || input.cwd !== this.#input.cwd || resolve(input.repoRoot ?? input.cwd) !== this.#workspaceIdentity) throw new SettingsConflictError();
  }
  /** Call on every discovered workspace change, before resolving/booting the new session. */
  configureSession(input: ResolveConfigInput, sessionId: string): void {
    if (this.#busy) throw new ConfigError(["settings apply in progress"]);
    if (sessionId !== this.#sessionId || resolve(input.repoRoot ?? input.cwd) !== this.#workspaceIdentity) { this.#temporary = {}; this.#contextRevision++; }
    else if (input.cwd !== this.#input.cwd) this.#contextRevision++;
    this.#interaction?.abort();
    this.#input = input; this.#sessionId = sessionId; this.#workspaceIdentity = resolve(input.repoRoot ?? input.cwd); this.#revision++;
  }
  /** Call on session shutdown even when the same session may later resume. */
  endSession(): void { this.#interaction?.abort(); this.#temporary = {}; this.#revision++; this.#contextRevision++; }
  assertRevision(revision: number): void { if (revision !== this.#revision) throw new ConfigError(["stale settings draft; reopen it"]); }
  async sharedProject(): Promise<{ repositoryName: string } | undefined> {
    const targets = await hostConfigTargets(this.#input);
    return targets.repository ? { repositoryName: targets.repositoryName } : undefined;
  }
  async open(scope: SettingsScope): Promise<SettingsDraft> {
    const revision = this.#revision;
    if (!["temporary", "project", "global"].includes(scope)) throw new ConfigError(["invalid settings scope"]);
    if (resolve(this.#input.repoRoot ?? this.#input.cwd) !== this.#workspaceIdentity) throw new SettingsConflictError();
    const targets = await hostConfigTargets(this.#input);
    const roots = [resolve(this.#input.repoRoot ?? this.#input.cwd), await fs.realpath(this.#input.repoRoot ?? this.#input.cwd)];
    const paths = targets.paths;
    const anchor = await captureAnchor(targets.agentDir, targets.canonicalAgentDir);
    const path = scope === "temporary" ? null : paths[scope];
    const source = path ? await readSource(path) : { text: null, raw: structuredClone(this.#temporary) as Record<string, unknown>, version: "memory" };
    if (scope === "project" && targets.repository) source.raw._repository = structuredClone(targets.repository);
    for (const file of [...Object.values(targets.paths), ...Object.values(targets.lexicalPaths)]) await assertPolicyOutsideWorkspace(file, roots);
    let recovery = false;
    let view;
    try { view = await this.#readView(); }
    catch {
      // Only the exact selected layer may be omitted, and only for a private baseline.
      try { view = await this.#readView(scope); recovery = true; }
      catch { throw new ConfigError(["Structured repair unavailable for this scope; manually edit host configuration, then retry"]); }
    }
    const base = view.resolved;
    if (path && source.text !== view.sources[path]) throw new SettingsConflictError();
    await assertAnchor(anchor);
    this.assertRevision(revision);
    return new SettingsDraft(this, scope, path, { ...source, anchor }, revision, base, targets.lexicalPaths, view.fingerprint, view.sanitize, recovery);
  }
  /** Read each policy once. No bootstrap, secret resolution, SDK, or overrides are involved. */
  #viewFingerprint(revision: number, sources: Record<string, string | null>, resolved: ResolvedConfig, versions: Record<string, string>, targets: HostConfigTargets): string {
    return hash(JSON.stringify({ revision, sources, resolved, env: this.#input.env ?? process.env, versions, targets }));
  }
  async #readView(omit?: SettingsScope) {
    const revision = this.#revision;
    const sources: Record<string, string | null> = {};
    const versions: Record<string, string> = {};
    const version = async (file: string): Promise<string> => {
      try {
        const stat = await fs.stat(file);
        return `${await fs.realpath(file)}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
    };
    const read = this.#input.readFile ?? (async (file: string) => {
      try { return await fs.readFile(file, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    });
    const targets = await hostConfigTargets(this.#input);
    if (this.#input.cliOverridesToml !== undefined) recoveryRaw(this.#input.cliOverridesToml);
    let sanitize!: SettingsSanitizer;
    const resolved = await resolveConfig({ ...this.#input, temporaryOverrides: omit === "temporary" ? {} : this.#temporary, readFile: async (file) => {
      if (!(file in sources)) {
        versions[file] = await version(file);
        sources[file] = await read(file);
        if (versions[file] !== await version(file)) throw new SettingsConflictError();
      }
      recoveryRaw(sources[file] ?? "");
      return omit !== undefined && omit !== "temporary" && file === targets.paths[omit] ? null : sources[file]!;
    } }, (captured) => { this.assertRevision(revision); sanitize = captured; });
    this.assertRevision(revision);
    if (!equal(targets, await hostConfigTargets(this.#input))) throw new SettingsConflictError();
    const fingerprint = this.#viewFingerprint(revision, sources, resolved, versions, targets);
    const privateRaw = Object.values(sources).map((text) => readRawConfig(text ?? ""));
    const redact = createSettingsSanitizer([...privateRaw, ...sourcePrivacy([...Object.values(sources), this.#input.cliOverridesToml ?? null]), ...environmentPrivacy(this.#input.env ?? process.env), this.#temporary]);
    const captured = sanitize;
    sanitize = (value, additional, format) => redact(captured(value, additional, format), additional, format);
    return { resolved, sources, versions, revision, fingerprint, sanitize, targets };
  }
  async reviewState(omit?: SettingsScope): Promise<string> { return (await this.#readView(omit)).fingerprint; }
  async guardAfterCommit(expected: string, path: string | null, text: string | null, next: ResolvedConfig, omit?: SettingsScope): Promise<() => Promise<void>> {
    const view = await this.#readView(omit);
    if (view.fingerprint !== expected) throw new SettingsConflictError();
    const sources = { ...view.sources, ...(path ? { [path]: text } : {}) };
    const versions = { ...view.versions };
    if (path) delete versions[path]; // Our own atomic replacement necessarily changes the target inode.
    const expectedTargets = await hostConfigTargets(this.#input, path && text !== null ? { file: path, text } : undefined);
    const fingerprint = this.#viewFingerprint(this.#revision + 1, sources, next, versions, expectedTargets);
    return async () => {
      const current = await this.#readView();
      if (path) delete current.versions[path];
      if (fingerprint !== this.#viewFingerprint(current.revision, current.sources, current.resolved, current.versions, current.targets)) throw new SettingsConflictError();
    };
  }
  async inspect(extra?: unknown, privateSources: unknown[] = []): Promise<Record<string, unknown>> {
    const revision = this.#revision;
    if (resolve(this.#input.repoRoot ?? this.#input.cwd) !== this.#workspaceIdentity) throw new SettingsConflictError();
    const targets = await hostConfigTargets(this.#input);
    let view;
    try { view = await this.#readView(); }
    catch { return this.#inspectRecovery(targets, extra, privateSources, revision); }
    const raw = Object.fromEntries(Object.entries(view.sources).map(([path, text]) => [path, readRawConfig(text ?? "")]));
    const layers = {
      global: projectSettingsJson(raw[targets.paths.global] ?? {}),
      project: projectSettingsJson(raw[targets.paths.project] ?? {}),
      session: projectSettingsJson(this.#temporary),
    };
    const origins = Object.fromEntries(SETTINGS_PATHS.map((path) => [path, view.resolved.provenance[normalizeConfigPath(path).join(".")] ?? "defaults"]));
    this.assertRevision(revision);
    return view.sanitize({
      runtime: extra, supportedPaths: SETTINGS_PATHS, desired: projectSettingsJson(view.resolved.config), layers,
      origins, provenance: view.resolved.provenance, warnings: view.resolved.warnings,
      layerSemantics: "Sparse raw scope intent; absent means inherit. Arrays are authoritative in these scopes. Desired is fully resolved, not necessarily adopted by the runtime.",
      otherOrigins: "defaults, legacy global, environment and CLI may contribute below these layers; provenance uses resolver layer names. Scalar-list provenance is field-level, not per-item history.",
    }, privateSources);
  }
  async #inspectRecovery(targets: Awaited<ReturnType<typeof hostConfigTargets>>, extra: unknown, privateSources: unknown[], revision: number): Promise<Record<string, unknown>> {
    const sources: Record<string, Record<string, unknown>> = {};
    const texts: Array<string | null> = [];
    const scopes: SettingsScope[] = [];
    const issues: string[] = [];
    let malformed = false;
    const read = this.#input.readFile ?? (async (file: string) => {
      try { return await fs.readFile(file, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    });
    const env = this.#input.env ?? process.env;
    const files = [...Object.entries(targets.paths), ...legacyConfigSources(this.#input).map(({ name, path }) => [name, path])];
    for (const [scope, file] of files) {
      try {
        const text = await read(file!);
        texts.push(text);
        const raw = recoveryRaw(text ?? "");
        sources[scope!] = raw;
        try { validateLayerValues(parseTomlConfig(text ?? "", "global").value); }
        catch (error) {
          if (scope === "global" || scope === "project") scopes.push(scope);
          const constraints = error instanceof ConfigError ? error.issues.slice(0, 32).flatMap((issue) => {
            const match = /^([A-Za-z][A-Za-z0-9.]*)(?:\[\d+\])?(?:\.[A-Za-z]+)?: (.*)$/.exec(issue);
            if (!match) return [];
            const field = match[1]!;
            if (![...SETTINGS_PATHS.map((path) => normalizeConfigPath(path).join(".")), "network"].includes(field)) return [];
            // Only fixed validator constraints, never input-bearing tool names or parser snippets.
            const detail = /^(must |allowHosts must |env must |allowlist needs )/.test(match[2]!) ? match[2] : "invalid value; check this setting's schema";
            return [`${field}: ${detail}`];
          }) : [];
          issues.push(`${scope}: ${constraints.length ? constraints.join("; ") : "invalid settings"}; repair this host layer and validate the complete configuration`);
        }
      } catch {
        malformed = true;
        issues.push(`${scope}: configuration cannot be safely reconstructed; manually edit the host file, then retry`);
      }
    }
    if (this.#input.cliOverridesToml !== undefined) {
      texts.push(this.#input.cliOverridesToml);
      try { recoveryRaw(this.#input.cliOverridesToml); } catch { malformed = true; }
    }
    let environment: unknown = {};
    try { environment = parseEnvConfig(env).value; } catch { /* Never publish environment/parser errors. */ }
    const supported: SettingsScope[] = [];
    if (!malformed) for (const scope of ["global", "project", "temporary"] as const) {
      try { await this.#readView(scope); supported.push(scope); } catch { /* Not an independently repairable target. */ }
    }
    this.assertRevision(revision);
    const sanitize = createSettingsSanitizer([...Object.values(sources), ...sourcePrivacy(texts), ...environmentPrivacy(env), environment, this.#temporary, ...privateSources]);
    return sanitize({
      supportedPaths: SETTINGS_PATHS,
      ...(!malformed ? { sources: { global: { path: targets.lexicalPaths.global, source: "host-default" }, project: { path: targets.lexicalPaths.project, source: "host-project" }, session: { path: null, source: "temporary" } } } : {}),
      ...(!malformed ? { runtime: extra, layers: { global: projectSettingsJson(sources.global ?? {}), project: projectSettingsJson(sources.project ?? {}), session: projectSettingsJson(this.#temporary) } } : {}),
      warnings: [],
      recovery: {
        available: supported.length > 0, configurationValid: false, manualRepairRequired: !supported.length,
        scopes: [...new Set([...scopes, ...supported])],
        issues: issues.length ? issues : ["Configuration resolution failed; check environment, CLI and host policy settings, then retry"],
        reason: supported.length ? "Desired configuration is invalid. A selected host layer can be repaired with full validation and user approval; no runtime was started."
          : "Structured repair is unavailable. Manually edit host configuration or correct environment/CLI settings, then retry.",
      },
      layerSemantics: "Sanitized raw host intent only. Desired configuration and provenance are unavailable because configuration resolution failed.",
    });
  }
  /** Recovery may omit one layer for drafting, never for final validation. */
  async validateRecoveryLayers(scope: SettingsScope, path: string | null, text: string | null, temporary: DeepPartial<Config>): Promise<void> {
    const view = await this.#readView(scope);
    for (const [file, original] of Object.entries(view.sources)) validateLayerValues(parseTomlConfig(file === path ? text ?? "" : original ?? "", "global").value);
    validateLayerValues(parseEnvConfig(this.#input.env ?? process.env).value);
    if (this.#input.cliOverridesToml !== undefined) validateLayerValues(parseTomlConfig(this.#input.cliOverridesToml, "cli").value);
    validateLayerValues(temporary);
  }
  /** A ceiling is only for collection baselines. Preview/commit always validate the full layered candidate. */
  async resolveCandidate(path: string | null, text: string | null, temporary: DeepPartial<Config>, ceiling: SettingsScope = "temporary"): Promise<ResolvedConfig> {
    const paths = await hostConfigPaths(this.#input);
    const read = this.#input.readFile ?? (async (file: string) => { try { return await fs.readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } });
    if (this.#input.cliOverridesToml !== undefined) recoveryRaw(this.#input.cliOverridesToml);
    return resolveConfig({ ...this.#input, temporaryOverrides: temporary, readFile: async (file) => {
      const original = await read(file);
      recoveryRaw(original ?? "");
      return (ceiling === "global" && file === paths.project) ? null : file === path ? text : original;
    } });
  }
  async commit(revision: number, scope: SettingsScope, path: string | null, source: Source, raw: Record<string, unknown>, temporary: DeepPartial<Config>, approvalGuard?: (resolved?: ResolvedConfig) => Promise<void>, recovery = false): Promise<ResolvedConfig> {
    this.assertRevision(revision);
    if (this.#busy) throw new ConfigError(["settings apply in progress"]);
    this.#busy = true;
    try {
      const targetInfo = await hostConfigTargets(this.#input);
      const targets = targetInfo.paths;
      if (scope === "project" && targetInfo.repository && !equal(raw._repository, targetInfo.repository)) throw new SettingsConflictError();
      if (scope === "temporary" ? path !== null : !["global", "project"].includes(scope) || path !== targets[scope]) throw new ConfigError(["invalid settings target"]);
      validateLayerValues(scope === "temporary" ? temporary : parseTomlConfig(serializeRaw(raw), "global").value);
      let validated: ResolvedConfig;
      const guard = async () => {
        await approvalGuard?.();
        this.assertRevision(revision);
        await assertAnchor(source.anchor);
        if (path) await assertPolicyOutsideWorkspace(path, [resolve(this.#input.repoRoot ?? this.#input.cwd), await fs.realpath(this.#input.repoRoot ?? this.#input.cwd)]);
        if (recovery) await this.validateRecoveryLayers(scope, path, path ? serializeRaw(raw) : null, temporary);
        validated = await this.resolveCandidate(path, path ? serializeRaw(raw) : null, temporary);
        await approvalGuard?.(validated);
        await assertAnchor(source.anchor);
        this.assertRevision(revision);
      };
      await guard();
      if (scope === "temporary") { await approvalGuard?.(); this.#temporary = structuredClone(temporary); }
      else await atomicWrite(path!, serializeRaw(raw), source, guard);
      this.#revision++;
      return validated!;
    } finally { this.#busy = false; }
  }
}
