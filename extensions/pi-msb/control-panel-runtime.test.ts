import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const localPackage = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
for (const pkg of new Set([localPackage, ...(process.env.PI_MSB_TEST_PI_PACKAGE ? [resolve(process.env.PI_MSB_TEST_PI_PACKAGE)] : [])])) {
  test(`real /msb and config tools, approval/provenance, custom overlay and teardown: ${pkg}`, { timeout: 30_000 }, async () => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["test/control-panel-runtime.mjs", pkg], {
      env: { PATH: process.env.PATH, TMPDIR: "/tmp" }, timeout: 25_000,
    });
    assert.match(stdout, /PASS .*real \/msb loader\/context\/custom\/theme/);
    assert.equal(stderr, "");
  });
}
