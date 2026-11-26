import { constants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, parse, resolve } from "node:path";
import { canonicalPolicyLocation, ConfigError, readRawConfig } from "./config.ts";

/** Internal guarded policy-file I/O; callers retain candidate and workspace policy validation. */
export interface Source { text: string | null; version: string; raw: Record<string, unknown>; anchor?: SettingsAnchor }
interface SettingsAnchor { path: string; canonical: string; ancestors: Array<{ path: string; identity?: string }> }
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const anchorIdentity = (stat: Awaited<ReturnType<typeof fs.lstat>>): string => `${stat.dev}:${stat.ino}:${stat.mode}${stat.isSymbolicLink() ? `:${stat.ctimeMs}:${stat.mtimeMs}` : ""}`;
export async function captureAnchor(path: string, canonical: string): Promise<SettingsAnchor> {
  const entries: SettingsAnchor["ancestors"] = [];
  for (const part of new Set([...await ancestors(path), ...await ancestors(canonical)])) {
    try { entries.push({ path: part, identity: anchorIdentity(await fs.lstat(part)) }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; entries.push({ path: part }); }
  }
  const anchor = { path, canonical, ancestors: entries };
  await assertAnchor(anchor);
  return anchor;
}
/** Pin existing lexical ancestors (including the selected root link), but allow missing directories to be created. */
export async function assertAnchor(anchor: SettingsAnchor | undefined): Promise<void> {
  if (!anchor) return;
  for (const entry of anchor.ancestors) {
    let stat;
    try { stat = await fs.lstat(entry.path); }
    catch (error) { if (!entry.identity && (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new ConfigError(["settings agent directory changed; reopen the panel"]); }
    if (entry.identity ? anchorIdentity(stat) !== entry.identity : !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ConfigError(["settings agent directory changed; reopen the panel"]);
    }
  }
  if (await canonicalPolicyLocation(anchor.path) !== anchor.canonical) throw new ConfigError(["settings agent directory changed; reopen the panel"]);
}
async function ancestors(path: string): Promise<string[]> {
  const result: string[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    result.unshift(current);
    if (current === parse(current).root) return result;
  }
}
async function inspectPath(path: string): Promise<string> {
  const result: string[] = [];
  for (const part of await ancestors(path)) {
    try {
      const stat = await fs.lstat(part);
      if (stat.isSymbolicLink() || (part !== path && !stat.isDirectory()) || (part === path && !stat.isFile())) {
        throw new ConfigError(["settings paths must use regular files and non-symlink directories"]);
      }
      result.push(`${part}:${stat.dev}:${stat.ino}${part === path ? `:${stat.size}:${stat.mode}:${stat.mtimeMs}:${stat.ctimeMs}` : ""}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      result.push(`${part}:missing`);
    }
  }
  return result.join("|");
}
export async function readSource(path: string): Promise<Source> {
  const location = await inspectPath(path);
  let text: string | null = null;
  try {
    const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw new ConfigError(["settings target must be a regular file"]);
      text = await file.readFile("utf8");
    } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (location !== await inspectPath(path)) throw new ConfigError(["settings path changed while reading"]);
  let raw: Record<string, unknown>;
  try { raw = readRawConfig(text ?? ""); }
  catch { throw new ConfigError(["Manual host edit required: malformed configuration syntax"]); }
  return { text, version: hash(`${location}\n${text === null ? "missing" : text}`), raw };
}
export async function atomicWrite(path: string, text: string, expected: Source, guard: () => Promise<void>): Promise<void> {
  await guard();
  if ((await readSource(path)).version !== expected.version) throw new ConfigError(["configuration changed externally; reopen the draft"]);
  for (const part of (await ancestors(dirname(path))).slice(1)) {
    try { await fs.mkdir(part, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await fs.lstat(part);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ConfigError(["unsafe settings ancestor"]);
  }
  const stable = await inspectPath(path);
  const temp = join(dirname(path), `.settings-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await guard();
    if (stable !== await inspectPath(path) || (await readSource(path)).text !== expected.text) throw new ConfigError(["configuration changed externally; reopen the draft"]);
    await fs.rename(temp, path);
    const directory = await fs.open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.unlink(temp).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}
