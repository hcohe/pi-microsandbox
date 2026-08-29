import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { ExecFn, GitRepoInfo, GitSeedBundle } from "./types.ts";

const execFileAsync = promisify(execFile);
const SEED_REF = "refs/pi-msb/seed";

interface ExecFileFailure {
  code?: number | string;
  killed?: boolean;
  signal?: string | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  message?: string;
}

/** Execute a program without giving it a shell or interpolating its arguments. */
const defaultExec: ExecFn = async (command, args, options = {}) => {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout === undefined ? undefined : options.timeout * 1000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    });
    return {
      stdout: String(result.stdout),
      stderr: String(result.stderr),
      code: 0,
    };
  } catch (error: unknown) {
    const failure = error as ExecFileFailure;
    const numericCode = typeof failure.code === "number" ? failure.code : 127;
    return {
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? failure.message ?? ""),
      code: numericCode,
      killed: Boolean(failure.killed || failure.signal),
    };
  }
};

const emptyRepo = (hostCwd?: string): GitRepoInfo => ({
  isGitRepo: false,
  ...(hostCwd ? { hostCwd } : {}),
  repoRoot: null,
  branch: null,
  headSha: null,
  unborn: false,
  isLinkedWorktree: false,
});

function output(result: Awaited<ReturnType<ExecFn>>): string {
  return result.stdout.trim();
}

function failureMessage(context: string, result: Awaited<ReturnType<ExecFn>>): Error {
  const detail = result.stderr.trim() || `git exited with code ${result.code}`;
  return new Error(`${context}: ${detail}`);
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return resolve(value);
  }
}

function pathFromGitResult(value: string, base: string): string {
  return isAbsolute(value) ? value : resolve(base, value);
}

async function lexicalRepoRoot(requestedCwd: string, canonicalRepoRoot: string): Promise<string | null> {
  let candidate = requestedCwd;
  while (true) {
    if (await canonicalPath(candidate) === canonicalRepoRoot) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

/**
 * Return the immutable source state of cwd. A directory outside Git is an ordinary
 * result rather than an error, which lets storage mode `auto` remain a direct alias.
 */
export async function detectGitRepo(cwd: string, exec: ExecFn = defaultExec): Promise<GitRepoInfo> {
  const requestedCwd = resolve(cwd);
  const hostCwd = await canonicalPath(requestedCwd);
  const topLevel = await exec("git", ["-C", requestedCwd, "rev-parse", "--show-toplevel"]);
  if (topLevel.code !== 0 || topLevel.killed || !output(topLevel)) return emptyRepo(hostCwd);

  const repoRoot = await canonicalPath(output(topLevel));
  const guestRepoRoot = await lexicalRepoRoot(requestedCwd, repoRoot);
  const branchResult = await exec("git", [
    "-C",
    repoRoot,
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  const branch = branchResult.code === 0 && !branchResult.killed && output(branchResult)
    ? output(branchResult)
    : null;

  const headResult = await exec("git", ["-C", repoRoot, "rev-parse", "--verify", "HEAD"]);
  const headSha = headResult.code === 0 && !headResult.killed && output(headResult)
    ? output(headResult)
    : null;

  // In a linked worktree --git-dir points at .git/worktrees/<name>, while
  // --git-common-dir points at the shared .git directory.
  const gitDirResult = await exec("git", ["-C", repoRoot, "rev-parse", "--git-dir"]);
  const commonDirResult = await exec("git", ["-C", repoRoot, "rev-parse", "--git-common-dir"]);
  let isLinkedWorktree = false;
  if (gitDirResult.code === 0 && commonDirResult.code === 0) {
    const gitDir = await canonicalPath(pathFromGitResult(output(gitDirResult), repoRoot));
    const commonDir = await canonicalPath(pathFromGitResult(output(commonDirResult), repoRoot));
    isLinkedWorktree = gitDir !== commonDir;
  }

  return {
    isGitRepo: true,
    hostCwd,
    repoRoot,
    guestRepoRoot,
    branch,
    headSha,
    unborn: headSha === null && branch !== null,
    isLinkedWorktree,
  };
}

function bundleFailure(context: string, result: Awaited<ReturnType<ExecFn>>): never {
  throw failureMessage(context, result);
}

async function checkedGit(
  exec: ExecFn,
  args: string[],
  context: string,
): Promise<Awaited<ReturnType<ExecFn>>> {
  const result = await exec("git", args);
  if (result.code !== 0 || result.killed) bundleFailure(context, result);
  return result;
}

/**
 * Make a disposable bundle from committed objects only. The temporary bare clone
 * deliberately has no worktree, so ignored, modified, and untracked files cannot
 * enter the seed.
 */
export async function createSeedBundle(
  info: GitRepoInfo,
  options: {
    branch: "current" | string;
    depth: number | "unlimited";
    tempRoot?: string;
    exec?: ExecFn;
  },
): Promise<GitSeedBundle | null> {
  if (!info.isGitRepo || info.unborn || !info.repoRoot || !info.headSha) return null;
  if (options.depth !== "unlimited" && (!Number.isInteger(options.depth) || options.depth < 1)) {
    throw new Error(`invalid Git bundle depth: ${String(options.depth)}`);
  }

  const exec = options.exec ?? defaultExec;
  const parent = resolve(options.tempRoot ?? tmpdir());
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(join(parent, "pi-msb-git-"));
  await chmod(tempDir, 0o700);
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await rm(tempDir, { recursive: true, force: true });
  };

  try {
    const bareName = "source.git";
    const barePath = join(tempDir, bareName);
    const bundlePath = join(tempDir, "seed.bundle");
    const source = fileUrl(info.repoRoot);
    const depthArgs = options.depth === "unlimited" ? [] : ["--depth", String(options.depth)];

    // A file:// URL forces Git's local transport while keeping the source repo
    // read-only. --bare means no checkout, filters, or worktree are involved.
    await checkedGit(
      exec,
      ["-C", tempDir, "clone", "--bare", "--no-tags", ...depthArgs, source, bareName],
      "creating temporary bare clone",
    );

    const objectCheck = await exec("git", ["-C", barePath, "cat-file", "-e", `${info.headSha}^{commit}`]);
    if (objectCheck.code !== 0 || objectCheck.killed) {
      // A branch may have moved between detection and clone. Fetch the captured
      // object explicitly; never fall back to whatever HEAD the clone obtained.
      await checkedGit(
        exec,
        ["-C", barePath, "fetch", "--no-tags", ...depthArgs, source, info.headSha],
        `fetching captured HEAD ${info.headSha}`,
      );
    }

    const verifiedObject = await exec("git", ["-C", barePath, "cat-file", "-e", `${info.headSha}^{commit}`]);
    if (verifiedObject.code !== 0 || verifiedObject.killed) {
      bundleFailure(`captured HEAD ${info.headSha} is not present in temporary clone`, verifiedObject);
    }

    await checkedGit(
      exec,
      ["-C", barePath, "update-ref", SEED_REF, info.headSha],
      "updating temporary seed ref",
    );
    await checkedGit(
      exec,
      ["-C", barePath, "bundle", "create", bundlePath, SEED_REF],
      "creating Git bundle",
    );
    await checkedGit(exec, ["-C", barePath, "bundle", "verify", bundlePath], "verifying Git bundle");
    const heads = await checkedGit(
      exec,
      ["-C", barePath, "bundle", "list-heads", bundlePath],
      "listing Git bundle heads",
    );
    const expectedHead = heads.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .find(([sha, ref]) => sha === info.headSha && ref === SEED_REF);
    if (!expectedHead) {
      throw new Error(`Git bundle did not contain captured HEAD ${info.headSha} at ${SEED_REF}`);
    }

    return {
      hostPath: bundlePath,
      branch: options.branch === "current" ? info.branch : options.branch,
      headSha: info.headSha,
      cleanup,
    };
  } catch (error: unknown) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}

export function fileUrl(path: string): string {
  return pathToFileURL(path).href;
}
