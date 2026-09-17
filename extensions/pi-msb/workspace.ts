import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { ExecFn, Workspace } from "./types.ts";

const execFileAsync = promisify(execFile);

interface ExecFileFailure {
  code?: number | string;
  killed?: boolean;
  signal?: string | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  message?: string;
}

const defaultExec: ExecFn = async (command, args, options = {}) => {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, LC_ALL: "C" },
      timeout: options.timeout === undefined ? undefined : options.timeout * 1000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr), code: 0 };
  } catch (error: unknown) {
    const failure = error as ExecFileFailure;
    return {
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? failure.message ?? ""),
      code: typeof failure.code === "number" ? failure.code : 127,
      killed: Boolean(failure.killed || failure.signal),
    };
  }
};

async function lexicalRoot(cwd: string, canonicalRoot: string): Promise<string | null> {
  let candidate = cwd;
  while (true) {
    let canonicalCandidate: string;
    try {
      canonicalCandidate = await realpath(candidate);
    } catch (error) {
      throw new Error(`workspace path cannot be canonicalized: ${candidate}`, { cause: error });
    }
    if (canonicalCandidate === canonicalRoot) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

function isNotRepository(code: number, stderr: string): boolean {
  return code === 128 && /(?:^|\n)fatal: (?:not a git (?:repository|work tree)|this operation must be run in a work tree)(?:\s|$)/i.test(stderr);
}

const PROTECTED_GUEST_PATHS = [
  "/bin",
  "/dev",
  "/etc/ld.so.cache",
  "/etc/ld.so.preload",
  "/lib",
  "/lib64",
  "/proc",
  "/sbin",
  "/sys",
  "/usr",
  "/run",
  "/var/run",
  "/var/lib/docker",
] as const;

function containsPath(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function assertSafeGuestRoot(root: string): void {
  if (PROTECTED_GUEST_PATHS.some((path) => containsPath(root, path) || containsPath(path, root))) {
    throw new Error(`workspace root cannot safely be mounted at the guest path: ${root}`);
  }
}

/** Discover the single path-preserving project bind for a configure/boot cycle. */
export async function discoverWorkspace(cwd: string, exec: ExecFn = defaultExec): Promise<Workspace> {
  const lexicalCwd = resolve(cwd);
  let canonicalCwd: string;
  try {
    canonicalCwd = await realpath(lexicalCwd);
  } catch (error) {
    throw new Error(`workspace cwd cannot be canonicalized: ${lexicalCwd}`, { cause: error });
  }

  const result = await exec("git", ["-C", lexicalCwd, "rev-parse", "--show-toplevel"]);
  if (result.killed) throw new Error("Git workspace discovery was interrupted");
  if (result.code !== 0) {
    if (isNotRepository(result.code, result.stderr)) {
      assertSafeGuestRoot(lexicalCwd);
      return { hostRoot: canonicalCwd, guestRoot: lexicalCwd, cwd: lexicalCwd, fromGit: false };
    }
    const detail = result.stderr.trim() || `git exited with code ${result.code}`;
    throw new Error(`Git workspace discovery failed: ${detail}`);
  }

  const output = result.stdout.replace(/\r?\n$/, "");
  if (!output || output.includes("\0") || output.includes("\n") || output.includes("\r") || !isAbsolute(output)) {
    throw new Error("Git workspace discovery returned an invalid repository root");
  }

  let hostRoot: string;
  try {
    hostRoot = await realpath(output);
  } catch (error) {
    throw new Error(`Git workspace root cannot be canonicalized: ${output}`, { cause: error });
  }
  const guestRoot = await lexicalRoot(lexicalCwd, hostRoot);
  if (guestRoot === null) {
    throw new Error("Git workspace root cannot preserve the cwd guest path; unsupported symlink topology");
  }
  assertSafeGuestRoot(guestRoot);

  return { hostRoot, guestRoot, cwd: lexicalCwd, fromGit: true };
}
