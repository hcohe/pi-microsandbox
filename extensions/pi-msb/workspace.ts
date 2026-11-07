import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Workspace } from "./types.ts";

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
  try {
    canonicalCwd = await realpath(lexicalCwd);
  } catch (error) {
    throw new Error(`workspace cwd cannot be canonicalized: ${lexicalCwd}`, { cause: error });
  }

  assertSafeGuestRoot(lexicalCwd);
  return { hostRoot: canonicalCwd, guestRoot: lexicalCwd, cwd: lexicalCwd };
}
