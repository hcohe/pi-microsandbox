import { classifySettingsEffect } from "./settings-effect.ts";
import {
  displayId,
  sandboxNameFor,
  STATE_SCHEMA_VERSION,
  type BootRequest,
  type Config,
  type LockHandle,
  type PersistedSandboxState,
  type PruneReport,
  type RuntimeExecution,
  type RuntimePreparation,
  type RuntimeState,
  type SandboxManager,
  type SandboxTransport,
  type ToolOperations,
} from "./types.ts";

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
  inspectSandbox(name: string): Promise<InspectedSandbox | null>;
  connectSandbox(value: InspectedSandbox): Promise<unknown>;
  startSandbox(value: InspectedSandbox): Promise<unknown>;
  createSandbox(request: BootRequest): Promise<unknown>;
  stopAndRemove(name: string, timeoutMs: number): Promise<void>;
  createTransport(raw: unknown): SandboxTransport;
  createOperations(transport: SandboxTransport): ToolOperations;
  prepareRuntime(runtime: RuntimeExecution, config: Config): Promise<RuntimePreparation>;
  persist(state: PersistedSandboxState): void;
  /** Privately mask resolved credentials without resolving sources again. */
  redactError?(message: string): string;
  /** Called after cleanup errors have been sanitized and ownership released. */
  disposed?(): void;
  /** Successful adoption, or conservative loss of VM-instance certainty after inspection. */
  adopted?(request: BootRequest, verification: "created" | "reconnected" | "live"): void;
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

function isLegacyManagedOwner(value: InspectedSandbox, request: BootRequest): boolean {
  const labels = labelsOf(value);
  return labels["pi-msb.managed"] === "true" &&
    labels["pi-msb.session"] === request.sessionId &&
    /^\d+$/.test(labels["pi-msb.schema"] ?? "") &&
    Number(labels["pi-msb.schema"]) < STATE_SCHEMA_VERSION;
}

function matchesWorkspace(value: InspectedSandbox, request: BootRequest): boolean {
  const labels = labelsOf(value);
  return isManagedOwner(value, request) &&
    labels["pi-msb.cwd"] === request.cwd &&
    labels["pi-msb.root"] === request.workspace.hostRoot &&
    labels["pi-msb.guest-root"] === request.workspace.guestRoot &&
    labels["pi-msb.image"] === request.config.image;
}

function infoFor(
  request: BootRequest,
  createdAt: number,
  name: string,
  preparation: RuntimePreparation,
): NonNullable<RuntimeState["info"]> {
  return {
    name,
    displayId: displayId(request.sessionId),
    image: request.config.image,
    pid: process.pid,
    cwd: request.cwd,
    root: request.workspace.guestRoot,
    createdAt,
    docker: { ...preparation.docker },
  };
}

function redactMessage(error: unknown, config?: Config, sanitize?: (message: string) => string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (sanitize) message = sanitize(message);
  const sources = (config?.secrets ?? []).flatMap((secret) => [secret.textValue, secret.hostEnv, secret.hostCmd])
    .filter((source): source is string => typeof source === "string" && !!source)
    .flatMap((source) => [source, JSON.stringify(source).slice(1, -1)]);
  for (const source of [...new Set(sources)].sort((a, b) => b.length - a.length)) message = message.split(source).join("[REDACTED]");
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
    a.workspace.hostRoot === b.workspace.hostRoot &&
    a.workspace.guestRoot === b.workspace.guestRoot &&
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
  if (restored.cwd !== request.cwd ||
      restored.root !== request.workspace.hostRoot ||
      restored.guestRoot !== request.workspace.guestRoot) return null;
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
  let runtimeInvalid = false;
  let sandboxName: string | null = null;
  let lastRequest: BootRequest | null = null;
  let retainedState: PersistedSandboxState | null = null;
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
  // Failed-generation cleanup must not hold the preflight queue: an active
  // callback may be awaiting a reentrant preflight on that same queue.
  let retirement: Promise<void> = Promise.resolve();

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
    const reason = redactMessage(error, request?.config, deps.redactError);
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
    runtimeInvalid = false;
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

  function retireFailedRuntime(error: unknown): Promise<void> {
    const current = runtime;
    const held = lock;
    runtime = null;
    runtimeInvalid = false;
    lock = null;
    // The failed inspection/reconnect no longer proves cleanup authority for
    // this name. Future boot/prune must reacquire ownership and validate it.
    sandboxName = null;
    setFailure(lastRequest, error);

    // Detach ownership synchronously within the transition, but drain outside
    // it. Later preflights reject immediately; only the original failing call
    // and lifecycle operations wait for cleanup of these captured resources.
    retirement = (async () => {
      await waitForActiveUses();
      if (current) {
        try {
          await current.transport.dispose();
        } catch {
          // Best effort, as in disposeRuntime; ownership must still be released.
        }
      }
      if (held) {
        try {
          await held.release();
        } catch {
          // The next boot will fail closed if ownership cannot be reacquired.
        }
      }
    })();
    return retirement;
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

  function invalidatesRuntime(error: unknown): boolean {
    if (!error || typeof error !== "object" || !("code" in error)) return false;
    const code = (error as { code?: unknown }).code;
    return code === "SANDBOX_DOWN";
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
    await retirement;
    const previousRequest = lastRequest;
    if (
      state.status === "active" &&
      runtime &&
      previousRequest &&
      sandboxName === requestSandboxName(request) &&
      !request.forceRecreate &&
      sameBootRequest(previousRequest, request)
    ) {
      return state;
    }
    if (state.status === "active" && runtime && previousRequest && !request.forceRecreate &&
        previousRequest.sessionId === request.sessionId && previousRequest.cwd === request.cwd &&
        previousRequest.workspace.hostRoot === request.workspace.hostRoot &&
        previousRequest.workspace.guestRoot === request.workspace.guestRoot &&
        requestSandboxName(previousRequest) === requestSandboxName(request) &&
        classifySettingsEffect(previousRequest.config, request.config) !== "restart") {
      lastRequest = request;
      deps.adopted?.(request, "live");
      return state;
    }
    if (state.status === "active" && runtime) {
      await shutdownInternal(false);
      if (manager.getState().status === "unavailable") return state;
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

    let partialSandbox = false;
    let created = false;
    let currentRequestInfo: RuntimeState["info"] = null;
    let bootedRuntime: RuntimeExecution | null = null;

    try {
      if (request.config.pruneOnStart) {
        await deps.pruneOthers(request.sessionId);
      }
      const restored = sameSessionRestore(request);
      const name = requestSandboxName(request);
      sandboxName = name;
      const inspected = await deps.inspectSandbox(name);
      let raw: unknown;

      if (!inspected) {
        partialSandbox = true; created = true;
        raw = await deps.createSandbox(request);
      } else if (isLegacyManagedOwner(inspected, request)) {
        // The current session owner lock guards removal. Legacy named volumes
        // are intentionally neither inspected nor removed.
        await deps.stopAndRemove(name, request.config.stopTimeoutMs);
        partialSandbox = true; created = true;
        raw = await deps.createSandbox(request);
      } else if (!isManagedOwner(inspected, request)) {
        throw new Error(`sandbox name conflict: ${name}`);
      } else if (request.forceRecreate || !matchesWorkspace(inspected, request)) {
        // The labels prove this is ours, but its configuration is stale. Only
        // that proven ownership permits a replacement.
        await deps.stopAndRemove(name, request.config.stopTimeoutMs);
        // The old instance was removed; a failed replacement still needs its
        // own best-effort cleanup.
        partialSandbox = true; created = true;
        raw = await deps.createSandbox(request);
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
      runtimeInvalid = false;
      const preparation = await deps.prepareRuntime(bootedRuntime, request.config);

      const createdAt = deps.now ? deps.now() : Date.now();
      currentRequestInfo = infoFor(request, createdAt, name, preparation);

      const persisted: PersistedSandboxState = {
        version: STATE_SCHEMA_VERSION,
        sessionId: request.sessionId,
        sandboxName: name,
        cwd: request.cwd,
        root: request.workspace.hostRoot,
        guestRoot: request.workspace.guestRoot,
        image: request.config.image,
        enabled: true,
        createdAt,
      };
      deps.persist(persisted);
      retainedState = persisted;
      state = { status: "active", info: currentRequestInfo };
      deps.adopted?.(request, created ? "created" : "reconnected");
      return state;
    } catch (error) {
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
    if (state.status !== "active" || !runtime || !lastRequest || !sandboxName) {
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
    // reconnecting. A same-name resource with changed cwd/root/image is not
    // safe to attach to.
    if (!matchesWorkspace(inspected, lastRequest)) {
      throw new Error(`sandbox ${sandboxName} configuration changed`);
    }

    if (isRunning(inspected) && !runtimeInvalid) {
      // The boot-created transport remains authoritative while the sandbox is
      // running. Reconnecting here would replace a valid handle and dispose a
      // transport that may still have active callers. Labels alone cannot prove
      // that an external same-name replacement is the instance we created.
      deps.adopted?.(lastRequest, "reconnected");
      return runtime;
    }

    // A stopped/unknown sandbox or invalid running handle requires a
    // replacement transport. Do not start or dispose the old one until every
    // earlier callback has released its runtime-use reservation.
    await waitForActiveUses();
    let raw: unknown;
    if (isStopped(inspected)) {
      raw = await deps.startSandbox(inspected);
      if (raw === undefined || raw === null) raw = await deps.connectSandbox(inspected);
    } else {
      raw = await deps.connectSandbox(inspected);
    }

    const replacement = await connectAndBuild(raw);
    let preparation: RuntimePreparation;
    try {
      preparation = await deps.prepareRuntime(replacement, lastRequest.config);
    } catch (error) {
      try {
        await replacement.transport.dispose();
      } catch {
        // Preserve the preparation error.
      }
      const previous = runtime;
      runtime = null;
      runtimeInvalid = false;
      if (previous) {
        try {
          await previous.transport.dispose();
        } catch {
          // The preparation error remains authoritative.
        }
      }
      const failedName = sandboxName;
      sandboxName = null;
      if (failedName) {
        try {
          await deps.stopAndRemove(failedName, lastRequest.config.stopTimeoutMs);
        } catch {
          throw new Error(`${redactMessage(error, lastRequest.config, deps.redactError)}; failed to clean up the restarted sandbox`);
        }
      }
      throw error;
    }
    const previous = runtime;
    runtime = replacement;
    runtimeInvalid = false;
    if (state.info) state = { ...state, info: { ...state.info, docker: { ...preparation.docker } } };
    // A same-name guest is not a trustworthy instance identity. Reconnected VM
    // policy must become unknown even when the previous transport was ours.
    deps.adopted?.(lastRequest, "reconnected");
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
    await retirement;
    const hadSandbox = Boolean(sandboxName);
    const name = sandboxName;
    const request = lastRequest;
    const oldInfo = state.info;
    state = { status: "stopping", info: oldInfo };

    await waitForActiveUses();
    await disposeRuntime();

    let cleanupError: unknown = null;
    // Failed-generation retirement already released ownership. A later shutdown
    // must not mutate that name: another process may now own the resource.
    if (hadSandbox && name && request && lock) {
      try {
        await deps.stopAndRemove(name, request.config.stopTimeoutMs);
      } catch (error) {
        cleanupError = error;
      }
    }

    runtime = null;
    sandboxName = null;

    if (persistDisabled && request && oldInfo) {
      const createdAt = oldInfo.createdAt;
      const disabled: PersistedSandboxState = {
        version: STATE_SCHEMA_VERSION,
        sessionId: request.sessionId,
        sandboxName: oldInfo.name,
        cwd: oldInfo.cwd,
        root: request.workspace.hostRoot,
        guestRoot: request.workspace.guestRoot,
        image: oldInfo.image,
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
        reason: redactMessage(cleanupError, request?.config, deps.redactError),
      };
    } else if (persistDisabled) {
      state = { status: "off", info: null };
    } else {
      state = { status: "disabled", info: null };
    }
    deps.disposed?.();
  }

  const manager: SandboxManager = {
    isActive(): boolean {
      return state.status === "active";
    },

    getState(): RuntimeState {
      return {
        status: state.status,
        info: state.info ? { ...state.info, docker: { ...state.info.docker } } : null,
        ...(state.reason ? { reason: state.reason } : {}),
      };
    },

    async withRuntime<T>(callback: (value: RuntimeExecution) => Promise<T>): Promise<T> {
      // Reserve before queuing preflight. A later wake must see this call even
      // while it is awaiting inspect/start/connect; otherwise it can dispose a
      // transport immediately before the callback begins using it.
      reserveUse();
      let activated = false;
      let ownRetirement: Promise<void> | undefined;
      let current: RuntimeExecution;
      try {
        current = await enqueueTransition(async () => {
          try {
            const value = await wakeIfNeeded();
            activateUse();
            activated = true;
            return value;
          } catch (error) {
            // Only the first failed active preflight owns retirement. A call
            // queued before failure (including callback reentry) must also reject
            // without waiting for the active callbacks that cleanup is draining.
            if (state.status === "active") ownRetirement = retireFailedRuntime(error);
            throw error;
          }
        });
      } catch (error) {
        releaseUse(activated);
        await ownRetirement;
        throw error;
      }
      try {
        return await callback(current);
      } catch (error) {
        if (runtime === current && invalidatesRuntime(error)) runtimeInvalid = true;
        throw error;
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
