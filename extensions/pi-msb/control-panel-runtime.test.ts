import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const localPackage = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
for (const pkg of new Set([localPackage, ...(process.env.PI_MSB_TEST_PI_PACKAGE ? [resolve(process.env.PI_MSB_TEST_PI_PACKAGE)] : [])])) {
  for (const renderer of ["main", "alt"]) {
    // A throttled Linux run needed 39s for both renderers. Give each isolated
    // renderer a bounded budget for real guarded filesystem/config inspection.
    test(`real /msb and config tools, approval/provenance, custom overlay and teardown (${renderer}): ${pkg}`, { timeout: 55_000 }, async (t) => {
      let stderr = "";
      try {
        const output = await promisify(execFile)(process.execPath, ["test/control-panel-runtime.mjs", pkg, renderer], {
          env: { PATH: process.env.PATH, TMPDIR: "/tmp", PI_MSB_RUNTIME_PHASES: "1" }, timeout: 50_000,
        });
        stderr = output.stderr;
        assert.match(output.stdout, /PASS .*real \/msb loader\/context\/custom\/theme/);
        const phases = stderr.match(/^PI_MSB_RUNTIME_PHASE (?:main|alt) [a-z0-9-]+\n/gm) ?? [];
        assert.ok(phases.length > 0 && phases.length <= 64);
        assert.equal(stderr.replace(/^PI_MSB_RUNTIME_PHASE (?:main|alt) [a-z0-9-]+\n/gm, ""), "");
      } catch (error) {
        const diagnostics = stderr || (error as { stderr?: string }).stderr;
        if (diagnostics) t.diagnostic(diagnostics);
        throw error;
      }
    });
  }
}
