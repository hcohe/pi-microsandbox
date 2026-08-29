import assert from "node:assert/strict";
import test from "node:test";

import {
  createCommandHandler,
  formatStatus,
  registerMsbCommand,
  systemPromptNote,
} from "./command.ts";
import type { MsbControl, RuntimeState, VolumeRecord } from "./types.ts";

function state(status: RuntimeState["status"]): RuntimeState {
  return {
    status,
    info:
      status === "active"
        ? {
            name: "pi-msb-0123456789abcdef0123",
            displayId: "012345",
            mode: "git",
            image: "ubuntu:24.04",
            pid: 42,
            cwd: "/repo",
            volumeName: "pi-msb-vol-0123456789abcdef0123",
            volumeHostPath: "/var/lib/pi-msb/repo",
            seedBranch: "feature/demo",
            seedSha: "deadbeef",
            createdAt: Date.now() - 61_000,
          }
        : null,
  };
}

function volume(name = "pi-msb-vol-0123456789abcdef0123"): VolumeRecord {
  return {
    name,
    hostPath: "/var/lib/pi-msb/repo",
    labels: {
      "pi-msb.managed": "true",
      "pi-msb.seed-branch": "main",
      "pi-msb.seed-sha": "abc123",
    },
    usedBytes: 2048,
    createdAt: Date.now() - 120_000,
  };
}

function fixture() {
  const notices: Array<{ message: string; type?: string }> = [];
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let current = state("active");
  let confirmResult = true;
  const control = {
    getState: () => current,
    setEnabled: async (enabled: boolean) => {
      calls.push({ method: "setEnabled", args: [enabled] });
      current = state(enabled ? "active" : "off");
    },
    reload: async () => calls.push({ method: "reload", args: [] }),
    pruneNow: async () => {
      calls.push({ method: "pruneNow", args: [] });
      return { inspected: 2, removed: ["old"], kept: ["live"], errors: [] };
    },
    listVolumes: async () => [volume()],
    describeVolume: async (name: string) => ({
      volume: volume(name),
      branch: "main",
      lastCommit: "abc123",
      dirtyCount: 0,
      mounted: false,
    }),
    removeVolume: async (name: string) => calls.push({ method: "removeVolume", args: [name] }),
    exportPaths: async (paths: string[], destination?: string) => {
      calls.push({ method: "exportPaths", args: [paths, destination] });
      return paths.map((source) => ({ source, destination: `${destination ?? "/tmp/export"}/${source}` }));
    },
    getLogs: async (tail?: number) => {
      calls.push({ method: "getLogs", args: [tail] });
      return "log line";
    },
    getEffectiveConfig: () => ({ config: { secrets: [{ env: "TOKEN", value: "secret-value", allowHosts: [] }] } } as any),
    getEffectiveConfigToml: () => "[secrets]\nvalue = \"[redacted]\"",
    setOverride: async (key: string, value: unknown) => calls.push({ method: "setOverride", args: [key, value] }),
    unsetOverride: async (key: string) => calls.push({ method: "unsetOverride", args: [key] }),
    resetOverrides: async () => calls.push({ method: "resetOverrides", args: [] }),
  } as unknown as MsbControl;
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message: string, type?: string) => notices.push({ message, type }),
      confirm: async () => confirmResult,
    },
    waitForIdle: async () => calls.push({ method: "waitForIdle", args: [] }),
  } as any;
  return {
    control,
    ctx,
    notices,
    calls,
    setConfirm(value: boolean) {
      confirmResult = value;
    },
  };
}

test("formatStatus distinguishes active, explicit host, fallback, and blocked states", () => {
  assert.equal(formatStatus(state("active")), "MSB active · git · pi-msb-0123456789abcdef0123");
  assert.equal(formatStatus(state("off")), "MSB host (off)");
  assert.equal(formatStatus(state("host-fallback")), "MSB host fallback (sandbox unavailable)");
  assert.equal(formatStatus({ status: "unavailable", info: null }), "MSB unavailable (blocked)");
  assert.equal(formatStatus(state("booting")), "MSB booting…");
  assert.equal(formatStatus(state("stopping")), "MSB stopping…");
});

test("system prompt note calls out retained git state and host fallback", () => {
  const note = systemPromptNote(state("active"));
  assert.match(note, /git mode/);
  assert.match(note, /Retained volume/);
  assert.match(note, /Host-target execution/);
  assert.match(systemPromptNote(state("host-fallback")), /different from explicitly turning MSB off/);
});

test("status is detailed and uses the full sandbox and volume names", async () => {
  const f = fixture();
  await createCommandHandler(f.control)("", f.ctx);
  const message = f.notices.at(-1)?.message ?? "";
  assert.match(message, /Name: pi-msb-0123456789abcdef0123/);
  assert.match(message, /Retained volume: pi-msb-vol-0123456789abcdef0123/);
  assert.match(message, /Seed SHA: deadbeef/);
  assert.doesNotMatch(message, /Name: pi-msb-012345$/);
});

test("on, off, and reload wait for idle before handing off", async () => {
  const f = fixture();
  const handler = createCommandHandler(f.control);
  await handler("off", f.ctx);
  await handler("on", f.ctx);
  await handler("reload", f.ctx);
  const lifecycle = f.calls.filter((call) => ["waitForIdle", "setEnabled", "reload"].includes(call.method));
  assert.deepEqual(lifecycle.map((call) => call.method), ["waitForIdle", "setEnabled", "waitForIdle", "setEnabled", "waitForIdle", "reload"]);
});

test("volume removal requires managed, unmounted metadata and confirmation", async () => {
  const f = fixture();
  const handler = createCommandHandler(f.control);
  await handler("volumes rm pi-msb-vol-0123456789abcdef0123", f.ctx);
  assert.deepEqual(f.calls.at(-1), { method: "removeVolume", args: ["pi-msb-vol-0123456789abcdef0123"] });

  const noUi = fixture();
  noUi.ctx.hasUI = false;
  await createCommandHandler(noUi.control)("volumes rm pi-msb-vol-0123456789abcdef0123", noUi.ctx);
  assert.equal(noUi.calls.some((call) => call.method === "removeVolume"), false);
  assert.match(noUi.notices.at(-1)?.message ?? "", /--yes/);
});

test("prune reports that volumes are never pruned", async () => {
  const f = fixture();
  await createCommandHandler(f.control)("prune", f.ctx);
  assert.match(f.notices.at(-1)?.message ?? "", /Removed: old/);
  assert.match(f.notices.at(-1)?.message ?? "", /Volumes are never pruned/);
});

test("config uses the facade's redacted TOML and never stringifies secrets", async () => {
  const f = fixture();
  await createCommandHandler(f.control)("config", f.ctx);
  const message = f.notices.at(-1)?.message ?? "";
  assert.match(message, /redacted/);
  assert.doesNotMatch(message, /secret-value/);
});

test("export reports every result and passes destination", async () => {
  const f = fixture();
  await createCommandHandler(f.control)("export src/a.txt src/b.txt --to ./out", f.ctx);
  const call = f.calls.find((entry) => entry.method === "exportPaths");
  assert.deepEqual(call?.args, [["src/a.txt", "src/b.txt"], "./out"]);
  assert.match(f.notices.at(-1)?.message ?? "", /src\/a.txt/);
  assert.match(f.notices.at(-1)?.message ?? "", /src\/b.txt/);
});

test("export fails closed without UI unless --yes is explicit", async () => {
  const f = fixture();
  f.ctx.hasUI = false;
  const handler = createCommandHandler(f.control);

  await handler("export src/a.txt --to ./out", f.ctx);
  assert.equal(f.calls.some((call) => call.method === "exportPaths"), false);
  assert.match(f.notices.at(-1)?.message ?? "", /--yes/);

  await handler("export src/a.txt --to ./out --yes", f.ctx);
  assert.equal(f.calls.some((call) => call.method === "exportPaths"), true);
});

test("UI export still requires confirmation unless --yes is supplied", async () => {
  const f = fixture();
  f.setConfirm(false);
  await createCommandHandler(f.control)("export src/a.txt --to ./out", f.ctx);
  assert.equal(f.calls.some((call) => call.method === "exportPaths"), false);
  assert.match(f.notices.at(-1)?.message ?? "", /cancelled/i);
});

test("invalid commands are reported without invoking control mutations", async () => {
  const f = fixture();
  await createCommandHandler(f.control)("volumes rm", f.ctx);
  assert.equal(f.calls.some((call) => call.method === "removeVolume"), false);
  assert.match(f.notices.at(-1)?.message ?? "", /usage/);
});

test("registerMsbCommand registers the facade-backed handler", () => {
  const f = fixture();
  let registration: any;
  registerMsbCommand({ registerCommand: (_name: string, options: any) => (registration = options) } as any, f.control);
  assert.equal(registration.description, "Manage pi-microsandbox and retained volumes");
  assert.equal(typeof registration.handler, "function");
});
