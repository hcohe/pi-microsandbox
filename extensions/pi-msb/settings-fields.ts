import { DEFAULT_CONFIG, normalizeConfigPath } from "./config.ts";
import { SETTINGS_PATHS } from "./settings.ts";

export const SECTIONS = ["Overview", "General", "Resources", "Network", "Secrets", "Variables", "Mounts", "Tools", "Image", "Advanced", "Sources", "Actions"] as const;
export type Section = typeof SECTIONS[number];
export interface FieldHelp { hint: string; editorHelp: string; choiceHelp?: Readonly<Record<string, string>> }
export interface SettingsField extends FieldHelp { path: string; section: Section; description: string; choices?: readonly (string | boolean)[] }
const descriptions: Record<string, string> = {
  image: "Guest image (prefer a verified digest). Custom images need runtime tools.",
  pull_policy: "When to download the guest image.", sandbox_name: "Sandbox identity; inherit for the automatic session name.",
  bootstrap_tools: "Choose whether missing guest tools may be installed automatically.",
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
// Menu hints stay brief; editor help is static and never interpolates configured values.
const help: Record<string, FieldHelp> = {
  image: { hint: "The image your sandbox runs", editorHelp: "Enter a nonempty guest image name; prefer a verified digest.\nExample format: registry.example.com/team/image@sha256:<verified-digest>\nCustom images must include the required runtime tools." },
  pull_policy: { hint: "When to download the image", editorHelp: "Choose when the guest image may be downloaded.\nFor example, if-missing reuses a locally available image.", choiceHelp: { always: "Download on every start.", "if-missing": "Download only when the image is not available locally.", never: "Use only a local image; fail if it is missing." } },
  sandbox_name: { hint: "A name for your sandbox", editorHelp: "Enter a sandbox name, or go back to choose the automatic session name.\nExample: my-project\nAutomatic names can only be applied to the current session." },
  bootstrap_tools: { hint: "How guest tools get installed", editorHelp: "Choose whether to install missing tools inside the guest.\nFor example, auto checks which tools the image needs.", choiceHelp: { auto: "Install missing guest tools when needed.", true: "Install missing guest tools when needed.", false: "Never bootstrap; the image must already provide the tools." } },
  cpus: { hint: "Processing power for the sandbox", editorHelp: "Enter a number from 1 to 64 for virtual CPUs.\nExample: 2" },
  memory_mib: { hint: "Memory for the sandbox", editorHelp: "Enter guest memory in MiB, at least 128.\nExample: 2048 (2 GiB)" },
  idle_timeout_sec: { hint: "When an idle sandbox stops", editorHelp: "Enter a non-negative number of idle seconds; 0 disables idle stop.\nExample: 300 (5 minutes)" },
  stop_timeout_ms: { hint: "Time to allow a graceful stop", editorHelp: "Enter a shutdown timeout in milliseconds, at least 1.\nExample: 10000 (10 seconds)" },
  detached: { hint: "Keep the guest process independent", editorHelp: "Choose whether the guest is detached from the process that creates it.\nFor example, true keeps it independent of that process.", choiceHelp: { true: "Create a detached guest process.", false: "Do not request a detached guest process." } },
  replace: { hint: "Legacy replacement preference", editorHelp: "This SDK compatibility flag does not authorize panel recreation.\nFor example, true still requires ownership checks and confirmation.", choiceHelp: { true: "Retain the SDK replacement preference; panel recreation stays guarded.", false: "Do not request SDK replacement; panel recreation stays guarded." } },
  replace_timeout_ms: { hint: "Legacy replacement wait time", editorHelp: "Enter the SDK compatibility timeout in milliseconds, at least 1.\nExample: 10000\nGuarded panel recreation uses stop_timeout_ms instead." },
  auto_start: { hint: "Start a sandbox when Pi starts", editorHelp: "Choose whether to boot automatically on session startup.\nFor example, false lets you enable it later. This never stops a running guest or enables host execution.", choiceHelp: { true: "Boot the sandbox automatically at session startup.", false: "Wait for explicit enablement instead of booting automatically." } },
  prune_on_start: { hint: "Clean up old owned sandboxes", editorHelp: "Choose whether startup cleans up stale sandboxes owned by this integration.\nFor example, true enables startup cleanup.", choiceHelp: { true: "Inspect and prune stale owned sandboxes on startup.", false: "Skip automatic startup pruning." } },
  show_footer: { hint: "Sandbox status in Pi's footer", editorHelp: "Choose whether Pi's footer shows sandbox status.\nFor example, false hides the status without changing isolation.", choiceHelp: { true: "Show the sandbox status indicator.", false: "Hide the sandbox status indicator; the sandbox keeps running." } },
  lock_dir: { hint: "Where ownership locks are stored", editorHelp: "Enter a nonempty host directory for sandbox ownership locks.\nExample: /var/tmp/pi-msb-locks\nKeep it outside untrusted workspaces so guests cannot alter ownership locks." },
  block_third_party: { hint: "How unfamiliar tools are handled", editorHelp: "Choose whether unrecognized third-party tools are blocked.\nFor example, true keeps the stricter boundary. Explicit pass-through tools are separate.", choiceHelp: { true: "Block unrecognized tools unless explicitly passed through.", false: "Allow unrecognized tools on the HOST, outside the sandbox, without per-call host approval." } },
  route_tools: { hint: "Which tools use the sandbox", editorHelp: "Enter one tool name: read, write, edit, ls, find, grep, or bash.\nExample: bash\nThis editor adds or replaces one list item, not a comma-separated list." },
  pass_through_tools: { hint: "Tools you trust to run on the host", editorHelp: "Enter one tool name, not a comma-separated list.\nExample: trusted_local_tool\nThese tools run on the HOST outside the sandbox without per-call host approval." },
  allow_host_execution: { hint: "Whether host requests can be approved", editorHelp: "Choose whether explicit host execution requests may be approved.\nFor example, false keeps this path disabled.", choiceHelp: { true: "Permit HOST execution outside the sandbox only after individual tool-call approval.", false: "Reject explicit host execution requests." } },
  allow_skill_reads: { hint: "Read discovered skills from the host", editorHelp: "Choose whether constrained skill and generated-prompt reads may bypass the sandbox.\nFor example, false disables this HOST read exception.", choiceHelp: { true: "Allow constrained reads of discovered skills and generated prompts from the HOST.", false: "Disable the constrained HOST skill-read exception." } },
  fallback_mode: { hint: "What happens if the sandbox fails", editorHelp: "Choose the behavior after sandbox failure.\nFor example, block fails closed instead of running tools on the host.", choiceHelp: { block: "Block tool execution when the sandbox fails (fail closed).", host: "Permit unsandboxed HOST tool execution after sandbox failure." } },
  expose_session_environment: { hint: "Share selected host variables", editorHelp: "Choose whether named host_env variables are forwarded to the guest.\nFor example, false leaves forwarding disabled. Never forward credentials or process-control variables.", choiceHelp: { true: "Forward only the variables named in host_env, not the whole host environment.", false: "Do not forward host_env variables to the guest." } },
  host_env: { hint: "Which host variables to share", editorHelp: "Enter one host environment variable name, not a comma-separated list.\nExample: LANG\nForwarding requires expose_session_environment. Never forward credentials or process-control variables." },
  host_ro_allowlist: { hint: "Older read-only host paths", editorHelp: "Enter one host path, not a comma-separated list. Prefer a read-only Mount instead.\nExample: /opt/shared-data\nThis deprecated setting exposes host data to the guest." },
  "network.mode": { hint: "How the sandbox reaches the network", editorHelp: "Choose the outbound network policy.\nFor example, allowlist limits connections to Allowed hosts.", choiceHelp: { default: "Allow outbound access but block private networks.", open: "Allow outbound access including private networks.", allowlist: "Restrict outbound hosts to Allowed hosts; DNS permission is configured separately.", deny: "Seal networking; do not permit outbound connections." } },
  "network.allow_hosts": { hint: "Which services the sandbox can reach", editorHelp: "Enter one host or host pattern, not a comma-separated list.\nExample: api.example.com\nUsed by allowlist network mode; this does not grant access to secrets." },
  "network.allow_dns": { hint: "Allow name lookups", editorHelp: "Choose whether restricted network policies permit DNS traffic.\nFor example, true lets allowed services resolve their names.", choiceHelp: { true: "Permit DNS traffic under restricted policies.", false: "Do not grant DNS traffic permission; allowlist mode then needs at least one host." } },
  "network.publish_ports": { hint: "Guest ports available from the host", editorHelp: "Enter one mapping: PORT, HOST:PORT, or IP:HOST:PORT; ports must be 1–65535.\nExample: 127.0.0.1:8080:80\nUse loopback to avoid exposing the guest service to other machines." },
  "docker.mode": { hint: "Whether to run Docker in the guest", editorHelp: "Choose how Docker readiness affects sandbox startup.\nFor example, require fails closed if guest Docker is not ready.", choiceHelp: { auto: "Try guest Docker without requiring it to be available.", require: "Require guest Docker readiness; fail closed if unavailable.", disabled: "Do not start guest Docker." } },
  "docker.startup_timeout_ms": { hint: "Time to wait for guest Docker", editorHelp: "Enter an integer from 1 to 300000 milliseconds for Docker readiness.\nExample: 30000 (30 seconds)" },
  secrets: { hint: "Secrets shared with selected services", editorHelp: "Add a secret with an environment name, allowed hosts and a masked value.\nExample environment name: SERVICE_TOKEN\nValues and references stay private; restrict each secret to the services that need it." },
  mounts: { hint: "Extra storage for the sandbox", editorHelp: "Add a dir, file, named volume or tmpfs mount.\nExample guest path: /mnt/data\nWritable host mounts expose host data. Sockets, writable policy paths and protected guest paths are blocked." },
};
export const SECRET_HOST_HELP = {
  hint: "Which services are allowed to use this secret",
  editorHelp: "Enter a comma-separated list; at least one host is required.\nExample: api.typesafe.ai, api.example.com",
  itemHelp: "Enter one host, not a comma-separated list.\nExample: api.example.com\nAt least one allowed host must remain for this secret.",
};
export const MOUNT_OPTION_HELP = {
  hint: "Extra restrictions for this mount",
  editorHelp: "Enter a comma-separated list of mount options, or leave blank for none.\nExample: noexec, nosuid, nodev\nThese request restrictions on execution, set-user-ID bits and device files, respectively.",
  itemHelp: "Enter one mount option, not a comma-separated list.\nExample: noexec\nOther common options: nosuid, nodev.",
};
const choices: Record<string, readonly (string | boolean)[]> = {
  pull_policy: ["always", "if-missing", "never"], bootstrap_tools: ["auto", true, false],
  fallback_mode: ["block", "host"], "network.mode": ["default", "open", "allowlist", "deny"], "docker.mode": ["auto", "require", "disabled"],
};
export function valueAt(config: unknown, path: string): any {
  return normalizeConfigPath(path).reduce((value: any, key) => value?.[key], config);
}
export const SETTINGS_FIELDS: readonly SettingsField[] = SETTINGS_PATHS.map((path) => ({
  path, description: descriptions[path]!, ...help[path]!,
  section: path.startsWith("network.") ? "Network" : path === "secrets" ? "Secrets" : path === "mounts" ? "Mounts"
    : ["block_third_party", "route_tools", "pass_through_tools", "allow_host_execution"].includes(path) ? "Tools"
    : ["cpus", "memory_mib"].includes(path) ? "Resources"
    : ["image", "pull_policy"].includes(path) ? "Image"
    : path === "host_env" ? "Variables"
    : ["bootstrap_tools", "sandbox_name", "auto_start", "prune_on_start", "show_footer", "detached"].includes(path) ? "General" : "Advanced",
  choices: choices[path] ?? (typeof valueAt(DEFAULT_CONFIG, path) === "boolean" ? [true, false] : undefined),
}));
