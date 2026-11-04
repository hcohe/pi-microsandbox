import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { footerStatus, styleFooterStatus } from "./index.ts";
import { displayId, type RuntimeState } from "./types.ts";

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

test("booting shows the real current-session ID before sandbox info exists", () => {
  const booting: RuntimeState = { status: "booting", info: null };
  assert.equal(footerStatus(booting, true, "session-one"), `msb-${displayId("session-one")}`);
  assert.equal(footerStatus({ ...booting, info: active.info }, true, "session-two"), `msb-${displayId("session-two")}`);
  assert.equal(footerStatus(booting, true), "msb-…");
  assert.equal(footerStatus(booting, false, "session-one"), undefined);
});

test("live footer puts a theme-success circle on the right of the dim label", () => {
  const calls: Array<[string, string]> = [];
  const theme = { fg: (role: string, text: string) => { calls.push([role, text]); return text; } };
  assert.equal(styleFooterStatus(theme, footerStatus(active, true)!, "active"), "\x1b[22mmsb-bf9379 ●\x1b[22m");
  assert.deepEqual(calls, [["dim", "msb-bf9379"], ["success", "●"]]);
});

test("boot frames flash only the right-hand circle between theme warning and dim", () => {
  const calls: Array<[string, string]> = [];
  const theme = { fg: (role: string, text: string) => { calls.push([role, text]); return text; } };
  const label = footerStatus({ status: "booting", info: null }, true, "session-one")!;
  for (let frame = 0; frame < 4; frame++) {
    calls.length = 0;
    assert.equal(styleFooterStatus(theme, label, "booting", frame), `\x1b[22m${label} ●\x1b[22m`);
    assert.deepEqual(calls, [["dim", label], [frame % 2 === 0 ? "warning" : "dim", "●"]]);
  }
});

test("non-live footers retain explicit host/blocked/disabled labels and never show success", () => {
  const calls: Array<[string, string]> = [];
  const theme = { fg: (role: string, text: string) => { calls.push([role, text]); return text; } };
  for (const [status, label, color] of [
    ["off", "MSB host", "warning"], ["host-fallback", "MSB host fallback", "warning"],
    ["unavailable", "MSB blocked", "error"], ["stopping", "MSB stopping", "warning"], ["disabled", "MSB disabled", "dim"],
  ] as const) {
    calls.length = 0;
    assert.equal(footerStatus({ status, info: null }, true), label);
    styleFooterStatus(theme, label, status);
    assert.deepEqual(calls, [["dim", label], [color, "●"]]);
  }
});
