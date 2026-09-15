import assert from "node:assert/strict";
import test from "node:test";

import {
  flock,
  flockBinaryPath,
  flockTarget,
  loadFlockBinding,
  type FlockRuntime,
} from "./flock.ts";

const glibc = "2.39";

function runtime(platform: string, arch: string, glibcVersionRuntime?: unknown): FlockRuntime {
  return { platform, arch, glibcVersionRuntime };
}

test("maps only the supported host tuples", () => {
  assert.equal(flockTarget(runtime("darwin", "arm64")), "darwin-arm64");
  assert.equal(flockTarget(runtime("linux", "x64", glibc)), "linux-x64-gnu");
  assert.equal(flockTarget(runtime("linux", "arm64", glibc)), "linux-arm64-gnu");
});

test("rejects unsupported operating systems and architectures", () => {
  assert.throws(() => flockTarget(runtime("win32", "x64")), /does not support win32-x64.*unsafe fallback/);
  assert.throws(() => flockTarget(runtime("darwin", "x64")), /does not support darwin-x64/);
  assert.throws(() => flockTarget(runtime("linux", "riscv64", glibc)), /does not support linux-riscv64/);
});

test("rejects musl and indeterminate Linux libc", () => {
  assert.throws(() => flockTarget(runtime("linux", "x64")), /requires glibc.*musl or indeterminate/);
  assert.throws(() => flockTarget(runtime("linux", "arm64", "")), /requires glibc/);
});

test("resolves and validates the exact target binding", () => {
  let requiredPath = "";
  const nativeFlock = () => undefined;
  const binding = loadFlockBinding({
    runtime: runtime("linux", "x64", glibc),
    requireAddon: (path) => {
      requiredPath = path;
      return { flock: nativeFlock };
    },
  });
  assert.equal(requiredPath, flockBinaryPath("linux-x64-gnu"));
  assert.equal(binding.flock, nativeFlock);
});

test("missing and corrupt binaries fail closed with their cause", () => {
  for (const cause of [
    Object.assign(new Error("not found"), { code: "MODULE_NOT_FOUND" }),
    new Error("invalid ELF header"),
  ]) {
    assert.throws(
      () => loadFlockBinding({
        runtime: runtime("linux", "x64", glibc),
        requireAddon: () => { throw cause; },
      }),
      (error) => error instanceof Error
        && error.message.includes("linux-x64-gnu")
        && error.message.includes("native/flock/prebuilds/linux-x64-gnu/flock.node")
        && error.message.includes("refusing to use an unsafe fallback")
        && error.cause === cause,
    );
  }
});

test("bindings with missing, extra, or non-callable exports fail closed", () => {
  for (const exports of [{}, { flock: true }, { flock: () => undefined, extra: true }]) {
    assert.throws(
      () => loadFlockBinding({
        runtime: runtime("darwin", "arm64"),
        requireAddon: () => exports,
      }),
      /unsafe fallback.*must export only flock\(\)/,
    );
  }
});

test("TypeScript validation happens before any native addon load", async () => {
  await assert.rejects(flock(-1, "exnb"), TypeError);
  await assert.rejects(flock(1.5, "exnb"), TypeError);
  await assert.rejects(flock(0, "invalid" as "exnb"), /operation must be/);
});
