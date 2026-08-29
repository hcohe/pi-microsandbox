import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, readdir, stat, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  createSeedBundle,
  detectGitRepo,
  fileUrl,
} from "./git.ts";
import type { ExecFn } from "./types.ts";

const execFileAsync = promisify(execFile);

async function git(repo: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return String(result.stdout);
}

async function makeRepo(name: string): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-git-test-"));
  const repo = join(root, name);
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.email", "pi-msb@example.invalid"]);
  await git(repo, ["config", "user.name", "pi-msb test"]);
  await git(repo, ["config", "commit.gpgSign", "false"]);
  return { root, repo };
}

async function commit(repo: string, content: string, message: string): Promise<string> {
  await writeFile(join(repo, "committed.txt"), content);
  await git(repo, ["add", "--", "committed.txt"]);
  await git(repo, ["commit", "-q", "-m", message]);
  return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

async function remove(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

test("detects canonical root, slash branches, exact HEAD, and ordinary worktrees", async () => {
  const { root, repo } = await makeRepo("repo with spaces #");
  try {
    const head = await commit(repo, "committed", "initial");
    await git(repo, ["checkout", "-q", "-b", "feature/with-slash"]);
    const nested = join(repo, "nested directory");
    await mkdir(nested);
    const info = await detectGitRepo(nested);

    assert.equal(info.isGitRepo, true);
    assert.equal(info.hostCwd, await realpath(nested));
    assert.equal(info.repoRoot, await realpath(repo));
    assert.equal(info.guestRepoRoot, repo);
    assert.equal(info.branch, "feature/with-slash");
    assert.equal(info.headSha, head);
    assert.equal(info.unborn, false);
    assert.equal(info.isLinkedWorktree, false);
  } finally {
    await remove(root);
  }
});

test("finds the lexical repo root for a committed symlink cwd inside the repository", async () => {
  const { root, repo } = await makeRepo("repo");
  try {
    await commit(repo, "committed", "initial");
    const target = join(repo, "target");
    const linked = join(repo, "linked-target");
    await mkdir(target);
    await writeFile(join(target, "tracked.txt"), "tracked\n");
    await symlink("target", linked, "dir");
    await git(repo, ["add", "--", "target/tracked.txt", "linked-target"]);
    await git(repo, ["commit", "-q", "-m", "add committed directory symlink"]);

    const info = await detectGitRepo(linked);
    assert.equal(info.hostCwd, await realpath(target));
    assert.equal(info.repoRoot, await realpath(repo));
    assert.equal(info.guestRepoRoot, repo);
  } finally {
    await remove(root);
  }
});

test("rejects a lexical mount root derived from a symlink directly into a repo subdirectory", async () => {
  const { root, repo } = await makeRepo("repo");
  try {
    await commit(repo, "committed", "initial");
    const subdir = join(repo, "nested");
    const alias = join(root, "nested-alias");
    await mkdir(subdir);
    await symlink(subdir, alias, "dir");
    const info = await detectGitRepo(alias);
    assert.equal(info.repoRoot, await realpath(repo));
    assert.equal(info.guestRepoRoot, null);
  } finally {
    await remove(root);
  }
});

test("detects detached HEAD, unborn branches, and non-repositories", async () => {
  const { root, repo } = await makeRepo("repo");
  const outside = join(root, "not-a-repo");
  await mkdir(outside);
  try {
    const unborn = await detectGitRepo(repo);
    assert.deepEqual(unborn, {
      isGitRepo: true,
      hostCwd: await realpath(repo),
      repoRoot: await realpath(repo),
      guestRepoRoot: repo,
      branch: "main",
      headSha: null,
      unborn: true,
      isLinkedWorktree: false,
    });

    const head = await commit(repo, "committed", "initial");
    await git(repo, ["checkout", "-q", "--detach", "HEAD"]);
    const detached = await detectGitRepo(repo);
    assert.equal(detached.isGitRepo, true);
    assert.equal(detached.branch, null);
    assert.equal(detached.headSha, head);
    assert.equal(detached.unborn, false);

    assert.deepEqual(await detectGitRepo(outside), {
      isGitRepo: false,
      hostCwd: await realpath(outside),
      repoRoot: null,
      branch: null,
      headSha: null,
      unborn: false,
      isLinkedWorktree: false,
    });
  } finally {
    await remove(root);
  }
});

test("identifies linked worktrees", async () => {
  const { root, repo } = await makeRepo("main-repo");
  const linked = join(root, "linked worktree");
  try {
    await commit(repo, "committed", "initial");
    await git(repo, ["worktree", "add", "-q", "-b", "linked-branch", linked]);
    const info = await detectGitRepo(join(linked, "."));

    assert.equal(info.isGitRepo, true);
    assert.equal(info.hostCwd, await realpath(linked));
    assert.equal(info.repoRoot, await realpath(linked));
    assert.equal(info.guestRepoRoot, linked);
    assert.equal(info.branch, "linked-branch");
    assert.equal(info.isLinkedWorktree, true);
  } finally {
    await remove(root);
  }
});

test("bundles only the captured committed tree and survives branch movement", async () => {
  const { root, repo } = await makeRepo("repo with spaces #");
  const checkout = join(root, "bundle checkout");
  try {
    const capturedSha = await commit(repo, "captured", "captured state");
    await writeFile(join(repo, ".env.untracked"), "must never be bundled\n");
    const info = await detectGitRepo(repo);

    // Move the host branch and dirty the worktree after detection. The bundle
    // must still name and contain the captured commit.
    await commit(repo, "later", "later state");
    await writeFile(join(repo, "working-tree-only.txt"), "not committed\n");

    const bundle = await createSeedBundle(info, { branch: "current", depth: "unlimited" });
    assert.ok(bundle);
    assert.equal(bundle.headSha, capturedSha);
    assert.equal(bundle.branch, "main");
    assert.equal((await stat(bundle.hostPath)).isFile(), true);
    assert.match(await git(root, ["bundle", "list-heads", bundle.hostPath]), new RegExp(`${capturedSha} refs/pi-msb/seed`));

    await mkdir(checkout);
    await git(checkout, ["init", "-q"]);
    await git(checkout, ["fetch", "-q", bundle.hostPath, "refs/pi-msb/seed:refs/heads/seed"]);
    assert.equal((await git(checkout, ["show", "seed:committed.txt"])).trim(), "captured");
    await assert.rejects(git(checkout, ["cat-file", "-e", "seed:.env.untracked"]));
    await assert.rejects(git(checkout, ["cat-file", "-e", "seed:working-tree-only.txt"]));

    await bundle.cleanup();
    await bundle.cleanup();
    await assert.rejects(stat(bundle.hostPath), { code: "ENOENT" });
  } finally {
    await remove(root);
  }
});

test("numeric depth creates a shallow bundle with the exact captured head", async () => {
  const { root, repo } = await makeRepo("repo");
  try {
    await commit(repo, "one", "one");
    await commit(repo, "two", "two");
    const capturedSha = await commit(repo, "three", "three");
    const info = await detectGitRepo(repo);
    const bundle = await createSeedBundle(info, { branch: "current", depth: 1 });
    assert.ok(bundle);
    assert.equal(bundle.headSha, capturedSha);

    assert.equal((await git(root, ["bundle", "list-heads", bundle.hostPath])).trim(), `${capturedSha} refs/pi-msb/seed`);
    await bundle.cleanup();
  } finally {
    await remove(root);
  }
});

test("returns no bundle for an unborn or non-Git source", async () => {
  const { root, repo } = await makeRepo("repo");
  try {
    const unborn = await detectGitRepo(repo);
    assert.equal(await createSeedBundle(unborn, { branch: "current", depth: "unlimited" }), null);
    assert.equal(
      await createSeedBundle(
        { isGitRepo: false, repoRoot: null, branch: null, headSha: null, unborn: false, isLinkedWorktree: false },
        { branch: "current", depth: "unlimited" },
      ),
      null,
    );
  } finally {
    await remove(root);
  }
});

test("cleans the temporary tree when clone or bundle verification fails", async () => {
  const source = "/source path/with spaces";
  const info = {
    isGitRepo: true,
    repoRoot: source,
    branch: "main",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    unborn: false,
    isLinkedWorktree: false,
  } as const;

  for (const failure of ["clone", "heads"] as const) {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-msb-git-failure-"));
    const calls: string[][] = [];
    const fake: ExecFn = async (_command, args) => {
      calls.push(args);
      if (failure === "clone" && args.includes("clone")) {
        return { stdout: "", stderr: "clone failed", code: 1 };
      }
      if (failure === "heads" && args.includes("list-heads")) {
        return { stdout: "deadbeef refs/pi-msb/seed\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    try {
      await assert.rejects(
        createSeedBundle(info, { branch: "current", depth: 2, tempRoot, exec: fake }),
      );
      assert.deepEqual(await readdir(tempRoot), []);
      assert.ok(calls.some((args) => args.includes("-C")));
      assert.ok(calls.every((args) => !args.some((arg) => arg.includes("source path/with spaces") && arg.includes(";"))));
    } finally {
      await remove(tempRoot);
    }
  }
});

test("fileUrl encodes path syntax instead of making a shell command", () => {
  const url = fileUrl("/tmp/a path/#literal?name");
  assert.equal(url, "file:///tmp/a%20path/%23literal%3Fname");
});
