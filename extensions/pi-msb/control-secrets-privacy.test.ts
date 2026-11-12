import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { fakeSdk } from "../../test/fake-msb-sdk.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { createMsbIntegration, type MsbIntegration } from "./control.ts";
import type { Config, RuntimeState } from "./types.ts";

const unavailable = "Diagnostic unavailable: startup secret tokens are unavailable for redaction.";
const escaped = (value: string) => JSON.stringify(value).slice(1, -1);

async function fixture(t: test.TestContext) {
  const root = await mkdtemp("/tmp/pi-msb-control-secrets-privacy-");
  const integrations: MsbIntegration[] = [];
  const entries: unknown[] = [];
  t.after(async () => {
    try {
      for (const integration of integrations.reverse()) {
        try { await integration.manager.shutdown(); }
        finally { integration.endSession(); }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const counter = join(root, "command-runs");
  const token = 'PRIVATE_STARTUP_TOKEN "quoted"\nsecond\tline\\suffix';
  const hostCmd = 'printf "run\\n" >> "$PRIVACY_COUNTER"\nprintf "%s\\n" "$PRIVACY_TOKEN"';
  // Neither escaped representation contains the raw value: raw-only redaction
  // must not accidentally satisfy these regressions.
  assert.notEqual(escaped(token), token);
  assert.notEqual(escaped(hostCmd), hostCmd);
  const diagnostic = `private diagnostic: token=${escaped(token)}; command=${escaped(hostCmd)}`;
  const sanitized = "private diagnostic: token=[REDACTED]; command=[REDACTED]";
  const calls: string[] = [];
  const states: RuntimeState[] = [];
  const notifications: string[] = [];
  const captured: string[] = [];
  const sdk = fakeSdk(calls, undefined, diagnostic);
  const originalBuilder = sdk.Sandbox.builder;
  sdk.Sandbox.builder = (name: string) => {
    const builder = originalBuilder(name);
    const originalSecret = builder.secret.bind(builder);
    builder.secret = (configure: (entry: any) => void) => originalSecret((entry: any) => {
      const originalValue = entry.value.bind(entry);
      entry.value = (value: string) => { captured.push(value); return originalValue(value); };
      configure(entry);
    });
    return builder;
  };
  const sessionId = "control-secrets-privacy";
  const config: Config = {
    ...(structuredClone(DEFAULT_CONFIG) as Config),
    autoStart: true,
    bootstrapTools: false,
    docker: { mode: "disabled", startupTimeoutMs: 15_000 },
    pruneOnStart: false,
    fallbackMode: "block",
    allowHostExecution: false,
    lockDir: join(root, "locks"),
    secrets: [{ env: "TOKEN", hostCmd, allowHosts: ["api.example.com"] }],
  };
  const createIntegration = () => {
    const integration = createMsbIntegration({
      sessionId, cwd, agentDir: join(root, "agent"), configDirName: ".pi",
      env: { PRIVACY_TOKEN: token, PRIVACY_COUNTER: counter },
      sdkLoader: async () => sdk,
      entries: () => entries,
      appendEntry: (customType, data) => { entries.push({ type: "custom", customType, data }); },
      locksPort: { tryAcquire: async () => ({ path: join(root, "prune.lock"), release: async () => undefined }) },
      acquireOwnerLock: async () => ({ path: join(root, "owner.lock"), release: async () => undefined }),
      onState: (state) => { states.push(structuredClone(state)); },
      notify: (message) => { notifications.push(message); },
    });
    integrations.push(integration);
    return integration;
  };
  const start = (integration: MsbIntegration) => integration.configureSession({
    sessionId, cwd, projectTrusted: true,
    config: { config: structuredClone(config), provenance: {}, warnings: [] },
  });
  const assertPrivate = (text: string) => {
    for (const value of [token, hostCmd]) {
      assert.ok(!text.includes(value), "raw secret or command leaked");
      assert.ok(!text.includes(escaped(value)), "JSON-escaped secret or command leaked");
    }
  };
  return { calls, states, notifications, captured, sdk, token, hostCmd, diagnostic, sanitized, counter, createIntegration, start, assertPrivate };
}

test("fresh reconnect with hostCmd withholds diagnostics without rerunning the command", async (t) => {
  const f = await fixture(t);
  const original = f.createIntegration();
  const created = await f.start(original);
  assert.equal(created.status, "active");
  assert.deepEqual(f.captured, [f.token]);
  assert.equal(await readFile(f.counter, "utf8"), "run\n");
  original.endSession(); // Leave the fake VM running, but discard startup tokens.

  const fresh = f.createIntegration();
  const reconnected = await f.start(fresh);
  assert.equal(reconnected.status, "active");
  assert.equal(reconnected.info?.name, created.info?.name);
  assert.ok(f.calls.includes(`connect:${created.info!.name}`));
  assert.equal(f.calls.filter((call) => call.startsWith("create:")).length, 1);
  assert.deepEqual(f.captured, [f.token], "reconnect must not rebuild secrets");
  const handle = await f.sdk.Sandbox.get(reconnected.info!.name);
  let logReads = 0;
  handle.logs = async () => { logReads++; return [{ text: () => f.diagnostic }]; };
  for (let i = 0; i < 2; i++) assert.equal(await fresh.control.getLogs(100), unavailable);
  assert.equal(logReads, 2, "exercise actual log retrieval, not an inactive runtime");

  handle.logs = async () => { throw new Error(f.diagnostic); };
  await assert.rejects(fresh.control.getLogs(100), { message: unavailable });
  f.sdk.Sandbox.listWith = async () => { throw new Error(f.diagnostic); };
  const report = await fresh.control.pruneNow();
  assert.deepEqual(report.errors, [unavailable]);
  assert.equal(await readFile(f.counter, "utf8"), "run\n", "diagnostics must never rerun hostCmd");
});

for (const stage of ["secret-builder", "create"] as const) {
  test(`SDK ${stage} failure redacts JSON-escaped multiline token and hostCmd`, async (t) => {
    const f = await fixture(t);
    const originalBuilder = f.sdk.Sandbox.builder;
    f.sdk.Sandbox.builder = (name: string) => {
      const builder = originalBuilder(name);
      if (stage === "create") builder.create = async () => { throw new Error(f.diagnostic); };
      else {
        const originalSecret = builder.secret.bind(builder);
        builder.secret = (configure: (entry: any) => void) => originalSecret((entry: any) => {
          const originalValue = entry.value.bind(entry);
          entry.value = (value: string) => {
            originalValue(value);
            throw new Error(f.diagnostic);
          };
          configure(entry);
        });
      }
      return builder;
    };
    const integration = f.createIntegration();
    const state = await f.start(integration);
    assert.deepEqual(f.captured, [f.token]);
    assert.equal(state.status, "unavailable");
    assert.equal(state.info, null);
    assert.equal(state.reason, f.sanitized);
    assert.equal(integration.manager.isActive(), false);
    assert.equal(integration.provider.isActive(), false);
    for (const visible of [state, integration.control.getState(), integration.manager.getState(), integration.provider.getState(), ...f.states]) {
      f.assertPrivate(visible.reason ?? "");
    }
    for (const message of f.notifications) f.assertPrivate(message);
    assert.equal(await readFile(f.counter, "utf8"), "run\n");
  });
}

test("getLogs and prune redact JSON-escaped startup token and command without resolving again", async (t) => {
  const f = await fixture(t);
  const integration = f.createIntegration();
  assert.equal((await f.start(integration)).status, "active");
  assert.deepEqual(f.captured, [f.token]);
  f.sdk.Sandbox.listWith = async () => { throw new Error(f.diagnostic); };
  for (let i = 0; i < 2; i++) {
    const logs = await integration.control.getLogs(100);
    assert.equal(logs, f.sanitized);
    f.assertPrivate(logs);
    const report = await integration.control.pruneNow();
    assert.equal(report.errors.length, 1);
    assert.ok(report.errors[0]!.includes(f.sanitized));
    for (const text of [...report.errors, ...report.removed, ...report.kept]) f.assertPrivate(text);
  }
  assert.equal(await readFile(f.counter, "utf8"), "run\n");
});

test("log retrieval rejection redacts JSON-escaped startup token and command", async (t) => {
  const f = await fixture(t);
  const integration = f.createIntegration();
  const state = await f.start(integration);
  assert.equal(state.status, "active");
  const handle = await f.sdk.Sandbox.get(state.info!.name);
  handle.logs = async () => { throw new Error(f.diagnostic); };
  await assert.rejects(integration.control.getLogs(100), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, f.sanitized);
    f.assertPrivate(error.message);
    return true;
  });
  assert.equal(await readFile(f.counter, "utf8"), "run\n");
});
