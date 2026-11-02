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

test("headless /msb is actionable and never mutates runtime", async () => {
  const f = fixture();
  f.ctx.hasUI = false; f.ctx.mode = "print";
  await createCommandHandler(f.control)("", f.ctx);
  assert.match(f.notices.at(-1)?.message ?? "", /interactive terminal mode/);
  assert.deepEqual(f.calls, []);
});

test("every legacy public subcommand is rejected without side effects", async () => {
  const f = fixture();
  for (const command of ["status", "on", "off", "reload", "prune", "logs 25", "config", "set cpus 2", "unset cpus", "reset", "network deny", "seal", "mount add a b", "help", "volumes ls", "export a"]) {
    await createCommandHandler(f.control)(command, f.ctx);
    assert.match(f.notices.at(-1)?.message ?? "", /has no subcommands/);
  }
  assert.deepEqual(f.calls, []);
});

test("registerMsbCommand exposes only panel opening and no completions", () => {
  const f = fixture(); let registration: any;
  registerMsbCommand({ registerCommand: (name: string, options: any) => { assert.equal(name, "msb"); registration = options; } } as any, f.control);
  assert.equal(registration.description, "Open Microsandbox control panel");
  assert.equal(typeof registration.handler, "function");
  assert.equal(registration.getArgumentCompletions, undefined);
});
