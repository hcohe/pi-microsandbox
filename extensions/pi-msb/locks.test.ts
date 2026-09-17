import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { flockBinaryPath, flockTarget } from "./flock.ts";
import {
  acquireOwnerLock,
  createLocksPort,
  lockPathFor,
  readLockInfo,
  tryAcquireOrphanLock,
  type FlockFn,
  type LocksOptions,
} from "./locks.ts";
import type { LockInfo } from "./types.ts";

const info: LockInfo = {
  version: 2,
  sessionId: "session-alpha",
  sandboxName: "pi-msb-alpha",
  cwd: "/tmp/project/packages/app",
  root: "/tmp/project",
  pid: 1234,
  createdAt: 1700000000000,
};

function fakeFlock(): { flock: FlockFn; unlock: (fd: number) => Promise<void>; unlocks: number } {
  const held = new Set<number>();
  let unlocks = 0;
  const flock: FlockFn = async (fd, operation) => {
    if (operation === "un") {
      held.delete(fd);
      unlocks++;
      return;
    }
    if (held.size > 0) {
      const error = Object.assign(new Error("would block"), { code: "EWOULDBLOCK" });
      throw error;
    }
    held.add(fd);
  };
  return {
    flock,
    unlock: async (fd) => flock(fd, "un"),
    get unlocks() {
      return unlocks;
    },
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-msb-locks-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function options(lockDir: string, fake = fakeFlock()): LocksOptions {
  return { lockDir, flock: fake.flock, unlock: fake.unlock };
}

test("two descriptors contend without waiting, then release permits ownership", async () => {
  await withTempDir(async (dir) => {
    const opts = options(dir);
    const owner = await acquireOwnerLock(opts, info);
    assert.ok(owner);

    const contender = await tryAcquireOrphanLock(opts, info.sessionId);
    assert.equal(contender, null);

    await owner.release();
    const replacement = await tryAcquireOrphanLock(opts, info.sessionId);
    assert.ok(replacement);
    await replacement.release();
  });
});

test("owner metadata is truncated, synced, and readable while the inode persists", async () => {
  await withTempDir(async (dir) => {
    const owner = await acquireOwnerLock(options(dir), info);
    assert.ok(owner);
    const path = lockPathFor(dir, info.sessionId);
    assert.deepStrictEqual(await readLockInfo(path), info);
    const text = await readFile(path, "utf8");
    assert.match(text, /"version":2/);
    assert.match(text, /"root":"\/tmp\/project"/);
    assert.doesNotMatch(text, /mode|volume/i);

    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600);
    await owner.release();
    assert.deepStrictEqual(await readLockInfo(path), info);
  });
});

test("rejects unsafe integer owner PIDs before acquiring", async () => {
  await withTempDir(async (dir) => {
    const unsafe = { ...info, pid: Number.MAX_SAFE_INTEGER + 1 };
    await assert.rejects(
      acquireOwnerLock(options(dir), unsafe),
      /Invalid owner lock information/,
    );
  });
});

test("readLockInfo rejects unsafe integer PIDs", async () => {
  await withTempDir(async (dir) => {
    const path = lockPathFor(dir, info.sessionId);
    await writeFile(path, JSON.stringify({ ...info, pid: Number.MAX_SAFE_INTEGER + 1 }));
    assert.equal(await readLockInfo(path), null);
  });
});

test("acquiring an existing lockfile normalizes its mode to owner-only", async () => {
  await withTempDir(async (dir) => {
    const path = lockPathFor(dir, info.sessionId);
    await writeFile(path, "stale metadata\n", { mode: 0o644 });
    await chmod(path, 0o644);
    assert.equal((await stat(path)).mode & 0o777, 0o644);

    const owner = await acquireOwnerLock(options(dir), info);
    assert.ok(owner);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await owner.release();
  });
});

test("corrupt JSON does not decide ownership", async () => {
  await withTempDir(async (dir) => {
    const opts = options(dir);
    const owner = await acquireOwnerLock(opts, info);
    assert.ok(owner);
    const path = lockPathFor(dir, info.sessionId);
    await writeFile(path, "not json\n");
    assert.equal(await readLockInfo(path), null);
    assert.equal(await tryAcquireOrphanLock(opts, info.sessionId), null);

    await owner.release();
    const recovered = await tryAcquireOrphanLock(opts, info.sessionId);
    assert.ok(recovered);
    await recovered.release();
  });
});

test("release is idempotent and the port exposes orphan acquisition", async () => {
  await withTempDir(async (dir) => {
    const fake = fakeFlock();
    const owner = await acquireOwnerLock({ lockDir: dir, flock: fake.flock, unlock: fake.unlock }, info);
    assert.ok(owner);

    await Promise.all([owner.release(), owner.release(), owner.release()]);
    assert.equal(fake.unlocks, 1);

    const port = createLocksPort({ lockDir: dir, flock: fake.flock, unlock: fake.unlock });
    const orphan = await port.tryAcquire(info.sessionId);
    assert.ok(orphan);
    await orphan.release();
    assert.equal(fake.unlocks, 2);
  });
});

test("flock failures fail closed instead of falling back to PID checks", async () => {
  await withTempDir(async (dir) => {
    const flock: FlockFn = async () => {
      throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" });
    };
    await assert.rejects(
      tryAcquireOrphanLock({ lockDir: dir, flock }, info.sessionId),
      /non-blocking owner flock.*operation not supported/,
    );
  });
});

test("real bundled addon contention is kernel-backed when the current prebuild is available", async (t) => {
  try {
    const report = process.platform === "linux"
      ? process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined
      : undefined;
    const target = flockTarget({
      platform: process.platform,
      arch: process.arch,
      glibcVersionRuntime: report?.header?.glibcVersionRuntime,
    });
    await access(flockBinaryPath(target));
  } catch {
    t.skip("the current target prebuild is absent or this source host is unsupported");
    return;
  }

  await withTempDir(async (dir) => {
    let first;
    try {
      first = await tryAcquireOrphanLock({ lockDir: dir }, info.sessionId);
    } catch (error) {
      t.skip(`the bundled addon cannot be loaded on this host: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    assert.ok(first);
    assert.equal(await tryAcquireOrphanLock({ lockDir: dir }, info.sessionId), null);
    await first.release();
    const afterClose = await tryAcquireOrphanLock({ lockDir: dir }, info.sessionId);
    assert.ok(afterClose);
    await afterClose.release();
  });
});
