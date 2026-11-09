import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { DEFAULT_CONFIG, hostConfigPaths, hostConfigTargets, parseTomlConfig, resolveConfig, type ResolveConfigInput } from "./config.ts";

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

test("host config targets share the repository key and retain existing cwd overrides as the worktree layer", async (t) => {
  const f = await fixture(t);
  const mainPaths = await hostConfigPaths({ ...f.input, cwd: f.main });
  assert.deepEqual(Object.keys(mainPaths), ["global", "project", "worktree"]);
  assert.equal(f.paths.project, mainPaths.project);
  assert.equal(f.paths.worktree, join(f.input.agentDir!, "pi-microsandbox", "projects", "external", "checkout", "config.toml"));
  const targets = await hostConfigTargets(f.input);
  assert.equal(targets.repositoryName, "repository");
  assert.equal(targets.worktreeName, "checkout");
  assert.equal(targets.isWorktree, true);
  assert.equal(targets.identity.association.kind, "linked");
  await f.save(f.paths.project, "cpus = 2\nmemory_mib = 2048");
  await f.save(f.paths.worktree!, "cpus = 3");
  let result = await resolveConfig(f.input);
  assert.equal(result.config.cpus, 3);
  assert.equal(result.config.memoryMiB, 2048);
  assert.equal(result.provenance.cpus, "host-worktree");
  assert.equal(result.provenance.memoryMiB, "host-project");
  result = await resolveConfig({ ...f.input, temporaryOverrides: { cpus: 5 } });
  assert.equal(result.config.cpus, 5);
  assert.equal(result.provenance.cpus, "temporary");
  assert.equal(parseTomlConfig("cpus = 3", "host-worktree").name, "host-worktree");
});

test("host-worktree lists are authoritative including empty arrays and identity provenance", async (t) => {
  const f = await fixture(t);
  await f.save(f.paths.global, 'cpus = 1\nhost_env = ["GLOBAL"]');
  await f.save(f.paths.project, `
route_tools = ["read", "bash"]
pass_through_tools = ["fetch_content"]
host_env = ["PROJECT"]
mounts = [{ host_path = ${JSON.stringify(f.main)}, guest_path = "/mnt/shared", readonly = true }]
secrets = [{ env = "TOKEN", text_value = "shared", allow_hosts = ["api.example"] }]
[network]
allow_hosts = ["api.example"]
publish_ports = ["127.0.0.1:8080:80"]
`);
  await f.save(f.paths.worktree!, `
route_tools = []
pass_through_tools = []
host_env = []
mounts = []
secrets = []
[network]
allow_hosts = []
publish_ports = []
`);
  const result = await resolveConfig(f.input);
  assert.equal(result.config.cpus, 1);
  for (const field of ["routeTools", "passThroughTools", "hostEnv", "mounts", "secrets"] as const) {
    assert.deepEqual(result.config[field], []);
    assert.equal(result.provenance[field], "host-worktree");
  }
  assert.deepEqual(result.config.network.allowHosts, []);
  assert.deepEqual(result.config.network.publishPorts, []);
  assert.equal(result.provenance["network.allowHosts"], "host-worktree");
  assert.equal(result.provenance["network.publishPorts"], "host-worktree");
  assert.equal(result.provenance["secrets[TOKEN]"], undefined);
  assert.equal(result.provenance["mounts[/mnt/shared]"], undefined);
});

test("host config nested worktrees remain cwd-local without inheriting root policies or changing workspace checks", async (t) => {
  // Linux /tmp is reserved in the guest; use the checkout to reach the
  // distinct project-mount shadowing check rather than that earlier guard.
  const f = await fixture(t, fileURLToPath(new URL("../../", import.meta.url)));
  const cwd = join(f.linked, "nested");
  await mkdir(cwd);
  await f.save(f.paths.project, "cpus = 2");
  await f.save(f.paths.worktree!, "cpus = 3");
  const nestedInput = { ...f.input, cwd };
  assert.equal((await resolveConfig(nestedInput)).config.cpus, DEFAULT_CONFIG.cpus);
  const paths = await hostConfigPaths(nestedInput);
  assert.equal(paths.project, join(dirname(f.paths.worktree!), "nested", "config.toml"));
  assert.equal(paths.worktree, undefined);
  await f.save(paths.project, "cpus = 6");
  assert.equal((await resolveConfig(nestedInput)).config.cpus, 6);
  // The main checkout is NOT the mounted project: mounting it read-only at a
  // non-overlapping guest path remains valid; shadowing actual cwd does not.
  await resolveConfig({ ...nestedInput, temporaryOverrides: { mounts: [{ type: "dir", hostPath: f.main, guestPath: "/mnt/main", readonly: true, options: [] }] } });
  await assert.rejects(resolveConfig({ ...nestedInput, temporaryOverrides: { mounts: [{ type: "dir", hostPath: f.main, guestPath: cwd, readonly: true, options: [] }] } }), /must not shadow the project mount/);
});

test("host-worktree Dockerfiles take precedence, explicit images suppress lower sources, and context stays protected", async (t) => {
  const f = await fixture(t);
  await f.save(join(dirname(f.paths.project), "Dockerfile"), "FROM scratch\nLABEL scope=shared\n");
  const dockerfile = join(dirname(f.paths.worktree!), "Dockerfile");
  await f.save(dockerfile, "FROM scratch\nLABEL scope=worktree\n");
  const context = join(dirname(dockerfile), "build-context");
  await mkdir(context);
  await f.save(join(context, "source"), "bytes");
  let result = await resolveConfig(f.input);
  assert.equal(result.imageBuild?.scope, "host-worktree");
  assert.equal(result.imageBuild?.dockerfile, dockerfile);
  assert.equal(result.provenance.image, "host-worktree");
  assert.equal(result.provenance.pullPolicy, "host-worktree");
  for (const hostPath of [dockerfile, context]) {
    await assert.rejects(resolveConfig({ ...f.input, temporaryOverrides: { mounts: [{ type: "dir", hostPath, guestPath: "/mnt/build", readonly: true, options: [] }] } }), /must not expose Dockerfile or build-context/);
  }
  await f.save(f.paths.worktree!, 'image = "example.test/worktree:tag"');
  result = await resolveConfig(f.input);
  assert.equal(result.imageBuild, undefined);
  assert.equal(result.config.image, "example.test/worktree:tag");
  result = await resolveConfig({ ...f.input, temporaryOverrides: { image: "example.test/temporary:tag" } });
  assert.equal(result.config.image, "example.test/temporary:tag");
});

test("host worktree policy and reciprocal Git proof cannot be exposed by writable mounts", async (t) => {
  const f = await fixture(t);
  for (const hostPath of [f.main, join(f.main, ".git"), f.registration, join(f.registration, "gitdir"), join(f.registration, "commondir"), dirname(f.paths.worktree!)]) {
    await mkdir(dirname(f.paths.worktree!), { recursive: true });
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
