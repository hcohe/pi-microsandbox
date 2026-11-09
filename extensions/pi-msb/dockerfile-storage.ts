import { constants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, parse, relative, sep } from "node:path";
import { assertPolicyOutsideWorkspace, canonicalPolicyLocation, hostConfigTargets, legacyConfigSources, readRawConfig, type ResolveConfigInput } from "./config.ts";
import { assertBuildPath, BUILD_LIMITS } from "./image-source.ts";
import { assertAnchor, captureAnchor } from "./settings-storage.ts";
import { SettingsConflictError } from "./settings-conflict.ts";
import { serializeRaw } from "./settings.ts";
import { CONTEXT_LIMITS, assertContextTargets, directoryIdentity, fileIdentity, ownerIdentity, sha256, readText, scanContext, validateContextEdits, type ContextEdit, type ContextEntry } from "./build-context-storage.ts";
import type { Config } from "./types.ts";

export type DockerfileScope = "project" | "global";
export const DOCKERFILE_MAX_BYTES = 32 * 1024;
type ScopePaths = { config: string; dockerfile: string; buildContext: string };
export interface DockerfilePaths {
  agentDir: string;
  canonicalAgentDir: string;
  global: ScopePaths;
  project: ScopePaths;
}
export interface DockerfileSnapshot {
  exists: boolean;
  bytes: number;
  mode?: number;
  content: string | null;
  reason?: string;
  version: string;
}
export interface BundleReview {
  changed: boolean;
  context: Array<{ path: string; before: string | null; after: string | null; executableBefore: boolean; executableAfter: boolean; modeBefore: number | null; modeAfter: number | null }>;
  registration?: { path: string; metadata: unknown; consequence: string };
}
export interface DockerfileDraft {
  paths: DockerfilePaths;
  scope: DockerfileScope;
  target: ScopePaths;
  source: DockerfileSnapshot;
  context: ContextEntry[];
  readContext(paths: string[]): Promise<unknown[]>;
  prepare(content?: string, context?: ContextEdit[]): Promise<BundleReview>;
  save(content: string | undefined, guard: () => Promise<void>): Promise<{ assertUnchanged(): Promise<void> }>;
}
/** A multi-artifact save is optimistic, not a crash-atomic transaction. Never activate after this error. */
export class BundlePersistenceError extends Error {
  readonly persisted: string[];
  readonly uncertain: string | undefined;
  constructor(persisted: string[], uncertain: string | undefined) {
    super("Bundle persistence partial or unknown; no activation authorized");
    this.persisted = persisted; this.uncertain = uncertain;
  }
}
const identity = (s: import("node:fs").Stats) => JSON.stringify([s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs]);
const ownedFileIdentity = (s: import("node:fs").Stats) => JSON.stringify([s.dev, s.ino, s.mode, s.nlink]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function validDockerfileText(text: string): boolean {
  return Buffer.byteLength(text, "utf8") <= DOCKERFILE_MAX_BYTES
    && Buffer.from(text, "utf8").toString("utf8") === text
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\p{Cf}]/u.test(text);
}

/** Resolve only authoritative host policy locations; never infer a Project mapping here. */
export async function dockerfilePaths(input: ResolveConfigInput, canonicalCwd: string, check: () => void, mounts: Config["mounts"] = [], replacement?: { file: string; text: string }): Promise<DockerfilePaths> {
  check();
  if (await fs.realpath(input.cwd) !== canonicalCwd) throw new SettingsConflictError();
  const targets = await hostConfigTargets(input, replacement);
  const scope = (config: string): ScopePaths => ({ config, dockerfile: join(dirname(config), "Dockerfile"), buildContext: join(dirname(config), "build-context") });
  const paths = { agentDir: targets.agentDir, canonicalAgentDir: targets.canonicalAgentDir, global: scope(targets.paths.global), project: scope(targets.paths.project) };
  const roots = [input.cwd, canonicalCwd, ...mounts.filter((m) => !m.readonly && ["dir", "file"].includes(m.type)).map((m) => m.hostPath!)];
  for (const config of [...Object.values(targets.lexicalPaths), ...Object.values(targets.paths)]) {
    for (const path of Object.values(scope(config))) for (const root of roots) await assertPolicyOutsideWorkspace(path, [root]);
  }
  const inside = (path: string, root: string) => { const rel = relative(root, path); return !rel || rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep); };
  for (const mount of mounts.filter((m) => !m.readonly && ["dir", "file"].includes(m.type))) {
    const host = mount.hostPath!;
    const canonicalHost = await canonicalPolicyLocation(host);
    for (const root of [join(targets.agentDir, "pi-microsandbox"), join(targets.canonicalAgentDir, "pi-microsandbox")]) {
      if ([host, canonicalHost].some((path) => inside(path, root) || inside(root, path))) throw new Error("Writable mount exposes policy storage");
    }
    for (const dependency of targets.identity.protectedPaths) {
      await assertPolicyOutsideWorkspace(dependency, [host, canonicalHost]);
      if ([host, canonicalHost].some((path) => inside(path, dependency))) throw new Error("Writable mount exposes repository proof");
    }
  }
  for (const selected of [paths.global, paths.project]) for (const path of Object.values(selected)) await assertBuildPath(targets.canonicalAgentDir, path);
  if (await fs.realpath(input.cwd) !== canonicalCwd || JSON.stringify(await hostConfigTargets(input, replacement)) !== JSON.stringify(targets)) throw new SettingsConflictError();
  check();
  return paths;
}

/** Bounded, nofollow read. Oversized/non-text files are reported, never truncated. */
export async function readDockerfile(path: string): Promise<DockerfileSnapshot> {
  let before;
  try { before = await fs.lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { exists: false, bytes: 0, content: null, version: "missing" };
  }
  if (!before.isFile() || before.nlink !== 1) throw new Error("Unsafe Dockerfile source");
  const version = identity(before);
  if (before.size > DOCKERFILE_MAX_BYTES) return { exists: true, bytes: before.size, mode: before.mode & 0o7777, content: null, reason: "Dockerfile exceeds 32768 UTF-8 bytes; inspect and repair with a human host editor.", version };
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (identity(await file.stat()) !== version) throw new SettingsConflictError();
    const data = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < data.length) {
      const part = await file.read(data, length, data.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length !== before.size || identity(await file.stat()) !== version || identity(await fs.lstat(path)) !== version) throw new SettingsConflictError();
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data.subarray(0, length)); }
    catch { return { exists: true, bytes: length, mode: before.mode & 0o7777, content: null, reason: "Dockerfile is not valid UTF-8 text.", version }; }
    if (!validDockerfileText(content)) return { exists: true, bytes: length, mode: before.mode & 0o7777, content: null, reason: "Dockerfile contains unsupported control/format characters; human host repair required.", version };
    return { exists: true, bytes: length, mode: before.mode & 0o7777, content, version: hash(version + content) };
  } finally { await file.close(); }
}


/** Pin policy metadata without parsing config or resolving commands/credentials. */
async function policyVersions(input: ResolveConfigInput, selected: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  const configs = [...Object.values((await hostConfigTargets(input)).paths), ...legacyConfigSources(input).map((source) => source.path)];
  for (const path of new Set([...configs, ...configs.map((config) => join(dirname(config), "Dockerfile"))])) {
    if (path === selected) continue;
    try {
      const stat = await fs.lstat(path);
      entries.set(path, identity(stat));
      if (stat.isSymbolicLink()) { const real = await fs.realpath(path); entries.set(real, identity(await fs.lstat(real))); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; entries.set(path, "missing"); }
  }
  return entries;
}
const sortedEntries = (entries: ContextEntry[]) => [...entries].sort((a, b) => a.path.localeCompare(b.path, "en"));
const sameContext = (a: ContextEntry[], b: ContextEntry[]) => JSON.stringify(sortedEntries(a)) === JSON.stringify(sortedEntries(b));

/** Each changed file is staged privately outside COPY root. Partial commits never authorize activation. */
export async function openDockerfile(input: ResolveConfigInput, canonicalCwd: string, scope: DockerfileScope, check: () => void,
  mounts: Config["mounts"] = [], ...retiredDestinations: never[]): Promise<DockerfileDraft> {
  // Old positional Worktree requests must fail, never become shared Project writes.
  if (retiredDestinations.length) throw new Error("Retired Dockerfile destinations are not supported");
  if (!["project", "global"].includes(scope)) throw new Error("Invalid destination");
  let targets = await hostConfigTargets(input);
  const paths = await dockerfilePaths(input, canonicalCwd, check, mounts);
  const target = paths[scope];
  const path = target.dockerfile;
  const anchors = await Promise.all([captureAnchor(paths.agentDir, paths.canonicalAgentDir), captureAnchor(input.cwd, canonicalCwd), captureAnchor(dirname(path), dirname(path))]);
  const missingParents = anchors[2]!.ancestors.filter((entry) => !entry.identity).map((entry) => entry.path);
  const created = new Set<string>();
  const createdOwners = new Map<string, string>();
  const source = await readDockerfile(path);
  const context = await scanContext(target.buildContext);
  let expectedContext = [...context];
  let expectedSource = source;
  const policies = await policyVersions(input, path);
  let registration: { text: string; previous: string | null; predicted: typeof targets } | undefined;
  if (scope === "project" && targets.repository) {
    let text: string | null = null;
    try { text = (await readText(target.config, 256 * 1024)).content; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const raw = readRawConfig(text ?? "");
    if (raw._repository !== undefined && JSON.stringify(raw._repository, Object.keys(targets.repository).sort()) !== JSON.stringify(targets.repository, Object.keys(targets.repository).sort())) throw new SettingsConflictError();
    if (raw._repository === undefined) {
      const proposed = serializeRaw({ ...raw, _repository: targets.repository });
      if (Buffer.byteLength(proposed) > 256 * 1024) throw new Error("Repository registration limit");
      registration = { text: proposed, previous: text, predicted: await hostConfigTargets(input, { file: target.config, text: proposed }) };
    }
  }
  let reviewedContextPaths: string[] = [];
  const validate = async () => {
    try {
      check();
      for (const anchor of anchors) await assertAnchor(anchor);
      for (const parent of missingParents.filter((entry) => !created.has(entry))) {
        try { await fs.lstat(parent); throw new SettingsConflictError(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (JSON.stringify(await hostConfigTargets(input)) !== JSON.stringify(targets)
        || JSON.stringify(await dockerfilePaths(input, canonicalCwd, check, mounts)) !== JSON.stringify(paths)
        || JSON.stringify([...(await policyVersions(input, path))]) !== JSON.stringify([...policies])
        || (await readDockerfile(path)).version !== expectedSource.version
        || !sameContext(await scanContext(target.buildContext), expectedContext)) throw new SettingsConflictError();
      await assertContextTargets(target.buildContext, expectedContext, reviewedContextPaths);
      check();
    } catch { throw new SettingsConflictError(); }
  };
  await validate();
  type Change = { path: string; content: string | null; mode: number; contextPath?: string; config?: boolean; temp?: string; owner?: string; version?: string };
  let changes: Change[] | undefined;
  let preparedContent: string | undefined;
  const readContext = async (requested: string[]) => {
    if (requested.length > CONTEXT_LIMITS.files || new Set(requested).size !== requested.length) throw new Error("Context read limit");
    // Reuse the patch path validation without reading any other file's contents.
    validateContextEdits(requested.map((path) => ({ path, content: null })));
    await assertContextTargets(target.buildContext, context, requested);
    let bytes = 0;
    const result: unknown[] = [];
    for (const name of requested) {
      await validate();
      await assertContextTargets(target.buildContext, context, [name]);
      const entry = context.find((entry) => entry.path === name);
      if (!entry) { result.push({ path: name, exists: false, content: null }); continue; }
      if (entry.directory) throw new Error("Requested context path is a directory");
      if (bytes + entry.bytes > CONTEXT_LIMITS.payloadBytes) throw new Error("Context read limit");
      const text = await readText(join(target.buildContext, name), CONTEXT_LIMITS.fileBytes);
      bytes += text.bytes;
      if (bytes > CONTEXT_LIMITS.payloadBytes || text.version !== entry.version) throw new Error("Context read limit or conflict");
      result.push({ path: name, exists: true, content: text.content, bytes: text.bytes, executable: entry.executable, sha256: sha256(text.content) });
    }
    await validate();
    return result;
  };
  return { paths, scope, target, source, context, readContext, async prepare(content, edits = []) {
    await validate(); validateContextEdits(edits);
    reviewedContextPaths = edits.map((edit) => edit.path);
    await validate();
    if (content !== undefined && (!validDockerfileText(content) || source.reason)) throw new Error("Invalid Dockerfile proposal");
    changes = []; preparedContent = content;
    const review: BundleReview = { changed: false, context: [] };
    if (content !== undefined && content !== source.content) changes.push({ path, content, mode: 0o600 });
    let reviewBytes = 0;
    for (const edit of edits) {
      const entry = context.find((entry) => entry.path === edit.path);
      if (entry?.directory) throw new Error("Cannot replace a context directory");
      for (let parent = dirname(edit.path); parent !== "."; parent = dirname(parent)) {
        const ancestor = context.find((entry) => entry.path === parent);
        if (ancestor && !ancestor.directory) throw new Error("Context ancestor is not a directory");
      }
      if (reviewBytes + (entry?.bytes ?? 0) > CONTEXT_LIMITS.payloadBytes) throw new Error("Context original review limit");
      const original = entry ? await readText(join(target.buildContext, edit.path), CONTEXT_LIMITS.fileBytes) : undefined;
      if (original && original.version !== entry!.version) throw new SettingsConflictError();
      reviewBytes += original?.bytes ?? 0;
      if (reviewBytes > CONTEXT_LIMITS.payloadBytes) throw new Error("Context original review limit");
      const executable = edit.executable ?? entry?.executable ?? false;
      if ((original?.content ?? null) === edit.content && (edit.content === null || executable === (entry?.executable ?? false))) continue;
      const oldMode = entry ? JSON.parse(entry.version)[2] & 0o7777 : undefined;
      const mode = edit.executable === undefined && oldMode !== undefined ? oldMode & 0o777 : executable ? 0o700 : 0o600;
      review.context.push({ path: edit.path, before: original?.content ?? null, after: edit.content, executableBefore: entry?.executable ?? false, executableAfter: executable, modeBefore: oldMode ?? null, modeAfter: edit.content === null ? null : mode });
      changes.push({ path: join(target.buildContext, edit.path), contextPath: edit.path, content: edit.content, mode });
    }
    review.changed = changes.length > 0;
    // A no-op does not create metadata, directories, or private files.
    if (review.changed && registration) {
      changes.push({ path: target.config, content: registration.text, mode: 0o600, config: true });
      review.registration = { path: target.config, metadata: targets.repository, consequence: "Register this immutable host-owned repository association in config.toml so shared sources are discovered by current/future registered worktrees, even after checkout gitfile deletion. User configuration/image intent and unknown keys are preserved; TOML formatting/comments may be rewritten. No Dockerfile/context is copied between destinations. Shared source may affect other worktrees on their next reload/start, subject to overrides." };
    }
    // Validate the FINAL source including implicit directories and the Dockerfile entry.
    const final = new Map(context.map((entry) => [entry.path, { directory: entry.directory, bytes: entry.bytes }]));
    for (const change of changes.filter((change) => change.contextPath !== undefined)) {
      const name = change.contextPath!;
      if (change.content === null) final.delete(name);
      else {
        final.set(name, { directory: false, bytes: Buffer.byteLength(change.content) });
        for (let parent = dirname(name); parent !== "."; parent = dirname(parent)) final.set(parent, { directory: true, bytes: 0 });
        final.set("", { directory: true, bytes: 0 });
      }
    }
    const bytes = [...final.values()].reduce((sum, entry) => sum + entry.bytes, 0) + Buffer.byteLength(content ?? source.content ?? "");
    if (bytes > BUILD_LIMITS.bytes || final.size + 1 > BUILD_LIMITS.entries) throw new Error("Final bundle source limit");
    await validate();
    return review;
  }, async save(content, guard) {
    if (!changes?.length || content !== preparedContent) throw new Error("Unprepared or unchanged bundle");
    const persisted: string[] = [];
    let completed = false;
    let uncertain: string | undefined;
    const unchanged = async () => { await guard(); await validate(); };
    const ensureDirectory = async (directory: string) => {
      const parts: string[] = [];
      for (let current = directory; current !== parse(current).root; current = dirname(current)) parts.unshift(current);
      for (const part of parts) {
        await unchanged();
        let stat;
        try { stat = await fs.lstat(part); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await fs.mkdir(part, { mode: 0o700 }); created.add(part);
          stat = await fs.lstat(part);
          createdOwners.set(part, ownerIdentity(stat));
          anchors.push(await captureAnchor(part, part));
          const rel = relative(target.buildContext, part);
          if (rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)) {
            expectedContext.push({ path: rel.split(sep).join("/"), directory: true, bytes: 0, executable: false, version: directoryIdentity(stat) });
          }
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SettingsConflictError();
      }
    };
    try {
      await unchanged();
      await ensureDirectory(dirname(path));
      // Stage ALL content before publishing any approved source changes; temps never enter COPY root.
      for (const change of changes) if (change.content !== null) {
        await unchanged();
        change.temp = join(dirname(path), `.dockerfile-${randomUUID()}.tmp`);
        const handle = await fs.open(change.temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, change.mode);
        try {
          // umask may restrict requested executable bits; set the exact reviewed mode on our new inode only.
          await handle.chmod(change.mode); await handle.writeFile(change.content, "utf8"); await handle.sync();
        } finally {
          try { const stat = await handle.stat(); change.version = fileIdentity(stat); change.owner = ownerIdentity(stat); }
          finally { await handle.close(); }
        }
      }
      for (const change of changes) {
        if (change.content !== null) await ensureDirectory(dirname(change.path));
        await unchanged();
        if (change.temp && fileIdentity(await fs.lstat(change.temp)) !== change.version) throw new SettingsConflictError();
        if (change.contextPath !== undefined) await assertContextTargets(target.buildContext, expectedContext, [change.contextPath]);
        uncertain = change.path;
        if (change.content === null) {
          await fs.unlink(change.path);
          expectedContext = expectedContext.filter((entry) => entry.path !== change.contextPath);
          try { await fs.lstat(change.path); throw new Error("Deleted file was replaced"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        } else {
          await fs.rename(change.temp!, change.path);
          const committed = await readText(change.path, change.config ? 256 * 1024 : DOCKERFILE_MAX_BYTES);
          if (committed.content !== change.content || committed.owner !== change.owner) throw new Error("Atomic replacement ownership or bytes changed");
          if (change.config) { policies.set(change.path, committed.version); targets = registration!.predicted; }
          else if (change.contextPath !== undefined) {
            expectedContext = expectedContext.filter((entry) => entry.path !== change.contextPath);
            expectedContext.push({ path: change.contextPath, directory: false, bytes: committed.bytes, executable: !!(change.mode & 0o111), version: committed.version });
          } else {
            expectedSource = { exists: true, bytes: committed.bytes, content: change.content, version: hash(committed.version + change.content) };
          }
        }
        persisted.push(change.path); uncertain = undefined;
        const directory = await fs.open(dirname(change.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
        await unchanged();
      }
      await unchanged();
      completed = true;
      return { async assertUnchanged() { await unchanged(); } };
    } catch (error) {
      if (persisted.length || uncertain) throw new BundlePersistenceError(persisted, uncertain);
      throw error;
    } finally {
      // No recursive source cleanup. Only our staged inode through our pinned parent may be removed.
      for (const change of changes) if (change.temp && change.owner) {
        try {
          for (const anchor of anchors) await assertAnchor(anchor);
          if (fileIdentity(await fs.lstat(change.temp)) === change.version) await fs.unlink(change.temp);
        } catch { /* Retain unknown/replaced artifacts rather than removing somebody else's bytes. */ }
      }
      if (!completed) for (const [directory, owner] of [...createdOwners].reverse()) {
        try {
          // Empty-directory-only cleanup, never recursive; pin ancestors and the owned directory inode.
          await assertAnchor(await captureAnchor(dirname(directory), dirname(directory)));
          for (const [ancestor, identity] of createdOwners) {
            if (directory.startsWith(`${ancestor}${sep}`) && ownerIdentity(await fs.lstat(ancestor)) !== identity) throw new SettingsConflictError();
          }
          for (const anchor of anchors) {
            for (const entry of anchor.ancestors.filter((entry) => entry.identity && !created.has(entry.path))) {
              const stat = await fs.lstat(entry.path);
              const actual = `${stat.dev}:${stat.ino}:${stat.mode}${stat.isSymbolicLink() ? `:${stat.ctimeMs}:${stat.mtimeMs}` : ""}`;
              if (actual !== entry.identity) throw new SettingsConflictError();
            }
          }
          if (ownerIdentity(await fs.lstat(directory)) === owner) await fs.rmdir(directory);
        } catch { /* Nonempty, replaced or uncertain directories belong to the host; retain them. */ }
      }
    }
  } };
}
