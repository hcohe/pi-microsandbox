import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("test-boot-speed --help loads without starting a VM", () => {
  const script = fileURLToPath(new URL("../../scripts/test-boot-speed.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--experimental-strip-types", script, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:.*test-boot-speed\.mjs/);
  assert.match(result.stdout, /--max-ms/);
});
