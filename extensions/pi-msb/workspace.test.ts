import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverWorkspace } from "./workspace.ts";
import type { ExecFn } from "./types.ts";

async function fixture(t: test.TestContext, name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pi-msb-workspace-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

function initRepo(path: string): void {
  git(path, ["init", "-q"]);
  git(path, ["config", "user.email", "test@example.invalid"]);
  git(path, ["config", "user.name", "Test"]);
  git(path, ["-c", "commit.gpgSign=false", "commit", "--allow-empty", "-qm", "initial"]);
}

test("a nested Git cwd mounts the canonical repository at its lexical path and retains cwd", async (t) => {
  const root = await fixture(t, "git");
  const repo = join(root, "repo");
  const cwd = join(repo, "packages", "app");
  await mkdir(cwd, { recursive: true });
  initRepo(repo);

  assert.deepEqual(await discoverWorkspace(cwd), {
    hostRoot: await realpath(repo),
    guestRoot: repo,
    cwd,
    fromGit: true,
  });
});

test("a non-Git cwd mounts only its canonical directory at the lexical cwd", async (t) => {
  const root = await fixture(t, "plain");
  const cwd = join(root, "plain");
  await mkdir(cwd);
  assert.deepEqual(await discoverWorkspace(cwd), {
    hostRoot: await realpath(cwd),
    guestRoot: cwd,
    cwd,
    fromGit: false,
  });
});

test("symlinked repository namespaces preserve lexical guest paths", async (t) => {
  const root = await fixture(t, "symlink");
  const repo = join(root, "repo");
  const nested = join(repo, "src", "nested");
  const alias = join(root, "alias");
  await mkdir(nested, { recursive: true });
  initRepo(repo);
  await symlink(repo, alias, "dir");

  const cwd = join(alias, "src", "nested");
  const workspace = await discoverWorkspace(cwd);
  assert.equal(workspace.hostRoot, await realpath(repo));
  assert.equal(workspace.guestRoot, alias);
  assert.equal(workspace.cwd, cwd);
});

test("a root that cannot be represented in the lexical namespace is rejected", async (t) => {
  const root = await fixture(t, "unrepresentable");
  const repo = join(root, "repo");
  const nested = join(repo, "nested");
  const outside = join(root, "outside");
  const alias = join(outside, "alias");
  await mkdir(nested, { recursive: true });
  await mkdir(outside);
  initRepo(repo);
  await symlink(nested, alias, "dir");

  await assert.rejects(discoverWorkspace(alias), /cannot preserve the cwd guest path|unsupported symlink topology/);
});

test("missing, interrupted, and malformed Git discovery fail closed", async (t) => {
  const cwd = await fixture(t, "failures");
  const cases: Array<[ExecFn, RegExp]> = [
    [async () => ({ stdout: "", stderr: "spawn git ENOENT", code: 127 }), /Git workspace discovery failed.*ENOENT/],
    [async () => ({ stdout: "", stderr: "", code: 1, killed: true }), /interrupted/],
    [async () => ({ stdout: "relative/root\n", stderr: "", code: 0 }), /invalid repository root/],
    [async () => ({ stdout: `${cwd}\n/second-root\n`, stderr: "", code: 0 }), /invalid repository root/],
    [async () => ({ stdout: "\n", stderr: "", code: 0 }), /invalid repository root/],
    [async () => ({ stdout: "", stderr: "fatal: not a git repository", code: 1 }), /Git workspace discovery failed/],
  ];
  for (const [exec, pattern] of cases) await assert.rejects(discoverWorkspace(cwd, exec), pattern);
});

test("only an ordinary not-a-repository result falls back to cwd", async (t) => {
  const cwd = await fixture(t, "not-repo");
  const exec: ExecFn = async () => ({ stdout: "", stderr: "fatal: not a git repository", code: 128 });
  assert.equal((await discoverWorkspace(cwd, exec)).fromGit, false);
});

test("workspace roots that overlap guest runtime paths are rejected", async () => {
  const exec: ExecFn = async () => ({ stdout: "", stderr: "fatal: not a git repository", code: 128 });
  await assert.rejects(discoverWorkspace("/", exec), /cannot safely be mounted/);
  await assert.rejects(discoverWorkspace("/usr/local", exec), /cannot safely be mounted/);
});

test("linked worktrees select the linked worktree root", async (t) => {
  const root = await fixture(t, "linked");
  const repo = join(root, "main");
  const linked = join(root, "linked");
  await mkdir(repo);
  initRepo(repo);
  git(repo, ["worktree", "add", "-q", "-b", "linked-branch", linked]);
  const cwd = join(linked, "nested");
  await mkdir(cwd);

  const workspace = await discoverWorkspace(cwd);
  assert.equal(workspace.hostRoot, await realpath(linked));
  assert.equal(workspace.guestRoot, linked);
  assert.equal(workspace.cwd, cwd);
});

test("submodule cwd selects the submodule worktree only", async (t) => {
  const root = await fixture(t, "submodule");
  const source = join(root, "source");
  const parent = join(root, "parent");
  await mkdir(source);
  await mkdir(parent);
  initRepo(source);
  initRepo(parent);
  execFileSync("git", ["-c", "protocol.file.allow=always", "-C", parent, "submodule", "add", "-q", source, "vendor/sub"]);
  git(parent, ["-c", "commit.gpgSign=false", "commit", "-qm", "add submodule"]);
  const submodule = join(parent, "vendor", "sub");

  const workspace = await discoverWorkspace(submodule);
  assert.equal(workspace.hostRoot, await realpath(submodule));
  assert.equal(workspace.guestRoot, submodule);
  assert.equal(workspace.fromGit, true);
});
