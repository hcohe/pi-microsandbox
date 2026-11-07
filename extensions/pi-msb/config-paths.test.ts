import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { canonicalPolicyLocation, DEFAULT_CONFIG, resolveConfig } from "./config.ts";

async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-config-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const file = join(agentDir, "pi-microsandbox", "default.toml");
  await mkdir(workspace);
  const resolve = (cwd = workspace, agent = agentDir) => resolveConfig({
    cwd, agentDir: agent, homedir: root, projectTrusted: true, configDirName: ".pi", env: {},
  });
  return { root, workspace, agentDir, file, resolve };
}

test("policy canonicalization retries concurrent directory creation but rejects dangling links", async (t) => {
  const { root, agentDir } = await fixture(t);
  let attempts = 0;
  const canonical = await canonicalPolicyLocation(agentDir, async (path) => {
    if (path === agentDir && attempts++ === 0) {
      await mkdir(agentDir);
      throw Object.assign(new Error("directory appeared after the missing-path lookup"), { code: "ENOENT" });
    }
    return realpath(path);
  });
  assert.equal(canonical, await realpath(agentDir));
  assert.equal(attempts, 2);
  const dangling = join(root, "dangling-agent");
  await symlink(join(root, "missing-agent"), dangling);
  await assert.rejects(canonicalPolicyLocation(dangling), /could not be canonicalized/);
});

test("read-only resolution rejects workspace paths, symlink targets, and dangling links without writing", async (t) => {
  const { root, workspace, agentDir, file, resolve } = await fixture(t);
  await assert.rejects(resolve(workspace, join(workspace, "agent")), /outside the mounted workspace/);
  await assert.rejects(stat(join(workspace, "agent")), { code: "ENOENT" });
  await mkdir(agentDir);
  await symlink(workspace, dirname(file));
  await assert.rejects(resolve(), /outside the mounted workspace/);
  await assert.rejects(stat(join(workspace, "default.toml")), { code: "ENOENT" });
  await rm(dirname(file));
  await mkdir(dirname(file));
  const local = join(workspace, "policy.toml");
  await writeFile(local, "");
  await symlink(local, file);
  await assert.rejects(resolve(), /outside the mounted workspace/);
  assert.equal(await readFile(local, "utf8"), "");
  await rm(file);
  await symlink(join(root, "missing"), file);
  await assert.rejects(resolve(), /canonicalized/);
});

test("read-only resolution rejects lexical and canonical ancestor traversal through the workspace", async (t) => {
  const { root, workspace, resolve } = await fixture(t);
  const outside = join(root, "outside");
  await mkdir(outside);
  const lexicalAgent = join(workspace, "agent");
  await symlink(outside, lexicalAgent);
  const projectAlias = join(root, "project-alias");
  await symlink(workspace, projectAlias);
  const bridge = join(workspace, "bridge");
  await mkdir(bridge);
  await symlink(outside, join(bridge, "pi-microsandbox"));
  const traversingAgent = join(root, "traversing-agent");
  await symlink(bridge, traversingAgent);
  for (const [project, agentDir] of [
    [workspace, lexicalAgent], [projectAlias, join(projectAlias, "agent")],
    [workspace, traversingAgent],
  ] as const) {
    await assert.rejects(resolve(project, agentDir), /outside the mounted workspace/);
  }
  await assert.rejects(stat(join(outside, "default.toml")), { code: "ENOENT" });
  await assert.rejects(stat(join(outside, "pi-microsandbox")), { code: "ENOENT" });
  const safeAgent = join(root, "safe-agent");
  assert.equal((await resolve(projectAlias, safeAgent)).config.cpus, DEFAULT_CONFIG.cpus);
  await assert.rejects(stat(safeAgent), { code: "ENOENT" });
});

test("read-only resolution preserves safe existing symlinks and fails on unusable directories", async (t) => {
  const { root, agentDir, file, resolve } = await fixture(t);
  await mkdir(dirname(file), { recursive: true });
  const external = join(root, "external.toml");
  await writeFile(external, "cpus = 2\n", { mode: 0o640 });
  const before = await stat(external);
  await symlink(external, file);
  assert.equal((await resolve()).config.cpus, 2);
  assert.equal(await readFile(file, "utf8"), "cpus = 2\n");
  const after = await stat(external);
  for (const key of ["ino", "mode", "mtimeMs", "ctimeMs"] as const) assert.equal(after[key], before[key]);
  await rm(agentDir, { recursive: true });
  await writeFile(agentDir, "not a directory");
  await assert.rejects(resolve(), /host configuration.*canonicalized|could not be read/);
});

test("read-only config resolution creates neither policy files nor empty directories", async (t) => {
  const { agentDir, file, resolve } = await fixture(t);
  assert.equal((await resolve()).config.cpus, DEFAULT_CONFIG.cpus);
  await assert.rejects(stat(file), { code: "ENOENT" });
  await assert.rejects(stat(agentDir), { code: "ENOENT" });
  await mkdir(agentDir);
  await resolve();
  await assert.rejects(stat(dirname(file)), { code: "ENOENT" });
});

test("read-only resolution uses Pi's custom agent directory without creating it", async (t) => {
  const { root, workspace, agentDir } = await fixture(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await resolveConfig({ cwd: workspace, homedir: root, projectTrusted: true, configDirName: ".pi", env: {} });
    await assert.rejects(stat(agentDir), { code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
