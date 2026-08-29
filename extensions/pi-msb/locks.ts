import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { LOCKFILE_VERSION, resourceId } from "./types.ts";
import type { LockHandle, LockInfo, LocksPort } from "./types.ts";

/**
 * The hooks are deliberately part of the options shape so unit tests can exercise
 * the lifecycle without loading the native addon. Production callers leave them
 * unset and use fs-ext below.
 */
export type FlockFn = (fd: number, operation: "exnb" | "un") => Promise<void>;

export interface LocksOptions {
  lockDir: string;
  warn?: (message: string) => void;
  flock?: FlockFn;
  unlock?: (fd: number) => Promise<void>;
}

type FsExtCallback = (
  fd: number,
  operation: string,
  callback: (error?: unknown) => void,
) => void;
type FsExtUnlockCallback = (fd: number, callback: (error?: unknown) => void) => void;
type FsExtModule = {
  flock?: FsExtCallback;
  unlock?: FsExtUnlockCallback;
};

let fsExtPromise: Promise<FsExtModule> | undefined;

// Keep the native dependency genuinely lazy and let extension-load/type-only
// environments operate without resolving the optional native module.
function importNativeModule(specifier: string): Promise<unknown> {
  return import(specifier);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unsupportedPlatformError(): Error {
  return new Error(
    "pi-microsandbox owner locks require POSIX flock(2) via fs-ext; this platform is unsupported (Windows LockFileEx is not implemented)",
  );
}

async function loadFsExt(): Promise<FsExtModule> {
  if (process.platform === "win32") throw unsupportedPlatformError();
  fsExtPromise ??= importNativeModule("fs-ext").then((module) => {
    const defaultExport = (module as unknown as { default?: unknown }).default;
    const candidate = (defaultExport ?? module) as FsExtModule;
    if (typeof candidate.flock !== "function") {
      throw new Error("fs-ext loaded without flock(); refusing to use a racy PID fallback");
    }
    return candidate;
  });
  return fsExtPromise;
}

function callbackFlock(flock: FsExtCallback, fd: number, operation: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      flock(fd, operation, (error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });
}

function callbackUnlock(unlock: FsExtUnlockCallback, fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      unlock(fd, (error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });
}

interface LockOperations {
  flock(fd: number): Promise<void>;
  unlock(fd: number): Promise<void>;
}

async function lockOperations(opts: LocksOptions): Promise<LockOperations> {
  if (opts.flock) {
    return {
      flock: (fd) => opts.flock!(fd, "exnb"),
      unlock: (fd) => opts.unlock ? opts.unlock(fd) : opts.flock!(fd, "un"),
    };
  }

  let module: FsExtModule;
  try {
    module = await loadFsExt();
  } catch (error) {
    throw new Error(
      `Unable to load fs-ext for owner locks; refusing to use a racy PID fallback: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const flock = module.flock;
  if (!flock) {
    throw new Error("fs-ext does not provide flock(); refusing to use a racy PID fallback");
  }
  const unlock = module.unlock;
  return {
    flock: (fd) => callbackFlock(flock, fd, "exnb"),
    unlock: (fd) => unlock
      ? callbackUnlock(unlock, fd)
      : callbackFlock(flock, fd, "un"),
  };
}

function normalizeLockInfo(value: unknown): LockInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<LockInfo>;
  const { version, sessionId, sandboxName, volumeName, mode, cwd, pid, createdAt } = candidate;
  if (version !== LOCKFILE_VERSION
    || typeof sessionId !== "string" || sessionId.length === 0
    || typeof sandboxName !== "string" || sandboxName.length === 0
    || (volumeName !== undefined && (typeof volumeName !== "string" || volumeName.length === 0))
    || (mode !== "git" && mode !== "direct" && mode !== "none")
    || typeof cwd !== "string" || !isAbsolute(cwd)
    || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0
    || typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    return null;
  }
  return { version, sessionId, sandboxName, volumeName, mode, cwd, pid, createdAt };
}

function validLockInfo(value: unknown): value is LockInfo {
  return normalizeLockInfo(value) !== null;
}

function lockInfoJson(info: LockInfo): string {
  // Serialize only the contract fields. This keeps the lockfile a small, validated
  // ownership record even if a caller passes an object with accidental extra fields.
  const value: Record<string, unknown> = {
    version: LOCKFILE_VERSION,
    sessionId: info.sessionId,
    sandboxName: info.sandboxName,
    mode: info.mode,
    cwd: info.cwd,
    pid: info.pid,
    createdAt: info.createdAt,
  };
  if (info.volumeName !== undefined) value.volumeName = info.volumeName;
  return `${JSON.stringify(value)}\n`;
}

async function ensureLockDir(lockDir: string): Promise<void> {
  try {
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    // mkdir's mode is ignored when the directory already exists.
    await chmod(lockDir, 0o700);
  } catch (error) {
    throw new Error(`Unable to prepare owner lock directory ${lockDir}: ${errorMessage(error)}`, { cause: error });
  }
}

export function lockPathFor(lockDir: string, sessionId: string): string {
  return join(lockDir, `pi-msb-${resourceId(sessionId)}.lock`);
}

async function acquireLock(
  opts: LocksOptions,
  path: string,
  info?: LockInfo,
): Promise<LockHandle | null> {
  await ensureLockDir(opts.lockDir);
  const operations = await lockOperations(opts);
  const file = await open(path, "a+", 0o600);

  try {
    try {
      await operations.flock(file.fd);
    } catch (error) {
      if (errorCode(error) === "EAGAIN" || errorCode(error) === "EWOULDBLOCK") {
        await file.close();
        return null;
      }
      throw new Error(
        `Unable to acquire non-blocking owner flock for ${path}: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    try {
      await file.chmod(0o600);
      if (info) {
        if (!validLockInfo(info)) throw new TypeError("Invalid owner lock information");
        await file.truncate(0);
        await file.writeFile(lockInfoJson(info), "utf8");
        await file.sync();
      }
    } catch (error) {
      try {
        await operations.unlock(file.fd);
      } finally {
        await file.close();
      }
      throw new Error(`Unable to write owner lock ${path}: ${errorMessage(error)}`, { cause: error });
    }

    let releasePromise: Promise<void> | undefined;
    return {
      path,
      release: () => {
        releasePromise ??= (async () => {
          let firstError: unknown;
          try {
            await operations.unlock(file.fd);
          } catch (error) {
            firstError = error;
          }
          try {
            await file.close();
          } catch (error) {
            firstError ??= error;
          }
          if (firstError) {
            throw new Error(`Unable to release owner flock for ${path}: ${errorMessage(firstError)}`, {
              cause: firstError,
            });
          }
        })();
        return releasePromise;
      },
    };
  } catch (error) {
    // The contention path closes the descriptor itself. All other failures must
    // close it too; the persistent inode is intentionally never unlinked.
    if (errorCode(error) !== "EAGAIN" && errorCode(error) !== "EWOULDBLOCK") {
      try {
        await file.close();
      } catch {
        // Preserve the actionable acquisition/write error.
      }
    }
    throw error;
  }
}

export async function acquireOwnerLock(opts: LocksOptions, info: LockInfo): Promise<LockHandle | null> {
  if (!validLockInfo(info)) throw new TypeError("Invalid owner lock information");
  return acquireLock(opts, lockPathFor(opts.lockDir, info.sessionId), info);
}

export async function tryAcquireOrphanLock(
  opts: LocksOptions,
  sessionId: string,
): Promise<LockHandle | null> {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("sessionId must be a non-empty string");
  }
  return acquireLock(opts, lockPathFor(opts.lockDir, sessionId));
}

export async function readLockInfo(path: string): Promise<LockInfo | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }

  try {
    const value: unknown = JSON.parse(text);
    return validLockInfo(value) ? value : null;
  } catch {
    return null;
  }
}

export function createLocksPort(opts: LocksOptions): LocksPort {
  return {
    tryAcquire: (sessionId) => tryAcquireOrphanLock(opts, sessionId),
  };
}
