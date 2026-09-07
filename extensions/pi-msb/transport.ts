import { posix as posixPath } from "node:path";

import type {
  EntryKind,
  ExecOptions,
  ExecStreamOptions,
  FsEntry,
  SandboxTransport,
  StatResult,
  TransportErrorCode,
  TransportExecResult,
} from "./types.ts";

/** An SDK operation failed before it could produce a transport result. */
export class SandboxTransportError extends Error {
  readonly code: TransportErrorCode;
  override readonly cause?: unknown;

  constructor(message: string, code: TransportErrorCode, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SandboxTransportError";
    this.code = code;
    this.cause = cause;
  }
}

type UnknownRecord = Record<string, unknown>;
type StreamEvent = {
  kind?: unknown;
  data?: unknown;
  code?: unknown;
};
type ExecHandle = {
  kill?: () => Promise<void> | void;
  [Symbol.asyncIterator]?: () => AsyncIterator<StreamEvent>;
};
type ExecBuilder = {
  args: (args: string[]) => ExecBuilder;
  cwd?: (cwd: string) => ExecBuilder;
  timeout?: (timeoutMs: number) => ExecBuilder;
};
type SandboxLike = {
  fs?: () => UnknownRecord;
  execWith?: (
    command: string,
    configure: (builder: ExecBuilder) => ExecBuilder,
  ) => Promise<UnknownRecord>;
  execStreamWith?: (
    command: string,
    configure: (builder: ExecBuilder) => ExecBuilder,
  ) => Promise<ExecHandle>;
};

type ActiveStream = {
  handle: ExecHandle;
  kill: () => Promise<void>;
  done: Promise<{ exitCode: number }>;
};
type PendingStreamCreation = {
  done: Promise<void>;
  resolve: () => void;
};

const TRANSPORT_CODES = new Set<TransportErrorCode>([
  "NOT_FOUND",
  "ACCESS",
  "TIMEOUT",
  "ABORTED",
  "SANDBOX_DOWN",
  "INVALID",
  "IO",
  "UNKNOWN",
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function constructorName(error: unknown): string {
  if (!isRecord(error)) return "";
  const ctor = error.constructor;
  if (typeof ctor === "function" && typeof ctor.name === "string" && ctor.name !== "Object") {
    return ctor.name;
  }
  return typeof error.name === "string" ? error.name : "";
}

function sdkCode(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== "string") return undefined;
  return error.code;
}

function mapSdkError(error: unknown, operation: string): SandboxTransportError {
  if (error instanceof SandboxTransportError) return error;

  const name = constructorName(error);
  const code = sdkCode(error);
  let mapped: TransportErrorCode = "UNKNOWN";

  // Prefer the SDK's typed error identity/code. Do not inspect arbitrary error
  // messages: those can contain guest data or resolved configuration secrets.
  if (
    name === "SandboxNotFoundError" ||
    name === "NotFoundError" ||
    code === "NOT_FOUND" ||
    code === "ENOENT" ||
    code === "sandboxNotFound" ||
    code === "volumeNotFound"
  ) {
    mapped = "NOT_FOUND";
  } else if (
    name === "PermissionDeniedError" ||
    name === "AccessDeniedError" ||
    name === "SandboxPermissionError" ||
    code === "ACCESS" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "permissionDenied"
  ) {
    mapped = "ACCESS";
  } else if (
    name === "ExecTimeoutError" ||
    name === "TimeoutError" ||
    code === "TIMEOUT" ||
    code === "ETIMEDOUT" ||
    code === "execTimeout"
  ) {
    mapped = "TIMEOUT";
  } else if (
    name === "AbortError" ||
    name === "AbortExecutionError" ||
    code === "ABORTED" ||
    code === "ABORT_ERR"
  ) {
    mapped = "ABORTED";
  } else if (
    name === "SandboxDownError" ||
    name === "SandboxStoppedError" ||
    name === "SandboxNotRunningError" ||
    name === "ConnectionClosedError" ||
    code === "SANDBOX_DOWN" ||
    code === "CONNECTION_CLOSED" ||
    code === "runtime"
  ) {
    mapped = "SANDBOX_DOWN";
  } else if (
    name === "InvalidArgumentError" ||
    name === "ValidationError" ||
    name === "SandboxAlreadyExistsError" ||
    name === "SandboxStillRunningError" ||
    code === "INVALID" ||
    code === "INVALID_ARGUMENT" ||
    code === "VALIDATION_ERROR" ||
    code === "invalidConfig" ||
    code === "sandboxAlreadyExists" ||
    code === "sandboxStillRunning" ||
    code === "unsupportedOperation" ||
    code === "unsupported" ||
    code === "volumeAlreadyExists"
  ) {
    mapped = "INVALID";
  } else if (
    name === "SandboxFsOpsError" ||
    name === "IoError" ||
    name === "IOError" ||
    code === "IO" ||
    code === "IO_ERROR" ||
    code === "EIO" ||
    code === "io" ||
    code === "sandboxFsOps"
  ) {
    mapped = "IO";
  } else if (code && TRANSPORT_CODES.has(code as TransportErrorCode)) {
    mapped = code as TransportErrorCode;
  }

  return new SandboxTransportError(`Sandbox transport ${operation} failed`, mapped, error);
}

function invalidSdk(operation: string): never {
  throw new SandboxTransportError(
    `Microsandbox SDK does not provide ${operation}`,
    "INVALID",
  );
}

function method<T extends (...args: any[]) => any>(
  value: UnknownRecord | undefined,
  name: string,
): T {
  const candidate = value?.[name];
  if (typeof candidate !== "function") invalidSdk(name);
  return candidate.bind(value) as T;
}

function kindOf(value: unknown): EntryKind {
  return value === "file" || value === "directory" ? value : "other";
}

function dateMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bytes(value: unknown, operation: string): Buffer {
  if (value instanceof Uint8Array || typeof value === "string") return Buffer.from(value);
  throw new SandboxTransportError(`Invalid ${operation} byte result`, "INVALID");
}

function configureExecution(
  builder: ExecBuilder,
  args: string[],
  options?: ExecOptions,
): ExecBuilder {
  let configured = builder.args(args);
  if (options?.cwd !== undefined) {
    if (typeof configured.cwd !== "function") invalidSdk("exec builder cwd");
    configured = configured.cwd(options.cwd);
  }
  if (options?.timeoutMs !== undefined) {
    if (typeof configured.timeout !== "function") invalidSdk("exec builder timeout");
    configured = configured.timeout(options.timeoutMs);
  }
  return configured;
}

function eventData(value: unknown): Buffer {
  return value instanceof Uint8Array || typeof value === "string"
    ? Buffer.from(value)
    : Buffer.from([]);
}

async function killHandle(handle: ExecHandle): Promise<void> {
  if (typeof handle.kill !== "function") return;
  await handle.kill();
}

async function drainHandle(handle: ExecHandle): Promise<void> {
  if (typeof handle[Symbol.asyncIterator] !== "function") return;
  const iterator = handle[Symbol.asyncIterator]!();
  while (true) {
    const next = await iterator.next();
    if (next.done) return;
  }
}

/**
 * Adapt a microsandbox Sandbox without importing the native SDK at
 * extension load time. The caller supplies the connected Sandbox instance.
 */
export function createSdkTransport(sandbox: unknown): SandboxTransport {
  const raw = sandbox as SandboxLike;
  const active = new Set<ActiveStream>();
  const pendingCreations = new Set<PendingStreamCreation>();
  let disposed = false;

  const rejectIfDisposed = (): void => {
    if (disposed) {
      throw new SandboxTransportError("Sandbox transport is disposed", "SANDBOX_DOWN");
    }
  };

  const call = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
    rejectIfDisposed();
    try {
      return await fn();
    } catch (error) {
      throw mapSdkError(error, operation);
    }
  };

  const getFs = (): UnknownRecord => {
    rejectIfDisposed();
    if (typeof raw.fs !== "function") invalidSdk("fs");
    const fs = raw.fs();
    if (!isRecord(fs)) invalidSdk("fs");
    return fs;
  };

  const readFile = (path: string): Promise<Buffer> =>
    call("read", async () => {
      const read = method<(path: string) => Promise<unknown>>(getFs(), "read");
      return bytes(await read(path), "read");
    });

  const writeFile = (path: string, data: string | Buffer): Promise<void> =>
    call("write", async () => {
      const write = method<(path: string, data: string | Uint8Array) => Promise<void>>(
        getFs(),
        "write",
      );
      await write(path, data);
    });

  const exists = (path: string): Promise<boolean> =>
    call("exists", async () => {
      const check = method<(path: string) => Promise<boolean>>(getFs(), "exists");
      return await check(path);
    });

  const stat = (path: string): Promise<StatResult> =>
    call("stat", async () => {
      const getStat = method<(path: string) => Promise<UnknownRecord>>(getFs(), "stat");
      const result = await getStat(path);
      return {
        kind: kindOf(result.kind),
        size: typeof result.size === "number" ? result.size : 0,
        mode: typeof result.mode === "number" ? result.mode : 0,
        readonly: result.readonly === true,
        modifiedAt: dateMillis(result.modified ?? result.modifiedAt),
      };
    });

  const list = (path: string): Promise<FsEntry[]> =>
    call("list", async () => {
      const listEntries = method<(path: string) => Promise<unknown[]>>(getFs(), "list");
      const entries = await listEntries(path);
      if (!Array.isArray(entries)) {
        throw new SandboxTransportError("Invalid filesystem list result", "INVALID");
      }
      return entries.map((entry) => {
        const value = isRecord(entry) ? entry : {};
        const entryPath = typeof value.path === "string" ? value.path : "";
        const name = posixPath.basename(entryPath) || (typeof value.name === "string" ? value.name : "");
        return { name, kind: kindOf(value.kind) };
      });
    });

  const copyFromHost = (hostPath: string, guestPath: string): Promise<void> =>
    call("copyFromHost", async () => {
      const copy = method<
        (hostPath: string, guestPath: string) => Promise<void>
      >(getFs(), "copyFromHost");
      await copy(hostPath, guestPath);
    });

  const copyToHost = (guestPath: string, hostPath: string): Promise<void> =>
    call("copyToHost", async () => {
      const copy = method<
        (guestPath: string, hostPath: string) => Promise<void>
      >(getFs(), "copyToHost");
      await copy(guestPath, hostPath);
    });

  const exec = (
    command: string,
    args: string[],
    options?: ExecOptions,
  ): Promise<TransportExecResult> =>
    call("exec", async () => {
      if (typeof raw.execWith !== "function") invalidSdk("execWith");
      const output = await raw.execWith(command, (builder) =>
        configureExecution(builder, args, options),
      );
      const stdoutBytes = method<() => Uint8Array>(output, "stdoutBytes");
      const stderrBytes = method<() => Uint8Array>(output, "stderrBytes");
      if (typeof output.code !== "number") {
        throw new SandboxTransportError("Invalid execution exit code", "INVALID");
      }
      return {
        stdout: Buffer.from(stdoutBytes()),
        stderr: Buffer.from(stderrBytes()),
        exitCode: output.code,
      };
    });

  const execStream = async (
    command: string,
    args: string[],
    options?: ExecStreamOptions,
  ): Promise<{ exitCode: number }> => {
    rejectIfDisposed();
    if (typeof raw.execStreamWith !== "function") invalidSdk("execStreamWith");

    let resolveCreation!: () => void;
    const creation: PendingStreamCreation = {
      done: new Promise<void>((resolve) => {
        resolveCreation = resolve;
      }),
      resolve: () => resolveCreation(),
    };
    pendingCreations.add(creation);

    try {
      let handle: ExecHandle;
      try {
        handle = await raw.execStreamWith(command, (builder) =>
          configureExecution(builder, args, options),
        );
      } catch (error) {
        if (disposed) {
          throw new SandboxTransportError("Sandbox transport is disposed", "SANDBOX_DOWN", error);
        }
        throw mapSdkError(error, "execStream");
      }

      // dispose() can run while the SDK is still acquiring the handle. The
      // late handle must be killed and drained before that dispose() settles.
      if (disposed) {
        try {
          await killHandle(handle);
        } catch {
          // The transport remains fail-closed even if SDK cleanup reports an error.
        }
        try {
          await drainHandle(handle);
        } catch {
          // The transport remains fail-closed even if SDK draining reports an error.
        }
        throw new SandboxTransportError("Sandbox transport is disposed", "SANDBOX_DOWN");
      }

      if (typeof handle?.[Symbol.asyncIterator] !== "function") {
        throw new SandboxTransportError("Invalid execution stream handle", "INVALID");
      }

      let killPromise: Promise<void> | undefined;
      const kill = (): Promise<void> => {
        if (!killPromise) {
          killPromise = killHandle(handle).catch((error) => {
            throw mapSdkError(error, "kill");
          });
        }
        return killPromise;
      };

      let aborted = options?.signal?.aborted === true;
      let exitCode: number | undefined;
      let entry!: ActiveStream;
      const consume = async (): Promise<{ exitCode: number }> => {
        const signal = options?.signal;
        const onAbort = (): void => {
          aborted = true;
          void kill().catch(() => undefined);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const iterator = handle[Symbol.asyncIterator]!();
          while (true) {
            const next = await iterator.next();
            if (next.done) break;
            const event = next.value as StreamEvent;
            if (event.kind === "stdout") {
              options?.onStdout?.(eventData(event.data));
            } else if (event.kind === "stderr") {
              options?.onStderr?.(eventData(event.data));
            } else if (event.kind === "exited" && typeof event.code === "number") {
              exitCode = event.code;
            }
          }
          if (aborted) {
            throw new SandboxTransportError("Sandbox execution aborted", "ABORTED", signal?.reason);
          }
          if (disposed) {
            throw new SandboxTransportError("Sandbox transport was disposed", "SANDBOX_DOWN");
          }
          return { exitCode: exitCode ?? 0 };
        } catch (error) {
          if (aborted) {
            throw new SandboxTransportError("Sandbox execution aborted", "ABORTED", signal?.reason);
          }
          throw mapSdkError(error, "execStream");
        } finally {
          signal?.removeEventListener("abort", onAbort);
          active.delete(entry);
        }
      };

      entry = {
        handle,
        kill,
        done: Promise.resolve({ exitCode: 0 }),
      };
      active.add(entry);
      if (aborted) void kill().catch(() => undefined);
      entry.done = consume();
      return entry.done;
    } finally {
      pendingCreations.delete(creation);
      creation.resolve();
    }
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;

    // Wait for SDK acquisitions already in flight. A creation that resolves
    // after disposal kills/drains its late handle before resolving this gate.
    const pendingDrain = Promise.allSettled(
      [...pendingCreations].map((creation) => creation.done),
    );
    const activeDrain = Promise.allSettled(
      [...active].map(async (entry) => {
        try {
          await entry.kill();
        } finally {
          await entry.done;
        }
      }),
    );
    await Promise.all([pendingDrain, activeDrain]);
  };

  return {
    readFile,
    writeFile,
    exists,
    stat,
    list,
    copyFromHost,
    copyToHost,
    exec,
    execStream,
    dispose,
  };
}
