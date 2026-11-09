import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG, hostConfigTargets } from "./config.ts";
import { serializeRaw } from "./settings.ts";
import { fakeSdk } from "../../test/fake-msb-sdk.ts";
import { createMsbIntegration } from "./control.ts";
import { resourceId, STATE_SCHEMA_VERSION, type Config, type PersistedSandboxState, type ResolvedConfig, type RuntimeState } from "./types.ts";

const legacySandboxNameFor = (session: string): string => `pi-msb-${resourceId(session)}`;

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

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pi-msb-${prefix}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

for (const existing of ["missing-agent", "empty-agent", "empty-policy-directory", "empty-config", "user-config"] as const) {
  test(`enabled setup, reload and settings inspection never bootstrap global config: ${existing}`, async (t) => {
    const root = await temp(t, "lazy-config");
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const policyDir = join(agentDir, "pi-microsandbox");
    const file = join(policyDir, "default.toml");
    await mkdir(cwd);
    if (existing !== "missing-agent") await mkdir(agentDir);
    if (["empty-policy-directory", "empty-config", "user-config"].includes(existing)) await mkdir(policyDir);
    const text = existing === "empty-config" ? "" : existing === "user-config" ? "# user policy\ncpus = 3\n" : undefined;
    if (text !== undefined) await writeFile(file, text, { mode: 0o640 });
    const before = text === undefined ? undefined : await stat(file);
    const calls: string[] = [];
    const integration = createMsbIntegration({
      sessionId: "lazy-config", cwd, configDirName: ".pi", agentDir,
      env: { HOME: root, PI_MSB_BOOTSTRAP_TOOLS: "false", PI_MSB_PRUNE_ON_START: "false", PI_MSB_DOCKER__MODE: "disabled" },
      sdkLoader: async () => fakeSdk(calls),
      locksPort: { tryAcquire: async () => ({ path: "unused", release: async () => undefined }) },
      acquireOwnerLock: async () => ({ path: "unused", release: async () => undefined }),
    });
    t.after(() => integration.manager.shutdown());
    const assertUntouched = async () => {
      if (before) {
        assert.equal(await readFile(file, "utf8"), text);
        const after = await stat(file);
        for (const key of ["ino", "mode", "mtimeMs", "ctimeMs"] as const) assert.equal(after[key], before[key]);
      } else await assert.rejects(stat(file), { code: "ENOENT" });
      if (existing === "missing-agent") await assert.rejects(stat(agentDir), { code: "ENOENT" });
      if (["missing-agent", "empty-agent"].includes(existing)) await assert.rejects(stat(policyDir), { code: "ENOENT" });
    };
    for (let setup = 0; setup < 2; setup++) {
      assert.equal((await integration.configureSession({ sessionId: "lazy-config", cwd, projectTrusted: true })).status, "active");
      await assertUntouched();
      await integration.control.reload();
      assert.equal(integration.control.getState().status, "active");
      await assertUntouched();
      await integration.control.settings!.inspect();
      for (const scope of ["global", "project", "temporary"] as const) {
        const draft = await integration.control.settings!.open(scope);
        await draft.preview();
        draft.discard();
      }
      await assertUntouched();
    }
    assert.ok(calls.some((call) => call.startsWith("cpus:")), "must boot through the fake SDK, not skip setup");
  });
}

test("host policy survives local edits while temporary settings override it through reload and off/on", async (t) => {
  const root = await temp(t, "host-config");
  const cwd = join(root, "Code", "app");
  await mkdir(cwd, { recursive: true });
  initRepo(cwd);
  const agentDir = join(root, "agent");
  const defaultFile = join(agentDir, "pi-microsandbox", "default.toml");
  const targets = await hostConfigTargets({ cwd, agentDir, homedir: root, env: {}, projectTrusted: true, configDirName: ".pi" });
  const projectFile = targets.paths.project;
  await mkdir(dirname(projectFile), { recursive: true });
  await writeFile(defaultFile, `
bootstrap_tools = false
prune_on_start = false
fallback_mode = "block"
allow_host_execution = false
auto_start = true
cpus = 3
[docker]
mode = "disabled"
`);
  await writeFile(projectFile, serializeRaw({ _repository: targets.repository, cpus: 2, memory_mib: 2048 }));
  const calls: string[] = [];
  const integration = createMsbIntegration({
    sessionId: "host-policy", cwd, configDirName: ".pi", agentDir,
    env: { HOME: root, PI_MSB_FALLBACK_MODE: "host" },
    sdkLoader: async () => fakeSdk(calls),
    locksPort: { tryAcquire: async () => ({ path: "unused", release: async () => undefined }) },
    acquireOwnerLock: async () => ({ path: "unused", release: async () => undefined }),
  });
  t.after(() => integration.manager.shutdown());
  const state = await integration.configureSession({ sessionId: "host-policy", cwd, projectTrusted: true });
  assert.equal(state.status, "active");
  assert.ok(calls.includes("cpus:2"));
  assert.equal(integration.configRef.value.fallbackMode, "block");
  assert.equal(integration.configRef.value.allowHostExecution, false);
  await writeFile(join(cwd, ".pi-msb.toml"), 'cpus = 64\nauto_start = false\nfallback_mode = "host"\nallow_host_execution = true');
  await integration.control.reload();
  assert.equal(integration.control.getState().status, "active");
  assert.equal(integration.configRef.value.cpus, 2);
  assert.equal(integration.configRef.value.fallbackMode, "block");
  assert.equal(integration.configRef.value.allowHostExecution, false);
  await integration.control.setOverride("cpus", 64);
  assert.equal(integration.configRef.value.cpus, 64);
  await integration.control.setEnabled(false);
  await integration.control.setEnabled(true);
  assert.equal(integration.configRef.value.cpus, 64);
  await integration.control.resetOverrides();
  assert.equal(integration.configRef.value.cpus, 2);
  await rm(projectFile);
  await integration.control.reload();
  assert.equal(integration.configRef.value.cpus, 3);
  await writeFile(defaultFile, "cpus = 0");
  await assert.rejects(integration.control.reload(), /cpus/);
  assert.equal(integration.configRef.value.fallbackMode, "block");
});

function initRepo(repo: string): void {
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-c", "commit.gpgSign=false", "-C", repo, "commit", "--allow-empty", "-qm", "initial"]);
}

test("creates exactly one project bind plus configured extras and keeps the original workdir", async (t) => {
  const root = await temp(t, "mounts");
  const cwd = join(root, "plain", "nested");
  const extra = join(root, "extra");
  await mkdir(cwd, { recursive: true });
  await mkdir(extra);
  const calls: string[] = [];
  const integration = createMsbIntegration({
    sessionId: "mount-session", cwd, configDirName: ".pi", sdkLoader: async () => fakeSdk(calls),
    acquireOwnerLock: async () => ({ path: join(root, "owner.lock"), release: async () => undefined }),
  });
  const state = await integration.configureSession({
    sessionId: "mount-session", cwd, projectTrusted: true,
    config: resolved(config({ mounts: [
      { type: "tmpfs", guestPath: "/mnt/cache", readonly: false, options: [] },
      { type: "dir", hostPath: extra, guestPath: "/mnt/extra", readonly: true, options: ["noexec", "nosuid", "nodev"] },
    ] })),
  });
  assert.equal(state.status, "active");
  assert.deepEqual(calls.filter((call) => call.startsWith("volume:")), [`volume:${cwd}`, "volume:/mnt/cache", "volume:/mnt/extra"]);
  assert.deepEqual(calls.filter((call) => call.startsWith("bind:")), [`bind:${await realpath(cwd)}`, `bind:${extra}`]);
  for (const flag of ["tmpfs", "readonly", "noexec", "nosuid", "nodev"]) assert.ok(calls.includes(flag));
  assert.ok(calls.includes(`workdir:${cwd}`));
  await integration.manager.shutdown();
});

test("a Git subdirectory binds only canonical cwd at lexical cwd through a symlink", async (t) => {
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
  assert.equal(state.info?.root, cwd);
  assert.deepEqual(calls.filter((call) => call.startsWith("volume:")), [`volume:${cwd}`]);
  assert.deepEqual(calls.filter((call) => call.startsWith("bind:")), [`bind:${await realpath(nested)}`]);
  assert.ok(calls.includes(`workdir:${cwd}`));
  await integration.manager.shutdown();
});

for (const poisonedAtSetup of [false, true]) test(`Git config cannot widen SDK binds at setup/reload (initially poisoned: ${poisonedAtSetup})`, async (t) => {
  const root = await temp(t, "git-poison");
  const cwd = join(root, "repo");
  const agentDir = join(root, "agent");
  const defaultFile = join(agentDir, "pi-microsandbox", "default.toml");
  await mkdir(cwd);
  await mkdir(dirname(defaultFile), { recursive: true });
  initRepo(cwd);
  const poison = async () => {
    // .git/config is inside the read/write guest mount, unlike host policy.
    execFileSync("git", ["-C", cwd, "config", "core.worktree", root]);
    assert.equal(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(), await realpath(root));
  };
  if (poisonedAtSetup) await poison();
  const calls: string[] = [];
  const sdk = fakeSdk(calls);
  const integration = createMsbIntegration({
    sessionId: "git-poison", cwd, configDirName: ".pi", agentDir,
    env: { HOME: root, PI_MSB_BOOTSTRAP_TOOLS: "false", PI_MSB_PRUNE_ON_START: "false", PI_MSB_DOCKER__MODE: "disabled" },
    sdkLoader: async () => sdk,
    acquireOwnerLock: async () => ({ path: join(root, "owner.lock"), release: async () => undefined }),
  });
  t.after(() => integration.manager.shutdown());
  const assertBind = async () => {
    assert.equal(integration.control.getState().status, "active");
    assert.equal(integration.control.getState().info?.root, cwd);
    assert.deepEqual(calls.filter((call) => call.startsWith("volume:")), [`volume:${cwd}`]);
    assert.deepEqual(calls.filter((call) => call.startsWith("bind:")), [`bind:${await realpath(cwd)}`]);
    const labels = JSON.parse(calls.find((call) => call.startsWith("labels:"))!.slice("labels:".length));
    assert.equal(labels["pi-msb.root"], await realpath(cwd));
    assert.equal(labels["pi-msb.guest-root"], cwd);
    calls.length = 0;
  };
  await integration.configureSession({ sessionId: "git-poison", cwd, projectTrusted: true });
  await assertBind();
  await poison();
  await integration.control.reload();
  assert.equal(integration.control.getState().status, "active");
  assert.equal(calls.some((call) => /^(create|volume|bind):/.test(call)), false, "unchanged cwd/config may safely reuse the cwd-only runtime");
  calls.length = 0;
  // Force real builder execution on reload, not just the unchanged-request fast path.
  await writeFile(defaultFile, "cpus = 2\n");
  await integration.control.reload();
  await assertBind();
  await writeFile(join(cwd, ".git", "config"), "[invalid Git config\n");
  await writeFile(defaultFile, "cpus = 3\n");
  await integration.control.reload();
  await assertBind();
  await integration.control.setEnabled(false);
  await integration.control.setEnabled(true);
  await assertBind();
});

for (const status of ["running", "stopped"]) test(`a restored wider-root Git sandbox is replaced, never adopted (${status})`, async (t) => {
  const root = await temp(t, "wider-root");
  const repo = join(root, "repo");
  const cwd = join(repo, "packages", "app");
  await mkdir(cwd, { recursive: true });
  initRepo(repo);
  const sessionId = "wider-root";
  const name = legacySandboxNameFor(sessionId);
  const restored: PersistedSandboxState = {
    version: STATE_SCHEMA_VERSION, sessionId, sandboxName: name, cwd,
    root: await realpath(repo), guestRoot: repo, image: DEFAULT_CONFIG.image, enabled: true, createdAt: 1,
  };
  const calls: string[] = [];
  const sdk = fakeSdk(calls, { name, status, labels: {
    "pi-msb.managed": "true", "pi-msb.schema": String(STATE_SCHEMA_VERSION), "pi-msb.session": sessionId,
    "pi-msb.cwd": cwd, "pi-msb.root": restored.root, "pi-msb.guest-root": repo, "pi-msb.image": DEFAULT_CONFIG.image,
  } });
  const entries: any[] = [];
  const integration = createMsbIntegration({
    sessionId, cwd, configDirName: ".pi", sdkLoader: async () => sdk,
    acquireOwnerLock: async () => { calls.push("owner-lock"); return { path: join(root, "owner.lock"), release: async () => undefined }; },
    appendEntry: (_kind, data) => entries.push(data),
  });
  t.after(() => integration.manager.shutdown());
  assert.equal((await integration.configureSession({ sessionId, cwd, projectTrusted: true, config: resolved(config()), restored })).status, "active");
  assert.ok(calls.indexOf("owner-lock") < calls.indexOf(`remove:${name}`));
  assert.ok(calls.indexOf(`remove:${name}`) < calls.indexOf(`create:${name}`));
  assert.equal(calls.some((call) => /^(connect|start):/.test(call)), false);
  assert.deepEqual(calls.filter((call) => call.startsWith("volume:")), [`volume:${cwd}`]);
  assert.deepEqual(calls.filter((call) => call.startsWith("bind:")), [`bind:${await realpath(cwd)}`]);
  assert.equal(entries.at(-1).root, await realpath(cwd));
  assert.equal(entries.at(-1).guestRoot, cwd);
  assert.equal(integration.control.getRuntimePolicy!()?.verification, "created");
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
    version: STATE_SCHEMA_VERSION, sessionId, sandboxName: integration.control.getState().info!.name, cwd: root,
    root: await realpath(root), guestRoot: root, image: DEFAULT_CONFIG.image, enabled: true,
    createdAt: (entries.at(-1)?.data as any).createdAt,
  });
  await integration.manager.shutdown();
});

test("unsafe or missing cwd fails closed before the SDK loads", async (t) => {
  const root = await temp(t, "unsafe");
  for (const cwd of ["/", join(root, "missing")]) {
    let loads = 0;
    const integration = createMsbIntegration({ sessionId: "unsafe", cwd, configDirName: ".pi", sdkLoader: async () => { loads++; return fakeSdk([]); } });
    const state = await integration.configureSession({ sessionId: "unsafe", cwd, projectTrusted: true });
    assert.equal(state.status, "unavailable");
    assert.match(state.reason ?? "", /cannot safely be mounted|cannot be canonicalized/);
    assert.equal(loads, 0);
  }
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

test("historical persisted overrides are ignored and never resurrect temporary settings", async (t) => {
  const root = await temp(t, "legacy-overrides");
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  for (const key of ["mode", "clone_branch", "clone_depth", "shallow_archive", "volume_quota_mib"]) {
    let loads = 0;
    const integration = createMsbIntegration({
      sessionId: `legacy-${key}`, cwd, configDirName: ".pi", agentDir: join(root, "agent"),
      entries: () => [{ type: "custom", customType: "pi-msb.override", data: { key, value: "legacy" } }],
      sdkLoader: async () => { loads++; return fakeSdk([]); },
      acquireOwnerLock: async () => ({ path: join(root, "owner.lock"), release: async () => undefined }),
    });
    const state = await integration.configureSession({ sessionId: `legacy-${key}`, cwd, projectTrusted: true });
    t.after(() => integration.manager.shutdown());
    assert.equal(state.status, "active");
    assert.equal(loads, 1);
    assert.deepEqual(integration.control.settings?.temporary(), {});
  }
});

test("legacy same-session sandbox is removed and recreated, never reconnected", async (t) => {
  const root = await temp(t, "legacy-sandbox");
  const sessionId = "legacy-sandbox";
  const name = legacySandboxNameFor(sessionId);
  const calls: string[] = [];
  const sdk = fakeSdk(calls, {
    name, status: "running",
    labels: { "pi-msb.managed": "true", "pi-msb.schema": "1", "pi-msb.session": sessionId, "pi-msb.mode": "git", "pi-msb.volume": "pi-msb-vol-only-copy" },
  });
  const integration = createMsbIntegration({
    sessionId, cwd: root, configDirName: ".pi", sdkLoader: async () => sdk,
    acquireOwnerLock: async () => { calls.push("owner-lock"); return { path: join(root, "owner.lock"), release: async () => undefined }; },
  });
  assert.equal((await integration.configureSession({ sessionId, cwd: root, projectTrusted: true, config: resolved(config({ sandboxName: name })) })).status, "active");
  assert.ok(calls.indexOf("owner-lock") < calls.indexOf(`stop:${name}`));
  assert.ok(calls.indexOf(`remove:${name}`) < calls.indexOf(`create:${name}`));
  assert.equal(calls.includes(`connect:${name}`), false);
  assert.equal(calls.some((call) => /Volume|volume-remove/.test(call)), false);
  await integration.manager.shutdown();
});

test("session setup stays read-only when disabled or auto-start is off and ignores obsolete local policy", async (t) => {
  const root = await temp(t, "bootstrap-lifecycle");
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const file = join(agentDir, "pi-microsandbox/default.toml");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi-msb.toml"), 'mode = "git"\n[[malformed');
  await writeFile(join(cwd, ".pi/msb.toml"), 'cpus = 0\nfallback_mode = "host"');
  let loads = 0;
  const env = { PI_MSB_AUTO_START: "false", PI_MSB_CPUS: "3", PI_MSB_DISABLE: "1" };
  const integration = createMsbIntegration({
    sessionId: "bootstrap", cwd, agentDir, configDirName: ".pi", env,
    sdkLoader: async () => { loads++; return fakeSdk([]); },
  });
  await assert.rejects(stat(file), { code: "ENOENT" });
  assert.equal((await integration.configureSession({ sessionId: "bootstrap", cwd, projectTrusted: true })).status, "off");
  await assert.rejects(stat(file), { code: "ENOENT" });
  env.PI_MSB_DISABLE = "0";
  assert.equal((await integration.configureSession({ sessionId: "bootstrap", cwd, projectTrusted: true })).status, "off");
  await assert.rejects(stat(agentDir), { code: "ENOENT" });
  assert.equal(integration.configRef.value.cpus, 3);
  assert.equal(loads, 0);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "cpus = 2\n");
  await integration.control.reload();
  assert.equal(integration.configRef.value.cpus, 2);
  assert.equal(await readFile(file, "utf8"), "cpus = 2\n");
  await writeFile(file, "");
  await integration.configureSession({ sessionId: "bootstrap-next", cwd, projectTrusted: false });
  assert.equal(await readFile(file, "utf8"), "");
  assert.equal(integration.configRef.value.cpus, 3);
  assert.equal(loads, 0);
});

test("unsafe host config paths block setup and explicit on even when environment requests host fallback", async (t) => {
  const root = await temp(t, "bootstrap-failure");
  const cwd = join(root, "project");
  await mkdir(cwd);
  const unusableAgent = join(root, "not-a-directory");
  await writeFile(unusableAgent, "preserve this");
  for (const agentDir of [unusableAgent, join(cwd, "agent")]) {
    let loads = 0;
    const integration = createMsbIntegration({
      sessionId: "blocked-bootstrap", cwd, agentDir, configDirName: ".pi",
      env: { PI_MSB_FALLBACK_MODE: "host" },
      sdkLoader: async () => { loads++; return fakeSdk([]); },
    });
    const state = await integration.configureSession({ sessionId: "blocked-bootstrap", cwd, projectTrusted: true });
    assert.equal(state.status, "unavailable");
    assert.match(state.reason ?? "", /host configuration/);
    await integration.control.setEnabled(true);
    assert.equal(integration.provider.getState().status, "unavailable");
    await assert.rejects(integration.provider.withRuntime(async () => undefined));
    assert.equal(loads, 0);
  }
  assert.equal(await readFile(unusableAgent, "utf8"), "preserve this");
  await assert.rejects(stat(join(cwd, "agent")), { code: "ENOENT" });
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

test("network uses exact domains; wildcard secret destinations stay separate from network rules", async (t) => {
  const root = await temp(t, "exact-domains"); const calls: string[] = [];
  const sdk = fakeSdk(calls);
  const policy: any = {
    defaultDeny() { calls.push("default-deny"); return policy; }, defaultIngress: () => policy,
    egress(configure: (rule: any) => void) {
      const rule: any = { allow(configure: (destination: any) => void) {
        const destination: any = {
          domain(host: string) { calls.push(`domain:${host}`); return destination; },
          ip(host: string) { calls.push(`ip:${host}`); return destination; },
          cidr(host: string) { calls.push(`cidr:${host}`); return destination; },
        };
        configure(destination); return rule;
      } };
      configure(rule); return policy;
    },
  };
  sdk.NetworkPolicy = { builder: () => policy };
  const builder = sdk.Sandbox.builder;
  sdk.Sandbox.builder = (...args: any[]) => {
    const value = builder(...args);
    value.secret = (configure: (entry: any) => void) => {
      const entry: any = { env: () => entry, value: () => entry, requireTlsIdentity(required: boolean) { assert.equal(required, true); return entry; },
        allowHost(host: string) { calls.push(`secret-host:${host}`); return entry; },
        allowHostPattern(host: string) { calls.push(`secret-pattern:${host}`); return entry; },
      };
      configure(entry); return value;
    };
    return value;
  };
  const integration = createMsbIntegration({ sessionId: "exact", cwd: root, configDirName: ".pi", sdkLoader: async () => sdk,
    acquireOwnerLock: async () => ({ path: join(root, "owner.lock"), release: async () => {} }) });
  t.after(() => integration.manager.shutdown());
  const state = await integration.configureSession({ sessionId: "exact", cwd: root, projectTrusted: true, config: resolved(config({
    network: { mode: "allowlist", allowHosts: ["github.com", "api.github.com", "127.0.0.1", "2001:db8::/32"], allowDns: false, publishPorts: [] },
    secrets: [{ env: "TOKEN", textValue: "synthetic-private", allowHosts: ["github.com", "other.example", "*.googleapis.com"] }],
  })) });
  assert.equal(state.status, "active");
  assert.ok(calls.includes("default-deny"));
  assert.deepEqual(calls.filter((call) => /^(domain|ip|cidr):/.test(call)), ["domain:github.com", "domain:api.github.com", "ip:127.0.0.1", "cidr:2001:db8::/32"]);
  assert.deepEqual(calls.filter((call) => call.startsWith("secret-host:")), ["secret-host:github.com", "secret-host:other.example"]);
  assert.deepEqual(calls.filter((call) => call.startsWith("secret-pattern:")), ["secret-pattern:*.googleapis.com"]);
  assert.ok(!calls.includes("domain:other.example"));
  assert.ok(!calls.includes("domain:*.googleapis.com"));
});

test("temporary control edits are memory-only, validated atomically, and reset at session boundaries", async (t) => {
  const root = await temp(t, "temporary-control");
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const agentDir = join(root, "agent");
  const defaultFile = join(agentDir, "pi-microsandbox", "default.toml");
  await mkdir(dirname(defaultFile), { recursive: true });
  await writeFile(defaultFile, 'auto_start = false\ncpus = 3\n');
  const entries: string[] = [];
  const integration = createMsbIntegration({ sessionId: "one", cwd, agentDir, configDirName: ".pi", env: { HOME: root }, appendEntry: (kind) => { entries.push(kind); } });
  t.after(() => integration.manager.shutdown());
  await integration.configureSession({ sessionId: "one", cwd, projectTrusted: true });
  await integration.control.setOverride("cpus", 8);
  assert.equal(integration.configRef.value.cpus, 8);
  await assert.rejects(integration.control.setOverride("cpus", 0));
  assert.equal(integration.configRef.value.cpus, 8);
  assert.equal(integration.control.settings?.temporary().cpus, 8);
  await integration.configureSession({ sessionId: "one", cwd, projectTrusted: true });
  assert.equal(integration.configRef.value.cpus, 8);
  await integration.configureSession({ sessionId: "two", cwd, projectTrusted: true });
  assert.equal(integration.configRef.value.cpus, 3);
  await integration.control.setOverride("cpus", 12);
  integration.endSession();
  await integration.configureSession({ sessionId: "two", cwd, projectTrusted: true });
  assert.equal(integration.configRef.value.cpus, 3);
  assert.equal(entries.includes("pi-msb.override"), false);
  assert.equal(await readFile(defaultFile, "utf8"), 'auto_start = false\ncpus = 3\n');
});

test("settings apply reload adopts live fields and recreates SDK resources/network/secrets; temporary reset/end is memory-only", async (t) => {
  const root = await realpath(await temp(t, "settings-runtime"));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const calls: string[] = []; const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const sdk = fakeSdk(calls);
  const integration = createMsbIntegration({ sessionId: "settings-runtime", cwd, agentDir: join(root, "agent"), configDirName: ".pi", env: {}, sdkLoader: async () => sdk, acquireOwnerLock: async () => ({ path: join(root, "lock"), release: async () => {} }), appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) });
  await integration.configureSession({ sessionId: "settings-runtime", cwd, projectTrusted: true });
  calls.length = 0;
  const live = await integration.control.settings!.open("temporary"); live.set("show_footer", false); await live.apply(); await integration.control.reload();
  assert.equal(integration.configRef.value.showFooter, false); assert.ok(!calls.some((call) => /create:|remove:|stop:/.test(call)));
  const draft = await integration.control.settings!.open("temporary");
  draft.set("cpus", 2); draft.set("memory_mib", 2048); draft.set("network.mode", "deny");
  draft.upsertSecret({ env: "TOKEN", textValue: "PRIVATE_TEST_SENTINEL", allowHosts: ["api.example.com"] });
  await draft.apply(); await integration.control.reload();
  assert.ok(calls.includes("cpus:2")); assert.ok(calls.includes("memory:2048")); assert.ok(calls.includes("network:deny")); assert.ok(calls.includes("secret-env:TOKEN"));
  assert.ok(calls.some((call) => call.startsWith("remove:"))); assert.ok(calls.some((call) => call.startsWith("create:")));
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_TEST_SENTINEL|pi-msb.override/);
  await integration.control.resetOverrides(); assert.equal(integration.configRef.value.cpus, 4); assert.deepEqual(integration.configRef.value.secrets, []);
  const again = await integration.control.settings!.open("temporary"); again.set("cpus", 3); await again.apply(); await integration.control.reload();
  integration.endSession(); await integration.manager.shutdown();
  await integration.configureSession({ sessionId: "settings-runtime", cwd, projectTrusted: true }); assert.equal(integration.configRef.value.cpus, 4);
  await integration.manager.shutdown();
});

test("preview compares privately to adopted runtime and late resource changes cannot restart without consent", async (t) => {
  const root = await realpath(await temp(t, "settings-consent")); const cwd = join(root, "workspace"); await mkdir(cwd);
  const agentDir = join(root, "agent"); const calls: string[] = []; const sdk = fakeSdk(calls);
  const integration = createMsbIntegration({ sessionId: "consent", cwd, agentDir, configDirName: ".pi", env: {}, sdkLoader: async () => sdk, acquireOwnerLock: async () => ({ path: join(root, "lock"), release: async () => {} }) });
  await integration.configureSession({ sessionId: "consent", cwd, projectTrusted: true });
  await mkdir(join(agentDir, "pi-microsandbox"), { recursive: true });
  await writeFile(join(agentDir, "pi-microsandbox/default.toml"), "cpus = 2\n");
  const draft = await integration.control.settings!.open("temporary"); draft.set("show_footer", false);
  assert.equal((await draft.preview()).effect, "live"); // disk baseline already has cpus=2
  assert.equal((await integration.control.previewSettings!(draft)).effect, "restart");
  await draft.apply(); calls.length = 0;
  await assert.rejects(integration.control.reload({ allowRestart: false }), /restart confirmation/);
  assert.equal(integration.configRef.value.cpus, 4); assert.equal(integration.provider.isActive(), true);
  assert.ok(!calls.some((call) => /create:|remove:|stop:/.test(call)));
  await integration.control.reload({ allowRestart: true }); assert.equal(integration.configRef.value.cpus, 2);
  await integration.manager.shutdown();
});

test("disabled Git subdirectory settings use shared main-root Project identity without bootstrap/SDK/adoption", async (t) => {
  const root = await realpath(await temp(t, "disabled-settings")); const repo = join(root, "repo"); const cwd = join(repo, "packages/app"); await mkdir(cwd, { recursive: true }); initRepo(repo);
  const agentDir = join(root, "agent"); let loads = 0;
  const integration = createMsbIntegration({ sessionId: "disabled", cwd, agentDir, configDirName: ".pi", env: { PI_MSB_DISABLE: "1", PI_MSB_CPUS: "3" }, sdkLoader: async () => { loads++; return fakeSdk([]); } });
  const state = await integration.configureSession({ sessionId: "disabled", cwd, projectTrusted: true }); assert.equal(state.status, "off"); assert.match(state.reason!, /PI_MSB_DISABLE/);
  await assert.rejects(stat(agentDir), { code: "ENOENT" }); assert.equal(loads, 0); assert.equal(integration.configRef.value.cpus, 4);
  const draft = await integration.control.settings!.open("project");
  const expected = (await hostConfigTargets({ cwd: repo, agentDir, env: {}, projectTrusted: true, configDirName: ".pi" })).paths.project; assert.equal(draft.path, expected);
  draft.set("cpus", 2); await draft.apply(); await integration.control.reload();
  assert.equal(integration.control.getState().status, "off"); assert.equal(integration.configRef.value.cpus, 4); assert.equal(loads, 0);
  assert.match(await readFile(expected, "utf8"), /cpus/); await assert.rejects(stat(join(agentDir, "pi-microsandbox/default.toml")), { code: "ENOENT" });
});

test("disabled workspace discovery failure blocks execution and wrong-identity editing", async (t) => {
  const root = await realpath(await temp(t, "disabled-failed-settings")); const cwd = join(root, "missing"); let loads = 0;
  const integration = createMsbIntegration({ sessionId: "disabled-failed", cwd, agentDir: join(root, "agent"), configDirName: ".pi", env: { PI_MSB_DISABLE: "1" }, sdkLoader: async () => { loads++; return fakeSdk([]); } });
  const state = await integration.configureSession({ sessionId: "disabled-failed", cwd, projectTrusted: true });
  assert.equal(state.status, "unavailable"); assert.match(state.reason!, /Settings editing is blocked/);
  assert.throws(() => integration.control.settings, /canonical workspace discovery/); assert.equal(loads, 0);
  await assert.rejects(stat(join(root, "agent")), { code: "ENOENT" });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const boundary of ["end", "supersede"] as const) test(`a deferred boot cannot restore adoption after session ${boundary}`, async (t) => {
  const root = await temp(t, `obsolete-adoption-${boundary}`);
  const entered = deferred<void>(), release = deferred<void>();
  const integration = createMsbIntegration({
    sessionId: "same", cwd: root, configDirName: ".pi", env: {}, sdkLoader: async () => fakeSdk([]),
    acquireOwnerLock: async () => {
      entered.resolve(); await release.promise;
      return { path: "unused", release: async () => {} };
    },
  });
  t.after(() => integration.manager.shutdown());
  const obsolete = integration.configureSession({ sessionId: "same", cwd: root, projectTrusted: true, config: resolved(config()) });
  await entered.promise;
  // Superseding the very same session/cwd must still create a new identity.
  const replacement = boundary === "supersede"
    ? integration.configureSession({ sessionId: "same", cwd: root, projectTrusted: true, config: resolved(config({ autoStart: false })) })
    : (integration.endSession(), undefined);
  release.resolve();
  await obsolete;
  await replacement;
  assert.equal(integration.control.getRuntimePolicy!(), undefined);
  assert.equal(integration.control.getAgentRuntimePolicy!(), undefined);
  const report: any = await integration.control.getDiagnostics!();
  assert.equal(report.adoption.known, false);
  assert.equal(report.adoption.verification, "unknown");
  assert.equal(integration.provider.isActive(), false);
  await assert.rejects(integration.provider.withRuntime(async () => { assert.fail("obsolete runtime used"); }));
});

test("direct same-session replacement invalidates adopted snapshots synchronously", async (t) => {
  const root = await temp(t, "adoption-visibility");
  const integration = createMsbIntegration({
    sessionId: "same", cwd: root, configDirName: ".pi", env: {}, sdkLoader: async () => fakeSdk([]),
    acquireOwnerLock: async () => ({ path: "unused", release: async () => {} }),
  });
  t.after(() => integration.manager.shutdown());
  const setup = { sessionId: "same", cwd: root, projectTrusted: true };
  await integration.configureSession({ ...setup, config: resolved(config()) });
  assert.ok(integration.control.getRuntimePolicy!());
  assert.ok(integration.control.getAgentRuntimePolicy!());
  const replacement = integration.configureSession({ ...setup, config: resolved(config({ autoStart: false })) });
  assert.equal(integration.control.getRuntimePolicy!(), undefined);
  assert.equal(integration.control.getAgentRuntimePolicy!(), undefined);
  assert.equal((await integration.control.getDiagnostics!() as any).adoption.known, false);
  await replacement;
});

test("an ended session rejects adoption from a deferred manager preflight", async (t) => {
  const root = await temp(t, "preflight-adoption"), sdk = fakeSdk([]);
  const integration = createMsbIntegration({
    sessionId: "same", cwd: root, configDirName: ".pi", env: {}, sdkLoader: async () => sdk,
    acquireOwnerLock: async () => ({ path: "unused", release: async () => {} }),
  });
  t.after(() => integration.manager.shutdown());
  await integration.configureSession({ sessionId: "same", cwd: root, projectTrusted: true, config: resolved(config()) });
  const entered = deferred<void>(), release = deferred<void>(), get = sdk.Sandbox.get;
  sdk.Sandbox.get = async (name: string) => { entered.resolve(); await release.promise; return get(name); };
  const queued = integration.provider.withRuntime(async () => { assert.fail("ended preflight entered callback"); });
  const rejected = assert.rejects(queued, /context changed/);
  await entered.promise;
  integration.endSession();
  release.resolve();
  await rejected;
  assert.equal(integration.control.getRuntimePolicy!(), undefined);
  assert.equal(integration.control.getAgentRuntimePolicy!(), undefined);
  assert.equal((await integration.control.getDiagnostics!() as any).adoption.known, false);
});

for (const initialMode of ["active", "off"] as const) test(`deferred and failed session replacement cannot reuse old ${initialMode} execution`, async (t) => {
  const root = await temp(t, `replace-${initialMode}`), first = join(root, "first"), second = join(root, "second");
  await mkdir(first); await mkdir(second);
  const entered = deferred<void>(), release = deferred<void>(), calls: string[] = [];
  const integration = createMsbIntegration({
    sessionId: "one", cwd: first, configDirName: ".pi", env: {}, sdkLoader: async () => fakeSdk(calls),
    acquireOwnerLock: async (request) => {
      if (request.sessionId === "two") { entered.resolve(); await release.promise; throw new Error("replacement failed"); }
      return { path: "unused", release: async () => {} };
    },
  });
  t.after(() => integration.manager.shutdown());
  await integration.configureSession({ sessionId: "one", cwd: first, projectTrusted: true, config: resolved(config({ autoStart: initialMode === "active" })) });
  assert.equal(integration.provider.getState().status, initialMode);
  const oldIdentity = integration.provider.execution!.current();
  const replacement = integration.configureSession({ sessionId: "two", cwd: second, projectTrusted: true, config: resolved(config()) });
  assert.notEqual(integration.provider.execution!.current(), oldIdentity);
  assert.equal(integration.provider.execution!.current().cwd, second);
  assert.equal(integration.provider.getState().status, "booting");
  let executions = 0;
  await assert.rejects(integration.provider.withRuntime(async () => { executions++; }), /not ready/);
  await entered.promise;
  assert.equal(integration.provider.isActive(), false);
  await assert.rejects(integration.provider.withRuntime(async () => { executions++; }), /not ready/);
  release.resolve();
  assert.equal((await replacement).status, "unavailable");
  await assert.rejects(integration.provider.withRuntime(async () => { executions++; }), /not available/);
  assert.equal(executions, 0);
});

test("failed workspace replacement and session end block the still-live previous manager", async (t) => {
  const root = await temp(t, "old-manager"), calls: string[] = [];
  const integration = createMsbIntegration({ sessionId: "one", cwd: root, configDirName: ".pi", env: {}, sdkLoader: async () => fakeSdk(calls), acquireOwnerLock: async () => ({ path: "unused", release: async () => {} }) });
  t.after(() => integration.manager.shutdown());
  await integration.configureSession({ sessionId: "one", cwd: root, projectTrusted: true, config: resolved(config()) });
  integration.endSession();
  assert.equal(integration.manager.isActive(), true);
  await assert.rejects(integration.provider.withRuntime(async () => { assert.fail("ended runtime used"); }), /not ready/);
  const state = await integration.configureSession({ sessionId: "two", cwd: join(root, "missing"), projectTrusted: true, config: resolved(config()) });
  assert.equal(state.status, "unavailable");
  assert.equal(integration.manager.isActive(), true);
  assert.equal(integration.provider.isActive(), false);
  await assert.rejects(integration.provider.withRuntime(async () => { assert.fail("old runtime used"); }), /not available/);
});

test("queued acquisitions cannot cross session/cwd replacement while entered callbacks drain normally", async (t) => {
  const root = await temp(t, "queued-session"), first = join(root, "first"), second = join(root, "second");
  await mkdir(first); await mkdir(second);
  const calls: string[] = [], sdk = fakeSdk(calls);
  const integration = createMsbIntegration({ sessionId: "one", cwd: first, configDirName: ".pi", env: {}, sdkLoader: async () => sdk, acquireOwnerLock: async () => ({ path: "unused", release: async () => {} }) });
  t.after(() => integration.manager.shutdown());
  await integration.configureSession({ sessionId: "one", cwd: first, projectTrusted: true, config: resolved(config()) });
  const entered = deferred<void>(), releaseCallback = deferred<void>();
  const activeCall = integration.provider.withRuntime(async (runtime) => {
    entered.resolve(); await releaseCallback.promise;
    // An entered callback is still entitled to its old transport until it returns.
    assert.equal((await runtime.transport.exec("draining-callback", [])).exitCode, 0);
    return "drained";
  });
  await entered.promise;
  const acquired = deferred<void>(), releaseAcquire = deferred<void>(), get = sdk.Sandbox.get;
  let holdNext = true;
  sdk.Sandbox.get = async (name: string) => {
    if (holdNext) { holdNext = false; acquired.resolve(); await releaseAcquire.promise; }
    return get(name);
  };
  const queued = integration.provider.withRuntime(async () => { assert.fail("queued old-session callback executed"); });
  const rejected = assert.rejects(queued, /context changed/);
  await acquired.promise;
  const replacement = integration.configureSession({ sessionId: "two", cwd: second, projectTrusted: true, config: resolved(config()) });
  releaseAcquire.resolve();
  await rejected;
  assert.equal(calls.some((call) => call.startsWith("stop:")), false);
  assert.equal(integration.provider.getState().status, "booting");
  releaseCallback.resolve();
  assert.equal(await activeCall, "drained");
  assert.equal((await replacement).status, "active");
  assert.equal(integration.provider.getState().info?.cwd, second);
  assert.equal(await integration.provider.withRuntime(async () => "new session"), "new session");
  assert.ok(calls.indexOf("exec:draining-callback:[]") < calls.findIndex((call) => call.startsWith("stop:")));
});

test("a newer setup supersedes deferred setup without exposing its stale configuration", async (t) => {
  const root = await temp(t, "superseded-setup"), first = join(root, "first"), second = join(root, "second");
  await mkdir(first); await mkdir(second);
  const entered = deferred<void>(), release = deferred<void>(), calls: string[] = [];
  const integration = createMsbIntegration({
    sessionId: "one", cwd: first, configDirName: ".pi", env: {}, sdkLoader: async () => fakeSdk(calls),
    acquireOwnerLock: async (request) => {
      if (request.sessionId === "one") { entered.resolve(); await release.promise; }
      return { path: "unused", release: async () => {} };
    },
  });
  t.after(() => integration.manager.shutdown());
  const obsolete = integration.configureSession({ sessionId: "one", cwd: first, projectTrusted: true, config: resolved(config({ cpus: 8 })) });
  await entered.promise;
  const replacement = integration.configureSession({ sessionId: "two", cwd: second, projectTrusted: true, config: resolved(config({ cpus: 2 })) });
  assert.equal(integration.provider.getState().status, "booting");
  release.resolve();
  await obsolete;
  assert.equal((await replacement).status, "active");
  assert.equal(integration.configRef.value.cpus, 2);
  assert.equal(integration.provider.execution!.current().cwd, second);
  assert.equal(integration.provider.getState().info?.cwd, second);
});

test("recent logs redact actual boot-time secret bytes even if an environment reference changes", async (t) => {
  const root = await realpath(await temp(t, "settings-log-redaction")); const cwd = join(root, "workspace"); await mkdir(cwd);
  const env = { PI_MSB_SECRETS: JSON.stringify([{ env: "TOKEN", hostEnv: "ACTUAL_TOKEN", allow_hosts: ["api.example.com"] }]), ACTUAL_TOKEN: "BOOT_SECRET_SENTINEL" };
  const sdk = fakeSdk([], undefined, "log BOOT_SECRET_SENTINEL and NEW_SECRET_SENTINEL");
  const integration = createMsbIntegration({ sessionId: "logs", cwd, agentDir: join(root, "agent"), configDirName: ".pi", env, sdkLoader: async () => sdk, acquireOwnerLock: async () => ({ path: join(root, "lock"), release: async () => {} }) });
  await integration.configureSession({ sessionId: "logs", cwd, projectTrusted: true });
  env.ACTUAL_TOKEN = "NEW_SECRET_SENTINEL";
  assert.doesNotMatch(await integration.control.getLogs(100), /BOOT_SECRET_SENTINEL|NEW_SECRET_SENTINEL/);
  await integration.manager.shutdown();
});

test("runtime activation failure after a valid settings save stays blocked and does not echo credential bytes", async (t) => {
  const root = await realpath(await temp(t, "settings-failure")); const cwd = join(root, "workspace"); await mkdir(cwd);
  const sdk = fakeSdk([]); const integration = createMsbIntegration({ sessionId: "failure", cwd, agentDir: join(root, "agent"), configDirName: ".pi", env: {}, sdkLoader: async () => sdk, acquireOwnerLock: async () => ({ path: join(root, "lock"), release: async () => {} }) });
  await integration.configureSession({ sessionId: "failure", cwd, projectTrusted: true });
  const originalBuilder = sdk.Sandbox.builder;
  sdk.Sandbox.builder = (name: string) => { const builder = originalBuilder(name); builder.create = async () => { throw new Error("SDK rejected PRIVATE_FAILURE_SENTINEL"); }; return builder; };
  const draft = await integration.control.settings!.open("temporary"); draft.set("cpus", 2); draft.upsertSecret({ env: "TOKEN", textValue: "PRIVATE_FAILURE_SENTINEL", allowHosts: ["api.example.com"] }); await draft.apply();
  await assert.rejects(integration.control.reload(), /activation failed/);
  assert.equal(integration.control.getState().status, "unavailable"); assert.equal(integration.provider.isActive(), false);
  assert.doesNotMatch(JSON.stringify(integration.control.getState()), /PRIVATE_FAILURE_SENTINEL/);
  await assert.rejects(integration.provider.withRuntime(async () => undefined), /not available/);
  assert.equal(integration.configRef.value.fallbackMode, "block");
  await integration.manager.shutdown();
});

test("prune diagnostic details redact current and boot-time credential bytes before reaching the panel", async (t) => {
  const root = await realpath(await temp(t, "prune-redaction")); const cwd = join(root, "workspace"); await mkdir(cwd);
  const env = { PI_MSB_SECRETS: JSON.stringify([{ env: "TOKEN", hostEnv: "TOKEN", allow_hosts: ["a.example"] }]), TOKEN: "BOOT_PRIVATE_SENTINEL" };
  const sdk = fakeSdk([]);
  const integration = createMsbIntegration({ sessionId: "prune-redaction", cwd, agentDir: join(root, "agent"), configDirName: ".pi", env, sdkLoader: async () => sdk, acquireOwnerLock: async () => ({ path: join(root, "lock"), release: async () => {} }) });
  await integration.configureSession({ sessionId: "prune-redaction", cwd, projectTrusted: true });
  env.TOKEN = "CURRENT_PRIVATE_SENTINEL";
  sdk.Sandbox.listWith = async () => { throw new Error("Prune failed: BOOT_PRIVATE_SENTINEL / CURRENT_PRIVATE_SENTINEL"); };
  const report = await integration.control.pruneNow();
  assert.ok(report.errors.length); assert.doesNotMatch(JSON.stringify(report), /BOOT_PRIVATE_SENTINEL|CURRENT_PRIVATE_SENTINEL/); assert.match(report.errors.join(" "), /REDACTED/);
  await integration.manager.shutdown();
});

test("UI refresh and manager notifications track sleep, wake, blocked preflight and session replacement", async (t) => {
  const root = await temp(t, "liveness");
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const calls: string[] = [];
  const sdk = fakeSdk(calls);
  const states: RuntimeState[] = [];
  let entered!: () => void, release!: () => void;
  const enteredPoll = new Promise<void>((resolve) => { entered = resolve; });
  const releasedPoll = new Promise<void>((resolve) => { release = resolve; });
  const get = sdk.Sandbox.get;
  let deferPoll = false, missing = false;
  sdk.Sandbox.get = async (name: string) => {
    if (deferPoll) { entered(); await releasedPoll; }
    if (missing) throw Object.assign(new Error("missing"), { code: "NOT_FOUND" });
    return get(name);
  };
  const integration = createMsbIntegration({
    sessionId: "liveness", cwd, configDirName: ".pi", agentDir: join(root, "agent"), env: { HOME: root },
    sdkLoader: async () => sdk, onState: (state) => states.push(state),
    acquireOwnerLock: async () => ({ path: "unused", release: async () => undefined }),
  });
  t.after(() => integration.manager.shutdown());
  const setup = { sessionId: "liveness", cwd, projectTrusted: true, config: resolved(config()) };
  await integration.configureSession(setup);
  const handle = await get(integration.control.getState().info!.name);
  handle.status = "stopped";
  const before = calls.length;
  assert.equal((await integration.provider.refreshState!()).observation, "asleep");
  assert.equal(integration.provider.isActive(), true);
  assert.equal(calls.length, before, "refresh must not start, connect or execute commands");
  await integration.control.getDiagnostics!();
  assert.equal(calls.length, before, "diagnostics must not probe");
  await integration.provider.withRuntime(async () => undefined);
  assert.equal(states.at(-1)?.status, "active");
  assert.equal(states.at(-1)?.observation, undefined);
  assert.ok(states.some((state) => state.observation === "unknown"));
  missing = true;
  await assert.rejects(integration.provider.withRuntime(async () => undefined));
  assert.equal(states.at(-1)?.status, "unavailable");
  missing = false;
  await integration.configureSession(setup);
  deferPoll = true;
  const refreshing = integration.provider.refreshState!();
  await enteredPoll;
  const replacing = integration.configureSession({ ...setup, sessionId: "replacement" });
  const count = states.length;
  deferPoll = false;
  release();
  await refreshing;
  await replacing;
  assert.deepEqual(states.slice(count).map((state) => state.status), ["booting", "active"]);
  assert.equal(states[count]?.pendingName, integration.control.getState().info?.name);
  assert.equal(states[count]?.info, null);
});

test("reload presents booting until success or failure without changing tool routing", async (t) => {
  const root = await temp(t, "reload-display");
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const env = { HOME: root, PI_MSB_AUTO_START: "false", PI_MSB_PRUNE_ON_START: "false", PI_MSB_DOCKER__MODE: "disabled" };
  const states: Array<{ status: string; observation?: string }> = [];
  const integration = createMsbIntegration({
    sessionId: "reload-display", cwd, configDirName: ".pi", agentDir: join(root, "agent"), env,
    onState: (state) => states.push(state), sdkLoader: async () => fakeSdk([]),
    acquireOwnerLock: async () => ({ path: "unused", release: async () => undefined }),
  });
  t.after(() => integration.manager.shutdown());
  await integration.configureSession({ sessionId: "reload-display", cwd, projectTrusted: true, config: resolved(config()) });
  states.length = 0;
  const reloading = integration.control.reload();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(states[0]?.status, "booting");
  assert.equal(integration.provider.getState().status, "active", "presentation must not change routing");
  assert.equal((await integration.provider.refreshState!()).status, "booting");
  await reloading;
  assert.equal(states.at(-1)?.status, "active");
  env.PI_MSB_AUTO_START = "not-a-boolean";
  await assert.rejects(integration.control.reload());
  assert.equal(states.at(-1)?.status, "active");
  assert.equal(states.at(-1)?.observation, "unknown", "invalid configuration must not retain an unverified green dot");
  assert.equal(integration.control.getState().observation, "unknown", "later synchronous renders must also remain uncertain");
  await integration.control.setEnabled(false);
  await assert.rejects(integration.control.reload());
  assert.equal(states.at(-1)?.status, "unavailable");
});

for (const mode of ["disabled", "invalid"]) test(`passive UI refresh never loads the SDK for ${mode} configuration`, async (t) => {
  const root = await temp(t, "passive-no-sdk");
  const cwd = join(root, "workspace"); await mkdir(cwd);
  let loads = 0;
  const integration = createMsbIntegration({
    sessionId: "passive", cwd, configDirName: ".pi", agentDir: join(root, "agent"),
    env: { HOME: root, ...(mode === "disabled" ? { PI_MSB_DISABLE: "1" } : { PI_MSB_CPUS: "invalid" }) },
    sdkLoader: async () => { loads++; throw new Error("must not load"); },
  });
  await integration.configureSession({ sessionId: "passive", cwd, projectTrusted: true });
  for (let i = 0; i < 3; i++) await integration.provider.refreshState!();
  assert.equal(loads, 0);
  assert.equal(integration.provider.getState().status, mode === "disabled" ? "off" : "unavailable");
  await integration.manager.shutdown();
});

test("automatic names stay consistent across SDK creation, owner metadata, settings reload and session resume", async (t) => {
  const root = await temp(t, "docker-names");
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const sessionId = "random-name-session";
  const calls: string[] = [];
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const lockNames: string[] = [];
  const options = {
    sessionId, cwd, configDirName: ".pi", agentDir: join(root, "agent"),
    env: { HOME: root, PI_MSB_BOOTSTRAP_TOOLS: "false", PI_MSB_PRUNE_ON_START: "false", PI_MSB_DOCKER__MODE: "disabled" },
    entries: () => entries,
    appendEntry: (customType: string, data?: unknown) => { entries.push({ type: "custom", customType, data }); },
    acquireOwnerLock: async (_request: unknown, name: string) => {
      lockNames.push(name);
      return { path: "unused", release: async () => undefined };
    },
  };
  const integration = createMsbIntegration({ ...options, sdkLoader: async () => fakeSdk(calls) });
  t.after(() => integration.manager.shutdown());
  const initial = await integration.configureSession({ sessionId, cwd, projectTrusted: true, config: resolved(config()) });
  assert.equal(initial.status, "active");
  const name = initial.info!.name;
  assert.match(name, /^[a-z]+-[a-z]+$/);
  assert.ok(calls.includes(`create:${name}`));
  assert.equal((entries.at(-1)!.data as PersistedSandboxState).sandboxName, name);
  assert.equal(integration.configRef.value.sandboxName, null, "chosen runtime name is not a settings override");
  await integration.control.reload();
  assert.equal(integration.control.getState().info?.name, name);
  await integration.control.setEnabled(false);
  await integration.control.setEnabled(true);
  assert.equal(integration.control.getState().info?.name, name);
  assert.ok(lockNames.every((selected) => selected === name));
  const labels = JSON.parse(calls.find((call) => call.startsWith("labels:"))!.slice("labels:".length));
  assert.equal(labels["pi-msb.session"], sessionId);
  await integration.manager.shutdown();

  const resumedCalls: string[] = [];
  const resumedSdk = fakeSdk(resumedCalls, { name, status: "running", labels });
  const resumed = createMsbIntegration({ ...options, sdkLoader: async () => resumedSdk });
  t.after(() => resumed.manager.shutdown());
  assert.equal((await resumed.configureSession({ sessionId, cwd, projectTrusted: true, config: resolved(config()) })).info?.name, name);
  assert.ok(resumedCalls.includes(`connect:${name}`));
  assert.equal(resumedCalls.some((call) => call.startsWith("create:")), false);
  assert.equal(lockNames.at(-1), name);
});
