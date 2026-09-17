import assert from "node:assert/strict";
import test from "node:test";

import { createCommandHandler, formatStatus, registerMsbCommand, systemPromptNote } from "./command.ts";
import type { MsbControl, RuntimeState } from "./types.ts";

function state(status: RuntimeState["status"]): RuntimeState {
  return {
    status,
    info: status === "active" ? {
      name: "pi-msb-0123456789abcdef0123",
      displayId: "012345",
      image: "ubuntu:24.04",
      pid: 42,
      cwd: "/repo/packages/app",
      root: "/repo",
      createdAt: Date.now() - 61_000,
      docker: { mode: "auto", readiness: "ready", version: "29.8.0", storageDriver: "vfs" },
    } : null,
  };
}

function fixture() {
  const notices: Array<{ message: string; type?: string }> = [];
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let current = state("active");
  const control: MsbControl = {
    getState: () => current,
    setEnabled: async (enabled) => { calls.push({ method: "setEnabled", args: [enabled] }); current = state(enabled ? "active" : "off"); },
    reload: async () => { calls.push({ method: "reload", args: [] }); },
    pruneNow: async () => { calls.push({ method: "pruneNow", args: [] }); return { inspected: 2, removed: ["old"], kept: ["live"], errors: [] }; },
    getLogs: async (tail) => { calls.push({ method: "getLogs", args: [tail] }); return "log line"; },
    getEffectiveConfig: () => ({ config: { secrets: [{ env: "TOKEN", value: "secret-value", allowHosts: [] }] } } as any),
    getEffectiveConfigToml: () => "[[secrets]]\nvalue = \"<redacted>\"",
    setOverride: async (key, value) => { calls.push({ method: "setOverride", args: [key, value] }); },
    unsetOverride: async (key) => { calls.push({ method: "unsetOverride", args: [key] }); },
    resetOverrides: async () => { calls.push({ method: "resetOverrides", args: [] }); },
  };
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
    waitForIdle: async () => { calls.push({ method: "waitForIdle", args: [] }); },
  } as any;
  return { control, ctx, notices, calls };
}

test("status and prompt report the mounted root without mode or volume language", () => {
  assert.equal(formatStatus(state("active")), "MSB active · /repo · pi-msb-0123456789abcdef0123");
  assert.equal(formatStatus(state("off")), "MSB host (off)");
  assert.equal(formatStatus(state("host-fallback")), "MSB host fallback (sandbox unavailable)");
  assert.equal(formatStatus({ status: "unavailable", info: null }), "MSB unavailable (blocked)");
  const note = systemPromptNote(state("active"));
  assert.match(note, /workspace mounted read\/write at \/repo/);
  assert.match(note, /Host-target execution/);
  assert.doesNotMatch(note, /mode|volume|seed/i);
});

test("status includes current identity and Docker capability", async () => {
  const f = fixture();
  await createCommandHandler(f.control)("", f.ctx);
  const message = f.notices.at(-1)?.message ?? "";
  assert.match(message, /Name: pi-msb-0123456789abcdef0123/);
  assert.match(message, /Workspace root: \/repo/);
  assert.match(message, /Workdir: \/repo\/packages\/app/);
  assert.match(message, /Docker mode: auto/);
  assert.match(message, /Docker readiness: ready/);
  assert.match(message, /Docker version: 29\.8\.0/);
  assert.doesNotMatch(message, /volume|seed|workspace mode/i);
});

test("on, off, and reload wait for idle before handing off", async () => {
  const f = fixture();
  const handler = createCommandHandler(f.control);
  await handler("off", f.ctx);
  await handler("on", f.ctx);
  await handler("reload", f.ctx);
  assert.deepEqual(
    f.calls.filter((call) => ["waitForIdle", "setEnabled", "reload"].includes(call.method)).map((call) => call.method),
    ["waitForIdle", "setEnabled", "waitForIdle", "setEnabled", "waitForIdle", "reload"],
  );
});

test("prune, config, logs, and overrides use the control facade", async () => {
  const f = fixture();
  const handler = createCommandHandler(f.control);
  await handler("prune", f.ctx);
  assert.match(f.notices.at(-1)?.message ?? "", /Removed: old/);
  await handler("config", f.ctx);
  assert.match(f.notices.at(-1)?.message ?? "", /redacted/);
  assert.doesNotMatch(f.notices.at(-1)?.message ?? "", /secret-value/);
  await handler("logs 25", f.ctx);
  await handler("set network.mode deny", f.ctx);
  await handler("unset network.mode", f.ctx);
  await handler("reset", f.ctx);
  assert.deepEqual(f.calls.slice(-4), [
    { method: "getLogs", args: [25] },
    { method: "setOverride", args: ["network.mode", "deny"] },
    { method: "unsetOverride", args: ["network.mode"] },
    { method: "resetOverrides", args: [] },
  ]);
});

test("removed mode, volume, export, and copy commands are unavailable", async () => {
  const f = fixture();
  const handler = createCommandHandler(f.control);
  for (const command of ["volumes ls", "export a", "copy a b", "mode git"]) {
    await handler(command, f.ctx);
    assert.match(f.notices.at(-1)?.message ?? "", /unknown \/msb command/);
    assert.equal(f.notices.at(-1)?.type, "error");
  }
});

test("registerMsbCommand registers the facade-backed handler", () => {
  const f = fixture();
  let registration: any;
  registerMsbCommand({ registerCommand: (_name: string, options: any) => { registration = options; } } as any, f.control);
  assert.equal(registration.description, "Manage pi-microsandbox");
  assert.equal(typeof registration.handler, "function");
});
