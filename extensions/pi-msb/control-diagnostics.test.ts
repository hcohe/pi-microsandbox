import assert from "node:assert/strict";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fakeSdk } from "../../test/fake-msb-sdk.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { createMsbIntegration } from "./control.ts";
import { boundDiagnosticsReport } from "./diagnostics-tools.ts";
import type { Config } from "./types.ts";

async function fixture(t: test.TestContext, active = false, fault?: { stage: "sdk" | "start" | "prepare"; enabled: boolean }) {
  const root = await mkdtemp("/tmp/msb-passive-diagnostics-");
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  let forbidden = false, envReads = 0, sdkLoads = 0, stateChanges = 0, writes = 0;
  const calls: string[] = [];
  const env = new Proxy({}, { get() { envReads++; if (forbidden) throw new Error("environment read"); return undefined; }, ownKeys() { throw new Error("environment enumeration"); } });
  const integration = createMsbIntegration({ sessionId: "diagnostics", cwd, configDirName: ".pi", agentDir: join(root, "agent"), env,
    sdkLoader: async () => {
      sdkLoads++; if (forbidden) throw new Error("SDK loaded");
      if (fault?.enabled && fault.stage === "sdk") throw new Error("PRIVATE_SDK_ERROR credential=PRIVATE_TOKEN");
      const sdk = fakeSdk(calls);
      const originalBuilder = sdk.Sandbox.builder;
      sdk.Sandbox.builder = (...args: Parameters<typeof originalBuilder>) => {
        const builder = originalBuilder(...args);
        const create = builder.create;
        builder.create = async () => {
          if (fault?.enabled && fault.stage === "start") throw new Error("PRIVATE_START_ERROR credential=PRIVATE_TOKEN");
          const raw = await create();
          if (fault?.enabled && fault.stage === "prepare") raw.execWith = async () => { throw new Error("PRIVATE_PREPARE_ERROR credential=PRIVATE_TOKEN"); };
          return raw;
        };
        return builder;
      };
      return sdk;
    },
    acquireOwnerLock: async () => ({ path: join(root, "owner"), release: async () => undefined }),
    locksPort: { tryAcquire: async () => ({ path: join(root, "lock"), release: async () => undefined }) },
    appendEntry: () => { writes++; }, onState: () => { stateChanges++; },
  });
  const config = { ...structuredClone(DEFAULT_CONFIG), autoStart: active, bootstrapTools: false, docker: { mode: "disabled", startupTimeoutMs: 15000 }, pruneOnStart: false } as Config;
  t.after(async () => { forbidden = false; await integration.manager.shutdown(); integration.endSession(); await rm(root, { recursive: true, force: true }); });
  return { root, cwd, integration, config, start: () => integration.configureSession({ sessionId: "diagnostics", cwd, projectTrusted: true, config: { config, provenance: {}, warnings: [] } }),
    forbid() { forbidden = true; }, allow() { forbidden = false; }, counters: () => ({ envReads, sdkLoads, stateChanges, writes, calls: [...calls] }) };
}

test("before startup diagnostics are passive, blocked, and do not advertise defaults", async (t) => {
  const f = await fixture(t);
  f.forbid();
  const before = f.counters();
  const result: any = await f.integration.control.getDiagnostics!();
  assert.equal(result.runtime.status, "unavailable");
  assert.equal(result.readiness.configReady, false);
  assert.equal(result.desired.settings, undefined);
  assert.equal(result.failure.code, "workspace_unavailable");
  assert.deepEqual(f.counters(), before);
});

for (const active of [false, true]) test(`diagnostics from ${active ? "active" : "off"} held state do not read environment/sources or run lifecycle`, async (t) => {
  const f = await fixture(t, active);
  await f.start();
  // Diagnostics must keep working even if every source/workspace has disappeared.
  await rm(f.cwd, { recursive: true });
  f.forbid();
  const state = structuredClone(f.integration.control.getState());
  const before = f.counters();
  const forbiddenCalls: string[] = [];
  // Patch the actual host entry points as well as the injected environment/SDK.
  for (const key of ["readFile", "stat", "lstat", "realpath", "access", "readdir", "mkdir", "writeFile", "open"] as const) {
    t.mock.method(fs, key, () => { forbiddenCalls.push(key); throw new Error(`Forbidden host IO: ${key}`); });
  }
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"] as const) {
    t.mock.method(childProcess, key, () => { forbiddenCalls.push(key); throw new Error(`Forbidden command: ${key}`); });
  }
  syncBuiltinESMExports();
  for (let i = 0; i < 2; i++) {
    const result: any = await f.integration.control.getDiagnostics!();
    assert.equal(result.runtime.status, active ? "active" : "off");
    assert.equal(result.readiness.configReady, true);
    assert.equal(result.desired.settings.autoStart, active);
    assert.match(result.evidence, /not live/);
    assert.ok(result.notPerformed.includes("environment reads"));
    assert.equal(result.adoption.known, active);
    assert.equal(result.failure.code, "none");
    assert.equal(result.failure.reason, "No cached blocking failure.");
  }
  assert.deepEqual(f.integration.control.getState(), state);
  assert.deepEqual(f.counters(), before);
  assert.deepEqual(forbiddenCalls, []);
  t.mock.restoreAll();
  syncBuiltinESMExports();
});

for (const active of [false, true]) test(`invalid/rejected configuration with ${active ? "active" : "off"} runtime never exposes raw parser text, literals or last known desired`, async (t) => {
  const f = await fixture(t, active);
  await f.start();
  const secret = "PRIVATE_REJECTED_LITERAL";
  await mkdir(join(f.root, "agent"), { recursive: true });
  await writeFile(join(f.root, "agent", "msb.toml"), `bad = [\n text_value = "${secret}"\n`);
  await assert.rejects(f.integration.control.reload());
  f.forbid();
  const before = f.counters();
  const result: any = await f.integration.control.getDiagnostics!();
  assert.equal(result.readiness.configReady, false);
  assert.equal(result.desired.settings, undefined);
  assert.equal(result.failure.phase, "configuration_not_ready");
  // Failed reload keeps an active runtime usable; an inactive runtime becomes unavailable.
  assert.equal(result.failure.code, active ? "none" : "invalid_configuration");
  if (active) assert.equal(result.failure.reason, "No cached blocking failure.");
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(f.counters(), before);
});

test("invalid startup sources and workspace identity failures report honest readiness without defaults", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "agent"), { recursive: true });
  await writeFile(join(f.root, "agent", "msb.toml"), 'secrets = [{ text_value = "PRIVATE_REJECTED", invalid = true }]\n');
  await f.integration.configureSession({ sessionId: "diagnostics", cwd: f.cwd, projectTrusted: true });
  const rejected: any = await f.integration.control.getDiagnostics!();
  assert.equal(rejected.readiness.configReady, false);
  assert.equal(rejected.desired.settings, undefined);
  assert.ok(!JSON.stringify(rejected).includes("PRIVATE_REJECTED"));
  assert.equal(rejected.failure.code, "invalid_configuration");
  assert.equal(f.counters().sdkLoads, 0);
  await f.integration.configureSession({ sessionId: "diagnostics", cwd: join(f.root, "missing-workspace"), projectTrusted: true });
  f.forbid();
  const before = f.counters();
  const missing: any = await f.integration.control.getDiagnostics!();
  assert.equal(missing.readiness.workspaceReady, false);
  assert.equal(missing.readiness.settingsReady, false);
  assert.equal(missing.failure.phase, "workspace_or_session_not_ready");
  assert.equal(missing.failure.code, "workspace_unavailable");
  assert.deepEqual(f.counters(), before);
});

test("literal repetitions, shadowed descriptors and cached resolved tokens stay private; teardown resets context", async (t) => {
  const f = await fixture(t, true);
  const secret = 'PRIVATE_LITERAL "quoted"';
  // A literal is resolved on boot; neither it nor repeated descriptor text may escape.
  f.config.secrets = [{ env: "TOKEN", textValue: secret, allowHosts: ["api.example.com"] }];
  f.config.image = `${f.config.image}${secret}`;
  await f.start();
  f.forbid();
  const before = f.counters();
  const result = await f.integration.control.getDiagnostics!();
  assert.ok(!JSON.stringify(result).includes("PRIVATE_LITERAL"));
  assert.deepEqual(f.counters(), before);
  f.integration.endSession();
  const ended: any = await f.integration.control.getDiagnostics!();
  assert.equal(ended.readiness.configReady, false);
  assert.equal(ended.desired.settings, undefined);
  assert.equal(ended.adoption.known, false);
});

test("failure projection accepts only fixed codes and never adapter failure prose", () => {
  const hostile = "PRIVATE_TOKEN".repeat(100_000);
  for (const code of [hostile, "toString", "__proto__", {}, undefined]) {
    const report: any = boundDiagnosticsReport({ outcome: "diagnosed", failure: { phase: "runtime_failure", code, reason: hostile } });
    assert.equal(report.failure.code, "unknown");
    assert.match(report.failure.reason, /cause unavailable/);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_TOKEN/);
    assert.ok(Buffer.byteLength(JSON.stringify(report)) < 48 * 1024);
  }
  const active: any = boundDiagnosticsReport({ outcome: "diagnosed", failure: { phase: "none", code: "native_sdk_unavailable", reason: hostile } });
  assert.equal(active.failure.code, "none");
  assert.equal(active.failure.reason, "No cached blocking failure.");
});

async function assertPassiveFailure(t: test.TestContext, f: Awaited<ReturnType<typeof fixture>>, code: string) {
  f.forbid();
  const before = f.counters();
  const state = structuredClone(f.integration.control.getState());
  const forbiddenCalls: string[] = [];
  for (const key of ["readFile", "stat", "lstat", "realpath", "access", "readdir", "mkdir", "writeFile", "open"] as const) {
    t.mock.method(fs, key, () => { forbiddenCalls.push(key); throw new Error("PRIVATE_IO_ERROR"); });
  }
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"] as const) {
    t.mock.method(childProcess, key, () => { forbiddenCalls.push(key); throw new Error("PRIVATE_COMMAND_ERROR"); });
  }
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 2; i++) {
      const report: any = await f.integration.control.getDiagnostics!();
      assert.equal(report.failure.phase, "runtime_failure");
      assert.equal(report.failure.code, code);
      assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|printf|TOKEN_SOURCE|credential=/);
      assert.ok(Buffer.byteLength(JSON.stringify(report)) < 48 * 1024);
      assert.match(report.recovery, /msb_config_set requires explicit approval/);
      assert.doesNotMatch(report.recovery, /separate explicit approval/);
    }
    assert.deepEqual(f.integration.control.getState(), state);
    assert.deepEqual(f.counters(), before);
    assert.deepEqual(forbiddenCalls, []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    f.allow();
  }
}

for (const stage of ["sdk", "start", "prepare"] as const) test(`cached ${stage} failure is actionable, private and passive`, async (t) => {
  const fault = { stage, enabled: true };
  const f = await fixture(t, true, fault);
  assert.equal((await f.start()).status, "unavailable");
  const code = stage === "sdk" ? "native_sdk_unavailable" : stage === "prepare" ? "runtime_preparation_failed" : "runtime_start_failed";
  await assertPassiveFailure(t, f, code);
  await f.integration.control.setEnabled(false);
  const off: any = await f.integration.control.getDiagnostics!();
  assert.equal(off.runtime.status, "off");
  assert.equal(off.failure.code, "none");
  assert.equal(off.failure.reason, "No cached blocking failure.");
  fault.enabled = false;
  if (stage === "sdk") {
    // Rejected SDK promise is cached: a new attempt must recapture its typed cause.
    assert.equal((await f.start()).status, "unavailable");
    await assertPassiveFailure(t, f, code);
  } else {
    assert.equal((await f.start()).status, "active");
    const recovered: any = await f.integration.control.getDiagnostics!();
    assert.equal(recovered.failure.code, "none");
    assert.equal(recovered.failure.reason, "No cached blocking failure.");
  }
  f.integration.endSession();
  const ended: any = await f.integration.control.getDiagnostics!();
  assert.notEqual(ended.failure.code, code);
});

for (const source of ["command-fails", "command-empty", "environment"] as const) test(`cached secret ${source} failure is passive and resets after success`, async (t) => {
  const f = await fixture(t, true);
  f.config.secrets = [{ env: "TOKEN", allowHosts: ["api.example.com"],
    ...(source === "environment" ? { hostEnv: "PRIVATE_TOKEN_SOURCE" }
      : { hostCmd: source === "command-fails" ? "printf PRIVATE_COMMAND_ERROR >&2; exit 1" : "printf ''" }) }];
  assert.equal((await f.start()).status, "unavailable");
  await assertPassiveFailure(t, f, source === "environment" ? "host_secret_environment_unavailable" : "host_secret_command_failed");
  f.config.secrets = [{ env: "TOKEN", allowHosts: ["api.example.com"], textValue: "PRIVATE_TOKEN" }];
  assert.equal((await f.start()).status, "active");
  f.forbid();
  const before = f.counters();
  const report: any = await f.integration.control.getDiagnostics!();
  assert.equal(report.failure.code, "none");
  assert.equal(report.failure.reason, "No cached blocking failure.");
  assert.deepEqual(f.counters(), before);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_/);
  f.integration.endSession();
  const ended: any = await f.integration.control.getDiagnostics!();
  assert.notEqual(ended.failure.code, "host_secret_command_failed");
  assert.notEqual(ended.failure.code, "host_secret_environment_unavailable");
});
