import { constants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { BUILD_LIMITS } from "./image-source.ts";
import { SettingsConflictError } from "./settings-conflict.ts";

export const CONTEXT_LIMITS = { files: 16, fileBytes: 32 * 1024, payloadBytes: 64 * 1024 } as const;
export interface ContextEdit { path: string; content: string | null; executable?: boolean }
export interface ContextEntry { path: string; directory: boolean; bytes: number; executable: boolean; version: string }
export const fileIdentity = (s: import("node:fs").Stats) => JSON.stringify([s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs]);
export const directoryIdentity = (s: import("node:fs").Stats) => JSON.stringify([s.dev, s.ino, s.mode]);
export const ownerIdentity = (s: import("node:fs").Stats) => JSON.stringify([s.dev, s.ino, s.mode, s.nlink]);
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
// Reject portable spelling collisions even on case-sensitive hosts; never retarget a reviewed path.
const contextPathKey = (path: string) => path.normalize("NFD").toUpperCase().toLowerCase().normalize("NFD");
export function validContextPath(path: string): boolean {
  return path.length <= 1024 && !/[\\\x00-\x1f\x7f-\x9f\p{Cf}]/u.test(path)
    && path.split("/").every((part) => !!part && part !== "." && part !== ".." && !part.includes(":"))
    && contextPathKey(path.split("/")[0]!) !== "dockerfile" && path.split("/").length <= BUILD_LIMITS.depth;
}
export function validText(text: string, limit = CONTEXT_LIMITS.fileBytes): boolean {
  return Buffer.byteLength(text) <= limit && Buffer.from(text).toString("utf8") === text
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\p{Cf}]/u.test(text);
}
/** Include implicit ancestors so two new files cannot spell the same directory differently. */
function assertContextSpellings(entries: ContextEntry[], paths: string[]): void {
  const spellings = new Map<string, string>();
  for (const path of [...entries.map((entry) => entry.path), ...paths]) {
    if (!path) continue;
    const components = path.split("/");
    for (let length = 1; length <= components.length; length++) {
      const prefix = components.slice(0, length).join("/");
      const key = contextPathKey(prefix), previous = spellings.get(key);
      if (previous !== undefined && previous !== prefix) throw new Error("Context path spelling alias");
      spellings.set(key, prefix);
    }
  }
}
/** Prove exact reviewed spelling/identity, or actual OS absence, without reading file contents. */
export async function assertContextTargets(root: string, entries: ContextEntry[], paths: string[]): Promise<void> {
  assertContextSpellings(entries, paths);
  const expected = new Map(entries.map((entry) => [entry.path, entry]));
  let rootStat;
  try { rootStat = await fs.lstat(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || expected.has("")) throw error;
    return;
  }
  if (!expected.has("") || !rootStat.isDirectory() || directoryIdentity(rootStat) !== expected.get("")!.version) throw new SettingsConflictError();
  for (const path of paths) {
    let parent = root, prefix = "";
    for (const component of path.split("/")) {
      prefix = prefix ? `${prefix}/${component}` : component;
      const entry = expected.get(prefix);
      const names = await fs.readdir(parent);
      if (names.some((name) => name !== component && contextPathKey(name) === contextPathKey(component))) throw new SettingsConflictError();
      const host = join(parent, component);
      let stat;
      try { stat = await fs.lstat(host); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || entry) throw error;
        break;
      }
      if (!entry || !names.includes(component) || stat.isSymbolicLink()
        || (entry.directory ? !stat.isDirectory() || directoryIdentity(stat) !== entry.version : !stat.isFile() || fileIdentity(stat) !== entry.version)) throw new SettingsConflictError();
      parent = host;
    }
  }
}
/** No content reads: the bounded inventory pins every regular file, directory and child name. */
export async function scanContext(root: string): Promise<ContextEntry[]> {
  const entries: ContextEntry[] = [];
  let bytes = 0;
  const visit = async (path: string, depth: number) => {
    if (depth > BUILD_LIMITS.depth || entries.length + 1 >= BUILD_LIMITS.entries) throw new Error("Context limit");
    const host = path ? join(root, path) : root;
    const stat = await fs.lstat(host);
    if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw new Error("Unsafe context");
    const directory = stat.isDirectory();
    entries.push({ path, directory, bytes: directory ? 0 : stat.size, executable: !directory && !!(stat.mode & 0o111), version: directory ? directoryIdentity(stat) : fileIdentity(stat) });
    if (directory) {
      for (const name of (await fs.readdir(host)).sort()) {
        const child = path ? `${path}/${name}` : name;
        if (!validContextPath(child)) throw new Error("Unsafe context path");
        await visit(child, depth + 1);
      }
    } else { bytes += stat.size; if (bytes > BUILD_LIMITS.bytes) throw new Error("Context limit"); }
    if (fileIdentity(await fs.lstat(host)) !== fileIdentity(stat)) throw new SettingsConflictError();
  };
  try { await visit("", 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || entries.length) throw error; }
  assertContextSpellings(entries, []);
  return entries;
}
/** Bounded nofollow text read; never consumes unrequested context file contents. */
export async function readText(path: string, limit: number): Promise<{ content: string; version: string; bytes: number; owner: string }> {
  const before = await fs.lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error("Unsafe or oversized text");
  const version = fileIdentity(before);
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (fileIdentity(await file.stat()) !== version) throw new SettingsConflictError();
    const data = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < data.length) {
      const part = await file.read(data, length, data.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length !== before.size || fileIdentity(await file.stat()) !== version || fileIdentity(await fs.lstat(path)) !== version) throw new SettingsConflictError();
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data.subarray(0, length));
    if (!validText(content, limit)) throw new Error("Unsupported text");
    return { content, version, bytes: length, owner: ownerIdentity(before) };
  } finally { await file.close(); }
}
export function validateContextEdits(edits: ContextEdit[]): void {
  if (edits.length > CONTEXT_LIMITS.files || new Set(edits.map((edit) => edit.path)).size !== edits.length) throw new Error("Context patch limit/duplicate");
  let bytes = 0;
  for (const edit of edits) {
    if (!validContextPath(edit.path) || edit.content !== null && (typeof edit.content !== "string" || !validText(edit.content))
      || edit.executable !== undefined && (typeof edit.executable !== "boolean" || edit.content === null)) throw new Error("Invalid context edit");
    bytes += Buffer.byteLength(edit.content ?? "");
  }
  if (bytes > CONTEXT_LIMITS.payloadBytes) throw new Error("Context payload limit");
  assertContextSpellings([], edits.map((edit) => edit.path));
  for (const edit of edits) if (edits.some((other) => other !== edit && other.path.startsWith(`${edit.path}/`))) throw new Error("Overlapping context edits");
}
