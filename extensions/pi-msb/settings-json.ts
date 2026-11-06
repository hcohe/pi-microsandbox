import { DEFAULT_CONFIG, normalizeConfigPath } from "./config.ts";
import { COLLECTION_REMOVALS, SETTINGS_PATHS } from "./settings.ts";

const REDACTED = "<redacted>";
const snake = (key: string): string => key.replace(/MiB/g, "Mib").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Whitelist raw/effective schema data: unknown values must never become a read side channel. */
export function projectSettingsJson(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const paths = [...SETTINGS_PATHS, ...Object.values(COLLECTION_REMOVALS)];
  const scalar = (input: unknown, expected: unknown): unknown => {
    if (Array.isArray(expected)) return Array.isArray(input) && input.every((item) => typeof item === "string") ? input : "<invalid>";
    if (expected === null) return input === null || typeof input === "string" ? input : "<invalid>";
    return typeof input === typeof expected && (typeof input !== "number" || Number.isFinite(input)) ? input : "<invalid>";
  };
  const project = (input: any, prefix = ""): Record<string, unknown> => Object.fromEntries(Object.entries(input).flatMap(([key, child]) => {
    const normalized = normalizeConfigPath(key).map(snake).join(".");
    const path = prefix ? `${prefix}.${normalized}` : normalized;
    if (paths.includes(path)) {
      if (["secrets", "mounts", "remove_secrets", "remove_mounts"].includes(path) && Array.isArray(child)) {
        const allowed = path.includes("secret") ? ["env", "allow_hosts", "text_value", "value", "host_env", "host_cmd"] : ["type", "host_path", "guest_path", "readonly", "options"];
        return [[normalized, child.map((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
          ? Object.fromEntries(Object.entries(entry).flatMap(([k, v]) => {
            const name = normalizeConfigPath(k).map(snake).join(".");
            return allowed.includes(name) ? [[name, ["text_value", "value"].includes(name) ? REDACTED : scalar(v, name === "readonly" ? true : ["allow_hosts", "options"].includes(name) ? [] : "")]] : [];
          })) : typeof entry === "string" && path.startsWith("remove_") ? entry : "<invalid>")]];
      }
      const expected = normalizeConfigPath(path).reduce((obj: any, key) => obj?.[key], DEFAULT_CONFIG);
      return [[normalized, path === "bootstrap_tools" && typeof child === "boolean" ? child : scalar(child, path.includes("remove_") ? [] : expected)]];
    }
    if (child && typeof child === "object" && !Array.isArray(child) && paths.some((p) => p.startsWith(`${path}.`))) return [[normalized, project(child, path)]];
    return [];
  }));
  return project(value);
}
