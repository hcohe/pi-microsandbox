import assert from "node:assert/strict";
import test from "node:test";

import {
  createSandboxManager,
  type InspectedSandbox,
  type SandboxManagerDeps,
} from "./sandbox-manager.ts";
import {
  sandboxNameFor,
  type BootRequest,
  type Config,
  type LockHandle,
  type PreparedStorage,
  type RuntimeExecution,
  type SandboxTransport,
  type StoragePlan,
  type ToolOperations,
} from "./types.ts";

const cwd = "/tmp/pi-msb-project";
const sessionId = "session-manager-test";

function config(overrides: Partial<Config> = {}): Config {
  return {
    image: "ubuntu:24.04",
    bootstrapTools: false,
    cpus: 1,
    memoryMiB: 512,
    idleTimeoutSec: 600,
    stopTimeoutMs: 10,
    detached: true,
    replace: false,
    replaceTimeoutMs: 10,
    sandboxName: null,
    mode: "direct",
    cloneBranch: "current",
    cloneDepth: "unlimited",
    shallowArchive: false,
    volumeQuotaMiB: 1024,
    network: { mode: "default", allowHosts: [], allowDns: true, publishPorts: [] },
    secrets: [],
    mounts: [],
    blockThirdParty: true,
    routeTools: [],
    passThroughTools: [],
    allowHostExecution: true,
    allowSkillReads: true,
    fallbackMode: "block",
    exposeSessionEnvironment: false,
    hostEnv: [],
    autoStart: true,
    pruneOnStart: true,
    lockDir: "/tmp",
    hostRoAllowlist: [],
    ...overrides,
  };
}

function request(overrides: Partial<BootRequest> = {}): BootRequest {
  return {
    sessionId,
    cwd,
    config: config(),
    restored: null,
    ...overrides,
  };
}

function transport(onDispose?: () => void): SandboxTransport {
  return {
    readFile: async () => Buffer.from(""),
    writeFile: async () => undefined,
    exists: async () => true,
    stat: async () => ({ kind: "file", size: 0, mode: 0o644, readonly: false, modifiedAt: null }),
    list: async () => [],
    copyFromHost: async () => undefined,
    copyToHost: async () => undefined,
    exec: async () => ({ stdout: Buffer.from(""), stderr: Buffer.from(""), exitCode: 0 }),
    execStream: async () => ({ exitCode: 0 }),
    dispose: async () => {
      onDispose?.();
    },
  };
}

const operations = {} as ToolOperations;

function directPlan(): StoragePlan {
  return { kind: "direct-mount", hostPath: cwd, guestPath: cwd, workdir: cwd };
}

function prepared(plan = directPlan(), extras: Partial<PreparedStorage> = {}): PreparedStorage {
  return { plan, createdVolume: false, ...extras };
}

function lock(events: string[]): LockHandle {
  return {
    path: "/tmp/pi-msb.lock",
    release: async () => {
      events.push("release");
    },
  };
}

function labels(req = request(), plan = directPlan()): Record<string, string> {
  return {
    "pi-msb.managed": "true",
    "pi-msb.schema": "1",
    "pi-msb.session": req.sessionId,
    "pi-msb.mode": plan.kind === "direct-mount" ? "direct" : plan.kind === "none" ? "none" : "git",
    "pi-msb.cwd": req.cwd,
    "pi-msb.image": req.config.image,
  };
}

function depsFor(events: string[], overrides: Partial<SandboxManagerDeps> = {}): SandboxManagerDeps {
  const req = request();
  return {
    acquireOwnerLock: async () => {
      events.push("lock");
      return lock(events);
    },
    pruneOthers: async () => {
      events.push("prune");
      return { inspected: 0, removed: [], kept: [], errors: [] };
    },
    detectGit: async () => {
      events.push("git");
      return { isGitRepo: false, repoRoot: null, branch: null, headSha: null, unborn: false, isLinkedWorktree: false };
    },
    buildStoragePlan: () => {
      events.push("plan");
      return directPlan();
    },
    prepareStorage: async (plan) => {
      events.push("prepare");
      return prepared(plan);
    },
    inspectSandbox: async () => {
      events.push("inspect");
      return null;
    },
    connectSandbox: async () => {
      events.push("connect");
      return {};
    },
    startSandbox: async () => {
      events.push("start");
      return {};
    },
    createSandbox: async () => {
      events.push("create");
      return {};
    },
    stopAndRemove: async () => {
      events.push("stop-remove");
    },
    createTransport: () => {
      events.push("transport");
      return transport();
    },
    createOperations: () => {
      events.push("operations");
      return operations;
    },
    probeAndBootstrap: async () => {
      events.push("probe");
    },
    seed: async () => {
      events.push("seed");
      return { headSha: null };
    },
    persist: () => {
      events.push("persist");
    },
    now: () => 1234,
    ...overrides,
  };
}

test("acquires the owner lock before every resource mutation", async () => {
  const events: string[] = [];
  const manager = createSandboxManager(depsFor(events));

  const result = await manager.boot(request());
  assert.equal(result.status, "active");
  assert.deepEqual(events.slice(0, 9), [
    "lock", "prune", "git", "plan", "prepare", "inspect", "create", "transport", "operations",
  ]);
  assert.ok(events.indexOf("lock") < events.indexOf("create"));
  assert.ok(events.indexOf("lock") < events.indexOf("prepare"));

  await manager.shutdown();
  assert.deepEqual(events.slice(-2), ["stop-remove", "release"]);
});

test("a duplicate live session fails closed without touching storage or SDK", async () => {
  const events: string[] = [];
  const deps = depsFor(events, {
    acquireOwnerLock: async () => {
      events.push("lock");
      return null;
    },
  });
  const manager = createSandboxManager(deps);

  const result = await manager.boot(request());
  assert.equal(result.status, "unavailable");
  assert.deepEqual(events, ["lock"]);
});

test("connects matching running sandboxes and starts matching stopped sandboxes", async () => {
  for (const status of ["running", "stopped"] as const) {
    const events: string[] = [];
    const req = request();
    const inspected: InspectedSandbox = {
      name: sandboxNameFor(req.sessionId),
      status,
      labels: labels(req),
    };
    const manager = createSandboxManager(depsFor(events, {
      inspectSandbox: async () => inspected,
    }));

    const result = await manager.boot(req);
    assert.equal(result.status, "active");
    assert.equal(events.includes(status === "running" ? "connect" : "start"), true);
    assert.equal(events.includes("create"), false);
    await manager.shutdown();
  }
});

test("boot failure disposes, cleans the bundle, and never removes a volume", async () => {
  const events: string[] = [];
  const bundle = {
    hostPath: "/tmp/bundle",
    branch: "main",
    headSha: "abc",
    cleanup: async () => {
      events.push("bundle-cleanup");
    },
  };
  const plan: StoragePlan = {
    kind: "git-volume",
    sessionId,
    volumeName: "pi-msb-vol-test",
    volumeQuotaMiB: 1,
    repoRoot: "/repo",
    mountGuestPath: "/repo",
    workdir: cwd,
    branch: "main",
    headSha: "abc",
    unborn: false,
    depth: "unlimited",
    seedRequired: true,
  };
  const deps = depsFor(events, {
    buildStoragePlan: () => plan,
    prepareStorage: async () => ({
      plan,
      createdVolume: true,
      bundle,
      volume: { name: plan.volumeName, hostPath: "/vol", labels: {} },
    }),
    probeAndBootstrap: async () => {
      events.push("probe");
      throw new Error("bootstrap failed");
    },
  });
  const manager = createSandboxManager(deps);

  const result = await manager.boot(request({ config: config({ fallbackMode: "host" }) }));
  assert.equal(result.status, "host-fallback");
  assert.equal(events.includes("bundle-cleanup"), true);
  assert.equal(events.includes("stop-remove"), true);
  assert.equal(events.some((entry) => entry.toLowerCase().includes("volume")), false);
});

test("withRuntime wakes and swaps the transport without retrying the callback", async () => {
  const events: string[] = [];
  let inspectCount = 0;
  let calls = 0;
  const req = request();
  const inspected: InspectedSandbox = {
    name: sandboxNameFor(req.sessionId),
    status: "running",
    labels: labels(req),
  };
  const first = transport();
  const second = transport();
  const deps = depsFor(events, {
    createTransport: () => {
      events.push("transport");
      return inspectCount > 1 ? second : first;
    },
    inspectSandbox: async () => {
      inspectCount += 1;
      return { ...inspected, status: inspectCount === 1 ? "running" : "stopped" };
    },
  });
  const manager = createSandboxManager(deps);
  await manager.boot(req);

  await assert.rejects(
    manager.withRuntime(async () => {
      calls += 1;
      throw new Error("operation failed");
    }),
    /operation failed/,
  );
  assert.equal(calls, 1);
  assert.equal(events.includes("start"), true);
  await manager.shutdown();
});

test("keeps a valid running transport without reconnecting or disposing it", async () => {
  const events: string[] = [];
  let disposed = 0;
  const req = request();
  const inspected: InspectedSandbox = {
    name: sandboxNameFor(req.sessionId),
    status: "running",
    labels: labels(req),
  };
  const deps = depsFor(events, {
    inspectSandbox: async () => inspected,
    createTransport: () => {
      events.push("transport");
      return transport(() => {
        disposed += 1;
      });
    },
  });
  const manager = createSandboxManager(deps);
  await manager.boot(req);

  await manager.withRuntime(async (current) => {
    assert.equal(current.operations, operations);
  });
  assert.equal(events.filter((event) => event === "connect").length, 1);
  assert.equal(events.filter((event) => event === "transport").length, 1);
  assert.equal(disposed, 0);
  await manager.shutdown();
  assert.equal(disposed, 1);
});

test("waits for prior runtime users before replacing a stopped transport", async () => {
  const events: string[] = [];
  const req = request();
  let inspections = 0;
  let startCalls = 0;
  let disposed = 0;
  let firstCallbackStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    firstCallbackStarted = resolve;
  });
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => {
      inspections += 1;
      if (inspections === 1) return null;
      return {
        name: sandboxNameFor(req.sessionId),
        status: "stopped",
        labels: labels(req),
      };
    },
    startSandbox: async () => {
      startCalls += 1;
      events.push("start");
      return {};
    },
    createTransport: () => transport(() => {
      disposed += 1;
    }),
  }));
  await manager.boot(req);

  const first = manager.withRuntime(async () => {
    firstCallbackStarted();
    await firstRelease;
  });
  await firstStarted;
  const second = manager.withRuntime(async () => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(startCalls, 1);
  assert.equal(disposed, 1);

  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(startCalls, 2);
  assert.equal(disposed, 2);
  await manager.shutdown();
  assert.equal(disposed, 3);
});

test("rejects a sandbox name mismatch before waking", async () => {
  const events: string[] = [];
  const req = request();
  let inspections = 0;
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => {
      inspections += 1;
      if (inspections === 1) return null;
      return {
        name: "pi-msb-unexpected",
        status: "running",
        labels: labels(req),
      };
    },
  }));
  await manager.boot(req);
  await assert.rejects(manager.withRuntime(async () => undefined), /sandbox name mismatch/);
  assert.equal(manager.getState().status, "unavailable");
  assert.equal(events.filter((event) => event === "connect").length, 0);
  await manager.shutdown();
});

test("revalidates mode, cwd, image, and volume labels before wake", async () => {
  for (const [field, value] of [
    ["pi-msb.mode", "none"],
    ["pi-msb.cwd", "/different"],
    ["pi-msb.image", "other:image"],
    ["pi-msb.volume", "unexpected-volume"],
  ] as const) {
    const events: string[] = [];
    const req = request();
    let inspections = 0;
    const manager = createSandboxManager(depsFor(events, {
      inspectSandbox: async () => {
        inspections += 1;
        if (inspections === 1) return null;
        return {
          name: sandboxNameFor(req.sessionId),
          status: "running",
          labels: { ...labels(req), [field]: value },
        };
      },
    }));
    await manager.boot(req);
    await assert.rejects(manager.withRuntime(async () => undefined), /configuration changed/);
    assert.equal(manager.getState().status, "unavailable");
    assert.equal(events.includes("start"), false);
    assert.equal(events.filter((event) => event === "connect").length, 0);
    await manager.shutdown();
  }
});

test("rejects a changed explicit storage mode before waking", async () => {
  const events: string[] = [];
  const req = request();
  let inspections = 0;
  const inspected: InspectedSandbox = {
    name: sandboxNameFor(req.sessionId),
    status: "running",
    labels: labels(req),
  };
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => inspections++ === 0 ? null : inspected,
  }));
  await manager.boot(req);
  req.config.mode = "none";

  await assert.rejects(manager.withRuntime(async () => undefined), /configuration changed/);
  assert.equal(manager.getState().status, "unavailable");
  assert.equal(events.filter((event) => event === "connect").length, 0);
  await manager.shutdown();
});

test("uses host fallback when waking or reconnecting fails", async () => {
  const events: string[] = [];
  const req = request({ config: config({ fallbackMode: "host" }) });
  let inspections = 0;
  let bootConnect = true;
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => {
      inspections += 1;
      if (inspections === 1) return null;
      return {
        name: sandboxNameFor(req.sessionId),
        status: "stopped",
        labels: labels(req),
      };
    },
    startSandbox: async () => {
      events.push("start");
      return undefined;
    },
    connectSandbox: async () => {
      events.push("connect");
      if (!bootConnect) throw new Error("reconnect failed");
      return {};
    },
  }));
  await manager.boot(req);
  bootConnect = false;

  await assert.rejects(manager.withRuntime(async () => undefined), /reconnect failed/);
  assert.equal(manager.getState().status, "host-fallback");
  assert.equal(events.includes("release"), true);
  await manager.shutdown();
  assert.equal(events.includes("stop-remove"), true);
});

test("off retains state and on boots with the retained restore", async () => {
  const events: string[] = [];
  let restored: unknown;
  const manager = createSandboxManager(depsFor(events, {
    prepareStorage: async (plan, value) => {
      restored = value;
      return prepared(plan);
    },
  }));
  const req = request();
  await manager.boot(req);
  await manager.setEnabled(false);
  assert.equal(manager.getState().status, "off");
  await manager.setEnabled(true);
  assert.equal(manager.getState().status, "active");
  assert.equal((restored as { sessionId: string }).sessionId, sessionId);
  await manager.shutdown();
});

test("a conflicting sandbox name is never blindly replaced", async () => {
  const events: string[] = [];
  const req = request();
  const manager = createSandboxManager(depsFor(events, {
    inspectSandbox: async () => ({
      name: sandboxNameFor(req.sessionId),
      status: "running",
      labels: { "pi-msb.managed": "true", "pi-msb.schema": "1", "pi-msb.session": "another" },
    }),
  }));
  const result = await manager.boot(req);
  assert.equal(result.status, "unavailable");
  assert.equal(events.includes("stop-remove"), false);
  assert.equal(events.includes("create"), false);
});
