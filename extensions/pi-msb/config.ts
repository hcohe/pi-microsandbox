import { promises as fs } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { defaultConfigTemplate } from "./config-template.ts";
import type {
  Config,
  ConfigLayerInput,
  ConfigLayerName,
  DeepPartial,
  DeepReadonly,
  MergeResult,
  ParsedConfigLayer,
  ResolvedConfig,
} from "./types.ts";

const ROUTED_TOOLS = ["read", "write", "edit", "ls", "find", "grep", "bash"];
const PASS_THROUGH_TOOLS = ["todo", "ask_user_question", "web_search", "source_check", "fetch_content"];
const ALLOWLIST_PATHS = new Set(["routeTools", "passThroughTools", "hostEnv", "hostRoAllowlist", "network.allowHosts"]);
const CONTROL_KEYS = new Set(["removeSecrets", "removeMounts", "removeRouteTools", "removePassThroughTools", "removeHostEnv", "removeHostRoAllowlist", "removeAllowHosts", "removePublishPorts"]);
const SECRET_FIELDS = new Set(["env", "value", "allowHosts"]);
const MOUNT_FIELDS = new Set(["type", "hostPath", "guestPath", "readonly", "options"]);
const FORBIDDEN_CONFIG_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const REMOVED_WORKSPACE_KEYS = new Set(["mode", "cloneBranch", "cloneDepth", "shallowArchive", "volumeQuotaMiB"]);
const REMOVED_WORKSPACE_MESSAGE = "was removed; pi-microsandbox now bind-mounts the discovered workspace root read/write";
const PROTECTED_GUEST_ENV = new Set([
  "BASH_ENV",
  "CDPATH",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "ENV",
  "GLOBIGNORE",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "PATH",
  "SHELLOPTS",
]);
const PROTECTED_GUEST_PATHS = [
  "/bin",
  "/dev",
  "/etc/ld.so.cache",
  "/etc/ld.so.preload",
  "/lib",
  "/lib64",
  "/proc",
  "/sbin",
  "/sys",
  "/usr",
  "/run",
  "/var/run",
  "/var/lib/docker",
] as const;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Defaults from PLAN §11.2. Values containing credentials are deliberately absent. */
export const DEFAULT_CONFIG = deepFreeze<Config>({
  image: "ghcr.io/hcohe/pi-microsandbox:1.1.0@sha256:ab4e99d4232f827b3f295ff3210437e01446dbb672ef0d0c78358566170ac86c",
  pullPolicy: "if-missing",
  bootstrapTools: "auto",
  cpus: 4,
  memoryMiB: 8_192,
  idleTimeoutSec: 600,
  stopTimeoutMs: 10_000,
  detached: true,
  replace: false,
  replaceTimeoutMs: 10_000,
  sandboxName: null,
  network: { mode: "default", allowHosts: [], allowDns: true, publishPorts: [] },
  docker: { mode: "auto", startupTimeoutMs: 15_000 },
  secrets: [],
  mounts: [],
  blockThirdParty: true,
  routeTools: [...ROUTED_TOOLS],
  passThroughTools: [...PASS_THROUGH_TOOLS],
  allowHostExecution: true,
  allowSkillReads: true,
  fallbackMode: "block",
  exposeSessionEnvironment: false,
  hostEnv: [],
  autoStart: true,
  pruneOnStart: true,
  showFooter: true,
  lockDir: "~/.pi-msb/locks",
  hostRoAllowlist: [],
});

export interface ResolveConfigInput {
  cwd: string;
  repoRoot?: string | null;
  projectTrusted: boolean;
  configDirName: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  xdgConfigHome?: string;
  agentDir?: string;
  cliOverridesToml?: string;
  /** Memory-only, authoritative layer above host policy. */
  temporaryOverrides?: DeepPartial<Config>;
  readFile?: (path: string) => Promise<string | null>;
  exists?: (path: string) => Promise<boolean>;
  realpath?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<{ isSocket(): boolean }>;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[] | string) {
    const list = typeof issues === "string" ? [issues] : [...issues];
    super(list.join("; "));
    this.name = "ConfigError";
    this.issues = list;
  }
}

function createRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}
function assertSafeConfigKey(key: string, path: readonly string[]): void {
  let semanticKey = key;
  if (key.length >= 2 && key[0] === key[key.length - 1] && (key[0] === "\"" || key[0] === "'")) {
    if (key[0] === "'") semanticKey = key.slice(1, -1);
    else {
      try { semanticKey = JSON.parse(key) as string; } catch { /* malformed TOML is rejected elsewhere */ }
    }
  }
  if (FORBIDDEN_CONFIG_KEYS.has(key) || FORBIDDEN_CONFIG_KEYS.has(semanticKey)) {
    throw new ConfigError([`forbidden config key ${path.join(".")}`]);
  }
}
function assertSafeConfigPath(parts: readonly string[]): void {
  for (let index = 0; index < parts.length; index++) assertSafeConfigKey(parts[index]!, parts.slice(0, index + 1));
}
function assertSafeConfigValue(value: unknown, path: readonly string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertSafeConfigValue(child, [...path, `[${index}]`]));
    return;
  }
  if (value === null || typeof value !== "object") return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ConfigError([`unsafe config object at ${path.join(".") || "<root>"}`]);
  }
  for (const [key, child] of Object.entries(value)) {
    assertSafeConfigKey(key, [...path, key]);
    assertSafeConfigValue(child, [...path, key]);
  }
}

type LayerValue = DeepPartial<Config> & {
  removeSecrets?: unknown;
  removeMounts?: unknown;
  removeRouteTools?: unknown;
  removePassThroughTools?: unknown;
  removeHostEnv?: unknown;
  removeHostRoAllowlist?: unknown;
  removeAllowHosts?: unknown;
  removePublishPorts?: unknown;
};

const clone = <T>(value: T): T => {
  if (value === undefined || value === null || typeof value !== "object") return value;
  return structuredClone(value);
};

function camel(key: string): string {
  const input = /^[A-Z0-9_]+$/.test(key) ? key.toLowerCase() : key;
  return input.replace(/_([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/Mib$/, "MiB");
}
function snake(key: string): string {
  return key.replace(/MiB/g, "Mib").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
function removedWorkspaceIssues(value: Record<string, unknown>): string[] {
  return Object.keys(value)
    .map(camel)
    .filter((key) => REMOVED_WORKSPACE_KEYS.has(key))
    .map((key) => `${snake(key)} ${REMOVED_WORKSPACE_MESSAGE}`);
}
function assertNoRemovedWorkspaceKeys(value: Record<string, unknown>): void {
  const issues = removedWorkspaceIssues(value);
  if (issues.length) throw new ConfigError(issues);
}
function pathKey(parts: string[]): string { return parts.join("."); }
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function withoutSecret(value: unknown): string {
  return typeof value === "string" && /^\$(?:ENV|FILE):[^\s]+$/.test(value) ? value : "<redacted>";
}
function warning(text: string): string { return text.replace(/(secret|password|token|value)\s*=\s*[^,; ]+/gi, "$1=<redacted>"); }

function stripTomlComment(line: string): string {
  let quote = "";
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote && line[i - 1] !== "\\") quote = "";
    } else if (c === "\"" || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "#" && depth === 0) return line.slice(0, i).trim();
  }
  return line.trim();
}
function splitTopLevel(text: string, delimiter = ","): string[] {
  const result: string[] = [];
  let start = 0, depth = 0, quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== "\\") quote = ""; continue; }
    if (c === "\"" || c === "'") quote = c;
    else if ("[{(".includes(c)) depth++;
    else if ("]})".includes(c)) depth--;
    else if (c === delimiter && depth === 0) { result.push(text.slice(start, i).trim()); start = i + 1; }
  }
  result.push(text.slice(start).trim());
  return result.filter(Boolean);
}
function findEquals(text: string): number {
  let quote = "", depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== "\\") quote = ""; }
    else if (c === "\"" || c === "'") quote = c;
    else if ("[{".includes(c)) depth++;
    else if ("]}".includes(c)) depth--;
    else if (c === "=" && depth === 0) return i;
  }
  return -1;
}
function decodeBasicTomlKey(text: string): string {
  let result = "";
  for (let index = 1; index < text.length - 1; index++) {
    const character = text[index]!;
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escape = text[++index];
    if (escape === undefined) throw new Error("invalid quoted TOML key");
    const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", "\"": "\"", "\\": "\\" };
    if (Object.hasOwn(simple, escape)) {
      result += simple[escape];
      continue;
    }
    if (escape !== "u" && escape !== "U") throw new Error("invalid quoted TOML key");
    const length = escape === "u" ? 4 : 8;
    const hex = text.slice(index + 1, index + 1 + length);
    if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) throw new Error("invalid quoted TOML key");
    const codePoint = Number.parseInt(hex, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) throw new Error("invalid quoted TOML key");
    result += String.fromCodePoint(codePoint);
    index += length;
  }
  return result;
}
function parseTomlKeySegment(text: string): string {
  const key = text.trim();
  if (key.startsWith("\"") && key.endsWith("\"")) return decodeBasicTomlKey(key);
  if (key.startsWith("'") && key.endsWith("'") && !key.slice(1, -1).includes("'")) return key.slice(1, -1);
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  throw new Error("invalid TOML key");
}
function parseTomlKey(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quote === "\"") {
      if (character === "\\") index++;
      else if (character === quote) quote = "";
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === ".") {
      parts.push(parseTomlKeySegment(text.slice(start, index)));
      start = index + 1;
    }
  }
  if (quote) throw new Error("invalid TOML key");
  parts.push(parseTomlKeySegment(text.slice(start)));
  return parts;
}
function parseTomlValue(text: string): unknown {
  const value = text.trim();
  if (value.startsWith("[") && value.endsWith("]")) return splitTopLevel(value.slice(1, -1)).map(parseTomlValue);
  if (value.startsWith("{") && value.endsWith("}")) {
    const object = createRecord();
    for (const part of splitTopLevel(value.slice(1, -1))) {
      const at = findEquals(part);
      if (at < 0) throw new Error("invalid inline table");
      const keys = parseTomlKey(part.slice(0, at));
      assign(object, keys, parseTomlValue(part.slice(at + 1)));
    }
    return object;
  }
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value[0] === "'") return value.slice(1, -1);
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (value === "true" || value === "false") return value === "true";
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
  return value;
}
function assign(root: Record<string, unknown>, keys: string[], value: unknown): void {
  assertSafeConfigPath(keys);
  let current = root;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(current[key])) current[key] = createRecord();
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
}

/** A small dependency-free TOML reader for the config subset. It intentionally has no I/O. */
function readToml(text: string): Record<string, unknown> {
  const root = createRecord();
  let section: string[] = [];
  let arraySection: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw);
    if (!line) continue;
    if (line.startsWith("[[") && line.endsWith("]]")) {
      const keys = parseTomlKey(line.slice(2, -2).trim());
      assertSafeConfigPath(keys);
      let parent: Record<string, unknown> = root;
      for (const key of keys.slice(0, -1)) {
        if (!Array.isArray(parent[key])) parent[key] = [];
        const list = parent[key] as unknown[];
        const last = list[list.length - 1];
        if (!isPlainObject(last)) list.push(createRecord());
        parent = list[list.length - 1] as Record<string, unknown>;
      }
      const final = keys[keys.length - 1]!;
      if (!Array.isArray(parent[final])) parent[final] = [];
      (parent[final] as unknown[]).push(createRecord());
      arraySection = keys;
      section = [];
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      section = parseTomlKey(line.slice(1, -1).trim());
      assertSafeConfigPath(section);
      arraySection = null;
      continue;
    }
    const at = findEquals(line);
    if (at < 0) throw new Error("invalid assignment");
    const keys = parseTomlKey(line.slice(0, at));
    const value = parseTomlValue(line.slice(at + 1));
    if (arraySection) {
      let parent: Record<string, unknown> = root;
      for (const part of arraySection) {
        const list = parent[part];
        if (!Array.isArray(list) || !isPlainObject(list[list.length - 1])) throw new Error("invalid array table");
        parent = list[list.length - 1] as Record<string, unknown>;
      }
      assign(parent, keys, value);
    } else assign(root, [...section, ...keys], value);
  }
  return root;
}

function normalizeValue(value: unknown, path: readonly string[] = []): unknown {
  if (Array.isArray(value)) return value.map((child, index) => normalizeValue(child, [...path, `[${index}]`]));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    assertSafeConfigKey(key, [...path, key]);
    const normalizedKey = camel(key);
    assertSafeConfigKey(normalizedKey, [...path, normalizedKey]);
    out[normalizedKey] = normalizeValue(child, [...path, normalizedKey]);
  }
  return out;
}
function knownPath(path: string): boolean {
  const parts = path.split(".");
  if (parts[0] === "removeSecrets") return parts.length === 1 || (parts.length === 2 && SECRET_FIELDS.has(parts[1]));
  if (parts[0] === "removeMounts") return parts.length === 1 || (parts.length === 2 && MOUNT_FIELDS.has(parts[1]));
  if (parts[0].startsWith("remove")) {
    const nestedNetworkRemoval = parts[0] === "removeAllowHosts" || parts[0] === "removePublishPorts";
    return parts.length === 1 && CONTROL_KEYS.has(parts[0]) && !nestedNetworkRemoval;
  }
  if (parts[0] === "network") return parts.length === 1 || (parts.length === 2 && ["mode", "allowHosts", "allowDns", "publishPorts", "removeAllowHosts", "removePublishPorts"].includes(parts[1]));
  if (parts[0] === "docker") return parts.length === 1 || (parts.length === 2 && ["mode", "startupTimeoutMs"].includes(parts[1]));
  if (parts[0] === "secrets") return parts.length === 1 || (parts.length === 2 && SECRET_FIELDS.has(parts[1]));
  if (parts[0] === "mounts") return parts.length === 1 || (parts.length === 2 && MOUNT_FIELDS.has(parts[1]));
  return ["image", "pullPolicy", "bootstrapTools", "cpus", "memoryMiB", "idleTimeoutSec", "stopTimeoutMs", "detached", "replace", "replaceTimeoutMs", "sandboxName", "blockThirdParty", "routeTools", "passThroughTools", "allowHostExecution", "allowSkillReads", "fallbackMode", "exposeSessionEnvironment", "hostEnv", "autoStart", "pruneOnStart", "showFooter", "lockDir", "hostRoAllowlist"].includes(parts[0]);
}
function collectUnknown(value: unknown, base: string[], warnings: string[]): void {
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const current = pathKey([...base, key]);
    if (!knownPath(current)) warnings.push(`unknown config key ${current}`);
    else if (isPlainObject(child)) collectUnknown(child, [...base, key], warnings);
    else if (Array.isArray(child)) child.forEach((item) => isPlainObject(item) && collectUnknown(item, [...base, key], warnings));
  }
}
function canonicalGuestPath(value: unknown): unknown {
  if (typeof value !== "string" || !isAbsolute(value)) return value;
  const result = normalize(value).replace(/[\\/]$/, "");
  return result || sep;
}
function withMountDefaults(value: LayerValue): LayerValue {
  const result = clone(value);
  if (!Array.isArray(result.mounts)) return result;
  result.mounts = result.mounts.map((raw) => {
    if (!isPlainObject(raw)) return raw as any;
    const mount = { ...raw } as Record<string, unknown>;
    if (mount.type === undefined) mount.type = "dir";
    if (mount.guestPath === undefined && (mount.type === "dir" || mount.type === "file") && typeof mount.hostPath === "string") mount.guestPath = mount.hostPath;
    if (mount.readonly === undefined) mount.readonly = true;
    if (mount.options === undefined) mount.options = [];
    if (typeof mount.guestPath === "string") mount.guestPath = canonicalGuestPath(mount.guestPath);
    return mount as any;
  }) as any;
  return result;
}
function normalizeLayer(name: ConfigLayerName, raw: Record<string, unknown>, source?: string): ParsedConfigLayer {
  assertSafeConfigValue(raw);
  const normalized = normalizeValue(raw) as Record<string, unknown>;
  assertNoRemovedWorkspaceKeys(normalized);
  const value = withMountDefaults(normalized as LayerValue);
  const warnings: string[] = [];
  collectUnknown(value, [], warnings);
  return { name, value, warnings: warnings.map(warning), source };
}

export function parseTomlConfig(text: string, source: string): ParsedConfigLayer {
  const name = ["cli", "env", "project", "host-default", "host-project"].includes(source)
    ? source as ConfigLayerName
    : "global";
  return layerFromText(name, text, source);
}

function envScalar(text: string, key: string): unknown {
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.endsWith(trimmed[0] === "{" ? "}" : "]")) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { /* use scalar below */ }
    if (parsed !== undefined) return normalizeValue(parsed);
  }
  if (trimmed === "true" || trimmed === "false") return trimmed === "true";
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (ALLOWLIST_PATHS.has(key) || key.endsWith("Tools") || key.endsWith("Env") || key.endsWith("Hosts") || key.endsWith("Ports")) {
    // JSON remains the unambiguous form (especially for port mappings). For
    // scalar lists use the native PATH-style delimiter: ':' on POSIX and ';'
    // on Windows. Keep comma input as a compatibility fallback when no native
    // delimiter is present.
    const delimiter = process.platform === "win32" ? ";" : ":";
    const separator = process.platform !== "win32" && !trimmed.includes(":") && trimmed.includes(",") ? "," : delimiter;
    return trimmed ? trimmed.split(separator).map((item) => item.trim()).filter(Boolean) : [];
  }
  return text;
}
export function parseEnvConfig(env: NodeJS.ProcessEnv): ParsedConfigLayer {
  const root = createRecord();
  const warnings: string[] = [];
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith("PI_MSB_") || raw === undefined || name === "PI_MSB_DISABLE" || name === "PI_MSB_CONFIG_FILE") continue;
    const alias = name === "PI_MSB_HOST_RO_PATHS";
    const parts = alias ? ["hostRoAllowlist"] : name.slice("PI_MSB_".length).split("__").filter(Boolean).map(camel);
    if (!parts.length) continue;
    assign(root, parts, envScalar(raw as string, pathKey(parts)));
  }
  const layer = normalizeLayer("env", root, "environment");
  return { ...layer, warnings: [...layer.warnings, ...warnings] };
}

function mergeObject(target: Record<string, any>, source: Record<string, any>, prefix: string[], layer: ConfigLayerName, provenance: Record<string, ConfigLayerName>, warnings: string[]): void {
  for (const [key, value] of Object.entries(source)) {
    const path = [...prefix, key];
    assertSafeConfigKey(key, path);
    if (CONTROL_KEYS.has(key) || value === undefined) continue;
    // Host policy lists are authoritative, never additive. Drop stale identity
    // provenance too, so replaced project mounts/secrets cannot retain authority.
    if ((layer === "host-default" || layer === "host-project" || layer === "temporary") && Array.isArray(value)) {
      target[key] = [];
      const field = pathKey(path);
      for (const prior of Object.keys(provenance)) if (prior.startsWith(`${field}[`)) delete provenance[prior];
      provenance[field] = layer;
    }
    if (key === "secrets" && Array.isArray(value)) { mergeIdentity(target, key, value, "env", layer, provenance); continue; }
    if (key === "mounts" && Array.isArray(value)) { mergeIdentity(target, key, value, "guestPath", layer, provenance); continue; }
    if (ALLOWLIST_PATHS.has(pathKey(path)) && Array.isArray(value)) {
      const existing = Array.isArray(target[key]) ? target[key] : [];
      const removeName = `remove${key[0].toUpperCase()}${key.slice(1)}`;
      const remove = (source as LayerValue)[removeName as keyof LayerValue];
      const removeValues = Array.isArray(remove) ? remove.map(String) : [];
      target[key] = [...existing.filter((x: unknown) => !removeValues.includes(String(x))), ...value.filter((x: unknown) => !removeValues.includes(String(x)) && !existing.includes(x))];
      if (value.length || removeValues.length) provenance[pathKey(path)] = layer;
      continue;
    }
    if (isPlainObject(value)) {
      if (!isPlainObject(target[key])) target[key] = {};
      mergeObject(target[key], value, path, layer, provenance, warnings);
    } else {
      target[key] = clone(value);
      provenance[pathKey(path)] = layer;
    }
  }
  const removalKeys = prefix[0] === "network"
    ? ["removeAllowHosts", "removePublishPorts"]
    : ["removeRouteTools", "removePassThroughTools", "removeHostEnv", "removeHostRoAllowlist"];
  for (const key of removalKeys) {
    const remove = (source as Record<string, unknown>)[key];
    if (!Array.isArray(remove)) continue;
    const field = key.slice(6, 7).toLowerCase() + key.slice(7);
    if (Array.isArray(target[field])) target[field] = target[field].filter((x: unknown) => !remove.map(String).includes(String(x)));
    provenance[pathKey([...prefix, field])] = layer;
  }
}
function mergeIdentity(target: Record<string, any>, key: string, incoming: unknown[], identity: string, layer: ConfigLayerName, provenance: Record<string, ConfigLayerName>): void {
  const existing: any[] = Array.isArray(target[key]) ? target[key] : [];
  for (const [incomingIndex, item] of incoming.entries()) {
    if (!isPlainObject(item)) throw new ConfigError([`${key}[${incomingIndex}] must be an object`]);
    const id = String(item[identity] ?? "");
    const existingIndex = existing.findIndex((old) => isPlainObject(old) && String(old[identity] ?? "") === id);
    if (existingIndex >= 0) existing[existingIndex] = clone(item); else existing.push(clone(item));
    provenance[`${key}[${id}]`] = layer;
  }
  target[key] = existing;
}
function applyRemovals(target: Record<string, any>, source: LayerValue, layer: ConfigLayerName, provenance: Record<string, ConfigLayerName>): void {
  for (const [key, identity, removeKey] of [["secrets", "env", "removeSecrets"], ["mounts", "guestPath", "removeMounts"]] as const) {
    const remove = source[removeKey];
    if (!Array.isArray(remove) || !Array.isArray(target[key])) continue;
    const ids = remove.map((item) => {
      const raw = isPlainObject(item) ? item[identity] ?? item.env ?? item.guestPath ?? "" : item;
      return key === "mounts" ? String(canonicalGuestPath(raw)) : String(raw);
    });
    target[key] = target[key].filter((item: any) => {
      const raw = item?.[identity] ?? "";
      return !ids.includes(key === "mounts" ? String(canonicalGuestPath(raw)) : String(raw));
    });
    provenance[key] = layer;
  }
}

export function mergeConfigLayers(layers: readonly ConfigLayerInput[]): MergeResult {
  const result: Record<string, any> = {};
  const provenance: Record<string, ConfigLayerName> = {};
  const warnings: string[] = [];
  for (const layer of layers) {
    assertSafeConfigValue(layer.value);
    assertNoRemovedWorkspaceKeys(layer.value as Record<string, unknown>);
    warnings.push(...layer.warnings.map(warning));
    const source = withMountDefaults(clone(layer.value) as LayerValue);
    applyRemovals(result, source, layer.name, provenance);
    mergeObject(result, source as Record<string, any>, [], layer.name, provenance, warnings);
  }
  return { value: result as DeepPartial<Config>, provenance, warnings };
}

function mergeWithDefaults(raw: DeepPartial<Config>): Config {
  const merged = mergeConfigLayers([
    { name: "defaults", value: clone(DEFAULT_CONFIG), warnings: [] },
    // Validation fills missing defaults without re-adding default list members
    // that an authoritative policy (or a removal control) already removed.
    { name: "host-project", value: raw, warnings: [] },
  ]).value;
  return merged as Config;
}
function issueForPath(path: string, text: string): string { return `${path}: ${text}`; }
function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function validatePort(port: unknown): boolean {
  if (typeof port !== "string" || !port.trim()) return false;
  const parts = port.split(":");
  if (parts.length > 3) return false;
  const nums = parts.slice(-2).map(Number);
  return parts.every((p, i) => i < parts.length - 2 || /^\d+$/.test(p)) && nums.every((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
}

export function validateConfig(raw: DeepPartial<Config>): Config {
  assertNoRemovedWorkspaceKeys(raw as Record<string, unknown>);
  const config = mergeWithDefaults(raw);
  const issues: string[] = [];
  const n = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  if (typeof config.lockDir !== "string" || !config.lockDir.trim()) issues.push(issueForPath("lockDir", "must be a non-empty string"));
  if (!config.image || typeof config.image !== "string") issues.push(issueForPath("image", "must be a non-empty string"));
  if (!["always", "if-missing", "never"].includes(config.pullPolicy)) issues.push(issueForPath("pullPolicy", "must be always, if-missing, or never"));
  if (!n(config.cpus) || config.cpus < 1 || config.cpus > 64) issues.push(issueForPath("cpus", "must be between 1 and 64"));
  if (!n(config.memoryMiB) || config.memoryMiB < 128) issues.push(issueForPath("memoryMiB", "must be at least 128 MiB"));
  if (!n(config.idleTimeoutSec) || config.idleTimeoutSec < 0) issues.push(issueForPath("idleTimeoutSec", "must be non-negative"));
  if (!n(config.stopTimeoutMs) || config.stopTimeoutMs < 1) issues.push(issueForPath("stopTimeoutMs", "must be positive"));
  if (!n(config.replaceTimeoutMs) || config.replaceTimeoutMs < 1) issues.push(issueForPath("replaceTimeoutMs", "must be positive"));
  const docker = isPlainObject(config.docker) ? config.docker : null;
  if (!docker || !["auto", "require", "disabled"].includes(docker.mode as string)) issues.push(issueForPath("docker.mode", "must be auto, require, or disabled"));
  if (!docker || !n(docker.startupTimeoutMs) || !Number.isInteger(docker.startupTimeoutMs) || (docker.startupTimeoutMs as number) < 1 || (docker.startupTimeoutMs as number) > 300_000) issues.push(issueForPath("docker.startupTimeoutMs", "must be an integer between 1 and 300000"));
  if (!["auto", true, false].includes(config.bootstrapTools)) issues.push(issueForPath("bootstrapTools", "must be auto, true, or false"));
  if (!["block", "host"].includes(config.fallbackMode)) issues.push(issueForPath("fallbackMode", "must be block or host"));
  const booleanFields = ["detached", "replace", "blockThirdParty", "allowHostExecution", "allowSkillReads", "exposeSessionEnvironment", "autoStart", "pruneOnStart", "showFooter"] as const;
  for (const field of booleanFields) if (typeof config[field] !== "boolean") issues.push(issueForPath(field, "must be boolean"));
  if (config.sandboxName !== null && typeof config.sandboxName !== "string") issues.push(issueForPath("sandboxName", "must be a string or null"));
  const stringArray = (field: string, value: unknown) => {
    if (!Array.isArray(value)) { issues.push(issueForPath(field, "must be an array")); return false; }
    for (const item of value) if (typeof item !== "string" || !item) issues.push(issueForPath(field, "must contain non-empty strings"));
    return true;
  };
  if (stringArray("routeTools", config.routeTools)) for (const tool of config.routeTools) if (!ROUTED_TOOLS.includes(tool)) issues.push(issueForPath("routeTools", `unknown routed tool ${tool}`));
  stringArray("passThroughTools", config.passThroughTools);
  if (stringArray("hostEnv", config.hostEnv)) for (const name of config.hostEnv) if (PROTECTED_GUEST_ENV.has(name)) issues.push(issueForPath("hostEnv", `must not forward protected process environment variable ${name}`));
  stringArray("hostRoAllowlist", config.hostRoAllowlist);
  const network = isPlainObject(config.network) ? config.network : null;
  if (!network || !["default", "open", "allowlist", "deny"].includes(network.mode as string)) issues.push(issueForPath("network.mode", "unknown network mode"));
  if (network && stringArray("network.allowHosts", network.allowHosts)) { /* checked above */ }
  if (network && stringArray("network.publishPorts", network.publishPorts)) { /* checked above */ }
  if (network && typeof network.allowDns !== "boolean") issues.push(issueForPath("network.allowDns", "must be boolean"));
  if (network?.mode === "allowlist" && Array.isArray(network.allowHosts) && !network.allowHosts.length && !network.allowDns) issues.push(issueForPath("network", "allowlist needs a host or DNS permission"));
  for (const port of (network && Array.isArray(network.publishPorts) ? network.publishPorts : [])) if (!validatePort(port)) issues.push(issueForPath("network.publishPorts", "invalid port mapping"));
  if (!Array.isArray(config.secrets)) issues.push(issueForPath("secrets", "must be an array"));
  for (const [index, secret] of (Array.isArray(config.secrets) ? config.secrets : []).entries()) {
    if (!secret || typeof secret.env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret.env)) issues.push(issueForPath(`secrets[${index}]`, "env must be a valid host environment name"));
    else if (PROTECTED_GUEST_ENV.has(secret.env)) issues.push(issueForPath(`secrets[${index}].env`, `must not set protected process environment variable ${secret.env}`));
    if (typeof secret?.value !== "string") issues.push(issueForPath(`secrets[${index}].value`, "must be a string"));
    if (!Array.isArray(secret?.allowHosts) || !secret.allowHosts.length || secret.allowHosts.some((host: unknown) => typeof host !== "string" || !host)) issues.push(issueForPath(`secrets[${index}]`, "allowHosts must be a non-empty string array"));
  }
  const seenGuests: { path: string; index: number }[] = [];
  if (!Array.isArray(config.mounts)) issues.push(issueForPath("mounts", "must be an array"));
  for (const [index, mount] of (Array.isArray(config.mounts) ? config.mounts : []).entries()) {
    const guest = mount?.guestPath;
    if (!mount || !["dir", "file", "named", "tmpfs"].includes(mount.type)) issues.push(issueForPath(`mounts[${index}]`, "unknown mount type"));
    if (typeof guest !== "string" || !isAbsolute(guest)) issues.push(issueForPath(`mounts[${index}].guestPath`, "must be absolute"));
    else {
      const canonical = normalize(guest).replace(/[\\/]$/, "") || sep;
      for (const prior of seenGuests) if (isInside(canonical, prior.path) || isInside(prior.path, canonical)) issues.push(issueForPath(`mounts[${index}].guestPath`, `overlaps mount ${prior.index}`));
      seenGuests.push({ path: canonical, index });
    }
    if (typeof mount?.readonly !== "boolean") issues.push(issueForPath(`mounts[${index}].readonly`, "must be boolean"));
    if (!Array.isArray(mount?.options) || mount.options.some((option: unknown) => typeof option !== "string")) issues.push(issueForPath(`mounts[${index}].options`, "must be a string array"));
    if (mount?.type === "named" && (typeof mount.hostPath !== "string" || !mount.hostPath)) issues.push(issueForPath(`mounts[${index}].hostPath`, "named mounts require a volume name"));
    if (mount?.type !== "named" && mount?.type !== "tmpfs" && (typeof mount?.hostPath !== "string" || !isAbsolute(mount.hostPath))) issues.push(issueForPath(`mounts[${index}].hostPath`, "hostPath must be absolute"));
    if (typeof guest === "string" && isAbsolute(guest)) {
      const canonical = String(canonicalGuestPath(guest));
      if (isInside(canonical, "/tmp") || isInside("/tmp", canonical)) issues.push(issueForPath(`mounts[${index}].guestPath`, "must not shadow reserved /tmp paths"));
      if (PROTECTED_GUEST_PATHS.some((reserved) => isInside(canonical, reserved) || isInside(reserved, canonical))) issues.push(issueForPath(`mounts[${index}].guestPath`, "must not shadow protected guest system or Docker runtime paths"));
    }
  }
  if (issues.length) throw new ConfigError(issues);
  return config;
}

function normalizeLegacy(config: Config, warnings: string[], canonical?: (p: string) => string): Config {
  if (!config.hostRoAllowlist.length) return config;
  warnings.push("hostRoAllowlist is deprecated; use read-only mounts instead");
  const mounts = [...config.mounts];
  for (const host of config.hostRoAllowlist) {
    const path = canonical ? canonical(host) : resolve(host);
    if (!mounts.some((mount) => mount.guestPath === path)) mounts.push({ type: "dir", hostPath: path, guestPath: path, readonly: true, options: [] });
  }
  return { ...config, mounts };
}

async function defaultRead(path: string): Promise<string | null> { try { return await fs.readFile(path, "utf8"); } catch { return null; } }
async function readHostPolicyFile(path: string): Promise<string | null> {
  try { return await fs.readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(["host configuration could not be read"]);
  }
}
async function defaultRealpath(path: string): Promise<string> { return fs.realpath(path); }
function configDir(env: NodeJS.ProcessEnv, input: ResolveConfigInput): string {
  return input.xdgConfigHome ?? env.XDG_CONFIG_HOME ?? join(input.homedir ?? env.HOME ?? osHomedir(), ".config");
}
function layerFromText(name: ConfigLayerName, text: string, source: string): ParsedConfigLayer {
  try { return normalizeLayer(name, readToml(text), source); }
  catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError([`invalid TOML in ${source}`]);
  }
}

/** Resolve missing policy locations through existing ancestors; dangling links fail closed. */
export async function canonicalPolicyLocation(path: string, realpath = defaultRealpath): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && dirname(path) !== path) {
      let missing = false;
      let appeared = false;
      try { appeared = !(await fs.lstat(path)).isSymbolicLink(); }
      catch (error) { missing = (error as NodeJS.ErrnoException).code === "ENOENT"; }
      if (missing) return join(await canonicalPolicyLocation(dirname(path), realpath), basename(path));
      // Concurrent bootstrap can create a directory after realpath observed ENOENT.
      // Retry once for an existing non-link; never treat a dangling link as missing.
      if (appeared) { try { return await realpath(path); } catch {} }
    }
    throw new ConfigError(["host configuration path could not be canonicalized"]);
  }
}

/** Follow raw link-target components in filesystem order; jump/.. must inspect jump first. */
async function hostPolicyAncestorLocations(paths: readonly string[], realpath: (path: string) => Promise<string>): Promise<string[]> {
  const locations = new Set<string>();
  let steps = 0;
  for (const path of paths) {
    const absolute = resolve(path);
    let base = parse(absolute).root;
    let pending = absolute.slice(base.length).split(sep);
    const visited = new Set<string>();
    locations.add(base);
    while (pending.length) {
      if (++steps > 256) throw new ConfigError(["host configuration ancestor traversal limit exceeded"]);
      const state = JSON.stringify([base, pending]);
      if (visited.has(state)) throw new ConfigError(["host configuration ancestor traversal cycle detected"]);
      visited.add(state);
      const component = pending.shift()!;
      if (!component || component === "." || component === "..") {
        try {
          if (!(await fs.stat(base)).isDirectory()) throw new Error();
        } catch { throw new ConfigError(["host configuration ancestors could not be inspected"]); }
        if (component === "..") base = dirname(base);
        continue;
      }
      const physicalEntry = join(base, component);
      locations.add(physicalEntry);
      let target: string | undefined;
      try { target = await fs.readlink(physicalEntry); }
      catch (error) {
        // Missing suffixes and ordinary files/directories remain valid dependencies.
        if (!["ENOENT", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          throw new ConfigError(["host configuration ancestors could not be inspected"]);
        }
      }
      if (target !== undefined) {
        const root = parse(target).root;
        if (root) base = root;
        // Do not join/resolve the target: preserve components following symlinks.
        pending = [...target.slice(root.length).split(sep), ...pending];
      } else {
        base = await canonicalPolicyLocation(physicalEntry, realpath);
        locations.add(base);
      }
    }
  }
  return [...locations];
}

/** A workspace must not be able to retarget any ancestor of a host policy path. */
export async function assertPolicyOutsideWorkspace(path: string, workspaceRoots: readonly string[], realpath = defaultRealpath): Promise<void> {
  let current = resolve(path);
  while (true) {
    const canonical = await canonicalPolicyLocation(current, realpath);
    if (workspaceRoots.some((root) => isInside(current, root) || isInside(canonical, root))) {
      throw new ConfigError(["host configuration must be outside the mounted workspace"]);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Session setup only: never call this from the extension factory or bare import. */
export async function ensureDefaultHostConfig(workspaceRoot: string, agentDir = getAgentDir()): Promise<void> {
  const lexicalFile = join(resolve(agentDir), "pi-microsandbox/default.toml");
  const directory = join(await canonicalPolicyLocation(resolve(agentDir)), "pi-microsandbox");
  const file = join(directory, "default.toml");
  const root = await defaultRealpath(workspaceRoot);
  await assertPolicyOutsideWorkspace(lexicalFile, [root, resolve(workspaceRoot)]);
  await assertPolicyOutsideWorkspace(file, [root, resolve(workspaceRoot)]);
  const policyRoot = await canonicalPolicyLocation(directory);
  if (isInside(root, policyRoot)) {
    throw new ConfigError(["host configuration must be outside the mounted workspace"]);
  }
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let handle;
    try { handle = await fs.open(file, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      throw error;
    }
    try { await handle.writeFile(defaultConfigTemplate(DEFAULT_CONFIG), "utf8"); }
    finally { await handle.close(); }
  } catch {
    throw new ConfigError(["host default configuration could not be created"]);
  }
}

/** Canonical I/O targets and lexical reference origins must stay distinct across an agent-root symlink. */
export async function hostConfigTargets(input: ResolveConfigInput) {
  const realpath = input.realpath ?? defaultRealpath;
  const env = input.env ?? process.env;
  const root = await realpath(input.repoRoot ?? input.cwd);
  const home = await realpath(input.homedir ?? env.HOME ?? osHomedir());
  const agentDir = resolve(input.agentDir ?? getAgentDir());
  const canonicalAgentDir = await canonicalPolicyLocation(agentDir, realpath);
  const targets = (anchor: string) => {
    const directory = join(anchor, "pi-microsandbox");
    return {
      global: join(directory, "default.toml"),
      project: isInside(root, home)
        ? join(directory, "projects", relative(home, root), "config.toml")
        : join(directory, "projects-absolute", relative(parse(root).root, root), "config.toml"),
    };
  };
  return { agentDir, canonicalAgentDir, paths: targets(canonicalAgentDir), lexicalPaths: targets(agentDir) };
}

/** Shared host-owned targets for resolution and editing, including missing descendants. */
export async function hostConfigPaths(input: ResolveConfigInput): Promise<{ global: string; project: string }> {
  return (await hostConfigTargets(input)).paths;
}

/** Raw, non-normalized source data. Never expose this to a rendering/logging surface. */
export function readRawConfig(text: string): Record<string, unknown> {
  try { return readToml(text); } catch { throw new ConfigError(["invalid raw configuration"]); }
}

export async function resolveConfig(input: ResolveConfigInput): Promise<ResolvedConfig> {
  const env = input.env ?? process.env;
  const readFile = input.readFile ?? defaultRead;
  const realpath = input.realpath ?? defaultRealpath;
  const warnings: string[] = [];
  const layers: ConfigLayerInput[] = [{ name: "defaults", value: clone(DEFAULT_CONFIG), warnings: [] }];
  const globalPaths = [join(configDir(env, input), "pi-msb", "config.toml")];
  if (env.PI_MSB_CONFIG_FILE) globalPaths.push(isAbsolute(env.PI_MSB_CONFIG_FILE) ? env.PI_MSB_CONFIG_FILE : resolve(input.cwd, env.PI_MSB_CONFIG_FILE));
  const canonicalPath = async (path: string, failClosed = false): Promise<string> => {
    try { return await realpath(path); }
    catch {
      if (failClosed) throw new ConfigError(["mount or trusted project path could not be canonicalized"]);
      return resolve(path);
    }
  };
  const projectRoot = await canonicalPath(input.repoRoot ?? input.cwd);
  const workspaceRoots = [projectRoot, resolve(input.repoRoot ?? input.cwd)];
  for (const file of [...new Set(globalPaths)]) {
    const text = await readFile(file);
    if (text === null) continue;
    try { await assertPolicyOutsideWorkspace(file, workspaceRoots, realpath); }
    catch (error) {
      if (!(error instanceof ConfigError) || !error.message.includes("outside the mounted workspace")) throw error;
      throw new ConfigError(["global configuration must be outside the mounted workspace; migrate to host-owned pi-microsandbox/default.toml or a per-project override"]);
    }
    layers.push(layerFromText("global", text, file));
  }
  const targets = await hostConfigTargets(input);
  const { global: hostDefaultFile, project: hostProjectFile } = targets.paths;
  const hostLayers: ParsedConfigLayer[] = [];
  const hostPolicyPaths: string[] = [];
  for (const [name, file] of [
    ["host-default", hostDefaultFile],
    ["host-project", hostProjectFile],
  ] as const) {
    // Protect even missing policy locations, including symlinked parents, so a
    // writable mount cannot create a higher-priority override on the next reload.
    const lexicalFile = targets.lexicalPaths[name === "host-default" ? "global" : "project"];
    await assertPolicyOutsideWorkspace(lexicalFile, workspaceRoots, realpath);
    await assertPolicyOutsideWorkspace(file, workspaceRoots, realpath);
    hostPolicyPaths.push(lexicalFile, dirname(lexicalFile));
    const protectedPaths = await Promise.all([canonicalPolicyLocation(file, realpath), canonicalPolicyLocation(dirname(file), realpath)]);
    hostPolicyPaths.push(...protectedPaths);
    const text = await (input.readFile ?? readHostPolicyFile)(file);
    if (text === null) continue;
    if (protectedPaths.some((path) => isInside(path, projectRoot))) {
      throw new ConfigError(["host configuration must be outside the mounted workspace"]);
    }
    const policy = layerFromText(name, text, lexicalFile);
    // Normalize relative references against the original lexical policy path,
    // before realpath: an upward reference must not jump to the agent link target.
    if (Array.isArray(policy.value.secrets)) {
      for (const secret of policy.value.secrets) if (typeof secret?.value === "string" && secret.value.startsWith("$FILE:")) {
        secret.value = `$FILE:${await canonicalPath(resolve(dirname(lexicalFile), secret.value.slice(6)), true)}`;
      }
    }
    hostLayers.push(policy);
  }
  hostPolicyPaths.push(...await hostPolicyAncestorLocations(Object.values(targets.lexicalPaths), realpath));
  // Reserve the whole policy directory while any host policy is active. A
  // writable child mount must not be able to create a higher-priority project
  // override that does not exist yet.
  const hostPolicyRoot = hostLayers.length ? await canonicalPolicyLocation(join(targets.canonicalAgentDir, "pi-microsandbox"), realpath) : undefined;
  if (hostPolicyRoot) {
    if (isInside(projectRoot, hostPolicyRoot) || hostPolicyPaths.some((path) => isInside(path, projectRoot))) {
      throw new ConfigError(["host configuration must be outside the mounted workspace"]);
    }
    hostPolicyPaths.push(hostPolicyRoot, join(targets.agentDir, "pi-microsandbox"));
  }
  layers.push(parseEnvConfig(env));
  if (input.cliOverridesToml !== undefined) layers.push(parseTomlConfig(input.cliOverridesToml, "cli"));
  layers.push(...hostLayers);
  if (input.temporaryOverrides) {
    const temporary = clone(input.temporaryOverrides);
    if (Array.isArray(temporary.secrets)) for (const secret of temporary.secrets) {
      if (typeof secret?.value === "string" && secret.value.startsWith("$FILE:")) secret.value = `$FILE:${await canonicalPath(resolve(input.cwd, secret.value.slice(6)), true)}`;
    }
    layers.push({ name: "temporary", value: temporary, warnings: [] });
  }
  const merged = mergeConfigLayers(layers);
  warnings.push(...merged.warnings);
  let config = validateConfig(merged.value);
  config = normalizeLegacy(config, warnings);
  // Legacy mounts participate in the same overlap/type checks as native mounts.
  config = validateConfig(config);
  config = {
    ...config,
    mounts: await Promise.all(config.mounts.map(async (mount) => mount.type === "named" || mount.type === "tmpfs"
      ? mount
      : { ...mount, hostPath: await canonicalPath(mount.hostPath!, true) })),
  };

  const projectGuestPath = String(canonicalGuestPath(resolve(input.repoRoot ?? input.cwd)));
  const projectShadowIssues = config.mounts.flatMap((mount, index) => {
    if (typeof mount.guestPath !== "string") return [];
    const guest = String(canonicalGuestPath(mount.guestPath));
    return isInside(guest, projectGuestPath) || isInside(projectGuestPath, guest)
      ? [issueForPath(`mounts[${index}].guestPath`, "must not shadow the project mount")]
      : [];
  });
  if (projectShadowIssues.length) throw new ConfigError(projectShadowIssues);

  if (config.network.mode === "open") warnings.push("network.mode=\"open\" permits private and host access; it is broader than microsandbox default mode");
  const policyIssues: string[] = [];
  const mountStat = input.stat ?? fs.stat;
  const knownHostDockerSockets = ["/var/run/docker.sock", "/run/docker.sock"];
  if (input.homedir ?? env.HOME) knownHostDockerSockets.push(join(String(input.homedir ?? env.HOME), ".docker", "run", "docker.sock"));
  if (env.XDG_RUNTIME_DIR) knownHostDockerSockets.push(join(env.XDG_RUNTIME_DIR, "docker.sock"));
  for (const [index, mount] of config.mounts.entries()) {
    if (mount.type === "named" || mount.type === "tmpfs" || typeof mount.hostPath !== "string") continue;
    const host = resolve(mount.hostPath);
    if (!mount.readonly && (hostPolicyPaths.some((path) => isInside(path, host)) || (hostPolicyRoot && [hostPolicyRoot, join(targets.agentDir, "pi-microsandbox")].some((root) => isInside(host, root))))) {
      policyIssues.push("writable host mounts must not expose host configuration");
    }
    let unsafe = basename(host) === "docker.sock" || knownHostDockerSockets.some((socket) => isInside(socket, host));
    if (!unsafe) {
      try { unsafe = (await mountStat(host)).isSocket(); }
      catch { policyIssues.push(issueForPath(`mounts[${index}].hostPath`, "could not be safely inspected")); continue; }
    }
    if (unsafe) policyIssues.push(issueForPath(`mounts[${index}].hostPath`, "must not mount a host socket or Docker socket path"));
  }
  if (policyIssues.length) throw new ConfigError(policyIssues);
  if (config.hostRoAllowlist.length) {
    const legacyPaths = new Map(config.hostRoAllowlist.map((path) => [resolve(path), path]));
    const canonicalMounts = await Promise.all(config.mounts.map(async (mount) => {
      const original = mount.hostPath && legacyPaths.has(resolve(mount.hostPath)) ? resolve(mount.hostPath) : undefined;
      if (original !== undefined && mount.guestPath === original && mount.readonly) {
        const rp = await canonicalPath(original);
        return { ...mount, hostPath: rp, guestPath: rp };
      }
      return mount;
    }));
    config = validateConfig({ ...config, mounts: canonicalMounts });
  }
  return { config, provenance: merged.provenance, warnings: warnings.map(warning) };
}

function setAt(base: any, parts: string[], value: unknown): any {
  assertSafeConfigValue(base);
  assertSafeConfigPath(parts);
  assertSafeConfigValue(value, parts);
  const out: any = clone(base) ?? {};
  let current = out;
  for (const part of parts.slice(0, -1)) { if (!isPlainObject(current[part])) current[part] = {}; current = current[part]; }
  current[parts[parts.length - 1]!] = clone(value);
  return out;
}
export function normalizeConfigPath(path: string): string[] {
  const parts = path.split(".");
  if (parts.some((part) => !part)) throw new ConfigError(["invalid setting path"]);
  assertSafeConfigPath(parts);
  return parts.map(camel);
}

export function applyOverride(base: DeepPartial<Config>, dottedSnakeKey: string, value: unknown): DeepPartial<Config> {
  const rawParts = dottedSnakeKey.split(".").filter(Boolean);
  assertSafeConfigPath(rawParts);
  const parts = rawParts.map(camel);
  if (REMOVED_WORKSPACE_KEYS.has(parts[0] ?? "")) {
    throw new ConfigError([`${dottedSnakeKey} ${REMOVED_WORKSPACE_MESSAGE}`]);
  }
  return setAt(base, parts, value) as DeepPartial<Config>;
}
export function removeOverride(base: DeepPartial<Config>, dottedSnakeKey: string): DeepPartial<Config> {
  assertSafeConfigValue(base);
  const out: any = clone(base) ?? {};
  const rawParts = dottedSnakeKey.split(".").filter(Boolean);
  assertSafeConfigPath(rawParts);
  const parts = rawParts.map(camel);
  assertSafeConfigPath(parts);
  if (REMOVED_WORKSPACE_KEYS.has(parts[0] ?? "")) {
    throw new ConfigError([`${dottedSnakeKey} ${REMOVED_WORKSPACE_MESSAGE}`]);
  }
  let current = out;
  for (const part of parts.slice(0, -1)) { if (!isPlainObject(current[part])) return out; current = current[part]; }
  delete current[parts[parts.length - 1]];
  return out;
}

function tomlScalar(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (value === null) return '""';
  if (Array.isArray(value)) return `[${value.map(tomlScalar).join(", ")}]`;
  if (isPlainObject(value)) return `{ ${Object.entries(value).map(([k, v]) => `${snake(k)} = ${tomlScalar(v)}`).join(", ")} }`;
  return JSON.stringify(String(value));
}
function serializeToml(value: Record<string, unknown>, prefix: string[] = []): string[] {
  const lines: string[] = [];
  const scalarEntries = Object.entries(value).filter(([, v]) => !isPlainObject(v) && !(Array.isArray(v) && v.some(isPlainObject)));
  for (const [key, child] of scalarEntries) lines.push(`${snake(key)} = ${tomlScalar(child)}`);
  for (const [key, child] of Object.entries(value)) {
    if (isPlainObject(child)) { lines.push("", `[${[...prefix, snake(key)].join(".")}]`, ...serializeToml(child, [...prefix, key])); }
    else if (Array.isArray(child) && child.some(isPlainObject)) for (const item of child) {
      if (!isPlainObject(item)) continue;
      lines.push("", `[[${[...prefix, snake(key)].join(".")}]]`, ...serializeToml(item, [...prefix, key]));
    }
  }
  return lines;
}
export function overridesToToml(value: DeepPartial<Config>): string {
  assertSafeConfigValue(value);
  return serializeToml(clone(value) as Record<string, unknown>).join("\n").replace(/^\n+/, "") + "\n";
}
export function toEffectiveToml(value: ResolvedConfig): string {
  const config = clone(value.config) as any;
  if (Array.isArray(config.secrets)) config.secrets = config.secrets.map((secret: any) => ({ ...secret, value: withoutSecret(secret.value) }));
  return overridesToToml(config);
}

export async function resolveSecretValue(value: string, env: NodeJS.ProcessEnv, readFile: (p: string) => Promise<string> = async (p) => fs.readFile(p, "utf8")): Promise<string> {
  if (value.startsWith("$ENV:")) {
    const name = value.slice(5);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || env[name] === undefined) throw new ConfigError(["secret environment reference is missing or invalid"]);
    return env[name]!;
  }
  if (value.startsWith("$FILE:")) {
    try { return await readFile(value.slice(6)); } catch { throw new ConfigError(["secret file reference could not be read"]); }
  }
  return value;
}
export function isDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env.PI_MSB_DISABLE;
  return value !== undefined && !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}
