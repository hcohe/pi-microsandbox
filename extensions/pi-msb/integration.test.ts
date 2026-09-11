import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "./config.ts";
import { createMsbIntegration, type MicrosandboxModule } from "./control.ts";
import { buildVolumeLabels } from "./labels.ts";
import { volumeNameFor } from "./types.ts";
import type { Config, ResolvedConfig } from "./types.ts";

function resolved(config: Config): ResolvedConfig {
  return { config, provenance: {}, warnings: [] };
}

function fakeSdk(calls: string[], volumeHandle?: any): MicrosandboxModule {
  const sandboxes = new Map<string, any>();
  const builder = (name: string): any => {
    const config: any = { name, labels: {} };
    const b: any = {
      image(value: string) { calls.push(`image:${value}`); return b; },
      pullPolicy(value: string) { calls.push(`pull-policy:${value}`); return b; },
      cpus(value: number) { calls.push(`cpus:${value}`); return b; },
      memory(value: number) { calls.push(`memory:${value}`); return b; },
      idleTimeout(value: number) { calls.push(`idle:${value}`); return b; },
      detached(value: boolean) { calls.push(`detached:${value}`); return b; },
      workdir(value: string) { calls.push(`workdir:${value}`); return b; },
      labels(value: Record<string, string>) { config.labels = value; calls.push("labels"); return b; },
      volume(guest: string, configure: (mount: any) => any) { calls.push(`volume:${guest}`); configure({ named: (value: string) => { calls.push(`named:${value}`); return this; }, bind: (value: string) => { calls.push(`bind:${value}`); return this; }, tmpfs: () => this }); return b; },
      network(configure: (network: any) => any) { configure({ policy: () => undefined }); return b; },
      envs() { return b; },
      secret(configure: (secret: any) => any) { configure({ env: () => ({ value: () => ({ requireTlsIdentity: () => ({ allowHost: () => ({}) }) }) }) }); return b; },
      async create() {
        const raw: any = {
          name,
          fs: () => ({
            read: async () => Buffer.from(""), write: async () => undefined, exists: async () => true,
            stat: async () => ({ kind: "directory", size: 0, mode: 0o755, readonly: false }), list: async () => [],
            copyFromHost: async () => undefined, copyToHost: async () => undefined,
          }),
          execWith: async () => ({ stdoutBytes: () => Buffer.from(""), stderrBytes: () => Buffer.from(""), code: 0 }),
          execStreamWith: async () => ({ async *[Symbol.asyncIterator]() { yield { kind: "exited", code: 0 }; }, kill: async () => undefined }),
        };
        const handle: any = {
          name, status: "running", labels: config.labels, createdAt: new Date(),
          config: () => config,
          connect: async () => raw,
          startDetached: async () => raw,
          stopWithTimeout: async () => { calls.push("stop"); },
          waitUntilStopped: async () => ({ status: "stopped" }),
          remove: async () => { calls.push("remove"); sandboxes.delete(name); },
          logs: async () => [],
        };
        sandboxes.set(name, { raw, handle });
        return raw;
      },
    };
    return b;
  };
  return {
    Sandbox: {
      builder,
      get: async (name: string) => {
        const item = sandboxes.get(name);
        if (!item) { const error: any = new Error("not found"); error.code = "NOT_FOUND"; throw error; }
        return item.handle;
      },
      listWith: async () => ({ sandboxes: [], nextCursor: undefined }),
    },
    Volume: {
      list: async () => volumeHandle ? [volumeHandle] : [],
      get: async () => {
        if (volumeHandle) return volumeHandle;
        const error: any = new Error("not found");
        error.code = "NOT_FOUND";
        throw error;
      },
      remove: async (name: string) => { calls.push(`volume-remove:${name}`); },
    },
  };
}

test("extension integration keeps native SDK lazy and boots through the real adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-integration-"));
  try {
    const canonicalRoot = await realpath(root);
    let loads = 0;
    const calls: string[] = [];
    const config = { ...DEFAULT_CONFIG, lockDir: join(root, "locks"), mode: "direct", autoStart: true, bootstrapTools: false } as Config;
    const integration = createMsbIntegration({
      sessionId: "integration-session",
      cwd: root,
      configDirName: ".pi",
      sdkLoader: async () => { loads++; return fakeSdk(calls); },
      acquireOwnerLock: async () => ({ path: join(root, "owner.lock"), release: async () => undefined }),
    });
    assert.equal(loads, 0);
    const state = await integration.configureSession({
      sessionId: "integration-session",
      cwd: root,
      projectTrusted: true,
      config: resolved(config),
    });
    assert.equal(loads, 1);
    assert.equal(state.status, "active");
    assert.ok(calls.includes(`image:${DEFAULT_CONFIG.image}`));
    assert.ok(calls.includes("pull-policy:if-missing"));
    assert.ok(calls.includes("memory:512"));
    assert.ok(calls.includes(`bind:${canonicalRoot}`));
    assert.ok(calls.includes(`volume:${root}`));
    await integration.manager.shutdown();
    assert.ok(calls.includes("stop"));
    assert.ok(calls.includes("remove"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves lexical cwd while mounting git storage in the same namespace", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-msb-canonical-cwd-"));
  try {
    const repo = join(fixture, "repo");
    const subdir = join(repo, "packages", "app");
    const alias = join(fixture, "repo-alias");
    await mkdir(subdir, { recursive: true });
    await symlink(repo, alias, "dir");
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-c", "commit.gpgSign=false", "-C", repo, "commit", "--allow-empty", "-qm", "seed"]);
    const committedLink = join(repo, "linked-app");
    await symlink(join("packages", "app"), committedLink, "dir");
    execFileSync("git", ["-C", repo, "add", "linked-app"]);
    execFileSync("git", ["-c", "commit.gpgSign=false", "-C", repo, "commit", "-qm", "add committed symlink"]);
    const requestedCwd = join(alias, "packages", "app");
    const canonicalRepo = await realpath(repo);
    const canonicalCwd = await realpath(subdir);

    const directCalls: string[] = [];
    const direct = createMsbIntegration({
      sessionId: "canonical-direct",
      cwd: requestedCwd,
      configDirName: ".pi",
      sdkLoader: async () => fakeSdk(directCalls),
      acquireOwnerLock: async () => ({ path: join(fixture, "direct.lock"), release: async () => undefined }),
    });
    const directConfig = { ...DEFAULT_CONFIG, mode: "direct", autoStart: true, bootstrapTools: false } as Config;
    const directState = await direct.configureSession({ sessionId: "canonical-direct", cwd: requestedCwd, projectTrusted: true, config: resolved(directConfig) });
    assert.equal(directState.info?.cwd, requestedCwd);
    assert.ok(directCalls.includes(`bind:${canonicalCwd}`));
    assert.ok(directCalls.includes(`volume:${requestedCwd}`));
    assert.ok(directCalls.includes(`workdir:${requestedCwd}`));
    await direct.manager.shutdown();

    const gitSessionId = "canonical-git";
    const gitCalls: string[] = [];
    const volumeHandle = {
      name: volumeNameFor(gitSessionId),
      labels: { ...buildVolumeLabels({ sessionId: gitSessionId, cwd: requestedCwd }), "pi-msb.mode": "git" },
    };
    const git = createMsbIntegration({
      sessionId: gitSessionId,
      cwd: requestedCwd,
      configDirName: ".pi",
      sdkLoader: async () => fakeSdk(gitCalls, volumeHandle),
      acquireOwnerLock: async () => ({ path: join(fixture, "git.lock"), release: async () => undefined }),
    });
    const gitConfig = { ...DEFAULT_CONFIG, mode: "git", autoStart: true, bootstrapTools: false } as Config;
    const gitState = await git.configureSession({ sessionId: gitSessionId, cwd: requestedCwd, projectTrusted: true, config: resolved(gitConfig) });
    assert.notEqual(canonicalCwd, requestedCwd, "fixture must exercise a lexical/canonical mismatch");
    assert.notEqual(canonicalRepo, alias, "fixture must use a symlinked repository namespace");
    assert.equal(gitState.info?.cwd, requestedCwd);
    assert.ok(gitCalls.includes(`volume:${alias}`));
    assert.ok(gitCalls.includes(`workdir:${requestedCwd}`));
    await git.manager.shutdown();

    const linkedSessionId = "committed-symlink-git";
    const linkedCalls: string[] = [];
    const linkedVolume = {
      name: volumeNameFor(linkedSessionId),
      labels: { ...buildVolumeLabels({ sessionId: linkedSessionId, cwd: committedLink }), "pi-msb.mode": "git" },
    };
    const linked = createMsbIntegration({
      sessionId: linkedSessionId,
      cwd: committedLink,
      configDirName: ".pi",
      sdkLoader: async () => fakeSdk(linkedCalls, linkedVolume),
      acquireOwnerLock: async () => ({ path: join(fixture, "linked.lock"), release: async () => undefined }),
    });
    const linkedState = await linked.configureSession({ sessionId: linkedSessionId, cwd: committedLink, projectTrusted: true, config: resolved(gitConfig) });
    assert.equal(linkedState.status, "active");
    assert.ok(linkedCalls.includes(`volume:${repo}`));
    assert.ok(linkedCalls.includes(`workdir:${committedLink}`));
    await linked.manager.shutdown();

    await writeFile(join(repo, ".pi-msb.toml"), 'mode = "git"\nbootstrap_tools = false\n');
    const configuredSessionId = "canonical-project-config";
    const configuredCalls: string[] = [];
    const configuredVolume = {
      name: volumeNameFor(configuredSessionId),
      labels: { ...buildVolumeLabels({ sessionId: configuredSessionId, cwd: requestedCwd }), "pi-msb.mode": "git" },
    };
    const configured = createMsbIntegration({
      sessionId: configuredSessionId,
      cwd: requestedCwd,
      configDirName: ".pi",
      env: { HOME: join(fixture, "home"), XDG_CONFIG_HOME: join(fixture, "config") },
      sdkLoader: async () => fakeSdk(configuredCalls, configuredVolume),
      acquireOwnerLock: async () => ({ path: join(fixture, "configured.lock"), release: async () => undefined }),
    });
    const configuredState = await configured.configureSession({ sessionId: configuredSessionId, cwd: requestedCwd, projectTrusted: true });
    assert.equal(configuredState.status, "active");
    assert.equal(configured.control.getEffectiveConfig().config.mode, "git");
    assert.ok(configuredCalls.includes(`volume:${alias}`));
    await configured.manager.shutdown();
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("does not discover project config above an unrepresentable lexical Git root", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-msb-config-boundary-"));
  try {
    const repo = join(fixture, "repo");
    const subdir = join(repo, "subdir");
    const outside = join(fixture, "outside");
    const alias = join(outside, "subdir-alias");
    await mkdir(subdir, { recursive: true });
    await mkdir(outside);
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-c", "commit.gpgSign=false", "-C", repo, "commit", "--allow-empty", "-qm", "seed"]);
    await symlink(subdir, alias, "dir");
    await writeFile(join(outside, ".pi-msb.toml"), 'mode = "none"\n');

    const calls: string[] = [];
    const integration = createMsbIntegration({
      sessionId: "config-boundary",
      cwd: alias,
      configDirName: ".pi",
      env: { HOME: join(fixture, "home"), XDG_CONFIG_HOME: join(fixture, "config") },
      sdkLoader: async () => fakeSdk(calls),
      acquireOwnerLock: async () => ({ path: join(fixture, "owner.lock"), release: async () => undefined }),
    });
    const state = await integration.configureSession({ sessionId: "config-boundary", cwd: alias, projectTrusted: true });
    assert.equal(state.status, "active");
    assert.equal(integration.control.getEffectiveConfig().config.mode, DEFAULT_CONFIG.mode);
    assert.ok(calls.includes(`bind:${await realpath(subdir)}`));
    assert.ok(calls.includes(`volume:${alias}`));
    await integration.manager.shutdown();
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("invalid configuration is fail-closed without loading microsandbox", async () => {
  let loads = 0;
  const integration = createMsbIntegration({
    sessionId: "bad-config",
    cwd: "/tmp",
    configDirName: ".pi",
    env: { PI_MSB_CPUS: "0" },
    sdkLoader: async () => { loads++; return fakeSdk([]); },
  });
  const state = await integration.configureSession({
    sessionId: "bad-config",
    cwd: "/tmp",
    projectTrusted: true,
  });
  assert.equal(loads, 0);
  assert.equal(state.status, "unavailable");
  assert.match(integration.control.getState().reason ?? "", /cpus/i);
  await integration.control.setEnabled(true);
  assert.equal(loads, 0);
  assert.equal(integration.control.getState().status, "unavailable");
});

test("reuses a VolumeHandle without assuming its nonexistent path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-reuse-"));
  try {
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
    // This test commit is local fixture setup; do not inherit a developer's
    // global commit.gpgSign/SSH signing policy into the temporary repository.
    execFileSync("git", ["-c", "commit.gpgSign=false", "-C", root, "commit", "--allow-empty", "-qm", "seed"]);
    const sessionId = "reuse-session";
    const labels = { ...buildVolumeLabels({ sessionId, cwd: root }), "pi-msb.mode": "git" };
    const volumeHandle = { name: volumeNameFor(sessionId), labels, kind: "directory", usedBytes: 0, createdAt: new Date() };
    const integration = createMsbIntegration({
      sessionId,
      cwd: root,
      configDirName: ".pi",
      sdkLoader: async () => fakeSdk([], volumeHandle),
      acquireOwnerLock: async () => ({ path: join(root, "owner.lock"), release: async () => undefined }),
    });
    const config = { ...DEFAULT_CONFIG, lockDir: join(root, "locks"), mode: "git", autoStart: true, bootstrapTools: false } as Config;
    const state = await integration.configureSession({ sessionId, cwd: root, projectTrusted: true, config: resolved(config) });
    assert.equal(state.status, "active");
    assert.equal(state.info?.volumeName, volumeHandle.name);
    assert.equal(state.info?.volumeHostPath, undefined);
    await integration.manager.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("locks the labeled volume owner and rechecks mounts before removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-volume-"));
  try {
    const targetSessionId = "retained-volume-session";
    const name = volumeNameFor(targetSessionId);
    const volumeHandle = {
      name,
      path: join(root, "volume-data"),
      labels: { ...buildVolumeLabels({ sessionId: targetSessionId, cwd: root }), "pi-msb.mode": "git" },
      kind: "directory",
      usedBytes: 123,
      createdAt: new Date(),
    };
    const calls: string[] = [];
    const lockRequests: Array<{ sessionId: string; cwd: string; mode: string }> = [];
    const integration = createMsbIntegration({
      sessionId: "current-session",
      cwd: "/different/current/cwd",
      configDirName: ".pi",
      sdkLoader: async () => fakeSdk(calls, volumeHandle),
      acquireOwnerLock: async (request) => {
        calls.push("target-lock");
        lockRequests.push({ sessionId: request.sessionId, cwd: request.cwd, mode: request.config.mode });
        return { path: join(root, "owner.lock"), release: async () => { calls.push("target-unlock"); } };
      },
    });
    const listed = await integration.control.listVolumes();
    assert.equal(listed[0]?.hostPath, volumeHandle.path);
    await integration.control.removeVolume(name);
    assert.deepEqual(lockRequests, [{ sessionId: targetSessionId, cwd: root, mode: "git" }]);
    assert.ok(calls.includes(`volume-remove:${name}`));
    assert.ok(calls.indexOf("target-lock") < calls.indexOf(`volume-remove:${name}`));
    assert.ok(calls.indexOf(`volume-remove:${name}`) < calls.indexOf("target-unlock"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses incomplete volume identity before taking an owner lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-volume-identity-"));
  try {
    const targetSessionId = "identity-session";
    const name = volumeNameFor(targetSessionId);
    const labels = { ...buildVolumeLabels({ sessionId: targetSessionId, cwd: root }), "pi-msb.mode": "direct" };
    const calls: string[] = [];
    const integration = createMsbIntegration({
      sessionId: "current-session",
      cwd: root,
      configDirName: ".pi",
      sdkLoader: async () => fakeSdk(calls, { name, path: join(root, "volume-data"), labels }),
      acquireOwnerLock: async () => {
        calls.push("target-lock");
        return { path: join(root, "owner.lock"), release: async () => undefined };
      },
    });
    await assert.rejects(integration.control.removeVolume(name), /managed volume identity mismatch/);
    assert.equal(calls.includes("target-lock"), false);
    assert.equal(calls.includes(`volume-remove:${name}`), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revalidates the same complete volume identity after locking", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-volume-recheck-"));
  try {
    const targetSessionId = "identity-recheck-session";
    const name = volumeNameFor(targetSessionId);
    const initial = {
      name,
      labels: { ...buildVolumeLabels({ sessionId: targetSessionId, cwd: root }), "pi-msb.mode": "git" },
    };
    const changed = {
      name,
      labels: { ...buildVolumeLabels({ sessionId: targetSessionId, cwd: "/different/target/cwd" }), "pi-msb.mode": "git" },
    };
    const calls: string[] = [];
    const sdk = fakeSdk(calls, initial);
    let gets = 0;
    sdk.Volume.get = async () => (++gets === 1 ? initial : changed);
    const integration = createMsbIntegration({
      sessionId: "current-session",
      cwd: root,
      configDirName: ".pi",
      sdkLoader: async () => sdk,
      acquireOwnerLock: async () => {
        calls.push("target-lock");
        return { path: join(root, "owner.lock"), release: async () => { calls.push("target-unlock"); } };
      },
    });
    await assert.rejects(integration.control.removeVolume(name), /managed volume identity mismatch/);
    assert.deepEqual(calls.filter((call) => call.startsWith("target-")), ["target-lock", "target-unlock"]);
    assert.equal(calls.includes(`volume-remove:${name}`), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rechecks target mount state while holding the owner lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-volume-mounted-"));
  try {
    const targetSessionId = "mounted-session";
    const name = volumeNameFor(targetSessionId);
    const volumeHandle = {
      name,
      path: join(root, "volume-data"),
      labels: { ...buildVolumeLabels({ sessionId: targetSessionId, cwd: root }), "pi-msb.mode": "git" },
    };
    const calls: string[] = [];
    const sdk = fakeSdk(calls, volumeHandle);
    sdk.Sandbox.listWith = async () => {
      calls.push("sandbox-list");
      return { sandboxes: [{ name: "mounting-sandbox" }], nextCursor: undefined };
    };
    sdk.Sandbox.get = async () => ({
      name: "mounting-sandbox",
      status: "running",
      config: () => ({ mounts: [{ type: "Named", name }] }),
    });
    const integration = createMsbIntegration({
      sessionId: "current-session",
      cwd: root,
      configDirName: ".pi",
      sdkLoader: async () => sdk,
      acquireOwnerLock: async () => {
        calls.push("target-lock");
        return { path: join(root, "owner.lock"), release: async () => { calls.push("target-unlock"); } };
      },
    });
    await assert.rejects(integration.control.removeVolume(name), /mounted volume/);
    assert.ok(calls.indexOf("target-lock") < calls.indexOf("sandbox-list"));
    assert.ok(calls.includes("target-unlock"));
    assert.equal(calls.includes(`volume-remove:${name}`), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});