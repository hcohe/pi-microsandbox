import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "./config.ts";
import { fakeSdk } from "../../test/fake-msb-sdk.ts";
import { createMsbIntegration } from "./control.ts";
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

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pi-msb-${prefix}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("host policy survives local edits while temporary settings override it through reload and off/on", async (t) => {
  const root = await temp(t, "host-config");
  const cwd = join(root, "Code", "app");
  await mkdir(cwd, { recursive: true });
  initRepo(cwd);
  const agentDir = join(root, "agent");
  const defaultFile = join(agentDir, "pi-microsandbox", "default.toml");
  const projectFile = join(agentDir, "pi-microsandbox", "projects", "Code", "app", "config.toml");
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
  await writeFile(projectFile, "cpus = 2\nmemory_mib = 2048");
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

test("session setup bootstraps only on first enabled session and ignores obsolete local policy", async (t) => {
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
  const template = await readFile(file, "utf8");
  assert.match(template, /pi-microsandbox host-owned configuration/);
  assert.equal(integration.configRef.value.cpus, 3);
  assert.equal(loads, 0);
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

test("bootstrap failures block setup and explicit on even when environment requests host fallback", async (t) => {
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
    secrets: [{ env: "TOKEN", value: "synthetic-private", allowHosts: ["github.com", "other.example", "*.googleapis.com"] }],
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
  draft.upsertSecret({ env: "TOKEN", value: "PRIVATE_TEST_SENTINEL", allowHosts: ["api.example.com"] });
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

test("disabled Git subdirectory settings use canonical worktree identity without bootstrap/SDK/adoption", async (t) => {
  const root = await realpath(await temp(t, "disabled-settings")); const repo = join(root, "repo"); const cwd = join(repo, "packages/app"); await mkdir(cwd, { recursive: true }); initRepo(repo);
  const agentDir = join(root, "agent"); let loads = 0;
  const integration = createMsbIntegration({ sessionId: "disabled", cwd, agentDir, configDirName: ".pi", env: { PI_MSB_DISABLE: "1", PI_MSB_CPUS: "3" }, sdkLoader: async () => { loads++; return fakeSdk([]); } });
  const state = await integration.configureSession({ sessionId: "disabled", cwd, projectTrusted: true }); assert.equal(state.status, "off"); assert.match(state.reason!, /PI_MSB_DISABLE/);
  await assert.rejects(stat(agentDir), { code: "ENOENT" }); assert.equal(loads, 0); assert.equal(integration.configRef.value.cpus, 4);
  const draft = await integration.control.settings!.open("project");
  const expected = join(agentDir, "pi-microsandbox/projects-absolute", repo.slice(1), "config.toml"); assert.equal(draft.path, expected); assert.ok(!draft.path!.includes("packages/app/config.toml"));
  draft.set("cpus", 2); await draft.apply(); await integration.control.reload();
  assert.equal(integration.control.getState().status, "off"); assert.equal(integration.configRef.value.cpus, 4); assert.equal(loads, 0);
  assert.match(await readFile(expected, "utf8"), /cpus/); await assert.rejects(stat(join(agentDir, "pi-microsandbox/default.toml")), { code: "ENOENT" });
});

test("disabled workspace discovery failure stays off and blocks wrong-identity editing", async (t) => {
  const root = await realpath(await temp(t, "disabled-failed-settings")); const cwd = join(root, "missing"); let loads = 0;
  const integration = createMsbIntegration({ sessionId: "disabled-failed", cwd, agentDir: join(root, "agent"), configDirName: ".pi", env: { PI_MSB_DISABLE: "1" }, sdkLoader: async () => { loads++; return fakeSdk([]); } });
  const state = await integration.configureSession({ sessionId: "disabled-failed", cwd, projectTrusted: true });
  assert.equal(state.status, "off"); assert.match(state.reason!, /Settings editing is blocked/);
  assert.throws(() => integration.control.settings, /canonical workspace discovery/); assert.equal(loads, 0);
  await assert.rejects(stat(join(root, "agent")), { code: "ENOENT" });
});

test("recent logs redact actual boot-time secret bytes even if an environment reference changes", async (t) => {
  const root = await realpath(await temp(t, "settings-log-redaction")); const cwd = join(root, "workspace"); await mkdir(cwd);
  const env = { PI_MSB_SECRETS: JSON.stringify([{ env: "TOKEN", value: "$ENV:ACTUAL_TOKEN", allow_hosts: ["api.example.com"] }]), ACTUAL_TOKEN: "BOOT_SECRET_SENTINEL" };
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
  const draft = await integration.control.settings!.open("temporary"); draft.set("cpus", 2); draft.upsertSecret({ env: "TOKEN", value: "PRIVATE_FAILURE_SENTINEL", allowHosts: ["api.example.com"] }); await draft.apply();
  await assert.rejects(integration.control.reload(), /activation failed/);
  assert.equal(integration.control.getState().status, "unavailable"); assert.equal(integration.provider.isActive(), false);
  assert.doesNotMatch(JSON.stringify(integration.control.getState()), /PRIVATE_FAILURE_SENTINEL/);
  await assert.rejects(integration.provider.withRuntime(async () => undefined), /not available/);
  assert.equal(integration.configRef.value.fallbackMode, "block");
  await integration.manager.shutdown();
});

test("prune diagnostic details redact current and boot-time credential bytes before reaching the panel", async (t) => {
  const root = await realpath(await temp(t, "prune-redaction")); const cwd = join(root, "workspace"); await mkdir(cwd);
  const env = { PI_MSB_SECRETS: JSON.stringify([{ env: "TOKEN", value: "$ENV:TOKEN", allow_hosts: ["a.example"] }]), TOKEN: "BOOT_PRIVATE_SENTINEL" };
  const sdk = fakeSdk([]);
  const integration = createMsbIntegration({ sessionId: "prune-redaction", cwd, agentDir: join(root, "agent"), configDirName: ".pi", env, sdkLoader: async () => sdk, acquireOwnerLock: async () => ({ path: join(root, "lock"), release: async () => {} }) });
  await integration.configureSession({ sessionId: "prune-redaction", cwd, projectTrusted: true });
  env.TOKEN = "CURRENT_PRIVATE_SENTINEL";
  sdk.Sandbox.listWith = async () => { throw new Error("Prune failed: BOOT_PRIVATE_SENTINEL / CURRENT_PRIVATE_SENTINEL"); };
  const report = await integration.control.pruneNow();
  assert.ok(report.errors.length); assert.doesNotMatch(JSON.stringify(report), /BOOT_PRIVATE_SENTINEL|CURRENT_PRIVATE_SENTINEL/); assert.match(report.errors.join(" "), /REDACTED/);
  await integration.manager.shutdown();
});
