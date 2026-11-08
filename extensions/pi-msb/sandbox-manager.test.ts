import assert from "node:assert/strict";
import test from "node:test";
import { left, right } from "@criblinc/docker-names";

import { DEFAULT_CONFIG } from "./config.ts";
import { createSandboxManager, type InspectedSandbox, type SandboxManagerDeps } from "./sandbox-manager.ts";
import { STATE_SCHEMA_VERSION, type BootRequest, type Config, type LockHandle, type PersistedSandboxState, type RuntimeState, type SandboxTransport, type ToolOperations } from "./types.ts";

const fixtureSandboxNameFor = (session: string): string => `fixture-${session}`;

const sessionId = "session-manager-test";
const cwd = "/tmp/project/packages/app";
const workspace = { hostRoot: "/canonical/project/packages/app", guestRoot: cwd, cwd };

function config(overrides: Partial<Config> = {}): Config {
  return { ...(structuredClone(DEFAULT_CONFIG) as Config), sandboxName: fixtureSandboxNameFor(sessionId), bootstrapTools: false, stopTimeoutMs: 10, pruneOnStart: true, ...overrides };
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for lifecycle test progress")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

test("lifecycle failures mask all secret sources and privately captured resolved tokens", async () => {
  const sensitive = "literal-private HOST_VARIABLE_PRIVATE host-command-private resolved-private";
  const req = request({ config: config({ secrets: [
    { env: "LITERAL", allowHosts: ["api.example"], textValue: "literal-private" },
    { env: "ENV", allowHosts: ["api.example"], hostEnv: "HOST_VARIABLE_PRIVATE" },
    { env: "CMD", allowHosts: ["api.example"], hostCmd: "host-command-private" },
  ] }) });
  for (const failDuring of ["boot", "shutdown"]) {
    let disposed = false;
    const manager = createSandboxManager(depsFor([], {
      createSandbox: async () => { if (failDuring === "boot") throw new Error(sensitive); return {}; },
      stopAndRemove: async () => { if (failDuring === "shutdown") throw new Error(sensitive); },
      redactError: (message) => message.replaceAll("resolved-private", "[REDACTED]"),
      disposed: () => {
        assert.doesNotMatch(manager.getState().reason ?? "", /resolved-private/);
        disposed = true;
      },
    }));
    await manager.boot(req);
    if (failDuring === "shutdown") await manager.shutdown();
    assert.equal(manager.getState().status, "unavailable");
    assert.equal(manager.getState().reason, "[REDACTED] [REDACTED] [REDACTED] [REDACTED]");
    assert.equal(disposed, failDuring === "shutdown");
  }
});

test("lifecycle failures mask JSON-escaped textValue and hostCmd sources", async () => {
  const literal = 'literal-private\n"quoted"';
  const command = 'printf "command-private\\n"';
  const req = request({ config: config({ secrets: [
    { env: "LITERAL", allowHosts: ["api.example"], textValue: literal },
    { env: "CMD", allowHosts: ["api.example"], hostCmd: command },
  ] }) });
  const manager = createSandboxManager(depsFor([], {
    createSandbox: async () => {
      throw new Error([literal, command].map((source) => JSON.stringify(source).slice(1, -1)).join(" / "));
    },
  }));
  await manager.boot(req);
  assert.equal(manager.getState().status, "unavailable");
  assert.equal(manager.getState().reason, "[REDACTED] / [REDACTED]");
});

test("restart preparation and cleanup failures mask literal and privately resolved secrets", async () => {
  const req = request({ config: config({ secrets: [
    { env: "TOKEN", allowHosts: ["api.example"], textValue: "literal-private" },
  ] }) });
  let restarting = false;
  const manager = createSandboxManager(depsFor([], {
    inspectSandbox: async () => restarting
      ? { name: fixtureSandboxNameFor(sessionId), status: "stopped", labels: labels(req) }
      : null,
    prepareRuntime: async () => {
      if (restarting) throw new Error("literal-private resolved-private");
      return { docker: { mode: "disabled", readiness: "disabled" } };
    },
    stopAndRemove: async () => { throw new Error("resolved-private"); },
    redactError: (message) => message.replaceAll("resolved-private", "[REDACTED]"),
  }));
  assert.equal((await manager.boot(req)).status, "active");
  restarting = true;
  const reason = "[REDACTED] [REDACTED]; failed to clean up the restarted sandbox";
  await assert.rejects(manager.withRuntime(async () => assert.fail("must not execute")), { message: reason });
  assert.equal(manager.getState().status, "unavailable");
  assert.equal(manager.getState().reason, reason);
});

test("adoption observer runs only after successful boot/reconnect or live policy adoption", async () => {
  for (const inspectedStatus of [undefined, "running", "stopped"]) {
    const events: string[] = []; const adopted: BootRequest[] = []; let fail = false;
    const secrets: Config["secrets"] = [
      { env: "LITERAL", allowHosts: ["api.example"], textValue: "literal-private" },
      { env: "ENV", allowHosts: ["api.example"], hostEnv: "HOST_VARIABLE_PRIVATE" },
      { env: "CMD", allowHosts: ["api.example"], hostCmd: "host-command-private" },
    ];
    const initial = request({ config: config({ secrets }) });
    const manager = createSandboxManager(depsFor(events, {
      inspectSandbox: async () => inspectedStatus ? { name: fixtureSandboxNameFor(sessionId), status: inspectedStatus, labels: labels(initial) } : null,
      adopted: (value) => { assert.equal(manager.getState().status, "active"); adopted.push(value); events.push("adopted"); },
      prepareRuntime: async () => { if (fail) throw new Error("preparation failed"); return { docker: { mode: "disabled", readiness: "disabled" } }; },
    }));
    await manager.boot(initial); assert.equal(adopted.length, 1); assert.ok(events.indexOf("persist") < events.indexOf("adopted"));
    assert.equal(adopted[0], initial);
    assert.deepEqual(adopted[0].config.secrets, secrets); // parent projection needs each original source kind
    await manager.boot(initial); assert.equal(adopted.length, 1); // unchanged request keeps original provenance
    const live = request({ config: config({ secrets, showFooter: false }) }); await manager.boot(live); assert.equal(adopted.length, 2); assert.equal(adopted[1], live);
    assert.deepEqual(adopted[1].config.secrets, secrets);
    fail = true; await manager.boot(request({ config: config({ cpus: 2 }), forceRecreate: true })); assert.equal(manager.getState().status, "unavailable"); assert.equal(adopted.length, 2);
    await manager.shutdown();
  }
});

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
    const inspected: InspectedSandbox = { name: fixtureSandboxNameFor(req.sessionId), status, labels: labels(req) };
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
    name: fixtureSandboxNameFor(sessionId), image: req.config.image, cwd, root: workspace.guestRoot,
  });
  assert.deepEqual(persisted, {
    version: STATE_SCHEMA_VERSION,
    sessionId,
    sandboxName: fixtureSandboxNameFor(sessionId),
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
    name: fixtureSandboxNameFor(sessionId), status: "running",
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
      inspectSandbox: async () => ({ name: fixtureSandboxNameFor(sessionId), status: "running", labels: { ...labels(req), [field]: "changed" } }),
    }));
    assert.equal((await manager.boot(req)).status, "active");
    assert.ok(events.indexOf("stop-remove") < events.indexOf("create"));
    await manager.shutdown();
  }

  const events: string[] = [];
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => ({ name: fixtureSandboxNameFor(sessionId), status: "running", labels: { ...labels(), "pi-msb.session": "another" } }),
  }));
  assert.equal((await manager.boot(request())).status, "unavailable");
  assert.equal(events.includes("stop-remove"), false);
  assert.equal(events.includes("create"), false);
});

test("an active wider-root workspace cannot be reused or live-adopted when narrowing to cwd", async () => {
  for (const liveChange of [false, true]) {
    const events: string[] = [];
    const adopted: Array<{ request: BootRequest; verification: string }> = [];
    const wider = request({ workspace: { hostRoot: "/canonical/project", guestRoot: "/tmp/project", cwd } });
    let inspected: InspectedSandbox | null = null;
    const manager = createSandboxManager(depsFor(events, {
      inspectSandbox: async () => inspected,
      createSandbox: async (req) => {
        events.push("create");
        inspected = { name: fixtureSandboxNameFor(sessionId), status: "running", labels: labels(req) };
        return {};
      },
      stopAndRemove: async () => { events.push("stop-remove"); inspected = null; },
      adopted: (request, verification) => adopted.push({ request, verification }),
    }));
    assert.equal((await manager.boot(wider)).status, "active");
    events.length = 0;
    adopted.length = 0;
    const narrowed = request({ config: config(liveChange ? { showFooter: false } : {}) });
    assert.equal((await manager.boot(narrowed)).status, "active");
    assert.ok(events.indexOf("stop-remove") < events.indexOf("create"));
    assert.equal(events.includes("create"), true);
    assert.equal(events.includes("connect"), false);
    assert.equal(events.includes("start"), false);
    assert.deepEqual(adopted, [{ request: narrowed, verification: "created" }]);
    assert.equal(manager.getState().info?.root, cwd);
    await manager.shutdown();
  }
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
        const record = { name: fixtureSandboxNameFor(sessionId), status: "running", labels: labels(req) };
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
  let created = false;
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => created ? { name: fixtureSandboxNameFor(sessionId), status: "running", labels: labels() } : null,
    createSandbox: async () => { created = true; return {}; },
    createTransport: () => transport(() => { disposed++; }),
    prepareRuntime: async () => { throw new Error("bootstrap failed"); },
  }));
  const result = await manager.boot(request({ config: config({ fallbackMode: "host" }) }));
  assert.equal(result.status, "host-fallback");
  assert.match(result.reason ?? "", /bootstrap failed/);
  assert.equal(disposed, 1);
  assert.ok(events.includes("stop-remove"));
  assert.ok(events.indexOf("stop-remove") < events.indexOf("release"));
});

test("a valid running transport is reused without reconnect or disposal", async () => {
  const events: string[] = [];
  let disposed = 0;
  const req = request();
  const inspected = { name: fixtureSandboxNameFor(sessionId), status: "running", labels: labels(req) };
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
    inspectSandbox: async () => inspections++ === 0 ? null : { name: fixtureSandboxNameFor(sessionId), status: "stopped", labels: labels(req) },
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
    inspectSandbox: async () => inspections++ === 0 ? null : { name: fixtureSandboxNameFor(sessionId), status: "running", labels: labels(req) },
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
    inspectSandbox: async () => inspections++ === 0 ? null : { name: fixtureSandboxNameFor(sessionId), status: "stopped", labels: labels(req) },
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

test("failed preflight retires its transport and lock before a replacement boot can acquire ownership", async () => {
  const req = request();
  const disposing = deferred();
  const finishDisposal = deferred();
  const releases: number[] = [];
  const disposals: number[] = [];
  let acquisitions = 0;
  let transports = 0;
  let inspections = 0;
  const manager = createSandboxManager(depsFor([], {
    acquireOwnerLock: async () => {
      const generation = ++acquisitions;
      return { path: `/tmp/owner-${generation}.lock`, release: async () => { releases.push(generation); } };
    },
    inspectSandbox: async () => ++inspections <= 3 ? null : {
      name: fixtureSandboxNameFor(sessionId), status: "running", labels: labels(req),
    },
    createTransport: () => {
      const generation = ++transports;
      return {
        ...transport(),
        dispose: async () => {
          disposals.push(generation);
          if (generation === 1) {
            disposing.resolve();
            await finishDisposal.promise;
          }
        },
      };
    },
  }));
  await manager.boot(req);
  const failed = assert.rejects(manager.withRuntime(async () => assert.fail("failed preflight must not execute")), /is unavailable/);
  await disposing.promise;
  const replacement = manager.boot({ ...req, forceRecreate: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const acquisitionsDuringDisposal = acquisitions;
  finishDisposal.resolve();
  await failed;
  assert.equal((await replacement).status, "active");
  assert.equal(acquisitionsDuringDisposal, 1, "replacement must wait for failed-generation retirement");
  assert.deepEqual(releases, [1], "old cleanup must release only the old owner lock");
  assert.deepEqual(disposals, [1], "replacement transport must remain owned and usable");
  await manager.withRuntime(async () => undefined);
  assert.equal(manager.getState().status, "active");
  await manager.shutdown();
  assert.deepEqual(releases, [1, 2]);
  assert.deepEqual(disposals, [1, 2]);
});

test("failed preflight drains active callbacks without activating queued reservations or retrying them", async () => {
  const req = request();
  const callbackStarted = deferred();
  const finishCallback = deferred();
  const inspectionStarted = deferred();
  const failInspection = deferred();
  let inspections = 0;
  let callbacks = 0;
  let disposed = 0;
  const events: string[] = [];
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => {
      const inspection = ++inspections;
      if (inspection === 1) return null;
      if (inspection === 3) {
        inspectionStarted.resolve();
        await failInspection.promise;
        return null;
      }
      return { name: fixtureSandboxNameFor(sessionId), status: "running", labels: labels(req) };
    },
    createTransport: () => transport(() => { disposed++; }),
  }));
  await manager.boot(req);
  const active = manager.withRuntime(async () => {
    callbacks++;
    callbackStarted.resolve();
    await finishCallback.promise;
    assert.equal(disposed, 0, "active callback retains its transport until it finishes");
    assert.equal(events.includes("release"), false);
  });
  await callbackStarted.promise;
  const failed = assert.rejects(manager.withRuntime(async () => { callbacks++; }), /is unavailable/);
  await inspectionStarted.promise;
  // Observe both outcomes immediately so the deliberately broken version does
  // not produce an unhandled rejection while the active callback is draining.
  const queued = manager.withRuntime(async () => { callbacks++; }).then(
    () => null,
    (error: unknown) => error,
  );
  failInspection.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const inspectionsDuringDrain = inspections;
  const callbacksDuringDrain = callbacks;
  finishCallback.resolve();
  await Promise.all([active, failed]);
  const queuedError = await queued;
  assert.equal(inspectionsDuringDrain, 3, "queued preflight must not inspect the failed generation");
  assert.equal(callbacksDuringDrain, 1, "pending reservations must not become active during retirement");
  assert.ok(queuedError instanceof Error);
  assert.match(queuedError.message, /sandbox is not available/);
  assert.equal(callbacks, 1);
  assert.equal(disposed, 1);
  assert.equal(events.filter((event) => event === "release").length, 1);
  assert.equal(manager.getState().status, "unavailable");
});

for (const timing of ["during retirement", "queued before failure"] as const) {
  for (const fallbackMode of ["block", "host"] as const) {
    test(`callback reentry ${timing} rejects without blocking retirement (${fallbackMode})`, { timeout: 5000 }, async () => {
      const req = request({ config: config({ fallbackMode }) });
      const callbackStarted = deferred();
      const enterReentry = deferred();
      const reentryQueued = deferred();
      const abortReentry = deferred();
      const inspectionStarted = deferred();
      const failInspection = deferred();
      const events: string[] = [];
      const tasks: Promise<unknown>[] = [];
      let inspections = 0;
      let disposed = 0;
      let nestedCallbacks = 0;
      let nestedError: unknown;
      const manager = createSandboxManager(depsFor(events, {
        inspectSandbox: async () => {
          const inspection = ++inspections;
          if (inspection === 1) return null;
          if (inspection === 3) {
            inspectionStarted.resolve();
            await failInspection.promise;
            return null;
          }
          return { name: fixtureSandboxNameFor(sessionId), status: "running", labels: labels(req) };
        },
        createTransport: () => transport(() => { disposed++; }),
      }));
      try {
        await bounded(manager.boot(req));
        const active = manager.withRuntime(async () => {
          callbackStarted.resolve();
          await enterReentry.promise;
          const nested = manager.withRuntime(async () => { nestedCallbacks++; }).then(
            () => null,
            (error: unknown) => error,
          );
          tasks.push(nested);
          reentryQueued.resolve();
          // The escape gate is used only by finally, so even a deadlocked
          // implementation cannot strand this callback or the test runner.
          nestedError = await Promise.race([nested, abortReentry.promise]);
          assert.equal(disposed, 0, "retirement must preserve the active callback's transport");
          assert.equal(events.includes("release"), false);
        }).then(() => null, (error: unknown) => error);
        tasks.push(active);
        await bounded(callbackStarted.promise);
        const failed = manager.withRuntime(async () => assert.fail("failed preflight must not execute")).then(
          () => null,
          (error: unknown) => error,
        );
        tasks.push(failed);
        await bounded(inspectionStarted.promise);
        if (timing === "queued before failure") {
          enterReentry.resolve();
          await bounded(reentryQueued.promise);
        }
        failInspection.resolve();
        // In the other ordering, let B reach failure draining before A reenters.
        await new Promise<void>((resolve) => setImmediate(resolve));
        enterReentry.resolve();
        const [activeError, failedError] = await bounded(Promise.all([active, failed]));
        assert.equal(activeError, null);
        assert.ok(failedError instanceof Error);
        assert.match(failedError.message, /is unavailable/);
        assert.ok(nestedError instanceof Error);
        assert.match(nestedError.message, /sandbox is not available/);
        assert.equal(nestedCallbacks, 0);
        assert.equal(inspections, 3, "reentry must not inspect or retry the failed generation");
        assert.equal(disposed, 1);
        assert.equal(events.filter((event) => event === "release").length, 1);
        assert.equal(manager.getState().status, fallbackMode === "host" ? "host-fallback" : "unavailable");
      } finally {
        enterReentry.resolve();
        failInspection.resolve();
        abortReentry.resolve();
        await bounded(Promise.allSettled(tasks));
        await bounded(manager.shutdown());
      }
    });
  }
}

test("shutdown waits for failed-generation disposal without mutating a retired owner's sandbox", { timeout: 5000 }, async () => {
  const disposing = deferred();
  const finishDisposal = deferred();
  const events: string[] = [];
  const manager = createSandboxManager(depsFor(events, {
    createTransport: () => ({
      ...transport(),
      dispose: async () => {
        disposing.resolve();
        await finishDisposal.promise;
        events.push("disposed");
      },
    }),
  }));
  const tasks: Promise<unknown>[] = [];
  try {
    await bounded(manager.boot(request()));
    const failed = assert.rejects(manager.withRuntime(async () => assert.fail("must not execute")), /is unavailable/);
    tasks.push(failed);
    await bounded(disposing.promise);
    const shutdown = manager.shutdown();
    tasks.push(shutdown);
    // A later rejected preflight must not wait for even transport disposal.
    await bounded(assert.rejects(manager.withRuntime(async () => assert.fail("must not execute")), /sandbox is not available/));
    assert.equal(events.includes("stop-remove"), false);
    assert.equal(events.includes("release"), false);
    finishDisposal.resolve();
    await bounded(Promise.all(tasks));
    assert.ok(events.indexOf("disposed") < events.indexOf("release"));
    assert.equal(events.includes("stop-remove"), false, "shutdown must not remove a resource after releasing its owner lock");
    assert.equal(events.filter((event) => event === "release").length, 1);
    assert.equal(manager.getState().status, "disabled");
  } finally {
    finishDisposal.resolve();
    await bounded(Promise.allSettled(tasks));
    await bounded(manager.shutdown());
  }
});

for (const action of ["shutdown", "disable", "busy reboot then shutdown"] as const) test(`retired ${action} cannot remove another manager's sandbox`, async () => {
  const req = request();
  let heldBy: string | undefined;
  let present = false;
  let failedInspection = false;
  const removals: string[] = [];
  const releases: string[] = [];
  const deps = (id: string): SandboxManagerDeps => depsFor([], {
    acquireOwnerLock: async () => {
      if (heldBy) return null;
      heldBy = id;
      return { path: "/tmp/shared-owner.lock", release: async () => {
        releases.push(id);
        assert.equal(heldBy, id, "only the current lock owner may release");
        heldBy = undefined;
      } };
    },
    inspectSandbox: async () => {
      if (id === "A" && failedInspection) throw new Error("inspection unavailable");
      return present ? { name: fixtureSandboxNameFor(sessionId), status: "running", labels: labels(req) } : null;
    },
    createSandbox: async () => { present = true; return {}; },
    stopAndRemove: async () => {
      removals.push(id);
      assert.equal(heldBy, id, "resource mutation requires the owner lock");
      present = false;
    },
  });
  const first = createSandboxManager(deps("A"));
  const contender = createSandboxManager(deps("B"));
  try {
    assert.equal((await first.boot(req)).status, "active");
    failedInspection = true;
    await assert.rejects(first.withRuntime(async () => assert.fail("must not execute")), /inspection unavailable/);
    assert.equal(heldBy, undefined);
    assert.equal((await contender.boot(req)).status, "active");
    if (action === "busy reboot then shutdown") assert.equal((await first.boot(req)).status, "unavailable");
    if (action === "disable") await first.setEnabled(false);
    else await first.shutdown();
    assert.deepEqual(removals, []);
    assert.deepEqual(releases, ["A"]);
    assert.equal(heldBy, "B");
    assert.equal(present, true);
    await contender.withRuntime(async () => undefined);
    assert.equal(contender.getState().status, "active");
    await contender.shutdown();
    assert.deepEqual(removals, ["B"]);
    assert.deepEqual(releases, ["A", "B"]);
  } finally {
    await first.shutdown();
    await contender.shutdown();
  }
});

test("preflight rejected during boot cannot retire resources owned by the in-progress boot", async () => {
  const preparing = deferred();
  const finishPreparation = deferred();
  const events: string[] = [];
  let disposed = 0;
  const manager = createSandboxManager(depsFor(events, {
    createTransport: () => transport(() => { disposed++; }),
    prepareRuntime: async () => {
      preparing.resolve();
      await finishPreparation.promise;
      return { docker: { mode: "disabled", readiness: "disabled" } };
    },
  }));
  const boot = manager.boot(request());
  await preparing.promise;
  await assert.rejects(manager.withRuntime(async () => assert.fail("boot is not ready")), /sandbox is not available/);
  const disposalsDuringBoot = disposed;
  const releasesDuringBoot = events.filter((event) => event === "release").length;
  finishPreparation.resolve();
  assert.equal((await boot).status, "active");
  assert.equal(disposalsDuringBoot, 0);
  assert.equal(releasesDuringBoot, 0);
  await manager.shutdown();
  assert.equal(disposed, 1);
  assert.equal(events.filter((event) => event === "release").length, 1);
});

test("running callbacks remain concurrent outside the preflight transition queue", async () => {
  const req = request();
  const finishCallbacks = deferred();
  let callbacks = 0;
  const manager = createSandboxManager(depsFor([], {
    inspectSandbox: async () => ({ name: fixtureSandboxNameFor(sessionId), status: "running", labels: labels(req) }),
  }));
  await manager.boot(req);
  const run = () => manager.withRuntime(async () => { callbacks++; await finishCallbacks.promise; });
  const first = run();
  const second = run();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const concurrentCallbacks = callbacks;
  finishCallbacks.resolve();
  await Promise.all([first, second]);
  assert.equal(concurrentCallbacks, 2);
  await manager.shutdown();
});

test("reconnect failure switches to configured host fallback and releases the lock", async () => {
  const events: string[] = [];
  let inspections = 0;
  const req = request({ config: config({ fallbackMode: "host" }) });
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => inspections++ === 0 ? null : { name: fixtureSandboxNameFor(sessionId), status: "stopped", labels: labels(req) },
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

test("live routing/footer settings adopt without disposal; forced recreation never reconnects matching resource", async () => {
  const events: string[] = [];
  const req = request();
  let inspected: InspectedSandbox | null = null;
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => inspected,
    createSandbox: async () => { events.push("create"); inspected = { name: fixtureSandboxNameFor(req.sessionId), status: "running", labels: labels(req) }; return {}; },
  }));
  await manager.boot(req); events.length = 0;
  await manager.boot({ ...req, config: config({ showFooter: false }) });
  assert.equal(events.length, 0);
  await manager.boot({ ...req, forceRecreate: true, config: config({ cpus: 2 }) });
  assert.ok(events.includes("stop-remove")); assert.ok(events.includes("create")); assert.ok(!events.includes("connect"));
  assert.ok(events.indexOf("lock") < events.lastIndexOf("stop-remove"));
  await manager.shutdown();
});

test("passive refresh observes sleep and uncertainty without waking or changing execution eligibility", async () => {
  const events: string[] = [];
  const states: Array<{ status: string; observation?: string }> = [];
  const req = request();
  let inspected: InspectedSandbox | null = null;
  let inspectError = false;
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => {
      events.push("inspect");
      if (inspectError) throw new Error("private SDK error");
      return inspected;
    },
    onState: (state) => states.push(state),
  }));
  assert.equal((await manager.refreshState!()).status, "disabled");
  assert.equal(events.length, 0);
  await manager.boot(req);
  for (const [status, observation] of [["running", undefined], ["stopped", "asleep"], ["idle", "asleep"], ["sleeping", "asleep"], ["mystery", "unknown"], ["running", undefined]] as const) {
    inspected = { name: fixtureSandboxNameFor(sessionId), status, labels: labels(req) };
    events.length = 0;
    const refreshed = await manager.refreshState!();
    assert.equal(refreshed.status, "active");
    assert.equal(refreshed.observation, observation);
    assert.equal(manager.isActive(), true);
    assert.deepEqual(events, ["inspect"]);
  }
  for (const invalid of [null, { name: "wrong-name", status: "running", labels: labels(req) },
    { name: fixtureSandboxNameFor(sessionId), status: "running", labels: { ...labels(req), "pi-msb.root": "/changed" } }]) {
    inspected = invalid;
    assert.equal((await manager.refreshState!()).observation, "unknown");
  }
  inspectError = true;
  assert.equal((await manager.refreshState!()).observation, "unknown");
  assert.equal(manager.getState().reason, undefined, "passive errors must not leak SDK text");
  inspectError = false;
  inspected = { name: fixtureSandboxNameFor(sessionId), status: "stopped", labels: labels(req) };
  await manager.refreshState!();
  events.length = 0;
  await manager.withRuntime(async () => undefined);
  assert.ok(events.includes("start"));
  assert.equal(manager.getState().observation, undefined);
  assert.ok(states.some((state) => state.observation === "asleep"));
  assert.ok(states.some((state) => state.observation === "unknown"));
  assert.equal(states.at(-1)?.status, "active");
  await manager.shutdown();
});

test("runtime-down callbacks and failed preflight publish uncertainty, blocked state, and recovery", async () => {
  const states: Array<{ status: string; observation?: string }> = [];
  let missing = false;
  const manager = createSandboxManager(depsFor([], {
    inspectSandbox: async () => missing ? null : { name: fixtureSandboxNameFor(sessionId), status: "running", labels: labels() },
    onState: (state) => states.push(state),
  }));
  await manager.boot(request());
  await assert.rejects(manager.withRuntime(async () => { throw Object.assign(new Error("down"), { code: "SANDBOX_DOWN" }); }));
  assert.equal(states.at(-1)?.observation, "unknown");
  await manager.withRuntime(async () => undefined);
  assert.equal(states.at(-1)?.status, "active");
  assert.equal(states.at(-1)?.observation, undefined);
  missing = true;
  await assert.rejects(manager.withRuntime(async () => undefined));
  assert.equal(states.at(-1)?.status, "unavailable");
  missing = false;
  await manager.boot(request());
  assert.equal(states.at(-1)?.status, "active");
  await manager.shutdown();
});

test("passive inspection serializes with preflight and cannot publish after shutdown is requested", async () => {
  const entered = deferred(), release = deferred();
  let poll = false;
  const states: Array<{ status: string; observation?: string }> = [];
  const events: string[] = [];
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => {
      if (poll) {
        entered.resolve();
        await release.promise;
      }
      return { name: fixtureSandboxNameFor(sessionId), status: "running", labels: labels() };
    },
    onState: (state) => states.push(state),
  }));
  await manager.boot(request());
  poll = true;
  const observing = manager.refreshState!();
  await entered.promise;
  let used = false;
  const using = manager.withRuntime(async () => { used = true; });
  await Promise.resolve();
  assert.equal(used, false);
  const stopping = manager.shutdown();
  const before = states.length;
  release.resolve();
  await bounded(Promise.all([observing, using, stopping]));
  assert.equal(used, true);
  assert.deepEqual(states.slice(before).map((state) => state.status), ["active", "stopping", "disabled"], "only the queued preflight may publish active before teardown");
});

test("hung passive reads time out without overlapping polls or blocking shutdown; late results are ignored", async (t) => {
  const entered = deferred(), release = deferred();
  let poll = false, count = 0;
  const states: Array<{ status: string; observation?: string }> = [];
  const manager = createSandboxManager(depsFor([], {
    inspectSandbox: async () => {
      if (poll) { count++; entered.resolve(); await release.promise; }
      return { name: fixtureSandboxNameFor(sessionId), status: "running", labels: labels() };
    },
    onState: (state) => states.push(state),
  }));
  await manager.boot(request());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  poll = true;
  const observing = manager.refreshState!();
  await entered.promise;
  t.mock.timers.tick(2_000);
  assert.equal((await observing).observation, "unknown");
  assert.equal((await manager.refreshState!()).observation, "unknown");
  assert.equal(count, 1);
  await manager.shutdown();
  const before = states.length;
  release.resolve();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(states.length, before);
  assert.equal(manager.getState().status, "disabled");
});

test("throwing display observers cannot change lifecycle, tool execution or cleanup", async () => {
  const events: string[] = [];
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => ({ name: fixtureSandboxNameFor(sessionId), status: "running", labels: labels() }),
    onState: () => { throw new Error("UI failure"); },
  }));
  assert.equal((await manager.boot(request())).status, "active");
  await manager.refreshState!();
  assert.equal(await manager.withRuntime(async () => "executed"), "executed");
  await manager.shutdown();
  assert.equal(manager.getState().status, "disabled");
  assert.ok(events.includes("stop-remove"));
  assert.ok(events.includes("release"));
});

test("automatic Docker names are selected once and reused for boot, restart, off/on and resume", async (t) => {
  let draws = 0;
  t.mock.method(Math, "random", () => { draws++; return 0; });
  const name = `${left[0]}-${right[0]}`;
  const req = request({ config: config({ sandboxName: null }) });
  let saved: PersistedSandboxState | undefined;
  const names: string[] = [];
  const events: string[] = [];
  const deps = depsFor(events, {
    acquireOwnerLock: async (value, selected) => { assert.equal(value.sessionId, sessionId); names.push(selected); return owner(events); },
    createSandbox: async (_value, selected) => { names.push(selected); return {}; },
    persist: (value) => { saved = value; },
  });
  const manager = createSandboxManager(deps);
  assert.equal((await manager.boot(req)).info?.name, name);
  assert.equal((await manager.boot(req)).info?.name, name);
  assert.equal((await manager.boot({ ...req, forceRecreate: true })).info?.name, name);
  await manager.setEnabled(false);
  assert.equal((await manager.setEnabled(true)).info?.name, name);
  assert.equal(saved?.sandboxName, name);
  assert.equal(draws, 2, "the package draws one adjective and one surname only once");
  assert.ok(names.length >= 6);
  assert.ok(names.every((selected) => selected === name));
  await manager.shutdown();

  const resumed = createSandboxManager(depsFor([], {
    inspectSandbox: async (selected) => {
      assert.equal(selected, name);
      return { name, status: "running", labels: labels(req) };
    },
    createSandbox: async () => assert.fail("resume must reconnect"),
  }));
  assert.equal((await resumed.boot({ ...req, restored: saved })).info?.name, name);
  assert.equal(draws, 2, "a new manager uses persisted identity, not another random draw");
  await resumed.shutdown();
});

test("saved names are session-scoped; explicit names remain unchanged", async (t) => {
  t.mock.method(Math, "random", () => 0);
  const saved: PersistedSandboxState = {
    version: STATE_SCHEMA_VERSION, sessionId, sandboxName: "pi-msb-existing-saved-name",
    cwd, root: workspace.hostRoot, guestRoot: workspace.guestRoot,
    image: DEFAULT_CONFIG.image, enabled: true, createdAt: 1,
  };
  for (const [id, configured, expected] of [
    [sessionId, null, saved.sandboxName],
    ["another-session", null, `${left[0]}-${right[0]}`],
    [sessionId, "my-explicit-name", "my-explicit-name"],
  ] as const) {
    const manager = createSandboxManager(depsFor([]));
    const result = await manager.boot(request({ sessionId: id, config: config({ sandboxName: configured }), restored: saved }));
    assert.equal(result.info?.name, expected);
    await manager.shutdown();
  }
});

test("automatic name collision fails closed without creating, connecting or removing a foreign sandbox", async (t) => {
  t.mock.method(Math, "random", () => 0);
  const name = `${left[0]}-${right[0]}`;
  const events: string[] = [];
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async (selected) => {
      assert.equal(selected, name);
      return { name, status: "running", labels: { ...labels(), "pi-msb.session": "foreign-session" } };
    },
  }));
  const result = await manager.boot(request({ config: config({ sandboxName: null }) }));
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, `sandbox name conflict: ${name}`);
  assert.deepEqual(events, ["lock", "prune", "release"]);
  await manager.shutdown();
  assert.equal(events.includes("stop-remove"), false);
});

for (const foreign of [true, false]) test(`failed create cleanup verifies ownership under lock (foreign winner: ${foreign})`, async (t) => {
  t.mock.method(Math, "random", () => 0);
  const name = `${left[0]}-${right[0]}`;
  const events: string[] = [];
  let appeared = false;
  const req = request({ config: config({ sandboxName: null }) });
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async (selected) => {
      assert.equal(selected, name);
      events.push("inspect");
      return appeared ? { name, status: "running", labels: {
        ...labels(req), "pi-msb.session": foreign ? "foreign-session" : sessionId,
      } } : null;
    },
    createSandbox: async (_value, selected) => {
      assert.equal(selected, name);
      events.push("create");
      appeared = true;
      throw new Error("create rejected");
    },
  }));
  const result = await manager.boot(req);
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "create rejected");
  assert.deepEqual(events, ["lock", "prune", "inspect", "create", "inspect", ...(foreign ? [] : ["stop-remove"]), "release"]);
  await manager.shutdown();
  assert.equal(events.filter((event) => event === "stop-remove").length, foreign ? 0 : 1);
});

for (const naming of ["automatic", "restored", "explicit"] as const) test(`pendingName exposes the ${naming} selection through lock, create and preparation without verified info`, async (t) => {
  t.mock.method(Math, "random", () => 0);
  const expected = naming === "automatic" ? `${left[0]}-${right[0]}` : `${naming}-sandbox`;
  const req = request({ config: config({ sandboxName: naming === "explicit" ? expected : null }) });
  if (naming === "restored") req.restored = {
    version: STATE_SCHEMA_VERSION, sessionId, sandboxName: expected, cwd,
    root: workspace.hostRoot, guestRoot: workspace.guestRoot, image: req.config.image, enabled: true, createdAt: 1,
  };
  const locking = deferred(), locked = deferred(), creating = deferred(), created = deferred(), preparing = deferred(), prepared = deferred();
  const notifications: RuntimeState[] = [];
  const manager = createSandboxManager(depsFor([], {
    acquireOwnerLock: async (_request, name) => { assert.equal(name, expected); locking.resolve(); await locked.promise; return owner([]); },
    createSandbox: async (_request, name) => { assert.equal(name, expected); creating.resolve(); await created.promise; return {}; },
    prepareRuntime: async () => { preparing.resolve(); await prepared.promise; return { docker: { mode: "disabled", readiness: "disabled" } }; },
    onState: (state) => notifications.push(state),
  }));
  const boot = manager.boot(req);
  const assertPending = () => {
    assert.deepEqual(manager.getState(), { status: "booting", info: null, pendingName: expected });
    assert.deepEqual(notifications.at(-1), manager.getState());
    assert.equal(manager.isActive(), false);
  };
  await bounded(locking.promise); assertPending(); locked.resolve();
  await bounded(creating.promise); assertPending(); created.resolve();
  await bounded(preparing.promise); assertPending(); prepared.resolve();
  const active = await bounded(boot);
  assert.equal(active.info?.name, expected);
  assert.equal(active.pendingName, undefined);
  assert.equal(manager.getState().pendingName, undefined);
  await manager.shutdown();
  assert.equal(manager.getState().pendingName, undefined);
});

test("a rejected owner lock clears pendingName instead of advertising a live sandbox", async () => {
  const manager = createSandboxManager(depsFor([], { acquireOwnerLock: async () => null }));
  const result = await manager.boot(request());
  assert.equal(result.status, "unavailable");
  assert.equal(result.info, null);
  assert.equal(result.pendingName, undefined);
  assert.equal(manager.getState().pendingName, undefined);
});
