import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "./config.ts";
import { createMsbIntegration, type MicrosandboxModule } from "./control.ts";
import { sandboxNameFor, STATE_SCHEMA_VERSION, type Config, type ResolvedConfig } from "./types.ts";

function config(overrides: Partial<Config> = {}): Config {
  return {
    ...(structuredClone(DEFAULT_CONFIG) as Config),
    bootstrapTools: false,
    docker: { mode: "disabled", startupTimeoutMs: 15_000 },
    pruneOnStart: false,
    ...overrides,
  };
}

function resolved(value: Config): ResolvedConfig {
  return { config: value, provenance: {}, warnings: [] };
}

function notFound(): Error {
  return Object.assign(new Error("not found"), { code: "NOT_FOUND" });
}

function fakeSdk(calls: string[], initial?: { name: string; status: string; labels: Record<string, string> }): MicrosandboxModule {
  const sandboxes = new Map<string, any>();

  const rawSandbox = (name: string) => ({
    name,
    fs: () => ({
      read: async () => Buffer.alloc(0), write: async () => undefined, exists: async () => true,
      stat: async () => ({ kind: "directory", size: 0, mode: 0o755, readonly: false }), list: async () => [],
    }),
    execWith: async (command: string, configure: (builder: any) => void) => {
      const execution = { args: [] as string[], cwd: undefined as string | undefined, timeout: undefined as number | undefined };
      const builder: any = {
        args(value: string[]) { execution.args = value; return builder; },
        cwd(value: string) { execution.cwd = value; return builder; },
        timeout(value: number) { execution.timeout = value; return builder; },
      };
      configure(builder);
      calls.push(`exec:${command}:${JSON.stringify(execution.args)}`);
      return { stdoutBytes: () => Buffer.alloc(0), stderrBytes: () => Buffer.alloc(0), code: 0 };
    },
    execStreamWith: async () => ({ async *[Symbol.asyncIterator]() { yield { kind: "exited", code: 0 }; }, kill: async () => undefined }),
  });

  const makeHandle = (name: string, status: string, labels: Record<string, string>) => {
    const raw = rawSandbox(name);
    const handle: any = {
      name, status, createdAt: new Date(),
      config: () => ({ name, labels }),
      connect: async () => { calls.push(`connect:${name}`); return raw; },
      startDetached: async () => { calls.push(`start:${name}`); return raw; },
      stopWithTimeout: async () => { calls.push(`stop:${name}`); },
      waitUntilStopped: async () => ({ status: "stopped" }),
      remove: async () => { calls.push(`remove:${name}`); sandboxes.delete(name); },
      logs: async () => [],
    };
    sandboxes.set(name, handle);
    return handle;
  };
  if (initial) makeHandle(initial.name, initial.status, initial.labels);

  const Sandbox = {
    builder(name: string) {
      const metadata = { labels: {} as Record<string, string> };
      const builder: any = {
        image(value: string) { calls.push(`image:${value}`); return builder; },
        pullPolicy(value: string) { calls.push(`pull-policy:${value}`); return builder; },
        cpus(value: number) { calls.push(`cpus:${value}`); return builder; },
        memory(value: number) { calls.push(`memory:${value}`); return builder; },
        idleTimeout(value: number) { calls.push(`idle:${value}`); return builder; },
        detached(value: boolean) { calls.push(`detached:${value}`); return builder; },
        workdir(value: string) { calls.push(`workdir:${value}`); return builder; },
        labels(value: Record<string, string>) { metadata.labels = value; calls.push(`labels:${JSON.stringify(value)}`); return builder; },
        volume(guest: string, configure: (mount: any) => void) {
          calls.push(`volume:${guest}`);
          const mount: any = {
            bind(value: string) { calls.push(`bind:${value}`); return mount; },
            named(value: string) { calls.push(`named:${value}`); return mount; },
            tmpfs() { calls.push("tmpfs"); return mount; },
            readonly() { calls.push("readonly"); return mount; },
            noexec() { calls.push("noexec"); return mount; },
            nosuid() { calls.push("nosuid"); return mount; },
            nodev() { calls.push("nodev"); return mount; },
          };
          configure(mount);
          return builder;
        },
        disableNetwork() { calls.push("network:deny"); return builder; },
        network(configure: (network: any) => void) { const network = { policy: () => { calls.push("network:policy"); return network; } }; configure(network); return builder; },
        port(host: number, guest: number) { calls.push(`port:${host}:${guest}`); return builder; },
        portBind(bind: string, host: number, guest: number) { calls.push(`port-bind:${bind}:${host}:${guest}`); return builder; },
        envs() { return builder; },
        secret(configure: (secret: any) => void) {
          const secret: any = { env: () => secret, value: () => secret, requireTlsIdentity: () => secret, allowHost: () => secret, allowHostPattern: () => secret };
          configure(secret); return builder;
        },
        async create() {
          calls.push(`create:${name}`);
          makeHandle(name, "running", metadata.labels);
          return rawSandbox(name);
        },
      };
      return builder;
    },
    async get(name: string) { const handle = sandboxes.get(name); if (!handle) throw notFound(); return handle; },
    async listWith() { return { sandboxes: [], nextCursor: undefined }; },
  };
  return { Sandbox };
}

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pi-msb-${prefix}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function initRepo(repo: string): void {
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-c", "commit.gpgSign=false", "-C", repo, "commit", "--allow-empty", "-qm", "initial"]);
}

test("creates exactly one project bind plus configured extras and keeps the original workdir", async (t) => {
  const root = await temp(t, "mounts");
  const cwd = join(root, "plain", "nested");
  await mkdir(cwd, { recursive: true });
  const calls: string[] = [];
  const integration = createMsbIntegration({
    sessionId: "mount-session", cwd, configDirName: ".pi", sdkLoader: async () => fakeSdk(calls),
    acquireOwnerLock: async () => ({ path: join(root, "owner.lock"), release: async () => undefined }),
  });
  const state = await integration.configureSession({
    sessionId: "mount-session", cwd, projectTrusted: true,
    config: resolved(config({ mounts: [{ type: "tmpfs", guestPath: "/mnt/cache", readonly: false, options: [] }] })),
  });
  assert.equal(state.status, "active");
  assert.deepEqual(calls.filter((call) => call.startsWith("volume:")), [`volume:${cwd}`, "volume:/mnt/cache"]);
  assert.deepEqual(calls.filter((call) => call.startsWith("bind:")), [`bind:${await realpath(cwd)}`]);
  assert.ok(calls.includes("tmpfs"));
  assert.ok(calls.includes(`workdir:${cwd}`));
  await integration.manager.shutdown();
});

test("a Git subdirectory binds the canonical repository at the lexical root", async (t) => {
  const root = await temp(t, "git-mount");
  const repo = join(root, "repo");
  const nested = join(repo, "packages", "app");
  const alias = join(root, "alias");
  await mkdir(nested, { recursive: true });
  initRepo(repo);
  await symlink(repo, alias, "dir");
  const cwd = join(alias, "packages", "app");
  const calls: string[] = [];
  const integration = createMsbIntegration({
    sessionId: "git-session", cwd, configDirName: ".pi", sdkLoader: async () => fakeSdk(calls),
    acquireOwnerLock: async () => ({ path: join(root, "owner.lock"), release: async () => undefined }),
  });
  const state = await integration.configureSession({ sessionId: "git-session", cwd, projectTrusted: true, config: resolved(config()) });
  assert.equal(state.info?.cwd, cwd);
  assert.equal(state.info?.root, alias);
  assert.deepEqual(calls.filter((call) => call.startsWith("volume:")), [`volume:${alias}`]);
  assert.deepEqual(calls.filter((call) => call.startsWith("bind:")), [`bind:${await realpath(repo)}`]);
  assert.ok(calls.includes(`workdir:${cwd}`));
  await integration.manager.shutdown();
});

test("current labels and persisted state carry schema, session, image, cwd, and canonical root", async (t) => {
  const root = await temp(t, "identity");
  const calls: string[] = [];
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const sessionId = "identity-session";
  const integration = createMsbIntegration({
    sessionId, cwd: root, configDirName: ".pi", sdkLoader: async () => fakeSdk(calls),
    acquireOwnerLock: async () => ({ path: join(root, "owner.lock"), release: async () => undefined }),
    appendEntry: (customType, data) => { entries.push({ type: "custom", customType, data }); },
  });
  await integration.configureSession({ sessionId, cwd: root, projectTrusted: true, config: resolved(config()) });
  const labelsCall = calls.find((call) => call.startsWith("labels:"));
  const labels = JSON.parse(labelsCall!.slice("labels:".length));
  assert.equal(labels["pi-msb.schema"], String(STATE_SCHEMA_VERSION));
  assert.equal(labels["pi-msb.session"], sessionId);
  assert.equal(labels["pi-msb.cwd"], root);
  assert.equal(labels["pi-msb.root"], await realpath(root));
  assert.equal(labels["pi-msb.guest-root"], root);
  assert.equal(labels["pi-msb.image"], DEFAULT_CONFIG.image);
  assert.equal("pi-msb.mode" in labels, false);
  assert.equal("pi-msb.volume" in labels, false);
  assert.deepEqual(entries.at(-1)?.data, {
    version: STATE_SCHEMA_VERSION, sessionId, sandboxName: sandboxNameFor(sessionId), cwd: root,
    root: await realpath(root), guestRoot: root, image: DEFAULT_CONFIG.image, enabled: true,
    createdAt: (entries.at(-1)?.data as any).createdAt,
  });
  await integration.manager.shutdown();
});

test("unsafe workspace discovery fails closed before the SDK loads", async (t) => {
  const root = await temp(t, "unsafe");
  const repo = join(root, "repo");
  const nested = join(repo, "nested");
  const outside = join(root, "outside");
  const alias = join(outside, "alias");
  await mkdir(nested, { recursive: true });
  await mkdir(outside);
  initRepo(repo);
  await symlink(nested, alias, "dir");
  let loads = 0;
  const integration = createMsbIntegration({ sessionId: "unsafe", cwd: alias, configDirName: ".pi", sdkLoader: async () => { loads++; return fakeSdk([]); } });
  const state = await integration.configureSession({ sessionId: "unsafe", cwd: alias, projectTrusted: true });
  assert.equal(state.status, "unavailable");
  assert.match(state.reason ?? "", /cannot preserve|symlink topology/);
  assert.equal(loads, 0);
});

test("guest runtime probes do not require Git", async (t) => {
  const root = await temp(t, "guest-tools");
  const calls: string[] = [];
  const integration = createMsbIntegration({
    sessionId: "guest-tools", cwd: root, configDirName: ".pi", sdkLoader: async () => fakeSdk(calls),
    acquireOwnerLock: async () => ({ path: join(root, "owner.lock"), release: async () => undefined }),
  });
  assert.equal((await integration.configureSession({ sessionId: "guest-tools", cwd: root, projectTrusted: true, config: resolved(config()) })).status, "active");
  const guestExec = calls.filter((call) => call.startsWith("exec:"));
  assert.ok(guestExec.length > 0);
  assert.equal(guestExec.some((call) => /\"git\"/.test(call) || call.startsWith("exec:git:")), false);
  await integration.manager.shutdown();
});

test("persisted overrides containing removed workspace keys fail closed without SDK load", async (t) => {
  const root = await temp(t, "legacy-overrides");
  for (const key of ["mode", "clone_branch", "clone_depth", "shallow_archive", "volume_quota_mib"]) {
    let loads = 0;
    const integration = createMsbIntegration({
      sessionId: `legacy-${key}`, cwd: root, configDirName: ".pi",
      entries: () => [{ type: "custom", customType: "pi-msb.override", data: { key, value: "legacy" } }],
      sdkLoader: async () => { loads++; return fakeSdk([]); },
    });
    const state = await integration.configureSession({ sessionId: `legacy-${key}`, cwd: root, projectTrusted: true });
    assert.equal(state.status, "unavailable");
    assert.match(state.reason ?? "", /removed.*bind-mounts.*read\/write/);
    assert.equal(loads, 0);
  }
});

test("legacy same-session sandbox is removed and recreated, never reconnected", async (t) => {
  const root = await temp(t, "legacy-sandbox");
  const sessionId = "legacy-sandbox";
  const name = sandboxNameFor(sessionId);
  const calls: string[] = [];
  const sdk = fakeSdk(calls, {
    name, status: "running",
    labels: { "pi-msb.managed": "true", "pi-msb.schema": "1", "pi-msb.session": sessionId, "pi-msb.mode": "git", "pi-msb.volume": "pi-msb-vol-only-copy" },
  });
  const integration = createMsbIntegration({
    sessionId, cwd: root, configDirName: ".pi", sdkLoader: async () => sdk,
    acquireOwnerLock: async () => { calls.push("owner-lock"); return { path: join(root, "owner.lock"), release: async () => undefined }; },
  });
  assert.equal((await integration.configureSession({ sessionId, cwd: root, projectTrusted: true, config: resolved(config()) })).status, "active");
  assert.ok(calls.indexOf("owner-lock") < calls.indexOf(`stop:${name}`));
  assert.ok(calls.indexOf(`remove:${name}`) < calls.indexOf(`create:${name}`));
  assert.equal(calls.includes(`connect:${name}`), false);
  assert.equal(calls.some((call) => /Volume|volume-remove/.test(call)), false);
  await integration.manager.shutdown();
});

test("network and port behavior remains independent of workspace storage", async (t) => {
  const root = await temp(t, "network");
  const calls: string[] = [];
  const integration = createMsbIntegration({
    sessionId: "network", cwd: root, configDirName: ".pi", sdkLoader: async () => fakeSdk(calls),
    acquireOwnerLock: async () => ({ path: join(root, "owner.lock"), release: async () => undefined }),
  });
  const state = await integration.configureSession({
    sessionId: "network", cwd: root, projectTrusted: true,
    config: resolved(config({ network: { mode: "deny", allowHosts: [], allowDns: false, publishPorts: ["3000", "0.0.0.0:5000:50"] } })),
  });
  assert.equal(state.status, "active");
  assert.ok(calls.includes("network:deny"));
  assert.ok(calls.includes("port:3000:3000"));
  assert.ok(calls.includes("port-bind:0.0.0.0:5000:50"));
  await integration.manager.shutdown();
});
