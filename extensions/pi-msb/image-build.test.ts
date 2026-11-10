import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildSdk, dockerArchive, tarArchive } from "../../test/image-build-fixture.ts";
import { DEFAULT_CONFIG, hostConfigPaths, resolveConfig } from "./config.ts";
import { createMsbIntegration } from "./control.ts";
import { BUILD_FAILURE, buildDockerfileImage, loadDockerfileImage, ImagePhaseError } from "./image-build.ts";
import { artifactPath, buildRecordPath, readArtifact, selectionPath } from "./image-artifact.ts";
import { prepareBuildArchive } from "./image-archive.ts";
import { buildImageReference, nativeBuildPlatform, snapshotDockerfile } from "./image-source.ts";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp("/tmp/pi-msb-builder-test-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  await fs.mkdir(cwd); await fs.mkdir(agentDir);
  const input = { cwd, agentDir, homedir: root, env: {}, projectTrusted: true, configDirName: "pi" };
  const paths = await hostConfigPaths(input);
  const dockerfile = join(dirname(paths.project), "Dockerfile");
  await fs.mkdir(dirname(dockerfile), { recursive: true });
  await fs.writeFile(dockerfile, "FROM scratch\n");
  const resolved = await resolveConfig(input);
  const actual = await snapshotDockerfile(resolved.imageBuild!, (await import("./config.ts")).DEFAULT_CONFIG.image);
  return { root, input, paths, dockerfile, resolved, source: { ...resolved.imageBuild!, identity: actual.identity, platform: actual.platform } };
}
const acquireLock = async () => ({ path: "test", release: async () => undefined });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const temporaryPaths = (calls: string[]) => calls.filter((call) => call.startsWith("builder-bind:")).map((call) => call.slice(call.indexOf(":", "builder-bind:".length) + 1));
async function assertClean(calls: string[]) { for (const path of temporaryPaths(calls)) assert.equal(await fs.stat(path).then(() => true, () => false), false, path); }

test("builder exports a reusable verified artifact without import or runtime calls", async (t) => {
  const f = await fixture(t); const calls: string[] = []; const sdk = buildSdk(calls);
  sdk.Image!.load = async () => { assert.fail("build must not import"); };
  sdk.Image!.get = async () => { assert.fail("build must not inspect loaded images"); };
  const built = await buildDockerfileImage({ sdk, source: f.source, acquireLock });
  assert.equal(built.cacheHit, false);
  assert.ok(calls.includes("builder-cpus:2")); assert.ok(calls.includes("builder-memory:4096"));
  assert.ok(calls.includes("builder-rootDisk:8192"));
  assert.equal(calls.find((call) => call.startsWith("builder-image:")), `builder-image:${DEFAULT_CONFIG.image}`);
  assert.ok(calls.findIndex((call) => call.startsWith("builder-image:")) < calls.indexOf("builder-rootDisk:8192"));
  assert.ok(calls.includes("builder-security:default"));
  assert.ok(calls.includes("builder-user:root"));
  assert.ok(calls.includes("builder-detached:false"));
  assert.ok(calls.includes("builder-maxDuration:1200"));
  assert.equal(calls.some((call) => call.startsWith("builder-idleTimeout:")), false);
  assert.ok(calls.includes("builder-profiles:public"));
  assert.match(calls.find((call) => call.startsWith("builder-network:"))!, /"defaultIngress":"deny"/);
  assert.ok(calls.includes("builder-readonly:/pi-msb-input"));
  assert.equal(calls.filter((call) => call.startsWith("builder-bind:")).length, 2);
  assert.equal(calls.some((call) => /secret|envs|allowAll/.test(call)), false);
  assert.match(calls.find((call) => call.includes('"buildx"'))!, /"--load"/);
  assert.match(calls.find((call) => call.includes('"buildx"'))!, /"-i","PATH=/);
  const cached = await buildDockerfileImage({ sdk, source: f.source, acquireLock });
  assert.equal(cached.cacheHit, true); assert.equal(cached.artifact.artifactId, built.artifact.artifactId);
  assert.equal(calls.filter((call) => call === "builder-create").length, 1);
  assert.equal(built.logs.length, 3); assert.equal(built.logs[1]!.exitCode, 0);
  assert.match(built.logs[1]!.stderr, /PRIVATE GUEST OUTPUT/);
  await assertClean(calls);
});

test("changed content invalidates image identity; changed source after resolution and alias/cache retargeting fail before SDK create", async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  const sdk = buildSdk(calls);
  await fs.writeFile(f.dockerfile, "FROM scratch\nLABEL changed=true\n");
  await assert.rejects(buildDockerfileImage({ sdk, source: f.source, acquireLock }), ImagePhaseError);
  assert.equal(calls.includes("builder-create"), false);
  const next = await resolveConfig(f.input);
  const snapshot = await snapshotDockerfile(next.imageBuild!, (await import("./config.ts")).DEFAULT_CONFIG.image);
  assert.notEqual(snapshot.identity, f.source.identity);
  await buildDockerfileImage({ sdk, source: { ...next.imageBuild!, identity: snapshot.identity }, acquireLock });
  await assertClean(calls);
  const alias = join(f.root, "alias");
  await fs.symlink(f.input.agentDir, alias);
  const aliased = await resolveConfig({ ...f.input, agentDir: alias });
  await fs.unlink(alias); await fs.symlink(f.input.cwd, alias);
  await assert.rejects(buildDockerfileImage({ sdk, source: { ...aliased.imageBuild!, identity: f.source.identity }, acquireLock }), ImagePhaseError);
  await fs.rm(next.imageBuild!.cacheDir, { recursive: true });
  await fs.symlink(f.input.cwd, next.imageBuild!.cacheDir);
  await assert.rejects(buildDockerfileImage({ sdk, source: next.imageBuild!, acquireLock }), ImagePhaseError);
});

test("cross-process lock deduplicates concurrent content builds and validates cached digest/platform", async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  const gate = deferred();
  const entered = deferred();
  const sdk = buildSdk(calls, { build: async () => { entered.resolve(); await gate.promise; } });
  const first = buildDockerfileImage({ sdk, source: f.source });
  await entered.promise;
  const second = buildDockerfileImage({ sdk, source: f.source });
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(calls.filter((call) => call === "builder-create").length, 1);
  const record = JSON.parse(await fs.readFile(buildRecordPath(f.source), "utf8"));
  await fs.appendFile(artifactPath(f.source, record.artifactId), "tampered");
  await assert.rejects(buildDockerfileImage({ sdk, source: f.source }), /content mismatch/);
  assert.equal(calls.filter((call) => call === "builder-create").length, 1);
  await assertClean(calls);
});

for (const failStep of ["create", "build"]) test(`build ${failStep} failure is diagnostic, uncached and cleans owned resources`, async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  await assert.rejects(buildDockerfileImage({ sdk: buildSdk(calls, { failStep }), source: f.source, acquireLock }), ImagePhaseError);
  assert.ok(calls.includes("builder-destroy"));
  if (failStep === "create") {
    assert.equal(calls.filter((call) => call.startsWith("builder-get:")).length, 1);
    assert.match(calls.find((call) => call.startsWith("builder-record-destroy:"))!, /:10000$/);
  }
  assert.equal(await fs.stat(join(f.source.cacheDir, `${f.source.identity}.json`)).then(() => true, () => false), false);
  await assertClean(calls);
});

test("cancellation awaits late creation, kills execution streams and cleans the owned builder", async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  const gate = deferred();
  const entered = deferred();
  const abort = new AbortController();
  const sdk = buildSdk(calls, { create: async () => { entered.resolve(); await gate.promise; } });
  const pending = buildDockerfileImage({ sdk, source: f.source, acquireLock, signal: abort.signal });
  await entered.promise;
  abort.abort(); gate.resolve();
  await assert.rejects(pending, ImagePhaseError);
  assert.ok(calls.includes("builder-destroy"));
  assert.equal(calls.some((call) => call.startsWith("image-load:")), false);
  await assertClean(calls);
  const buildGate = deferred(); const buildEntered = deferred(); const activeAbort = new AbortController();
  const activeSdk = buildSdk(calls, { build: async () => { buildEntered.resolve(); await buildGate.promise; } });
  const active = buildDockerfileImage({ sdk: activeSdk, source: f.source, acquireLock, signal: activeAbort.signal });
  await buildEntered.promise;
  activeAbort.abort(); buildGate.resolve();
  await assert.rejects(active, ImagePhaseError);
  assert.ok(calls.includes("builder-kill"));
  await assertClean(calls);
});

test("archive preflight rejects extra image/tags, wrong platform, links, truncation and strips all ignored alias metadata", async (t) => {
  const f = await fixture(t);
  const reference = buildImageReference(f.source.identity);
  const input = join(f.root, "input.tar"); const output = join(f.root, "validated.tar");
  const prepare = () => prepareBuildArchive(input, output, reference, nativeBuildPlatform());
  const config = JSON.stringify({ os: "linux", architecture: nativeBuildPlatform().split("/")[1] });
  for (const manifest of [
    [{ Config: "config.json", RepoTags: [reference, "unrelated:latest"], Layers: [] }],
    [{ Config: "config.json", RepoTags: [reference], Layers: [] }, { Config: "config.json", RepoTags: ["unrelated:latest"], Layers: [] }],
    [{ Config: "config.json", RepoTags: ["unrelated:latest"], Layers: [] }],
  ]) {
    await fs.writeFile(input, tarArchive({ "manifest.json": JSON.stringify(manifest), "config.json": config }));
    await assert.rejects(prepare());
  }
  await fs.writeFile(input, dockerArchive(reference, "linux/wrong"));
  await assert.rejects(prepare(), /platform/);
  await fs.writeFile(input, dockerArchive(reference).subarray(0, 100));
  await assert.rejects(prepare());
  await fs.writeFile(input, tarArchive({ "../escape": "bad" }));
  await assert.rejects(prepare(), /Unsafe/);
  const link = tarArchive({ "link": "" });
  link[156] = 50;
  link.fill(32, 148, 156);
  const checksum = link.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  link.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  await fs.writeFile(input, link);
  await assert.rejects(prepare(), /links\/extensions\/special/);
  await fs.truncate(input, 16 * 1024 ** 3 + 512);
  await assert.rejects(prepare(), /Invalid build archive/);
  await fs.writeFile(input, dockerArchive(reference, undefined, { "index.json": '{"unrelated":"other:latest"}', "repositories": '{"private":"other:latest"}' }));
  await prepare();
  const sanitized = await fs.readFile(output);
  assert.doesNotMatch(sanitized.toString(), /other:latest|index.json|repositories/);
  assert.match(sanitized.toString(), /manifest.json/);
});

test("malicious guest archive is never passed to Image.load and cloud backend never builds", async (t) => {
  const f = await fixture(t); const calls: string[] = [];
  const sdk = buildSdk(calls, { archive: (reference) => dockerArchive(reference, "linux/wrong") });
  await assert.rejects(buildDockerfileImage({ sdk, source: f.source, acquireLock }), ImagePhaseError);
  assert.equal(calls.some((call) => call.startsWith("image-load:")), false);
  await assertClean(calls);
  sdk.defaultBackendKind = () => "cloud";
  await assert.rejects(buildDockerfileImage({ sdk, source: f.source, acquireLock }), ImagePhaseError);
  assert.equal(calls.filter((call) => call === "builder-create").length, 1);
});

test("build failure hard-blocks activation even when host fallback is explicitly configured", async (t) => {
  const f = await fixture(t); const calls: string[] = [];
  const sdk = buildSdk(calls, { failStep: "build" });
  const integration = createMsbIntegration({ sessionId: "blocked-build", cwd: f.input.cwd, configDirName: "pi", agentDir: f.input.agentDir, env: { HOME: f.root }, sdkLoader: async () => sdk });
  f.resolved.config.fallbackMode = "host";
  const state = await integration.configureSession({ sessionId: "blocked-build", cwd: f.input.cwd, projectTrusted: true, config: f.resolved });
  assert.equal(state.status, "unavailable");
  assert.equal(state.reason, BUILD_FAILURE);
  assert.equal(integration.provider.isActive(), false);
  assert.equal(calls.some((call) => call.startsWith("create:")), false);
  await assertClean(calls);
});

for (const failure of ["create", "prepare"]) test(`built-image runtime ${failure} failure blocks configured host fallback`, async (t) => {
  const f = await fixture(t); const calls: string[] = [];
  const sdk = buildSdk(calls);
  const built = await buildDockerfileImage({ sdk, source: f.source, acquireLock });
  await loadDockerfileImage({ sdk, source: f.source, artifactId: built.artifact.artifactId, expectedSelectionVersion: "missing" });
  f.resolved = await resolveConfig(f.input);
  const builder = sdk.Sandbox.builder;
  sdk.Sandbox.builder = (name: string) => {
    const value = builder(name);
    if (!name.startsWith("pi-msb-builder-")) {
      const create = value.create;
      value.create = async () => {
        if (failure === "create") throw new Error("Runtime create failed");
        const raw = await create();
        raw.execWith = async () => ({ code: 1, stdoutBytes: () => Buffer.alloc(0), stderrBytes: () => Buffer.alloc(0) });
        return raw;
      };
    }
    return value;
  };
  const integration = createMsbIntegration({ sessionId: `blocked-runtime-${failure}`, cwd: f.input.cwd, configDirName: "pi", agentDir: f.input.agentDir, env: { HOME: f.root }, sdkLoader: async () => sdk,
    acquireOwnerLock: async () => ({ path: "test", release: async () => undefined }) });
  f.resolved.config.fallbackMode = "host";
  f.resolved.config.bootstrapTools = false;
  f.resolved.config.pruneOnStart = false;
  const state = await integration.configureSession({ sessionId: `blocked-runtime-${failure}`, cwd: f.input.cwd, projectTrusted: true, config: f.resolved });
  assert.equal(state.status, "unavailable");
  assert.equal(integration.control.getEffectiveConfig().config.fallbackMode, "host");
  assert.equal(integration.provider.isActive(), false);
  assert.ok(calls.some((call) => call.startsWith("image-load:")));
  await assertClean(calls);
});

test("failed builder destruction withholds publication and retains isolated output", async (t) => {
  const f = await fixture(t); const calls: string[] = []; let released = false;
  await assert.rejects(buildDockerfileImage({ sdk: buildSdk(calls, { failStep: "destroy" }), source: f.source,
    acquireLock: async () => ({ path: "test", release: async () => { released = true; } }) }), ImagePhaseError);
  assert.ok(released); assert.equal(calls.some((call) => call.startsWith("image-load:")), false);
  for (const path of temporaryPaths(calls)) assert.ok((await fs.stat(path)).isDirectory());
  for (const directory of new Set(temporaryPaths(calls).map(dirname))) await fs.rm(directory, { recursive: true, force: true });
});

test("delayed SDK acquisition cannot borrow a replacement activation source/controller", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t); const calls: string[] = []; const persisted: any[] = [];
  const sdkGate = deferred(); const entered = deferred();
  const sdk = buildSdk(calls);
  const integration = createMsbIntegration({ sessionId: "old-build", cwd: f.input.cwd, configDirName: "pi", agentDir: f.input.agentDir, env: { HOME: f.root },
    sdkLoader: async () => { entered.resolve(); await sdkGate.promise; return sdk; }, appendEntry: (_type, data) => persisted.push(data) });
  const old = integration.configureSession({ sessionId: "old-build", cwd: f.input.cwd, projectTrusted: true, config: f.resolved });
  await entered.promise;
  const replacement = structuredClone(f.resolved);
  replacement.config.autoStart = false;
  const next = integration.configureSession({ sessionId: "replacement-build", cwd: f.input.cwd, projectTrusted: true, config: replacement });
  sdkGate.resolve();
  await Promise.all([old, next]);
  assert.equal(integration.control.getState().status, "off");
  assert.equal(calls.includes("builder-create"), false);
  assert.equal(calls.some((call) => call.startsWith("create:")), false);
  assert.equal(persisted.some((entry) => entry.enabled === true), false);
  assert.equal(await fs.stat(f.source.cacheDir).then(() => true, () => false), false);
});

test("builder canonicalizes both private staging binds through an aliased temporary root", async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, "temporary-alias");
  await fs.symlink(f.root, alias);
  const mkdtemp = fs.mkdtemp.bind(fs);
  t.mock.method(fs, "mkdtemp", async () => mkdtemp(join(alias, "pi-msb-build-")));
  const calls: string[] = [];
  const sdk = buildSdk(calls, { create: async () => {
    const [input, output] = temporaryPaths(calls);
    assert.ok(input && output);
    assert.notEqual(input, output);
    assert.equal(dirname(input), dirname(output));
    for (const path of [dirname(input), input, output]) {
      assert.equal(path, await fs.realpath(path));
      assert.equal((await fs.stat(path)).mode & 0o777, 0o700);
    }
    assert.equal(calls.includes("builder-readonly:/pi-msb-input"), true);
    assert.equal(calls.includes("builder-readonly:/pi-msb-output"), false);
    assert.equal(calls.some((call) => /follow.*symlink/i.test(call)), false);
  } });
  await buildDockerfileImage({ sdk, source: f.source, acquireLock });
  await assertClean(calls);
});

for (const retarget of [false, true]) test(`staging realpath failure cleans only the original owned directory (retarget=${retarget})`, async (t) => {
  const f = await fixture(t);
  const mkdtemp = fs.mkdtemp.bind(fs);
  const realpath = fs.realpath.bind(fs);
  let owned = "";
  const moved = join(f.root, "original-staging");
  t.mock.method(fs, "mkdtemp", async () => { owned = await mkdtemp(join(f.root, "pi-msb-build-")); return owned; });
  t.mock.method(fs, "realpath", async (path: string) => {
    if (path !== owned || !owned) return realpath(path);
    if (retarget) {
      await fs.rename(owned, moved);
      await fs.mkdir(owned);
      await fs.writeFile(join(owned, "foreign"), "untouched");
    }
    throw new Error("PRIVATE REALPATH FAILURE");
  });
  const calls: string[] = [];
  await assert.rejects(buildDockerfileImage({ sdk: buildSdk(calls), source: f.source, acquireLock }), ImagePhaseError);
  assert.equal(calls.includes("builder-create"), false);
  if (retarget) {
    assert.equal(await fs.readFile(join(owned, "foreign"), "utf8"), "untouched");
    assert.ok((await fs.stat(moved)).isDirectory());
  } else assert.equal(await fs.stat(owned).then(() => true, () => false), false);
});

test("failed create before persistence removes staging on authoritative local database absence", async (t) => {
  const f = await fixture(t); const calls: string[] = [];
  const sdk = buildSdk(calls, { failStep: "create", persistBeforeCreate: false });
  await assert.rejects(buildDockerfileImage({ sdk, source: f.source, acquireLock }), ImagePhaseError);
  assert.equal(calls.filter((call) => call.startsWith("builder-get:")).length, 1);
  assert.equal(calls.includes("builder-destroy"), false);
  await assertClean(calls);
});

test("failed boot cleanup accepts persisted labels arrays without a handle lifecycle flag", async (t) => {
  const f = await fixture(t); const calls: string[] = [];
  const sdk = buildSdk(calls, { failStep: "create" });
  const get = sdk.Sandbox.get;
  sdk.Sandbox.get = async (name: string) => {
    const handle = await get(name);
    assert.equal("ownsLifecycle" in handle, false);
    const config = handle.config();
    handle.config = () => ({ ...config, labels: Object.entries(config.labels) });
    return handle;
  };
  await assert.rejects(buildDockerfileImage({ sdk, source: f.source, acquireLock }), ImagePhaseError);
  assert.ok(calls.includes("builder-destroy"));
  await assertClean(calls);
});

for (const failure of ["label", "name", "config-name", "backend", "id", "inspection", "config", "unknown-not-found", "backend-switch", "lookup-backend-switch", "destroy", "replacement"]) test(`failed boot ${failure} refuses uncertain cleanup and preserves staging`, async (t) => {
  const f = await fixture(t); const calls: string[] = [];
  const sdk = buildSdk(calls, { failStep: "create", create: async () => {
    if (failure === "backend-switch") sdk.defaultBackendKind = () => "cloud";
  } });
  const get = sdk.Sandbox.get;
  let original: any;
  sdk.Sandbox.get = async (name: string) => {
    assert.match(name, /^pi-msb-builder-[a-f0-9-]+$/);
    if (failure === "inspection") throw new Error("PRIVATE DATABASE FAILURE");
    if (failure === "unknown-not-found") throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
    if (failure === "lookup-backend-switch") {
      sdk.defaultBackendKind = () => "cloud";
      throw Object.assign(new Error("not found"), { code: "sandboxNotFound" });
    }
    const handle = original = await get(name);
    const config = handle.config();
    if (failure === "label") handle.config = () => ({ ...config, labels: { "pi-msb.builder": "foreign" } });
    if (failure === "name") handle.name = "pi-msb-builder-foreign";
    if (failure === "config-name") handle.config = () => ({ ...config, name: "foreign" });
    if (failure === "backend") handle.backendKind = "cloud";
    if (failure === "id") handle.id = "";
    if (failure === "config") handle.config = () => { throw new Error("PRIVATE CONFIG FAILURE"); };
    if (failure === "destroy") handle.destroy = async () => { throw new Error("PRIVATE DESTROY FAILURE"); };
    if (failure === "replacement") {
      const destroy = handle.destroy;
      handle.destroy = async (options: { timeoutMs: number }) => {
        // Persist a foreign same-name record between inspection and destruction.
        await sdk.Sandbox.builder(name).labels({ "pi-msb.builder": "foreign" }).create().catch(() => undefined);
        await destroy(options);
      };
    }
    return handle;
  };
  let released = false;
  await assert.rejects(buildDockerfileImage({ sdk, source: f.source, acquireLock: async () => ({ path: "test", release: async () => { released = true; } }) }), ImagePhaseError);
  assert.ok(released);
  assert.equal(calls.includes("builder-destroy"), false);
  assert.equal(calls.some((call) => /connect:|start:|image-load:/.test(call)), false);
  if (failure === "replacement") {
    const replacement = await get(original.name);
    assert.notEqual(replacement, original);
    assert.equal(replacement.config().labels["pi-msb.builder"], "foreign");
  }
  if (failure === "backend-switch") assert.equal(calls.some((call) => call.startsWith("builder-get:")), false);
  for (const path of temporaryPaths(calls)) assert.ok((await fs.stat(path)).isDirectory());
  // No real VM exists in this fixture; only its retained staging needs teardown.
  for (const directory of new Set(temporaryPaths(calls).map(dirname))) await fs.rm(directory, { recursive: true, force: true });
});

test("failed boot cleanup never sweeps previously registered builder names", async (t) => {
  const f = await fixture(t); const calls: string[] = [];
  const sdk = buildSdk(calls, { failStep: "create" });
  const previous = Array.from({ length: 4 }, (_, i) => `pi-msb-builder-00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  for (const name of previous) await sdk.Sandbox.builder(name).labels({ "pi-msb.builder": "previous-owner" }).create().catch(() => undefined);
  calls.length = 0;
  await assert.rejects(buildDockerfileImage({ sdk, source: f.source, acquireLock }), ImagePhaseError);
  const lookups = calls.filter((call) => call.startsWith("builder-get:"));
  assert.equal(lookups.length, 1);
  assert.equal(previous.some((name) => lookups[0] === `builder-get:${name}`), false);
  for (const name of previous) assert.equal((await sdk.Sandbox.get(name)).config().labels["pi-msb.builder"], "previous-owner");
  await assertClean(calls);
});

for (const expectation of [undefined, "missing"]) test(`direct load cannot bypass approval-time selection expectation (${expectation ?? "omitted"})`, async (t) => {
  const f = await fixture(t); const calls: string[] = []; const sdk = buildSdk(calls);
  const built = await buildDockerfileImage({ sdk, source: f.source, acquireLock });
  const replacement = '{"foreign":"selection"}';
  await fs.writeFile(selectionPath(f.source), replacement);
  await assert.rejects(loadDockerfileImage({ sdk, source: f.source, artifactId: built.artifact.artifactId,
    expectedSelectionVersion: expectation as string }), /expectation required|selection changed after approval/);
  assert.equal(calls.some((call) => call.startsWith("image-load:")), false);
  assert.equal(await fs.readFile(selectionPath(f.source), "utf8"), replacement);
});


for (const mode of ["nonzero", "silentEOF", "partialEOF", "transport", "timeout"] as const) test(`export ${mode} retains diagnostic evidence but never publishes even a complete archive`, async (t) => {
  const f = await fixture(t); const calls: string[] = [];
  const sdk = buildSdk(calls, {
    failStep: mode === "nonzero" ? "export" : undefined,
    exportFailure: mode === "transport" ? Object.assign(new Error("SECRET SDK MESSAGE"), { code: "CONNECTION_CLOSED" }) : mode === "timeout" ? Object.assign(new Error("SECRET SDK MESSAGE"), { code: "TIMEOUT" }) : mode === "nonzero" ? undefined : "eof",
    silentExport: mode === "silentEOF",
  });
  await assert.rejects(buildDockerfileImage({ sdk, source: f.source, acquireLock }), (error: unknown) => {
    assert.ok(error instanceof ImagePhaseError);
    assert.equal(error.phase, "export");
    assert.equal(error.diagnostics?.failureKind, mode === "nonzero" ? "commandNonzero" : mode === "transport" ? "transport" : mode === "timeout" ? "timeout" : "streamEndedWithoutExit");
    const log = error.logs.at(-1)!;
    assert.equal(log.exitCode, mode === "nonzero" ? 42 : undefined);
    if (mode !== "silentEOF") { assert.match(log.stdout, /BUILD STDOUT/); assert.match(log.stderr, /PRIVATE GUEST OUTPUT/); }
    else { assert.equal(log.stdout, ""); assert.equal(log.diagnostics?.stdoutBytes, 0); }
    if (mode !== "nonzero") {
      assert.equal(log.diagnostics?.transportCode, mode === "transport" ? "SANDBOX_DOWN" : mode === "timeout" ? "TIMEOUT" : "INVALID");
      assert.equal(log.diagnostics?.requestedTimeoutMs, 1_200_000);
      assert.equal(log.diagnostics?.stderrBytes, mode === "silentEOF" ? 0 : Buffer.byteLength(log.stderr));
      assert.ok(log.diagnostics!.elapsedMs >= 0);
      assert.equal(log.diagnostics?.cleanup.length, 2);
    }
    assert.equal(error.diagnostics?.observations?.authority, "observationOnlyNotCompletionProof");
    assert.equal(error.diagnostics?.observations?.archive.kind, "file");
    assert.ok(error.diagnostics!.observations!.archive.bytes! > 1024);
    assert.equal(error.diagnostics?.observations?.builder.status, "running");
    assert.doesNotMatch(JSON.stringify(error.diagnostics), /SECRET SDK MESSAGE/);
    return true;
  });
  await assert.rejects(fs.stat(buildRecordPath(f.source)), { code: "ENOENT" });
  assert.equal(calls.some((call) => call.startsWith("image-load:")), false);
  await assertClean(calls);
  // Failure is not cached; explicit retry builds and subsequent reuse is verified.
  const retrySdk = buildSdk(calls);
  const retry = await buildDockerfileImage({ sdk: retrySdk, source: f.source, acquireLock });
  assert.equal(retry.cacheHit, false);
  assert.equal((await buildDockerfileImage({ sdk: retrySdk, source: f.source, acquireLock })).cacheHit, true);
});

for (const source of ["user", "aggregateDeadline"] as const) test(`export cancellation reports owned ${source} evidence without invented status`, async (t) => {
  const f = await fixture(t); const calls: string[] = []; const abort = new AbortController();
  const entered = deferred(), gate = deferred();
  const sdk = buildSdk(calls, { export: async () => { entered.resolve(); await gate.promise; }, exportFailure: "eof" });
  if (source === "aggregateDeadline") t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = buildDockerfileImage({ sdk, source: f.source, acquireLock, signal: abort.signal });
  await entered.promise;
  if (source === "user") abort.abort(); else t.mock.timers.tick(1_200_000);
  gate.resolve();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ImagePhaseError);
    assert.equal(error.phase, "export");
    assert.equal(error.diagnostics?.cancellationSource, source);
    assert.equal(error.diagnostics?.failureKind, source === "user" ? "cancelled" : "timeout");
    assert.equal(error.logs.at(-1)?.exitCode, undefined);
    assert.equal(error.logs.at(-1)?.diagnostics?.transportCode, "ABORTED");
    assert.match(error.logs.at(-1)!.stdout, /BUILD STDOUT/);
    assert.equal(error.diagnostics?.observations?.builder.outcome, "skippedCancellation");
    return true;
  });
  await assert.rejects(fs.stat(buildRecordPath(f.source)), { code: "ENOENT" });
  await assertClean(calls);
});

for (const probe of ["reject", "pending", "replacement"] as const) test(`best-effort ${probe} probe and cleanup failures cannot replace primary export failure`, { timeout: 5000 }, async (t) => {
  const f = await fixture(t); const calls: string[] = [];
  const sdk = buildSdk(calls, {
    exportFailure: "eof",
    probe: probe === "replacement" ? undefined : async () => { if (probe === "reject") throw new Error("PRIVATE PROBE"); await new Promise(() => undefined); },
    destroy: async () => { throw new Error("PRIVATE DESTROY"); },
  });
  if (probe === "replacement") {
    const get = sdk.Sandbox.get;
    sdk.Sandbox.get = async (name: string) => ({ ...await get(name), id: "replacement", status: "crashed" });
  }
  await assert.rejects(buildDockerfileImage({ sdk, source: f.source, acquireLock: async () => ({ path: "test", release: async () => { throw new Error("PRIVATE RELEASE"); } }) }), (error: unknown) => {
    assert.ok(error instanceof ImagePhaseError);
    assert.equal(error.phase, "export");
    assert.match(error.message, /ended without an exit event/);
    assert.equal(error.diagnostics?.failureKind, "streamEndedWithoutExit");
    assert.equal(error.diagnostics?.observations?.builder.outcome, probe === "pending" ? "probeBudgetElapsed" : probe === "replacement" ? "identityMismatch" : "probeFailed");
    assert.deepEqual(error.diagnostics?.secondaryFailures.map((entry) => entry.operation), ["builderCleanup", "lockRelease"]);
    assert.doesNotMatch(JSON.stringify(error.diagnostics), /PRIVATE/);
    return true;
  });
  await assert.rejects(fs.stat(buildRecordPath(f.source)), { code: "ENOENT" });
  // Fake VM only: prove uncertain destruction retains staging before test teardown.
  for (const path of temporaryPaths(calls)) assert.ok((await fs.stat(path)).isDirectory());
  for (const directory of new Set(temporaryPaths(calls).map(dirname))) await fs.rm(directory, { recursive: true, force: true });
});

test("archive observation does not follow a symlink or validate its target", async (t) => {
  const f = await fixture(t); const calls: string[] = [];
  const target = join(f.root, "private"); await fs.writeFile(target, "private data");
  const sdk = buildSdk(calls, { exportFailure: "eof", export: async (archive) => { await fs.unlink(archive); await fs.symlink(target, archive); } });
  await assert.rejects(buildDockerfileImage({ sdk, source: f.source, acquireLock }), (error: unknown) => {
    assert.ok(error instanceof ImagePhaseError);
    assert.equal(error.diagnostics?.observations?.archive.kind, "symlink");
    assert.equal(error.diagnostics?.failureKind, "streamEndedWithoutExit");
    return true;
  });
  assert.equal(await fs.readFile(target, "utf8"), "private data"); await assertClean(calls);
});

test("cancellation interrupts pending diagnostic observation without waiting for its budget or publishing", async (t) => {
  const f = await fixture(t); const calls: string[] = []; const abort = new AbortController();
  const entered = deferred(), gate = deferred();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sdk = buildSdk(calls, { exportFailure: "eof", probe: async () => { entered.resolve(); await gate.promise; } });
  const pending = buildDockerfileImage({ sdk, source: f.source, acquireLock, signal: abort.signal });
  await entered.promise; abort.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ImagePhaseError);
    assert.equal(error.diagnostics?.failureKind, "cancelled");
    assert.equal(error.diagnostics?.cancellationSource, "user");
    assert.equal(error.diagnostics?.observations?.builder.outcome, "skippedCancellation");
    assert.equal(error.logs.at(-1)?.exitCode, undefined);
    assert.equal(error.diagnostics?.cleanup?.builder, "removed");
    return true;
  });
  gate.resolve();
  await assert.rejects(fs.stat(buildRecordPath(f.source)), { code: "ENOENT" });
  await assertClean(calls);
});
