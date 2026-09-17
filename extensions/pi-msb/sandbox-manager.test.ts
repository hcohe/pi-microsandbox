import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "./config.ts";
import { createSandboxManager, type InspectedSandbox, type SandboxManagerDeps } from "./sandbox-manager.ts";
import { sandboxNameFor, STATE_SCHEMA_VERSION, type BootRequest, type Config, type LockHandle, type SandboxTransport, type ToolOperations } from "./types.ts";

const sessionId = "session-manager-test";
const cwd = "/tmp/project/packages/app";
const workspace = { hostRoot: "/canonical/project", guestRoot: "/tmp/project", cwd, fromGit: true };

function config(overrides: Partial<Config> = {}): Config {
  return { ...(structuredClone(DEFAULT_CONFIG) as Config), bootstrapTools: false, stopTimeoutMs: 10, pruneOnStart: true, ...overrides };
}

function request(overrides: Partial<BootRequest> = {}): BootRequest {
  return { sessionId, cwd, workspace, config: config(), restored: null, ...overrides };
}

function labels(req = request()): Record<string, string> {
  return {
    "pi-msb.managed": "true",
    "pi-msb.schema": String(STATE_SCHEMA_VERSION),
    "pi-msb.session": req.sessionId,
    "pi-msb.cwd": req.cwd,
    "pi-msb.root": req.workspace.hostRoot,
    "pi-msb.guest-root": req.workspace.guestRoot,
    "pi-msb.pid": "42",
    "pi-msb.image": req.config.image,
    "pi-msb.keep": "true",
  };
}

function transport(onDispose?: () => void): SandboxTransport {
  return {
    readFile: async () => Buffer.alloc(0), writeFile: async () => undefined, exists: async () => true,
    stat: async () => ({ kind: "file", size: 0, mode: 0o644, readonly: false, modifiedAt: null }),
    list: async () => [],
    exec: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 }),
    execStream: async () => ({ exitCode: 0 }),
    dispose: async () => { onDispose?.(); },
  };
}

const operations = {} as ToolOperations;

function owner(events: string[]): LockHandle {
  return { path: "/tmp/owner.lock", release: async () => { events.push("release"); } };
}

function depsFor(events: string[], overrides: Partial<SandboxManagerDeps> = {}): SandboxManagerDeps {
  return {
    acquireOwnerLock: async () => { events.push("lock"); return owner(events); },
    pruneOthers: async () => { events.push("prune"); return { inspected: 0, removed: [], kept: [], errors: [] }; },
    inspectSandbox: async () => { events.push("inspect"); return null; },
    connectSandbox: async () => { events.push("connect"); return {}; },
    startSandbox: async () => { events.push("start"); return {}; },
    createSandbox: async () => { events.push("create"); return {}; },
    stopAndRemove: async () => { events.push("stop-remove"); },
    createTransport: () => { events.push("transport"); return transport(); },
    createOperations: () => { events.push("operations"); return operations; },
    prepareRuntime: async () => { events.push("prepare-runtime"); return { docker: { mode: "auto", readiness: "ready", version: "29.8.0", storageDriver: "vfs" } }; },
    persist: () => { events.push("persist"); },
    now: () => 1234,
    ...overrides,
  };
}

test("the owner lock precedes every resource mutation", async () => {
  const events: string[] = [];
  const manager = createSandboxManager(depsFor(events));
  assert.equal((await manager.boot(request())).status, "active");
  assert.deepEqual(events.slice(0, 8), ["lock", "prune", "inspect", "create", "transport", "operations", "prepare-runtime", "persist"]);
  await manager.shutdown();
  assert.deepEqual(events.slice(-2), ["stop-remove", "release"]);
});

test("a duplicate live session fails closed before SDK access", async () => {
  const events: string[] = [];
  const manager = createSandboxManager(depsFor(events, { acquireOwnerLock: async () => { events.push("lock"); return null; } }));
  assert.equal((await manager.boot(request())).status, "unavailable");
  assert.deepEqual(events, ["lock"]);
});

test("matching current identity reconnects running sandboxes and starts stopped sandboxes", async () => {
  for (const status of ["running", "stopped"] as const) {
    const events: string[] = [];
    const req = request();
    const inspected: InspectedSandbox = { name: sandboxNameFor(req.sessionId), status, labels: labels(req) };
    const manager = createSandboxManager(depsFor(events, { inspectSandbox: async () => inspected }));
    assert.equal((await manager.boot(req)).status, "active");
    assert.equal(events.includes(status === "running" ? "connect" : "start"), true);
    assert.equal(events.includes("create"), false);
    await manager.shutdown();
  }
});

test("active info and persisted state use session, schema, image, cwd, and canonical root identity", async () => {
  const events: string[] = [];
  let persisted: any;
  const req = request();
  const manager = createSandboxManager(depsFor(events, { persist: (state) => { persisted = state; } }));
  const state = await manager.boot(req);
  assert.deepEqual(state.info && {
    name: state.info.name, image: state.info.image, cwd: state.info.cwd, root: state.info.root,
  }, {
    name: sandboxNameFor(sessionId), image: req.config.image, cwd, root: workspace.guestRoot,
  });
  assert.deepEqual(persisted, {
    version: STATE_SCHEMA_VERSION,
    sessionId,
    sandboxName: sandboxNameFor(sessionId),
    cwd,
    root: workspace.hostRoot,
    guestRoot: workspace.guestRoot,
    image: req.config.image,
    enabled: true,
    createdAt: 1234,
  });
  await manager.shutdown();
});

test("same-session legacy sandbox is removed under the held lock without volume access", async () => {
  const events: string[] = [];
  const req = request();
  const legacy: InspectedSandbox = {
    name: sandboxNameFor(sessionId), status: "running",
    labels: { "pi-msb.managed": "true", "pi-msb.schema": "1", "pi-msb.session": sessionId, "pi-msb.mode": "git", "pi-msb.volume": "pi-msb-vol-only-copy" },
  };
  const manager = createSandboxManager(depsFor(events, { inspectSandbox: async () => legacy }));
  assert.equal((await manager.boot(req)).status, "active");
  assert.ok(events.indexOf("lock") < events.indexOf("stop-remove"));
  assert.ok(events.indexOf("stop-remove") < events.indexOf("create"));
  assert.equal(events.some((event) => /volume/i.test(event)), false);
  await manager.shutdown();
});

test("stale current-schema cwd, root, or image is replaced but a different session is never mutated", async () => {
  for (const field of ["pi-msb.cwd", "pi-msb.root", "pi-msb.guest-root", "pi-msb.image"] as const) {
    const events: string[] = [];
    const req = request();
    const manager = createSandboxManager(depsFor(events, {
      inspectSandbox: async () => ({ name: sandboxNameFor(sessionId), status: "running", labels: { ...labels(req), [field]: "changed" } }),
    }));
    assert.equal((await manager.boot(req)).status, "active");
    assert.ok(events.indexOf("stop-remove") < events.indexOf("create"));
    await manager.shutdown();
  }

  const events: string[] = [];
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => ({ name: sandboxNameFor(sessionId), status: "running", labels: { ...labels(), "pi-msb.session": "another" } }),
  }));
  assert.equal((await manager.boot(request())).status, "unavailable");
  assert.equal(events.includes("stop-remove"), false);
  assert.equal(events.includes("create"), false);
});

test("wake revalidates name, session, schema, image, cwd, and root", async () => {
  const mutations: Array<[string, string]> = [
    ["name", "pi-msb-unexpected"],
    ["pi-msb.session", "other"],
    ["pi-msb.schema", "1"],
    ["pi-msb.image", "other:image"],
    ["pi-msb.cwd", "/different"],
    ["pi-msb.root", "/different-root"],
    ["pi-msb.guest-root", "/different-guest-root"],
  ];
  for (const [field, value] of mutations) {
    const events: string[] = [];
    let inspections = 0;
    const req = request();
    const manager = createSandboxManager(depsFor(events, {
      inspectSandbox: async () => {
        if (inspections++ === 0) return null;
        const record = { name: sandboxNameFor(sessionId), status: "running", labels: labels(req) };
        if (field === "name") record.name = value;
        else record.labels[field] = value;
        return record;
      },
    }));
    await manager.boot(req);
    await assert.rejects(manager.withRuntime(async () => undefined), /mismatch|conflicting labels|configuration changed/);
    assert.equal(manager.getState().status, "unavailable");
  }
});

test("boot preparation failure disposes the transport, cleans the sandbox, releases ownership, and honors fallback", async () => {
  const events: string[] = [];
  let disposed = 0;
  const manager = createSandboxManager(depsFor(events, {
    createTransport: () => transport(() => { disposed++; }),
    prepareRuntime: async () => { throw new Error("bootstrap failed"); },
  }));
  const result = await manager.boot(request({ config: config({ fallbackMode: "host" }) }));
  assert.equal(result.status, "host-fallback");
  assert.match(result.reason ?? "", /bootstrap failed/);
  assert.equal(disposed, 1);
  assert.ok(events.indexOf("stop-remove") < events.indexOf("release"));
});

test("a valid running transport is reused without reconnect or disposal", async () => {
  const events: string[] = [];
  let disposed = 0;
  const req = request();
  const inspected = { name: sandboxNameFor(sessionId), status: "running", labels: labels(req) };
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => inspected,
    createTransport: () => transport(() => { disposed++; }),
  }));
  await manager.boot(req);
  await manager.withRuntime(async (runtime) => { assert.equal(runtime.operations, operations); });
  assert.equal(events.filter((event) => event === "connect").length, 1);
  assert.equal(disposed, 0);
  await manager.shutdown();
  assert.equal(disposed, 1);
});

test("wake preparation failure blocks callbacks and disposes replacement and previous handles", async () => {
  const events: string[] = [];
  let inspections = 0;
  let preparations = 0;
  let disposed = 0;
  let callbackCalled = false;
  const req = request();
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => inspections++ === 0 ? null : { name: sandboxNameFor(sessionId), status: "stopped", labels: labels(req) },
    createTransport: () => transport(() => { disposed++; }),
    prepareRuntime: async () => {
      if (++preparations === 2) throw new Error("Docker daemon did not become ready");
      return { docker: { mode: "require", readiness: "ready" } };
    },
  }));
  await manager.boot(req);
  await assert.rejects(manager.withRuntime(async () => { callbackCalled = true; }), /Docker daemon/);
  assert.equal(callbackCalled, false);
  assert.equal(disposed, 2);
  assert.equal(manager.getState().status, "unavailable");
  assert.ok(events.indexOf("stop-remove") < events.indexOf("release"));
});

test("transport-down marks a running handle invalid and reconnects without retrying the callback", async () => {
  const events: string[] = [];
  let inspections = 0;
  let preparations = 0;
  let callbacks = 0;
  const req = request();
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => inspections++ === 0 ? null : { name: sandboxNameFor(sessionId), status: "running", labels: labels(req) },
    prepareRuntime: async () => ({ docker: { mode: "auto", readiness: "ready", version: `v${++preparations}` } }),
  }));
  await manager.boot(req);
  await assert.rejects(manager.withRuntime(async () => {
    callbacks++;
    throw Object.assign(new Error("transport down"), { code: "SANDBOX_DOWN" });
  }), /transport down/);
  await manager.withRuntime(async () => { callbacks++; });
  assert.equal(callbacks, 2);
  assert.equal(events.filter((event) => event === "connect").length, 1);
  assert.equal(preparations, 2);
  await manager.shutdown();
});

test("replacement waits for an active callback before disposing its transport", async () => {
  const events: string[] = [];
  let inspections = 0;
  let disposed = 0;
  let started!: () => void;
  const callbackStarted = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const callbackRelease = new Promise<void>((resolve) => { release = resolve; });
  const req = request();
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => inspections++ === 0 ? null : { name: sandboxNameFor(sessionId), status: "stopped", labels: labels(req) },
    createTransport: () => transport(() => { disposed++; }),
  }));
  await manager.boot(req);
  const first = manager.withRuntime(async () => { started(); await callbackRelease; });
  await callbackStarted;
  const second = manager.withRuntime(async () => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposed, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(disposed, 2);
  await manager.shutdown();
  assert.equal(disposed, 3);
});

test("reconnect failure switches to configured host fallback and releases the lock", async () => {
  const events: string[] = [];
  let inspections = 0;
  const req = request({ config: config({ fallbackMode: "host" }) });
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => inspections++ === 0 ? null : { name: sandboxNameFor(sessionId), status: "stopped", labels: labels(req) },
    startSandbox: async () => undefined,
    connectSandbox: async () => { throw new Error("reconnect failed"); },
  }));
  await manager.boot(req);
  await assert.rejects(manager.withRuntime(async () => undefined), /reconnect failed/);
  assert.equal(manager.getState().status, "host-fallback");
  assert.equal(events.includes("release"), true);
});

test("off persists direct identity and on boots again", async () => {
  const events: string[] = [];
  const states: any[] = [];
  const manager = createSandboxManager(depsFor(events, { persist: (state) => { states.push(state); } }));
  await manager.boot(request());
  await manager.setEnabled(false);
  assert.equal(manager.getState().status, "off");
  assert.equal(states.at(-1).root, workspace.hostRoot);
  assert.equal(states.at(-1).enabled, false);
  assert.equal((await manager.setEnabled(true)).status, "active");
  await manager.shutdown();
});
