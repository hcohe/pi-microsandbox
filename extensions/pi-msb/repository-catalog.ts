import { constants, promises as fs } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { projectConfigPath } from "./project-storage-path.ts";

/** Immutable host-owned association, stored in the SAME atomic artifact as shared policy. */
export interface RepositoryMetadata { version: 1; common_dir: string; main_root: string }
export interface CatalogOptions {
  root: string;
  home: string;
  parse(text: string): Record<string, unknown>;
  /** Private prediction of our own atomic replacement, never an agent setting. */
  replacement?: { file: string; text: string };
}
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

/** Read only the readable policy trees, never Dockerfiles or build-context contents. */
export async function readRepositoryCatalog(options: CatalogOptions): Promise<Array<{ file: string; metadata: RepositoryMetadata }>> {
  const files = new Set<string>();
  let entries = 0;
  const directories = new Map<string, string>();
  const directoryVersion = async (path: string): Promise<string> => {
    const stat = await fs.lstat(path);
    if (!stat.isDirectory() || await fs.realpath(path) !== path) fail();
    return JSON.stringify([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]);
  };
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (depth > 256 || ++entries > 4096) fail();
    if (!await directory(folder)) return;
    directories.set(folder, await directoryVersion(folder));
    const dir = await fs.opendir(folder);
    try {
      for await (const entry of dir) {
        if (++entries > 4096) fail();
        const path = join(folder, entry.name);
        if (/^build-context$/i.test(entry.name)) {
          // Context-only saves need no config or Dockerfile sibling. Its bytes
          // are never catalog metadata, even if a source is named config.toml.
          if (!entry.isDirectory()) fail();
          continue;
        }
        if (/^(config\.toml|Dockerfile)$/i.test(entry.name)) {
          if (!entry.isFile() || !["config.toml", "Dockerfile"].includes(entry.name)) fail();
          if (entry.name === "config.toml") files.add(path);
          continue;
        }
        if (entry.isDirectory()) await walk(path, depth + 1);
        else if (!entry.isFile()) fail();
      }
    } finally { await dir.close().catch((error) => { if (error.code !== "ERR_DIR_CLOSED") throw error; }); }
  };
  if (await directory(options.root)) directories.set(options.root, await directoryVersion(options.root));
  for (const tree of ["projects", "projects-absolute"]) await walk(join(options.root, tree), 0);
  const replacement = options.replacement;
  if (replacement && ["projects", "projects-absolute"].some((tree) => replacement.file.startsWith(join(options.root, tree) + "/"))) files.add(replacement.file);
  if (files.size > 256) fail();
  const result: Array<{ file: string; metadata: RepositoryMetadata }> = [];
  for (const file of [...files].sort()) {
    const text = replacement?.file === file ? replacement.text : await read(file);
    if (text === null) continue;
    const raw = options.parse(text)._repository;
    // Cwd-local non-Git/unsupported records share the readable trees.
    if (raw === undefined) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail();
    const metadata = raw as RepositoryMetadata;
    if (Object.keys(metadata).sort().join(",") !== "common_dir,main_root,version" || metadata.version !== 1
      || typeof metadata.common_dir !== "string" || typeof metadata.main_root !== "string"
      || !isAbsolute(metadata.common_dir) || !isAbsolute(metadata.main_root)
      || resolve(metadata.common_dir) !== metadata.common_dir || resolve(metadata.main_root) !== metadata.main_root
      || join(metadata.main_root, ".git") !== metadata.common_dir
      || projectConfigPath(options.root, options.home, metadata.main_root) !== file) fail();
    if (await fs.realpath(metadata.main_root) !== metadata.main_root || !await directory(metadata.common_dir)) fail();
    result.push({ file, metadata });
  }
  // Reject a catalog assembled across structural replacement or concurrent
  // entry creation/removal; portable APIs do not provide openat-style pinning.
  for (const [path, version] of directories) if (await directoryVersion(path) !== version) fail();
  return result;
}
