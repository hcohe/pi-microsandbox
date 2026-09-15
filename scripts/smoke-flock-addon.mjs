#!/usr/bin/env node
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function targetForCurrentHost() {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) {
    if (!process.report?.getReport()?.header?.glibcVersionRuntime) {
      throw new Error("flock addon smoke requires glibc Linux");
    }
    return `linux-${process.arch}-gnu`;
  }
  throw new Error(`unsupported flock addon smoke host: ${process.platform}-${process.arch}`);
}

if (process.argv.length > 3) {
  throw new Error("usage: node scripts/smoke-flock-addon.mjs [flock.node]");
}
const target = targetForCurrentHost();
const binary = resolve(process.argv[2] ?? join(ROOT, "native", "flock", "prebuilds", target, "flock.node"));
const binding = createRequire(import.meta.url)(binary);
assert.deepEqual(Object.keys(binding), ["flock"]);
assert.equal(typeof binding.flock, "function");
const { flock } = binding;

assert.throws(() => flock(), TypeError);
assert.throws(() => flock(-1, "exnb"), TypeError);
assert.throws(() => flock(1.5, "exnb"), TypeError);
assert.throws(() => flock(1, "exclusive"), TypeError);
assert.throws(
  () => flock(2_000_000_000, "exnb"),
  (error) => error instanceof Error
    && error.code === "EBADF"
    && Number.isInteger(error.errno)
    && error.errno > 0
    && error.syscall === "flock"
    && /^flock: /.test(error.message),
);

const directory = mkdtempSync(join(tmpdir(), "pi-msb-flock-smoke-"));
const lockPath = join(directory, "owner.lock");
const first = openSync(lockPath, "a+");
const second = openSync(lockPath, "a+");
try {
  assert.equal(flock(first, "exnb"), undefined);
  assert.throws(
    () => flock(second, "exnb"),
    (error) => error instanceof Error
      && error.code === "EAGAIN"
      && Number.isInteger(error.errno)
      && error.errno > 0
      && error.syscall === "flock",
  );

  const child = spawnSync(
    process.execPath,
    ["-e", String.raw`
      const binding = require(process.argv[1]);
      const fs = require("node:fs");
      const fd = fs.openSync(process.argv[2], "a+");
      try {
        binding.flock(fd, "exnb");
        process.exitCode = 2;
      } catch (error) {
        if (error && error.code === "EAGAIN" && error.syscall === "flock" && error.errno > 0) process.exitCode = 0;
        else { console.error(error); process.exitCode = 3; }
      } finally {
        fs.closeSync(fd);
      }
    `, binary, lockPath],
    { encoding: "utf8", timeout: 5_000 },
  );
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, `child was terminated by ${child.signal}`);
  assert.equal(child.status, 0, `cross-process contention failed:\n${child.stdout}${child.stderr}`);

  assert.equal(flock(first, "un"), undefined);
  assert.equal(flock(second, "exnb"), undefined);
  assert.equal(flock(second, "un"), undefined);

  assert.equal(flock(first, "exnb"), undefined);
  closeSync(first);
  assert.equal(flock(second, "exnb"), undefined);
  assert.equal(flock(second, "un"), undefined);
} finally {
  try { closeSync(first); } catch {}
  try { closeSync(second); } catch {}
  rmSync(directory, { recursive: true, force: true });
}

console.log(`flock addon smoke passed for ${target}: ${binary}`);
