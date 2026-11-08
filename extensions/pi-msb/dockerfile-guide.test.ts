import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { DEFAULT_CONFIG, hostConfigPaths } from "./config.ts";
import { createMsbIntegration } from "./control.ts";
import { dockerfileGuidePaths, registerDockerfileGuideTool, type DockerfileGuidePaths } from "./dockerfile-guide.ts";
import { createSessionExecution, type MsbControl, type SessionExecutionContext } from "./types.ts";

function tool(control: Partial<MsbControl>, execution?: SessionExecutionContext) {
  let definition: any;
  registerDockerfileGuideTool({ registerTool(value: unknown) { definition = value; } } as any, control as MsbControl, execution);
  return definition;
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp("/tmp/pi-msb-guide-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const cwd = join(home, "Code", "app with 'quote");
  const agentDir = join(root, "agent with 'quote");
  await mkdir(cwd, { recursive: true });
  const input = { cwd, agentDir, env: { HOME: home }, projectTrusted: true, configDirName: ".pi" };
  return { root, home, cwd, agentDir, input };
}
async function tree(path: string): Promise<unknown> {
  return Promise.all((await readdir(path, { withFileTypes: true })).map(async (entry) => entry.isDirectory()
    ? [entry.name, await tree(join(path, entry.name))]
    : [entry.name, await readFile(join(path, entry.name), "utf8")]));
}

test("dockerfile-guide derives Global/Project locations for nested/outside-home cwd and symlink aliases", async (t) => {
  const f = await fixture(t);
  await mkdir(f.agentDir);
  const alias = join(f.root, "agent alias"); await symlink(f.agentDir, alias);
  const cwdAlias = join(f.root, "cwd alias"); await symlink(f.cwd, cwdAlias);
  const nested = join(f.cwd, "nested"); await mkdir(nested);
  const outside = join(f.root, "outside"); await mkdir(outside);
  for (const cwd of [f.cwd, cwdAlias, nested, outside]) {
    const input = { ...f.input, cwd, agentDir: alias };
    const paths = await dockerfileGuidePaths(input, await realpath(cwd), () => {});
    const expected = await hostConfigPaths(input);
    assert.equal(paths.agentDir, alias); assert.equal(paths.canonicalAgentDir, f.agentDir);
    for (const scope of ["global", "project"] as const) {
      assert.deepEqual(paths[scope], { config: expected[scope], dockerfile: join(dirname(expected[scope]), "Dockerfile"), buildContext: join(dirname(expected[scope]), "build-context") });
    }
    if (cwd === outside) assert.ok(paths.project.config.includes("/projects-absolute/"));
    else assert.ok(paths.project.config.includes("/projects/Code/app with 'quote/"));
    if (cwd === nested) assert.ok(paths.project.config.endsWith("/nested/config.toml"));
  }
});

test("dockerfile-guide recommends actual bundled digest, approved host calls and safe create-only shell quoting", async (t) => {
  const f = await fixture(t);
  const paths = await dockerfileGuidePaths(f.input, f.cwd, () => {});
  const d = tool({ async getDockerfileGuidePaths() { return paths; }, getEffectiveConfig() { throw new Error("must not resolve effective image"); } });
  const output = await d.execute("guide", {});
  assert.equal(output.details.outcome, "guided");
  assert.equal(output.details.baseImage, DEFAULT_CONFIG.image);
  assert.match(DEFAULT_CONFIG.image, /@sha256:[a-f0-9]{64}$/);
  assert.ok(output.details.minimalDockerfile.startsWith(`FROM ${DEFAULT_CONFIG.image}\n`));
  assert.match(output.details.minimalDockerfile, /apt-get install.*jq/);
  const text = output.content[0].text;
  for (const pattern of [/allowHostExecution/, /per-call user approval/, /no UI/, /human.*host editor/, /never-pull/, /Session image/, /Project overrides Global/, /runtime network deny/, /comment/, /build-context\/Dockerfile/]) assert.match(text, pattern);
  assert.equal(d.parameters.additionalProperties, false);
  for (const scope of ["global", "project"] as const) {
    const example = output.details.createOnlyExamples[scope];
    assert.equal(example.tool, "bash"); assert.equal(example.input.execution_target, "host");
    assert.equal(example.input.target, undefined);
    // Test the inert returned example explicitly, in disposable /tmp, never during getter execution.
    execFileSync("sh", ["-c", example.input.command], { stdio: "pipe" });
    assert.equal(await readFile(paths[scope].dockerfile, "utf8"), output.details.minimalDockerfile);
    assert.equal((await stat(paths[scope].dockerfile)).mode & 0o077, 0, "new Dockerfile must be private");
    assert.equal((await stat(dirname(paths[scope].dockerfile))).mode & 0o077, 0, "new policy directory must be private");
    await writeFile(paths[scope].dockerfile, "preserve existing\n");
    assert.throws(() => execFileSync("sh", ["-c", example.input.command], { stdio: "pipe" }));
    assert.equal(await readFile(paths[scope].dockerfile, "utf8"), "preserve existing\n");
    await rm(paths[scope].dockerfile);
    const danglingTarget = join(dirname(paths[scope].dockerfile), "must-not-create");
    await symlink(danglingTarget, paths[scope].dockerfile);
    assert.throws(() => execFileSync("sh", ["-c", example.input.command], { stdio: "pipe" }));
    await assert.rejects(stat(danglingTarget), { code: "ENOENT" });
    await rm(paths[scope].dockerfile);
    execFileSync("mkfifo", [paths[scope].dockerfile]);
    const attempt = spawnSync("sh", ["-c", example.input.command], { stdio: "pipe", timeout: 2_000 });
    assert.equal(attempt.error, undefined, "existing FIFO must fail without blocking");
    assert.notEqual(attempt.status, null);
    assert.notEqual(attempt.status, 0);
  }
});

test("dockerfile-guide native getter is passive off/blocked, without credential commands, approval, SDK or writes", async (t) => {
  const f = await fixture(t);
  let sdkLoads = 0;
  const paths = await hostConfigPaths(f.input);
  await mkdir(dirname(paths.global), { recursive: true });
  await writeFile(paths.global, 'cpus = 0\n[secrets.TOKEN]\nhost_cmd = "exit 99"\n');
  for (const off of [true, false]) {
    const integration = createMsbIntegration({ ...f.input, sessionId: "guide", env: { ...f.input.env, PI_MSB_DISABLE: off ? "1" : "0" }, sdkLoader: async () => { sdkLoads++; throw new Error("SDK forbidden"); } });
    const d = tool(integration.control, integration.provider.execution);
    assert.equal((await d.execute("early", {})).details.outcome, "unavailable");
    await integration.configureSession({ sessionId: "guide", cwd: f.cwd, projectTrusted: true });
    assert.equal(integration.control.getState().status, off ? "off" : "unavailable");
    const before = await tree(f.root);
    const ctx = { cwd: f.cwd, sessionManager: { getSessionId: () => "guide" }, ui: { select() { throw new Error("approval forbidden"); } }, hasUI: false, mode: "print" };
    const result = await d.execute("guide", {}, undefined, undefined, ctx);
    assert.equal(result.details.outcome, "guided");
    assert.equal(result.details.paths.project.config, paths.project);
    assert.deepEqual(await tree(f.root), before); assert.equal(sdkLoads, 0);
    assert.ok(!JSON.stringify(result).includes("exit 99"));
    const pending = d.execute("guide", {}, undefined, undefined, ctx);
    integration.endSession();
    const stale = await pending;
    assert.equal(stale.details.outcome, "unavailable"); assert.equal(stale.details.paths, undefined);
    assert.equal(stale.details.createOnlyExamples, undefined);
  }
});

test("dockerfile-guide rejects nonempty inputs without touching control and safely handles unavailable adapters", async () => {
  let calls = 0;
  const d = tool({ async getDockerfileGuidePaths() { calls++; throw new Error("private error"); } });
  for (const args of [null, [], "", { command: "private" }, { scope: "global" }, { [Symbol()]: 1 }]) {
    assert.equal((await d.execute("guide", args)).details.outcome, "rejected");
  }
  assert.equal(calls, 0);
  const missing = tool(new Proxy({}, { get(_t, key) { if (key === "getDockerfileGuidePaths") return undefined; throw new Error("other getters forbidden"); } }));
  for (const definition of [d, missing]) {
    const result = await definition.execute("guide", {});
    assert.equal(result.details.outcome, "unavailable"); assert.equal(result.details.paths, undefined);
    assert.equal(result.details.createOnlyExamples, undefined); assert.ok(!JSON.stringify(result).includes("private error"));
    assert.ok(Buffer.byteLength(result.content[0].text) < 48 * 1024);
  }
});

test("dockerfile-guide rejects a caller already belonging to another session or cwd", async (t) => {
  const f = await fixture(t);
  const execution = createSessionExecution("current", f.cwd);
  let calls = 0;
  const d = tool({ async getDockerfileGuidePaths() { calls++; throw new Error("must not inspect paths"); } }, execution.context);
  for (const [sessionId, cwd] of [["obsolete", f.cwd], ["current", f.root]]) {
    const ctx = { cwd, sessionManager: { getSessionId: () => sessionId } };
    const result = await d.execute("guide", {}, undefined, undefined, ctx);
    assert.equal(result.details.outcome, "unavailable");
    assert.equal(result.details.paths, undefined);
    assert.equal(result.details.createOnlyExamples, undefined);
  }
  assert.equal(calls, 0);
});

test("dockerfile-guide withholds paths after context supersession or cancellation across async work", async (t) => {
  const f = await fixture(t);
  const paths = await dockerfileGuidePaths(f.input, f.cwd, () => {});
  for (const change of ["context", "cancel", "execution"] as const) {
    let done!: (value: DockerfileGuidePaths) => void;
    const execution = createSessionExecution("one", f.cwd);
    const d = tool({ getDockerfileGuidePaths: () => new Promise((resolve) => { done = resolve; }) }, execution.context);
    let sessionId = "one";
    const ctx = { cwd: f.cwd, sessionManager: { getSessionId: () => sessionId } };
    const abort = new AbortController();
    const pending = d.execute("guide", {}, abort.signal, undefined, ctx);
    if (change === "cancel") abort.abort();
    else if (change === "context") sessionId = "two";
    else execution.begin("one", f.cwd); // Same values, new lifecycle reference identity.
    done(paths);
    const result = await pending;
    assert.equal(result.details.outcome, "unavailable"); assert.equal(result.details.paths, undefined);
  }
  let checks = 0;
  await assert.rejects(dockerfileGuidePaths(f.input, f.cwd, () => { if (++checks > 1) throw new Error("superseded"); }), /superseded/);
});

test("dockerfile-guide refuses workspace-enclosed policy, descendant symlinks, changed cwd and agent alias retarget", async (t) => {
  const f = await fixture(t);
  await assert.rejects(dockerfileGuidePaths({ ...f.input, cwd: f.root }, f.root, () => {}));
  await assert.rejects(dockerfileGuidePaths(f.input, f.root, () => {}), /identity changed/);
  await mkdir(f.agentDir, { recursive: true });
  const workspaceAlias = join(f.cwd, "agent-alias");
  await symlink(f.agentDir, workspaceAlias);
  await assert.rejects(dockerfileGuidePaths({ ...f.input, agentDir: workspaceAlias }, f.cwd, () => {}), /outside/);
  const integration = createMsbIntegration({ ...f.input, agentDir: workspaceAlias, sessionId: "unsafe-guide", env: { ...f.input.env, PI_MSB_DISABLE: "1" } });
  await integration.configureSession({ sessionId: "unsafe-guide", cwd: f.cwd, projectTrusted: true });
  const unavailable = await tool(integration.control, integration.provider.execution).execute("guide", {});
  assert.equal(unavailable.details.outcome, "unavailable");
  assert.equal(unavailable.details.paths, undefined);
  assert.equal(unavailable.details.createOnlyExamples, undefined);
  await integration.endSession();
  const paths = await hostConfigPaths(f.input);
  await mkdir(dirname(paths.global), { recursive: true });
  await symlink(f.cwd, join(dirname(paths.global), "build-context"));
  await assert.rejects(dockerfileGuidePaths(f.input, f.cwd, () => {}), /outside|symlink/);
  await rm(join(dirname(paths.global), "build-context"));
  const alias = join(f.root, "alias"); await symlink(f.agentDir, alias);
  const other = join(f.root, "other agent"); await mkdir(other);
  let retargeted = false;
  await assert.rejects(dockerfileGuidePaths({ ...f.input, agentDir: alias, realpath: async (path) => {
    const value = await realpath(path);
    if (path === alias && !retargeted) { retargeted = true; await rm(alias); await symlink(other, alias); }
    return value;
  } }, f.cwd, () => {}), /identity changed/);
});
