import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { footerStatus } from "./index.ts";
import type { RuntimeState } from "./types.ts";

const active: RuntimeState = {
  status: "active",
  info: {
    name: "pi-msb-example",
    displayId: "bf9379",
    image: "ubuntu:24.04",
    pid: 123,
    cwd: "/repo/packages/app",
    root: "/repo",
    createdAt: 0,
    docker: { mode: "auto", readiness: "ready", version: "29.8.0", storageDriver: "vfs" },
  },
};

test("index bare import and factory registration do not create host configuration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-index-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    const { default: register } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
    register({ registerTool() {}, registerCommand() {}, on() {} });
  `], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: "pipe" });
  await assert.rejects(stat(agentDir), { code: "ENOENT" });
});

test("footer status follows the visibility setting", () => {
  assert.equal(footerStatus(active, false), undefined);
  assert.equal(footerStatus(active, true), "msb-bf9379");
});
