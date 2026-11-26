import type { BigIntStats } from "node:fs";
import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const HOST_BASH_CWD_MAX_BYTES = 4096;
export const HOST_BASH_CWD_ERROR = "Host Bash cwd is unsafe, missing, not a directory, or its canonical path/physical directory identity changed; request fresh approval.";
export const HOST_BASH_CWD_DESCRIPTION = "Optional existing directory for explicitly approved host Bash only (execution_target=host), not sandbox Bash, other tools or off/host-fallback mode. Relative paths resolve against the fixed session cwd, never a previous command; omitted means session cwd. Approval binds the normalized path, canonical target and physical directory identity. Outside-workspace directories are allowed with explicit approval and shown in the theme's error/red color. Use cwd instead of cd or command chaining; changing it requires fresh approval.";

export function validHostBashCwd(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= HOST_BASH_CWD_MAX_BYTES
    && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
}
export function hostCwdDisplay(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);
}
interface HostDirectoryProof {
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly dev: bigint;
  readonly ino: bigint;
}
export interface HostBashCwd {
  readonly target: HostDirectoryProof;
  readonly workspace: HostDirectoryProof;
  readonly outsideWorkspace: boolean;
}

async function checked<T>(read: () => Promise<T>, guard: () => void): Promise<T> {
  guard();
  const value = await read();
  guard();
  return value;
}
async function discoverDirectory(lexicalPath: string, guard: () => void): Promise<HostDirectoryProof> {
  if (!validHostBashCwd(lexicalPath)) throw new Error(HOST_BASH_CWD_ERROR);
  const directory = await checked(() => fs.stat(lexicalPath, { bigint: true }), guard);
  const canonicalPath = await checked(() => fs.realpath(lexicalPath), guard);
  if (!directory.isDirectory() || directory.ino <= 0n || !validHostBashCwd(canonicalPath)) throw new Error(HOST_BASH_CWD_ERROR);
  return Object.freeze({ lexicalPath, canonicalPath, dev: directory.dev, ino: directory.ino });
}
async function assertDirectoryCurrent(proof: HostDirectoryProof, guard: () => void): Promise<void> {
  const same = (entry: BigIntStats) => entry.isDirectory() && entry.dev === proof.dev && entry.ino === proof.ino;
  if (await checked(() => fs.realpath(proof.lexicalPath), guard) !== proof.canonicalPath
    || !same(await checked(() => fs.stat(proof.lexicalPath, { bigint: true }), guard))
    || !same(await checked(() => fs.stat(proof.canonicalPath, { bigint: true }), guard))
    || await checked(() => fs.realpath(proof.lexicalPath), guard) !== proof.canonicalPath) throw new Error(HOST_BASH_CWD_ERROR);
}

/** Both proofs belong to this one approval, never to shared Project policy storage. */
export async function discoverHostBashCwd(sessionCwd: string, requestedCwd: string | undefined, guard: () => void): Promise<HostBashCwd> {
  if (!isAbsolute(sessionCwd) || requestedCwd !== undefined && !validHostBashCwd(requestedCwd)) throw new Error(HOST_BASH_CWD_ERROR);
  const workspace = await discoverDirectory(resolve(sessionCwd), guard);
  const lexicalPath = requestedCwd === undefined ? workspace.lexicalPath : resolve(sessionCwd, requestedCwd);
  const target = lexicalPath === workspace.lexicalPath ? workspace : await discoverDirectory(lexicalPath, guard);
  const path = relative(workspace.canonicalPath, target.canonicalPath);
  const outsideWorkspace = path !== "" && (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path));
  const proof = Object.freeze({ target, workspace, outsideWorkspace });
  await assertHostBashCwdCurrent(proof, guard);
  return proof;
}

/** Public path checks and spawn cannot be jointly atomic; failed proofs never authorize a retry. */
export async function assertHostBashCwdCurrent(proof: HostBashCwd, guard: () => void): Promise<void> {
  try {
    await assertDirectoryCurrent(proof.workspace, guard);
    if (proof.target !== proof.workspace) await assertDirectoryCurrent(proof.target, guard);
    guard();
  } catch { throw new Error(HOST_BASH_CWD_ERROR); }
}
