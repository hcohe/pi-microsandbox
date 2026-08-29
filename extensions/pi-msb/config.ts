import { promises as fs } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type {
  Config,
  ConfigLayerName,
  DeepPartial,
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

/** Defaults from PLAN §11.2. Values containing credentials are deliberately absent. */
export const DEFAULT_CONFIG: Config = {
  image: "ubuntu:24.04",
  bootstrapTools: "auto",
  cpus: 1,
  memoryMiB: 512,
  idleTimeoutSec: 600,
  stopTimeoutMs: 10_000,
  detached: true,
  replace: false,
  replaceTimeoutMs: 10_000,
  sandboxName: null,
  mode: "direct",
  cloneBranch: "current",
  cloneDepth: "unlimited",
  shallowArchive: false,
  volumeQuotaMiB: 2_048,
  network: { mode: "default", allowHosts: [], allowDns: true, publishPorts: [] },
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
  lockDir: "~/.pi-msb/locks",
  hostRoAllowlist: [],
};

export interface ResolveConfigInput {
  cwd: string;
  repoRoot?: string | null;
  projectTrusted: boolean;
  configDirName: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  xdgConfigHome?: string;
  cliOverridesToml?: string;
  readFile?: (path: string) => Promise<string | null>;
  exists?: (path: string) => Promise<boolean>;
  realpath?: (path: string) => Promise<string>;
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
  return key.replace(/MiB/g, "mib").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
function pathKey(parts: string[]): string { return parts.join("."); }
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
function parseTomlValue(text: string): unknown {
  const value = text.trim();
  if (value.startsWith("[") && value.endsWith("]")) return splitTopLevel(value.slice(1, -1)).map(parseTomlValue);
  if (value.startsWith("{") && value.endsWith("}")) {
    const object: Record<string, unknown> = {};
    for (const part of splitTopLevel(value.slice(1, -1))) {
      const at = findEquals(part);
      if (at < 0) throw new Error("invalid inline table");
      object[part.slice(0, at).trim()] = parseTomlValue(part.slice(at + 1));
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
  let current = root;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(current[key])) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

/** A small dependency-free TOML reader for the config subset. It intentionally has no I/O. */
function readToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let section: string[] = [];
  let arraySection: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw);
    if (!line) continue;
    if (line.startsWith("[[") && line.endsWith("]]")) {
      const keys = line.slice(2, -2).trim().split(".").map((x) => x.trim());
      let parent: Record<string, unknown> = root;
      for (const key of keys.slice(0, -1)) {
        if (!Array.isArray(parent[key])) parent[key] = [];
        const list = parent[key] as unknown[];
        const last = list[list.length - 1];
        if (!isPlainObject(last)) list.push({});
        parent = list[list.length - 1] as Record<string, unknown>;
      }
      const final = keys[keys.length - 1];
      if (!Array.isArray(parent[final])) parent[final] = [];
      (parent[final] as unknown[]).push({});
      arraySection = keys;
      section = [];
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim().split(".").map((x) => x.trim());
      arraySection = null;
      continue;
    }
    const at = findEquals(line);
    if (at < 0) throw new Error("invalid assignment");
    const key = line.slice(0, at).trim();
    const value = parseTomlValue(line.slice(at + 1));
    if (arraySection) {
      let parent: Record<string, unknown> = root;
      for (const part of arraySection) {
        const list = parent[part];
        if (!Array.isArray(list) || !isPlainObject(list[list.length - 1])) throw new Error("invalid array table");
        parent = list[list.length - 1] as Record<string, unknown>;
      }
      parent[key] = value;
    } else assign(root, [...section, ...key.split(".").map((x) => x.trim())], value);
  }
  return root;
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) out[camel(key)] = normalizeValue(child);
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
  if (parts[0] === "secrets") return parts.length === 1 || (parts.length === 2 && SECRET_FIELDS.has(parts[1]));
  if (parts[0] === "mounts") return parts.length === 1 || (parts.length === 2 && MOUNT_FIELDS.has(parts[1]));
  return ["image", "bootstrapTools", "cpus", "memoryMiB", "idleTimeoutSec", "stopTimeoutMs", "detached", "replace", "replaceTimeoutMs", "sandboxName", "mode", "cloneBranch", "cloneDepth", "shallowArchive", "volumeQuotaMiB", "blockThirdParty", "routeTools", "passThroughTools", "allowHostExecution", "allowSkillReads", "fallbackMode", "exposeSessionEnvironment", "hostEnv", "autoStart", "pruneOnStart", "lockDir", "hostRoAllowlist"].includes(parts[0]);
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
  const value = withMountDefaults(normalizeValue(raw) as LayerValue);
  const warnings: string[] = [];
  collectUnknown(value, [], warnings);
  if (name === "project" && Array.isArray(value.secrets)) {
    for (const secret of value.secrets as any[]) {
      if (typeof secret?.value === "string" && !/^\$(?:ENV|FILE):/.test(secret.value)) {
        warnings.push("project config contains a literal secret value; use $ENV or $FILE instead");
      }
    }
  }
  return { name, value, warnings: warnings.map(warning), source };
}

export function parseTomlConfig(text: string, source: string): ParsedConfigLayer {
  try { return normalizeLayer(source === "cli" ? "cli" : source === "env" ? "env" : source === "project" ? "project" : "global", readToml(text), source); }
  catch { throw new ConfigError([`invalid TOML in ${source}`]); }
}

function envScalar(text: string, key: string): unknown {
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.endsWith(trimmed[0] === "{" ? "}" : "]")) {
    try { return normalizeValue(JSON.parse(trimmed)); } catch { /* use scalar below */ }
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
  const root: Record<string, unknown> = {};
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
    if (CONTROL_KEYS.has(key) || value === undefined) continue;
    const path = [...prefix, key];
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

export function mergeConfigLayers(layers: ParsedConfigLayer[]): MergeResult {
  const result: Record<string, any> = {};
  const provenance: Record<string, ConfigLayerName> = {};
  const warnings: string[] = [];
  for (const layer of layers) {
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
    { name: "cli", value: raw, warnings: [] },
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
  const config = mergeWithDefaults(raw);
  const issues: string[] = [];
  const n = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  if (!config.image || typeof config.image !== "string") issues.push(issueForPath("image", "must be a non-empty string"));
  if (!n(config.cpus) || config.cpus < 1 || config.cpus > 64) issues.push(issueForPath("cpus", "must be between 1 and 64"));
  if (!n(config.memoryMiB) || config.memoryMiB < 128) issues.push(issueForPath("memoryMiB", "must be at least 128 MiB"));
  if (!n(config.idleTimeoutSec) || config.idleTimeoutSec < 0) issues.push(issueForPath("idleTimeoutSec", "must be non-negative"));
  if (!n(config.stopTimeoutMs) || config.stopTimeoutMs < 1) issues.push(issueForPath("stopTimeoutMs", "must be positive"));
  if (!n(config.replaceTimeoutMs) || config.replaceTimeoutMs < 1) issues.push(issueForPath("replaceTimeoutMs", "must be positive"));
  if (!n(config.volumeQuotaMiB) || config.volumeQuotaMiB < 1) issues.push(issueForPath("volumeQuotaMiB", "must be positive"));
  if (!["auto", "git", "direct", "none"].includes(config.mode)) issues.push(issueForPath("mode", "unknown storage mode"));
  if (!["auto", true, false].includes(config.bootstrapTools)) issues.push(issueForPath("bootstrapTools", "must be auto, true, or false"));
  if (!["block", "host"].includes(config.fallbackMode)) issues.push(issueForPath("fallbackMode", "must be block or host"));
  const booleanFields = ["detached", "replace", "shallowArchive", "blockThirdParty", "allowHostExecution", "allowSkillReads", "exposeSessionEnvironment", "autoStart", "pruneOnStart"] as const;
  for (const field of booleanFields) if (typeof config[field] !== "boolean") issues.push(issueForPath(field, "must be boolean"));
  if (config.sandboxName !== null && typeof config.sandboxName !== "string") issues.push(issueForPath("sandboxName", "must be a string or null"));
  if (typeof config.cloneBranch !== "string" || !config.cloneBranch) issues.push(issueForPath("cloneBranch", "must be a non-empty string"));
  if (config.cloneDepth !== "unlimited" && (!n(config.cloneDepth) || !Number.isInteger(config.cloneDepth) || config.cloneDepth < 1)) issues.push(issueForPath("cloneDepth", "must be a positive integer or unlimited"));
  const stringArray = (field: string, value: unknown) => {
    if (!Array.isArray(value)) { issues.push(issueForPath(field, "must be an array")); return false; }
    for (const item of value) if (typeof item !== "string" || !item) issues.push(issueForPath(field, "must contain non-empty strings"));
    return true;
  };
  if (stringArray("routeTools", config.routeTools)) for (const tool of config.routeTools) if (!ROUTED_TOOLS.includes(tool)) issues.push(issueForPath("routeTools", `unknown routed tool ${tool}`));
  stringArray("passThroughTools", config.passThroughTools);
  stringArray("hostEnv", config.hostEnv);
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
async function defaultExists(path: string): Promise<boolean> { try { await fs.access(path); return true; } catch { return false; } }
async function defaultRealpath(path: string): Promise<string> { return fs.realpath(path); }
async function projectFile(cwd: string, repoRoot: string | null | undefined, configDirName: string, exists: (p: string) => Promise<boolean>): Promise<string | null> {
  let current = resolve(cwd);
  const stop = repoRoot ? resolve(repoRoot) : null;
  while (true) {
    const candidates = [join(current, ".pi-msb.toml"), join(current, configDirName, "msb.toml")];
    for (const candidate of candidates) if (await exists(candidate)) return candidate;
    if (stop && current === stop) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
function configDir(env: NodeJS.ProcessEnv, input: ResolveConfigInput): string {
  return input.xdgConfigHome ?? env.XDG_CONFIG_HOME ?? join(input.homedir ?? env.HOME ?? osHomedir(), ".config");
}
function layerFromText(name: ConfigLayerName, text: string, source: string): ParsedConfigLayer {
  try { return normalizeLayer(name, readToml(text), source); }
  catch { throw new ConfigError([`invalid TOML in ${source}`]); }
}

export async function resolveConfig(input: ResolveConfigInput): Promise<ResolvedConfig> {
  const env = input.env ?? process.env;
  const readFile = input.readFile ?? defaultRead;
  const exists = input.exists ?? defaultExists;
  const realpath = input.realpath ?? defaultRealpath;
  const warnings: string[] = [];
  const layers: ParsedConfigLayer[] = [{ name: "defaults", value: clone(DEFAULT_CONFIG), warnings: [] }];
  const globalPaths = [join(configDir(env, input), "pi-msb", "config.toml")];
  if (env.PI_MSB_CONFIG_FILE) globalPaths.push(isAbsolute(env.PI_MSB_CONFIG_FILE) ? env.PI_MSB_CONFIG_FILE : resolve(input.cwd, env.PI_MSB_CONFIG_FILE));
  for (const file of [...new Set(globalPaths)]) {
    const text = await readFile(file);
    if (text !== null) layers.push(layerFromText("global", text, file));
  }
  const canonicalPath = async (path: string, failClosed = false): Promise<string> => {
    try { return await realpath(path); }
    catch {
      if (failClosed) throw new ConfigError(["trusted project path could not be canonicalized"]);
      return resolve(path);
    }
  };
  const project = await projectFile(input.cwd, input.repoRoot, input.configDirName, exists);
  if (project && !input.projectTrusted) warnings.push("project config ignored because this project is not trusted");
  if (project && input.projectTrusted) {
    const text = await readFile(project);
    if (text !== null) {
      const parsed = layerFromText("project", text, project);
      const projectValue = withMountDefaults(clone(parsed.value) as LayerValue);
      if (Array.isArray(projectValue.mounts)) {
        projectValue.mounts = await Promise.all(projectValue.mounts.map(async (mount: any) => {
          if (mount && (mount.type === "dir" || mount.type === "file") && typeof mount.hostPath === "string" && isAbsolute(mount.hostPath)) {
            return { ...mount, hostPath: await canonicalPath(mount.hostPath, true) };
          }
          return mount;
        })) as any;
      }
      layers.push({ ...parsed, value: projectValue });
    }
  }
  layers.push(parseEnvConfig(env));
  if (input.cliOverridesToml !== undefined) layers.push(parseTomlConfig(input.cliOverridesToml, "cli"));
  const merged = mergeConfigLayers(layers);
  warnings.push(...merged.warnings);
  let config = validateConfig(merged.value);
  config = normalizeLegacy(config, warnings);
  // Legacy mounts participate in the same overlap/type checks as native mounts.
  config = validateConfig(config);

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
  const repo = input.repoRoot ? await canonicalPath(input.repoRoot) : null;
  const projectLayer = layers.find((layer) => layer.name === "project");
  const projectMounts = (projectLayer?.value as LayerValue | undefined)?.mounts;
  const authorizedWrites = layers.filter((layer) => layer.name === "global" || layer.name === "cli")
    .flatMap((layer) => ((layer.value as LayerValue).mounts ?? []) as any[])
    .filter((mount) => mount && mount.readonly === false)
    .map((mount) => String(canonicalGuestPath(mount.guestPath ?? "")));
  const policyIssues: string[] = [];
  const projectSecretFiles = new Map<string, { reference: string; canonical: string }>();
  if (Array.isArray(projectMounts)) for (const mount of projectMounts as any[]) {
    if (!mount || typeof mount.hostPath !== "string" || mount.type === "named" || mount.type === "tmpfs") continue;
    const outsideRepo = !repo || !isInside(mount.hostPath, repo);
    if (outsideRepo && mount.readonly !== true && !authorizedWrites.includes(String(canonicalGuestPath(mount.guestPath ?? "")))) {
      policyIssues.push("project host mounts outside the repository must be read-only unless a global or session policy authorizes write access");
    }
  }
  if (Array.isArray((projectLayer?.value as LayerValue | undefined)?.secrets)) {
    const approvedRoots = await Promise.all([input.cwd, repo ?? input.cwd, input.homedir ?? env.HOME, configDir(env, input)]
      .filter(Boolean).map((item) => canonicalPath(String(item))));
    for (const secret of (projectLayer!.value as any).secrets) if (typeof secret?.value === "string" && secret.value.startsWith("$FILE:")) {
      const file = secret.value.slice(6);
      const absolute = isAbsolute(file) ? file : resolve(dirname(project!), file);
      const canonicalFile = await canonicalPath(absolute, true);
      if (!approvedRoots.some((root) => isInside(canonicalFile, root))) policyIssues.push("project secret file reference is outside approved roots");
      if (typeof secret.env === "string") projectSecretFiles.set(secret.env, { reference: secret.value, canonical: canonicalFile });
    }
  }
  if (policyIssues.length) throw new ConfigError(policyIssues);
  if (projectSecretFiles.size) {
    config = {
      ...config,
      secrets: config.secrets.map((secret) => {
        const approved = projectSecretFiles.get(secret.env);
        return merged.provenance[`secrets[${secret.env}]`] === "project" && approved?.reference === secret.value
          ? { ...secret, value: `$FILE:${approved.canonical}` }
          : secret;
      }),
    };
  }
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
  const out: any = clone(base) ?? {};
  let current = out;
  for (const part of parts.slice(0, -1)) { if (!isPlainObject(current[part])) current[part] = {}; current = current[part]; }
  current[parts[parts.length - 1]] = clone(value);
  return out;
}
export function applyOverride(base: DeepPartial<Config>, dottedSnakeKey: string, value: unknown): DeepPartial<Config> {
  return setAt(base, dottedSnakeKey.split(".").filter(Boolean).map(camel), value) as DeepPartial<Config>;
}
export function removeOverride(base: DeepPartial<Config>, dottedSnakeKey: string): DeepPartial<Config> {
  const out: any = clone(base) ?? {};
  const parts = dottedSnakeKey.split(".").filter(Boolean).map(camel);
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
