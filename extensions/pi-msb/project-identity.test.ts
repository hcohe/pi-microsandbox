import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { discoverProjectIdentity } from "./project-identity.ts";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-msb-project-identity-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, "repository");
  const linked = join(root, "external", "checkout");
  await mkdir(main);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], { cwd: main, env, stdio: "pipe" });
  git("init", "--initial-branch=main");
  git("commit", "--allow-empty", "-m", "initial");
  git("worktree", "add", "-b", "linked", linked);
  const registration = join(main, ".git", "worktrees", basename(linked));
  return { root, main, linked, registration, git };
}

test("project identity shares main checkout keys for registered external and future worktrees", async (t) => {
  const f = await fixture(t);
  const main = await discoverProjectIdentity(f.main);
  assert.equal(main.projectPolicyRoot, f.main);
  assert.equal(main.worktreePolicyRoot, f.main);
  assert.equal(main.isWorktree, false);
  const identity = await discoverProjectIdentity(f.linked);
  assert.equal(identity.projectPolicyRoot, f.main);
  assert.equal(identity.worktreePolicyRoot, f.linked);
  assert.equal(identity.repositoryName, "repository");
  assert.equal(identity.worktreeName, "checkout");
  assert.equal(identity.isWorktree, true);
  assert.equal(identity.fingerprint, (await discoverProjectIdentity(f.linked)).fingerprint);
  const next = join(f.root, "future");
  f.git("worktree", "add", "-b", "future", next);
  assert.equal((await discoverProjectIdentity(next)).projectPolicyRoot, f.main);
  // Project core.worktree is not a source of policy redirection.
  f.git("config", "core.worktree", join(f.root, "unrelated"));
  assert.equal((await discoverProjectIdentity(f.linked)).projectPolicyRoot, f.main);
});

test("project identity preserves cwd suffix isolation, missing main suffixes, and canonical aliases", async (t) => {
  const f = await fixture(t);
  const nested = join(f.linked, "packages", "app");
  await mkdir(nested, { recursive: true });
  const identity = await discoverProjectIdentity(nested);
  assert.equal(identity.projectPolicyRoot, join(f.main, "packages", "app"));
  assert.equal(identity.worktreePolicyRoot, nested);
  assert.equal(identity.repositoryName, "repository");
  const alias = join(f.root, "alias");
  await symlink(f.linked, alias);
  assert.deepEqual(await discoverProjectIdentity(join(alias, "packages", "app")), identity);
  const mainAlias = join(f.root, "main-alias");
  await symlink(f.main, mainAlias);
  assert.equal((await discoverProjectIdentity(mainAlias)).projectPolicyRoot, f.main);
  await mkdir(join(f.main, "packages"));
  await symlink(join(f.root, "external"), join(f.main, "packages", "app"));
  await assert.rejects(discoverProjectIdentity(nested), /could not be safely verified/);
});

test("project identity verifies reciprocal registration rather than trusting a forged gitfile", async (t) => {
  const f = await fixture(t);
  const forged = join(f.root, "forged");
  await mkdir(forged);
  await writeFile(join(forged, ".git"), await readFile(join(f.linked, ".git")));
  await assert.rejects(discoverProjectIdentity(forged), /could not be safely verified/);
  // Relative pointers are permitted, but they still need the reciprocal match.
  await writeFile(join(f.linked, ".git"), `gitdir: ${relative(f.linked, f.registration)}\n`);
  assert.equal((await discoverProjectIdentity(f.linked)).projectPolicyRoot, f.main);
  await writeFile(join(f.registration, "gitdir"), join(forged, ".git"));
  await assert.rejects(discoverProjectIdentity(f.linked), /could not be safely verified/);
});

test("project identity fails closed on malformed, symlinked, missing, or retargeted metadata", async (t) => {
  const f = await fixture(t);
  const dotgit = join(f.linked, ".git");
  const original = await readFile(dotgit, "utf8");
  for (const value of ["not git", "gitdir: /nonexistent/pi-msb-metadata", `${original.trim()}\nextra`, `gitdir: ${"x".repeat(17000)}`]) {
    await writeFile(dotgit, value);
    await assert.rejects(discoverProjectIdentity(f.linked), /could not be safely verified/);
  }
  await writeFile(dotgit, original);
  const common = join(f.registration, "commondir");
  const commonText = await readFile(common, "utf8");
  await writeFile(common, "/nonexistent/pi-msb-common");
  await assert.rejects(discoverProjectIdentity(f.linked), /could not be safely verified/);
  await writeFile(common, commonText);
  const saved = join(f.root, "saved-gitfile");
  await rename(dotgit, saved);
  await symlink(saved, dotgit);
  await assert.rejects(discoverProjectIdentity(f.linked), /could not be safely verified/);
});

test("project identity changes without policy files when registration or discovery boundaries change", async (t) => {
  const f = await fixture(t);
  const before = await discoverProjectIdentity(f.linked);
  const backpointer = join(f.registration, "gitdir");
  await writeFile(backpointer, `${join(f.linked, ".git")}\n\n`);
  const after = await discoverProjectIdentity(f.linked);
  assert.notEqual(after.fingerprint, before.fingerprint);
  const local = join(f.root, "local");
  await mkdir(local);
  const missing = await discoverProjectIdentity(local);
  await mkdir(join(local, ".git"));
  assert.notEqual((await discoverProjectIdentity(local)).fingerprint, missing.fingerprint);
});

test("project identity fingerprints cwd replacement but not ordinary directory writes", async (t) => {
  const f = await fixture(t);
  const nested = join(f.linked, "nested");
  await mkdir(nested);
  const before = await discoverProjectIdentity(nested);
  await writeFile(join(nested, "guest-file"), "ordinary write");
  assert.equal((await discoverProjectIdentity(nested)).fingerprint, before.fingerprint);
  await rename(nested, join(f.linked, "old-nested"));
  await mkdir(nested);
  assert.notEqual((await discoverProjectIdentity(nested)).fingerprint, before.fingerprint);
});

test("project identity keeps submodules, separate-git-dir, bare, and non-Git cwd-local", async (t) => {
  const f = await fixture(t);
  for (const name of ["submodule", "separate", "ordinary", "bare"]) {
    const cwd = join(f.linked, name);
    await mkdir(cwd);
    if (name === "submodule" || name === "separate") {
      const gitdir = join(f.root, `${name}-metadata`);
      await mkdir(gitdir);
      await writeFile(join(cwd, ".git"), `gitdir: ${gitdir}\n`);
    } else if (name === "bare") {
      await writeFile(join(cwd, "HEAD"), "ref: refs/heads/main\n");
      await mkdir(join(cwd, "objects"));
      await mkdir(join(cwd, "refs"));
    }
    const identity = await discoverProjectIdentity(cwd);
    assert.equal(identity.projectPolicyRoot, name === "ordinary" ? join(f.main, name) : cwd);
    assert.equal(identity.isWorktree, name === "ordinary");
  }
  const nonGit = join(f.root, "non-git");
  await mkdir(nonGit);
  assert.equal((await discoverProjectIdentity(nonGit)).projectPolicyRoot, nonGit);
});
