import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { flock as bundledFlock } from "./flock.ts";
import { LOCKFILE_VERSION, resourceId } from "./types.ts";
import type { LockHandle, LockInfo, LocksPort } from "./types.ts";

/**
 * The hooks are deliberately part of the options shape so unit tests can exercise
 * the lifecycle without loading the native addon. Production callers leave them
 * unset and use the lazy bundled binding.
 */
export type FlockFn = (fd: number, operation: "exnb" | "un") => Promise<void>;

export interface LocksOptions {
  lockDir: string;
  warn?: (message: string) => void;
  flock?: FlockFn;
  unlock?: (fd: number) => Promise<void>;
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

interface LockOperations {
  flock(fd: number): Promise<void>;
  unlock(fd: number): Promise<void>;
}

async function lockOperations(opts: LocksOptions): Promise<LockOperations> {
  const flock = opts.flock ?? bundledFlock;
  return {
    flock: (fd) => flock(fd, "exnb"),
    unlock: (fd) => opts.unlock ? opts.unlock(fd) : flock(fd, "un"),
  };
}

function normalizeLockInfo(value: unknown): LockInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<LockInfo>;
  const { version, sessionId, sandboxName, cwd, root, pid, createdAt } = candidate;
  if (version !== LOCKFILE_VERSION
    || typeof sessionId !== "string" || sessionId.length === 0
    || typeof sandboxName !== "string" || sandboxName.length === 0
    || typeof cwd !== "string" || !isAbsolute(cwd)
    || typeof root !== "string" || !isAbsolute(root)
    || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0
    || typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    return null;
  }
  return { version, sessionId, sandboxName, cwd, root, pid, createdAt };
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
    cwd: info.cwd,
    root: info.root,
    pid: info.pid,
    createdAt: info.createdAt,
  };
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
