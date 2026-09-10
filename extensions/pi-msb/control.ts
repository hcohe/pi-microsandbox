import { promises as fs } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, basename, relative as relativePath } from "node:path";

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
import { createSeedBundle, detectGitRepo } from "./git.ts";
import { buildSandboxLabels, buildVolumeLabels, decodeSessionState, normalizeSandboxRecord, normalizeVolumeRecord, encodeSessionState } from "./labels.ts";
import { acquireOwnerLock, createLocksPort } from "./locks.ts";
import { createBashOps, createFindOps, createGrepOps } from "./operations-exec.ts";
import { createEditOps, createLsOps, createReadOps, createWriteOps } from "./operations.ts";
import { pruneStale, type PrunePort } from "./prune.ts";
import { buildStoragePlan, seedGitVolume, validateReusableVolume } from "./storage.ts";
import { createSdkTransport } from "./transport.ts";
import { createSandboxManager, type InspectedSandbox, type SandboxManagerDeps } from "./sandbox-manager.ts";
import {
  LABEL_KEYS,
  sandboxNameFor,
  volumeNameFor,
  type BootRequest,
  type Config,
  type GitRepoInfo,
  type LockInfo,
  type LocksPort,
  type MsbControl,
  type PersistedSandboxState,
  type ResolvedConfig,
  type RuntimeExecution,
  type RuntimeState,
  type StoragePlan,
  type ToolOperations,
  type ToolOpsProvider,
  type VolumeRecord,
  type DeepPartial,
} from "./types.ts";

const execFile = promisify(execFileCallback);
const STATE_ENTRY = "pi-msb.state";
const OVERRIDE_ENTRY = "pi-msb.override";
const REQUIRED_GUEST_COMMANDS = ["bash", "git", "rg", "file", "cat", "mkdir", "rm"] as const;

type AnyRecord = Record<string, any>;

/** The deliberately small SDK surface used by the adapter. Tests can inject this. */
export interface MicrosandboxModule {
  Sandbox: AnyRecord;
  Volume: AnyRecord;
  NetworkPolicy?: AnyRecord;
  Rule?: AnyRecord;
}

export interface SessionSetup {
  sessionId: string;
  cwd: string;
  repoRoot?: string | null;
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
  return name.includes("NotFound") || ["NOT_FOUND", "ENOENT", "volumeNotFound", "sandboxNotFound"].includes(value?.code);
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

function volumeHostPath(value: AnyRecord): string | undefined {
  // VolumeHandle has no path getter. Only use a path
  // when the SDK object explicitly exposes one (the Volume returned by create)
  // or a future metadata object documents one; never manufacture a host path.
  const direct = typeof value.path === "string" ? value.path : typeof value.hostPath === "string" ? value.hostPath : undefined;
  if (direct && isAbsolute(direct)) return direct;
  const metadata = objectConfig(value.metadata ?? value.info);
  const documented = typeof metadata.hostPath === "string" ? metadata.hostPath : typeof metadata.path === "string" ? metadata.path : undefined;
  return documented && isAbsolute(documented) ? documented : undefined;
}

function volumeIdentityFromHandle(handle: AnyRecord): { name: string; labels: Record<string, string> } | null {
  const name = typeof handle.name === "string" ? handle.name : undefined;
  const labels = sdkLabels(handle);
  return name && Object.keys(labels).length ? { name, labels } : null;
}

function volumeFromHandle(handle: AnyRecord): VolumeRecord | null {
  const identity = volumeIdentityFromHandle(handle);
  const hostPath = volumeHostPath(handle);
  if (!identity || !hostPath) return null;
  return normalizeVolumeRecord({
    name: identity.name,
    hostPath,
    labels: identity.labels,
    kind: handle.kind,
    usedBytes: handle.usedBytes,
    createdAt: handle.createdAt instanceof Date ? handle.createdAt.getTime() : handle.createdAt,
  });
}

function reusableVolumeIdentity(plan: Extract<StoragePlan, { kind: "git-volume" }>, identity: { name: string; labels: Record<string, string> }): boolean {
  const labels = identity.labels;
  return identity.name === plan.volumeName &&
    labels[LABEL_KEYS.managed] === "true" &&
    labels[LABEL_KEYS.schema] === "1" &&
    labels[LABEL_KEYS.session] === plan.sessionId &&
    labels[LABEL_KEYS.cwd] === plan.workdir &&
    labels[LABEL_KEYS.mode] === "git" &&
    labels[LABEL_KEYS.keep] === "true";
}

function labelsForVolume(input: { sessionId: string; cwd: string }): Record<string, string> {
  return { ...buildVolumeLabels(input), [LABEL_KEYS.mode]: "git" };
}

interface ManagedVolumeTarget {
  sessionId: string;
  cwd: string;
  name: string;
}

function managedVolumeTarget(requestedName: string, identity: { name: string; labels: Record<string, string> }): ManagedVolumeTarget | null {
  const labels = identity.labels;
  const sessionId = labels[LABEL_KEYS.session];
  const cwd = labels[LABEL_KEYS.cwd];
  if (!sessionId || !cwd || !isAbsolute(cwd)) return null;
  const expectedLabels = labelsForVolume({ sessionId, cwd });
  if (identity.name !== requestedName || requestedName !== volumeNameFor(sessionId)) return null;
  if (Object.entries(expectedLabels).some(([key, value]) => labels[key] !== value)) return null;
  return { sessionId, cwd, name: requestedName };
}

function namedMountVolume(mount: unknown): string | undefined {
  const value = objectConfig(mount);
  const kind = value.kind ?? value.type;
  if (typeof kind === "string" && kind.toLowerCase() === "named" && typeof value.name === "string") return value.name;
  const nested = objectConfig(value.named ?? value.Named);
  return typeof nested.name === "string" ? nested.name : undefined;
}

async function volumeIsMounted(msb: MicrosandboxModule, name: string): Promise<boolean> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  while (true) {
    const page = await msb.Sandbox.listWith((list: AnyRecord) => {
      if (cursor) list.cursor(cursor);
      return list;
    });
    if (!page || !Array.isArray(page.sandboxes)) throw new Error("unable to verify volume mount state: malformed sandbox list");
    for (const listed of page.sandboxes) {
      if (typeof listed?.name !== "string" || !listed.name) throw new Error("unable to verify volume mount state: malformed sandbox handle");
      let handle: AnyRecord;
      try {
        handle = await msb.Sandbox.get(listed.name);
      } catch (error) {
        if (sdkNotFound(error)) continue;
        throw error;
      }
      const status = sdkStatus(handle)?.trim().toLowerCase();
      if (status === "stopped" || status === "crashed") continue;
      const config = await handleConfig(handle);
      if (!Array.isArray(config.mounts)) throw new Error(`unable to verify volume mount state for sandbox ${listed.name}`);
      if (config.mounts.some((mount: unknown) => namedMountVolume(mount) === name)) return true;
    }
    if (page.nextCursor === undefined) return false;
    if (typeof page.nextCursor !== "string" || !page.nextCursor || seenCursors.has(page.nextCursor)) {
      throw new Error("unable to verify volume mount state: invalid sandbox page cursor");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

function parsePort(value: string): { bind: string; host: number; guest: number } {
  const parts = value.split(":");
  const numbers = parts.slice(-2).map((item) => Number(item));
  if (parts.length === 1) return { bind: "127.0.0.1", host: numbers[0], guest: numbers[0] };
  if (parts.length === 2) return { bind: "127.0.0.1", host: numbers[0], guest: numbers[1] };
  return { bind: parts[0], host: numbers[1], guest: numbers[2] };
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
      if (network.allowDns) policy.egress((rule: AnyRecord) => rule.allowDns());
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
  const mode = request.config.mode === "direct" || request.config.mode === "none" ? request.config.mode : "git";
  return {
    version: 1,
    sessionId: request.sessionId,
    sandboxName: request.config.sandboxName ?? sandboxNameFor(request.sessionId),
    volumeName: mode === "git" ? volumeNameFor(request.sessionId) : undefined,
    mode,
    cwd: request.cwd,
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
  const configRef = { value: { ...DEFAULT_CONFIG, network: { ...DEFAULT_CONFIG.network } } as Config };
  let sessionId = options.sessionId;
  let cwd = options.cwd;
  let repoRoot: string | null = null;
  let currentGit: GitRepoInfo = { isGitRepo: false, repoRoot: null, branch: null, headSha: null, unborn: false, isLinkedWorktree: false };
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
    detectGit: async (path) => {
      currentGit = await detectGitRepo(path);
      currentGit = currentGit;
      return currentGit;
    },
    buildStoragePlan: (input) => {
      const plan = buildStoragePlan(input);
      activeProjectRoot = plan.kind === "git-volume" ? plan.mountGuestPath : input.cwd;
      return plan;
    },
    prepareStorage: async (plan, restored) => {
      if (plan.kind !== "git-volume") return { plan, createdVolume: false };
      const msb = await sdk();
      let volume: VolumeRecord | undefined;
      let createdVolume = false;
      try {
        const handle = await msb.Volume.get(plan.volumeName);
        const identity = volumeIdentityFromHandle(handle);
        if (!identity || !reusableVolumeIdentity(plan, identity)) throw new Error(`managed volume identity mismatch: ${plan.volumeName}`);
        const record = volumeFromHandle(handle);
        if (record && !validateReusableVolume(plan, record)) throw new Error(`managed volume identity mismatch: ${plan.volumeName}`);
        // VolumeHandle has no supported host path. Reuse is safe
        // because mounting uses the name; status/export report no fabricated path.
        volume = record ?? undefined;
      } catch (error) {
        if (!sdkNotFound(error)) throw error;
        const labels = labelsForVolume({ sessionId: plan.sessionId, cwd: plan.workdir });
        let builder = msb.Volume.builder(plan.volumeName).directory().quota(plan.volumeQuotaMiB);
        for (const [key, value] of Object.entries(labels)) builder = builder.label(key, value);
        const created = await builder.create();
        const createdVolumeRecord = volumeFromHandle({
          name: created.name,
          path: volumeHostPath(created),
          labels,
          kind: created.kind,
          usedBytes: created.usedBytes,
          createdAt: created.createdAt,
        });
        if (!createdVolumeRecord) throw new Error("microsandbox returned invalid volume metadata");
        volume = createdVolumeRecord;
        createdVolume = true;
      }
      let bundle = null;
      if (createdVolume && plan.seedRequired && !plan.unborn) {
        bundle = await createSeedBundle(currentGit, { branch: configRef.value.cloneBranch, depth: configRef.value.cloneDepth });
      }
      // The manager owns cleanup after seed/boot failure; storage owns only the bundle creation.
      return { plan, volume, bundle, createdVolume };
    },
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
    createSandbox: async (request, prepared) => {
      const msb = await sdk();
      const name = request.config.sandboxName ?? sandboxNameFor(request.sessionId);
      const plan = prepared.plan;
      const mode = plan.kind === "git-volume" ? "git" : plan.kind === "direct-mount" ? "direct" : "none";
      const labels = buildSandboxLabels({ sessionId: request.sessionId, mode, cwd: request.cwd, pid: process.pid, image: request.config.image, volumeName: plan.kind === "git-volume" ? plan.volumeName : undefined, seedBranch: plan.kind === "git-volume" ? plan.branch : null, seedSha: plan.kind === "git-volume" ? plan.headSha : null });
      let builder = msb.Sandbox.builder(name).image(request.config.image).pullPolicy(request.config.pullPolicy).cpus(request.config.cpus).memory(request.config.memoryMiB).idleTimeout(request.config.idleTimeoutSec).detached(request.config.detached).workdir(plan.kind === "git-volume" ? plan.workdir : request.cwd).labels(labels);
      if (plan.kind === "git-volume") builder.volume(plan.mountGuestPath, (m: AnyRecord) => m.named(plan.volumeName));
      else if (plan.kind === "direct-mount") builder.volume(plan.guestPath, (m: AnyRecord) => m.bind(plan.hostPath));
      else builder.volume(plan.guestPath, (m: AnyRecord) => m.tmpfs());
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
    probeAndBootstrap: async (runtime, config) => {
      const missing = async () => {
        const result = await Promise.all(REQUIRED_GUEST_COMMANDS.map(async (command) => ({ command, result: await runtime.transport.exec("sh", ["-lc", `command -v ${command}`]) })));
        return result.filter((item) => item.result.exitCode !== 0).map((item) => item.command);
      };
      let commands = await missing();
      if (commands.length && config.bootstrapTools !== false) {
        const apt = await runtime.transport.exec("sh", ["-lc", "command -v apt-get"]);
        if (apt.exitCode === 0) {
          await runtime.transport.exec("apt-get", ["update", "-y"]);
          await runtime.transport.exec("apt-get", ["install", "-y", "--no-install-recommends", "bash", "git", "ripgrep", "file", "coreutils", "ca-certificates"]);
          commands = await missing();
        }
      }
      if (commands.length) throw new Error(`sandbox is missing required commands: ${commands.join(", ")}; install them or use bootstrapTools=true`);
    },
    seed: async (runtime, prepared) => seedGitVolume(runtime.transport, prepared.plan as any, prepared.bundle ?? null),
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
  const resolveForSession = async (setup: SessionSetup): Promise<ResolvedConfig> => {
    if (setup.config) return setup.config;
    return resolveConfig({ cwd: setup.cwd, repoRoot: setup.repoRoot, projectTrusted: setup.projectTrusted, configDirName: options.configDirName, env: options.env, cliOverridesToml: overridesToToml(overrides) });
  };

  const configureSession = async (setup: SessionSetup): Promise<RuntimeState> => {
    sessionId = setup.sessionId;
    cwd = setup.cwd;
    configReady = false;
    repoRoot = setup.repoRoot ?? null;
    projectTrusted = setup.projectTrusted;
    explicitOff = isDisabledByEnv(options.env ?? process.env);
    if (explicitOff) {
      failureState = { status: "off", info: null };
      notifyState(failureState);
      return visibleState();
    }
    currentGit = await detectGitRepo(cwd);
    repoRoot = currentGit.guestRepoRoot === null
      ? cwd
      : currentGit.guestRepoRoot ?? currentGit.repoRoot;
    overrides = overrideEntries(options.entries?.() ?? []);
    let next: ResolvedConfig;
    try {
      next = await resolveForSession({ ...setup, repoRoot });
    } catch (error) {
      failureState = { status: "unavailable", info: null, reason: redactedError(error, configRef.value).message };
      notifyState(failureState);
      return visibleState();
    }
    resolved = next;
    configReady = true;
    Object.assign(configRef.value, next.config, { network: { ...next.config.network }, secrets: [...next.config.secrets], mounts: [...next.config.mounts] });
    const state = setup.restored ?? persistenceState(options.entries?.() ?? [], sessionId);
    explicitOff = isDisabledByEnv(options.env ?? process.env);
    failureState = explicitOff ? { status: "off", info: null } : null;
    if (explicitOff || !configRef.value.autoStart) {
      if (!explicitOff) { await manager.setEnabled(false); failureState = { status: "off", info: null }; }
      return visibleState();
    }
    const result = await manager.boot({ sessionId, cwd, config: configRef.value, restored: state });
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
        const result = await manager.boot({ sessionId, cwd, config: configRef.value, restored: persistenceState(options.entries?.() ?? [], sessionId) });
        if (result.status === "unavailable") failureState = result;
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
        next = await resolveConfig({ cwd, repoRoot, projectTrusted, configDirName: options.configDirName, env: options.env, cliOverridesToml: overridesToToml(overrides) });
      } catch (error) {
        configReady = false;
        if (!manager.isActive()) failureState = { status: "unavailable", info: null, reason: redactedError(error, configRef.value).message };
        notifyState(visibleState());
        throw error;
      }
      resolved = next;
      configReady = true;
      Object.assign(configRef.value, next.config, { network: { ...next.config.network }, secrets: [...next.config.secrets], mounts: [...next.config.mounts] });
      failureState = null;
      if (!explicitOff && configRef.value.autoStart) {
        const result = await manager.boot({ sessionId, cwd, config: configRef.value, restored: persistenceState(options.entries?.() ?? [], sessionId) });
        if (result.status === "unavailable") failureState = result;
      }
      notifyState(visibleState());
    },
    async pruneNow() {
      const report = await pruneStale({ port: prunePort, locks: lockPort(), currentSessionId: sessionId, stopTimeoutMs: configRef.value.stopTimeoutMs });
      notifyState(visibleState());
      return report;
    },
    async listVolumes() {
      const msb = await sdk();
      const handles = await msb.Volume.list();
      const volumes: VolumeRecord[] = [];
      for (const handle of handles) {
        const identity = volumeIdentityFromHandle(handle);
        if (!identity || identity.labels[LABEL_KEYS.managed] !== "true") continue;
        const record = volumeFromHandle(handle);
        if (!record) throw new Error(`host path metadata is unavailable for managed volume ${identity.name}; refusing to fabricate a path`);
        volumes.push(record);
      }
      return volumes;
    },
    async describeVolume(name) {
      const msb = await sdk();
      const handle = await msb.Volume.get(name);
      const volume = volumeFromHandle(handle);
      if (!volume) throw new Error("microsandbox returned invalid volume metadata");
      if (volume.labels[LABEL_KEYS.managed] !== "true") throw new Error("refusing to inspect an unmanaged volume");
      let branch: string | undefined;
      let lastCommit: string | undefined;
      let dirtyCount: number | undefined;
      try {
        const head = await execFile("git", ["-C", volume.hostPath, "symbolic-ref", "--quiet", "--short", "HEAD"]);
        branch = head.stdout.trim() || undefined;
      } catch { /* detached/uninitialized volumes are valid */ }
      try {
        const head = await execFile("git", ["-C", volume.hostPath, "rev-parse", "HEAD"]);
        lastCommit = head.stdout.trim() || undefined;
      } catch { /* no commit */ }
      try {
        const status = await execFile("git", ["-C", volume.hostPath, "status", "--porcelain"]);
        dirtyCount = status.stdout.trim() ? status.stdout.trim().split("\n").length : 0;
      } catch { /* non-git volume */ }
      return { volume, branch, lastCommit, dirtyCount, mounted: visibleState().info?.volumeName === name };
    },
    async removeVolume(name) {
      const msb = await sdk();
      const initialIdentity = volumeIdentityFromHandle(await msb.Volume.get(name));
      const target = initialIdentity ? managedVolumeTarget(name, initialIdentity) : null;
      if (!target) throw new Error(`managed volume identity mismatch: ${name}`);
      const targetRequest: BootRequest = {
        sessionId: target.sessionId,
        cwd: target.cwd,
        config: { ...configRef.value, mode: "git", sandboxName: sandboxNameFor(target.sessionId) },
        restored: null,
      };
      const owner = options.acquireOwnerLock
        ? await options.acquireOwnerLock(targetRequest)
        : await acquireOwnerLock({ lockDir: expandHome(configRef.value.lockDir) }, lockInfoFor(targetRequest));
      if (!owner) throw new Error("another process owns the target session; volume removal is blocked");
      try {
        const lockedIdentity = volumeIdentityFromHandle(await msb.Volume.get(name));
        const lockedTarget = lockedIdentity ? managedVolumeTarget(name, lockedIdentity) : null;
        if (!lockedTarget || lockedTarget.sessionId !== target.sessionId || lockedTarget.cwd !== target.cwd || lockedTarget.name !== target.name) {
          throw new Error(`managed volume identity mismatch: ${name}`);
        }
        if (visibleState().info?.volumeName === name || await volumeIsMounted(msb, name)) {
          throw new Error("refusing to remove a mounted volume");
        }
        // Volume.remove is the final atomic mount check: microsandbox rejects
        // deletion if a sandbox mounts the volume after the list recheck.
        await msb.Volume.remove(name);
      } finally {
        await owner.release();
      }
    },
    async exportPaths(paths, destination) {
      if (!manager.isActive()) throw new Error("sandbox is not active");
      const target = destination ? resolve(destination) : await fs.mkdtemp(join((process.env.TMPDIR ?? "/tmp"), "pi-msb-export-"));
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      const results: Array<{ source: string; destination: string }> = [];
      await manager.withRuntime(async (runtime) => {
        for (const requested of paths) {
          const source = requested.startsWith("/") ? resolve(requested) : resolve(cwd, requested);
          const sourceRoot = resolve(activeProjectRoot);
          const sourceRelative = relativePath(sourceRoot, source);
          if (sourceRelative === ".." || sourceRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(sourceRelative)) {
            throw new Error(`refusing to export a path outside the sandbox project: ${requested}`);
          }
          const output = join(target, basename(source));
          if (resolve(output) !== output || await fs.lstat(output).then(() => true, () => false)) throw new Error(`export destination exists: ${output}`);
          await runtime.transport.copyToHost(source, output);
          results.push({ source, destination: output });
        }
      });
      return results;
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

  // Keep the returned config facade useful to callers without exposing mutable internals.
  void repoRoot;
  return { control, manager, provider, configRef, configureSession };
}

export const createControl = createMsbIntegration;