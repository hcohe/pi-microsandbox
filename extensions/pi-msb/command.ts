import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  LABEL_KEYS,
  type MsbControl,
  type PruneReport,
  type RuntimeState,
  type VolumeRecord,
} from "./types.ts";

/** The small part of Pi's command context used by this module. */
export type CommandContext = Pick<
  ExtensionCommandContext,
  "ui" | "hasUI" | "waitForIdle"
>;
export type CommandHandler = (
  args: string,
  ctx: CommandContext,
) => Promise<void>;

const HELP = `Usage: /msb <command>

/status                         Show the current runtime
/on | /off | /reload            Change runtime state
/prune                          Remove stale sandboxes (never volumes)
/volumes ls                     List retained volumes
/volumes rm <name> [--yes]      Remove one unmounted managed volume
/export <paths...> [--to dir]   Safely export files from the sandbox
/logs [tail-lines]              Show recent sandbox logs
/config                         Show redacted effective configuration
/set <key> <value>              Set a session override
/unset <key>                    Remove a session override
/reset                          Remove all session overrides
/network allow <host...>         Allow network hosts
/network deny                   Seal network access
/seal                           Alias for network deny
/mount add <json|host guest>    Add a mount
/mount rm <guest-path>          Remove a mount override
/help                           Show this help`;

function displayTime(createdAt: number | undefined): string {
  if (createdAt === undefined || !Number.isFinite(createdAt)) return "unknown";
  const timestamp = createdAt < 1_000_000_000_000 ? createdAt * 1000 : createdAt;
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Format the short footer/status representation. A display ID is deliberately
 * not used as an identity here; the full sandbox name is the authoritative name.
 */
export function formatStatus(state: RuntimeState): string | undefined {
  switch (state.status) {
    case "active": {
      const info = state.info;
      if (!info) return "MSB active (sandbox details unavailable)";
      return `MSB active · ${info.mode} · ${info.name}`;
    }
    case "booting":
      return "MSB booting…";
    case "stopping":
      return "MSB stopping…";
    case "off":
      return "MSB host (off)";
    case "host-fallback":
      return "MSB host fallback (sandbox unavailable)";
    case "unavailable":
      return `MSB unavailable (blocked)${state.reason ? `: ${state.reason}` : ""}`;
    case "disabled":
      return "MSB disabled";
    default:
      return undefined;
  }
}

/** Text injected into the agent system prompt for the current runtime. */
export function systemPromptNote(state: RuntimeState): string {
  switch (state.status) {
    case "active": {
      const info = state.info;
      if (!info) return "MSB is active, but runtime details are unavailable.";
      const volume = info.volumeName
        ? ` Retained volume: ${info.volumeName}${info.volumeHostPath ? ` at ${info.volumeHostPath}` : ""}.`
        : "";
      const targetWarning =
        " Host-target execution, when enabled, is an explicit escape from the sandbox and should be used deliberately.";
      return `MSB sandbox is active in ${info.mode} mode (${info.name}).${volume}${targetWarning}`;
    }
    case "off":
      return "MSB is explicitly off: tools run on the host. No sandbox is active.";
    case "host-fallback":
      return "MSB could not start and is using the configured host fallback. This is different from explicitly turning MSB off.";
    case "unavailable":
      return "MSB is unavailable and routed tools are blocked. Use /msb on after fixing the reported problem, or explicitly use /msb off if host execution is intended.";
    case "booting":
      return "MSB is booting; wait for it to become active before using routed tools.";
    case "stopping":
      return "MSB is stopping; routed tools are temporarily unavailable.";
    case "disabled":
      return "MSB is disabled.";
    default:
      return "MSB runtime state is unknown; routed tools remain fail-closed.";
  }
}

function tokenize(input: string): string[] {
  const result: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  for (const char of input.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        result.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += char;
    started = true;
  }
  if (escaped) token += "\\";
  if (quote) throw new Error("unterminated quote in command arguments");
  if (started) result.push(token);
  return result;
}

function parseValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith("{") || raw.startsWith("[") || raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("value is not valid JSON");
    }
  }
  return raw;
}

function fullState(state: RuntimeState): string {
  const lines = [formatStatus(state) ?? "MSB state unavailable"];
  const info = state.info;
  if (!info) {
    if (state.reason) lines.push(`Reason: ${state.reason}`);
    return lines.join("\n");
  }

  lines.push(`Name: ${info.name}`);
  lines.push(`Mode: ${info.mode}`);
  lines.push(`Image: ${info.image}`);
  lines.push(`PID: ${info.pid}`);
  lines.push(`Age: ${displayTime(info.createdAt)}`);
  if (info.seedBranch) lines.push(`Branch: ${info.seedBranch}`);
  if (info.seedSha) lines.push(`Seed SHA: ${info.seedSha}`);
  if (info.volumeName) lines.push(`Retained volume: ${info.volumeName}`);
  if (info.volumeHostPath) lines.push(`Volume path: ${info.volumeHostPath}`);
  return lines.join("\n");
}

function volumeLine(
  volume: VolumeRecord,
  details?: {
    branch?: string;
    lastCommit?: string;
    dirtyCount?: number;
    mounted?: boolean;
  },
): string {
  const labels = volume.labels;
  const branch = details?.branch ?? labels[LABEL_KEYS.seedBranch] ?? "-";
  const lastCommit = details?.lastCommit ?? labels[LABEL_KEYS.seedSha] ?? "-";
  const dirty = details?.dirtyCount === undefined ? "unknown" : String(details.dirtyCount);
  const mounted = details?.mounted ? " mounted" : "";
  return `${volume.name}  labels=${JSON.stringify(labels)}  path=${volume.hostPath}  size=${formatBytes(volume.usedBytes)}  age=${displayTime(volume.createdAt)}  branch=${branch}  last=${lastCommit}  dirty=${dirty}${mounted}`;
}

function redactedError(error: unknown, control: MsbControl): string {
  let message = error instanceof Error ? error.message : String(error);
  try {
    for (const secret of control.getEffectiveConfig().config.secrets) {
      if (secret.value) message = message.split(secret.value).join("[redacted]");
    }
  } catch {
    // Error reporting must not make a failed command fail a second time.
  }
  return message || "command failed";
}

function notify(ctx: CommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(message, type);
}

async function confirm(
  ctx: CommandContext,
  title: string,
  message: string,
): Promise<boolean> {
  if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") return false;
  return ctx.ui.confirm(title, message);
}

function parseTail(args: string[]): number | undefined {
  if (!args.length) return undefined;
  if (args.length !== 1 || !/^\d+$/.test(args[0])) {
    throw new Error("logs accepts at most one non-negative tail line count");
  }
  const tail = Number(args[0]);
  if (!Number.isSafeInteger(tail)) throw new Error("tail line count is too large");
  return tail;
}

async function listVolumes(control: MsbControl): Promise<string> {
  const volumes = await control.listVolumes();
  if (!volumes.length) return "No retained volumes.\nVolumes are never pruned automatically.";
  const rows = await Promise.all(
    volumes.map(async (volume) => {
      try {
        const described = await control.describeVolume(volume.name);
        return volumeLine(volume, described);
      } catch {
        return volumeLine(volume);
      }
    }),
  );
  return ["Retained volumes (volumes are never pruned automatically):", ...rows].join("\n");
}

function pruneSummary(report: PruneReport): string {
  const removed = report.removed.length ? report.removed.join(", ") : "none";
  const kept = report.kept.length ? report.kept.join(", ") : "none";
  const errors = report.errors.length ? report.errors.join("; ") : "none";
  return `Prune complete\nInspected: ${report.inspected}\nRemoved: ${removed}\nKept: ${kept}\nErrors: ${errors}\nVolumes are never pruned.`;
}

async function handleVolumeRemove(
  args: string[],
  ctx: CommandContext,
  control: MsbControl,
): Promise<void> {
  const yes = args.includes("--yes");
  const names = args.filter((arg) => arg !== "--yes");
  if (names.length !== 1 || args.filter((arg) => arg === "--yes").length > 1) {
    throw new Error("usage: /msb volumes rm <name> [--yes]");
  }
  await ctx.waitForIdle();
  const name = names[0];
  const described = await control.describeVolume(name);
  if (described.volume.labels[LABEL_KEYS.managed] !== "true") {
    throw new Error("refusing to remove an unmanaged volume");
  }
  if (described.mounted) throw new Error("refusing to remove a mounted volume");

  const metadata = volumeLine(described.volume, described);
  if (!yes) {
    if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") {
      throw new Error("volume removal requires --yes when no UI is available");
    }
    const approved = await confirm(
      ctx,
      "Remove retained volume?",
      `This permanently removes the managed volume.\n${metadata}`,
    );
    if (!approved) {
      notify(ctx, "Volume removal cancelled", "warning");
      return;
    }
  }
  await control.removeVolume(name);
  notify(ctx, `Removed volume ${name}.`);
}

function parseExportArgs(args: string[]): { paths: string[]; destination?: string; yes: boolean } {
  const paths: string[] = [];
  let destination: string | undefined;
  let yes = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--yes") {
      if (yes) throw new Error("duplicate --yes");
      yes = true;
    } else if (arg === "--to") {
      if (destination !== undefined || index + 1 >= args.length) {
        throw new Error("usage: /msb export <paths...> [--to dir]");
      }
      destination = args[++index];
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown export option ${arg}`);
    } else {
      paths.push(arg);
    }
  }
  if (!paths.length) throw new Error("usage: /msb export <paths...> [--to dir]");
  return { paths, destination, yes };
}

async function handleExport(
  args: string[],
  ctx: CommandContext,
  control: MsbControl,
): Promise<void> {
  const { paths, destination, yes } = parseExportArgs(args);
  await ctx.waitForIdle();
  if (!yes && (!ctx.hasUI || typeof ctx.ui.confirm !== "function")) {
    throw new Error("export requires --yes when no UI is available");
  }
  if (!yes && ctx.hasUI && typeof ctx.ui.confirm === "function") {
    const where = destination ? ` to ${destination}` : " to the dedicated export directory";
    const approved = await confirm(
      ctx,
      "Export sandbox files?",
      `Export ${paths.length} path${paths.length === 1 ? "" : "s"}${where}. Existing destinations are never overwritten without confirmation.`,
    );
    if (!approved) {
      notify(ctx, "Export cancelled", "warning");
      return;
    }
  }
  const results = await control.exportPaths(paths, destination);
  if (!results.length) {
    notify(ctx, "No paths were exported.", "warning");
    return;
  }
  notify(ctx, results.map((result) => `${result.source} -> ${result.destination}`).join("\n"));
}

async function handleNetwork(args: string[], control: MsbControl): Promise<string> {
  if (!args.length || args[0] === "help") throw new Error("usage: /msb network allow <host...> | deny");
  const mode = args[0];
  if (mode === "deny") {
    if (args.length !== 1) throw new Error("usage: /msb network deny");
    await control.setOverride("network.mode", "deny");
    return "Network sealed (deny mode).";
  }
  if (mode === "allow") {
    const hosts = args.slice(1);
    if (!hosts.length) throw new Error("network allow requires at least one host");
    await control.setOverride("network.mode", "allowlist");
    await control.setOverride("network.allow_hosts", hosts);
    return `Network allowlist set: ${hosts.join(", ")}`;
  }
  throw new Error("usage: /msb network allow <host...> | deny");
}

async function handleMount(args: string[], control: MsbControl): Promise<string> {
  const action = args[0];
  if (action === "add") {
    const value = args.slice(1);
    if (value.length === 1) {
      const mount = parseValue(value[0]);
      if (!mount || typeof mount !== "object" || Array.isArray(mount)) {
        throw new Error("mount add expects a JSON object or <hostPath> <guestPath>");
      }
      await control.setOverride("mounts", [mount]);
      return "Mount override added.";
    }
    if (value.length < 2 || value.length > 3 || (value[2] !== "--readonly" && value.length === 3)) {
      throw new Error("usage: /msb mount add <json|hostPath guestPath [--readonly]>");
    }
    const mount = {
      type: "dir",
      hostPath: value[0],
      guestPath: value[1],
      readonly: value[2] === "--readonly",
      options: [],
    };
    await control.setOverride("mounts", [mount]);
    return "Mount override added.";
  }
  if (action === "rm" && args.length === 2) {
    await control.setOverride("remove_mounts", [{ guestPath: args[1] }]);
    return `Mount override removed for ${args[1]}.`;
  }
  throw new Error("usage: /msb mount add <json|hostPath guestPath [--readonly]> | rm <guestPath>");
}

async function executeCommand(
  args: string,
  ctx: CommandContext,
  control: MsbControl,
): Promise<void> {
  const tokens = tokenize(args);
  const command = tokens.shift() ?? "status";

  switch (command) {
    case "help":
      if (tokens.length) throw new Error("help does not accept arguments");
      notify(ctx, HELP);
      return;
    case "status":
      if (tokens.length) throw new Error("usage: /msb status");
      notify(ctx, fullState(control.getState()));
      return;
    case "on":
    case "off":
    case "reload": {
      if (tokens.length) throw new Error(`usage: /msb ${command}`);
      await ctx.waitForIdle();
      const before = control.getState();
      if (command === "reload") await control.reload();
      else await control.setEnabled(command === "on");
      const after = control.getState();
      const reused =
        before.info?.volumeName &&
        after.info?.volumeName === before.info.volumeName
          ? `\nVolume reused: ${after.info.volumeName}`
          : "";
      notify(ctx, `${fullState(after)}${reused}`);
      return;
    }
    case "prune": {
      if (tokens.length) throw new Error("usage: /msb prune");
      await ctx.waitForIdle();
      notify(ctx, pruneSummary(await control.pruneNow()));
      return;
    }
    case "volumes":
      if (tokens[0] === "ls" && tokens.length === 1) {
        notify(ctx, await listVolumes(control));
        return;
      }
      if (tokens[0] === "rm") {
        await handleVolumeRemove(tokens.slice(1), ctx, control);
        return;
      }
      throw new Error("usage: /msb volumes ls | /msb volumes rm <name> [--yes]");
    case "export":
      await handleExport(tokens, ctx, control);
      return;
    case "logs":
      notify(ctx, await control.getLogs(parseTail(tokens)));
      return;
    case "config":
      if (tokens.length) throw new Error("usage: /msb config");
      // The facade's TOML representation is the redacted representation. Do not
      // stringify getEffectiveConfig(): resolved secret values must not reach UI.
      notify(ctx, control.getEffectiveConfigToml());
      return;
    case "set":
      if (tokens.length !== 2) throw new Error("usage: /msb set <key> <value>");
      await control.setOverride(tokens[0], parseValue(tokens[1]));
      notify(ctx, `Set override ${tokens[0]}.`);
      return;
    case "unset":
      if (tokens.length !== 1) throw new Error("usage: /msb unset <key>");
      await control.unsetOverride(tokens[0]);
      notify(ctx, `Unset override ${tokens[0]}.`);
      return;
    case "reset":
      if (tokens.length) throw new Error("usage: /msb reset");
      await control.resetOverrides();
      notify(ctx, "Session overrides reset.");
      return;
    case "network":
      notify(ctx, await handleNetwork(tokens, control));
      return;
    case "seal":
      if (tokens.length) throw new Error("usage: /msb seal");
      await control.setOverride("network.mode", "deny");
      notify(ctx, "Network sealed (deny mode).");
      return;
    case "mount":
      notify(ctx, await handleMount(tokens, control));
      return;
    default:
      throw new Error(`unknown /msb command ${command}; use /msb help`);
  }
}

export function createCommandHandler(control: MsbControl): CommandHandler {
  return async (args, ctx) => {
    try {
      await executeCommand(args, ctx, control);
    } catch (error) {
      notify(ctx, `msb: ${redactedError(error, control)}`, "error");
    }
  };
}

export function registerMsbCommand(pi: ExtensionAPI, control: MsbControl): void {
  pi.registerCommand("msb", {
    description: "Manage pi-microsandbox and retained volumes",
    handler: createCommandHandler(control),
  });
}
