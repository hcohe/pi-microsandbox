import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyOverride,
  DEFAULT_CONFIG,
  isDisabledByEnv,
  overridesToToml,
  resolveConfig,
  resolveSecretValue,
  removeOverride,
  toEffectiveToml,
} from "./config.ts";
import { buildSandboxLabels, decodeSessionState, normalizeSandboxRecord, encodeSessionState } from "./labels.ts";
import { acquireOwnerLock, createLocksPort } from "./locks.ts";
import { createBashOps, createFindOps, createGrepOps } from "./operations-exec.ts";
import { createEditOps, createLsOps, createReadOps, createWriteOps } from "./operations.ts";
import { pruneStale, type PrunePort } from "./prune.ts";
import { createSdkTransport } from "./transport.ts";
import { discoverWorkspace } from "./workspace.ts";
import { createSandboxManager, type InspectedSandbox, type SandboxManagerDeps } from "./sandbox-manager.ts";
import {
  LOCKFILE_VERSION,
  sandboxNameFor,
  type BootRequest,
  type Config,
  type LockInfo,
  type LocksPort,
  type MsbControl,
  type PersistedSandboxState,
  type ResolvedConfig,
  type RuntimeExecution,
  type RuntimePreparation,
  type RuntimeState,
  type ToolOperations,
  type ToolOpsProvider,
  type Workspace,
  type DeepPartial,
} from "./types.ts";

const STATE_ENTRY = "pi-msb.state";
const OVERRIDE_ENTRY = "pi-msb.override";
const REQUIRED_GUEST_COMMANDS = ["bash", "rg", "file", "cat", "mkdir", "rm"] as const;

type AnyRecord = Record<string, any>;

/** The deliberately small SDK surface used by the adapter. Tests can inject this. */
export interface MicrosandboxModule {
  Sandbox: AnyRecord;
  NetworkPolicy?: AnyRecord;
  Rule?: AnyRecord;
}

export interface SessionSetup {
  sessionId: string;
  cwd: string;
  projectTrusted: boolean;
  config?: ResolvedConfig;
  restored?: PersistedSandboxState | null;
}

export interface MsbControlOptions {
  sessionId: string;
  cwd: string;
  configDirName: string;
  env?: NodeJS.ProcessEnv;
  sdkLoader?: () => Promise<MicrosandboxModule>;
  locksPort?: LocksPort;
  acquireOwnerLock?: SandboxManagerDeps["acquireOwnerLock"];
  appendEntry?: (customType: string, data?: unknown) => void;
  entries?: () => readonly unknown[];
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
  onState?: (state: RuntimeState) => void;
}

export interface MsbIntegration {
  control: MsbControl;
  manager: ReturnType<typeof createSandboxManager>;
  provider: ToolOpsProvider;
  configRef: { value: Config };
  configureSession(setup: SessionSetup): Promise<RuntimeState>;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function redactedError(error: unknown, config: Config): Error {
  let message = errorText(error);
  for (const secret of config.secrets) if (secret.value) message = message.split(secret.value).join("[REDACTED]");
  return new Error(message || "microsandbox operation failed");
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function sdkNotFound(error: unknown): boolean {
  const value = error as AnyRecord;
  const name = typeof value?.constructor?.name === "string" ? value.constructor.name : "";
  return name.includes("NotFound") || ["NOT_FOUND", "ENOENT", "sandboxNotFound"].includes(value?.code);
}

function objectConfig(value: unknown): AnyRecord {
  if (value && typeof value === "object") return value as AnyRecord;
  return {};
}

function sdkLabels(value: unknown): Record<string, string> {
  const raw = objectConfig(value);
  const source = raw.labels ?? raw.config?.labels;
  const out: Record<string, string> = {};
  if (Array.isArray(source)) {
    for (const pair of source) {
      if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string") out[pair[0]] = pair[1];
    }
    return out;
  }
  const labels = objectConfig(source);
  for (const [key, item] of Object.entries(labels)) if (typeof item === "string") out[key] = item;
  return out;
}

function sdkStatus(value: unknown): string | undefined {
  const status = objectConfig(value).status ?? objectConfig(value).state;
  return typeof status === "string" ? status : undefined;
}

async function handleConfig(handle: AnyRecord): Promise<AnyRecord> {
  try {
    if (typeof handle.config === "function") return objectConfig(await handle.config());
  } catch { /* configJson is a compatible fallback */ }
  try {
    if (typeof handle.configJson === "string") return objectConfig(JSON.parse(handle.configJson));
    if (typeof handle.configJson === "function") return objectConfig(JSON.parse(await handle.configJson()));
  } catch { /* malformed SDK metadata is treated as untrusted */ }
  return {};
}

function inspectedFromHandle(handle: AnyRecord, config: AnyRecord = {}): InspectedSandbox {
  return {
    name: typeof handle.name === "string" ? handle.name : String(config.name ?? ""),
    status: sdkStatus(handle),
    labels: sdkLabels(config),
    createdAt: handle.createdAt instanceof Date ? handle.createdAt.getTime() : typeof handle.createdAt === "number" ? handle.createdAt : undefined,
    _handle: handle,
    _config: config,
  };
}

function parsePort(value: string): { bind: string; host: number; guest: number } {
  const parts = value.split(":");
  const numbers = parts.slice(-2).map((item) => Number(item));
  if (parts.length === 1) return { bind: "127.0.0.1", host: numbers[0], guest: numbers[0] };
  if (parts.length === 2) return { bind: "127.0.0.1", host: numbers[0], guest: numbers[1] };
  return { bind: parts[0], host: numbers[0], guest: numbers[1] };
}

function applyMount(builder: AnyRecord, mount: Config["mounts"][number]): void {
  const guest = mount.guestPath!;
  builder.volume(guest, (m: AnyRecord) => {
    if (mount.type === "dir" || mount.type === "file") m.bind(mount.hostPath!);
    else if (mount.type === "named") m.named(mount.hostPath!);
    else m.tmpfs();
    if (mount.readonly) m.readonly();
    for (const option of mount.options) {
      if (option === "noexec") m.noexec();
      else if (option === "nosuid") m.nosuid();
      else if (option === "nodev") m.nodev();
      else throw new Error(`unsupported microsandbox mount option: ${option}`);
    }
    return m;
  });
}

function applyNetwork(builder: AnyRecord, config: Config, sdk: MicrosandboxModule): void {
  const network = config.network;
  if (network.mode !== "default") {
    if (network.mode === "deny") {
      builder.disableNetwork();
    } else if (network.mode === "open") {
      const policyApi = sdk.NetworkPolicy;
      if (!policyApi?.allowAll) throw new Error("microsandbox does not provide NetworkPolicy.allowAll");
      builder.network((n: AnyRecord) => n.policy(policyApi.allowAll()));
    } else {
      const policyApi = sdk.NetworkPolicy;
      if (!policyApi?.builder) throw new Error("microsandbox does not provide a network policy builder");
      const policy = policyApi.builder().defaultDeny().defaultIngress("deny");
      for (const host of network.allowHosts) {
        policy.egress((rule: AnyRecord) => rule.allow((destination: AnyRecord) => {
          if (host.includes("/") || /^\d+(?:\.\d+){3}$/.test(host)) return destination.cidr(host);
          return destination.domain(host);
        }));
      }
      if (network.allowDns) policy.egress((rule: AnyRecord) => rule.udp().tcp().port(53).allowHost());
      builder.network((n: AnyRecord) => n.policy(policy));
    }
  }
  for (const portValue of network.publishPorts) {
    const port = parsePort(portValue);
    if (port.bind === "127.0.0.1") builder.port(port.host, port.guest);
    else builder.portBind(port.bind, port.host, port.guest);
  }
}

function lockInfoFor(request: BootRequest): LockInfo {
  return {
    version: LOCKFILE_VERSION,
    sessionId: request.sessionId,
    sandboxName: request.config.sandboxName ?? sandboxNameFor(request.sessionId),
    cwd: request.cwd,
    root: request.workspace.hostRoot,
    pid: process.pid,
    createdAt: Date.now(),
  };
}

function persistenceState(entries: readonly unknown[], sessionId: string): PersistedSandboxState | null {
  for (const entry of [...entries].reverse()) {
    const value = objectConfig(entry);
    if (value.type !== "custom" || value.customType !== STATE_ENTRY) continue;
    const decoded = decodeSessionState(value.data, sessionId);
    if (decoded) return decoded;
  }
  return null;
}

function sanitizeOverride(key: string, value: unknown): unknown {
  if (/secret|password|token|credential|\.value/i.test(key)) return "[REDACTED]";
  return structuredClone(value);
}

export function createMsbIntegration(options: MsbControlOptions): MsbIntegration {
  const configRef = { value: { ...DEFAULT_CONFIG, network: { ...DEFAULT_CONFIG.network }, docker: { ...DEFAULT_CONFIG.docker } } as Config };
  let sessionId = options.sessionId;
  let cwd = options.cwd;
  let workspace: Workspace | null = null;
  let resolved: ResolvedConfig = { config: configRef.value, provenance: {}, warnings: [] };
  let overrides: DeepPartial<Config> = {};
  let projectTrusted = true;
  let configReady = false;
  let explicitOff = isDisabledByEnv(options.env ?? process.env);
  let failureState: RuntimeState | null = explicitOff ? { status: "off", info: null } : { status: "unavailable", info: null, reason: "session has not started" };
  let sdkPromise: Promise<MicrosandboxModule> | null = null;
  let activeProjectRoot = cwd;

  const loadSdk = async (): Promise<MicrosandboxModule> => {
    if (!sdkPromise) sdkPromise = (options.sdkLoader ?? (async () => await import("microsandbox")))();
    return sdkPromise;
  };
  const lockPort = () => options.locksPort ?? createLocksPort({ lockDir: expandHome(configRef.value.lockDir) });
  const sdk = async () => loadSdk();

  const listSandboxPage = async (input: { labels: Record<string, string>; cursor?: string }) => {
    const msb = await sdk();
    const page = await msb.Sandbox.listWith((list: AnyRecord) => {
      if (input.cursor) list.cursor(input.cursor);
      if (typeof list.labels === "function") list.labels(input.labels);
      else for (const [key, value] of Object.entries(input.labels)) list.label(key, value);
      return list;
    });
    return {
      sandboxes: page.sandboxes.map((item: AnyRecord) => normalizeSandboxRecord({
        name: item.name,
        status: item.status,
        labels: sdkLabels(item.config?.() ?? item),
        createdAt: item.createdAt instanceof Date ? item.createdAt.getTime() : item.createdAt,
      })).filter((item: any): item is any => item !== null),
      nextCursor: page.nextCursor,
    };
  };

  const prunePort: PrunePort = {
    listPage: listSandboxPage,
    stop: async (name, timeout) => {
      const msb = await sdk();
      const handle = await msb.Sandbox.get(name);
      await handle.stopWithTimeout(timeout);
    },
    remove: async (name) => {
      const msb = await sdk();
      const handle = await msb.Sandbox.get(name);
      await handle.remove();
    },
  };

  const deps: SandboxManagerDeps = {
    acquireOwnerLock: async (request) => options.acquireOwnerLock
      ? options.acquireOwnerLock(request)
      : acquireOwnerLock({ lockDir: expandHome(request.config.lockDir) }, lockInfoFor(request)),
    pruneOthers: async (currentSessionId) => pruneStale({ port: prunePort, locks: lockPort(), currentSessionId, stopTimeoutMs: configRef.value.stopTimeoutMs }),
    inspectSandbox: async (name) => {
      const msb = await sdk();
      try {
        const handle = await msb.Sandbox.get(name);
        return inspectedFromHandle(handle, await handleConfig(handle));
      } catch (error) {
        if (sdkNotFound(error)) return null;
        throw error;
      }
    },
    connectSandbox: async (value) => objectConfig(value)._handle.connect(),
    startSandbox: async (value) => objectConfig(value)._handle.startDetached(),
    createSandbox: async (request) => {
      const msb = await sdk();
      const name = request.config.sandboxName ?? sandboxNameFor(request.sessionId);
      const labels = buildSandboxLabels({ sessionId: request.sessionId, cwd: request.cwd, root: request.workspace.hostRoot, guestRoot: request.workspace.guestRoot, pid: process.pid, image: request.config.image });
      let builder = msb.Sandbox.builder(name).image(request.config.image).pullPolicy(request.config.pullPolicy).cpus(request.config.cpus).memory(request.config.memoryMiB).idleTimeout(request.config.idleTimeoutSec).detached(request.config.detached).workdir(request.workspace.cwd).labels(labels);
      builder.volume(request.workspace.guestRoot, (m: AnyRecord) => m.bind(request.workspace.hostRoot));
      for (const mount of request.config.mounts) applyMount(builder, mount);
      applyNetwork(builder, request.config, msb);
      const envValues: Record<string, string> = {};
      if (request.config.exposeSessionEnvironment) {
        for (const name of request.config.hostEnv) if (typeof (options.env ?? process.env)[name] === "string") envValues[name] = (options.env ?? process.env)[name]!;
      }
      if (Object.keys(envValues).length) builder.envs(envValues);
      // Secret values are resolved and passed only to the immediate SDK builder closure.
      // SDK failures are sanitized before they cross the manager boundary.
      const resolvedSecrets: string[] = [];
      try {
        for (const secret of request.config.secrets) {
          const value = await resolveSecretValue(secret.value, options.env ?? process.env);
          resolvedSecrets.push(value);
          builder.secret((entry: AnyRecord) => {
            entry.env(secret.env).value(value).requireTlsIdentity(true);
            for (const host of secret.allowHosts) {
              if (host.includes("*") || host.includes("?")) entry.allowHostPattern(host);
              else entry.allowHost(host);
            }
            return entry;
          });
        }
        return await builder.create();
      } catch (error) {
        let message = errorText(error);
        for (const value of resolvedSecrets) if (value) message = message.split(value).join("[REDACTED]");
        throw new Error(message || "sandbox creation failed");
      }
    },
    stopAndRemove: async (name, timeout) => {
      const msb = await sdk();
      const handle = await msb.Sandbox.get(name);
      await handle.stopWithTimeout(timeout);
      if (typeof handle.waitUntilStopped === "function") {
        const stopped = await handle.waitUntilStopped();
        const status = String(stopped?.status ?? "").toLowerCase();
        if (status && !["stopped", "exited", "dead", "killed", "created"].includes(status)) throw new Error(`sandbox ${name} did not stop`);
      }
      await handle.remove();
    },
    createTransport: (raw) => createSdkTransport(raw),
    createOperations: (transport) => {
      const fileOptions = { projectRoot: activeProjectRoot };
      return {
        read: createReadOps(transport, fileOptions),
        write: createWriteOps(transport, fileOptions),
        edit: createEditOps(transport, fileOptions),
        ls: createLsOps(transport, fileOptions),
        find: createFindOps(transport),
        grep: createGrepOps(transport),
        bash: createBashOps({ withRuntime: async (callback) => callback({ transport, operations: undefined as never }) }),
      } as ToolOperations;
    },
    prepareRuntime: async (runtime, config): Promise<RuntimePreparation> => {
      const commandsMissing = async (commandNames: readonly string[]) => {
        const result = await Promise.all(commandNames.map(async (command) => ({
          command,
          result: await runtime.transport.exec("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "pi-msb-probe", command]),
        })));
        return result.filter((item) => item.result.exitCode !== 0).map((item) => item.command);
      };
      let commands = await commandsMissing(REQUIRED_GUEST_COMMANDS);
      if (commands.length && config.bootstrapTools !== false) {
        const apt = await runtime.transport.exec("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "pi-msb-probe", "apt-get"]);
        if (apt.exitCode === 0) {
          await runtime.transport.exec("apt-get", ["update", "-y"]);
          await runtime.transport.exec("apt-get", ["install", "-y", "--no-install-recommends", "bash", "ripgrep", "file", "coreutils", "ca-certificates"]);
          commands = await commandsMissing(REQUIRED_GUEST_COMMANDS);
        }
      }
      if (commands.length) throw new Error(`sandbox is missing required commands: ${commands.join(", ")}; install them or use bootstrapTools=true`);

      const mode = config.docker.mode;
      if (mode === "disabled") return { docker: { mode, readiness: "disabled" } };

      const dockerComponents = [
        { name: "docker", path: "/usr/local/bin/docker" },
        { name: "dockerd", path: "/usr/local/bin/dockerd" },
        { name: "pi-msb-docker-start", path: "/usr/local/sbin/pi-msb-docker-start" },
      ] as const;
      const dockerChecks = await Promise.all(dockerComponents.map(async (component) => ({
        ...component,
        result: await runtime.transport.exec("/usr/bin/test", ["-x", component.path]),
      })));
      const missingDocker = dockerChecks.filter((item) => item.result.exitCode !== 0).map((item) => item.name);
      if (missingDocker.length) {
        const reason = `image is missing Docker components: ${missingDocker.join(", ")}`;
        if (mode === "require") throw new Error(reason);
        return { docker: { mode, readiness: "missing", reason } };
      }

      let started = false;
      try {
        const result = await runtime.transport.exec(
          "/usr/bin/env",
          [
            "-i",
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME=/root",
            "/usr/local/sbin/pi-msb-docker-start",
            String(config.docker.startupTimeoutMs),
          ],
          { timeoutMs: config.docker.startupTimeoutMs + 2_000 },
        );
        started = result.exitCode === 0;
      } catch {
        // Keep host-visible status bounded so transport errors cannot expose
        // environment or secret values.
      }
      if (!started) {
        const reason = "Docker daemon did not become ready; inspect /var/log/pi-msb-dockerd.log inside the sandbox";
        if (mode === "require") throw new Error(reason);
        return { docker: { mode, readiness: "unavailable", reason } };
      }

      const inspectLocalDocker = (args: string[]) => runtime.transport.exec(
        "/usr/bin/env",
        [
          "-i",
          "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "HOME=/root",
          "/usr/local/bin/docker",
          "--host=unix:///var/run/docker.sock",
          ...args,
        ],
        { timeoutMs: 5_000 },
      );
      let version: string | undefined;
      let storageDriver: string | undefined;
      try {
        const [versionResult, driverResult] = await Promise.all([
          inspectLocalDocker(["version", "--format", "{{.Server.Version}}"]),
          inspectLocalDocker(["info", "--format", "{{.Driver}}"]),
        ]);
        if (versionResult.exitCode === 0 && driverResult.exitCode === 0) {
          version = versionResult.stdout.toString("utf8").trim().split(/\r?\n/, 1)[0]?.slice(0, 128);
          storageDriver = driverResult.stdout.toString("utf8").trim().split(/\r?\n/, 1)[0]?.slice(0, 128);
        }
      } catch {
        // Report a bounded capability error below.
      }
      if (!version || !storageDriver) {
        const reason = "Docker daemon became reachable but capability inspection failed";
        if (mode === "require") throw new Error(reason);
        return { docker: { mode, readiness: "unavailable", reason } };
      }
      return { docker: { mode, readiness: "ready", version, storageDriver } };
    },
    persist: (state) => options.appendEntry?.(STATE_ENTRY, encodeSessionState(state)),
  };

  const manager = createSandboxManager(deps);
  const notifyState = (state: RuntimeState) => options.onState?.(state);
  const visibleState = (): RuntimeState => {
    const state = failureState ?? manager.getState();
    if (explicitOff && (state.status === "disabled" || state.status === "off")) return { status: "off", info: null };
    return state;
  };
  const provider: ToolOpsProvider = {
    isActive: () => manager.isActive(),
    getState: visibleState,
    withRuntime: (callback) => manager.withRuntime(callback),
  };
  const effective = (): ResolvedConfig => resolved;
  const configSnapshot = (): Config => structuredClone(configRef.value);
  const overrideEntries = (entries: readonly unknown[]): DeepPartial<Config> => {
    let result: DeepPartial<Config> = {};
    for (const entry of entries) {
      const value = objectConfig(entry);
      if (value.type !== "custom" || value.customType !== OVERRIDE_ENTRY) continue;
      if (value.data?.reset === true) { result = {}; continue; }
      if (typeof value.data?.key !== "string") continue;
      if (value.data?.unset === true) result = removeOverride(result, value.data.key);
      else if (value.data?.value !== "[REDACTED]") result = applyOverride(result, value.data.key, value.data.value);
    }
    return result;
  };
  const resolveForSession = async (setup: SessionSetup, selected: Workspace): Promise<ResolvedConfig> => {
    if (setup.config) return setup.config;
    return resolveConfig({ cwd: selected.cwd, repoRoot: selected.guestRoot, projectTrusted: setup.projectTrusted, configDirName: options.configDirName, env: options.env, cliOverridesToml: overridesToToml(overrides) });
  };

  const configureSession = async (setup: SessionSetup): Promise<RuntimeState> => {
    sessionId = setup.sessionId;
    cwd = setup.cwd;
    configReady = false;
    projectTrusted = setup.projectTrusted;
    explicitOff = isDisabledByEnv(options.env ?? process.env);
    if (explicitOff) {
      failureState = { status: "off", info: null };
      notifyState(failureState);
      return visibleState();
    }
    let next: ResolvedConfig;
    try {
      overrides = overrideEntries(options.entries?.() ?? []);
      workspace = await discoverWorkspace(cwd);
      cwd = workspace.cwd;
      activeProjectRoot = workspace.guestRoot;
      next = await resolveForSession(setup, workspace);
    } catch (error) {
      failureState = { status: "unavailable", info: null, reason: redactedError(error, configRef.value).message };
      notifyState(failureState);
      return visibleState();
    }
    resolved = next;
    configReady = true;
    Object.assign(configRef.value, next.config, { network: { ...next.config.network }, docker: { ...next.config.docker }, secrets: [...next.config.secrets], mounts: [...next.config.mounts] });
    const state = setup.restored ?? persistenceState(options.entries?.() ?? [], sessionId);
    explicitOff = isDisabledByEnv(options.env ?? process.env);
    failureState = explicitOff ? { status: "off", info: null } : null;
    if (explicitOff || !configRef.value.autoStart) {
      if (!explicitOff) { await manager.setEnabled(false); failureState = { status: "off", info: null }; }
      return visibleState();
    }
    const result = await manager.boot({ sessionId, cwd, workspace, config: configSnapshot(), restored: state });
    if (result.status === "unavailable") failureState = result;
    notifyState(visibleState());
    return visibleState();
  };

  const control: MsbControl = {
    getState: visibleState,
    async setEnabled(enabled) {
      if (enabled && isDisabledByEnv(options.env ?? process.env)) {
        explicitOff = true;
        failureState = { status: "off", info: null };
        notifyState(failureState);
        return;
      }
      if (enabled && !configReady) {
        if (!manager.isActive()) {
          failureState = failureState ?? { status: "unavailable", info: null, reason: "no valid configuration is available; reload after fixing configuration" };
          notifyState(failureState);
        }
        return;
      }
      explicitOff = !enabled;
      failureState = null;
      if (!enabled) {
        await manager.setEnabled(false);
        failureState = { status: "off", info: null };
      } else {
        try {
          workspace = await discoverWorkspace(cwd);
          cwd = workspace.cwd;
          activeProjectRoot = workspace.guestRoot;
          const next = await resolveConfig({ cwd, repoRoot: workspace.guestRoot, projectTrusted, configDirName: options.configDirName, env: options.env, cliOverridesToml: overridesToToml(overrides) });
          resolved = next;
          configReady = true;
          Object.assign(configRef.value, next.config, { network: { ...next.config.network }, docker: { ...next.config.docker }, secrets: [...next.config.secrets], mounts: [...next.config.mounts] });
          const result = await manager.boot({ sessionId, cwd, workspace, config: configSnapshot(), restored: persistenceState(options.entries?.() ?? [], sessionId) });
          if (result.status === "unavailable") failureState = result;
        } catch (error) {
          failureState = { status: "unavailable", info: null, reason: redactedError(error, configRef.value).message };
        }
      }
      notifyState(visibleState());
    },
    async reload() {
      if (isDisabledByEnv(options.env ?? process.env)) {
        explicitOff = true;
        failureState = { status: "off", info: null };
        notifyState(failureState);
        return;
      }
      let next: ResolvedConfig;
      try {
        workspace = await discoverWorkspace(cwd);
        cwd = workspace.cwd;
        activeProjectRoot = workspace.guestRoot;
        next = await resolveConfig({ cwd, repoRoot: workspace.guestRoot, projectTrusted, configDirName: options.configDirName, env: options.env, cliOverridesToml: overridesToToml(overrides) });
      } catch (error) {
        configReady = false;
        if (!manager.isActive()) failureState = { status: "unavailable", info: null, reason: redactedError(error, configRef.value).message };
        notifyState(visibleState());
        throw error;
      }
      resolved = next;
      configReady = true;
      Object.assign(configRef.value, next.config, { network: { ...next.config.network }, docker: { ...next.config.docker }, secrets: [...next.config.secrets], mounts: [...next.config.mounts] });
      failureState = null;
      if (!explicitOff && configRef.value.autoStart && workspace) {
        const result = await manager.boot({ sessionId, cwd, workspace, config: configSnapshot(), restored: persistenceState(options.entries?.() ?? [], sessionId) });
        if (result.status === "unavailable") failureState = result;
      }
      notifyState(visibleState());
    },
    async pruneNow() {
      const report = await pruneStale({ port: prunePort, locks: lockPort(), currentSessionId: sessionId, stopTimeoutMs: configRef.value.stopTimeoutMs });
      notifyState(visibleState());
      return report;
    },
    async getLogs(tailLines) {
      const name = visibleState().info?.name;
      if (!name) return "";
      const msb = await sdk();
      const handle = await msb.Sandbox.get(name);
      const rows = await handle.logs(tailLines === undefined ? undefined : { tail: tailLines });
      return rows.map((row: AnyRecord) => typeof row.text === "function" ? row.text() : Buffer.from(row.data ?? []).toString("utf8")).join("");
    },
    getEffectiveConfig: effective,
    getEffectiveConfigToml: () => toEffectiveToml(effective()),
    async setOverride(key, value) {
      overrides = applyOverride(overrides, key, value);
      options.appendEntry?.(OVERRIDE_ENTRY, { key, value: sanitizeOverride(key, value) });
      await control.reload();
    },
    async unsetOverride(key) {
      overrides = removeOverride(overrides, key);
      options.appendEntry?.(OVERRIDE_ENTRY, { key, unset: true });
      await control.reload();
    },
    async resetOverrides() {
      overrides = {};
      options.appendEntry?.(OVERRIDE_ENTRY, { reset: true });
      await control.reload();
    },
  };

  return { control, manager, provider, configRef, configureSession };
}

export const createControl = createMsbIntegration;