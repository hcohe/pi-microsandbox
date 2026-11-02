import { DEFAULT_CONFIG, normalizeConfigPath } from "./config.ts";
import { SETTINGS_PATHS } from "./settings.ts";

export const SECTIONS = ["Overview", "General", "Resources", "Network", "Secrets", "Mounts", "Advanced", "Sources", "Actions"] as const;
export type Section = typeof SECTIONS[number];
export interface SettingsField { path: string; section: Section; description: string; choices?: readonly (string | boolean)[] }
const descriptions: Record<string, string> = {
  image: "Guest image (prefer a verified digest). Custom images need runtime tools.",
  pull_policy: "When to download the guest image.", sandbox_name: "Sandbox identity; inherit for the automatic session name.",
  bootstrap_tools: "Install missing guest tools automatically, always, or never.",
  cpus: "Virtual CPUs, 1–64.", memory_mib: "Guest RAM in MiB, minimum 128.", idle_timeout_sec: "Idle stop in seconds; 0 disables it.",
  stop_timeout_ms: "Graceful shutdown timeout in milliseconds (>0).", detached: "Keep the guest detached from its creating process.",
  replace: "Retained SDK compatibility flag; panel recreation always requires ownership and confirmation.", replace_timeout_ms: "Retained compatibility timeout (>0 ms); guarded recreation uses stop_timeout_ms.",
  auto_start: "Automatically boot on session startup. Changing this never stops a running guest or enables host execution.", prune_on_start: "Clean up stale owned sandboxes on startup.",
  show_footer: "Show sandbox status in Pi's footer.", lock_dir: "Host owner-lock directory; keep it outside untrusted workspaces.",
  block_third_party: "Block unrecognized tools unless explicitly passed through.", route_tools: "Sandbox tools: read, write, edit, ls, find, grep, bash.",
  pass_through_tools: "Named tools allowed to execute on the HOST.", allow_host_execution: "Permit explicit, individually approved host execution.",
  allow_skill_reads: "Allow constrained reads of discovered skills and generated prompts.", fallback_mode: "block fails closed; host permits HOST execution on sandbox failure.",
  expose_session_environment: "Expose only the named host_env variables; never forward credentials.", host_env: "Host variable names forwarded to the guest (not process-control variables).",
  host_ro_allowlist: "Deprecated read-only host paths; prefer Mounts.",
  "network.mode": "default blocks private networks; open permits them; allowlist restricts hosts; deny seals networking.",
  "network.allow_hosts": "Allowed outbound hosts/patterns for allowlist mode.", "network.allow_dns": "Allow DNS traffic in restricted policies.",
  "network.publish_ports": "Guest port mappings: PORT, HOST:PORT, or IP:HOST:PORT. Prefer loopback.",
  "docker.mode": "Docker inside the VM: auto best effort, require fail-closed, or disabled.",
  "docker.startup_timeout_ms": "Docker readiness timeout, integer milliseconds 1–300000.",
  secrets: "Destination-scoped secret injection. Values stay masked; omit replacement to retain.",
  mounts: "Additional mounts; writable host data is exposed. No sockets, policy paths or guest system overlap.",
};
const choices: Record<string, readonly (string | boolean)[]> = {
  pull_policy: ["always", "if-missing", "never"], bootstrap_tools: ["auto", true, false],
  fallback_mode: ["block", "host"], "network.mode": ["default", "open", "allowlist", "deny"], "docker.mode": ["auto", "require", "disabled"],
};
export function valueAt(config: unknown, path: string): any {
  return normalizeConfigPath(path).reduce((value: any, key) => value?.[key], config);
}
export const SETTINGS_FIELDS: readonly SettingsField[] = SETTINGS_PATHS.map((path) => ({
  path, description: descriptions[path]!,
  section: path.startsWith("network.") ? "Network" : path === "secrets" ? "Secrets" : path === "mounts" ? "Mounts"
    : ["cpus", "memory_mib", "idle_timeout_sec", "stop_timeout_ms", "replace_timeout_ms"].includes(path) ? "Resources"
    : ["image", "pull_policy", "bootstrap_tools", "sandbox_name", "auto_start", "prune_on_start", "show_footer", "detached"].includes(path) ? "General" : "Advanced",
  choices: choices[path] ?? (typeof valueAt(DEFAULT_CONFIG, path) === "boolean" ? [true, false] : undefined),
}));
