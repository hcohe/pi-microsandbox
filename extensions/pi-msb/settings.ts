import { constants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, normalize, parse, resolve } from "node:path";
import {
  applyOverride, assertPolicyOutsideWorkspace, canonicalPolicyLocation, ConfigError, DEFAULT_CONFIG, hostConfigPaths, hostConfigTargets,
  normalizeConfigPath, parseTomlConfig, readRawConfig, removeOverride,
  resolveConfig, toEffectiveToml, validateConfig, type ResolveConfigInput,
} from "./config.ts";
import type { Config, DeepPartial, ResolvedConfig } from "./types.ts";

export type SettingsScope = "temporary" | "project" | "global";
export type SettingsEffect = "none" | "live" | "restart";
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
interface EntryOrigin { source: string; path: string | null; rank: number }
interface EntryEdit {
  operation: "upsert" | "remove";
  identity: string;
  previousIdentity?: string;
  value?: unknown;
  valueOrigin?: string | null;
  origin: EntryOrigin;
}
interface DraftPatch { inherit: boolean; value?: unknown; entries?: EntryEdit[] }
const LAYER_RANK: Record<string, number> = { defaults: 0, global: 1, project: 1, env: 2, cli: 3, "host-default": 4, "host-project": 5, temporary: 6 };
const scopeRank = (scope: SettingsScope): number => scope === "global" ? 4 : scope === "project" ? 5 : 6;
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
export interface SettingsSnapshot {
  scope: SettingsScope;
  path: string | null;
  revision: number;
  /** Raw target layer, with every secret value masked (including references). */
  raw: Record<string, unknown>;
  effectiveToml: string;
  provenance: ResolvedConfig["provenance"];
  warnings: string[];
  automaticSandboxName: boolean;
}
export interface SettingsApplyResult extends SettingsPreview {
  saved: boolean;
  runtimeApplied: false;
}

const snake = (key: string): string => key.replace(/MiB/g, "Mib").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
/** Complete schema leaf inventory. Arrays are edited as collections, never indexed paths. */
export const SETTINGS_PATHS: readonly string[] = Object.freeze(Object.entries(DEFAULT_CONFIG).flatMap(([key, value]) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).map((child) => `${snake(key)}.${snake(child)}`) : [snake(key)]));
const canonical = (path: string): string => normalizeConfigPath(path).map(snake).join(".");
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function get(value: any, parts: string[]): any { for (const part of parts) value = value?.[part]; return value; }
function masked(value: unknown, key = ""): any {
  if (key === "value") return "<redacted>";
  if (Array.isArray(value)) return value.map((child) => masked(child));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, masked(v, k)]));
  return value;
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
/** Inline tables retain original raw key spelling and unknown data; comments/formatting are not retained. */
function serializeRaw(raw: Record<string, unknown>): string {
  const scalar = (value: unknown): string => {
    if (value === null || value === undefined) throw new ConfigError(["TOML cannot store null; use inherit instead"]);
    if (Array.isArray(value)) return `[${value.map(scalar).join(", ")}]`;
    if (typeof value === "object") return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${scalar(v)}`).join(", ")} }`;
    return JSON.stringify(value);
  };
  return Object.entries(raw).map(([k, v]) => `${JSON.stringify(k)} = ${scalar(v)}`).join("\n") + "\n";
}
/** A deliberate authoritative collection edit wins over conflicting removals in that same scope. */
export const COLLECTION_REMOVALS: Readonly<Record<string, string>> = Object.freeze({
  route_tools: "remove_route_tools", pass_through_tools: "remove_pass_through_tools",
  host_env: "remove_host_env",
  secrets: "remove_secrets", mounts: "remove_mounts",
  "network.allow_hosts": "network.remove_allow_hosts", "network.publish_ports": "network.remove_publish_ports",
});
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
interface Source { text: string | null; version: string; raw: Record<string, unknown>; anchor?: SettingsAnchor }
interface SettingsAnchor { path: string; canonical: string; ancestors: Array<{ path: string; identity?: string }> }
const anchorIdentity = (stat: Awaited<ReturnType<typeof fs.lstat>>): string => `${stat.dev}:${stat.ino}:${stat.mode}${stat.isSymbolicLink() ? `:${stat.ctimeMs}:${stat.mtimeMs}` : ""}`;
async function captureAnchor(path: string, canonical: string): Promise<SettingsAnchor> {
  const entries: SettingsAnchor["ancestors"] = [];
  for (const part of new Set([...await ancestors(path), ...await ancestors(canonical)])) {
    try { entries.push({ path: part, identity: anchorIdentity(await fs.lstat(part)) }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; entries.push({ path: part }); }
  }
  const anchor = { path, canonical, ancestors: entries };
  await assertAnchor(anchor);
  return anchor;
}
/** Pin existing lexical ancestors (including the selected root link), but allow missing directories to be created. */
async function assertAnchor(anchor: SettingsAnchor | undefined): Promise<void> {
  if (!anchor) return;
  for (const entry of anchor.ancestors) {
    let stat;
    try { stat = await fs.lstat(entry.path); }
    catch (error) { if (!entry.identity && (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new ConfigError(["settings agent directory changed; reopen the panel"]); }
    if (entry.identity ? anchorIdentity(stat) !== entry.identity : !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ConfigError(["settings agent directory changed; reopen the panel"]);
    }
  }
  if (await canonicalPolicyLocation(anchor.path) !== anchor.canonical) throw new ConfigError(["settings agent directory changed; reopen the panel"]);
}
async function ancestors(path: string): Promise<string[]> {
  const result: string[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    result.unshift(current);
    if (current === parse(current).root) return result;
  }
}
async function inspectPath(path: string): Promise<string> {
  const result: string[] = [];
  for (const part of await ancestors(path)) {
    try {
      const stat = await fs.lstat(part);
      if (stat.isSymbolicLink() || (part !== path && !stat.isDirectory()) || (part === path && !stat.isFile())) {
        throw new ConfigError(["settings paths must use regular files and non-symlink directories"]);
      }
      result.push(`${part}:${stat.dev}:${stat.ino}${part === path ? `:${stat.size}:${stat.mode}:${stat.mtimeMs}:${stat.ctimeMs}` : ""}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      result.push(`${part}:missing`);
    }
  }
  return result.join("|");
}
async function readSource(path: string): Promise<Source> {
  const location = await inspectPath(path);
  let text: string | null = null;
  try {
    const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw new ConfigError(["settings target must be a regular file"]);
      text = await file.readFile("utf8");
    } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (location !== await inspectPath(path)) throw new ConfigError(["settings path changed while reading"]);
  return { text, version: hash(`${location}\n${text === null ? "missing" : text}`), raw: readRawConfig(text ?? "") };
}
async function atomicWrite(path: string, text: string, expected: Source, guard: () => Promise<void>): Promise<void> {
  await guard();
  if ((await readSource(path)).version !== expected.version) throw new ConfigError(["configuration changed externally; reopen the draft"]);
  for (const part of (await ancestors(dirname(path))).slice(1)) {
    try { await fs.mkdir(part, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await fs.lstat(part);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ConfigError(["unsafe settings ancestor"]);
  }
  const stable = await inspectPath(path);
  const temp = join(dirname(path), `.settings-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await guard();
    if (stable !== await inspectPath(path) || (await readSource(path)).text !== expected.text) throw new ConfigError(["configuration changed externally; reopen the draft"]);
    await fs.rename(temp, path);
    const directory = await fs.open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.unlink(temp).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}

export const LIVE_SETTINGS_KEYS: readonly (keyof Config)[] = Object.freeze(["blockThirdParty", "routeTools", "passThroughTools", "allowHostExecution", "allowSkillReads", "fallbackMode", "showFooter", "autoStart"]);
const LIVE_FIELDS = new Set<string>(LIVE_SETTINGS_KEYS);
/** Conservative: only live routing/presentation and startup-only preferences avoid recreation. */
export function classifySettingsEffect(before: Config, after: Config): SettingsEffect {
  const changed = Object.keys(before).filter((key) => !equal(before[key as keyof Config], after[key as keyof Config]));
  return !changed.length ? "none" : changed.every((key) => LIVE_FIELDS.has(key)) ? "live" : "restart";
}

/** Private raw/secret data stays in this object; snapshots and diffs are always masked. */
export class SettingsDraft {
  #editor: SettingsEditor;
  #source: Source;
  #revision: number;
  #contextRevision: number;
  #base: ResolvedConfig;
  #scopeBase?: ResolvedConfig;
  #referencePaths: { global: string; project: string };
  #closed = false;
  #patch = new Map<string, DraftPatch>();
  readonly scope: SettingsScope;
  readonly path: string | null;
  constructor(editor: SettingsEditor, scope: SettingsScope, path: string | null, source: Source, revision: number, base: ResolvedConfig, referencePaths: { global: string; project: string }) {
    this.#editor = editor; this.scope = scope; this.path = path; this.#source = source; this.#revision = revision; this.#contextRevision = editor.contextRevision; this.#base = base; this.#referencePaths = referencePaths;
  }
  /** I/O uses path; raw relative FILE references use the original lexical policy location. */
  get #referencePath(): string | null { return this.scope === "temporary" ? null : this.#referencePaths[this.scope]; }
  snapshot(): SettingsSnapshot {
    const raw = structuredClone(this.#source.raw);
    for (const [path, patch] of this.#patch) patchRaw(raw, normalizeConfigPath(path), patch.entries ? replayEntries(path, this.#ownCollection(path) ?? [], patch.entries) : patch.value, patch.inherit);
    return { scope: this.scope, path: this.path, revision: this.#revision, raw: masked(raw), effectiveToml: toEffectiveToml(this.#base), provenance: { ...this.#base.provenance }, warnings: [...this.#base.warnings], automaticSandboxName: this.#base.config.sandboxName === null };
  }
  set(path: string, value: unknown): void {
    this.#assertOpen();
    const key = canonical(path);
    if (!SETTINGS_PATHS.includes(key)) throw new ConfigError(["unknown editable setting"]);
    // Assert prototype safety before retaining user data.
    applyOverride({}, key, value);
    if (value === undefined) throw new ConfigError(["use inherit to remove a setting"]);
    if (key === "secrets" && Array.isArray(value) && value.some((secret) => secret && ["<redacted>", "[REDACTED]"].includes(secret.value))) {
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
          if (path === "secrets" && this.path !== target.path) for (const entry of entries) {
            const secret = entry.value as Config["secrets"][number] | undefined;
            if (secret) secret.value = await this.#editor.rebaseSecretReference(secret.value, entry.valueOrigin ?? null);
          }
          target.#patch.set(path, { inherit: false, entries });
        } else if (patch.inherit) target.inherit(path);
        else {
          const value = structuredClone(patch.value);
          if (path === "secrets" && this.path !== target.path && Array.isArray(value)) {
            for (const secret of value) if (typeof secret?.value === "string") secret.value = await this.#editor.rebaseSecretReference(secret.value, this.#referencePath);
          }
          target.set(path, value);
        }
      }
      this.#editor.assertContextRevision(this.#contextRevision);
      return target;
    } catch (error) { target.discard(); throw error; }
  }
  /** CRUD retains identity-level intent; it never exports unrelated effective entries across scopes. */
  upsertSecret(secret: { env: string; allowHosts: string[]; value?: string }, previousEnv = secret.env): void {
    this.#assertOpen();
    const prior = (this.#visibleCollection("secrets") as Config["secrets"]).find((entry) => entry.env === previousEnv);
    const value = secret.value ?? prior?.value;
    if (value === undefined) throw new ConfigError(["new secrets require a value or reference"]);
    const previous = this.#latestEntry("secrets", previousEnv);
    this.#editEntry("secrets", {
      operation: "upsert", identity: secret.env, previousIdentity: previousEnv,
      value: { ...secret, value },
      valueOrigin: secret.value !== undefined ? this.#referencePath : (previous ? previous.valueOrigin ?? null : this.#origin("secrets", previousEnv).path),
      origin: previous?.origin ?? this.#origin("secrets", previousEnv),
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
    if (path === "secrets" && edit.operation === "upsert" && ["<redacted>", "[REDACTED]"].includes((edit.value as Config["secrets"][number]).value)) throw new ConfigError(["masked secret placeholders cannot be saved"]);
    const patch = this.#patch.get(path);
    if (patch && !patch.entries && !patch.inherit) {
      // An explicit replacement remains explicit when subsequently edited.
      this.set(path, replayEntries(path, patch.value as unknown[], [edit]));
    } else this.#patch.set(path, { inherit: false, entries: [...(patch?.entries ?? []), structuredClone(edit)] });
  }
  #origin(path: string, identity: string): EntryOrigin {
    if (!this.#visibleCollection(path).some((entry) => entryIdentity(path, entry) === identity)) return { source: "new entry", path: this.#referencePath, rank: 0 };
    const key = path === "secrets" || path === "mounts" ? `${path}[${identity}]` : normalizeConfigPath(path).join(".");
    const source = this.#base.provenance[key] ?? "defaults";
    return { source, path: source === "host-project" ? this.#referencePaths.project : source === "host-default" ? this.#referencePaths.global : null, rank: LAYER_RANK[source] ?? 0 };
  }
  #ownCollection(path: string): unknown[] | undefined {
    const ownRaw = rawValue(this.#source.raw, normalizeConfigPath(path));
    if (ownRaw === undefined) return;
    const container = {};
    patchRaw(container, normalizeConfigPath(path), ownRaw, false);
    return get(parseTomlConfig(serializeRaw(container), "global").value, normalizeConfigPath(path));
  }
  #baselineCollection(path: string, base: ResolvedConfig): unknown[] {
    const items = structuredClone(get(base.config, normalizeConfigPath(path))) as any[];
    if (path === "secrets") for (const secret of items) {
      const source = base.provenance[`secrets[${secret.env}]`];
      // Non-policy references are read by the SDK relative to the process cwd.
      // Anchor before materialization; target-owned policy spelling is restored below.
      if (!["host-default", "host-project", "temporary"].includes(source ?? "") && typeof secret.value === "string" && secret.value.startsWith("$FILE:") && !isAbsolute(secret.value.slice(6))) secret.value = `$FILE:${resolve(secret.value.slice(6))}`;
    }
    if (path === "secrets" || path === "mounts") {
      const own = this.#ownCollection(path);
      if (Array.isArray(own)) for (let index = 0; index < items.length; index++) {
        const identity = entryIdentity(path, items[index]);
        const expected = this.scope === "global" ? "host-default" : this.scope === "project" ? "host-project" : "temporary";
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
    this.#patch.clear(); this.#source = { text: null, raw: {}, version: "closed" };
    this.#base = { config: structuredClone(DEFAULT_CONFIG) as Config, provenance: {}, warnings: [] };
    this.#scopeBase = this.#base;
    this.#closed = true;
  }
  async preview(runtimeBaseline?: Config): Promise<SettingsPreview> { return (await this.#candidate(runtimeBaseline)).preview; }
  async apply(): Promise<SettingsApplyResult> {
    const candidate = await this.#candidate();
    if (!candidate.preview.changes.length) return { ...candidate.preview, saved: false, runtimeApplied: false };
    const next = await this.#editor.commit(this.#revision, this.scope, this.path, this.#source, candidate.raw, candidate.temporary);
    const preview = this.#preview(candidate.preview.changes, next);
    this.discard();
    return { ...preview, saved: true, runtimeApplied: false };
  }
  async #candidate(runtimeBaseline?: Config) {
    this.#assertOpen();
    await assertAnchor(this.#source.anchor);
    if ([...this.#patch.values()].some((patch) => patch.entries)) {
      this.#scopeBase = this.scope === "temporary" ? this.#base : await this.#editor.resolveCandidate(null, null, {}, this.scope);
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
    validateConfig(this.scope === "temporary" ? temporary : parseTomlConfig(text!, "global").value);
    const next = await this.#editor.resolveCandidate(this.path, text, temporary);
    return { raw, temporary, next, preview: this.#preview(changes, next, runtimeBaseline) };
  }
  #preview(changes: SettingsChange[], next: ResolvedConfig, runtimeBaseline = this.#base.config): SettingsPreview {
    const targetRank = scopeRank(this.scope);
    const collections: SettingsCollectionIntent[] = [];
    for (const [path, patch] of this.#patch) {
      if (!COLLECTION_REMOVALS[path]) continue;
      const owner = (identity: string): string | undefined => next.provenance[path === "secrets" || path === "mounts" ? `${path}[${identity}]` : normalizeConfigPath(path).join(".")];
      const higher = (identity: string): boolean => (LAYER_RANK[owner(identity) ?? ""] ?? 0) > targetRank;
      if (patch.entries) for (const entry of patch.entries) {
        const present = (get(next.config, normalizeConfigPath(path)) as unknown[]).some((item) => entryIdentity(path, item) === entry.identity);
        collections.push({ path, operation: entry.operation, identities: [entry.identity], previousIdentity: entry.previousIdentity, source: entry.origin.source, sourcePath: entry.origin.path, promoted: entry.operation === "upsert" && entry.origin.rank > targetRank, shadowed: higher(entry.identity) && (entry.operation === "upsert" || present) });
      } else collections.push({ path, operation: patch.inherit ? "inherit" : (patch.value as unknown[]).length ? "replace" : "clear", identities: patch.inherit ? [] : (patch.value as unknown[]).map((entry) => entryIdentity(path, entry)), source: "explicit whole-list intent", sourcePath: this.#referencePath, promoted: false, shadowed: (LAYER_RANK[next.provenance[normalizeConfigPath(path).join(".")] ?? ""] ?? 0) > targetRank });
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
    return { changes, collections, effect: classifySettingsEffect(runtimeBaseline, next.config), effectiveToml: toEffectiveToml(next), provenance: { ...next.provenance }, warnings: [...next.warnings], shadowed };
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
  #workspaceIdentity: string;
  constructor(input: ResolveConfigInput, sessionId: string) { this.#input = input; this.#sessionId = sessionId; this.#workspaceIdentity = resolve(input.repoRoot ?? input.cwd); }
  get contextRevision(): number { return this.#contextRevision; }
  assertContextRevision(revision: number): void { if (revision !== this.#contextRevision) throw new ConfigError(["settings context changed; reopen the panel"]); }
  async rebaseSecretReference(value: string, sourcePath: string | null): Promise<string> {
    if (!value.startsWith("$FILE:") || isAbsolute(value.slice(6))) return value;
    return `$FILE:${await fs.realpath(resolve(sourcePath ? dirname(sourcePath) : this.#input.cwd, value.slice(6)))}`;
  }
  temporary(): DeepPartial<Config> { return structuredClone(this.#temporary); }
  /** Invalidates drafts and drops temporary state on identity change, even before workspace discovery succeeds. */
  beginSession(input: ResolveConfigInput, sessionId: string): void {
    if (this.#busy) throw new ConfigError(["settings apply in progress"]);
    if (sessionId !== this.#sessionId) { this.#temporary = {}; this.#contextRevision++; }
    else if (input.cwd !== this.#input.cwd) this.#contextRevision++;
    this.#input = input; this.#sessionId = sessionId; this.#revision++;
  }
  /** Call on every discovered workspace change, before resolving/booting the new session. */
  configureSession(input: ResolveConfigInput, sessionId: string): void {
    if (this.#busy) throw new ConfigError(["settings apply in progress"]);
    if (sessionId !== this.#sessionId || resolve(input.repoRoot ?? input.cwd) !== this.#workspaceIdentity) { this.#temporary = {}; this.#contextRevision++; }
    else if (input.cwd !== this.#input.cwd) this.#contextRevision++;
    this.#input = input; this.#sessionId = sessionId; this.#workspaceIdentity = resolve(input.repoRoot ?? input.cwd); this.#revision++;
  }
  /** Call on session shutdown even when the same session may later resume. */
  endSession(): void { this.#temporary = {}; this.#revision++; this.#contextRevision++; }
  assertRevision(revision: number): void { if (revision !== this.#revision) throw new ConfigError(["stale settings draft; reopen it"]); }
  async open(scope: SettingsScope): Promise<SettingsDraft> {
    const revision = this.#revision;
    if (!["temporary", "project", "global"].includes(scope)) throw new ConfigError(["invalid settings scope"]);
    const targets = await hostConfigTargets(this.#input);
    const paths = targets.paths;
    const anchor = await captureAnchor(targets.agentDir, targets.canonicalAgentDir);
    const path = scope === "temporary" ? null : paths[scope];
    const source = path ? await readSource(path) : { text: null, raw: structuredClone(this.#temporary) as Record<string, unknown>, version: "memory" };
    const base = await this.resolveCandidate(null, null, this.#temporary);
    await assertAnchor(anchor);
    this.assertRevision(revision);
    return new SettingsDraft(this, scope, path, { ...source, anchor }, revision, base, targets.lexicalPaths);
  }
  /** A ceiling is only for collection baselines. Preview/commit always validate the full layered candidate. */
  async resolveCandidate(path: string | null, text: string | null, temporary: DeepPartial<Config>, ceiling: SettingsScope = "temporary"): Promise<ResolvedConfig> {
    const paths = await hostConfigPaths(this.#input);
    const read = this.#input.readFile ?? (async (file: string) => { try { return await fs.readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } });
    return resolveConfig({ ...this.#input, temporaryOverrides: temporary, readFile: (file) => ceiling === "global" && file === paths.project ? Promise.resolve(null) : file === path ? Promise.resolve(text) : read(file) });
  }
  async commit(revision: number, scope: SettingsScope, path: string | null, source: Source, raw: Record<string, unknown>, temporary: DeepPartial<Config>): Promise<ResolvedConfig> {
    this.assertRevision(revision);
    if (this.#busy) throw new ConfigError(["settings apply in progress"]);
    this.#busy = true;
    try {
      const targets = await hostConfigPaths(this.#input);
      if (scope === "temporary" ? path !== null : !["global", "project"].includes(scope) || path !== targets[scope]) throw new ConfigError(["invalid settings target"]);
      validateConfig(scope === "temporary" ? temporary : parseTomlConfig(serializeRaw(raw), "global").value);
      let validated: ResolvedConfig;
      const guard = async () => {
        this.assertRevision(revision);
        await assertAnchor(source.anchor);
        if (path) await assertPolicyOutsideWorkspace(path, [resolve(this.#input.repoRoot ?? this.#input.cwd), await fs.realpath(this.#input.repoRoot ?? this.#input.cwd)]);
        validated = await this.resolveCandidate(path, path ? serializeRaw(raw) : null, temporary);
        await assertAnchor(source.anchor);
        this.assertRevision(revision);
      };
      await guard();
      if (scope === "temporary") this.#temporary = structuredClone(temporary);
      else await atomicWrite(path!, serializeRaw(raw), source, guard);
      this.#revision++;
      return validated!;
    } finally { this.#busy = false; }
  }
}
