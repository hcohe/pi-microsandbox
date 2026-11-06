import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { fakeSdk } from "../../test/fake-msb-sdk.ts";
import { DEFAULT_CONFIG, parseTomlConfig } from "./config.ts";
import { createMsbIntegration, type MicrosandboxModule } from "./control.ts";
import type { Config, RuntimeState, SecretConfig } from "./types.ts";

interface CapturedSecret {
  env: string;
  value: string;
  tls: boolean[];
  hosts: string[];
  patterns: string[];
}

function captureSecrets(sdk: MicrosandboxModule, captured: CapturedSecret[], onValue?: (value: string) => void): void {
  const originalBuilder = sdk.Sandbox.builder;
  sdk.Sandbox.builder = (name: string) => {
    const builder = originalBuilder(name);
    builder.secret = (configure: (entry: any) => void) => {
      const secret: CapturedSecret = { env: "", value: "", tls: [], hosts: [], patterns: [] };
      captured.push(secret);
      const entry: any = {
        env(value: string) { secret.env = value; return entry; },
        value(value: string) { secret.value = value; onValue?.(value); return entry; },
        requireTlsIdentity(value: boolean) { secret.tls.push(value); return entry; },
        allowHost(value: string) { secret.hosts.push(value); return entry; },
        allowHostPattern(value: string) { secret.patterns.push(value); return entry; },
      };
      configure(entry);
      return builder;
    };
    return builder;
  };
}

async function fixture(t: test.TestContext, env: NodeJS.ProcessEnv = {}, logText = "") {
  const root = await mkdtemp("/tmp/pi-msb-control-secrets-");
  // Register cleanup immediately, including if fixture setup fails.
  let shutdown: (() => Promise<void>) | undefined;
  t.after(async () => {
    try { await shutdown?.(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const calls: string[] = [];
  const states: RuntimeState[] = [];
  const notifications: string[] = [];
  const sdk = fakeSdk(calls, undefined, logText);
  const sessionId = "control-secrets";
  const integration = createMsbIntegration({
    sessionId, cwd, agentDir: join(root, "agent"), configDirName: ".pi", env,
    sdkLoader: async () => sdk,
    locksPort: { tryAcquire: async () => ({ path: join(root, "prune.lock"), release: async () => undefined }) },
    acquireOwnerLock: async () => ({ path: join(root, "owner.lock"), release: async () => undefined }),
    onState: (state) => { states.push(structuredClone(state)); },
    notify: (message) => { notifications.push(message); },
  });
  shutdown = async () => {
    try { await integration.manager.shutdown(); }
    finally { integration.endSession(); }
  };
  const start = (secrets: SecretConfig[]) => {
    const config: Config = {
      ...(structuredClone(DEFAULT_CONFIG) as Config),
      autoStart: true,
      bootstrapTools: false,
      docker: { mode: "disabled", startupTimeoutMs: 15_000 },
      pruneOnStart: false,
      fallbackMode: "block",
      allowHostExecution: false,
      lockDir: join(root, "locks"),
      secrets,
    };
    return integration.configureSession({
      sessionId, cwd, projectTrusted: true,
      config: { config, provenance: {}, warnings: [] },
    });
  };
  return { root, calls, states, notifications, sdk, integration, start };
}

async function assertBlocked(f: Awaited<ReturnType<typeof fixture>>, state: RuntimeState, sensitive: string[]): Promise<void> {
  assert.equal(state.status, "unavailable");
  assert.equal(state.info, null);
  assert.equal(f.integration.control.getState().status, "unavailable");
  assert.equal(f.integration.manager.isActive(), false);
  assert.equal(f.integration.provider.isActive(), false);
  assert.equal(f.integration.configRef.value.fallbackMode, "block");
  assert.equal(f.integration.configRef.value.allowHostExecution, false);
  let called = false;
  await assert.rejects(f.integration.provider.withRuntime(async () => { called = true; }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /not available/);
    for (const value of sensitive) assert.ok(!error.message.includes(value), "runtime error leaked a secret or source");
    return true;
  });
  assert.equal(called, false);
  const visible = JSON.stringify({
    state, control: f.integration.control.getState(), manager: f.integration.manager.getState(),
    provider: f.integration.provider.getState(), states: f.states, notifications: f.notifications,
  });
  for (const value of sensitive) assert.ok(!visible.includes(JSON.stringify(value).slice(1, -1)), "visible state leaked a secret or source");
}

test("SDK receives $ENV and $FILE literal secret values verbatim", async (t) => {
  const f = await fixture(t, { LITERAL_HOST_TOKEN: "must-not-resolve-host-env" });
  const sourceFile = join(f.root, "literal-source");
  await writeFile(sourceFile, "must-not-read-host-file\n");
  const captured: CapturedSecret[] = [];
  captureSecrets(f.sdk, captured);
  const secrets: SecretConfig[] = [
    { env: "ENV_LITERAL", textValue: "$ENV:LITERAL_HOST_TOKEN", allowHosts: ["env.example.com"] },
    { env: "FILE_LITERAL", textValue: `$FILE:${sourceFile}`, allowHosts: ["file.example.com"] },
  ];
  assert.equal((await f.start(secrets)).status, "active");
  assert.deepEqual(captured.map(({ env, value }) => ({ env, value })), secrets.map(({ env, textValue }) => ({ env, value: textValue })));
  assert.equal(f.calls.filter((call) => call.startsWith("create:")).length, 1);
});

test("adopted agent projections expose host source metadata but hide literals and resolved tokens", async (t) => {
  const f = await fixture(t, { ADOPTED_HOST_ENV_PRIVATE: "ADOPTED_ENV_TOKEN_PRIVATE", ADOPTED_COMMAND_TOKEN: "ADOPTED_COMMAND_RESULT_PRIVATE" });
  const captured: CapturedSecret[] = [];
  captureSecrets(f.sdk, captured);
  const secrets: SecretConfig[] = [
    { env: "LITERAL", textValue: "$ENV:ADOPTED_LITERAL_PRIVATE", allowHosts: ["api.example"] },
    { env: "ENV_TOKEN", hostEnv: "ADOPTED_HOST_ENV_PRIVATE", allowHosts: ["api.example"] },
    { env: "CMD_TOKEN", hostCmd: 'printf %s "$ADOPTED_COMMAND_TOKEN"', allowHosts: ["api.example"] },
  ];
  assert.equal((await f.start(secrets)).status, "active");
  const runtime = f.integration.control.getRuntimePolicy!()!;
  const agent = f.integration.control.getAgentRuntimePolicy!()!;
  assert.equal(runtime.verification, "created");
  assert.deepEqual(parseTomlConfig(runtime.effectiveToml, "global").value.secrets, [
    { env: "LITERAL", textValue: "<redacted>", allowHosts: ["api.example"] },
    { env: "ENV_TOKEN", hostEnv: "<redacted>", allowHosts: ["api.example"] },
    { env: "CMD_TOKEN", hostCmd: "<redacted>", allowHosts: ["api.example"] },
  ]);
  assert.deepEqual(agent.settings.secrets, [
    { env: "LITERAL", allow_hosts: ["api.example"], text_value: "<redacted>" },
    { env: "ENV_TOKEN", allow_hosts: ["api.example"], host_env: "ADOPTED_HOST_ENV_PRIVATE" },
    { env: "CMD_TOKEN", allow_hosts: ["api.example"], host_cmd: 'printf %s "$ADOPTED_COMMAND_TOKEN"' },
  ]);
  assert.doesNotMatch(JSON.stringify({ runtime, agent }), /\$ENV:ADOPTED_LITERAL_PRIVATE|ADOPTED_ENV_TOKEN_PRIVATE|ADOPTED_COMMAND_RESULT_PRIVATE/);
  assert.deepEqual(captured.map(({ value }) => value), ["$ENV:ADOPTED_LITERAL_PRIVATE", "ADOPTED_ENV_TOKEN_PRIVATE", "ADOPTED_COMMAND_RESULT_PRIVATE"]);
});

test("hostEnv uses options.env and diagnostics redact both startup and changed values", async (t) => {
  const source = "PI_MSB_RUNTIME_HOST_ENV";
  const startupToken = "HOST_ENV_STARTUP_PRIVATE";
  const currentToken = "HOST_ENV_CURRENT_PRIVATE";
  const env = { [source]: startupToken };
  const diagnostic = `environment diagnostic: ${startupToken} / ${currentToken} / ${source}`;
  const f = await fixture(t, env, diagnostic);
  const captured: CapturedSecret[] = [];
  captureSecrets(f.sdk, captured);
  assert.equal((await f.start([{ env: "TOKEN", hostEnv: source, allowHosts: ["api.example.com"] }])).status, "active");
  assert.equal(captured[0]?.value, startupToken);
  env[source] = currentToken;
  assert.equal(await f.integration.control.getLogs(100), "environment diagnostic: [REDACTED] / [REDACTED] / [REDACTED]");
  f.sdk.Sandbox.listWith = async () => { throw new Error(diagnostic); };
  const report = await f.integration.control.pruneNow();
  assert.ok(report.errors.length > 0);
  assert.match(report.errors.join(" "), /environment diagnostic: \[REDACTED\] \/ \[REDACTED\] \/ \[REDACTED\]/);
});

test("real hostCmd stdout preserves token whitespace, requires TLS destinations, and runs only at startup", async (t) => {
  const startupToken = "  HOST_COMMAND_STARTUP_PRIVATE\nsecond line \t";
  const env: NodeJS.ProcessEnv = {};
  const f = await fixture(t, env, `command diagnostic: ${startupToken}`);
  const tokenFile = join(f.root, "command-token");
  const counterFile = join(f.root, "command-runs");
  await writeFile(tokenFile, `${startupToken}\r\n\n`);
  env.HOST_TOKEN_FILE = tokenFile;
  env.HOST_COUNTER_FILE = counterFile;
  // Real host shell expansion, redirection and stdout; stderr is not the token.
  const hostCmd = 'printf "run\\n" >> "$HOST_COUNTER_FILE"; printf "ignored stderr" >&2; cat "$HOST_TOKEN_FILE"';
  const captured: CapturedSecret[] = [];
  captureSecrets(f.sdk, captured);
  assert.equal((await f.start([{
    env: "COMMAND_TOKEN", hostCmd,
    allowHosts: ["api.example.com", "*.service.example.com", "other.example.com"],
  }])).status, "active");
  assert.deepEqual(captured, [{
    env: "COMMAND_TOKEN", value: startupToken, tls: [true],
    hosts: ["api.example.com", "other.example.com"], patterns: ["*.service.example.com"],
  }]);
  assert.equal(await readFile(counterFile, "utf8"), "run\n");
  // If a diagnostic resolves the command again, it both increments the counter
  // and gets a different value, which cannot redact the original startup token.
  await writeFile(tokenFile, "CHANGED_COMMAND_PRIVATE\n");
  for (let i = 0; i < 2; i++) {
    assert.equal(await f.integration.control.getLogs(100), "command diagnostic: [REDACTED]");
  }
  f.sdk.Sandbox.listWith = async () => { throw new Error(`prune diagnostic: ${startupToken} / ${hostCmd}`); };
  for (let i = 0; i < 2; i++) {
    const report = await f.integration.control.pruneNow();
    assert.ok(report.errors.length > 0);
    assert.match(report.errors.join(" "), /prune diagnostic: \[REDACTED\] \/ \[REDACTED\]/);
  }
  assert.equal(await readFile(counterFile, "utf8"), "run\n");
  assert.ok(!f.calls.some((call) => call.includes(hostCmd)), "hostCmd must not execute through the guest SDK");
});

for (const failure of ["nonzero exit", "empty token"] as const) {
  test(`hostCmd startup ${failure} fails closed with sanitized state`, async (t) => {
    const token = "FAILED_COMMAND_OUTPUT_PRIVATE";
    const f = await fixture(t, { FAILED_COMMAND_TOKEN: token, PI_MSB_FALLBACK_MODE: "host" });
    const hostCmd = failure === "nonzero exit"
      ? 'printf "%s\\n" "$FAILED_COMMAND_TOKEN"; printf "%s\\n" "$FAILED_COMMAND_TOKEN" >&2; exit 17'
      : 'printf "\\r\\n\\n"';
    const captured: CapturedSecret[] = [];
    captureSecrets(f.sdk, captured);
    const state = await f.start([{ env: "TOKEN", hostCmd, allowHosts: ["api.example.com"] }]);
    await assertBlocked(f, state, [token, hostCmd]);
    assert.match(state.reason!, /host secret command failed/);
    assert.deepEqual(captured, []);
    assert.ok(!f.calls.some((call) => /^(create|exec):/.test(call)));
  });
}

test("session teardown retains resolved command tokens until cleanup errors are sanitized", async (t) => {
  const token = "SESSION_CLEANUP_PRIVATE_TOKEN";
  const f = await fixture(t, { CLEANUP_TOKEN: token });
  assert.equal((await f.start([{ env: "TOKEN", hostCmd: 'printf "%s" "$CLEANUP_TOKEN"', allowHosts: ["api.example.com"] }])).status, "active");
  f.sdk.Sandbox.get = async () => { throw new Error(`cleanup rejected ${token}`); };
  f.integration.endSession();
  await f.integration.manager.shutdown();
  assert.equal(f.integration.manager.getState().status, "unavailable");
  assert.equal(f.integration.manager.getState().reason, "cleanup rejected [REDACTED]");
});

for (const source of ["hostEnv", "hostCmd"] as const) {
  for (const stage of ["create", "secret-builder"] as const) {
    test(`SDK ${stage} failure redacts the ${source} descriptor and resolved token`, async (t) => {
      const token = "RESOLVED_SDK_FAILURE_PRIVATE";
      const descriptor = source === "hostEnv"
        ? "SDK_FAILURE_HOST_ENV_SOURCE"
        : 'printf "%s\\n" "$SDK_FAILURE_HOST_COMMAND_TOKEN"';
      const env = source === "hostEnv" ? { [descriptor]: token } : { SDK_FAILURE_HOST_COMMAND_TOKEN: token };
      const f = await fixture(t, env);
      const captured: CapturedSecret[] = [];
      const message = `SDK ${stage} rejected ${token}; source ${descriptor}; repeated ${token}`;
      captureSecrets(f.sdk, captured, stage === "secret-builder" ? (value) => {
        assert.equal(value, token);
        throw new Error(message);
      } : undefined);
      if (stage === "create") {
        const originalBuilder = f.sdk.Sandbox.builder;
        f.sdk.Sandbox.builder = (name: string) => {
          const builder = originalBuilder(name);
          builder.create = async () => { throw new Error(message); };
          return builder;
        };
      }
      const secret: SecretConfig = { env: "TOKEN", [source]: descriptor, allowHosts: ["api.example.com"] };
      const state = await f.start([secret]);
      assert.equal(captured[0]?.value, token);
      await assertBlocked(f, state, [token, descriptor]);
      assert.match(state.reason!, new RegExp(`SDK ${stage} rejected \\[REDACTED\\]; source \\[REDACTED\\]; repeated \\[REDACTED\\]`));
    });
  }
}
