import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { discoverWorkspace } from "./workspace.ts";

async function fixture(t: test.TestContext, name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pi-msb-workspace-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initRepo(path: string): void {
  git(path, ["init", "-q"]);
  git(path, ["config", "user.email", "test@example.invalid"]);
  git(path, ["config", "user.name", "Test"]);
  git(path, ["-c", "commit.gpgSign=false", "commit", "--allow-empty", "-qm", "initial"]);
}

async function assertCwdOnly(cwd: string): Promise<void> {
  const lexicalCwd = resolve(cwd);
  assert.deepEqual(await discoverWorkspace(cwd), {
    hostRoot: await realpath(lexicalCwd), guestRoot: lexicalCwd, cwd: lexicalCwd,
  });
}

test("a nested Git cwd mounts exactly cwd, not the repository root", async (t) => {
  const root = await fixture(t, "git");
  const repo = join(root, "repo");
  const cwd = join(repo, "packages", "app");
  await mkdir(cwd, { recursive: true });
  initRepo(repo);
  await assertCwdOnly(cwd);
});

test("a non-Git cwd mounts only its canonical directory at the resolved lexical cwd", async (t) => {
  const root = await fixture(t, "plain");
  const cwd = join(root, "plain");
  await mkdir(cwd);
  await assertCwdOnly(cwd);
  await assertCwdOnly(relative(process.cwd(), cwd));
  await assertCwdOnly(join(cwd, "unused") + "/../.");
});

test("symlinked repository namespaces preserve only the lexical cwd", async (t) => {
  const root = await fixture(t, "symlink");
  const repo = join(root, "repo");
  const nested = join(repo, "src", "nested");
  const alias = join(root, "alias");
  await mkdir(nested, { recursive: true });
  initRepo(repo);
  await symlink(repo, alias, "dir");
  await assertCwdOnly(join(alias, "src", "nested"));
});

test("a symlink directly into a nested repository directory is supported without exposing its ancestors", async (t) => {
  const root = await fixture(t, "nested-alias");
  const repo = join(root, "repo");
  const nested = join(repo, "nested");
  const outside = join(root, "outside");
  const alias = join(outside, "alias");
  await mkdir(nested, { recursive: true });
  await mkdir(outside);
  initRepo(repo);
  await symlink(nested, alias, "dir");
  await assertCwdOnly(alias);
});

test("guest-writable core.worktree pointing to an ancestor cannot widen workspace selection", async (t) => {
  const root = await fixture(t, "malicious-config");
  const repo = join(root, "repo");
  const nested = join(repo, "packages", "app");
  await mkdir(nested, { recursive: true });
  initRepo(repo);
  git(repo, ["config", "core.worktree", root]);
  // Prove this is a real widening attack against Git-based discovery.
  assert.equal(git(nested, ["rev-parse", "--show-toplevel"]), await realpath(root));
  await assertCwdOnly(repo);
  await assertCwdOnly(nested);
});

test("invalid repository config and gitdir files cannot influence selection", async (t) => {
  const root = await fixture(t, "invalid-config");
  const repo = join(root, "repo");
  const cwd = join(repo, "nested");
  await mkdir(cwd, { recursive: true });
  initRepo(repo);
  await writeFile(join(repo, ".git", "config"), "[invalid Git config\n");
  assert.throws(() => git(cwd, ["rev-parse", "--show-toplevel"]));
  await assertCwdOnly(repo);
  await assertCwdOnly(cwd);
  await writeFile(join(cwd, ".git"), "gitdir: /nonexistent/pi-msb-gitdir\n");
  await assertCwdOnly(cwd);
});

test("Git environment, global config, and missing Git cannot influence selection", async (t) => {
  const root = await fixture(t, "git-env");
  const repo = join(root, "repo");
  const cwd = join(repo, "nested");
  const emptyPath = join(root, "empty-path");
  const invalidConfig = join(root, "invalid-gitconfig");
  await mkdir(cwd, { recursive: true });
  await mkdir(emptyPath);
  await writeFile(invalidConfig, "[invalid Git config\n");
  initRepo(repo);
  const cases: NodeJS.ProcessEnv[] = [
    { GIT_DIR: join(repo, ".git"), GIT_WORK_TREE: root },
    { GIT_DIR: join(root, "missing"), GIT_COMMON_DIR: root, GIT_CEILING_DIRECTORIES: root },
    { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: root },
    { GIT_CONFIG_GLOBAL: invalidConfig, GIT_CONFIG_SYSTEM: invalidConfig, GIT_CONFIG_NOSYSTEM: "0" },
    { GIT_CONFIG_COUNT: "not-a-number" },
    { PATH: emptyPath },
  ];
  for (const env of cases) {
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, env);
      if (env.PATH) assert.throws(() => git(cwd, ["--version"]), { code: "ENOENT" });
      await assertCwdOnly(cwd);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
});

test("missing cwd, dangling symlinks, and symlink loops fail closed with canonicalization errors", async (t) => {
  const root = await fixture(t, "failures");
  const missing = join(root, "missing");
  const dangling = join(root, "dangling");
  const loop = join(root, "loop");
  await symlink(missing, dangling, "dir");
  await symlink(loop, loop, "dir");
  for (const cwd of [missing, dangling, loop]) {
    await assert.rejects(discoverWorkspace(cwd), (error: Error) => {
      assert.equal(error.message, `workspace cwd cannot be canonicalized: ${cwd}`);
      assert.ok(error.cause instanceof Error);
      return true;
    });
  }
});

test("workspace roots that overlap guest runtime paths are rejected", async () => {
  for (const cwd of ["/", "/usr", "/bin", "/etc"]) {
    await assert.rejects(discoverWorkspace(cwd), /cannot safely be mounted/);
  }
});

test("linked worktrees bind exactly cwd, including nested directories", async (t) => {
  const root = await fixture(t, "linked");
  const repo = join(root, "main");
  const linked = join(root, "linked");
  await mkdir(repo);
  initRepo(repo);
  git(repo, ["worktree", "add", "-q", "-b", "linked-branch", linked]);
  const cwd = join(linked, "nested");
  await mkdir(cwd);
  await assertCwdOnly(linked);
  await assertCwdOnly(cwd);
});

test("submodules bind exactly cwd, including nested directories", async (t) => {
  const root = await fixture(t, "submodule");
  const source = join(root, "source");
  const parent = join(root, "parent");
  await mkdir(source);
  await mkdir(parent);
  initRepo(source);
  initRepo(parent);
  git(parent, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "vendor/sub"]);
  git(parent, ["-c", "commit.gpgSign=false", "commit", "-qm", "add submodule"]);
  const submodule = join(parent, "vendor", "sub");
  const cwd = join(submodule, "nested");
  await mkdir(cwd);
  await assertCwdOnly(submodule);
  await assertCwdOnly(cwd);
});
