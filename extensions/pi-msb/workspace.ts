import type { BigIntStats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Workspace } from "./types.ts";

// Private discovery-time proof: a freshly sampled replacement is never a new authorization root.
const rootProofs = new WeakMap<Workspace, { lexicalCwd: string; canonicalCwd: string; dev: bigint; ino: bigint }>();

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

/** Select only cwd; guest-writable Git metadata must never widen the host bind. */
export async function discoverWorkspace(cwd: string): Promise<Workspace> {
  const lexicalCwd = resolve(cwd);
  let canonicalCwd: string;
  let directory: BigIntStats;
  try {
    directory = await stat(lexicalCwd, { bigint: true });
    if (!directory.isDirectory() || directory.ino <= 0n) throw new Error("workspace directory identity cannot be proven");
    canonicalCwd = await realpath(lexicalCwd);
  } catch (error) {
    throw new Error(`workspace cwd cannot be canonicalized: ${lexicalCwd}`, { cause: error });
  }

  assertSafeGuestRoot(lexicalCwd);
  const workspace = { hostRoot: canonicalCwd, guestRoot: lexicalCwd, cwd: lexicalCwd };
  rootProofs.set(workspace, { lexicalCwd, canonicalCwd, dev: directory.dev, ino: directory.ino });
  await assertWorkspaceRootCurrent(workspace);
  return workspace;
}

/** Recheck the discovery-time root; public path primitives cannot make check-and-spawn atomic. */
export async function assertWorkspaceRootCurrent(workspace: Workspace): Promise<void> {
  const proof = rootProofs.get(workspace);
  if (!proof || workspace.cwd !== proof.lexicalCwd || workspace.hostRoot !== proof.canonicalCwd) throw new Error("Workspace root proof is unavailable");
  const sameDirectory = (entry: BigIntStats) => entry.isDirectory() && entry.dev === proof.dev && entry.ino === proof.ino;
  if (await realpath(workspace.cwd) !== proof.canonicalCwd
    || !sameDirectory(await stat(workspace.cwd, { bigint: true }))
    || !sameDirectory(await stat(proof.canonicalCwd, { bigint: true }))
    || await realpath(workspace.cwd) !== proof.canonicalCwd) {
    throw new Error("Workspace canonical root or physical directory changed");
  }
}
