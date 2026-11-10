import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { assertBuildPath, buildImageReference, type DockerfileSource } from "./image-source.ts";

export interface BuildArtifact {
  artifactId: string;
  sourceIdentity: string;
  dockerfile: string;
  platform: string;
  reference: string;
  archiveDigest: string;
  bytes: number;
}
export interface LoadedImage { artifact: BuildArtifact; digest: string }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const identity = (s: import("node:fs").Stats) => JSON.stringify([s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs]);
// Rename may update ctime; publication still must retain the staged inode, mode and bytes.
const publicationIdentity = (s: import("node:fs").Stats) => JSON.stringify([s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeMs]);
export const selectionPath = (source: Pick<DockerfileSource, "cacheDir" | "dockerfile">) => join(source.cacheDir, `${hash(source.dockerfile)}.selected.json`);
export const buildRecordPath = (source: DockerfileSource) => join(source.cacheDir, `${hash(source.dockerfile + source.identity)}.build.json`);
export function artifactPath(source: DockerfileSource, id: string): string {
  if (!validHash(id)) throw new Error("Invalid artifactId: expected 64 lowercase hexadecimal characters");
  return join(source.cacheDir, `${id}.tar`);
}
function validateArtifact(source: Pick<DockerfileSource, "dockerfile" | "platform">, artifact: BuildArtifact): void {
  if (!artifact || !validHash(artifact.artifactId) || !validHash(artifact.sourceIdentity) || !validHash(artifact.archiveDigest)
    || artifact.dockerfile !== source.dockerfile || artifact.platform !== source.platform
    || artifact.reference !== buildImageReference(artifact.artifactId) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0
    || artifact.artifactId !== hash(JSON.stringify([artifact.dockerfile, artifact.sourceIdentity, artifact.platform, artifact.archiveDigest, artifact.bytes]))) throw new Error("Artifact ownership/content identity mismatch");
}

/** Pin the canonical cache and all existing ancestors; never follow a descendant link. */
export async function artifactStore(source: Pick<DockerfileSource, "agentRoot" | "agentAlias" | "cacheDir">, create = false) {
  await assertBuildPath(source.agentRoot, source.cacheDir);
  if (create) await fs.mkdir(source.cacheDir, { recursive: true, mode: 0o700 });
  const ancestors: Array<[string, string]> = [];
  for (let path = source.cacheDir; ; path = dirname(path)) {
    const stat = await fs.lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path === source.cacheDir && typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Unsafe artifact directory ownership");
    ancestors.push([path, JSON.stringify([stat.dev, stat.ino, stat.mode, stat.uid])]);
    if (path === source.agentRoot) break;
    if (dirname(path) === path) throw new Error("Artifact cache outside agent root");
  }
  const check = async () => {
    if (await fs.realpath(source.agentAlias) !== source.agentRoot || await fs.realpath(source.agentRoot) !== source.agentRoot) throw new Error("Agent directory identity changed");
    for (const [path, expected] of ancestors) {
      const s = await fs.lstat(path);
      if (JSON.stringify([s.dev, s.ino, s.mode, s.uid]) !== expected || !s.isDirectory() || s.isSymbolicLink()) throw new Error("Artifact directory identity changed");
    }
  };
  await check();
  const read = async (path: string, digestOnly = false): Promise<{ text: string; digest: string; bytes: number; version: string; publication: string }> => {
    await check(); await assertBuildPath(source.agentRoot, path);
    const before = await fs.lstat(path);
    if (!before.isFile() || before.nlink !== 1 || typeof process.getuid === "function" && before.uid !== process.getuid() || !digestOnly && before.size > 8192 || before.size > 16 * 1024 ** 3) throw new Error("Unsafe artifact file ownership/size");
    const version = identity(before);
    const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const digest = createHash("sha256"); let text = ""; let bytes = 0;
    try {
      if (identity(await file.stat()) !== version) throw new Error("Artifact file replaced");
      const buffer = Buffer.alloc(64 * 1024);
      while (true) {
        const part = await file.read(buffer, 0, buffer.length, bytes);
        if (!part.bytesRead) break;
        bytes += part.bytesRead;
        if (bytes > before.size) throw new Error("Artifact grew during verification");
        const data = buffer.subarray(0, part.bytesRead); digest.update(data);
        if (!digestOnly) text += data.toString("utf8");
      }
      if (bytes !== before.size || identity(await file.stat()) !== version || identity(await fs.lstat(path)) !== version) throw new Error("Artifact changed during verification");
      await check();
      return { text, digest: digest.digest("hex"), bytes, version, publication: publicationIdentity(before) };
    } finally { await file.close(); }
  };
  const write = async (path: string, value: unknown, guard: () => Promise<void>) => {
    await check(); await assertBuildPath(source.agentRoot, path);
    let previous: string | undefined;
    try { previous = (await read(path)).version; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const pending = `${path}.${randomUUID()}.tmp`;
    const file = await fs.open(pending, "wx", 0o600);
    let owned: string | undefined;
    let publication: string | undefined;
    let closed = false;
    let assertPublished: (() => Promise<void>) | undefined;
    try {
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
      finally { try { const stat = await file.stat(); owned = identity(stat); publication = publicationIdentity(stat); } finally { await file.close(); closed = true; } }
      await guard(); await check();
      let current: string | undefined;
      try { current = (await read(path)).version; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (current !== previous || identity(await fs.lstat(pending)) !== owned) throw new Error("Artifact publication changed");
      await fs.rename(pending, path);
      const published = await read(path);
      if (published.publication !== publication || published.text !== JSON.stringify(value)) throw new Error("Artifact publication ownership changed");
      const publishedVersion = published.version;
      assertPublished = async () => {
        if ((await read(path)).version !== publishedVersion) throw new Error("Approved artifact publication changed");
      };
      const directory = await fs.open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
      await check();
    } finally {
      if (!closed) await file.close();
      await check();
      try { if (owned && identity(await fs.lstat(pending)) === owned) await fs.unlink(pending); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    // Synchronization and cleanup await after ownership verification; never rebaseline their result.
    await assertPublished!();
    return assertPublished!;
  };
  return { check, read, write };
}
export async function readArtifact(source: DockerfileSource, id: string) {
  const store = await artifactStore(source);
  const path = artifactPath(source, id);
  const receipt = await store.read(join(source.cacheDir, `${id}.artifact.json`));
  const artifact = JSON.parse(receipt.text) as BuildArtifact;
  validateArtifact(source, artifact);
  if (artifact.artifactId !== id || artifact.sourceIdentity !== source.identity) throw Object.assign(new Error("Stale artifact: source changed; build the current source explicitly"), { code: "STALE_SOURCE" });
  const archive = await store.read(path, true);
  if (archive.digest !== artifact.archiveDigest || archive.bytes !== artifact.bytes) throw new Error("Artifact archive content mismatch");
  return { artifact, path, async assertUnchanged() {
    await store.check();
    if ((await store.read(join(source.cacheDir, `${id}.artifact.json`))).version !== receipt.version || (await store.read(path, true)).version !== archive.version) throw new Error("Approved artifact changed");
  } };
}
export async function publishArtifact(source: DockerfileSource, archive: string, guard: () => Promise<void>): Promise<BuildArtifact> {
  const store = await artifactStore(source, true);
  // Staging has already been ownership-pinned by the builder; copy exclusively into the pinned cache.
  const pending = join(source.cacheDir, `${randomUUID()}.export.tmp`);
  await copyArtifactFile(archive, pending);
  const data = await store.read(pending, true);
  try {
    const artifactId = hash(JSON.stringify([source.dockerfile, source.identity, source.platform, data.digest, data.bytes]));
    const artifact: BuildArtifact = { artifactId, sourceIdentity: source.identity, dockerfile: source.dockerfile, platform: source.platform, archiveDigest: data.digest, bytes: data.bytes, reference: buildImageReference(artifactId) };
    await guard(); await store.check();
    const destination = artifactPath(source, artifactId);
    try { await copyArtifactFile(pending, destination); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const saved = await store.read(destination, true);
    if (saved.digest !== data.digest || saved.bytes !== data.bytes) throw new Error("Existing artifact archive mismatch");
    await store.write(join(source.cacheDir, `${artifactId}.artifact.json`), artifact, guard);
    await store.write(buildRecordPath(source), { artifactId }, guard);
    const confirmed = await readArtifact(source, artifactId);
    await guard(); await confirmed.assertUnchanged();
    return artifact;
  } finally {
    await store.check();
    if ((await store.read(pending, true)).version === data.version) await fs.unlink(pending);
  }
}
export async function readLoadedImage(source: Pick<DockerfileSource, "dockerfile" | "agentRoot" | "agentAlias" | "cacheDir" | "platform">): Promise<LoadedImage | undefined> {
  try {
    const store = await artifactStore(source);
    const record = JSON.parse((await store.read(selectionPath(source))).text) as LoadedImage;
    validateArtifact(source, record.artifact);
    if (!/^sha256:[a-f0-9]{64}$/.test(record.digest)) throw new Error("Invalid loaded image digest");
    return record;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function selectLoadedImage(source: DockerfileSource, loaded: LoadedImage, guard: () => Promise<void>) {
  validateArtifact(source, loaded.artifact);
  const store = await artifactStore(source);
  const assertPublished = await store.write(selectionPath(source), loaded, guard);
  await assertPublished();
  return assertPublished;
}

export async function copyArtifactFile(input: string, output: string): Promise<void> {
  const before = await fs.lstat(input);
  if (!before.isFile() || before.nlink !== 1) throw new Error("Unsafe artifact copy source");
  const parent = await fs.lstat(dirname(output));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Unsafe artifact copy destination");
  const source = await fs.open(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let owned: string | undefined;
  let complete = false;
  try {
    if (identity(await source.stat()) !== identity(before)) throw new Error("Artifact copy source replaced");
    const destination = await fs.open(output, "wx", 0o600);
    try {
      const buffer = Buffer.alloc(64 * 1024); let position = 0;
      while (position < before.size) {
        const part = await source.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (!part.bytesRead) throw new Error("Artifact copy source truncated");
        await destination.writeFile(buffer.subarray(0, part.bytesRead)); position += part.bytesRead;
      }
      await destination.sync();
    } finally { try { owned = identity(await destination.stat()); } finally { await destination.close(); } }
    if (identity(await source.stat()) !== identity(before) || identity(await fs.lstat(input)) !== identity(before)) throw new Error("Artifact changed while copying");
    complete = true;
  } finally {
    await source.close();
    if (!complete && owned) {
      const current = await fs.lstat(dirname(output));
      if (current.isDirectory() && !current.isSymbolicLink() && current.dev === parent.dev && current.ino === parent.ino) {
        try { if (identity(await fs.lstat(output)) === owned) await fs.unlink(output); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  }
}
