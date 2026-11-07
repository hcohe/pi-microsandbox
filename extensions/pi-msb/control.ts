import { homedir } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  ensureDefaultHostConfig,
  isDisabledByEnv,
  resolveConfig,
  resolveSecretValue,
  toEffectiveToml,
} from "./config.ts";
import { boundDiagnosticsReport, type DiagnosticFailureCode } from "./diagnostics-tools.ts";
import { projectSettingsJson } from "./settings-json.ts";
import { createSettingsSanitizer, type SettingsSanitizer } from "./settings-redaction.ts";
import { classifySettingsEffect, LIVE_SETTINGS_KEYS } from "./settings-effect.ts";
import { SettingsEditor } from "./settings.ts";
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
  createSessionExecution,
  sandboxNameFor,
  type AgentRuntimePolicySnapshot,
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
  type RuntimePolicySnapshot,
  type SessionExecutionIdentity,
  type ToolOperations,
  type ToolOpsProvider,
  type Workspace,
} from "./types.ts";

const STATE_ENTRY = "pi-msb.state";
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
  agentDir?: string;
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
  /** Lifecycle owner must call this on shutdown; does not stop the manager. */
  endSession(): void;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function secretDescriptors(config: Config): string[] {
  return config.secrets.flatMap((secret) => [secret.textValue, secret.hostEnv, secret.hostCmd]).filter((value): value is string => typeof value === "string" && !!value);
}

function redactSecretText(text: string, values: Iterable<string>): string {
  const variants = new Set<string>();
  for (const value of values) if (value) {
    variants.add(value);
    variants.add(JSON.stringify(value).slice(1, -1));
  }
  // Longest first prevents overlapping credentials leaving a suffix visible.
  for (const value of [...variants].sort((a, b) => b.length - a.length)) text = text.split(value).join("[REDACTED]");
  return text;
}

function redactedError(error: unknown, config: Config, resolvedValues: Iterable<string> = []): Error {
  const message = redactSecretText(errorText(error), [...secretDescriptors(config), ...resolvedValues]);
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
          if (host.includes("/")) return destination.cidr(host);
          if (isIP(host)) return destination.ip(host);
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

export function createMsbIntegration(options: MsbControlOptions): MsbIntegration {
  const configRef = { value: { ...DEFAULT_CONFIG, network: { ...DEFAULT_CONFIG.network }, docker: { ...DEFAULT_CONFIG.docker } } as Config };
  let sessionId = options.sessionId;
  let cwd = options.cwd;
  let workspace: Workspace | null = null;
  let resolved: ResolvedConfig = { config: configRef.value, provenance: {}, warnings: [] };
  const resolutionSanitizers = new WeakMap<ResolvedConfig, SettingsSanitizer>();
  const requestSanitizers = new WeakMap<Config, SettingsSanitizer>();
  let projectTrusted = true;
  const settingsInput = () => ({ cwd, repoRoot: workspace?.guestRoot, projectTrusted, configDirName: options.configDirName, agentDir: options.agentDir, env: options.env });
  const settings = new SettingsEditor(settingsInput(), sessionId);
  // Diagnostics never resolve configuration or inspect settings. Only this small,
  // non-string projection is retained on the existing resolution paths. Raw
  // parser/SDK errors are deliberately withheld: even a known sanitizer cannot
  // prove coverage for rejected syntax or unobserved reconnect credentials.
  let diagnosticDesired: Record<string, unknown> | undefined;
  let diagnosticFailure: DiagnosticFailureCode = "unknown";
  let capturingBootFailure = false;
  const cacheDiagnosticConfig = (config: Config): void => {
    diagnosticDesired = {
      autoStart: config.autoStart, allowHostExecution: config.allowHostExecution,
      bootstrapTools: config.bootstrapTools, blockThirdParty: config.blockThirdParty,
      secretCount: config.secrets.length, mountCount: config.mounts.length,
      networkMode: config.network.mode, dockerMode: config.docker.mode,
      fallbackMode: config.fallbackMode,
    };
  };
  let configReady = false;
  let settingsReady = false;
  let pendingRestart = false;
  const logSecretRedactions = new Set<string>();
  let endingSession = false;
  const resolvedCommandSources = new Set<string>();
  let explicitOff = isDisabledByEnv(options.env ?? process.env);
  let failureState: RuntimeState | null = { status: "unavailable", info: null, reason: "session has not started" };
  let sdkPromise: Promise<MicrosandboxModule> | null = null;
  let activeProjectRoot = cwd;

  const redactDiagnostic = async (text: string): Promise<string> => {
    try {
      const sensitive = new Set(logSecretRedactions);
      for (const value of secretDescriptors(configRef.value)) sensitive.add(value);
      for (const secret of configRef.value.secrets) {
        // A fresh reconnect cannot recover the token used by an existing VM.
        // Never execute a command for diagnostics or expose potentially unmasked logs.
        if (secret.hostCmd !== undefined && !resolvedCommandSources.has(secret.hostCmd)) return "Diagnostic unavailable: startup secret tokens are unavailable for redaction.";
        if (secret.hostEnv !== undefined) sensitive.add(await resolveSecretValue(secret, options.env ?? process.env));
      }
      return redactSecretText(text, sensitive);
    } catch { return "Diagnostic unavailable: a secret source could not be read for redaction."; }
  };
  const loadSdk = async (): Promise<MicrosandboxModule> => {
    if (!sdkPromise) sdkPromise = (options.sdkLoader ?? (async () => await import("microsandbox")))();
    return sdkPromise;
  };
  const lockPort = () => options.locksPort ?? createLocksPort({ lockDir: expandHome(configRef.value.lockDir) });
  const sdk = async () => {
    try { return await loadSdk(); }
    catch (error) {
      if (capturingBootFailure && diagnosticFailure === "runtime_start_failed") diagnosticFailure = "native_sdk_unavailable";
      throw error;
    }
  };

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
    redactError: (message) => redactedError(message, configRef.value, logSecretRedactions).message,
    disposed: () => {
      if (endingSession) {
        logSecretRedactions.clear(); resolvedCommandSources.clear(); endingSession = false;
      }
    },
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
          let value: string;
          try { value = await resolveSecretValue(secret, options.env ?? process.env); }
          catch (error) {
            diagnosticFailure = secret.hostCmd !== undefined ? "host_secret_command_failed"
              : secret.hostEnv !== undefined ? "host_secret_environment_unavailable" : "unknown";
            throw error;
          }
          resolvedSecrets.push(value);
          if (value) logSecretRedactions.add(value);
          if (secret.hostCmd !== undefined) resolvedCommandSources.add(secret.hostCmd);
          builder.secret((entry: AnyRecord) => {
            entry.env(secret.env).value(value).requireTlsIdentity(true);
            for (const host of secret.allowHosts) {
              if (host.startsWith("*.")) entry.allowHostPattern(host);
              else entry.allowHost(host);
            }
            return entry;
          });
        }
        return await builder.create();
      } catch (error) {
        throw redactedError(error, request.config, resolvedSecrets);
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
      try {
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
      } catch (error) {
        diagnosticFailure = "runtime_preparation_failed";
        throw error;
      }
    },
    persist: (state) => options.appendEntry?.(STATE_ENTRY, encodeSessionState(state)),
  };

  const execution = createSessionExecution(options.sessionId, options.cwd);
  // Manager preflights reuse the boot request. Retain its originating lifecycle
  // identity so late boot/reconnect callbacks cannot publish obsolete metadata.
  const requestExecutions = new WeakMap<BootRequest, SessionExecutionIdentity>();
  let adopted: { identity: SessionExecutionIdentity; policy: RuntimePolicySnapshot; agentPolicy: AgentRuntimePolicySnapshot } | undefined;
  const currentAdoption = () => adopted?.identity === execution.context.current() ? adopted : undefined;
  deps.adopted = (request, verification) => {
    const identity = requestExecutions.get(request);
    if (!identity || identity !== execution.context.current()) return;
    diagnosticFailure = "unknown";
    const sameRuntime = adopted?.identity === identity;
    const knownFields = verification === "created" ? Object.keys(request.config) as Array<keyof Config>
      : verification === "live" && sameRuntime ? adopted!.policy.knownFields : [...LIVE_SETTINGS_KEYS];
    const safeConfig = Object.fromEntries(knownFields.map((key) => [key, key === "secrets"
      ? request.config.secrets.map((secret) => ({ env: secret.env, allowHosts: [...secret.allowHosts],
        ...Object.fromEntries(["textValue", "hostEnv", "hostCmd"].filter((source) => Object.hasOwn(secret, source)).map((source) => [source, "<redacted>"])),
      }))
      : request.config[key]])) as unknown as Config;
    const provenance: Record<string, string> = Object.fromEntries(Object.entries(resolved.provenance).filter(([key]) => knownFields.some((field) => key === field || key.startsWith(`${field}.`) || key.startsWith(`${field}[`))));
    const effectiveToml = toEffectiveToml({ ...resolved, config: safeConfig });
    if (verification === "reconnected" && sameRuntime && adopted!.policy.verification === "reconnected" && adopted!.policy.effectiveToml === effectiveToml) return;
    const policy: RuntimePolicySnapshot = {
      effectiveToml, provenance, automaticSandboxName: knownFields.includes("sandboxName") && request.config.sandboxName === null,
      knownFields: [...knownFields], verification: verification === "created" || verification === "live" && sameRuntime && adopted!.policy.verification === "created" ? "created" : "reconnected", adoptedAt: Date.now(),
    };
    const sanitize = requestSanitizers.get(request.config) ?? createSettingsSanitizer([request.config]);
    const agentPolicy = sanitize({
      // Human TOML stays source-masked, but agents can inspect known host source descriptors.
      settings: projectSettingsJson(Object.fromEntries(knownFields.map((key) => [key, request.config[key]]))), knownFields: policy.knownFields,
      provenance: policy.provenance, verification: policy.verification, adoptedAt: policy.adoptedAt,
    }, [request.config]);
    adopted = { identity, policy, agentPolicy };
  };
  const manager = createSandboxManager(deps);
  const boot = async (request: Parameters<typeof manager.boot>[0]) => {
    requestExecutions.set(request, execution.context.current());
    diagnosticFailure = "runtime_start_failed";
    capturingBootFailure = true;
    try {
      const result = await manager.boot(request);
      if (result.status !== "unavailable" && result.status !== "host-fallback") diagnosticFailure = "unknown";
      return result;
    } finally { capturingBootFailure = false; }
  };
  const notifyState = (state: RuntimeState) => options.onState?.(state);
  const visibleState = (): RuntimeState => {
    if (!execution.context.isReady()) return failureState?.status === "unavailable" ? failureState : { status: "booting", info: null };
    const state = failureState ?? manager.getState();
    if (explicitOff && (state.status === "disabled" || state.status === "off")) return { ...state, status: "off", info: null };
    return state;
  };
  const provider: ToolOpsProvider = {
    execution: execution.context,
    isActive: () => execution.context.isReady() && visibleState().status === "active" && manager.isActive(),
    getState: visibleState,
    withRuntime: async (callback) => {
      const identity = execution.context.current();
      execution.context.assertCurrent(identity);
      if (visibleState().status !== "active") throw new Error("Sandbox is not available; tool execution is blocked.");
      return manager.withRuntime((runtime) => {
        // Acquisitions can queue behind boot/preflight. Recheck at callback entry,
        // not exit: callbacks already using the old transport must drain normally.
        execution.context.assertCurrent(identity);
        return callback(runtime);
      });
    },
  };
  const effective = (): ResolvedConfig => resolved;
  const configSnapshot = (): Config => {
    const snapshot = structuredClone(configRef.value);
    requestSanitizers.set(snapshot, resolutionSanitizers.get(resolved) ?? createSettingsSanitizer([snapshot]));
    return snapshot;
  };
  const resolveForWorkspace = async (selected: Workspace, approvedSettingsReload = false): Promise<ResolvedConfig> => {
    configReady = false;
    const input = { ...settingsInput(), cwd: selected.cwd, repoRoot: selected.guestRoot };
    if (approvedSettingsReload) settings.assertSession(input, sessionId);
    else {
      settings.configureSession(input, sessionId);
      await ensureDefaultHostConfig(selected.guestRoot, options.agentDir);
    }
    let sanitize!: SettingsSanitizer;
    const next = await resolveConfig({ cwd: selected.cwd, repoRoot: selected.guestRoot, projectTrusted, configDirName: options.configDirName, agentDir: options.agentDir, env: options.env, temporaryOverrides: settings.temporary() }, (captured) => { sanitize = captured; });
    // Shared diagnostic state is committed by callers only after their lifecycle
    // identity checks, never by a resolution that may have become obsolete.
    resolutionSanitizers.set(next, sanitize);
    return next;
  };

  const configureSessionInternal = async (setup: SessionSetup, isCurrent: () => boolean): Promise<RuntimeState> => {
    sessionId = setup.sessionId;
    cwd = setup.cwd;
    configReady = false;
    settingsReady = false;
    workspace = null;
    diagnosticDesired = undefined;
    diagnosticFailure = "unknown";
    projectTrusted = setup.projectTrusted;
    settings.beginSession({ ...settingsInput(), cwd: setup.cwd, repoRoot: undefined }, setup.sessionId);
    explicitOff = isDisabledByEnv(options.env ?? process.env);
    if (explicitOff) {
      try {
        const selected = await discoverWorkspace(cwd);
        if (!isCurrent()) return visibleState();
        workspace = selected;
        cwd = workspace.cwd;
        activeProjectRoot = workspace.guestRoot;
        settings.configureSession(settingsInput(), sessionId);
        settingsReady = true;
        failureState = { status: "off", info: null, reason: "PI_MSB_DISABLE is set. Remove it and restart Pi to enable the sandbox." };
      } catch {
        if (!isCurrent()) return visibleState();
        failureState = { status: "unavailable", info: null, reason: "PI_MSB_DISABLE is set; workspace discovery failed. Settings editing is blocked. Fix the working directory/Git discovery and restart Pi." };
      }
      return visibleState();
    }
    let next: ResolvedConfig;
    try {
      const selected = await discoverWorkspace(cwd);
      if (!isCurrent()) return visibleState();
      workspace = selected;
      cwd = workspace.cwd;
      activeProjectRoot = workspace.guestRoot;
      settings.configureSession(settingsInput(), sessionId);
      settingsReady = true;
      next = setup.config ?? await resolveForWorkspace(workspace);
      if (!isCurrent()) return visibleState();
    } catch (error) {
      if (!isCurrent()) return visibleState();
      failureState = { status: "unavailable", info: null, reason: redactedError(error, configRef.value, logSecretRedactions).message };
      return visibleState();
    }
    resolved = next;
    cacheDiagnosticConfig(next.config);
    configReady = true;
    Object.assign(configRef.value, next.config, { network: { ...next.config.network }, docker: { ...next.config.docker }, secrets: [...next.config.secrets], mounts: [...next.config.mounts] });
    const state = setup.restored ?? persistenceState(options.entries?.() ?? [], sessionId);
    explicitOff = isDisabledByEnv(options.env ?? process.env);
    failureState = explicitOff ? { status: "off", info: null } : null;
    if (explicitOff || !configRef.value.autoStart) {
      if (!explicitOff) {
        await manager.setEnabled(false);
        if (!isCurrent()) return visibleState();
        failureState = { status: "off", info: null };
      }
      return visibleState();
    }
    const result = await boot({ sessionId, cwd, workspace, config: configSnapshot(), restored: state });
    if (!isCurrent()) return visibleState();
    if (result.status === "unavailable") failureState = result;
    return visibleState();
  };

  // Supersede synchronously, then serialize setup so an obsolete discovery or
  // boot cannot overwrite the replacement's shared config/settings/runtime.
  let sessionSetup: Promise<unknown> = Promise.resolve();
  const configureSession = (setup: SessionSetup): Promise<RuntimeState> => {
    const previous = execution.context.current();
    const identity = execution.begin(setup.sessionId, setup.cwd);
    failureState = { status: "booting", info: null };
    if (previous.sessionId !== setup.sessionId || previous.cwd !== setup.cwd) settings.endSession();
    settingsReady = false;
    configReady = false;
    const isCurrent = () => execution.context.current() === identity;
    const result = sessionSetup.then(async () => {
      if (!isCurrent()) return visibleState();
      try {
        await configureSessionInternal(setup, isCurrent);
      } catch (error) {
        if (isCurrent()) failureState = { status: "unavailable", info: null, reason: redactedError(error, configRef.value, logSecretRedactions).message };
      }
      if (isCurrent()) {
        execution.finish(identity);
        notifyState(visibleState());
      }
      return visibleState();
    });
    sessionSetup = result.catch(() => undefined);
    return result;
  };

  const control: MsbControl = {
    get settings() {
      if (!settingsReady) throw new Error("Settings unavailable until canonical workspace discovery succeeds. Fix the working directory and restart Pi.");
      return settings;
    },
    getState: visibleState,
    async getDiagnostics() {
      const state = visibleState();
      const statuses = ["active", "off", "disabled", "unavailable", "host-fallback", "booting", "stopping"];
      const status = statuses.includes(state.status) ? state.status : "unknown";
      const failed = status === "unavailable" || status === "host-fallback";
      const phase = !settingsReady ? "workspace_or_session_not_ready"
        : !configReady ? "configuration_not_ready"
        : failed ? "runtime_failure" : "none";
      const code: DiagnosticFailureCode = !failed ? "none" : !settingsReady ? "workspace_unavailable"
        : !configReady ? "invalid_configuration" : diagnosticFailure;
      return boundDiagnosticsReport({
        outcome: "diagnosed", readOnly: true, evidence: "cached; last-known, not live-probed",
        runtime: { status, execution: status === "active" ? "sandbox" : status === "off" ? "explicit-host" : status === "host-fallback" ? "fallback-host" : "blocked" },
        readiness: { workspaceReady: workspace !== null && settingsReady, settingsReady, configReady },
        host: { platform: process.platform, arch: process.arch, node: process.version },
        failure: { phase, code },
        desired: { evidence: "last-known resolution; not live", validForSession: configReady,
          ...(configReady && diagnosticDesired ? { settings: { ...diagnosticDesired } } : {}) },
        adoption: { evidence: "last-known; not live", known: currentAdoption() !== undefined,
          verification: currentAdoption()?.policy.verification ?? "unknown" },
        recovery: !settingsReady
          ? "Fix working-directory/Git identity on the host and restart Pi; settings editing is blocked until canonical workspace discovery succeeds."
          : "Use msb_config_get to inspect recovery constraints, then msb_config_set to propose a supported repair. Diagnostics cannot repair anything; msb_config_set requires explicit approval. Invalid syntax may require manual host repair. Never disable protection or use host fallback as an automatic repair.",
        notPerformed: ["commands", "source reads", "environment reads", "credential resolution", "SDK loading", "logs/stdout", "health", "installation", "network", "virtualization", "credential validity", "writes", "repairs"],
      });
    },
    getAgentRuntimePolicy: () => {
      const current = currentAdoption();
      return current ? structuredClone(current.agentPolicy) : undefined;
    },
    getRuntimePolicy: () => {
      const current = currentAdoption();
      return current ? structuredClone(current.policy) : undefined;
    },
    async setEnabled(enabled) {
      const identity = execution.context.current();
      const assertCurrent = () => execution.context.assertCurrent(identity);
      assertCurrent();
      if (enabled && isDisabledByEnv(options.env ?? process.env)) {
        explicitOff = true;
        failureState = { status: "off", info: null, reason: "PI_MSB_DISABLE is set. Remove it and restart Pi to enable the sandbox." };
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
        assertCurrent();
        failureState = { status: "off", info: null };
      } else {
        try {
          workspace = null;
          settingsReady = false;
          const selected = await discoverWorkspace(cwd);
          assertCurrent();
          workspace = selected;
          settingsReady = true;
          cwd = workspace.cwd;
          activeProjectRoot = workspace.guestRoot;
          const next = await resolveForWorkspace(workspace);
          assertCurrent();
          resolved = next;
          cacheDiagnosticConfig(next.config);
          configReady = true;
          Object.assign(configRef.value, next.config, { network: { ...next.config.network }, docker: { ...next.config.docker }, secrets: [...next.config.secrets], mounts: [...next.config.mounts] });
          const result = await boot({ sessionId, cwd, workspace, config: configSnapshot(), forceRecreate: pendingRestart, restored: persistenceState(options.entries?.() ?? [], sessionId) });
          assertCurrent();
          if (result.status === "active") pendingRestart = false;
          if (result.status === "unavailable") failureState = result;
        } catch (error) {
          assertCurrent();
          configReady = false;
          failureState = { status: "unavailable", info: null, reason: redactedError(error, configRef.value, logSecretRedactions).message };
        }
      }
      notifyState(visibleState());
    },
    previewSettings: (draft) => draft.preview(configSnapshot()),
    async reload(reloadOptions) {
      const identity = execution.context.current();
      const assertCurrent = () => execution.context.assertCurrent(identity);
      assertCurrent();
      await reloadOptions?.guard?.();
      assertCurrent();
      if (isDisabledByEnv(options.env ?? process.env)) {
        explicitOff = true;
        failureState = { status: "off", info: null, reason: "PI_MSB_DISABLE is set. Remove it and restart Pi to enable the sandbox." };
        notifyState(failureState);
        if (reloadOptions?.guard) throw new Error("Runtime reload disabled by environment");
        return;
      }
      let next: ResolvedConfig;
      try {
        workspace = null;
        settingsReady = false;
        const selected = await discoverWorkspace(cwd);
        assertCurrent();
        workspace = selected;
        settingsReady = true;
        cwd = workspace.cwd;
        activeProjectRoot = workspace.guestRoot;
        next = await resolveForWorkspace(workspace, !!reloadOptions?.guard);
        assertCurrent();
      } catch (error) {
        assertCurrent();
        configReady = false;
        if (!manager.isActive()) failureState = { status: "unavailable", info: null, reason: redactedError(error, configRef.value, logSecretRedactions).message };
        notifyState(visibleState());
        throw error;
      }
      await reloadOptions?.guard?.();
      assertCurrent();
      pendingRestart ||= classifySettingsEffect(configRef.value, next.config) === "restart";
      if (pendingRestart && reloadOptions?.allowRestart === false && !explicitOff && (manager.isActive() || next.config.autoStart)) {
        throw new Error("Settings saved, but newly changed runtime settings need restart confirmation. Open Actions and choose Reload settings.");
      }
      const forceRecreate = pendingRestart;
      resolved = next;
      cacheDiagnosticConfig(next.config);
      configReady = true;
      Object.assign(configRef.value, next.config, { network: { ...next.config.network }, docker: { ...next.config.docker }, secrets: [...next.config.secrets], mounts: [...next.config.mounts] });
      failureState = null;
      if (!explicitOff && workspace && (next.config.autoStart || manager.isActive())) {
        const result = await boot({ sessionId, cwd, workspace, config: configSnapshot(), forceRecreate, restored: persistenceState(options.entries?.() ?? [], sessionId) });
        assertCurrent();
        if (result.status === "unavailable" || result.status === "host-fallback") failureState = result;
        else if (result.status === "active") pendingRestart = false;
      }
      notifyState(visibleState());
      if (["unavailable", "host-fallback"].includes(visibleState().status)) throw new Error("Settings saved, but sandbox activation failed. Inspect Overview; routed tools remain subject to configured safety policy.");
    },
    async pruneNow() {
      const report = await pruneStale({ port: prunePort, locks: lockPort(), currentSessionId: sessionId, stopTimeoutMs: configRef.value.stopTimeoutMs });
      for (const key of ["errors", "removed", "kept"] as const) report[key] = await Promise.all(report[key].map(redactDiagnostic));
      notifyState(visibleState());
      return report;
    },
    async getLogs(tailLines) {
      const name = visibleState().info?.name;
      if (!name) return "";
      try {
        const msb = await sdk();
        const handle = await msb.Sandbox.get(name);
        const rows = await handle.logs(tailLines === undefined ? undefined : { tail: tailLines });
        const text = rows.map((row: AnyRecord) => typeof row.text === "function" ? row.text() : Buffer.from(row.data ?? []).toString("utf8")).join("");
        return await redactDiagnostic(text);
      } catch (error) {
        throw new Error(await redactDiagnostic(errorText(error)));
      }
    },
    getEffectiveConfig: effective,
    getEffectiveConfigToml: () => toEffectiveToml(effective()),
    async setOverride(key, value) {
      const draft = await settings.open("temporary");
      draft.set(key, value);
      await draft.apply();
      await control.reload();
    },
    async unsetOverride(key) {
      const draft = await settings.open("temporary");
      draft.inherit(key);
      await draft.apply();
      await control.reload();
    },
    async resetOverrides() {
      settings.endSession();
      await control.reload();
    },
  };

  return {
    control, manager, provider, configRef, configureSession,
    endSession: () => {
      const identity = execution.context.current();
      execution.begin(identity.sessionId, identity.cwd);
      failureState = { status: "unavailable", info: null, reason: "session has ended" };
      settings.endSession();
      settingsReady = false;
      configReady = false;
      workspace = null;
      diagnosticDesired = undefined;
      diagnosticFailure = "unknown";
      adopted = undefined;
      endingSession = true;
    },
  };
}

export const createControl = createMsbIntegration;
