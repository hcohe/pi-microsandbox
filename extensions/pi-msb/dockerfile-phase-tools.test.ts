import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { buildSdk } from "../../test/image-build-fixture.ts";
import { DEFAULT_CONFIG, hostConfigPaths } from "./config.ts";
import { createMsbIntegration } from "./control.ts";
import { registerDockerfileTools } from "./dockerfile-tools.ts";
import { selectedImageReference } from "./image-source.ts";

const from = `FROM ${DEFAULT_CONFIG.image}\n`;
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { resolve, promise }; }
async function fixture(t: TestContext, options: { exportFailure?: "eof" | Error; autoStart?: boolean; failStep?: string; build?: () => Promise<void>; import?: () => Promise<void>; create?: () => Promise<void>; stderr?: string; sdkAcquire?: () => Promise<void> } = {}) {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/pi-msb-phases-"));
  const cwd = join(root, "cwd"), agentDir = join(root, "agent");
  await fs.mkdir(cwd); await fs.mkdir(agentDir);
  const input = { cwd, agentDir, configDirName: "pi", env: { HOME: root }, projectTrusted: true };
  const paths = await hostConfigPaths(input);
  await fs.mkdir(dirname(paths.project), { recursive: true });
  await fs.writeFile(paths.project, `auto_start=${options.autoStart ?? false}\nprune_on_start=false\n[docker]\nmode="disabled"\n`);
  const dockerfile = join(dirname(paths.project), "Dockerfile"); await fs.writeFile(dockerfile, from);
  const calls: string[] = [];
  const sdk = buildSdk(calls, options);
  const integration = createMsbIntegration({ ...input, sessionId: "phases", sdkLoader: async () => sdk,
    acquireOwnerLock: async () => ({ path: "test", release: async () => undefined }), locksPort: { tryAcquire: async () => null } });
  t.after(async () => { await integration.manager.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  await integration.configureSession({ sessionId: "phases", cwd, projectTrusted: true });
  if (options.sdkAcquire) { const build = integration.control.buildDockerfile!; integration.control.buildDockerfile = async (request) => { await options.sdkAcquire!(); return build(request); }; }
  const definitions = new Map<string, any>();
  registerDockerfileTools({ registerTool(tool: any) { definitions.set(tool.name, tool); } } as any, integration.control, integration.provider.execution);
  let answer: string | undefined = "Yes";
  let duringApproval: (() => Promise<void>) | undefined;
  const ctx: any = { cwd, mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "phases" }, ui: { async select(question: string, choices: string[]) {
    if (question.startsWith("Do you approve loading")) {
      assert.match(question, /^Do you approve loading local built image using custom Dockerfile\?\n\nScope: (Project|Global)$/);
      assert.deepEqual(choices, ["No", "Yes"]);
    }
    assert.equal(choices[0], "No"); await duringApproval?.(); return answer;
  } } };
  const run = async (name: "write" | "build" | "load", args: unknown = { scope: "project" }, signal?: AbortSignal) => (await definitions.get(`msb_dockerfile_${name}`).execute("test", args, signal, undefined, ctx));
  return { root, cwd, agentDir, paths, dockerfile, calls, sdk, integration, definitions, ctx, run, review(callback?: () => Promise<void>, response: string | undefined = "Yes") { duringApproval = callback; answer = response; } };
}
function forbidBuildUI(ctx: any) {
  ctx.ui = new Proxy({}, { get(_target, key) { assert.fail(`Autonomous build must not access UI method ${String(key)}`); } });
}
const noRuntime = (calls: string[]) => assert.equal(calls.some((call) => /^(image-load:|create:|stop:|start:)/.test(call)), false, calls.join("\n"));

test("write/build/load are independent; build cache is reusable; explicit load alone activates; edited startup source never rebuilds", async (t) => {
  const f = await fixture(t, { autoStart: true });
  assert.equal(f.integration.control.getState().status, "unavailable");
  assert.equal(f.calls.includes("builder-create"), false);
  const previous = f.integration.control.getEffectiveConfig().config.image;
  const reload = f.integration.control.reload;
  f.integration.control.reload = async () => { assert.fail("write/build must not reload"); };
  const write = (await f.run("write", { scope: "project", content: from + "RUN exit 37\n" })).details;
  assert.equal(write.code, "SOURCE_WRITTEN");
  const built = (await f.run("build")).details;
  assert.equal(built.code, "ARTIFACT_BUILT", JSON.stringify(built));
  assert.match(built.artifactId, /^[a-f0-9]{64}$/);
  assert.equal(f.integration.control.getEffectiveConfig().config.image, previous);
  noRuntime(f.calls);
  const cached = (await f.run("build")).details;
  assert.equal(cached.cacheHit, true); assert.equal(cached.artifactId, built.artifactId);
  assert.equal(f.calls.filter((call) => call === "builder-create").length, 1);
  f.integration.control.reload = reload;
  const builder = f.sdk.Sandbox.builder;
  f.sdk.Sandbox.builder = (name: string) => { assert.ok(!name.startsWith("pi-msb-builder-"), "load/reconcile must not build"); return builder(name); };
  const loaded = (await f.run("load", { scope: "project", artifactId: built.artifactId })).details;
  assert.equal(loaded.code, "ARTIFACT_LOADED", JSON.stringify(loaded)); assert.equal(loaded.activation, "active");
  const selected = f.integration.control.getEffectiveConfig().config.image;
  assert.equal(selected, selectedImageReference(built.artifact)); assert.ok(f.calls.includes("pull-policy:never"));
  await fs.writeFile(f.dockerfile, "BROKEN AND UNBUILT\n");
  const boundary = f.calls.length;
  await f.integration.control.reload();
  assert.equal(f.integration.control.getEffectiveConfig().config.image, selected);
  assert.equal(f.integration.control.getState().status, "active");
  assert.equal(f.calls.slice(boundary).some((call) => /^(image-load:|builder-|stop:|create:)/.test(call)), false);
  await f.integration.control.setEnabled(false); await f.integration.control.setEnabled(true);
  assert.equal(f.integration.control.getState().status, "active");
  assert.equal(f.integration.control.getEffectiveConfig().config.image, selected);
});

test("failed build preserves source and previous running image with exact stderr/exit status and no load/restart", async (t) => {
  const f = await fixture(t, { autoStart: true });
  const built = (await f.run("build")).details;
  assert.equal((await f.run("load", { scope: "project", artifactId: built.artifactId })).details.success, true);
  const previous = f.integration.control.getEffectiveConfig().config.image;
  const status = f.integration.control.getState();
  const bad = from + "RUN exit 1\n";
  await f.run("write", { scope: "project", content: bad });
  const builder = buildSdk([], { failStep: "build" }).Sandbox.builder;
  const original = f.sdk.Sandbox.builder;
  f.sdk.Sandbox.builder = (name: string) => name.startsWith("pi-msb-builder-") ? builder(name) : original(name);
  const boundary = f.calls.length;
  const failed = await f.run("build");
  assert.equal(failed.details.code, "BUILD_FAILED", JSON.stringify(failed));
  const log = failed.details.logs.at(-1);
  assert.equal(log.exitCode, 1); assert.match(log.stderr, /PRIVATE GUEST OUTPUT/);
  assert.match(failed.content[0].text, /exit 1/); assert.match(failed.content[0].text, /PRIVATE GUEST OUTPUT/);
  assert.equal(await fs.readFile(f.dockerfile, "utf8"), bad);
  assert.equal(f.integration.control.getEffectiveConfig().config.image, previous);
  assert.deepEqual(f.integration.control.getState(), status);
  noRuntime(f.calls.slice(boundary));
});

for (const failure of ["import", "activation"] as const) test(`${failure} failure retains artifact; retry load never builds and classifies partial state`, async (t) => {
  const f = await fixture(t, { autoStart: true });
  const built = (await f.run("build")).details;
  const originalLoad = f.sdk.Image!.load;
  const originalReload = f.integration.control.reload;
  if (failure === "import") f.sdk.Image!.load = async () => { throw new Error("precise import diagnostic"); };
  else f.integration.control.reload = async () => { throw new Error("precise activation diagnostic"); };
  const failed = await f.run("load", { scope: "project", artifactId: built.artifactId });
  assert.equal(failed.details.code, failure === "import" ? "IMPORT_FAILED" : "ACTIVATION_FAILED", JSON.stringify(failed));
  assert.equal(failed.details.imported, failure === "import" ? "unknown" : true);
  assert.equal(failed.details.selected, failure === "activation" ? true : "unknown");
  assert.equal(failed.details.logs.length, 0); assert.ok(!("exitCode" in failed.details));
  assert.match(failed.content[0].text, /precise .* diagnostic/);
  assert.equal(await fs.stat(join(f.agentDir, "pi-microsandbox", "build-cache")).then(() => true, () => false), false);
  f.sdk.Image!.load = originalLoad; f.integration.control.reload = originalReload;
  const before = f.calls.filter((call) => call === "builder-create").length;
  const retryArtifact = failure === "activation" ? (await f.run("build")).details.artifactId : built.artifactId;
  assert.equal((await f.run("load", { scope: "project", artifactId: retryArtifact })).details.success, true);
  assert.equal(f.calls.filter((call) => call === "builder-create").length, before);
});

for (const change of ["source", "source-inode", "archive", "archive-inode", "hardlink", "symlink", "directory", "request", "policy", "cwd", "session", "cancel"] as const) test(`load approval revalidation rejects ${change} without import/activation`, async (t) => {
  const f = await fixture(t);
  const built = (await f.run("build")).details;
  const candidate = await f.integration.control.readDockerfileArtifact!({ ...f.integration.control.getEffectiveConfig().imageBuild!, identity: built.artifact.sourceIdentity }, built.artifactId);
  const archive = candidate.path;
  const cache = dirname(archive);
  const request = { scope: "project", artifactId: built.artifactId };
  const abort = new AbortController();
  f.review(async () => {
    if (change === "source") await fs.writeFile(f.dockerfile, from + "# changed\n");
    if (change === "archive") await fs.appendFile(archive, "tamper");
    if (change === "source-inode") { const text = await fs.readFile(f.dockerfile); await fs.unlink(f.dockerfile); await fs.writeFile(f.dockerfile, text); }
    if (change === "archive-inode") { await fs.rename(archive, archive + ".old"); await fs.copyFile(archive + ".old", archive); }
    if (change === "hardlink") await fs.link(archive, join(f.root, "linked"));
    if (change === "symlink") { await fs.rename(archive, archive + ".old"); await fs.symlink(archive + ".old", archive); }
    if (change === "directory") { await fs.rename(cache, cache + ".old"); await fs.mkdir(cache); }
    if (change === "request") request.artifactId = "f".repeat(64);
    if (change === "policy") await fs.appendFile(f.paths.project, "\n[network]\nmode=\"deny\"\n");
    if (change === "cwd") { await fs.rename(f.cwd, f.cwd + ".old"); await fs.mkdir(f.cwd); }
    if (change === "session") f.ctx.sessionManager.getSessionId = () => "other";
    if (change === "cancel") abort.abort();
  });
  const boundary = f.calls.length;
  const result = (await f.run("load", request, abort.signal)).details;
  if (change === "directory") { await fs.rmdir(cache); await fs.rename(cache + ".old", cache); }
  if (change === "request") {
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.artifactId, built.artifactId, "input is snapshotted, never silently changes chosen artifact");
  } else {
    assert.equal(result.success, false, JSON.stringify(result));
    assert.equal(result.imported, false); noRuntime(f.calls.slice(boundary));
  }
});

for (const response of ["No", "dismissed", "no-ui"] as const) test(`load requires separate default-No approval: ${response}`, async (t) => {
  const f = await fixture(t);
  const built = (await f.run("build")).details;
  f.review(undefined, response === "no-ui" ? "Yes" : response);
  if (response === "no-ui") f.ctx.hasUI = false;
  const boundary = f.calls.length;
  const result = (await f.run("load", { scope: "project", artifactId: built.artifactId })).details;
  assert.equal(result.success, false); noRuntime(f.calls.slice(boundary));
  assert.equal(f.calls.slice(boundary).includes("builder-create"), false);
});

for (const change of ["cancel", "source", "source-inode", "context", "root", "session", "policy", "off"] as const) test(`build ${change} while command runs never imports/restarts`, async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { autoStart: true, build: async () => { entered.resolve(); await release.promise; } });
  f.ctx.hasUI = false; f.ctx.mode = "print"; forbidBuildUI(f.ctx);
  const abort = new AbortController();
  const pending = f.run("build", { scope: "project" }, abort.signal);
  await entered.promise;
  if (change === "cancel") abort.abort();
  if (change === "source") await fs.writeFile(f.dockerfile, from + "# changed\n");
  if (change === "source-inode") { await fs.rename(f.dockerfile, f.dockerfile + ".old"); await fs.writeFile(f.dockerfile, from); }
  if (change === "context") { const context = join(dirname(f.dockerfile), "build-context"); await fs.mkdir(context); await fs.writeFile(join(context, "new.txt"), "changed"); }
  if (change === "root") { await fs.rename(f.agentDir, f.agentDir + ".old"); await fs.mkdir(f.agentDir); }
  if (change === "session") f.ctx.sessionManager.getSessionId = () => "replacement";
  if (change === "policy") await fs.appendFile(f.paths.project, '\n[network]\nmode="deny"\n');
  if (change === "off") await f.integration.control.setEnabled(false);
  release.resolve();
  const result = (await pending).details;
  assert.equal(result.success, false, JSON.stringify(result)); noRuntime(f.calls);
  assert.doesNotMatch(result.code, /APPROVAL/); assert.doesNotMatch(result.reason, /fresh (?:approval|review)/i);
  if (change === "cancel") assert.equal(result.code, "BUILD_CANCELLED");
});

for (const phase of ["build", "load"] as const) test(`${phase} malformed requests are structured input failures with no fabricated exit status`, async (t) => {
  const f = await fixture(t);
  for (const input of [null, [], {}, { scope: "repository" }, { scope: "project", arbitrary: true }, { scope: "project", artifactId: "../escape" }]) {
    const result = (await f.run(phase, input)).details;
    assert.equal(result.code, "INVALID_INPUT"); assert.equal(result.phase, "input"); assert.ok(!("exitCode" in result));
  }
  noRuntime(f.calls); assert.equal(f.calls.includes("builder-create"), false);
});

for (const scope of ["project", "global"] as const) test(`loaded ${scope} selection survives source deletion; no cross-scope fallback; explicit image wins`, async (t) => {
  const f = await fixture(t, { autoStart: true });
  if (scope === "global") { await fs.unlink(f.dockerfile); await f.run("write", { scope, content: from }); }
  else await f.run("write", { scope: "global", content: from + "# lower scope must not be selected\n" });
  const built = (await f.run("build", { scope })).details;
  assert.equal((await f.run("load", { scope, artifactId: built.artifactId })).details.success, true);
  const selected = f.integration.control.getEffectiveConfig().config.image;
  const source = f.integration.control.getEffectiveConfig().imageBuild!;
  await fs.unlink(source.dockerfile);
  const boundary = f.calls.length;
  await f.integration.control.reload();
  assert.equal(f.integration.control.getEffectiveConfig().config.image, selected);
  assert.equal(f.integration.control.getEffectiveConfig().imageBuild!.scope, scope === "project" ? "host-project" : "host-default");
  noRuntime(f.calls.slice(boundary));
  for (const phase of ["build", "load"] as const) {
    const result = (await f.run(phase, { scope, ...(phase === "load" ? { artifactId: built.artifactId } : {}) })).details;
    assert.equal(result.code, "SOURCE_MISSING");
  }
  assert.equal(f.integration.control.getEffectiveConfig().config.image, selected);
  const text = await fs.readFile(f.paths.project, "utf8");
  await fs.writeFile(f.paths.project, 'image="custom:explicit"\n' + text);
  await f.integration.control.reload();
  assert.equal(f.integration.control.getEffectiveConfig().config.image, "custom:explicit");
  assert.equal(f.integration.control.getEffectiveConfig().imageBuild, undefined);
});

for (const tamper of ["source-symlink", "source-hardlink", "missing-image"] as const) test(`loaded selection fails closed on ${tamper}, never falls through or rebuilds`, async (t) => {
  const f = await fixture(t, { autoStart: true });
  const built = (await f.run("build")).details;
  assert.equal((await f.run("load", { scope: "project", artifactId: built.artifactId })).details.success, true);
  const source = f.integration.control.getEffectiveConfig().imageBuild!;
  if (tamper === "source-symlink") { await fs.rename(f.dockerfile, f.dockerfile + ".old"); await fs.symlink(f.dockerfile + ".old", f.dockerfile); }
  if (tamper === "source-hardlink") await fs.link(f.dockerfile, join(f.root, "linked-source"));
  if (tamper === "missing-image") f.sdk.Image!.get = async () => { throw new Error("Missing selected image"); };
  const boundary = f.calls.length;
  await assert.rejects(f.integration.control.reload());
  assert.equal(f.calls.slice(boundary).some((call) => /^(builder-|image-load:|create:|stop:)/.test(call)), false);
  assert.notEqual(f.integration.control.getState().status, "host-fallback");
});

test("export command failure reports actual status/stdout/stderr without import or selection", async (t) => {
  const f = await fixture(t, { failStep: "export" });
  const result = await f.run("build");
  assert.equal(result.details.code, "EXPORT_FAILED");
  assert.equal(result.details.logs.at(-1).exitCode, 42);
  assert.match(result.content[0].text, /BUILD STDOUT/); assert.match(result.content[0].text, /PRIVATE GUEST OUTPUT/);
  noRuntime(f.calls);
});

for (const change of ["cancel", "source", "artifact", "selection"] as const) test(`load ${change} during SDK import retains artifact and reports imported but not activated`, async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { import: async () => { entered.resolve(); await release.promise; } });
  const built = (await f.run("build")).details;
  const abort = new AbortController();
  const pending = f.run("load", { scope: "project", artifactId: built.artifactId }, abort.signal);
  await entered.promise;
  if (change === "cancel") abort.abort();
  if (change === "source") await fs.writeFile(f.dockerfile, from + "# changed after approval\n");
  if (change === "artifact") { const candidate = await f.integration.control.readDockerfileArtifact!({ ...f.integration.control.getEffectiveConfig().imageBuild!, identity: built.artifact.sourceIdentity }, built.artifactId); await fs.appendFile(candidate.path, "tampered"); }
  if (change === "selection") {
    const source = f.integration.control.getEffectiveConfig().imageBuild!;
    const get = f.sdk.Image!.get;
    f.sdk.Image!.get = async (ref) => ref === selectedImageReference(source) ? { ...await get(ref), manifestDigest: `sha256:${"f".repeat(64)}` } : get(ref);
  }
  release.resolve();
  const failed = (await pending).details;
  assert.equal(failed.success, false); assert.equal(failed.imported, true);
  assert.equal(f.calls.some((call) => /^(create:|stop:)/.test(call)), false);
  assert.equal(await fs.stat(join(f.agentDir, "pi-microsandbox", "build-cache")).then(() => true, () => false), false);

});

test("stale artifact cannot load a different edited source, even with fresh approval", async (t) => {
  const f = await fixture(t);
  const built = (await f.run("build")).details;
  await f.run("write", { scope: "project", content: from + "RUN echo changed\n" });
  const boundary = f.calls.length;
  const failed = (await f.run("load", { scope: "project", artifactId: built.artifactId })).details;
  assert.equal(failed.code, "STALE_SOURCE"); noRuntime(f.calls.slice(boundary));
});

test("shared Project artifact/selection follows the same main-root record across linked and nested cwd, without cross-source load", async (t) => {
  const f = await fixture(t);
  const main = join(f.root, "repository"), registration = join(main, ".git", "worktrees", "cwd");
  await fs.mkdir(registration, { recursive: true });
  await fs.writeFile(join(registration, "commondir"), "../..\n");
  await fs.writeFile(join(registration, "gitdir"), join(f.cwd, ".git") + "\n");
  await fs.writeFile(join(f.cwd, ".git"), `gitdir: ${registration}\n`);
  const saved = (await f.run("write", { scope: "project", content: from + "RUN echo shared\n" })).details;
  assert.equal(saved.success, true, JSON.stringify(saved));
  assert.match(saved.review.target.dockerfile, /projects\/repository\/Dockerfile$/);
  const built = (await f.run("build")).details;
  assert.equal(built.success, true, JSON.stringify(built));
  assert.equal((await f.run("load", { scope: "project", artifactId: built.artifactId })).details.success, true);
  const { resolveConfig } = await import("./config.ts");
  const nested = join(f.cwd, "nested"); await fs.mkdir(nested);
  await fs.unlink(join(f.cwd, ".git"));
  for (const cwd of [main, f.cwd, nested]) {
    const desired = await resolveConfig({ imageSdkLoader: async () => f.sdk, cwd, agentDir: f.agentDir, configDirName: "pi", env: { HOME: f.root }, projectTrusted: true });
    assert.equal(desired.config.image, selectedImageReference({ dockerfile: built.artifact.dockerfile, platform: built.artifact.platform }));
    assert.equal(desired.imageBuild?.dockerfile, built.artifact.dockerfile);
  }
  await f.run("write", { scope: "global", content: from + "RUN echo shared\n" });
  const crossScope = (await f.run("load", { scope: "global", artifactId: built.artifactId })).details;
  assert.equal(crossScope.success, false); assert.equal(crossScope.code, "VALIDATION_FAILED");
});

test("build diagnostics explicitly mark bounded stderr tail truncation", async (t) => {
  const f = await fixture(t, { failStep: "build", stderr: "discarded-prefix" + "x".repeat(100_000) + "useful-tail" });
  const result = await f.run("build");
  const log = result.details.logs.at(-1);
  assert.equal(log.truncated, true); assert.equal(log.exitCode, 1);
  assert.ok(Buffer.byteLength(log.stderr) <= 32 * 1024);
  assert.ok(log.stderr.endsWith("useful-tail")); assert.ok(!log.stderr.includes("discarded-prefix"));
  assert.match(result.content[0].text, /bounded tail; truncated/);
});

test("load cancellation during runtime create reports partial activation, retains artifact and never falls back to host", async (t) => {
  const f = await fixture(t, { autoStart: true });
  const built = (await f.run("build")).details;
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const builder = f.sdk.Sandbox.builder;
  f.sdk.Sandbox.builder = (name: string) => {
    const value = builder(name);
    if (!name.startsWith("pi-msb-builder-")) {
      const create = value.create;
      value.create = async () => { entered.resolve(); await release.promise; return create(); };
    }
    return value;
  };
  const abort = new AbortController();
  const pending = f.run("load", { scope: "project", artifactId: built.artifactId }, abort.signal);
  await entered.promise; abort.abort(); release.resolve();
  const failed = (await pending).details;
  assert.equal(failed.code, "ACTIVATION_FAILED", JSON.stringify(failed));
  assert.equal(failed.imported, true); assert.equal(failed.selected, true);
  assert.equal(failed.activation, "partial_or_unverified");
  assert.notEqual(f.integration.control.getState().status, "host-fallback");
  assert.equal(await fs.stat(join(f.agentDir, "pi-microsandbox", "build-cache")).then(() => true, () => false), false);
});

for (const outcome of ["success", "build", "import", "activation"] as const) test(`expanded Dockerfile ${outcome} result exposes useful inert diagnostics and recovery`, async (t) => {
  const hostile = "precise diagnostic\x1b[31mRED\x1b[0m\u202eTAIL\rreturn";
  const f = await fixture(t, { failStep: outcome === "build" ? "build" : undefined, stderr: hostile });
  const built = await f.run("build");
  let output = built;
  let tool = f.definitions.get("msb_dockerfile_build");
  if (outcome === "import" || outcome === "activation") {
    assert.equal(built.details.success, true);
    if (outcome === "import") f.sdk.Image!.load = async () => { throw new Error(hostile); };
    else f.integration.control.reload = async () => { throw new Error(hostile); };
    output = await f.run("load", { scope: "project", artifactId: built.details.artifactId });
    tool = f.definitions.get("msb_dockerfile_load");
  }
  const frame = tool.renderResult(output, { expanded: true, isPartial: false }, {}, {}).render(2000).map((line: string) => line.trimEnd()).join("\n");
  assert.match(frame, new RegExp(`Dockerfile ${output.details.phase}: ${output.details.code}`));
  assert.ok(frame.includes(`Next: ${output.details.nextAction}`));
  assert.match(frame, /precise diagnostic/);
  assert.match(frame, /\\u\{1b\}\[31mRED/); assert.match(frame, /\\u\{202e\}TAIL\\u\{d\}return/);
  assert.doesNotMatch(frame, /\x1b\[31m|\u202e|\r/);
  assert.doesNotMatch(frame, /See tool content/);
  if (outcome === "success" || outcome === "build") {
    assert.match(frame, /BUILD STDOUT/); assert.match(frame, /stderr:/); assert.match(frame, /stdout:/);
    assert.match(frame, outcome === "success" ? /\(exit 0\)/ : /\(exit 1\)/);
  } else {
    assert.doesNotMatch(frame, /\(exit \d+\)|exit status/);
    assert.match(frame, outcome === "import" ? /imported=unknown, selected=unknown/ : /imported=true, selected=true, activation=partial_or_unverified/);
  }
  if (outcome !== "success") assert.match(frame, /Recovery:/);
  if (output.details.artifactId) {
    assert.ok(frame.includes(output.details.artifactId));
    const compact = tool.renderResult(output, { expanded: false }, {}, {}).render(2000).map((line: string) => line.trimEnd()).join("\n");
    assert.ok(compact.includes(output.details.artifactId)); assert.ok(compact.includes(output.details.code)); assert.ok(compact.includes(output.details.phase));
  }
});

test("load callback and returned selected proof remain pinned after helper handoff", async (t) => {
  const f = await fixture(t);
  const built = (await f.run("build")).details;
  const source = { ...f.integration.control.getEffectiveConfig().imageBuild!, identity: built.artifact.sourceIdentity };
  let callbackProof: (() => Promise<void>) | undefined;
  const loaded = await f.integration.control.loadDockerfile!({ source, artifactId: built.artifactId, expectedSelectionVersion: "missing",
    onSelectionPublished(proof) { callbackProof = proof; } });
  assert.equal(loaded.assertSelected, callbackProof, "handoff must retain the same immutable publication proof");
  await loaded.assertSelected();
  const get = f.sdk.Image!.get;
  f.sdk.Image!.get = async (reference) => reference === selectedImageReference(source)
    ? { ...await get(reference), manifestDigest: `sha256:${"f".repeat(64)}` } : get(reference);
  await assert.rejects(loaded.assertSelected(), /selection changed/);
  await assert.rejects(callbackProof!(), /selection changed/);
});


for (const [mode, hasUI] of [["tui", true], ["rpc", true], [undefined, false], ["print", false]] as const) test(`autonomous build and cache hit are UI-free in ${mode ?? "headless"}`, async (t) => {
  const f = await fixture(t);
  f.ctx.mode = mode; f.ctx.hasUI = hasUI; forbidBuildUI(f.ctx);
  f.integration.control.reload = async () => { assert.fail("Build must not reload"); };
  f.integration.control.loadDockerfile = async () => { assert.fail("Build must not load"); };
  const previous = f.integration.control.getEffectiveConfig().config.image;
  const built = (await f.run("build")).details;
  assert.equal(built.success, true, JSON.stringify(built)); assert.equal(built.code, "ARTIFACT_BUILT");
  const cached = (await f.run("build")).details;
  assert.equal(cached.success, true, JSON.stringify(cached)); assert.equal(cached.cacheHit, true);
  assert.equal(cached.artifactId, built.artifactId);
  assert.equal(f.calls.filter((call) => call === "builder-create").length, 1);
  assert.equal(f.integration.control.getEffectiveConfig().config.image, previous);
  await assert.rejects(f.sdk.Image!.get(selectedImageReference(f.integration.control.getEffectiveConfig().imageBuild!)), { code: "imageNotFound" });
  noRuntime(f.calls);
});


for (const failure of ["build", "export"] as const) test(`autonomous ${failure} failure is UI-free and preserves source/selection`, async (t) => {
  const f = await fixture(t, { failStep: failure });
  f.ctx.hasUI = false; f.ctx.mode = "print"; forbidBuildUI(f.ctx);
  f.integration.control.reload = async () => { assert.fail("Failed build must not reload"); };
  const before = f.integration.control.getEffectiveConfig().config.image;
  const failed = (await f.run("build")).details;
  assert.equal(failed.code, failure === "build" ? "BUILD_FAILED" : "EXPORT_FAILED");
  assert.equal(failed.logs.at(-1).exitCode, failure === "build" ? 1 : 42);
  assert.equal(await fs.readFile(f.dockerfile, "utf8"), from);
  assert.equal(f.integration.control.getEffectiveConfig().config.image, before);
  assert.doesNotMatch(failed.reason, /approval|review/); noRuntime(f.calls);
});

test("autonomous build lease contention is retryable coordination, not denied approval", async (t) => {
  const f = await fixture(t); f.ctx.hasUI = false; forbidBuildUI(f.ctx);
  const lease = f.integration.control.settings!.acquireInteraction(); assert.ok(lease);
  const busy = (await f.run("build")).details;
  assert.equal(busy.code, "BUILD_BUSY"); assert.equal(busy.phase, "validation"); assert.equal(busy.nextAction, "msb_dockerfile_build");
  assert.deepEqual(busy.logs, []); assert.ok(!("exitCode" in busy));
  assert.doesNotMatch(busy.reason, /approval|review/);
  lease.release();
  assert.equal((await f.run("build")).details.success, true); noRuntime(f.calls);
});

test("already cancelled autonomous build needs no UI and performs no build effects", async (t) => {
  const f = await fixture(t); f.ctx.hasUI = false; forbidBuildUI(f.ctx);
  const abort = new AbortController(); abort.abort();
  const failed = (await f.run("build", { scope: "project" }, abort.signal)).details;
  assert.equal(failed.code, "BUILD_CANCELLED"); assert.equal(failed.nextAction, "msb_dockerfile_build"); assert.deepEqual(failed.logs, []);
  assert.equal(f.calls.includes("builder-create"), false); noRuntime(f.calls);
});

test("autonomous build snapshots request scope before async execution", async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { build: async () => { entered.resolve(); await release.promise; } });
  forbidBuildUI(f.ctx);
  const input = { scope: "project" };
  const pending = f.run("build", input);
  await entered.promise; input.scope = "global"; release.resolve();
  const built = (await pending).details;
  assert.equal(built.success, true, JSON.stringify(built));
  assert.equal(built.artifact.dockerfile, f.dockerfile); noRuntime(f.calls);
});


for (const change of ["cancel", "source", "root", "session", "policy"] as const) test(`autonomous build rejects ${change} across SDK acquisition without UI or build effects`, async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { sdkAcquire: async () => { entered.resolve(); await release.promise; } });
  f.ctx.hasUI = false; f.ctx.mode = "print"; forbidBuildUI(f.ctx);
  const abort = new AbortController();
  const pending = f.run("build", { scope: "project" }, abort.signal);
  await entered.promise;
  if (change === "cancel") abort.abort();
  if (change === "source") await fs.writeFile(f.dockerfile, from + "RUN echo changed\n");
  if (change === "root") { await fs.rename(f.agentDir, f.agentDir + ".old"); await fs.mkdir(f.agentDir); }
  if (change === "session") f.ctx.sessionManager.getSessionId = () => "replacement";
  if (change === "policy") await fs.appendFile(f.paths.project, '\n[network]\nmode="deny"\n');
  release.resolve();
  const failed = (await pending).details;
  assert.equal(failed.success, false, JSON.stringify(failed));
  assert.doesNotMatch(failed.code, /APPROVAL/); assert.doesNotMatch(failed.reason, /fresh (?:approval|review)/i);
  assert.equal(f.calls.includes("builder-create"), false); noRuntime(f.calls);
  if (change === "cancel") assert.equal(failed.code, "BUILD_CANCELLED");
});


for (const action of ["initial-no", "yes", "escape", "ctrl-c", "abort", "source", "selection"] as const) test(`load minimal custom TUI ${action} preserves explicit approval and request guards`, async (t) => {
  const f = await fixture(t);
  const built = (await f.run("build")).details;
  const abort = new AbortController();
  f.ctx.mode = "tui";
  f.ctx.ui.select = async () => { assert.fail("Custom TUI must not use native select"); };
  f.ctx.ui.custom = async (factory: any, options: unknown) => {
    assert.deepEqual(options, { overlay: false });
    let complete!: (value: boolean) => void;
    const answer = new Promise<boolean>((resolve) => { complete = resolve; });
    const view = factory({ terminal: { rows: 24, columns: 80 }, requestRender() {} }, { fg: (_role: string, text: string) => text }, new KeybindingsManager(TUI_KEYBINDINGS), complete);
    assert.deepEqual(view.render(80), ["Do you approve loading local built image using custom Dockerfile?", "", "Scope: Project", "", "Yes", "No"]);
    if (action !== "initial-no") { view.handleInput("\x1b[A"); view.render(80); }
    if (action === "source") await fs.writeFile(f.dockerfile, from + "RUN echo changed\n");
    if (action === "selection") { const source = f.integration.control.getEffectiveConfig().imageBuild!; const get = f.sdk.Image!.get; f.sdk.Image!.get = async (ref) => ref === selectedImageReference(source) ? { reference: ref, manifestDigest: `sha256:${"f".repeat(64)}`, os: "linux", architecture: source.platform.split("/")[1] } as any : get(ref); }
    if (action === "abort") abort.abort();
    view.handleInput(action === "escape" ? "\x1b" : action === "ctrl-c" ? "\x03" : "\r");
    return answer;
  };
  const boundary = f.calls.length;
  const result = (await f.run("load", { scope: "project", artifactId: built.artifactId }, abort.signal)).details;
  assert.equal(result.success, action === "yes", JSON.stringify(result));
  if (action !== "yes") {
    assert.equal(result.imported, false); assert.equal(result.selected, false); noRuntime(f.calls.slice(boundary));
  }

});

for (const mode of ["no-ui", "print", "json"] as const) test(`load tool ${mode} remains fail-closed with no prompt/import/activation`, async (t) => {
  const f = await fixture(t);
  const built = (await f.run("build")).details;
  f.ctx.hasUI = mode !== "no-ui"; f.ctx.mode = mode === "no-ui" ? "rpc" : mode;
  f.ctx.ui = new Proxy({}, { get() { assert.fail("Load cannot prompt in an unsupported context"); } });
  const boundary = f.calls.length;
  const result = (await f.run("load", { scope: "project", artifactId: built.artifactId })).details;
  assert.equal(result.code, "APPROVAL_FAILED"); assert.equal(result.imported, false); assert.equal(result.selected, false);
  noRuntime(f.calls.slice(boundary));
});

for (const mode of ["eof", "transport", "timeout"] as const) test(`expanded export ${mode} exposes structured inert diagnostics and keeps EXPORT_FAILED`, async (t) => {
  const hostile = "partial\x1b[31m\u202eoutput";
  const f = await fixture(t, { exportFailure: mode === "eof" ? "eof" : Object.assign(new Error("SECRET SDK INFO"), { code: mode === "timeout" ? "TIMEOUT" : "CONNECTION_CLOSED" }), stderr: hostile });
  const result = await f.run("build");
  assert.equal(result.details.code, "EXPORT_FAILED");
  assert.equal(result.details.diagnostics.failureKind, mode === "eof" ? "streamEndedWithoutExit" : mode);
  assert.equal(result.details.logs.at(-1).exitCode, undefined);
  assert.match(result.content[0].text, /Stream diagnostics:/);
  assert.match(result.content[0].text, /observationOnlyNotCompletionProof/);
  assert.doesNotMatch(JSON.stringify(result.details.diagnostics), /SECRET SDK INFO/);
  const tool = f.definitions.get("msb_dockerfile_build")!;
  const rendered = tool.renderResult!(result, { expanded: true } as any, {} as any);
  const frame = rendered.render(200).join("\n");
  assert.match(frame, /streamEndedWithoutExit|transport|timeout/);
  assert.doesNotMatch(frame, /\u202e|\x1b\[31m/);
  assert.match(frame, /Next: msb_dockerfile_build/);
  noRuntime(f.calls);
});

test("runtime selected alias survives broken context without reading source snapshot; shutdown removes pending exports", async (t) => {
  const f = await fixture(t, { autoStart: true });
  const built = (await f.run("build")).details;
  assert.equal((await f.run("load", { scope: "project", artifactId: built.artifactId })).details.success, true);
  const selected = f.integration.control.getEffectiveConfig().config.image;
  const context = join(dirname(f.dockerfile), "build-context");
  await fs.mkdir(context);
  await fs.writeFile(join(context, "input"), "context bytes");
  await fs.link(join(context, "input"), join(context, "hardlinked-input"));
  await f.integration.control.reload();
  assert.equal(f.integration.control.getEffectiveConfig().config.image, selected);
  assert.equal(f.integration.control.getState().status, "active");
  await fs.rm(context, { recursive: true });
  const pending = (await f.run("build")).details;
  const source = { ...f.integration.control.getEffectiveConfig().imageBuild!, identity: pending.artifact.sourceIdentity };
  const candidate = await f.integration.control.readDockerfileArtifact!(source, pending.artifactId);
  await f.integration.manager.shutdown();
  await assert.rejects(fs.stat(candidate.path), { code: "ENOENT" });
  await assert.rejects(f.integration.control.readDockerfileArtifact!(source, pending.artifactId), /unavailable/);
});

for (const sourceExists of [false, true]) test(`passive/Off config is independent of unavailable native SDK (Dockerfile=${sourceExists})`, async (t) => {
  const root = await fs.mkdtemp("/tmp/pi-msb-passive-native-");
  const cwd = join(root, "cwd"), agentDir = join(root, "agent"); await fs.mkdir(cwd); await fs.mkdir(agentDir);
  const input = { cwd, agentDir, projectTrusted: true, configDirName: "pi", env: { HOME: root } };
  const paths = await hostConfigPaths(input); await fs.mkdir(dirname(paths.project), { recursive: true });
  await fs.writeFile(paths.project, "auto_start=false\n");
  if (sourceExists) await fs.writeFile(join(dirname(paths.project), "Dockerfile"), from);
  let loads = 0;
  const integration = createMsbIntegration({ ...input, sessionId: "passive", sdkLoader: async () => { loads++; throw new Error("Unavailable native backend"); } });
  t.after(async () => { await integration.manager.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal((await integration.configureSession({ sessionId: "passive", cwd, projectTrusted: true })).status, "off");
  await integration.control.settings!.inspect(); await integration.control.reload();
  assert.equal(loads, 0);
  await integration.control.setEnabled(true);
  assert.equal(integration.control.getState().status, "unavailable");
  assert.equal(loads, 1, "only execution attempts native resolution, without treating failure as cache absence");
});

test("post-import alias replacement during pending cleanup never reaches activation", async (t) => {
  const f = await fixture(t); const built = (await f.run("build")).details;
  const source = { ...f.integration.control.getEffectiveConfig().imageBuild!, identity: built.artifact.sourceIdentity };
  const candidate = await f.integration.control.readDockerfileArtifact!(source, built.artifactId);
  const rm = fs.rm.bind(fs); const get = f.sdk.Image!.get; let replaced = false, reloads = 0;
  f.integration.control.reload = async () => { reloads++; };
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    await rm(...args);
    if (String(args[0]) === dirname(candidate.path)) { replaced = true; f.sdk.Image!.get = async (ref) => ref === selectedImageReference(source) ? { ...await get(ref), manifestDigest: `sha256:${"f".repeat(64)}` } : get(ref); }
  });
  const result = (await f.run("load", { scope: "project", artifactId: built.artifactId })).details;
  assert.equal(replaced, true); assert.equal(result.success, false); assert.equal(reloads, 0);
  assert.equal(result.imported, true);
});

test("changed selected native digest recreates active runtime even though selected alias is stable", async (t) => {
  const f = await fixture(t, { autoStart: true });
  const first = (await f.run("build")).details;
  assert.equal((await f.run("load", { scope: "project", artifactId: first.artifactId })).details.success, true);
  const reference = f.integration.control.getEffectiveConfig().config.image;
  const creates = f.calls.filter((call) => call.startsWith("create:")).length;
  const exported = (await f.run("build")).details;
  assert.equal(exported.cacheHit, true);
  assert.equal((await f.run("load", { scope: "project", artifactId: exported.artifactId })).details.success, true);
  assert.equal(f.integration.control.getEffectiveConfig().config.image, reference);
  assert.equal(f.calls.filter((call) => call.startsWith("create:")).length, creates + 1);
});

test("shutdown cancels and awaits an in-flight builder before disposing pending artifacts", async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { build: async () => { entered.resolve(); await release.promise; } });
  const pending = f.run("build"); await entered.promise;
  let finished = false;
  const shutdown = f.integration.manager.shutdown().then(() => { finished = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(finished, false, "uncancellable SDK/stream work must drain before cleanup is claimed");
  release.resolve();
  const result = (await pending).details;
  await shutdown;
  assert.equal(result.success, false);
  assert.equal(f.calls.includes("builder-destroy"), true);
  assert.equal(f.calls.some((call) => call.startsWith("image-load:")), false);
});
