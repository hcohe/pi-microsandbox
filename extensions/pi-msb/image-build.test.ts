import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildSdk, dockerArchive, tarArchive } from "../../test/image-build-fixture.ts";
import { hostConfigPaths, resolveConfig } from "./config.ts";
import { createMsbIntegration } from "./control.ts";
import { BUILD_FAILURE, ensureDockerfileImage } from "./image-build.ts";
import { prepareBuildArchive } from "./image-archive.ts";
import { buildImageReference, nativeBuildPlatform } from "./image-source.ts";

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
  return { root, input, paths, dockerfile, resolved, source: resolved.imageBuild! };
}
const acquireLock = async () => ({ path: "test", release: async () => undefined });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const temporaryPaths = (calls: string[]) => calls.filter((call) => call.startsWith("builder-bind:")).map((call) => call.slice(call.indexOf(":", "builder-bind:".length) + 1));
async function assertClean(calls: string[]) { for (const path of temporaryPaths(calls)) assert.equal(await fs.stat(path).then(() => true, () => false), false, path); }

test("builder uses isolated pinned-image root VM, public-only policy and argv; sanitized archive is imported once and cache reused", async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  const sdk = buildSdk(calls);
  await ensureDockerfileImage({ sdk, source: f.source, acquireLock });
  assert.ok(calls.includes("builder-cpus:2"));
  assert.ok(calls.includes("builder-memory:4096"));
  assert.ok(calls.includes("builder-rootDisk:8192"));
  assert.ok(calls.findIndex((call) => call.startsWith("builder-image:")) < calls.indexOf("builder-rootDisk:8192"));
  assert.ok(calls.includes("builder-security:default"));
  assert.ok(calls.includes("builder-user:root"));
  assert.ok(calls.includes("builder-detached:false"));
  assert.ok(calls.includes("builder-maxDuration:1200"));
  assert.ok(calls.includes("builder-profiles:public"));
  assert.match(calls.find((call) => call.startsWith("builder-network:"))!, /"defaultIngress":"deny"/);
  assert.ok(calls.includes("builder-readonly:/pi-msb-input"));
  assert.equal(calls.filter((call) => call.startsWith("builder-bind:")).length, 2);
  assert.equal(calls.some((call) => /secret|envs|allowAll/.test(call)), false);
  assert.match(calls.find((call) => call.includes('"buildx"'))!, /"--load"/);
  assert.match(calls.find((call) => call.includes('"buildx"'))!, /"-i","PATH=/);
  assert.match(calls.find((call) => call.startsWith("image-load:"))!, /validated-image.tar/);
  assert.ok(calls.indexOf("builder-destroy") < calls.findIndex((call) => call.startsWith("image-load:")));
  const record = JSON.parse(await fs.readFile(join(f.source.cacheDir, `${f.source.identity}.json`), "utf8"));
  assert.equal(record.digest, `sha256:${"a".repeat(64)}`);
  await ensureDockerfileImage({ sdk, source: f.source, acquireLock });
  assert.equal(calls.filter((call) => call === "builder-create").length, 1);
  assert.equal(calls.filter((call) => call.startsWith("image-load:")).length, 1);
  await assertClean(calls);
});

test("changed content invalidates image identity; changed source after resolution and alias/cache retargeting fail before SDK create", async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  const sdk = buildSdk(calls);
  await fs.writeFile(f.dockerfile, "FROM scratch\nLABEL changed=true\n");
  await assert.rejects(ensureDockerfileImage({ sdk, source: f.source, acquireLock }), { message: BUILD_FAILURE });
  assert.equal(calls.includes("builder-create"), false);
  const next = await resolveConfig(f.input);
  assert.notEqual(next.config.image, f.resolved.config.image);
  await ensureDockerfileImage({ sdk, source: next.imageBuild!, acquireLock });
  await assertClean(calls);
  const alias = join(f.root, "alias");
  await fs.symlink(f.input.agentDir, alias);
  const aliased = await resolveConfig({ ...f.input, agentDir: alias });
  await fs.unlink(alias); await fs.symlink(f.input.cwd, alias);
  await assert.rejects(ensureDockerfileImage({ sdk, source: aliased.imageBuild!, acquireLock }), { message: BUILD_FAILURE });
  await fs.rm(next.imageBuild!.cacheDir, { recursive: true });
  await fs.symlink(f.input.cwd, next.imageBuild!.cacheDir);
  await assert.rejects(ensureDockerfileImage({ sdk, source: next.imageBuild!, acquireLock }), { message: BUILD_FAILURE });
});

test("cross-process lock deduplicates concurrent content builds and validates cached digest/platform", async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  const gate = deferred();
  const entered = deferred();
  const sdk = buildSdk(calls, { build: async () => { entered.resolve(); await gate.promise; } });
  const first = ensureDockerfileImage({ sdk, source: f.source });
  await entered.promise;
  const second = ensureDockerfileImage({ sdk, source: f.source });
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(calls.filter((call) => call === "builder-create").length, 1);
  const get = sdk.Image!.get;
  sdk.Image!.get = async (reference) => ({ ...await get(reference), architecture: "wrong" });
  await assert.rejects(ensureDockerfileImage({ sdk, source: f.source }), { message: BUILD_FAILURE });
  assert.equal(calls.filter((call) => call === "builder-create").length, 2);
  await assertClean(calls);
});

for (const failStep of ["create", "build", "import"]) test(`build ${failStep} failure is generic, uncached and cleans owned resources`, async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  await assert.rejects(ensureDockerfileImage({ sdk: buildSdk(calls, { failStep }), source: f.source, acquireLock }), { message: BUILD_FAILURE });
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
  const pending = ensureDockerfileImage({ sdk, source: f.source, acquireLock, signal: abort.signal });
  await entered.promise;
  abort.abort(); gate.resolve();
  await assert.rejects(pending, { message: BUILD_FAILURE });
  assert.ok(calls.includes("builder-destroy"));
  assert.equal(calls.some((call) => call.startsWith("image-load:")), false);
  await assertClean(calls);
  const buildGate = deferred(); const buildEntered = deferred(); const activeAbort = new AbortController();
  const activeSdk = buildSdk(calls, { build: async () => { buildEntered.resolve(); await buildGate.promise; } });
  const active = ensureDockerfileImage({ sdk: activeSdk, source: f.source, acquireLock, signal: activeAbort.signal });
  await buildEntered.promise;
  activeAbort.abort(); buildGate.resolve();
  await assert.rejects(active, { message: BUILD_FAILURE });
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
  await assert.rejects(ensureDockerfileImage({ sdk, source: f.source, acquireLock }), { message: BUILD_FAILURE });
  assert.equal(calls.some((call) => call.startsWith("image-load:")), false);
  await assertClean(calls);
  sdk.defaultBackendKind = () => "cloud";
  await assert.rejects(ensureDockerfileImage({ sdk, source: f.source, acquireLock }), { message: BUILD_FAILURE });
  assert.equal(calls.filter((call) => call === "builder-create").length, 1);
});

test("activation builds before runtime create, uses never-pull labels, and rebuilds before destroying adopted VM", async (t) => {
  const f = await fixture(t); const calls: string[] = [];
  const sdk = buildSdk(calls);
  const integration = createMsbIntegration({ sessionId: "build-lifecycle", cwd: f.input.cwd, configDirName: "pi", agentDir: f.input.agentDir, env: { HOME: f.root }, sdkLoader: async () => sdk,
    acquireOwnerLock: async () => ({ path: "test", release: async () => undefined }), locksPort: { tryAcquire: async () => null } });
  t.after(() => integration.manager.shutdown());
  const config = f.resolved;
  config.config.pruneOnStart = false; config.config.docker.mode = "disabled";
  const initial = await integration.configureSession({ sessionId: "build-lifecycle", cwd: f.input.cwd, projectTrusted: true, config });
  assert.equal(initial.status, "active");
  assert.ok(calls.includes("pull-policy:never"));
  assert.match(calls.find((call) => call.startsWith("labels:"))!, new RegExp(f.source.identity));
  const firstRuntime = calls.findIndex((call) => call.startsWith("create:"));
  assert.ok(calls.findIndex((call) => call.startsWith("image-load:")) < firstRuntime);
  await fs.writeFile(f.paths.project, 'prune_on_start=false\n[docker]\nmode="disabled"\n');
  await fs.writeFile(f.dockerfile, "FROM scratch\nLABEL changed=true\n");
  const boundary = calls.length;
  await integration.control.reload();
  const changed = calls.slice(boundary);
  const imported = changed.findIndex((call) => call.startsWith("image-load:"));
  assert.ok(imported >= 0);
  assert.ok(imported < changed.findIndex((call) => call.startsWith("stop:")));
  assert.notEqual(integration.control.getEffectiveConfig().config.image, config.config.image);
  await assertClean(calls);
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

test("cache digest mismatch triggers rebuild, and failed builder destruction withholds import and retains only isolated output", async (t) => {
  const f = await fixture(t); const calls: string[] = [];
  const sdk = buildSdk(calls);
  await ensureDockerfileImage({ sdk, source: f.source, acquireLock });
  const metadata = join(f.source.cacheDir, `${f.source.identity}.json`);
  const record = JSON.parse(await fs.readFile(metadata, "utf8"));
  await fs.writeFile(metadata, JSON.stringify({ ...record, digest: `sha256:${"b".repeat(64)}` }));
  await ensureDockerfileImage({ sdk, source: f.source, acquireLock });
  assert.equal(calls.filter((call) => call === "builder-create").length, 2);
  await fs.unlink(metadata);
  const failedCalls: string[] = [];
  let released = false;
  await assert.rejects(ensureDockerfileImage({ sdk: buildSdk(failedCalls, { failStep: "destroy" }), source: f.source,
    acquireLock: async () => ({ path: "test", release: async () => { released = true; } }) }), { message: BUILD_FAILURE });
  assert.ok(released);
  assert.equal(failedCalls.some((call) => call.startsWith("image-load:")), false);
  assert.equal(await fs.stat(metadata).then(() => true, () => false), false);
  for (const path of temporaryPaths(failedCalls)) assert.ok((await fs.stat(path)).isDirectory());
  // Fake SDK has no actual VM; test teardown can safely remove retained output.
  for (const directory of new Set(temporaryPaths(failedCalls).map(dirname))) await fs.rm(directory, { recursive: true, force: true });
});

test("Off invalidates a gated build before runtime activation/persistence, and On uses a fresh controller", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t); const calls: string[] = []; const persisted: any[] = [];
  const gate = deferred(); const entered = deferred(); let builds = 0;
  const sdk = buildSdk(calls, { build: async () => { if (++builds === 2) { entered.resolve(); await gate.promise; } } });
  const integration = createMsbIntegration({ sessionId: "off-build", cwd: f.input.cwd, configDirName: "pi", agentDir: f.input.agentDir, env: { HOME: f.root }, sdkLoader: async () => sdk,
    appendEntry: (_type, data) => persisted.push(data), acquireOwnerLock: async () => ({ path: "test", release: async () => undefined }) });
  t.after(() => integration.manager.shutdown());
  f.resolved.config.pruneOnStart = false; f.resolved.config.docker.mode = "disabled";
  assert.equal((await integration.configureSession({ sessionId: "off-build", cwd: f.input.cwd, projectTrusted: true, config: f.resolved })).status, "active");
  await fs.writeFile(f.paths.project, 'prune_on_start=false\n[docker]\nmode="disabled"\n');
  await fs.writeFile(f.dockerfile, "FROM scratch\nLABEL changed=true\n");
  const reload = integration.control.reload();
  await entered.promise;
  await integration.control.setEnabled(false);
  const boundary = calls.length; const persistenceBoundary = persisted.length;
  assert.equal(integration.control.getState().status, "off");
  gate.resolve();
  await reload;
  assert.equal(integration.control.getState().status, "off");
  assert.equal(calls.slice(boundary).some((call) => call.startsWith("create:")), false);
  assert.equal(persisted.slice(persistenceBoundary).some((entry) => entry.enabled === true), false);
  assert.equal(persisted.at(-1).enabled, false);
  await integration.control.setEnabled(true);
  assert.equal(integration.control.getState().status, "active");
  assert.equal(persisted.at(-1).enabled, true);
  await assertClean(calls);
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
  await ensureDockerfileImage({ sdk, source: f.source, acquireLock });
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
  await assert.rejects(ensureDockerfileImage({ sdk: buildSdk(calls), source: f.source, acquireLock }), { message: BUILD_FAILURE });
  assert.equal(calls.includes("builder-create"), false);
  if (retarget) {
    assert.equal(await fs.readFile(join(owned, "foreign"), "utf8"), "untouched");
    assert.ok((await fs.stat(moved)).isDirectory());
  } else assert.equal(await fs.stat(owned).then(() => true, () => false), false);
});

test("failed create before persistence removes staging on authoritative local database absence", async (t) => {
  const f = await fixture(t); const calls: string[] = [];
  const sdk = buildSdk(calls, { failStep: "create", persistBeforeCreate: false });
  await assert.rejects(ensureDockerfileImage({ sdk, source: f.source, acquireLock }), { message: BUILD_FAILURE });
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
  await assert.rejects(ensureDockerfileImage({ sdk, source: f.source, acquireLock }), { message: BUILD_FAILURE });
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
  await assert.rejects(ensureDockerfileImage({ sdk, source: f.source, acquireLock: async () => ({ path: "test", release: async () => { released = true; } }) }), { message: BUILD_FAILURE });
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
  await assert.rejects(ensureDockerfileImage({ sdk, source: f.source, acquireLock }), { message: BUILD_FAILURE });
  const lookups = calls.filter((call) => call.startsWith("builder-get:"));
  assert.equal(lookups.length, 1);
  assert.equal(previous.some((name) => lookups[0] === `builder-get:${name}`), false);
  for (const name of previous) assert.equal((await sdk.Sandbox.get(name)).config().labels["pi-msb.builder"], "previous-owner");
  await assertClean(calls);
});
