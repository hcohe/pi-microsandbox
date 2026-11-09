import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Immutable host-owned association, stored in the SAME atomic artifact as shared policy. */
export interface RepositoryMetadata { version: 1; common_dir: string; main_root: string }
export interface CatalogOptions {
  root: string;
  parse(text: string): Record<string, unknown>;
  /** Private prediction of our own atomic replacement, never an agent setting. */
  replacement?: { file: string; text: string };
}
export const repositoryKey = (commonDir: string): string => createHash("sha256").update(commonDir).digest("hex");
export const repositoryMetadata = (commonDir: string, mainRoot: string): RepositoryMetadata => ({ version: 1, common_dir: commonDir, main_root: mainRoot });
const fail = (): never => { throw new Error("Unsafe repository catalog"); };

async function directory(path: string): Promise<boolean> {
  try {
    if (!(await fs.lstat(path)).isDirectory() || await fs.realpath(path) !== path) fail();
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
/** Bounded regular-file read; no shell, Git, bootstrap, mkdir or registry writes. */
async function read(file: string): Promise<string | null> {
  let before;
  try { before = await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const signature = (s: typeof before) => JSON.stringify([s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs]);
  if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024) fail();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (signature(await handle.stat()) !== signature(before)) fail();
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const part = await handle.read(buffer, length, buffer.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length !== before.size || signature(await handle.stat()) !== signature(before) || signature(await fs.lstat(file)) !== signature(before)) fail();
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
}

export async function readRepositoryCatalog(options: CatalogOptions): Promise<Array<{ file: string; metadata: RepositoryMetadata }>> {
  const exists = await directory(options.root);
  const names: string[] = [];
  if (exists) {
    const dir = await fs.opendir(options.root);
    try {
      for await (const entry of dir) {
        if (names.length >= 256 || !/^[a-f0-9]{64}$/.test(entry.name) || !entry.isDirectory()) fail();
        names.push(entry.name);
      }
    } finally { await dir.close().catch((error) => { if (error.code !== "ERR_DIR_CLOSED") throw error; }); }
  }
  const replacement = options.replacement;
  if (replacement && dirname(dirname(replacement.file)) === options.root) {
    const key = dirname(replacement.file).slice(options.root.length + 1);
    if (!names.includes(key)) names.push(key);
  }
  if (names.length > 256) fail();
  const result: Array<{ file: string; metadata: RepositoryMetadata }> = [];
  for (const name of names.sort()) {
    const folder = join(options.root, name);
    await directory(folder);
    const file = join(folder, "config.toml");
    const text = replacement?.file === file ? replacement.text : await read(file);
    // Empty directories can be created by an interrupted save or Dockerfile save.
    if (text === null) continue;
    const raw = options.parse(text)._repository;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
    const metadata = raw as RepositoryMetadata;
    if (Object.keys(metadata).sort().join(",") !== "common_dir,main_root,version" || metadata.version !== 1
      || typeof metadata.common_dir !== "string" || typeof metadata.main_root !== "string"
      || !isAbsolute(metadata.common_dir) || !isAbsolute(metadata.main_root)
      || resolve(metadata.common_dir) !== metadata.common_dir || resolve(metadata.main_root) !== metadata.main_root
      || join(metadata.main_root, ".git") !== metadata.common_dir || repositoryKey(metadata.common_dir) !== name) fail();
    if (await fs.realpath(metadata.main_root) !== metadata.main_root || !await directory(metadata.common_dir)) fail();
    result.push({ file, metadata });
  }
  return result;
}
