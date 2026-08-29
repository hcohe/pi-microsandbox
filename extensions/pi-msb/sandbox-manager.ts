import {
  displayId,
  sandboxNameFor,
  STATE_SCHEMA_VERSION,
  type BootRequest,
  type Config,
  type GitRepoInfo,
  type LockHandle,
  type PersistedSandboxState,
  type PreparedStorage,
  type PruneReport,
  type RuntimeExecution,
  type RuntimeState,
  type SandboxManager,
  type SandboxTransport,
  type SeedResult,
  type StorageMode,
  type StoragePlan,
  type ToolOperations,
} from "./types.ts";

/**
 * Inputs to the storage planner. Kept local because the shared contract only
 * describes the values crossing the manager boundary.
 */
export interface StoragePlanInput {
  cwd: string;
  sessionId: string;
  config: Config;
  git: GitRepoInfo;
  restored?: PersistedSandboxState | null;
}

/** The SDK adapter deliberately owns the concrete shape of an inspected handle. */
export interface InspectedSandbox {
  name: string;
  status?: string;
  labels: Record<string, string>;
  [key: string]: unknown;
}

export interface SandboxManagerDeps {
  acquireOwnerLock(request: BootRequest): Promise<LockHandle | null>;
  pruneOthers(currentSessionId: string): Promise<PruneReport>;
  detectGit(cwd: string): Promise<GitRepoInfo>;
  buildStoragePlan(input: StoragePlanInput): StoragePlan;
  prepareStorage(
    plan: StoragePlan,
    restored: PersistedSandboxState | null,
  ): Promise<PreparedStorage>;
  inspectSandbox(name: string): Promise<InspectedSandbox | null>;
  connectSandbox(value: InspectedSandbox): Promise<unknown>;
  startSandbox(value: InspectedSandbox): Promise<unknown>;
  createSandbox(request: BootRequest, prepared: PreparedStorage): Promise<unknown>;
  stopAndRemove(name: string, timeoutMs: number): Promise<void>;
  createTransport(raw: unknown): SandboxTransport;
  createOperations(transport: SandboxTransport): ToolOperations;
  probeAndBootstrap(runtime: RuntimeExecution, config: Config): Promise<void>;
  seed(runtime: RuntimeExecution, prepared: PreparedStorage): Promise<SeedResult>;
  persist(state: PersistedSandboxState): void;
  now?: () => number;
}

const RUNNING_STATUSES = new Set(["running", "started", "active", "up"]);
const STOPPED_STATUSES = new Set([
  "stopped",
  "exited",
  "idle",
  "paused",
  "dead",
  "created",
]);

function modeForPlan(plan: StoragePlan): StorageMode {
  return plan.kind === "git-volume"
    ? "git"
    : plan.kind === "direct-mount"
      ? "direct"
      : "none";
}

function volumeNameForPlan(plan: StoragePlan): string | undefined {
  return plan.kind === "git-volume" ? plan.volumeName : undefined;
}

function statusOf(value: InspectedSandbox): string | undefined {
  if (typeof value.status === "string") return value.status.toLowerCase();
  if (value.running === true) return "running";
  if (value.running === false) return "stopped";
  return undefined;
}

function isRunning(value: InspectedSandbox): boolean {
  return RUNNING_STATUSES.has(statusOf(value) ?? "");
}

function isStopped(value: InspectedSandbox): boolean {
  return STOPPED_STATUSES.has(statusOf(value) ?? "");
}

function labelsOf(value: InspectedSandbox): Record<string, string> {
  return value.labels && typeof value.labels === "object" ? value.labels : {};
}

function isManagedOwner(value: InspectedSandbox, request: BootRequest): boolean {
  const labels = labelsOf(value);
  return (
    labels["pi-msb.managed"] === "true" &&
    labels["pi-msb.schema"] === String(STATE_SCHEMA_VERSION) &&
    labels["pi-msb.session"] === request.sessionId
  );
}

function matchesPlan(value: InspectedSandbox, request: BootRequest, plan: StoragePlan): boolean {
  const labels = labelsOf(value);
  const expectedMode = modeForPlan(plan);
  const expectedVolume = volumeNameForPlan(plan);

  if (request.config.mode !== "auto" && request.config.mode !== expectedMode) return false;
  if (!isManagedOwner(value, request)) return false;
  if (labels["pi-msb.mode"] !== expectedMode) return false;
  if (labels["pi-msb.cwd"] !== request.cwd) return false;
  if (labels["pi-msb.image"] !== request.config.image) return false;

  const actualVolume = labels["pi-msb.volume"];
  return expectedVolume === undefined
    ? actualVolume === undefined
    : actualVolume === expectedVolume;
}

function infoFor(
  request: BootRequest,
  plan: StoragePlan,
  prepared: PreparedStorage,
  seedBranch: string | null | undefined,
  seedSha: string | null | undefined,
  createdAt: number,
  name: string,
): NonNullable<RuntimeState["info"]> {
  return {
    name,
    displayId: displayId(request.sessionId),
    mode: modeForPlan(plan),
    image: request.config.image,
    pid: process.pid,
    cwd: request.cwd,
    volumeName: volumeNameForPlan(plan),
    volumeHostPath: plan.kind === "git-volume" ? prepared.volume?.hostPath : undefined,
    seedBranch: seedBranch ?? null,
    seedSha: seedSha ?? null,
    createdAt,
  };
}

function redactMessage(error: unknown, config?: Config): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of config?.secrets ?? []) {
    if (secret.value) message = message.split(secret.value).join("[REDACTED]");
  }
  return message || "unknown error";
}

function unavailableError(state: RuntimeState): Error {
  const reason = state.reason ? `: ${state.reason}` : "";
  return new Error(`sandbox is not available${reason}`);
}

function sameBootRequest(a: BootRequest, b: BootRequest): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.cwd === b.cwd &&
    JSON.stringify(a.config) === JSON.stringify(b.config)
  );
}

function sameSessionRestore(
  request: BootRequest,
): PersistedSandboxState | null {
  const restored = request.restored;
  if (!restored) return null;
  if (restored.version !== STATE_SCHEMA_VERSION) return null;
  if (restored.sessionId !== request.sessionId) return null;
  if (restored.cwd !== request.cwd) return null;
  return restored;
}

/**
 * Lifecycle coordinator for the injected sandbox ports. In particular, no
 * storage or SDK operation is reached until the owner lock has been acquired.
 */
export function createSandboxManager(deps: SandboxManagerDeps): SandboxManager {
  let state: RuntimeState = { status: "disabled", info: null };
  let lock: LockHandle | null = null;
  let runtime: RuntimeExecution | null = null;
  let sandboxName: string | null = null;
  let lastRequest: BootRequest | null = null;
  let retainedState: PersistedSandboxState | null = null;
  let activePlan: StoragePlan | null = null;
  // activeUses includes reservations made before preflight. pendingUses marks
  // those reservations; only activeUses - pendingUses are callbacks currently
  // using a transport and therefore must drain before replacement/disposal.
  let activeUses = 0;
  let pendingUses = 0;
  const usageDrainWaiters: Array<() => void> = [];

  // Lifecycle transitions are serialized, but the tool callback itself is not
  // put on this queue. This permits concurrent guest commands while ensuring a
  // wake/replacement cannot race another wake or shutdown.
  let lifecycle: Promise<unknown> = Promise.resolve();
  let transition: Promise<unknown> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = lifecycle.then(fn, fn);
    lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function enqueueTransition<T>(fn: () => Promise<T>): Promise<T> {
    const result = transition.then(fn, fn);
    transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function setFailure(request: BootRequest | null, error: unknown): RuntimeState {
    const reason = redactMessage(error, request?.config);
    state = {
      status: request?.config.fallbackMode === "host" ? "host-fallback" : "unavailable",
      info: null,
      reason,
    };
    return state;
  }

  async function disposeRuntime(): Promise<void> {
    const current = runtime;
    runtime = null;
    if (!current) return;
    try {
      await current.transport.dispose();
    } catch {
      // Disposal is best effort. The owner lock and sandbox cleanup must still
      // happen even when the transport has already gone down.
    }
  }

  function activeCallbackCount(): number {
    return activeUses - pendingUses;
  }

  function notifyUsageDrain(): void {
    if (activeCallbackCount() !== 0 || usageDrainWaiters.length === 0) return;
    const waiters = usageDrainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async function waitForActiveUses(): Promise<void> {
    if (activeCallbackCount() === 0) return;
    await new Promise<void>((resolve) => {
      usageDrainWaiters.push(resolve);
    });
  }

  function reserveUse(): void {
    activeUses += 1;
    pendingUses += 1;
  }

  function activateUse(): void {
    pendingUses -= 1;
  }

  function releaseUse(activated: boolean): void {
    activeUses -= 1;
    if (!activated) pendingUses -= 1;
    notifyUsageDrain();
  }

  function requestSandboxName(request: BootRequest): string {
    return request.config.sandboxName ?? sandboxNameFor(request.sessionId);
  }

  async function connectAndBuild(raw: unknown): Promise<RuntimeExecution> {
    const transport = deps.createTransport(raw);
    try {
      return {
        transport,
        operations: deps.createOperations(transport),
      };
    } catch (error) {
      try {
        await transport.dispose();
      } catch {
        // Preserve the operation-construction error.
      }
      throw error;
    }
  }

  async function bootInternal(request: BootRequest): Promise<RuntimeState> {
    // Do not mutate or reconnect a resource while a concurrent tool preflight is
    // atomically replacing its runtime handle.
    await transition;
    const previousRequest = lastRequest;
    if (
      state.status === "active" &&
      runtime &&
      previousRequest &&
      sandboxName === requestSandboxName(request) &&
      sameBootRequest(previousRequest, request)
    ) {
      return state;
    }
    if (state.status === "active" && runtime) {
      await shutdownInternal(false);
    }

    lastRequest = request;
    state = { status: "booting", info: null };
    let owner: LockHandle | null;
    try {
      owner = await deps.acquireOwnerLock(request);
    } catch (error) {
      // A lock implementation failure is fail-closed and must not permit any
      // SDK/storage call to run without ownership.
      return setFailure(request, error);
    }
    if (!owner) {
      // A live owner is not a stale-resource condition. Do not inspect, prune,
      // or otherwise mutate anything when the non-blocking lock says busy.
      state = {
        status: "unavailable",
        info: null,
        reason: "another process owns this session",
      };
      return state;
    }
    lock = owner;

    let prepared: PreparedStorage | null = null;
    let partialSandbox = false;
    let currentRequestInfo: RuntimeState["info"] = null;
    let bootedRuntime: RuntimeExecution | null = null;

    try {
      if (request.config.pruneOnStart) {
        await deps.pruneOthers(request.sessionId);
      }
      const git = await deps.detectGit(request.cwd);
      const restored = sameSessionRestore(request);
      const plan = deps.buildStoragePlan({
        cwd: request.cwd,
        sessionId: request.sessionId,
        config: request.config,
        git,
        restored,
      });
      prepared = await deps.prepareStorage(plan, restored);

      const name = requestSandboxName(request);
      sandboxName = name;
      const inspected = await deps.inspectSandbox(name);
      let raw: unknown;

      if (!inspected) {
        partialSandbox = true;
        raw = await deps.createSandbox(request, prepared);
      } else if (!isManagedOwner(inspected, request)) {
        throw new Error(`sandbox name conflict: ${name}`);
      } else if (!matchesPlan(inspected, request, plan)) {
        // The labels prove this is ours, but its configuration is stale. Only
        // that proven ownership permits a replacement.
        await deps.stopAndRemove(name, request.config.stopTimeoutMs);
        // The old instance was removed; a failed replacement still needs its
        // own best-effort cleanup.
        partialSandbox = true;
        raw = await deps.createSandbox(request, prepared);
      } else if (isRunning(inspected)) {
        raw = await deps.connectSandbox(inspected);
        partialSandbox = true;
      } else if (isStopped(inspected)) {
        partialSandbox = true;
        raw = await deps.startSandbox(inspected);
        if (raw === undefined || raw === null) raw = await deps.connectSandbox(inspected);
      } else {
        // An unknown state is not safe to replace. A connect gives adapters a
        // chance to normalize SDK-specific states without granting replace.
        raw = await deps.connectSandbox(inspected);
        partialSandbox = true;
      }

      bootedRuntime = await connectAndBuild(raw);
      runtime = bootedRuntime;
      await deps.probeAndBootstrap(bootedRuntime, request.config);

      let seed: SeedResult | null = null;
      if (
        prepared.plan.kind === "git-volume" &&
        prepared.createdVolume &&
        prepared.plan.seedRequired
      ) {
        seed = await deps.seed(bootedRuntime, prepared);
      }

      const createdAt = deps.now ? deps.now() : Date.now();
      const previous = restored;
      const seedBranch = prepared.createdVolume
        ? prepared.plan.kind === "git-volume"
          ? prepared.plan.branch
          : null
        : previous?.seedBranch ??
          (prepared.plan.kind === "git-volume" ? prepared.plan.branch : null);
      const seedSha = prepared.createdVolume
        ? seed?.headSha ??
          (prepared.plan.kind === "git-volume" ? prepared.plan.headSha : null)
        : previous?.seedSha ??
          (prepared.plan.kind === "git-volume" ? prepared.plan.headSha : null);
      currentRequestInfo = infoFor(
        request,
        prepared.plan,
        prepared,
        seedBranch,
        seedSha,
        createdAt,
        name,
      );

      // Bundle cleanup is deliberately before state publication: a successful
      // boot never publishes a state whose temporary host artifact leaked.
      if (prepared.bundle) await prepared.bundle.cleanup();
      prepared.bundle = null;

      const persisted: PersistedSandboxState = {
        version: STATE_SCHEMA_VERSION,
        sessionId: request.sessionId,
        sandboxName: name,
        mode: currentRequestInfo.mode,
        cwd: request.cwd,
        image: request.config.image,
        volumeName: currentRequestInfo.volumeName,
        volumeHostPath: currentRequestInfo.volumeHostPath,
        seedBranch: currentRequestInfo.seedBranch,
        seedSha: currentRequestInfo.seedSha,
        enabled: true,
        createdAt,
      };
      deps.persist(persisted);
      retainedState = persisted;
      activePlan = prepared.plan;
      state = { status: "active", info: currentRequestInfo };
      return state;
    } catch (error) {
      if (prepared?.bundle) {
        try {
          await prepared.bundle.cleanup();
        } catch {
          // The primary boot error is more useful, and no secret is exposed.
        }
        prepared.bundle = null;
      }
      await disposeRuntime();
      if (partialSandbox && sandboxName) {
        try {
          await deps.stopAndRemove(sandboxName, request.config.stopTimeoutMs);
        } catch {
          // Leave an uncertain labelled sandbox for a later prune/recovery.
        }
      }
      runtime = null;
      bootedRuntime = null;
      activePlan = null;
      sandboxName = null;
      if (lock === owner) {
        lock = null;
        try {
          await owner.release();
        } catch {
          // The lock implementation is expected to be idempotent. There is no
          // safe resource action to take if release itself fails.
        }
      }
      return setFailure(request, error);
    }
  }

  async function wakeIfNeeded(): Promise<RuntimeExecution> {
    if (state.status !== "active" || !runtime || !lastRequest || !sandboxName || !activePlan) {
      throw unavailableError(state);
    }

    const inspected = await deps.inspectSandbox(sandboxName);
    if (!inspected) {
      throw new Error(`sandbox ${sandboxName} is unavailable`);
    }
    if (inspected.name !== sandboxName) {
      throw new Error(`sandbox name mismatch: expected ${sandboxName}`);
    }
    if (!isManagedOwner(inspected, lastRequest)) {
      throw new Error(`sandbox ${sandboxName} has conflicting labels`);
    }
    // Revalidate the complete managed runtime identity before waking or
    // reconnecting. A same-name resource with changed mode/cwd/image/volume is
    // not safe to attach to.
    if (!matchesPlan(inspected, lastRequest, activePlan)) {
      throw new Error(`sandbox ${sandboxName} configuration changed`);
    }

    if (isRunning(inspected)) {
      // The boot-created transport remains authoritative while the sandbox is
      // running. Reconnecting here would replace a valid handle and dispose a
      // transport that may still have active callers.
      return runtime;
    }

    // A stopped/unknown sandbox requires a replacement transport. Do not stop,
    // start, or dispose the old one until every earlier callback has released
    // its runtime-use reservation.
    await waitForActiveUses();
    let raw: unknown;
    if (isStopped(inspected)) {
      raw = await deps.startSandbox(inspected);
      if (raw === undefined || raw === null) raw = await deps.connectSandbox(inspected);
    } else {
      raw = await deps.connectSandbox(inspected);
    }

    const replacement = await connectAndBuild(raw);
    const previous = runtime;
    runtime = replacement;
    if (previous && previous !== replacement) {
      try {
        await previous.transport.dispose();
      } catch {
        // The replacement is already installed and is the authoritative one.
      }
    }
    return replacement;
  }

  async function shutdownInternal(persistDisabled: boolean): Promise<void> {
    // A preflight may be reconnecting while the lifecycle queue reaches
    // shutdown. Finish that atomic replacement before disposing its handle.
    await transition;
    const hadSandbox = Boolean(sandboxName);
    const name = sandboxName;
    const request = lastRequest;
    const oldInfo = state.info;
    state = { status: "stopping", info: oldInfo };

    await waitForActiveUses();
    await disposeRuntime();

    let cleanupError: unknown = null;
    if (hadSandbox && name && request) {
      try {
        await deps.stopAndRemove(name, request.config.stopTimeoutMs);
      } catch (error) {
        cleanupError = error;
      }
    }

    runtime = null;
    activePlan = null;
    sandboxName = null;

    if (persistDisabled && request && oldInfo) {
      const createdAt = oldInfo.createdAt;
      const disabled: PersistedSandboxState = {
        version: STATE_SCHEMA_VERSION,
        sessionId: request.sessionId,
        sandboxName: oldInfo.name,
        mode: oldInfo.mode,
        cwd: oldInfo.cwd,
        image: oldInfo.image,
        volumeName: oldInfo.volumeName,
        volumeHostPath: oldInfo.volumeHostPath,
        seedBranch: oldInfo.seedBranch,
        seedSha: oldInfo.seedSha,
        enabled: false,
        createdAt,
      };
      retainedState = disabled;
      deps.persist(disabled);
    }

    // Releasing ownership is last, after transport and sandbox cleanup. This
    // ordering prevents prune from observing an owned resource as orphaned.
    const held = lock;
    lock = null;
    if (held) {
      try {
        await held.release();
      } catch {
        cleanupError ??= new Error("could not release the session lock");
      }
    }

    if (cleanupError) {
      state = {
        status: "unavailable",
        info: null,
        reason: redactMessage(cleanupError, request?.config),
      };
    } else if (persistDisabled) {
      state = { status: "off", info: null };
    } else {
      state = { status: "disabled", info: null };
    }
  }

  const manager: SandboxManager = {
    isActive(): boolean {
      return state.status === "active";
    },

    getState(): RuntimeState {
      return {
        status: state.status,
        info: state.info ? { ...state.info } : null,
        ...(state.reason ? { reason: state.reason } : {}),
      };
    },

    async withRuntime<T>(callback: (value: RuntimeExecution) => Promise<T>): Promise<T> {
      // Reserve before queuing preflight. A later wake must see this call even
      // while it is awaiting inspect/start/connect; otherwise it can dispose a
      // transport immediately before the callback begins using it.
      reserveUse();
      let activated = false;
      let current: RuntimeExecution;
      try {
        current = await enqueueTransition(async () => {
          const value = await wakeIfNeeded();
          activateUse();
          activated = true;
          return value;
        });
      } catch (error) {
        if (activated) releaseUse(true);
        else releaseUse(false);
        // A wake/reconnect failure must not leave a dead transport owned by a
        // runtime that is now being offered as host fallback. First wait for
        // earlier callbacks, then dispose; their transport remains usable until
        // their callbacks finish.
        await waitForActiveUses();
        await disposeRuntime();
        const held = lock;
        lock = null;
        if (held) {
          try {
            await held.release();
          } catch {
            // The next boot will fail closed if ownership cannot be reacquired.
          }
        }
        if (state.status === "active") setFailure(lastRequest, error);
        throw error;
      }
      try {
        return await callback(current);
      } finally {
        releaseUse(true);
      }
    },

    async boot(request: BootRequest): Promise<RuntimeState> {
      return enqueue(() => bootInternal(request));
    },

    async shutdown(): Promise<void> {
      return enqueue(() => shutdownInternal(false));
    },

    async setEnabled(enabled: boolean): Promise<RuntimeState> {
      return enqueue(async () => {
        if (!enabled) {
          if (state.status === "off" && !lock && !runtime) return manager.getState();
          await shutdownInternal(true);
          return manager.getState();
        }

        if (state.status === "active") return manager.getState();
        if (!lastRequest) {
          state = { status: "unavailable", info: null, reason: "no sandbox boot request" };
          return manager.getState();
        }
        const request: BootRequest = {
          ...lastRequest,
          restored: retainedState ?? lastRequest.restored,
        };
        return bootInternal(request);
      });
    },
  };

  return manager;
}
