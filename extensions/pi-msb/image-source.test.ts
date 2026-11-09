import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_CONFIG, hostConfigPaths, resolveConfig } from "./config.ts";
import { BUILD_LIMITS, BUILD_ROOT_DISK_MIB, BUILD_VERSION, snapshotDockerfile } from "./image-source.ts";
import { SettingsEditor } from "./settings.ts";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp("/tmp/pi-msb-source-test-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = join(root, "home", "work");
  const agentDir = join(root, "agent");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(agentDir);
  const input = { cwd, agentDir, homedir: join(root, "home"), env: {}, projectTrusted: true, configDirName: "pi" };
  const paths = await hostConfigPaths(input);
  const global = join(dirname(paths.global), "Dockerfile");
  const project = join(dirname(paths.project), "Dockerfile");
  const write = async (path: string, text: string) => { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, text); };
  return { root, cwd, input, paths, global, project, write };
}

test("Dockerfile source is atomic by scope and scalar provenance reflects the generated never-pull image", async (t) => {
  const f = await fixture(t);
  await f.write(f.global, "FROM scratch\n");
  let result = await resolveConfig({ ...f.input, env: { PI_MSB_IMAGE: "env-image" }, cliOverridesToml: 'image="cli-image"' });
  assert.match(result.config.image, /^localhost\/pi-msb-build:[a-f0-9]{64}$/);
  assert.equal(result.config.pullPolicy, "never");
  assert.equal(result.provenance.image, "host-default");
  assert.equal(result.provenance.pullPolicy, "host-default");
  assert.equal(result.imageBuild?.dockerfile, f.global);
  assert.match(result.warnings.join(" "), /image source: host-default Dockerfile/);
  await f.write(f.paths.global, 'image="global-explicit"\n');
  result = await resolveConfig(f.input);
  assert.equal(result.config.image, "global-explicit");
  assert.equal(result.imageBuild, undefined);
  await f.write(f.project, "FROM scratch\nLABEL project=true\n");
  result = await resolveConfig(f.input);
  assert.equal(result.imageBuild?.scope, "host-project");
  await f.write(f.paths.project, 'image="project-explicit"\n');
  result = await resolveConfig(f.input);
  assert.equal(result.config.image, "project-explicit");
  assert.equal(result.config.pullPolicy, "if-missing");
  result = await resolveConfig({ ...f.input, temporaryOverrides: { image: "session-image" } });
  assert.equal(result.config.image, "session-image");
  assert.equal(result.provenance.image, "temporary");
  await fs.unlink(f.paths.project);
  result = await resolveConfig({ ...f.input, temporaryOverrides: { image: "session-image" } });
  assert.equal(result.imageBuild, undefined);
  assert.equal(result.config.pullPolicy, "if-missing");
});

test("Dockerfile context hashes exact dedicated bytes and modes, not adjacent policies/repository files", async (t) => {
  const f = await fixture(t);
  await f.write(f.project, "FROM scratch\nCOPY . /\n");
  await f.write(join(dirname(f.project), "build-context", "tool"), "first");
  const first = await resolveConfig(f.input);
  await f.write(join(f.cwd, "secret.txt"), "REPOSITORY PRIVATE");
  await f.write(f.paths.project, "cpus=2\n");
  await f.write(join(dirname(f.global), "other-project.toml"), "POLICY PRIVATE");
  const same = await resolveConfig(f.input);
  assert.equal(same.config.image, first.config.image);
  const snapshot = await snapshotDockerfile(same.imageBuild!, DEFAULT_CONFIG.image);
  assert.deepEqual(snapshot.entries.map((entry) => entry.path), ["Dockerfile", "", "tool"]);
  assert.doesNotMatch(JSON.stringify(snapshot.entries), /PRIVATE/);
  await f.write(join(dirname(f.project), "build-context", "tool"), "second");
  const changed = await resolveConfig(f.input);
  assert.notEqual(changed.config.image, first.config.image);
  await fs.chmod(join(dirname(f.project), "build-context", "tool"), 0o755);
  assert.notEqual((await resolveConfig(f.input)).config.image, changed.config.image);
  await f.write(f.project, "FROM scratch\nLABEL changed=true\n");
  assert.notEqual((await resolveConfig(f.input)).config.image, changed.config.image);
});

test("builder writable disk size participates in Dockerfile cache identity", async (t) => {
  const f = await fixture(t);
  await f.write(f.project, "FROM scratch\n");
  const resolved = await resolveConfig(f.input);
  const snapshot = await snapshotDockerfile(resolved.imageBuild!, DEFAULT_CONFIG.image);
  const identity = (diskSize?: number) => {
    const options = [BUILD_VERSION, DEFAULT_CONFIG.image, snapshot.platform, 2, 4096];
    if (diskSize !== undefined) options.push(diskSize);
    const hash = createHash("sha256").update(JSON.stringify(options));
    for (const entry of snapshot.entries) {
      hash.update(JSON.stringify([entry.path, entry.mode, entry.data?.length ?? null]));
      if (entry.data) hash.update(entry.data);
    }
    return hash.digest("hex");
  };
  assert.equal(snapshot.identity, identity(BUILD_ROOT_DISK_MIB));
  assert.notEqual(snapshot.identity, identity());
});

test("Dockerfile uses canonical exact cwd identity, never parent project policy", async (t) => {
  const f = await fixture(t);
  await f.write(f.project, "FROM scratch\n");
  const nested = join(f.cwd, "nested");
  await fs.mkdir(nested);
  assert.equal((await resolveConfig({ ...f.input, cwd: nested })).imageBuild, undefined);
  const alias = join(f.root, "alias");
  await fs.symlink(f.cwd, alias);
  assert.equal((await resolveConfig({ ...f.input, cwd: alias })).imageBuild?.dockerfile, f.project);
  const outside = join(f.root, "outside");
  await fs.mkdir(outside);
  const absolute = await hostConfigPaths({ ...f.input, cwd: outside });
  assert.match(absolute.project, /projects-absolute/);
});

test("agent-dir symlink is supported but descendants, hardlinks, collisions and special context files fail closed", async (t) => {
  const f = await fixture(t);
  await f.write(f.project, "FROM scratch\n");
  const alias = join(f.root, "agent-alias");
  await fs.symlink(f.input.agentDir, alias);
  assert.ok((await resolveConfig({ ...f.input, agentDir: alias })).imageBuild);
  const context = join(dirname(f.project), "build-context");
  await fs.mkdir(context);
  await fs.symlink(join(f.cwd, "secret"), join(context, "link"));
  await assert.rejects(resolveConfig(f.input), /safely snapshotted/);
  await fs.unlink(join(context, "link"));
  await f.write(join(f.cwd, "secret"), "private");
  await fs.link(join(f.cwd, "secret"), join(context, "hardlink"));
  await assert.rejects(resolveConfig(f.input), /safely snapshotted/);
  await fs.unlink(join(context, "hardlink"));
  await f.write(join(context, "Dockerfile"), "FROM bad");
  await assert.rejects(resolveConfig(f.input), /safely snapshotted/);
  await fs.unlink(join(context, "Dockerfile"));
  await fs.rm(context, { recursive: true });
  await fs.symlink(f.cwd, context);
  await assert.rejects(resolveConfig(f.input), /safely snapshotted/);
  await fs.unlink(context);
  await fs.unlink(f.project);
  await fs.symlink(join(f.cwd, "secret"), f.project);
  await assert.rejects(resolveConfig(f.input), /safely inspected/);
});

test("Dockerfile snapshot bounds and host exposure checks fail closed", async (t) => {
  const f = await fixture(t);
  await f.write(f.global, "FROM scratch\n");
  const context = join(dirname(f.global), "build-context");
  await f.write(join(context, "large"), "");
  await fs.truncate(join(context, "large"), BUILD_LIMITS.bytes + 1);
  await assert.rejects(resolveConfig(f.input), /bounded context/);
  await fs.unlink(join(context, "large"));
  await f.write(f.paths.global, `mounts=[{type="dir",host_path=${JSON.stringify(context)},guest_path="/context",readonly=true}]`);
  await assert.rejects(resolveConfig(f.input), /must not expose Dockerfile/);
  await fs.unlink(f.paths.global);
  await assert.rejects(resolveConfig({ ...f.input, cwd: f.root }), /outside the mounted workspace/);
});

test("settings inspections and unrelated saves preserve discovered source without persisting generated image", async (t) => {
  const f = await fixture(t);
  await f.write(f.project, "FROM scratch\n");
  await f.write(f.paths.project, "cpus=2\n");
  const editor = new SettingsEditor(f.input, "source-test");
  const inspection = await editor.inspect();
  assert.match(JSON.stringify(inspection), /localhost\/pi-msb-build/);
  assert.match(JSON.stringify(inspection), /Dockerfile/);
  const draft = await editor.open("project");
  draft.set("cpus", 3);
  await draft.apply();
  const saved = await fs.readFile(f.paths.project, "utf8");
  assert.doesNotMatch(saved, /image|pull_policy/);
  assert.ok((await resolveConfig(f.input)).imageBuild);
  assert.equal(await fs.stat(join(f.input.agentDir, "pi-microsandbox", "build-cache")).then(() => true, () => false), false);
});

test("higher explicit image disables even invalid lower Dockerfile sources", async (t) => {
  const f = await fixture(t);
  await f.write(f.global, "FROM scratch\n");
  await fs.unlink(f.global); await fs.symlink(join(f.cwd, "missing"), f.global);
  const session = await resolveConfig({ ...f.input, temporaryOverrides: { image: "session-explicit" } });
  assert.equal(session.config.image, "session-explicit");
  await f.write(f.paths.project, 'image="project-explicit"\n');
  assert.equal((await resolveConfig(f.input)).config.image, "project-explicit");
  await fs.unlink(f.paths.project);
  await f.write(f.project, "FROM scratch\n");
  assert.equal((await resolveConfig(f.input)).imageBuild?.scope, "host-project");
});

test("dedicated context rejects excessive depth/entries and non-regular socket files", async (t) => {
  const f = await fixture(t);
  await f.write(f.project, "FROM scratch\n");
  const context = join(dirname(f.project), "build-context");
  await fs.mkdir(join(context, ...Array<string>(BUILD_LIMITS.depth + 1).fill("deep")), { recursive: true });
  await assert.rejects(resolveConfig(f.input), /bounded context/);
  await fs.rm(context, { recursive: true }); await fs.mkdir(context);
  await Promise.all(Array.from({ length: BUILD_LIMITS.entries }, (_, index) => fs.writeFile(join(context, String(index)), "")));
  await assert.rejects(resolveConfig(f.input), /bounded context/);
  await fs.rm(context, { recursive: true }); await fs.mkdir(context);
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(context, "socket"), resolve); });
  try { await assert.rejects(resolveConfig(f.input), /safely snapshotted/); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
