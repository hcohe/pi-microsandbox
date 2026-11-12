import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildSdk, tarArchive } from "../../test/image-build-fixture.ts";
import { DEFAULT_CONFIG, hostConfigPaths } from "./config.ts";
import { createMsbIntegration, type MsbControlOptions } from "./control.ts";
import { registerDiagnosticsTool, MAX_DIAGNOSTICS_BYTES } from "./diagnostics-tools.ts";
import { selectionVersion } from "./image-artifact.ts";
import { BUILD_FAILURE } from "./image-build.ts";
import { buildImageReference, nativeBuildPlatform, selectedImageReference, snapshotDockerfile } from "./image-source.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const count = (calls: string[], prefix: string) => calls.filter((call) => call.startsWith(prefix)).length;
async function fixture(t: TestContext, options: Parameters<typeof buildSdk>[1] = {}, scope: "project" | "global" = "project") {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/pi-msb-runtime-image-"));
  const cwd = join(root, "cwd"), agentDir = join(root, "agent");
  await fs.mkdir(cwd); await fs.mkdir(agentDir);
  let envReads = 0, sdkLoads = 0, forbid = false;
  const env = new Proxy({ HOME: root }, {
    get(target, key, receiver) { envReads++; if (forbid) throw new Error("Forbidden environment read"); return Reflect.get(target, key, receiver); },
    ownKeys(target) { envReads++; if (forbid) throw new Error("Forbidden environment enumeration"); return Reflect.ownKeys(target); },
  });
  const input = { cwd, agentDir, configDirName: "pi", env, projectTrusted: true };
  const paths = await hostConfigPaths(input);
  const policy = paths[scope], dockerfile = join(dirname(policy), "Dockerfile");
  await fs.mkdir(dirname(policy), { recursive: true });
  await fs.writeFile(policy, 'sandbox_name="runtime-image-test"\nauto_start=true\nbootstrap_tools=false\nprune_on_start=false\nfallback_mode="host"\n[docker]\nmode="disabled"\n');
  await fs.writeFile(dockerfile, "FROM scratch\n");
  const calls: string[] = [];
  const sdk = buildSdk(calls, { archive: (reference) => tarArchive({
    "manifest.json": JSON.stringify([{ Config: "config.json", RepoTags: [reference], Layers: [] }]),
    "config.json": JSON.stringify({ os: "linux", architecture: nativeBuildPlatform().split("/")[1], reference }),
  }), ...options });
  const integrations: ReturnType<typeof createMsbIntegration>[] = [];
  const integration = (observers: Pick<MsbControlOptions, "onState" | "onImagePreparation" | "onImagePreparationFailure" | "onCustomImageBoot"> = {}) => {
    const value = createMsbIntegration({ ...input, sessionId: "runtime-image", sdkLoader: async () => { sdkLoads++; if (forbid) throw new Error("Forbidden SDK load"); return sdk; }, ...observers,
      acquireOwnerLock: async () => ({ path: "test", release: async () => undefined }) });
    integrations.push(value);
    return value;
  };
  const start = (value: ReturnType<typeof createMsbIntegration>) => value.configureSession({ sessionId: "runtime-image", cwd, projectTrusted: true });
  t.after(async () => { forbid = false; for (const value of integrations) await value.manager.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, cwd, agentDir, paths, policy, dockerfile, input, calls, sdk, integration, start,
    forbid: () => { forbid = true; }, allow: () => { forbid = false; }, counters: () => ({ envReads, sdkLoads, calls: [...calls] }) };
}

for (const scope of ["global", "project"] as const) test(`actual ${scope} startup builds/imports once; unchanged native source reuses image but not unproven persisted VM`, async (t) => {
  const f = await fixture(t, {}, scope);
  const first = f.integration();
  assert.equal((await f.start(first)).status, "active");
  assert.equal(count(f.calls, "builder-create"), 1);
  assert.equal(count(f.calls, "image-load:"), 1);
  assert.ok(f.calls.indexOf("builder-create") < f.calls.findIndex((call) => call.startsWith("image-load:")));
  assert.ok(f.calls.findIndex((call) => call.startsWith("image-load:")) < f.calls.findIndex((call) => call.startsWith("create:")));
  const source = first.control.getEffectiveConfig().imageBuild!;
  assert.notEqual(source.identity, "unloaded");
  assert.equal(source.loadedDigest, (await f.sdk.Image!.get(buildImageReference(source))).manifestDigest);
  // Simulate a lost lifecycle owner: same stable alias is not proof of the VM's digest.
  first.endSession();
  const boundary = f.calls.length;
  const replacement = f.integration();
  assert.equal((await f.start(replacement)).status, "active");
  assert.equal(f.calls.slice(boundary).some((call) => /^(builder-|image-load:|image-save:|connect:|start:)/.test(call)), false);
  assert.equal(count(f.calls.slice(boundary), "create:"), 1);
  assert.equal(count(f.calls.slice(boundary), "stop:"), 1);
});

for (const edit of ["Dockerfile", "context"] as const) test(`edited ${edit} waits through live reload, refreshes on restart and next startup`, async (t) => {
  const f = await fixture(t);
  const value = f.integration();
  assert.equal((await f.start(value)).status, "active");
  const initial = value.control.getEffectiveConfig().imageBuild!;
  if (edit === "Dockerfile") await fs.appendFile(f.dockerfile, "LABEL edited=true\n");
  else { const context = join(dirname(f.dockerfile), "build-context"); await fs.mkdir(context); await fs.writeFile(join(context, "input"), "edited context"); }
  let boundary = f.calls.length;
  await value.control.reload({ allowRestart: false });
  assert.equal(f.calls.slice(boundary).some((call) => /^(builder-|image-load:|create:|stop:)/.test(call)), false);
  await fs.writeFile(f.policy, 'cpus=3\nauto_start=true\nbootstrap_tools=false\nprune_on_start=false\n[docker]\nmode="disabled"\n');
  await assert.rejects(value.control.reload({ allowRestart: false }), /restart confirmation/);
  assert.equal(count(f.calls, "builder-create"), 1);
  await value.control.reload();
  const next = value.control.getEffectiveConfig().imageBuild!;
  assert.notEqual(next.identity, initial.identity);
  assert.notEqual(next.loadedDigest, initial.loadedDigest);
  assert.equal(count(f.calls, "builder-create"), 2);
  assert.equal(count(f.calls, "image-load:"), 2);
  assert.equal(count(f.calls, "create:"), 2);
  await value.manager.shutdown();
  await fs.appendFile(f.dockerfile, "# edited between sessions\n");
  boundary = f.calls.length;
  assert.equal((await f.start(f.integration())).status, "active");
  assert.equal(count(f.calls.slice(boundary), "builder-create"), 1);
  assert.equal(count(f.calls.slice(boundary), "image-load:"), 1);
});

for (const failure of ["build", "import"] as const) test(`automatic ${failure} failure blocks stale runtime and host fallback`, async (t) => {
  const f = await fixture(t);
  const initial = f.integration();
  assert.equal((await f.start(initial)).status, "active");
  initial.endSession();
  await fs.appendFile(f.dockerfile, "# new source\n");
  const broken = buildSdk([], { failStep: failure });
  if (failure === "build") {
    const original = f.sdk.Sandbox.builder;
    f.sdk.Sandbox.builder = (name: string) => name.startsWith("pi-msb-builder-") ? broken.Sandbox.builder(name) : original(name);
  } else f.sdk.Image!.load = broken.Image!.load;
  const boundary = f.calls.length;
  const replacement = f.integration();
  assert.equal((await f.start(replacement)).reason, BUILD_FAILURE);
  assert.equal(replacement.provider.isActive(), false);
  assert.equal(f.calls.slice(boundary).some((call) => /^(connect:|start:|create:|stop:)/.test(call)), false);
});

for (const phase of ["build", "import"] as const) test(`shutdown cancels and drains automatic ${phase} before artifacts disposal or runtime boot`, async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { [phase]: async () => { entered.resolve(); await release.promise; } });
  const value = f.integration();
  const startup = f.start(value);
  await entered.promise;
  let drained = false;
  const shutdown = value.manager.shutdown().then(() => { drained = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(drained, false);
  release.resolve();
  await Promise.all([startup, shutdown]);
  assert.equal(drained, true);
  assert.equal(value.provider.isActive(), false);
  assert.equal(count(f.calls, "create:"), 0);
  if (phase === "build") assert.equal(count(f.calls, "image-load:"), 0);
});

for (const change of ["source", "workspace", "selection"] as const) test(`automatic build rejects ${change} change before import`, async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { build: async () => { entered.resolve(); await release.promise; } });
  const value = f.integration();
  const startup = f.start(value);
  await entered.promise;
  if (change === "source") await fs.appendFile(f.dockerfile, "# changed during build\n");
  if (change === "workspace") { await fs.rename(f.cwd, f.cwd + ".old"); await fs.mkdir(f.cwd); }
  if (change === "selection") {
    const get = f.sdk.Image!.get;
    f.sdk.Image!.get = async (ref) => ref.startsWith("localhost/pi-msb-selected:") ? { reference: ref, os: "linux", architecture: nativeBuildPlatform().split("/")[1], manifestDigest: `sha256:${"f".repeat(64)}` } as any : get(ref);
  }
  release.resolve();
  assert.equal((await startup).status, "unavailable");
  assert.equal(count(f.calls, "image-load:"), 0);
  assert.equal(count(f.calls, "create:"), 0);
});

test("absent source retains selection, but present Project with missing FROM GLOBAL fails closed", async (t) => {
  const f = await fixture(t);
  const global = join(dirname(f.paths.global), "Dockerfile");
  await fs.writeFile(global, "FROM scratch\n");
  await fs.writeFile(f.dockerfile, "FROM GLOBAL\n");
  const first = f.integration();
  assert.equal((await f.start(first)).status, "active");
  await first.manager.shutdown();
  await fs.unlink(global);
  let boundary = f.calls.length;
  assert.equal((await f.start(f.integration())).status, "unavailable");
  assert.equal(f.calls.slice(boundary).some((call) => /^(builder-|image-load:|create:)/.test(call)), false);
  await fs.unlink(f.dockerfile);
  boundary = f.calls.length;
  assert.equal((await f.start(f.integration())).status, "active");
  assert.equal(f.calls.slice(boundary).some((call) => /^(builder-|image-load:|image-save:)/.test(call)), false);
});

test("explicit image wins without reading unsafe Dockerfile/context or building/importing", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.policy, 'image="explicit:latest"\nauto_start=true\nbootstrap_tools=false\nprune_on_start=false\n[docker]\nmode="disabled"\n');
  await fs.writeFile(f.dockerfile, "BROKEN SOURCE THAT MUST NOT BE BUILT\n");
  const context = join(dirname(f.dockerfile), "build-context"); await fs.mkdir(context);
  await fs.symlink("/missing", join(context, "unsafe-input"));
  assert.equal((await f.start(f.integration())).status, "active");
  assert.equal(f.calls.some((call) => /^(builder-|image-load:|image-get:)/.test(call)), false);
});

test("native content reference mismatch rebuilds; native metadata error is not a cache miss", async (t) => {
  const f = await fixture(t);
  const first = f.integration();
  assert.equal((await f.start(first)).status, "active");
  await first.manager.shutdown();
  const source = first.control.getEffectiveConfig().imageBuild!;
  const get = f.sdk.Image!.get;
  let missing = true;
  const load = f.sdk.Image!.load;
  f.sdk.Image!.load = async (...args) => { const result = await load(...args); missing = false; return result; };
  f.sdk.Image!.get = async (ref) => {
    if (missing && ref === buildImageReference(source)) throw Object.assign(new Error("missing source tag"), { code: "imageNotFound" });
    return get(ref);
  };
  assert.equal((await f.start(f.integration())).status, "active");
  assert.equal(count(f.calls, "builder-create"), 2);
  f.sdk.Image!.get = async (ref) => {
    if (ref === buildImageReference(source)) return { ...await get(ref), os: "wrong" };
    return get(ref);
  };
  const boundary = f.calls.length;
  assert.equal((await f.start(f.integration())).status, "unavailable");
  assert.equal(f.calls.slice(boundary).some((call) => /^(builder-|image-load:|create:|connect:)/.test(call)), false);
  assert.equal((await f.sdk.Image!.get(selectedImageReference(source))).manifestDigest, (await get(selectedImageReference(source))).manifestDigest);
  assert.equal((await snapshotDockerfile(source, DEFAULT_CONFIG.image)).identity, source.identity);
});

for (const edit of ["Dockerfile", "context"] as const) test(`actual Project reboot refreshes edited FROM GLOBAL ${edit}`, async (t) => {
  const f = await fixture(t);
  const global = join(dirname(f.paths.global), "Dockerfile");
  await fs.writeFile(global, "FROM scratch\n");
  await fs.writeFile(f.dockerfile, "FROM GLOBAL\n");
  const value = f.integration();
  assert.equal((await f.start(value)).status, "active");
  const first = value.control.getEffectiveConfig().imageBuild!;
  await value.control.setEnabled(false);
  if (edit === "Dockerfile") await fs.appendFile(global, "# edited global\n");
  else { const context = join(dirname(global), "build-context"); await fs.mkdir(context); await fs.writeFile(join(context, "dependency"), "changed"); }
  await value.control.setEnabled(true);
  assert.equal(value.control.getState().status, "active");
  const next = value.control.getEffectiveConfig().imageBuild!;
  assert.notEqual(next.identity, first.identity);
  assert.notEqual(next.loadedDigest, first.loadedDigest);
  assert.equal(count(f.calls, "builder-create"), 2);
  assert.equal(count(f.calls, "image-load:"), 2);
});

test("live-only reload cannot authorize a changed native selection restart", async (t) => {
  const f = await fixture(t);
  const value = f.integration();
  assert.equal((await f.start(value)).status, "active");
  const selected = value.control.getEffectiveConfig().config.image;
  const get = f.sdk.Image!.get;
  f.sdk.Image!.get = async (ref) => ref === selected ? { ...await get(ref), manifestDigest: `sha256:${"f".repeat(64)}` } : get(ref);
  const boundary = f.calls.length;
  await assert.rejects(value.control.reload({ allowRestart: false }), /restart confirmation/);
  assert.equal(f.calls.slice(boundary).some((call) => /^(builder-|image-load:|stop:|create:)/.test(call)), false);
});

for (const change of ["source", "selection"] as const) test(`automatic import rejects ${change} replacement before runtime handoff`, async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { import: async () => { entered.resolve(); await release.promise; } });
  const value = f.integration();
  const startup = f.start(value);
  await entered.promise;
  if (change === "source") await fs.appendFile(f.dockerfile, "# changed during import\n");
  else {
    const get = f.sdk.Image!.get;
    f.sdk.Image!.get = async (ref) => ref.startsWith("localhost/pi-msb-selected:") ? { ...await get(ref), manifestDigest: `sha256:${"f".repeat(64)}` } : get(ref);
  }
  release.resolve();
  assert.equal((await startup).status, "unavailable");
  assert.equal(count(f.calls, "image-load:"), 1, "native aliases may already have changed");
  assert.equal(count(f.calls, "create:"), 0);
});


test("preparation phases follow real build/export/import/boot and unchanged reuse has no rebuild or live-reload notices", async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { build: async () => { entered.resolve(); await release.promise; } });
  const phases: string[] = [], notices: string[] = [];
  let value: ReturnType<typeof createMsbIntegration>;
  value = f.integration({ onImagePreparation(phase) {
    phases.push(phase);
    assert.equal(value.provider.getState().imagePreparation, phase, "polling/animation sees the same phase");
    if (phase === "importing") assert.ok(f.calls.some((call) => call.startsWith("builder-exec:") && call.includes("save")));
    if (phase === "booting") assert.equal(count(f.calls, "image-load:"), 1);
  }, onCustomImageBoot: () => notices.push("boot") });
  const startup = f.start(value);
  await entered.promise;
  assert.equal(value.provider.getState().imagePreparation, "building");
  assert.deepEqual(notices, [], "no premature boot notice while building");
  assert.equal(count(f.calls, "create:"), 0);
  release.resolve(); await startup;
  assert.deepEqual(phases, ["checking-source", "image-missing", "building", "exporting", "importing", "booting"]);
  assert.deepEqual(notices, ["boot"]);
  assert.equal(value.provider.getState().imagePreparation, undefined);
  phases.length = 0; await value.control.reload();
  assert.deepEqual(phases, [], "no-op/live reload does not prepare");
  await value.manager.shutdown();
  const reused: string[] = [];
  const next = f.integration({ onImagePreparation: (phase) => reused.push(phase) });
  await f.start(next);
  assert.deepEqual(reused, ["checking-source", "using-cache", "booting"]);
  await next.control.setEnabled(false);
  await fs.appendFile(f.dockerfile, "# changed\n");
  reused.length = 0; await next.control.setEnabled(true);
  assert.deepEqual(reused, ["checking-source", "source-changed", "image-missing", "building", "exporting", "importing", "booting"]);
});

for (const phase of ["build", "import"] as const) test(`automatic ${phase} failure reports useful bounded detail and clears footer phase`, async (t) => {
  const f = await fixture(t, { failStep: phase, stderr: "x".repeat(4000) + " Docker step failed: missing-package" });
  const failures: string[] = [], phases: string[] = [];
  const value = f.integration({ onImagePreparationFailure: (message) => failures.push(message), onImagePreparation: (phase) => phases.push(phase) });
  assert.equal((await f.start(value)).reason, BUILD_FAILURE);
  assert.equal(value.provider.getState().status, "unavailable");
  assert.equal(value.provider.getState().imagePreparation, undefined);
  assert.equal(phases.includes("booting"), false);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /Sandbox activation blocked; no host fallback/);
  assert.match(failures[0]!, /msb_dockerfile_build then msb_dockerfile_load/);
  if (phase === "build") {
    assert.match(failures[0]!, /build; exit status 1; command .*docker .*buildx build/);
    assert.match(failures[0]!, /Output tail: .*missing-package/);
    assert.ok(failures[0]!.length < 2300);
  } else assert.match(failures[0]!, /import.*PRIVATE IMPORT OUTPUT/);
});

for (const action of ["cancel", "replace", "reload", "shutdown"] as const) test(`${action} during preparation clears phase and suppresses late notices/errors`, async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { build: async () => { entered.resolve(); await release.promise; } });
  const phases: string[] = [], failures: string[] = [];
  const value = f.integration({ onImagePreparation: (phase) => phases.push(phase), onImagePreparationFailure: (message) => failures.push(message) });
  // Start from a disabled session so approval cancellation exercises the reload path.
  await fs.writeFile(f.policy, (await fs.readFile(f.policy, "utf8")).replace("auto_start=true", "auto_start=false"));
  await f.start(value);
  await fs.writeFile(f.policy, (await fs.readFile(f.policy, "utf8")).replace("auto_start=false", "auto_start=true"));
  const abort = new AbortController();
  const pending = value.control.reload({ signal: abort.signal }).catch(() => undefined);
  await entered.promise;
  assert.equal(value.provider.getState().imagePreparation, "building");
  let replacement: Promise<unknown> | undefined;
  if (action === "cancel") abort.abort();
  else if (action === "shutdown") replacement = value.manager.shutdown();
  else {
    await fs.writeFile(f.policy, (await fs.readFile(f.policy, "utf8")).replace("auto_start=true", "auto_start=false"));
    replacement = action === "reload" ? value.control.reload()
      : value.configureSession({ sessionId: "replacement", cwd: f.cwd, projectTrusted: true });
    if (action === "reload") await replacement;
  }
  const boundary = phases.length;
  assert.equal(value.provider.getState().imagePreparation, undefined);
  if (action === "cancel") {
    assert.equal(value.provider.getState().status, "unavailable");
    assert.match(value.provider.getState().reason!, /cancelled/);
  }
  release.resolve(); await Promise.all([pending, replacement]);
  assert.deepEqual(phases.slice(boundary), []);
  assert.deepEqual(failures, []);
  assert.equal((await value.control.getDiagnostics!()).imagePreparationFailure, undefined);
  assert.equal(count(f.calls, "create:"), 0);
});


for (const kind of ["literal", "environment", "command"] as const) test(`preparation failure UI protects ${kind} secret sources without diagnostic command execution`, async (t) => {
  const secret = "runtime-private-token";
  const f = await fixture(t, { failStep: "build", stderr: `${secret}\x1b[31m\u202e missing-package` });
  const marker = join(f.root, "must-not-execute");
  const source = kind === "literal" ? `text_value="${secret}"`
    : kind === "environment" ? 'host_env="PRIVATE_TOKEN"' : `host_cmd=${JSON.stringify(`touch ${marker}; printf ${secret}`)}`;
  await fs.appendFile(f.policy, `\n[[secrets]]\nenv="TOKEN"\nallow_hosts=["api.example"]\n${source}\n`);
  Object.assign(f.input.env, { PRIVATE_TOKEN: secret });
  const failures: string[] = [];
  const value = f.integration({ onImagePreparationFailure: (message) => failures.push(message) });
  assert.equal((await f.start(value)).reason, BUILD_FAILURE);
  assert.equal(failures.length, 1);
  const diagnostic = JSON.stringify(await value.control.getDiagnostics!());
  assert.doesNotMatch(diagnostic, /runtime-private-token/);
  assert.match(diagnostic, kind === "command" ? /withheld.*startup secret tokens/ : /(?:<redacted>|\[REDACTED\]).*missing-package/);
  assert.doesNotMatch(failures[0]!, /runtime-private-token/);
  assert.doesNotMatch(failures[0]!.replaceAll("\n", ""), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  if (kind === "command") {
    assert.match(failures[0]!, /withheld.*startup secret tokens/);
    assert.equal(await fs.stat(marker).then(() => true, () => false), false);
  } else assert.match(failures[0]!, /(?:<redacted>|\[REDACTED\]).*missing-package/);
});

function diagnosticsTool(value: ReturnType<typeof createMsbIntegration>) {
  let tool: any;
  registerDiagnosticsTool({ registerTool(definition: unknown) { tool = definition; } } as any, value.control);
  return tool;
}

async function assertPassiveImageFailure(t: TestContext, f: Awaited<ReturnType<typeof fixture>>,
  value: ReturnType<typeof createMsbIntegration>, expected: (failure: any) => void) {
  const tool = diagnosticsTool(value), forbiddenCalls: string[] = [];
  const before = f.counters(), state = structuredClone(value.control.getState());
  f.forbid();
  for (const key of ["readFile", "stat", "lstat", "realpath", "access", "readdir", "mkdir", "writeFile", "open", "rm", "rename", "unlink"] as const) {
    t.mock.method(fs, key, () => { forbiddenCalls.push(key); throw new Error(`Forbidden IO: ${key}`); });
  }
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"] as const) {
    t.mock.method(childProcess, key, () => { forbiddenCalls.push(key); throw new Error(`Forbidden command: ${key}`); });
  }
  syncBuiltinESMExports();
  try {
    for (const format of ["json", "text"]) {
      const output = await tool.execute("diag", { format });
      assert.equal(output.details.outcome, "diagnosed");
      expected(output.details.imagePreparationFailure);
      const text = output.content[0].text.replace(/^Microsandbox diagnostics \(passive, read-only\)\n/, "");
      assert.deepEqual(JSON.parse(text), output.details);
      assert.ok(Buffer.byteLength(output.content[0].text) <= MAX_DIAGNOSTICS_BYTES);
      assert.ok(Buffer.byteLength(JSON.stringify(output.details)) <= MAX_DIAGNOSTICS_BYTES);
      assert.doesNotMatch(JSON.stringify(output.details), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    }
    assert.deepEqual(value.control.getState(), state);
    assert.deepEqual(f.counters(), before);
    assert.deepEqual(forbiddenCalls, []);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); f.allow();
  }
}

for (const phase of ["build", "export", "import"] as const) test(`diagnostics returns passive safe cached automatic ${phase} failure in text and JSON, even Off`, async (t) => {
  const f = await fixture(t, { failStep: phase, stderr: `${"x".repeat(4000)}\x1b\u202e no space left on device: missing-package` });
  const value = f.integration();
  assert.equal((await f.start(value)).status, "unavailable");
  const expected = (failure: any) => {
    assert.equal(failure.operation, "activation"); assert.equal(failure.phase, phase);
    if (phase !== "import") {
      assert.equal(failure.exitCode, phase === "build" ? 1 : 42);
      assert.equal(failure.failureKind, "commandNonzero");
      assert.match(failure.command, phase === "build" ? /docker .*buildx build/ : /docker .*save/);
      assert.match(failure.stderrTail, /no space left on device: missing-package/);
      assert.equal(failure.stdoutTail, "BUILD STDOUT");
      assert.equal(failure.outputTruncated, true);
      assert.match(failure.recovery, /32 GiB.*VFS.*check host free space.*cleanup/);
    } else {
      assert.equal(failure.exitCode, undefined); assert.equal(failure.command, undefined);
      assert.match(failure.message, /PRIVATE IMPORT OUTPUT/);
      assert.equal(failure.imported, "unknown"); assert.equal(failure.selected, "unknown");
      assert.match(failure.recovery, /Fix the source and retry/);
    }
  };
  await assertPassiveImageFailure(t, f, value, expected);
  await value.control.setEnabled(false);
  assert.equal(value.control.getState().status, "off");
  await assertPassiveImageFailure(t, f, value, expected);
  value.endSession();
  assert.equal((await value.control.getDiagnostics!()).imagePreparationFailure, undefined);
});

test("new automatic retry clears failure synchronously, then success and replacement session stay clear", async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { failStep: "build" }), value = f.integration();
  await f.start(value);
  assert.ok((await value.control.getDiagnostics!()).imagePreparationFailure);
  const healthy = buildSdk([], { build: async () => { entered.resolve(); await release.promise; } });
  const original = f.sdk.Sandbox.builder;
  f.sdk.Sandbox.builder = (name: string) => name.startsWith("pi-msb-builder-") ? healthy.Sandbox.builder(name) : original(name);
  const retry = value.control.setEnabled(true);
  await entered.promise;
  assert.equal((await value.control.getDiagnostics!()).imagePreparationFailure, undefined);
  release.resolve(); await retry;
  assert.equal(value.control.getState().status, "active");
  assert.equal((await value.control.getDiagnostics!()).imagePreparationFailure, undefined);
  const replacement = value.configureSession({ sessionId: "different-session", cwd: f.cwd, projectTrusted: true });
  assert.equal((await value.control.getDiagnostics!()).imagePreparationFailure, undefined);
  await replacement;
});

test("explicit build/load failures are cached separately from active runtime and successful retry clears", async (t) => {
  const f = await fixture(t), value = f.integration(); await f.start(value);
  await fs.appendFile(f.dockerfile, "# explicit changed source\n");
  const selected = value.control.getEffectiveConfig().imageBuild!;
  const source = { ...selected, ...await snapshotDockerfile(selected, DEFAULT_CONFIG.image) };
  const original = f.sdk.Sandbox.builder, broken = buildSdk([], { failStep: "build", stderr: "explicit missing-package" });
  f.sdk.Sandbox.builder = (name: string) => name.startsWith("pi-msb-builder-") ? broken.Sandbox.builder(name) : original(name);
  await assert.rejects(value.control.buildDockerfile!({ source }));
  const report: any = await value.control.getDiagnostics!();
  assert.equal(report.runtime.status, "active"); assert.equal(report.failure.code, "none");
  await assertPassiveImageFailure(t, f, value, (failure) => {
    assert.equal(failure.operation, "build"); assert.equal(failure.phase, "build"); assert.equal(failure.exitCode, 1);
    assert.match(failure.stderrTail, /explicit missing-package/);
    assert.doesNotMatch(JSON.stringify(failure), /Sandbox activation blocked/);
  });
  await value.provider.refreshState?.();
  assert.deepEqual((await value.control.getDiagnostics!()).imagePreparationFailure, report.imagePreparationFailure, "unrelated live refresh/adoption must not clear explicit failure");
  f.sdk.Sandbox.builder = original;
  const built = await value.control.buildDockerfile!({ source });
  assert.equal((await value.control.getDiagnostics!()).imagePreparationFailure, undefined);
  assert.equal(f.calls.filter((call) => call.startsWith("image-load:")).length, 1, "explicit build remains export-only");
  const load = f.sdk.Image!.load;
  f.sdk.Image!.load = async () => { throw new Error("explicit import failed"); };
  const options = { source, artifactId: built.artifact.artifactId, expectedSelectionVersion: await selectionVersion(f.sdk, source) };
  await assert.rejects(value.control.loadDockerfile!(options));
  await assertPassiveImageFailure(t, f, value, (failure) => {
    assert.equal(failure.operation, "load"); assert.equal(failure.phase, "import");
    assert.match(failure.message, /explicit import failed/);
    assert.equal(failure.imported, "unknown"); assert.equal(failure.selected, "unknown");
  });
  assert.equal(value.control.getState().status, "active");
  f.sdk.Image!.load = load;
  await value.control.loadDockerfile!(options);
  assert.equal((await value.control.getDiagnostics!()).imagePreparationFailure, undefined);
});

test("an older explicit failure cannot overwrite a newer successful attempt or replacement session", async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t), value = f.integration(); await f.start(value);
  const source = value.control.getEffectiveConfig().imageBuild!;
  let first = true;
  const obsolete = value.control.buildDockerfile!({ source, guard: async () => {
    if (first) { first = false; entered.resolve(); await release.promise; throw new Error("obsolete build failure"); }
  } });
  const rejected = assert.rejects(obsolete);
  await entered.promise;
  // Invalidates the older attempt before any SDK awaits, even if its guard later fails.
  await value.control.buildDockerfile!({ source });
  assert.equal((await value.control.getDiagnostics!()).imagePreparationFailure, undefined);
  release.resolve(); await rejected;
  assert.equal((await value.control.getDiagnostics!()).imagePreparationFailure, undefined);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(value.control.buildDockerfile!({ source, signal: cancelled.signal }));
  assert.equal((await value.control.getDiagnostics!()).imagePreparationFailure, undefined);
  await assert.rejects(value.control.buildDockerfile!({ source, guard: async () => { throw new Error("current failure"); } }));
  assert.ok((await value.control.getDiagnostics!()).imagePreparationFailure);
  const replacement = value.configureSession({ sessionId: "replacement", cwd: f.cwd, projectTrusted: true });
  assert.equal((await value.control.getDiagnostics!()).imagePreparationFailure, undefined);
  await replacement;
});

test("automatic export timeout preserves typed status and cached tail without inventing an exit code", async (t) => {
  const f = await fixture(t, { exportFailure: Object.assign(new Error("timeout detail"), { code: "TIMEOUT" }), stderr: "export stalled" });
  const value = f.integration(); await f.start(value);
  await assertPassiveImageFailure(t, f, value, (failure) => {
    assert.equal(failure.phase, "export"); assert.equal(failure.failureKind, "timeout");
    assert.equal(failure.exitCode, undefined); assert.match(failure.command, /docker .*save/);
    assert.equal(failure.stderrTail, "export stalled");
    assert.match(failure.recovery, /retry/);
  });
});

test("explicit failure uses originating configuration sanitizer even if held config changes during await", async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t), value = f.integration(); await f.start(value);
  const source = value.control.getEffectiveConfig().imageBuild!;
  const secret = " originating-private-token\n";
  value.configRef.value.secrets = [{ env: "TOKEN", textValue: secret, allowHosts: ["api.example"] }];
  const pending = value.control.buildDockerfile!({ source, guard: async () => {
    entered.resolve(); await release.promise; throw new Error(`${secret} failed explicit validation`);
  } });
  const rejected = assert.rejects(pending);
  await entered.promise;
  value.configRef.value.secrets = [{ env: "TOKEN", textValue: "replacement-private-token", allowHosts: ["api.example"] }];
  release.resolve(); await rejected;
  const failure: any = (await value.control.getDiagnostics!()).imagePreparationFailure;
  assert.equal(failure.operation, "build");
  assert.match(failure.message, /REDACTED.*failed explicit validation/);
  assert.doesNotMatch(JSON.stringify(failure), /originating-private-token|replacement-private-token/);
});

test("replacement session immediately clears an explicit failure and ignores an obsolete callback", async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t), value = f.integration(); await f.start(value);
  const source = value.control.getEffectiveConfig().imageBuild!;
  const pending = value.control.buildDockerfile!({ source, guard: async () => {
    entered.resolve(); await release.promise; throw new Error("old-session explicit error");
  } });
  const rejected = assert.rejects(pending); await entered.promise;
  const replacement = value.configureSession({ sessionId: "replacement", cwd: f.cwd, projectTrusted: true });
  assert.equal((await value.control.getDiagnostics!()).imagePreparationFailure, undefined);
  release.resolve(); await Promise.all([rejected, replacement]);
  assert.equal((await value.control.getDiagnostics!()).imagePreparationFailure, undefined);
});

for (const runtimeImage of ["custom-source", "explicit-image"] as const) test(`${runtimeImage} unchanged and live-only reloads preserve completed explicit build failure`, async (t) => {
  const f = await fixture(t);
  if (runtimeImage === "explicit-image") await fs.writeFile(f.policy, `image="explicit:latest"\n${await fs.readFile(f.policy, "utf8")}`);
  const value = f.integration(); await f.start(value);
  const partial = { dockerfile: f.dockerfile, agentRoot: f.agentDir, agentAlias: f.agentDir, scope: "host-project" as const };
  const source = { ...partial, ...await snapshotDockerfile(partial, DEFAULT_CONFIG.image) };
  await assert.rejects(value.control.buildDockerfile!({ source, guard: async () => { throw new Error("explicit build failed"); } }));
  const failure = (await value.control.getDiagnostics!()).imagePreparationFailure;
  assert.ok(failure);
  const boundary = f.calls.length;
  await value.control.reload();
  assert.equal(value.control.getState().status, "active");
  assert.deepEqual((await value.control.getDiagnostics!()).imagePreparationFailure, failure, "unchanged reload retains completed failure");
  await fs.writeFile(f.policy, `show_footer=false\n${await fs.readFile(f.policy, "utf8")}`);
  await value.control.reload({ allowRestart: false });
  assert.equal(value.control.getState().status, "active");
  assert.equal(value.control.getEffectiveConfig().config.showFooter, false);
  assert.deepEqual((await value.control.getDiagnostics!()).imagePreparationFailure, failure, "live-only reload retains completed failure");
  assert.equal(f.calls.slice(boundary).some((call) => /^(builder-|image-load:|create:|stop:)/.test(call)), false);
  if (runtimeImage === "custom-source") {
    await fs.writeFile(f.policy, `cpus=3\n${await fs.readFile(f.policy, "utf8")}`);
    await value.control.reload();
    assert.equal(value.control.getState().status, "active");
    assert.equal((await value.control.getDiagnostics!()).imagePreparationFailure, undefined, "actual automatic preparation/recreation clears the previous failure");
  }
});

test("failed live image verification replaces a completed explicit failure with current automatic evidence", async (t) => {
  const f = await fixture(t), value = f.integration(); await f.start(value);
  const source = value.control.getEffectiveConfig().imageBuild!;
  await assert.rejects(value.control.buildDockerfile!({ source, guard: async () => { throw new Error("explicit failure"); } }));
  const get = f.sdk.Image!.get, reference = selectedImageReference(source);
  let reads = 0;
  f.sdk.Image!.get = async (ref) => {
    if (ref === reference && ++reads > 2) throw new Error("untyped live verification failed");
    return get(ref);
  };
  await assert.rejects(value.control.reload());
  const failure: any = (await value.control.getDiagnostics!()).imagePreparationFailure;
  assert.equal(failure.operation, "activation");
  assert.equal(failure.phase, "validation");
  assert.match(failure.message, /untyped error detail withheld/);
});

test("inactive explicit build SDK loader failure keeps unconfigured credentials out of cached diagnostics", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.policy, (await fs.readFile(f.policy, "utf8")).replace("auto_start=true", "auto_start=false"));
  let sdkLoads = 0;
  const value = createMsbIntegration({ ...f.input, sessionId: "runtime-image", sdkLoader: async () => {
    sdkLoads++; throw new Error("PRIVATE_SDK_ERROR credential=PRIVATE_TOKEN");
  } });
  t.after(() => value.manager.shutdown());
  await f.start(value);
  assert.equal(value.control.getState().status, "off");
  assert.equal(sdkLoads, 0);
  const source = value.control.getEffectiveConfig().imageBuild!;
  await assert.rejects(value.control.buildDockerfile!({ source }), /PRIVATE_SDK_ERROR/);
  assert.equal(sdkLoads, 1);
  await assertPassiveImageFailure(t, f, value, (failure) => {
    assert.equal(failure.operation, "build");
    assert.match(failure.message, /untyped error detail withheld/);
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_SDK_ERROR|credential=|PRIVATE_TOKEN/);
  });
  assert.equal(sdkLoads, 1, "diagnostics never retries the loader");
});

for (const secretSource of ["effective", "shadowed"] as const) test(`actual upstream collector withholds truncated ${secretSource} literal secret from TUI and diagnostics`, async (t) => {
  const secret = `${"x".repeat(32 * 1024)}PRIVATE_SUFFIX`;
  const f = await fixture(t, { failStep: "build", stderr: secret });
  const secrets = `secrets=[{env="TOKEN",text_value=${JSON.stringify(secret)},allow_hosts=["api.example"]}]\n`;
  if (secretSource === "effective") await fs.writeFile(f.policy, secrets + await fs.readFile(f.policy, "utf8"));
  else {
    await fs.writeFile(f.paths.global, secrets);
    await fs.writeFile(f.policy, `secrets=[]\n${await fs.readFile(f.policy, "utf8")}`);
  }
  const notices: string[] = [];
  const value = f.integration({ onImagePreparationFailure: (message) => notices.push(message) });
  await f.start(value);
  assert.equal(value.control.getEffectiveConfig().config.secrets.length, secretSource === "effective" ? 1 : 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Output withheld: upstream truncation/);
  assert.doesNotMatch(notices[0]!, /PRIVATE_SUFFIX/);
  await assertPassiveImageFailure(t, f, value, (failure) => {
    assert.equal(failure.phase, "build"); assert.equal(failure.exitCode, 1);
    assert.equal(failure.outputTruncated, true); assert.equal(failure.outputWithheld, true);
    assert.match(failure.stderrTail, /Output withheld: upstream truncation/);
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_SUFFIX/);
  });
});

test("ordinary no-secret long build output retains a useful tail after upstream truncation", async (t) => {
  const f = await fixture(t, { failStep: "build", stderr: `${"x".repeat(40 * 1024)} ordinary-long-build-tail` });
  const notices: string[] = [], value = f.integration({ onImagePreparationFailure: (message) => notices.push(message) });
  await f.start(value);
  assert.match(notices[0]!, /ordinary-long-build-tail/);
  await assertPassiveImageFailure(t, f, value, (failure) => {
    assert.equal(failure.outputTruncated, true); assert.equal(failure.outputWithheld, false);
    assert.match(failure.stderrTail, /ordinary-long-build-tail/);
  });
});
