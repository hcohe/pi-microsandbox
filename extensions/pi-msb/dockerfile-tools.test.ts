import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_CONFIG, hostConfigPaths, hostConfigTargets, readRawConfig, resolveConfig } from "./config.ts";
import { SettingsEditor } from "./settings.ts";
import { createMsbIntegration } from "./control.ts";
import { dockerfilePaths, DOCKERFILE_MAX_BYTES, openDockerfile } from "./dockerfile-storage.ts";
import { registerDockerfileTools } from "./dockerfile-tools.ts";
import { createSessionExecution, type MsbControl } from "./types.ts";
import { buildSdk } from "../../test/image-build-fixture.ts";

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/pi-msb-dockerfile-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = join(root, "home", "Code", "app with 'quote");
  const agentDir = join(root, "agent with 'quote");
  await fs.mkdir(cwd, { recursive: true });
  const input = { cwd, agentDir, env: { HOME: join(root, "home") }, projectTrusted: true, configDirName: ".pi" };
  const execution = createSessionExecution("dockerfile", cwd);
  let destination = "worktree";
  let duringDestination: (() => Promise<void>) | undefined;
  const editor = new SettingsEditor(input, "dockerfile");
  let answer: string | undefined = "Yes", approvals = 0, reloads = 0, question = "";
  let duringApproval: (() => Promise<void>) | undefined;
  let failReload = false;
  let busy = false;
  const control = {
    openDockerfile: (scope: "project" | "global", destination?: "repository" | "worktree") => openDockerfile(input, cwd, scope, () => {}, [], destination),
    settings: { projectDestinations: () => editor.projectDestinations(), reviewState: () => editor.reviewState(), acquireInteraction() {
      if (busy) return undefined; busy = true;
      return { signal: new AbortController().signal, release() { busy = false; } };
    } },
    getState: () => ({ status: "disabled", info: null }),
    getEffectiveConfig: () => ({ config: DEFAULT_CONFIG, provenance: {}, warnings: [] }),
    async reload(options: any) { reloads++; assert.equal(options.allowRestart, true); await options.guard(); if (failReload) throw new Error("private host error"); },
  } as unknown as MsbControl;
  const definitions = new Map<string, any>();
  registerDockerfileTools({ registerTool(value: any) { definitions.set(value.name, value); } } as any, control, execution.context);
  const ctx: any = { cwd, hasUI: true, mode: "rpc", sessionManager: { getSessionId: () => "dockerfile" }, ui: {
    async select(text: string, choices: string[]) {
      approvals++; question = text; assert.equal(choices[0], "No");
      await duringDestination?.(); await duringApproval?.();
      if (answer !== "Yes") return answer;
      if (choices.length === 3) return destination === "cancel" ? "No" : choices.find((choice) => choice.startsWith(destination === "repository" ? "All worktrees" : "This worktree"));
      assert.match(choices[1]!, /^Apply/); return choices[1]; },
  } };
  const run = async (set: boolean, args: unknown, signal?: AbortSignal) => (await definitions.get(set ? "msb_dockerfile_set" : "msb_dockerfile_get").execute("test", args, signal, undefined, ctx)).details;
  return { root, cwd, agentDir, input, execution, control, definitions, ctx, run,
    configure(options: { answer?: string; duringApproval?: () => Promise<void>; failReload?: boolean; destination?: string; duringDestination?: () => Promise<void> }) {
      destination = options.destination ?? destination; duringDestination = options.duringDestination;
      answer = options.answer; duringApproval = options.duringApproval; failReload = options.failReload ?? false;
    }, counts: () => ({ approvals, reloads }), question: () => question };
}
const from = `FROM ${DEFAULT_CONFIG.image}\n`;
async function tree(path: string): Promise<unknown> {
  return Promise.all((await fs.readdir(path, { withFileTypes: true })).map(async (entry) => entry.isDirectory()
    ? [entry.name, await tree(join(path, entry.name))] : [entry.name, await fs.readFile(join(path, entry.name), "utf8")]));
}

test("dockerfile-storage paths use current authoritative Project mapping for nested/outside-home cwd and aliases", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.agentDir);
  const alias = join(f.root, "agent alias"); await fs.symlink(f.agentDir, alias);
  const cwdAlias = join(f.root, "cwd alias"); await fs.symlink(f.cwd, cwdAlias);
  const nested = join(f.cwd, "nested"); await fs.mkdir(nested);
  const outside = join(f.root, "outside"); await fs.mkdir(outside);
  for (const cwd of [f.cwd, cwdAlias, nested, outside]) {
    const input = { ...f.input, cwd, agentDir: alias };
    const paths = await dockerfilePaths(input, await fs.realpath(cwd), () => {});
    const expected = await hostConfigPaths(input);
    assert.equal(paths.agentDir, alias); assert.equal(paths.canonicalAgentDir, f.agentDir);
    for (const scope of ["project", "global"] as const) assert.deepEqual(paths[scope], {
      config: expected[scope], dockerfile: join(dirname(expected[scope]), "Dockerfile"), buildContext: join(dirname(expected[scope]), "build-context"),
    });
  }
});

for (const scope of ["project", "global"] as const) test(`dockerfile get/set ${scope}: missing/pin/content, approval-bound create/update, no-op preserves mode/mtime`, async (t) => {
  const f = await fixture(t); const before = await tree(f.root);
  const missing = await f.run(false, { scope });
  assert.equal(missing.outcome, "inspected"); assert.equal(missing.exists, false); assert.equal(missing.content, null);
  assert.equal(missing.baseImage, DEFAULT_CONFIG.image); assert.ok(missing.minimalDockerfile.startsWith(from));
  assert.equal(missing.minimalDockerfile, from);
  assert.deepEqual(await tree(f.root), before); assert.deepEqual(f.counts(), { approvals: 0, reloads: 0 });
  const result = await f.run(true, { scope, content: from });
  assert.equal(result.saved, true); assert.equal(result.reloaded, true); assert.equal(result.outcome, "saved_shadowed");
  const path = missing.paths[scope].dockerfile;
  assert.equal(await fs.readFile(path, "utf8"), from);
  assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(dirname(path))).mode & 0o777, 0o700);
  await assert.rejects(fs.stat(missing.paths[scope].config), { code: "ENOENT" });
  assert.match(f.question(), /Scope: Global|Scope: Project · cwd-local/);
  assert.ok(!f.question().includes(path), "long canonical paths belong in optional TUI details/getter, not main review");
  for (const pattern of [/Dockerfile \[create\]/, /\+FROM /]) assert.match(f.question(), pattern);
  assert.doesNotMatch(f.question(), /--- \/dev\/null|\+\+\+ b\/Dockerfile|@@|public network|restart|guest-local state/);
  const read = await f.run(false, { scope }); assert.equal(read.content, from); assert.equal(read.exists, true);
  await fs.chmod(path, 0o640); const stat = await fs.stat(path);
  assert.equal((await f.run(true, { scope, content: from })).outcome, "no_op");
  assert.equal((await fs.stat(path)).mtimeMs, stat.mtimeMs); assert.equal((await fs.stat(path)).mode, stat.mode);
  assert.deepEqual(f.counts(), { approvals: 1, reloads: 1 });
  assert.equal((await f.run(true, { scope, content: from + "# updated\n" })).saved, true);
  assert.ok(!f.question().includes(` ${from.split("\n")[0]}`), "unchanged FROM stays in details, not main review"); assert.ok(f.question().includes("+# updated"));
  assert.equal(await fs.readFile(path, "utf8"), from + "# updated\n");
  assert.deepEqual(f.counts(), { approvals: 2, reloads: 2 });
});

for (const deny of ["No", undefined, "noUI", "cancel"] as const) test(`dockerfile setter ${deny ?? "dismissed"}: no writes/directories/reload`, async (t) => {
  const f = await fixture(t); const before = await tree(f.root); const abort = new AbortController();
  if (deny === "noUI") f.ctx.hasUI = false;
  f.configure({ answer: deny === "cancel" ? "Yes" : deny, duringApproval: async () => { if (deny === "cancel") abort.abort(); } });
  const result = await f.run(true, { scope: "global", content: from }, abort.signal);
  assert.ok(["cancelled", "rejected"].includes(result.outcome)); assert.equal(result.saved, false);
  assert.deepEqual(await tree(f.root), before); assert.equal(f.counts().reloads, 0);
});

for (const conflict of ["file", "same-content-inode", "cwd", "session", "execution", "agent-alias", "parent", "missing-parent", "config", "context"] as const) test(`dockerfile setter rejects postapproval ${conflict} conflict`, async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.agentDir);
  const alias = join(f.root, "agent alias"); await fs.symlink(f.agentDir, alias);
  f.input.agentDir = alias;
  const paths = await hostConfigPaths(f.input); const path = join(dirname(paths.project), "Dockerfile");
  if (conflict !== "missing-parent") { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, from); }
  f.configure({ answer: "Yes", duringApproval: async () => {
    if (conflict === "file") await fs.writeFile(path, "# external edit\n");
    if (conflict === "same-content-inode") { await fs.unlink(path); await fs.writeFile(path, from); }
    if (conflict === "cwd") { await fs.rename(f.cwd, f.cwd + "-old"); await fs.mkdir(f.cwd); }
    if (conflict === "session") f.ctx.sessionManager.getSessionId = () => "other";
    if (conflict === "execution") f.execution.begin("dockerfile", f.cwd);
    if (conflict === "agent-alias") { await fs.unlink(alias); const other = join(f.root, "other"); await fs.mkdir(other); await fs.symlink(other, alias); }
    if (conflict === "parent") { await fs.rename(dirname(path), dirname(path) + "-old"); await fs.mkdir(dirname(path)); await fs.writeFile(path, from); }
    if (conflict === "missing-parent") await fs.mkdir(dirname(path), { recursive: true });
    if (conflict === "config") await fs.writeFile(paths.project, "cpus=2\n");
    if (conflict === "context") { await fs.mkdir(join(dirname(path), "build-context")); await fs.writeFile(join(dirname(path), "build-context", "new"), "new"); }
  } });
  const result = await f.run(true, { scope: "project", content: from + "# proposal\n" });
  assert.equal(result.outcome, "conflict", JSON.stringify(result)); assert.equal(result.saved, false); assert.equal(f.counts().reloads, 0);
  const content = await fs.readFile(path, "utf8").catch(() => null);
  assert.notEqual(content, from + "# proposal\n");
});

test("dockerfile bounds and UTF-8 reject without truncated original/review or writes", async (t) => {
  const f = await fixture(t); const paths = await hostConfigPaths(f.input); const path = join(dirname(paths.global), "Dockerfile");
  await fs.mkdir(dirname(path), { recursive: true });
  for (const content of ["x".repeat(DOCKERFILE_MAX_BYTES + 1), "é".repeat(DOCKERFILE_MAX_BYTES), "\ud800", "bad\x1b[2J", "bad\u202e", "\0"]) {
    assert.equal((await f.run(true, { scope: "global", content })).outcome, "rejected");
  }
  for (const data of [Buffer.alloc(DOCKERFILE_MAX_BYTES + 1, 65), Buffer.from([0xff, 0xfe]), Buffer.from("bad\0")]) {
    await fs.writeFile(path, data);
    const read = await f.run(false, { scope: "global" });
    assert.equal(read.content, null); assert.equal(read.exists, true); assert.equal(read.bytes, data.length); assert.ok(read.reason);
    assert.equal((await f.run(true, { scope: "global", content: from })).outcome, "rejected");
    assert.deepEqual(await fs.readFile(path), data);
  }
  assert.deepEqual(f.counts(), { approvals: 0, reloads: 0 });
  const exact = "#" + "é".repeat((DOCKERFILE_MAX_BYTES - 2) / 2) + "\n";
  assert.equal(Buffer.byteLength(exact), DOCKERFILE_MAX_BYTES);
  await fs.writeFile(path, exact);
  assert.equal((await f.run(false, { scope: "global" })).content, exact);
});

for (const unsafe of ["symlink", "hardlink", "directory", "fifo", "parent-link", "workspace", "mount"] as const) test(`dockerfile-storage rejects unsafe ${unsafe}`, async (t) => {
  const f = await fixture(t); const paths = await hostConfigPaths(f.input); const path = join(dirname(paths.global), "Dockerfile");
  await fs.mkdir(dirname(path), { recursive: true });
  const other = join(f.root, "other"); await fs.writeFile(other, from);
  if (unsafe === "symlink") await fs.symlink(other, path);
  if (unsafe === "hardlink") await fs.link(other, path);
  if (unsafe === "directory") await fs.mkdir(path);
  if (unsafe === "fifo") execFileSync("mkfifo", [path]);
  if (unsafe === "parent-link") { await fs.rm(dirname(path), { recursive: true }); await fs.symlink(f.cwd, dirname(path)); }
  if (unsafe === "workspace") f.input.agentDir = join(f.cwd, "agent");
  if (unsafe === "mount") {
    await assert.rejects(openDockerfile(f.input, f.cwd, "global", () => {}, [{ type: "dir", hostPath: f.root, guestPath: "/outside", readonly: false, options: [] }]));
  } else {
    assert.equal((await f.run(false, { scope: "global" })).outcome, "unavailable");
    assert.equal((await f.run(true, { scope: "global", content: from })).saved, false);
  }
  assert.deepEqual(f.counts(), { approvals: 0, reloads: 0 }); assert.equal(await fs.readFile(other, "utf8"), from);
});

test("dockerfile tools reject schema tampering/session mismatch without backend calls", async (t) => {
  const f = await fixture(t); let calls = 0;
  f.control.openDockerfile = async () => { calls++; throw new Error("PRIVATE error\x1b"); };
  for (const set of [false, true]) {
    for (const args of [null, [], {}, { scope: "session", content: from }, { scope: "project", path: "arbitrary", content: from }, { scope: "global", content: from, command: "x" }, { scope: "global", [Symbol()]: true }]) {
      assert.equal((await f.run(set, args)).outcome, "rejected");
    }
    assert.equal(f.definitions.get(set ? "msb_dockerfile_set" : "msb_dockerfile_get").parameters.additionalProperties, false);
  }
  assert.equal(calls, 0);
  f.ctx.cwd = f.root;
  assert.equal((await f.run(false, { scope: "global" })).outcome, "unavailable"); assert.equal(calls, 0);
  f.ctx.cwd = f.cwd;
  const error = await f.run(false, { scope: "global" }); assert.ok(!JSON.stringify(error).includes("PRIVATE"));
});

test("dockerfile getter native integration passive Off/blocked with invalid config and no SDK/approval/writes", async (t) => {
  const f = await fixture(t); const paths = await hostConfigPaths(f.input); await fs.mkdir(dirname(paths.global), { recursive: true });
  await fs.writeFile(paths.global, 'cpus=0\n[secrets.TOKEN]\nhost_cmd="exit 99"\n');
  for (const off of [true, false]) {
    let loads = 0;
    const integration = createMsbIntegration({ ...f.input, sessionId: "dockerfile", env: { ...f.input.env, PI_MSB_DISABLE: off ? "1" : "0" }, sdkLoader: async () => { loads++; throw new Error("Forbidden"); } });
    t.after(() => integration.endSession());
    const defs: any[] = []; registerDockerfileTools({ registerTool(d: any) { defs.push(d); } } as any, integration.control, integration.provider.execution);
    const getter = defs[0];
    assert.equal((await getter.execute("early", { scope: "project" })).details.outcome, "unavailable");
    await integration.configureSession({ sessionId: "dockerfile", cwd: f.cwd, projectTrusted: true });
    const before = await tree(f.root);
    const result = await getter.execute("get", { scope: "project" }, undefined, undefined, f.ctx);
    assert.equal(result.details.outcome, "inspected"); assert.equal(loads, 0); assert.deepEqual(await tree(f.root), before);
    assert.ok(!JSON.stringify(result).includes("exit 99"));
    const pending = getter.execute("get", { scope: "project" }, undefined, undefined, f.ctx); integration.endSession();
    assert.equal((await pending).details.outcome, "unavailable");
  }
});

for (const failure of [false, true]) test(`dockerfile setter integration builds and reloads new image; build failure=${failure}`, async (t) => {
  const f = await fixture(t); const calls: string[] = [];
  const paths = await hostConfigPaths(f.input); await fs.mkdir(dirname(paths.project), { recursive: true });
  await fs.writeFile(paths.project, 'prune_on_start=false\n[docker]\nmode="disabled"\n');
  const path = join(dirname(paths.project), "Dockerfile"); await fs.writeFile(path, from);
  let fail = false;
  const sdk = buildSdk(calls, { build: async () => { if (fail) throw new Error("PRIVATE build error"); } });
  const integration = createMsbIntegration({ ...f.input, sessionId: "dockerfile", sdkLoader: async () => sdk,
    acquireOwnerLock: async () => ({ path: "test", release: async () => {} }), locksPort: { tryAcquire: async () => null } });
  t.after(() => integration.manager.shutdown());
  assert.equal((await integration.configureSession({ sessionId: "dockerfile", cwd: f.cwd, projectTrusted: true })).status, "active");
  const previous = integration.control.getEffectiveConfig().config.image;
  const count = calls.filter((call) => call.startsWith("create:")).length;
  const defs: any[] = []; registerDockerfileTools({ registerTool(d: any) { defs.push(d); } } as any, integration.control, integration.provider.execution);
  fail = failure;
  const result = (await defs[1].execute("set", { scope: "project", content: from + "# changed\n" }, undefined, undefined, f.ctx)).details;
  assert.equal(result.saved, true, JSON.stringify(result)); assert.equal(await fs.readFile(path, "utf8"), from + "# changed\n");
  if (failure) {
    assert.equal(result.outcome, "saved_but_reload_failed"); assert.equal(result.reloaded, false);
    assert.equal(calls.filter((call) => call.startsWith("create:")).length, count);
    assert.notEqual(integration.control.getState().status, "host-fallback"); assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  } else {
    assert.equal(result.outcome, "applied", JSON.stringify(result)); assert.equal(result.activation.active, true);
    assert.notEqual(integration.control.getEffectiveConfig().config.image, previous);
    assert.equal(integration.control.getEffectiveConfig().config.pullPolicy, "never");
    assert.equal(calls.filter((call) => call.startsWith("create:")).length, count + 1);
    assert.equal(calls.filter((call) => call === "builder-create").length, 2);
    assert.ok(calls.includes("pull-policy:never"));
  }
});

for (const mode of ["off", "environment-disabled", "autoStart-false", "explicit-image", "higher-project"] as const) test(`dockerfile setter activation reports ${mode} without selecting another scope or enabling VM`, async (t) => {
  const f = await fixture(t); const paths = await hostConfigPaths(f.input);
  await fs.mkdir(dirname(paths.project), { recursive: true });
  const config = mode === "explicit-image" ? 'auto_start=false\nimage="custom:explicit"\n' : 'auto_start=false\n';
  await fs.writeFile(paths.project, config);
  if (mode === "higher-project") await fs.writeFile(join(dirname(paths.project), "Dockerfile"), from);
  let loads = 0;
  const integration = createMsbIntegration({ ...f.input, sessionId: "dockerfile", env: { ...f.input.env, ...(mode === "environment-disabled" ? { PI_MSB_DISABLE: "1" } : {}) },
    sdkLoader: async () => { loads++; throw new Error("No build/VM while deferred"); } });
  t.after(() => integration.endSession());
  await integration.configureSession({ sessionId: "dockerfile", cwd: f.cwd, projectTrusted: true });
  if (mode === "off") await integration.control.setEnabled(false);
  const defs: any[] = []; registerDockerfileTools({ registerTool(d: any) { defs.push(d); } } as any, integration.control, integration.provider.execution);
  const scope = mode === "higher-project" ? "global" : "project";
  const result = (await defs[1].execute("set", { scope, content: from + "# saved\n" }, undefined, undefined, f.ctx)).details;
  assert.equal(result.saved, true, JSON.stringify(result));
  assert.equal(result.outcome, ["explicit-image", "higher-project"].includes(mode) ? "saved_shadowed" : "saved_deferred", JSON.stringify(result));
  assert.equal(result.activation.active, false); assert.equal(loads, 0);
  assert.equal(await fs.readFile(paths.project, "utf8"), config);
  assert.equal(await fs.readFile(join(dirname(paths[scope]), "Dockerfile"), "utf8"), from + "# saved\n");
});

test("dockerfile setter holds shared lease, no-op works without UI, and post-save reload guard detects changed bytes", async (t) => {
  const f = await fixture(t); const paths = await hostConfigPaths(f.input); const path = join(dirname(paths.global), "Dockerfile");
  await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, from);
  f.ctx.hasUI = false;
  assert.equal((await f.run(true, { scope: "global", content: from })).outcome, "no_op");
  f.ctx.hasUI = true;
  f.configure({ answer: "Yes", duringApproval: async () => {
    assert.equal(f.control.settings!.acquireInteraction(), undefined);
  } });
  f.control.reload = async (options) => { await fs.writeFile(path, "# externally replaced after save\n"); await options!.guard!(); };
  const result = await f.run(true, { scope: "global", content: from + "# approved\n" });
  assert.equal(result.saved, true); assert.equal(result.reloaded, false); assert.equal(result.outcome, "saved_but_reload_failed");
  assert.ok(f.control.settings!.acquireInteraction(), "lease released after failed reload");
});

test("dockerfile-storage rejects writable policy descendants and canonical aliases", async (t) => {
  const f = await fixture(t); await fs.mkdir(f.agentDir);
  const paths = await hostConfigPaths(f.input);
  const alias = join(f.root, "agent mount alias"); await fs.symlink(f.agentDir, alias);
  for (const hostPath of [join(dirname(paths.project), "build-context", "nested"), join(alias, "pi-microsandbox")]) {
    await assert.rejects(openDockerfile(f.input, f.cwd, "project", () => {}, [{ type: "dir", hostPath, guestPath: "/host-policy", readonly: false, options: [] }]));
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const change of ["cancel-build", "cancel-import", "cancel-create", "source-during-build", "off-during-build"] as const) test(`dockerfile setter cannot activate stale approval: ${change}`, { timeout: 15_000 }, async (t) => {
  const f = await fixture(t); const calls: string[] = [], persisted: any[] = [];
  const paths = await hostConfigPaths(f.input); await fs.mkdir(dirname(paths.project), { recursive: true });
  await fs.writeFile(paths.project, 'prune_on_start=false\nfallback_mode="host"\n[docker]\nmode="disabled"\n');
  const path = join(dirname(paths.project), "Dockerfile"); await fs.writeFile(path, from);
  const entered = deferred(), release = deferred(); let armed = false;
  t.after(() => release.resolve());
  const gate = async () => { if (armed) { entered.resolve(); await release.promise; } };
  const sdk = buildSdk(calls, {
    build: change === "cancel-import" || change === "cancel-create" ? undefined : gate,
    import: change === "cancel-import" ? gate : undefined,
  });
  if (change === "cancel-create") {
    const builder = sdk.Sandbox.builder;
    sdk.Sandbox.builder = (name: string) => {
      const value = builder(name);
      if (!name.startsWith("pi-msb-builder-")) {
        const create = value.create;
        value.create = async () => { await gate(); return create(); };
      }
      return value;
    };
  }
  const integration = createMsbIntegration({ ...f.input, sessionId: "dockerfile", sdkLoader: async () => sdk,
    appendEntry: (_type, data) => persisted.push(data), acquireOwnerLock: async () => ({ path: "test", release: async () => {} }), locksPort: { tryAcquire: async () => null } });
  t.after(() => integration.manager.shutdown());
  assert.equal((await integration.configureSession({ sessionId: "dockerfile", cwd: f.cwd, projectTrusted: true })).status, "active");
  const initialImage = integration.control.getAgentRuntimePolicy!()!.settings.image;
  const boundary = calls.length, persistenceBoundary = persisted.length;
  const defs: any[] = []; registerDockerfileTools({ registerTool(d: any) { defs.push(d); } } as any, integration.control, integration.provider.execution);
  const abort = new AbortController(); armed = true;
  const approved = from + "# gated approved change\n";
  const pending = defs[1].execute("set", { scope: "project", content: approved }, abort.signal, undefined, f.ctx);
  await entered.promise;
  assert.equal(await fs.readFile(path, "utf8"), approved);
  if (change === "source-during-build") await fs.writeFile(path, "# unapproved replacement during build\n");
  else if (change === "off-during-build") await integration.control.setEnabled(false);
  else abort.abort();
  release.resolve();
  const result = (await pending).details;
  assert.equal(result.saved, true, JSON.stringify(result)); assert.equal(result.reloaded, false);
  assert.equal(result.outcome, change === "off-during-build" ? "saved_deferred" : "saved_but_reload_failed", JSON.stringify(result));
  assert.equal(persisted.slice(persistenceBoundary).some((state) => state.enabled === true), false);
  assert.notEqual(integration.control.getState().status, "host-fallback");
  assert.equal(calls.slice(boundary).filter((call) => call.startsWith("create:")).length, change === "cancel-create" ? 1 : 0,
    "only an already-started uncancelable SDK create may complete, never activation");
  if (change !== "source-during-build") assert.equal(await fs.readFile(path, "utf8"), approved);
  if (["cancel-build", "cancel-import", "source-during-build"].includes(change)) {
    assert.equal(integration.control.getState().status, "active", "old adopted VM is retained before runtime handoff");
    assert.equal(integration.control.getAgentRuntimePolicy!()!.settings.image, initialImage);
  }
  if (change === "off-during-build") assert.equal(integration.control.getState().status, "off", "late request cannot overwrite newer Off");
  if (change === "cancel-create") assert.equal(integration.control.getState().status, "unavailable", "late handle is never published active");
});

for (const replacement of ["different-content", "same-content-new-inode", "deleted", "changed-mode", "hardlinked"] as const) test(`dockerfile save does not adopt post-rename ${replacement} baseline`, async (t) => {
  const f = await fixture(t); const paths = await hostConfigPaths(f.input); const path = join(dirname(paths.project), "Dockerfile");
  await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, from);
  const proposed = from + "# approved replacement\n";
  const external = join(dirname(path), "external-replacement");
  const rename = fs.rename;
  let intercepted = false;
  t.mock.method(fs, "rename", async (oldPath: Parameters<typeof fs.rename>[0], newPath: Parameters<typeof fs.rename>[1]) => {
    await rename(oldPath, newPath);
    if (String(newPath) !== path || !String(oldPath).includes(".dockerfile-")) return;
    intercepted = true;
    if (replacement === "deleted") await fs.unlink(path);
    else if (replacement === "changed-mode") await fs.chmod(path, 0o644);
    else if (replacement === "hardlinked") await fs.link(path, external);
    else {
      await fs.writeFile(external, replacement === "same-content-new-inode" ? proposed : "# external unapproved bytes\n", { mode: 0o600 });
      await rename(external, path);
    }
  });
  const result = await f.run(true, { scope: "project", content: proposed });
  assert.equal(intercepted, true);
  assert.equal(result.outcome, "conflict"); assert.equal(result.saved, "unknown", JSON.stringify(result)); assert.equal(result.reloaded, false);
  assert.equal(f.counts().reloads, 0, "no build/reload/activation after an uncertain atomic save");
  if (replacement === "deleted") await assert.rejects(fs.stat(path), { code: "ENOENT" });
  else {
    assert.equal(await fs.readFile(path, "utf8"), replacement === "different-content" ? "# external unapproved bytes\n" : proposed,
      "never remove/overwrite the external replacement during cleanup");
    if (replacement === "changed-mode") assert.equal((await fs.stat(path)).mode & 0o777, 0o644);
    if (replacement === "hardlinked") assert.equal((await fs.stat(path)).nlink, 2);
  }
});

test("dockerfile setter rechecks cancellation after an adapter reload returns", async (t) => {
  const f = await fixture(t); const abort = new AbortController();
  f.control.reload = async () => { abort.abort(); };
  const result = await f.run(true, { scope: "global", content: from }, abort.signal);
  assert.equal(result.saved, true); assert.equal(result.reloaded, false); assert.equal(result.outcome, "saved_but_reload_failed");
});

test("cancelled activation of a shadowed Dockerfile cannot fall back to host without a local build source", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t); const calls: string[] = [], persisted: any[] = [];
  const paths = await hostConfigPaths(f.input); await fs.mkdir(dirname(paths.project), { recursive: true });
  const intent = 'image="custom:explicit"\nfallback_mode="host"\nprune_on_start=false\n[docker]\nmode="disabled"\n';
  await fs.writeFile(paths.project, 'auto_start=false\n' + intent);
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const sdk = buildSdk(calls); const builder = sdk.Sandbox.builder;
  sdk.Sandbox.builder = (name: string) => {
    const value = builder(name); const create = value.create;
    value.create = async () => { entered.resolve(); await release.promise; return create(); };
    return value;
  };
  const integration = createMsbIntegration({ ...f.input, sessionId: "dockerfile", sdkLoader: async () => sdk,
    appendEntry: (_type, data) => persisted.push(data), acquireOwnerLock: async () => ({ path: "test", release: async () => {} }) });
  t.after(() => integration.manager.shutdown());
  await integration.configureSession({ sessionId: "dockerfile", cwd: f.cwd, projectTrusted: true });
  // Human-edited startup intent exists before inspection/review; the setter does not edit it.
  await fs.writeFile(paths.project, 'auto_start=true\n' + intent);
  const defs: any[] = []; registerDockerfileTools({ registerTool(d: any) { defs.push(d); } } as any, integration.control, integration.provider.execution);
  const abort = new AbortController();
  const pending = defs[1].execute("set", { scope: "global", content: from }, abort.signal, undefined, f.ctx);
  await entered.promise;
  abort.abort(); release.resolve();
  const result = (await pending).details;
  assert.equal(result.saved, true); assert.equal(result.outcome, "saved_but_reload_failed"); assert.equal(result.reloaded, false);
  assert.equal(integration.control.getEffectiveConfig().imageBuild, undefined);
  assert.equal(integration.control.getState().status, "unavailable");
  assert.equal(persisted.some((state) => state.enabled === true), false);
  assert.equal(calls.includes("builder-create"), false);
  assert.equal(await fs.readFile(paths.project, "utf8"), 'auto_start=true\n' + intent);
});


for (const catalogued of [false, true]) test(`Dockerfile Project Worktree destination preserves shared source and getter explicitly disambiguates shadowing: catalogued=${catalogued}`, async (t) => {
  const f = await fixture(t); execFileSync("git", ["init", "-q", f.cwd]);
  const paths = await hostConfigPaths(f.input); assert.ok(paths.worktree);
  if (catalogued) {
    const editor = new SettingsEditor(f.input, "dockerfile"); const draft = await editor.open("project"); draft.set("cpus", 2); await draft.apply();
    await fs.writeFile(join(dirname(paths.project), "Dockerfile"), from);
  }
  const sharedBefore = catalogued ? await fs.readFile(paths.project, "utf8") : null;
  await fs.mkdir(dirname(paths.worktree!), { recursive: true });
  await fs.writeFile(paths.worktree!, `image = ${JSON.stringify(DEFAULT_CONFIG.image)}\n`);
  const desired = await resolveConfig(f.input); f.control.getEffectiveConfig = () => desired;
  const inspected = await f.run(false, { scope: "project" });
  assert.equal(inspected.paths.project.config, paths.project);
  assert.equal(inspected.paths.project.dockerfile, join(dirname(paths.project), "Dockerfile"));
  assert.match(inspected.warnings.join(" "), /shared Repository or this Worktree/);
  const saved = await f.run(true, { scope: "project", content: from });
  assert.equal(saved.saved, true); assert.equal(saved.outcome, "saved_shadowed");
  assert.ok(f.question().includes("worktree"));
  const after = await f.run(false, { scope: "project", destination: "worktree" });
  assert.equal(after.target.config, paths.worktree);
  assert.equal(after.content, from); assert.equal(after.lastKnownSelection.selected, false);
  assert.equal(await fs.readFile(paths.worktree!, "utf8"), `image = ${JSON.stringify(DEFAULT_CONFIG.image)}\n`);
  if (catalogued) {
    assert.equal(await fs.readFile(paths.project, "utf8"), sharedBefore);
    assert.equal(await fs.readFile(join(dirname(paths.project), "Dockerfile"), "utf8"), from);
  } else await assert.rejects(fs.readFile(paths.project), { code: "ENOENT" });
});

async function realLinkedCheckout(f: Awaited<ReturnType<typeof fixture>>) {
  const main = join(f.root, "main-repository");
  await fs.mkdir(main);
  execFileSync("git", ["init", "-q", main]);
  execFileSync("git", ["-C", main, "-c", "user.name=Tests", "-c", "user.email=tests@example.com", "commit", "-q", "--allow-empty", "-m", "initial"]);
  await fs.rmdir(f.cwd);
  execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "linked", f.cwd]);
  return main;
}

for (const destination of ["repository", "worktree"] as const) test(`Dockerfile Project real linked Git ${destination}: exact config destination, no copies, current/future discovery`, async (t) => {
  const f = await fixture(t); const main = await realLinkedCheckout(f);
  const targets = await hostConfigTargets(f.input);
  f.configure({ answer: "Yes", destination });
  const saved = await f.run(true, { scope: "project", content: from, context: [{ path: "nested/bootstrap.sh", content: "#!/bin/sh\necho ready\n", executable: true }] });
  assert.equal(saved.saved, true, JSON.stringify(saved)); assert.equal(saved.reloaded, true);
  const target = destination === "repository" ? targets.paths.project : targets.paths.worktree!;
  assert.equal(saved.review.target.config, target);
  assert.equal(await fs.readFile(join(dirname(target), "Dockerfile"), "utf8"), from);
  assert.equal((await fs.stat(join(dirname(target), "build-context", "nested", "bootstrap.sh"))).mode & 0o777, 0o700);
  const other = destination === "repository" ? targets.paths.worktree! : targets.paths.project;
  await assert.rejects(fs.lstat(join(dirname(other), "Dockerfile")), { code: "ENOENT" });
  await assert.rejects(fs.lstat(join(dirname(other), "build-context")), { code: "ENOENT" });
  if (destination === "repository") {
    assert.deepEqual(JSON.parse(JSON.stringify(readRawConfig(await fs.readFile(target, "utf8"))._repository)), targets.repository);
    assert.doesNotMatch(f.question(), /immutable host-owned repository association|formatting\/comments/);
    assert.match(saved.review.registration.consequence, /immutable host-owned repository association/);
    assert.equal((await resolveConfig({ ...f.input, cwd: main })).imageBuild?.dockerfile, join(dirname(target), "Dockerfile"));
    const future = join(f.root, "future-worktree");
    execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "future", future]);
    await fs.unlink(join(future, ".git"));
    assert.equal((await resolveConfig({ ...f.input, cwd: future })).imageBuild?.dockerfile, join(dirname(target), "Dockerfile"));
    await fs.unlink(join(f.cwd, ".git"));
    assert.equal((await f.run(false, { scope: "project" })).content, from);
  } else {
    await assert.rejects(fs.lstat(targets.paths.project), { code: "ENOENT" });
    assert.equal((await resolveConfig({ ...f.input, cwd: main })).imageBuild, undefined);
    assert.equal((await f.run(false, { scope: "project" })).content, null);
    assert.equal((await f.run(false, { scope: "project", destination: "worktree" })).content, from);
  }
});

for (const change of ["association", "alias", "config", "chooser-association"] as const) test(`Dockerfile shared approval rejects real Git ${change} change`, async (t) => {
  const f = await fixture(t); const main = await realLinkedCheckout(f);
  const targets = await hostConfigTargets(f.input);
  await fs.mkdir(f.agentDir);
  const alias = join(f.root, "agent-alias"); await fs.symlink(f.agentDir, alias); f.input.agentDir = alias;
  const mutate = async () => {
    if (change === "association" || change === "chooser-association") await fs.appendFile(join(main, ".git", "worktrees", await fs.readdir(join(main, ".git", "worktrees")).then((names) => names[0]!), "gitdir"), "\n");
    else if (change === "alias") { await fs.unlink(alias); const other = join(f.root, "other-agent"); await fs.mkdir(other); await fs.symlink(other, alias); }
    else { await fs.mkdir(dirname(targets.paths.worktree!), { recursive: true }); await fs.writeFile(targets.paths.worktree!, "cpus=3\n"); }
  };
  f.configure({ answer: "Yes", destination: "repository", ...(change === "chooser-association" ? { duringDestination: mutate } : { duringApproval: mutate }) });
  const saved = await f.run(true, { scope: "project", content: from, context: [{ path: "new", content: "text" }] });
  assert.equal(saved.saved, false, JSON.stringify(saved)); assert.equal(f.counts().reloads, 0);
  await assert.rejects(fs.lstat(join(dirname(targets.paths.project), "Dockerfile")), { code: "ENOENT" });
});

test("Dockerfile shared metadata already present is never rewritten; existing image/unknown keys and comments stay byte-identical", async (t) => {
  const f = await fixture(t); await realLinkedCheckout(f);
  const editor = new SettingsEditor(f.input, "dockerfile"); const draft = await editor.open("project"); draft.set("cpus", 2); await draft.apply();
  const targets = await hostConfigTargets(f.input);
  const config = '# KEEP COMMENT\nimage="custom:explicit"\nunknown_option="keep"\n' + await fs.readFile(targets.paths.project, "utf8");
  await fs.writeFile(targets.paths.project, config);
  f.configure({ answer: "Yes", destination: "repository" });
  const saved = await f.run(true, { scope: "project", content: from });
  assert.equal(saved.saved, true, JSON.stringify(saved)); assert.equal(saved.review.registration, undefined);
  assert.equal(await fs.readFile(targets.paths.project, "utf8"), config);
});

test("Dockerfile context PATCH create/read/update/delete preserves binary and unrelated inputs, supports nested exec and .dockerignore", async (t) => {
  const f = await fixture(t); const paths = await hostConfigPaths(f.input); const root = join(dirname(paths.global), "build-context");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(join(root, "binary.dat"), Buffer.from([0, 255, 128]));
  await fs.writeFile(join(root, "unrequested.txt"), "private unrequested text");
  const baseline = await fs.stat(join(root, "binary.dat"));
  const edits = [{ path: ".dockerignore", content: "*.dat\n" }, { path: "scripts/start.sh", content: "#!/bin/sh\necho hello\n", executable: true }, { path: "delete-me", content: "temporary\n" }];
  const saved = await f.run(true, { scope: "global", content: from, context: edits });
  assert.equal(saved.saved, true, JSON.stringify(saved)); assert.match(f.question(), /executable/); assert.match(f.question(), /scripts\/start.sh/);
  assert.equal((await fs.stat(join(root, "scripts"))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(join(root, ".dockerignore"))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(join(root, "scripts", "start.sh"))).mode & 0o777, 0o700);
  const open = fs.open; const opened: string[] = [];
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => { opened.push(String(args[0])); return open(...args); });
  const read = await f.run(false, { scope: "global", contextPaths: ["scripts/start.sh", "missing"] });
  assert.equal(read.outcome, "inspected", JSON.stringify(read)); assert.equal(read.inventoryComplete, true);
  assert.ok(read.inventory.some((entry: any) => entry.path === "binary.dat" && entry.bytes === 3));
  assert.equal(read.contextFiles[0].content, edits[1]!.content); assert.equal(read.contextFiles[0].executable, true); assert.equal(read.contextFiles[1].exists, false);
  assert.ok(!opened.some((path) => path.endsWith("binary.dat") || path.endsWith("unrequested.txt")));
  t.mock.restoreAll();
  const result = await f.run(true, { scope: "global", context: [{ path: "delete-me", content: null }, { path: "scripts/start.sh", content: edits[1]!.content, executable: false }] });
  assert.equal(result.saved, true, JSON.stringify(result)); assert.match(f.question(), /\[delete\]/);
  await assert.rejects(fs.lstat(join(root, "delete-me")), { code: "ENOENT" });
  assert.equal((await fs.stat(join(root, "scripts", "start.sh"))).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readFile(join(root, "binary.dat")), Buffer.from([0, 255, 128]));
  assert.equal((await fs.stat(join(root, "binary.dat"))).mtimeMs, baseline.mtimeMs);
  assert.equal(await fs.readFile(join(root, "unrequested.txt"), "utf8"), "private unrequested text");
});

test("Dockerfile context no-op is passive without UI and preserves all modes/directories", async (t) => {
  const f = await fixture(t); const paths = await hostConfigPaths(f.input); const root = join(dirname(paths.global), "build-context");
  await fs.mkdir(root, { recursive: true }); await fs.writeFile(join(root, "same"), "same", { mode: 0o640 });
  const file = await fs.stat(join(root, "same")), directory = await fs.stat(root);
  f.ctx.hasUI = false;
  const noop = await f.run(true, { scope: "global", context: [{ path: "same", content: "same" }, { path: "missing", content: null }] });
  assert.equal(noop.outcome, "no_op", JSON.stringify(noop)); assert.equal((await fs.stat(join(root, "same"))).mode, file.mode);
  assert.equal((await fs.stat(root)).mtimeMs, directory.mtimeMs); assert.deepEqual(f.counts(), { approvals: 0, reloads: 0 });
});

for (const path of ["", "/absolute", "../escape", "a/../b", "a/./b", "a//b", "a/", ".", "..", "Dockerfile", "a\\b", "C:drive", "bad\u202e", "bad\n", "a/".repeat(16) + "deep"]) test(`Dockerfile context rejects ambiguous path ${JSON.stringify(path)}`, async (t) => {
  const f = await fixture(t); const before = await tree(f.root);
  assert.equal((await f.run(true, { scope: "global", context: [{ path, content: "text" }] })).outcome, "rejected");
  assert.equal((await f.run(false, { scope: "global", contextPaths: [path] })).outcome, "rejected");
  assert.deepEqual(await tree(f.root), before); assert.deepEqual(f.counts(), { approvals: 0, reloads: 0 });
});

for (const type of ["symlink", "hardlink", "fifo", "directory", "ancestor-alias", "binary", "oversize", "growth"] as const) test(`Dockerfile context never reads/overwrites unsafe ${type}`, async (t) => {
  const f = await fixture(t); const paths = await hostConfigPaths(f.input); const root = join(dirname(paths.global), "build-context");
  await fs.mkdir(root, { recursive: true }); const target = join(root, "target");
  const other = join(f.root, "external"); await fs.writeFile(other, "untouched");
  if (type === "symlink") await fs.symlink(other, target);
  else if (type === "hardlink") await fs.link(other, target);
  else if (type === "fifo") execFileSync("mkfifo", [target]);
  else if (type === "directory") await fs.mkdir(target);
  else if (type === "ancestor-alias") { await fs.symlink(f.root, join(root, "alias")); }
  else await fs.writeFile(target, type === "binary" ? Buffer.from([255]) : type === "oversize" ? "x".repeat(32769) : "original");
  if (type === "growth") {
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]) === target) await fs.appendFile(target, "growing");
      return handle;
    });
  }
  const path = type === "ancestor-alias" ? "alias/external" : "target";
  const read = await f.run(false, { scope: "global", contextPaths: [path] }); assert.equal(read.outcome, "unavailable");
  const save = await f.run(true, { scope: "global", context: [{ path, content: "proposal" }] });
  assert.equal(save.saved, false, JSON.stringify(save)); assert.deepEqual(f.counts(), { approvals: 0, reloads: 0 });
  assert.equal(await fs.readFile(other, "utf8"), "untouched");
});

for (const scenario of ["denied", "no-ui", "stale-unrequested", "cancel-save", "partial", "postcommit-bytes", "postcommit-mode", "postcommit-inode"] as const) test(`Dockerfile context ${scenario} never activates unauthorized/partial bundle and preserves owned cleanup`, async (t) => {
  const f = await fixture(t); const paths = await hostConfigPaths(f.input); const root = join(dirname(paths.global), "build-context");
  await fs.mkdir(root, { recursive: true }); await fs.writeFile(join(root, "original"), "unchanged");
  if (scenario === "no-ui") f.ctx.hasUI = false;
  const abort = new AbortController();
  f.configure({ answer: scenario === "denied" ? "No" : "Yes", duringApproval: async () => { if (scenario === "stale-unrequested") await fs.writeFile(join(root, "original"), "unapproved"); } });
  const rename = fs.rename;
  let first = true;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (!String(args[0]).includes(".dockerfile-")) return rename(...args);
    assert.ok(!String(args[0]).startsWith(`${root}/`), "staging never enters COPY root");
    if (scenario === "partial" && !first) throw new Error("injected second artifact failure");
    await rename(...args); first = false;
    if (scenario === "cancel-save") abort.abort();
    if (scenario === "postcommit-bytes") await fs.writeFile(args[1], "unapproved replacement");
    if (scenario === "postcommit-mode") await fs.chmod(args[1], 0o644);
    if (scenario === "postcommit-inode") { const external = join(f.root, "replacement"); await fs.writeFile(external, "first", { mode: 0o600 }); await rename(external, args[1]); }
  });
  const saved = await f.run(true, { scope: "global", context: [{ path: "first", content: "first" }, { path: "nested/second", content: "second" }] }, abort.signal);
  assert.notEqual(saved.saved, true, JSON.stringify(saved)); assert.equal(saved.reloaded, false); assert.equal(f.counts().reloads, 0);
  if (["partial", "cancel-save", "postcommit-bytes", "postcommit-mode", "postcommit-inode"].includes(scenario)) assert.equal(saved.saved, "unknown", JSON.stringify(saved));
  if (scenario === "partial") { assert.deepEqual(saved.persistedArtifacts, [join(root, "first")]); assert.equal(await fs.readFile(join(root, "first"), "utf8"), "first"); }
  if (scenario === "postcommit-bytes") assert.equal(await fs.readFile(join(root, "first"), "utf8"), "unapproved replacement");
  if (scenario === "postcommit-mode") assert.equal((await fs.stat(join(root, "first"))).mode & 0o777, 0o644);
  assert.ok(!(await fs.readdir(dirname(root))).some((name) => name.startsWith(".dockerfile-")), "only owned stage files cleaned");
});

for (const cancellation of [false, true]) test(`Dockerfile context-only fake SDK new image activation/never-pull; cancelled during build=${cancellation}`, { timeout: 15_000 }, async (t) => {
  const f = await fixture(t); const paths = await hostConfigPaths(f.input); const root = join(dirname(paths.project), "build-context");
  await fs.mkdir(root, { recursive: true }); await fs.writeFile(paths.project, 'prune_on_start=false\n[docker]\nmode="disabled"\n');
  await fs.writeFile(join(dirname(paths.project), "Dockerfile"), from + "COPY . /build-inputs/\n"); await fs.writeFile(join(root, "script"), "before");
  const calls: string[] = []; const entered = deferred(), release = deferred(); let armed = false;
  t.after(() => release.resolve());
  const sdk = buildSdk(calls, { build: async () => { if (armed && cancellation) { entered.resolve(); await release.promise; } } });
  const integration = createMsbIntegration({ ...f.input, sessionId: "dockerfile", sdkLoader: async () => sdk,
    acquireOwnerLock: async () => ({ path: "test", release: async () => {} }), locksPort: { tryAcquire: async () => null } });
  t.after(() => integration.manager.shutdown());
  assert.equal((await integration.configureSession({ sessionId: "dockerfile", cwd: f.cwd, projectTrusted: true })).status, "active");
  const before = integration.control.getAgentRuntimePolicy!()!.settings.image;
  const count = calls.filter((call) => call.startsWith("create:")).length;
  const defs: any[] = []; registerDockerfileTools({ registerTool(d: any) { defs.push(d); } } as any, integration.control, integration.provider.execution);
  const abort = new AbortController(); armed = true;
  const pending = defs[1].execute("context", { scope: "project", context: [{ path: "script", content: "after", executable: true }] }, abort.signal, undefined, f.ctx);
  if (cancellation) { await entered.promise; abort.abort(); release.resolve(); }
  const saved = (await pending).details;
  assert.equal(saved.saved, true, JSON.stringify(saved)); assert.equal(await fs.readFile(join(root, "script"), "utf8"), "after");
  assert.equal(calls.filter((call) => call.startsWith("create:")).length, count + (cancellation ? 0 : 1));
  assert.equal(saved.outcome, cancellation ? "saved_but_reload_failed" : "applied", JSON.stringify(saved));
  if (cancellation) assert.equal(integration.control.getAgentRuntimePolicy!()!.settings.image, before);
  else { assert.notEqual(integration.control.getAgentRuntimePolicy!()!.settings.image, before); assert.equal(integration.control.getEffectiveConfig().config.pullPolicy, "never"); assert.ok(calls.includes("pull-policy:never")); }
});

test("Dockerfile getter bounded report explicitly marks incomplete inventory; never silently truncates requested contents", async (t) => {
  const f = await fixture(t); const paths = await hostConfigPaths(f.input); const root = join(dirname(paths.global), "build-context");
  await fs.mkdir(root, { recursive: true });
  await Promise.all(Array.from({ length: 1000 }, (_, index) => fs.writeFile(join(root, `${String(index).padStart(4, "0")}-${"x".repeat(230)}`), "")));
  const result = await f.run(false, { scope: "global" });
  assert.equal(result.outcome, "unavailable"); assert.equal(result.inventoryComplete, false);
  assert.match(result.reason, /omitted, not truncated/); assert.equal(result.inventory, undefined);
  assert.deepEqual(f.counts(), { approvals: 0, reloads: 0 });
});

test("Dockerfile context read/proposal limits reject complete oversize requests, never mutate files", async (t) => {
  const f = await fixture(t); const paths = await hostConfigPaths(f.input); const root = join(dirname(paths.global), "build-context");
  await fs.mkdir(root, { recursive: true });
  for (const name of ["one", "two", "three"]) await fs.writeFile(join(root, name), "x".repeat(32768));
  const result = await f.run(false, { scope: "global", contextPaths: ["one", "two", "three"] });
  assert.equal(result.outcome, "unavailable"); assert.equal(result.contextFiles, undefined);
  const proposal = await f.run(true, { scope: "global", context: ["one", "two", "three"].map((path) => ({ path, content: null })) });
  assert.equal(proposal.saved, false); assert.equal(f.counts().approvals, 0);
  for (const params of [{ scope: "global", context: [] }, { scope: "global", destination: "repository", content: from }, { scope: "global", context: [{ path: "one", content: "y", extra: true }] }]) {
    assert.equal((await f.run(true, params)).outcome, "rejected");
  }
  assert.equal((await fs.stat(join(root, "one"))).size, 32768);
});

test("Dockerfile nested cwd under real linked Git stays cwd-local with no shared registration/source copying", async (t) => {
  const f = await fixture(t); await realLinkedCheckout(f);
  const nested = join(f.cwd, "nested"); await fs.mkdir(nested);
  const input = { ...f.input, cwd: nested };
  const targets = await hostConfigTargets(input); assert.equal(targets.repository, undefined);
  const draft = await openDockerfile(input, nested, "project", () => {});
  assert.equal(draft.paths.project.config, targets.paths.project);
  const review = await draft.prepare(from, [{ path: ".dockerignore", content: "ignore\n" }]);
  assert.equal(review.registration, undefined);
  const applied = await draft.save(from, async () => {}); await applied.assertUnchanged();
  await assert.rejects(fs.lstat(targets.paths.project), { code: "ENOENT" });
  const parent = await hostConfigPaths(f.input);
  await assert.rejects(fs.lstat(join(dirname(parent.project), "Dockerfile")), { code: "ENOENT" });
});

for (const alias of ["file-case", "directory-case", "file-normalization", "directory-normalization"] as const) test(`Dockerfile context rejects existing ${alias} aliases before review/read/publication`, async (t) => {
  const f = await fixture(t); const paths = await hostConfigPaths(f.input); const root = join(dirname(paths.global), "build-context");
  await fs.mkdir(root, { recursive: true });
  const directory = alias.startsWith("directory");
  const originalName = alias.endsWith("normalization") ? "cafe\u0301" : "asset";
  const existing = join(root, originalName);
  if (directory) await fs.mkdir(existing);
  const originalFile = directory ? join(existing, "binary.bin") : existing;
  const bytes = Buffer.from([0, 255, 128]); await fs.writeFile(originalFile, bytes);
  const actualName = (await fs.readdir(root))[0]!;
  const alternativeName = alias.endsWith("normalization")
    ? actualName === actualName.normalize("NFD") ? actualName.normalize("NFC") : actualName.normalize("NFD")
    : actualName.toUpperCase();
  assert.notEqual(alternativeName, actualName);
  const proposedPath = directory ? `${alternativeName}/binary.bin` : alternativeName;
  const original = await fs.lstat(originalFile);
  const rename = fs.rename; let publications = 0;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => { if (String(args[0]).includes(".dockerfile-")) publications++; return rename(...args); });
  for (const content of ["replacement", null]) {
    const result = await f.run(true, { scope: "global", context: [{ path: proposedPath, content }] });
    assert.equal(result.saved, false, JSON.stringify(result)); assert.equal(result.reloaded, false);
  }
  assert.equal((await f.run(false, { scope: "global", contextPaths: [proposedPath] })).outcome, "unavailable");
  assert.equal(publications, 0); assert.deepEqual(f.counts(), { approvals: 0, reloads: 0 });
  assert.deepEqual(await fs.readFile(originalFile), bytes);
  const after = await fs.lstat(originalFile);
  assert.equal(after.ino, original.ino); assert.equal(after.dev, original.dev); assert.equal(after.mode, original.mode);
  assert.deepEqual(await fs.readdir(root), [actualName]);
  if (directory) assert.deepEqual(await fs.readdir(existing), ["binary.bin"]);
});

test("Dockerfile context case-insensitive host regression preserves binary original inode with zero publication", async (t) => {
  const f = await fixture(t); const paths = await hostConfigPaths(f.input); const root = join(dirname(paths.global), "build-context");
  await fs.mkdir(root, { recursive: true });
  const originalPath = join(root, "asset.bin"), bytes = Buffer.from([0, 255, 128]);
  await fs.writeFile(originalPath, bytes);
  let aliasStat;
  try { aliasStat = await fs.lstat(join(root, "ASSET.BIN")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; t.skip("Case-sensitive filesystem; portable collision tests still run"); return; }
  const before = await fs.lstat(originalPath); assert.equal(aliasStat.ino, before.ino);
  const rename = fs.rename; let publications = 0;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => { if (String(args[0]).includes(".dockerfile-")) publications++; return rename(...args); });
  const result = await f.run(true, { scope: "global", context: [{ path: "ASSET.BIN", content: "replacement" }] });
  assert.equal(result.saved, false, JSON.stringify(result)); assert.equal(publications, 0);
  assert.deepEqual(f.counts(), { approvals: 0, reloads: 0 });
  assert.deepEqual(await fs.readFile(originalPath), bytes); assert.equal((await fs.lstat(originalPath)).ino, before.ino);
});

for (const externalName of ["created.bin", "CREATED.BIN"]) test(`Dockerfile context verifies OS absence again immediately before publishing declared create against ${externalName}`, async (t) => {
  const f = await fixture(t); const paths = await hostConfigPaths(f.input); const root = join(dirname(paths.global), "build-context");
  await fs.mkdir(root, { recursive: true });
  const externalPath = join(root, externalName), bytes = Buffer.from([0, 255, 128]);
  const lstat = fs.lstat, rename = fs.rename; let inserted = false, publications = 0, externalInode: number | undefined;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await lstat(...args);
    // This temp check follows the last whole-bundle scan and precedes publication.
    if (!inserted && String(args[0]).includes(".dockerfile-")) {
      inserted = true; await fs.writeFile(externalPath, bytes); externalInode = (await lstat(externalPath)).ino;
    }
    return stat;
  });
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => { if (String(args[0]).includes(".dockerfile-")) publications++; return rename(...args); });
  const result = await f.run(true, { scope: "global", context: [{ path: "CREATED.BIN", content: "approved new text" }] });
  assert.equal(inserted, true); assert.equal(result.saved, false, JSON.stringify(result)); assert.equal(result.reloaded, false);
  assert.equal(publications, 0); assert.equal(f.counts().reloads, 0);
  assert.deepEqual(await fs.readFile(externalPath), bytes); assert.equal((await lstat(externalPath)).ino, externalInode);
  assert.ok(!(await fs.readdir(dirname(root))).some((name) => name.startsWith(".dockerfile-")));
});

for (const destination of ["repository", "worktree"] as const) test(`Dockerfile combined Project approval prepares both own baselines once and saves only chosen ${destination}`, async (t) => {
  const f = await fixture(t); await realLinkedCheckout(f);
  const paths = await hostConfigPaths(f.input);
  for (const [config, original] of [[paths.project, "repository-original"], [paths.worktree!, "worktree-original"]]) {
    await fs.mkdir(join(dirname(config!), "build-context"), { recursive: true });
    await fs.writeFile(join(dirname(config!), "Dockerfile"), from + `RUN ${original}\n`);
    await fs.writeFile(join(dirname(config!), "build-context", "setup.sh"), `echo ${original}\n`);
    await fs.writeFile(join(dirname(config!), "build-context", `${original}.txt`), original!);
  }
  const opened: Array<string | undefined> = [];
  const open = f.control.openDockerfile!;
  f.control.openDockerfile = async (scope, target) => { opened.push(target); return open(scope, target); };
  f.configure({ answer: "Yes", destination, duringApproval: async () => {
    assert.deepEqual(opened, ["worktree", "repository"], "both candidates must be pinned/prepared before the one question");
    const review = f.question();
    const local = review.slice(review.indexOf("This worktree"), review.indexOf("All worktrees"));
    const shared = review.slice(review.indexOf("All worktrees"));
    assert.match(local, /-RUN worktree-original/); assert.match(local, /-echo worktree-original/);
    assert.ok(!local.includes("repository-original")); assert.ok(!local.includes("Register immutable"));
    assert.match(shared, /-RUN repository-original/); assert.match(shared, /-echo repository-original/);
    assert.ok(!shared.includes("worktree-original")); assert.doesNotMatch(shared, /Register immutable|Shared on next reload/);
    assert.ok(!review.includes('"metadata"') && !review.includes("modeBefore") && !review.includes(f.agentDir));
  } });
  const content = from + "RUN apt-get update && apt-get install -y --no-install-recommends cowsay\r\n";
  const saved = await f.run(true, { scope: "project", content, context: [{ path: "setup.sh", content: "echo cowsay", executable: true }] });
  assert.equal(saved.saved, true, JSON.stringify(saved)); assert.deepEqual(f.counts(), { approvals: 1, reloads: 1 });
  const chosen = destination === "repository" ? paths.project : paths.worktree!;
  const other = destination === "repository" ? paths.worktree! : paths.project;
  assert.equal(saved.review.target.config, chosen);
  assert.equal(await fs.readFile(join(dirname(chosen), "Dockerfile"), "utf8"), content, "persist original proposal CRLF bytes, not escaped review text");
  assert.equal(await fs.readFile(join(dirname(chosen), "build-context", "setup.sh"), "utf8"), "echo cowsay");
  assert.equal((await fs.stat(join(dirname(chosen), "build-context", "setup.sh"))).mode & 0o777, 0o700);
  const otherOriginal = destination === "repository" ? "worktree-original" : "repository-original";
  assert.equal(await fs.readFile(join(dirname(other), "Dockerfile"), "utf8"), from + `RUN ${otherOriginal}\n`);
  await assert.rejects(fs.lstat(join(dirname(chosen), "build-context", `${otherOriginal}.txt`)), { code: "ENOENT" });
});

test("Dockerfile combined Project approval shows an unavailable candidate but cannot approve it or copy its source", async (t) => {
  const f = await fixture(t); await realLinkedCheckout(f);
  const paths = await hostConfigPaths(f.input);
  await fs.mkdir(dirname(paths.worktree!), { recursive: true });
  const unsafe = Buffer.from([0xff, 0xfe]); await fs.writeFile(join(dirname(paths.worktree!), "Dockerfile"), unsafe);
  let prompts = 0;
  f.ctx.ui.select = async (question: string, choices: string[]) => {
    prompts++; assert.match(question, /This worktree[\s\S]*UNAVAILABLE/);
    assert.equal(choices.length, 2); assert.equal(choices[0], "No"); assert.match(choices[1]!, /^All worktrees/);
    return choices[1];
  };
  const saved = await f.run(true, { scope: "project", content: from });
  assert.equal(saved.saved, true, JSON.stringify(saved)); assert.equal(prompts, 1);
  assert.deepEqual(await fs.readFile(join(dirname(paths.worktree!), "Dockerfile")), unsafe);
  assert.equal(await fs.readFile(join(dirname(paths.project), "Dockerfile"), "utf8"), from);
});

test("Dockerfile combined Project headless and competing lease remain write-free", async (t) => {
  const f = await fixture(t); await realLinkedCheckout(f);
  const before = await tree(f.agentDir).catch(() => null);
  f.ctx.hasUI = false;
  const headless = await f.run(true, { scope: "project", content: from });
  assert.equal(headless.saved, false); assert.equal(f.counts().approvals, 0);
  f.ctx.hasUI = true;
  const lease = f.control.settings!.acquireInteraction()!;
  try {
    const competing = await f.run(true, { scope: "project", content: from });
    assert.equal(competing.outcome, "rejected"); assert.equal(competing.saved, false);
    assert.equal(f.counts().approvals, 0); assert.equal(f.counts().reloads, 0);
    assert.deepEqual(await tree(f.agentDir).catch(() => null), before);
  } finally { lease.release(); }
});

test("Dockerfile setter result text is compact while getter retains source and minimal comment-free guidance", async (t) => {
  const f = await fixture(t);
  const output = await f.definitions.get("msb_dockerfile_set").execute("test", { scope: "global", content: from }, undefined, undefined, f.ctx);
  assert.equal(output.details.saved, true);
  assert.ok(output.content[0].text.length < 300);
  for (const field of ["review", "warnings", "metadata", "dockerfileMode"]) assert.ok(!output.content[0].text.includes(`"${field}"`));
  assert.ok(output.details.review.diff.includes("+FROM "));
  const read = await f.definitions.get("msb_dockerfile_get").execute("test", { scope: "global" }, undefined, undefined, f.ctx);
  assert.equal(read.details.content, from); assert.equal(read.details.minimalDockerfile, from);
  assert.match(read.details.editing, /smallest Dockerfile edit/); assert.match(read.details.editing, /Do not add comments/);
  assert.match(read.details.editing, /normal response/); assert.match(read.details.editing, /parser directives/);
  assert.ok(!read.details.lifecycle.includes("change a Dockerfile comment"));
  assert.match(f.definitions.get("msb_dockerfile_set").description, /smallest Dockerfile edit/);
  assert.match(f.definitions.get("msb_dockerfile_set").parameters.properties.content.description, /Do not add comments/);
});

test("Dockerfile combined Project approval retains shared lease through reload and accepts only the reviewed generation", async (t) => {
  const f = await fixture(t); await realLinkedCheckout(f);
  const paths = await hostConfigPaths(f.input);
  f.configure({ answer: "Yes", destination: "repository" });
  const reload = f.control.reload;
  let blocked = false;
  f.control.reload = async (options) => {
    assert.equal(f.control.settings!.acquireInteraction(), undefined, "lease must remain held after saving and through reload");
    const competing = await f.run(true, { scope: "global", content: from });
    assert.equal(competing.saved, false); assert.equal(competing.outcome, "rejected"); blocked = true;
    return reload(options);
  };
  const content = "#syntax=docker/dockerfile:1\n" + from + "# existing functional/local comments are not backend-banned\nRUN echo ready\n";
  const saved = await f.run(true, { scope: "project", content });
  assert.equal(saved.saved, true, JSON.stringify(saved)); assert.equal(blocked, true);
  assert.equal(await fs.readFile(join(dirname(paths.project), "Dockerfile"), "utf8"), content);
  assert.deepEqual(f.counts(), { approvals: 1, reloads: 1 });
  const released = f.control.settings!.acquireInteraction(); assert.ok(released); released.release();
});
