import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { hostConfigPaths, hostConfigTargets, resolveConfig, type ResolveConfigInput } from "./config.ts";

async function fixture(t: TestContext, parent = tmpdir()) {
  const root = await realpath(await mkdtemp(join(parent, "pi-msb-config-worktree-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, "repository");
  const linked = join(root, "external", "checkout");
  const registration = join(main, ".git", "worktrees", "checkout");
  await mkdir(registration, { recursive: true });
  await mkdir(linked, { recursive: true });
  await writeFile(join(registration, "commondir"), "../..\n");
  await writeFile(join(registration, "gitdir"), `${join(linked, ".git")}\n`);
  await writeFile(join(linked, ".git"), `gitdir: ${registration}\n`);
  const input: ResolveConfigInput = { cwd: linked, homedir: root, agentDir: join(root, "agent"), env: {}, projectTrusted: true, configDirName: ".pi" };
  const paths = await hostConfigPaths(input);
  const save = async (file: string, text: string) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, file === paths.project ? `_repository = { version = 1, common_dir = ${JSON.stringify(join(main, ".git"))}, main_root = ${JSON.stringify(main)} }\n${text}` : text);
  };
  return { root, main, linked, registration, input, paths, save };
}

test("host Project uses one main-root record from main, linked and nested cwd", async (t) => {
  const f = await fixture(t);
  assert.equal(f.paths.project, join(f.input.agentDir!, "pi-microsandbox", "projects", "repository", "config.toml"));
  const nested = join(f.linked, "nested"); const mainNested = join(f.main, "nested");
  await mkdir(nested); await mkdir(mainNested);
  await f.save(f.paths.global, "cpus = 1");
  await f.save(f.paths.project, "cpus = 2\nmemory_mib = 2048");
  for (const cwd of [f.main, f.linked, nested, mainNested]) {
    assert.deepEqual(await hostConfigPaths({ ...f.input, cwd }), f.paths);
    const resolved = await resolveConfig({ ...f.input, cwd });
    assert.equal(resolved.config.cpus, 2);
    assert.equal(resolved.config.memoryMiB, 2048);
    assert.equal(resolved.provenance.cpus, "host-project");
  }
  assert.equal((await resolveConfig({ ...f.input, temporaryOverrides: { cpus: 5 } })).config.cpus, 5);
});

test("host Project source uses readable siblings and retains explicit image and Session precedence", async (t) => {
  const f = await fixture(t);
  await f.save(f.paths.project, "cpus = 2");
  const dockerfile = join(dirname(f.paths.project), "Dockerfile");
  await f.save(dockerfile, "FROM scratch\nLABEL scope=shared\n");
  const result = await resolveConfig(f.input);
  assert.equal(result.imageBuild?.scope, "host-project");
  assert.equal(result.imageBuild?.dockerfile, dockerfile);
  assert.equal(result.provenance.image, "host-project");
  await mkdir(join(dirname(dockerfile), "build-context"));
  for (const hostPath of [dockerfile, join(dirname(dockerfile), "build-context")]) {
    await assert.rejects(resolveConfig({ ...f.input, temporaryOverrides: { mounts: [{ type: "dir", hostPath, guestPath: "/mnt/build", readonly: true, options: [] }] } }), /must not expose Dockerfile or build-context/);
  }
  await f.save(f.paths.project, 'image = "example.test/project:tag"');
  assert.equal((await resolveConfig(f.input)).config.image, "example.test/project:tag");
  assert.equal((await resolveConfig({ ...f.input, temporaryOverrides: { image: "example.test/session:tag" } })).config.image, "example.test/session:tag");
});

test("nested Project inheritance never changes actual cwd mount shadow checks", async (t) => {
  const f = await fixture(t, fileURLToPath(new URL("../../", import.meta.url)));
  const cwd = join(f.linked, "nested"); await mkdir(cwd);
  await f.save(f.paths.project, "cpus = 2");
  const input = { ...f.input, cwd };
  assert.equal((await resolveConfig(input)).config.cpus, 2);
  await resolveConfig({ ...input, temporaryOverrides: { mounts: [{ type: "dir", hostPath: f.main, guestPath: "/mnt/main", readonly: true, options: [] }] } });
  await assert.rejects(resolveConfig({ ...input, temporaryOverrides: { mounts: [{ type: "dir", hostPath: f.main, guestPath: cwd, readonly: true, options: [] }] } }), /must not shadow the project mount/);
});

test("host worktree policy and reciprocal Git proof cannot be exposed by writable mounts", async (t) => {
  const f = await fixture(t);
  for (const hostPath of [f.main, join(f.main, ".git"), f.registration, join(f.registration, "gitdir"), join(f.registration, "commondir"), dirname(f.paths.project)]) {
    await mkdir(dirname(f.paths.project), { recursive: true });
    await assert.rejects(resolveConfig({ ...f.input, temporaryOverrides: { mounts: [{ type: "dir", hostPath, guestPath: "/mnt/proof", readonly: false, options: [] }] } }), /writable host mounts must not expose host configuration/);
  }
  await resolveConfig({ ...f.input, temporaryOverrides: { mounts: [{ type: "dir", hostPath: f.registration, guestPath: "/mnt/proof", readonly: true, options: [] }] } });
  // A symlink spelling cannot bypass the reservation.
  const alias = join(f.root, "metadata-alias");
  await symlink(f.registration, alias);
  await assert.rejects(resolveConfig({ ...f.input, temporaryOverrides: { mounts: [{ type: "dir", hostPath: alias, guestPath: "/mnt/proof", readonly: false, options: [] }] } }), /writable host mounts must not expose host configuration/);
});

test("host config rejects guest-fabricated reciprocal proof inside the actual cwd bind", async (t) => {
  const f = await fixture(t);
  const common = join(f.linked, "fake-main", ".git");
  const registration = join(common, "worktrees", "fabricated");
  await mkdir(registration, { recursive: true });
  await writeFile(join(registration, "commondir"), "../..");
  await writeFile(join(registration, "gitdir"), join(f.linked, ".git"));
  await writeFile(join(f.linked, ".git"), `gitdir: ${registration}\n`);
  await assert.rejects(hostConfigTargets(f.input), /could not be safely verified/);
  await assert.rejects(resolveConfig(f.input), /could not be safely verified/);
});
