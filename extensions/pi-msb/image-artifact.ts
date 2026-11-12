import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { MicrosandboxModule } from "./control.ts";
import { prepareBuildArchive } from "./image-archive.ts";
import { buildImageReference, selectedImageReference, type DockerfileSource } from "./image-source.ts";

export interface BuildArtifact {
  artifactId: string;
  sourceIdentity: string;
  dockerfile: string;
  platform: string;
  reference: string;
  archiveDigest: string;
  configDigest: string;
  bytes: number;
}
type NativeSource = Pick<DockerfileSource, "dockerfile" | "platform">;
export type ImageSdkLoader = () => Promise<MicrosandboxModule>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const identity = (s: import("node:fs").Stats) => JSON.stringify([s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeMs, s.ctimeMs]);
export async function cachedImage(sdk: MicrosandboxModule, reference: string, platform: string) {
  if (!sdk.Image || sdk.defaultBackendKind?.() !== "local") throw new Error("Local image backend required");
  try {
    const image = await sdk.Image.get(reference);
    if (sdk.defaultBackendKind?.() !== "local" || image.reference !== reference || image.os !== "linux" || `linux/${image.architecture}` !== platform || !/^sha256:[a-f0-9]{64}$/.test(image.manifestDigest ?? "")) throw new Error("Native image metadata mismatch");
    return image;
  } catch (error) {
    if ((error as { code?: string })?.code === "imageNotFound" && sdk.defaultBackendKind?.() === "local") return undefined;
    throw error;
  }
}
export async function readLoadedImage(source: NativeSource, loader: ImageSdkLoader = async () => import("microsandbox")) {
  const image = await cachedImage(await loader(), selectedImageReference(source), source.platform);
  return image ? { digest: image.manifestDigest! } : undefined;
}
export async function selectionVersion(sdk: MicrosandboxModule, source: NativeSource): Promise<string> {
  return (await cachedImage(sdk, selectedImageReference(source), source.platform))?.manifestDigest ?? "missing";
}

/** No receipts or archives survive this owner. Durable approved images belong only to MSB. */
export class PendingArtifacts {
  private generation = 0;
  private entries = new Map<string, { artifact: BuildArtifact; path: string; check(): Promise<void>; remove(): Promise<void> }>();
  async read(source: DockerfileSource, id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Pending artifact unavailable; explicitly rebuild after restart or cleanup");
    if (entry.artifact.dockerfile !== source.dockerfile || entry.artifact.sourceIdentity !== source.identity || entry.artifact.platform !== source.platform || entry.artifact.reference !== buildImageReference(source)) {
      if (entry.artifact.dockerfile === source.dockerfile) await this.discard(id);
      throw Object.assign(new Error("Stale artifact: source changed; build the current source explicitly"), { code: "STALE_SOURCE" });
    }
    await entry.check();
    return { artifact: structuredClone(entry.artifact), path: entry.path, assertUnchanged: entry.check };
  }
  async current(source: DockerfileSource) {
    for (const [id, entry] of this.entries) if (entry.artifact.dockerfile === source.dockerfile && entry.artifact.sourceIdentity !== source.identity) await this.discard(id);
    const entry = [...this.entries.values()].find(({ artifact }) => artifact.reference === buildImageReference(source));
    return entry ? this.read(source, entry.artifact.artifactId) : undefined;
  }
  async publish(source: DockerfileSource, archive: string, guard: () => Promise<void>): Promise<BuildArtifact> {
    const generation = this.generation;
    const alias = await fs.mkdtemp("/tmp/pi-msb-pending-");
    const owner = await fs.lstat(alias);
    let directory = alias;
    const checkDirectory = async () => {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== owner.dev || stat.ino !== owner.ino || stat.uid !== owner.uid || (stat.mode & 0o777) !== 0o700) throw new Error("Pending artifact directory identity changed");
    };
    let removal: Promise<void> | undefined;
    const remove = () => removal ??= (async () => { await checkDirectory(); await fs.rm(directory, { recursive: true }); })().catch((error) => { removal = undefined; throw error; });
    let retained = false;
    try {
      directory = await fs.realpath(alias); await checkDirectory();
      const path = join(directory, "image.tar");
      const metadata = await prepareBuildArchive(archive, path, buildImageReference(source), source.platform);
      const data = await readArtifactFile(path);
      const artifactId = hash(JSON.stringify([source.dockerfile, source.identity, source.platform, data.digest, data.bytes]));
      const artifact: BuildArtifact = { artifactId, sourceIdentity: source.identity, dockerfile: source.dockerfile, platform: source.platform, reference: buildImageReference(source), archiveDigest: data.digest, configDigest: metadata.configDigest, bytes: data.bytes };
      const check = async () => {
        try { await checkDirectory(); if ((await readArtifactFile(path)).version !== data.version) throw new Error("Approved artifact changed"); }
        catch (error) {
          await remove();
          // A stale validator owns only its captured export, not a replacement with the same ID.
          if (this.entries.get(artifactId)?.check === check) this.entries.delete(artifactId);
          throw error;
        }
      };
      await guard(); await check();
      // Superseded pending exports are disposable, never durable image authority.
      for (const [id, previous] of this.entries) if (previous.artifact.dockerfile === source.dockerfile) { await previous.remove(); if (this.entries.get(id) === previous) this.entries.delete(id); }
      if (generation !== this.generation) throw new Error("Pending artifact lifetime ended");
      this.entries.set(artifactId, { artifact, path, check, remove }); retained = true;
      return structuredClone(artifact);
    } finally { if (!retained) await remove(); }
  }
  async discard(id: string) {
    const entry = this.entries.get(id);
    if (entry) { await entry.remove(); if (this.entries.get(id) === entry) this.entries.delete(id); }
  }
  async dispose() {
    this.generation++;
    let failure: unknown;
    for (const id of this.entries.keys()) {
      try { await this.discard(id); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
}
// Standalone build/load callers share an explicit process lifetime; integrations own separate stores.
export const pendingArtifacts = new PendingArtifacts();
export const readArtifact = (source: DockerfileSource, id: string) => pendingArtifacts.read(source, id);

export async function readArtifactFile(path: string): Promise<{ digest: string; bytes: number; version: string }> {
  const before = await fs.lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > 16 * 1024 ** 3 || typeof process.getuid === "function" && before.uid !== process.getuid()) throw new Error("Unsafe artifact file ownership/size");
  const version = identity(before);
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (identity(await file.stat()) !== version) throw new Error("Artifact file replaced");
    const digest = createHash("sha256"); const buffer = Buffer.alloc(64 * 1024); let bytes = 0;
    while (true) {
      const part = await file.read(buffer, 0, buffer.length, bytes);
      if (!part.bytesRead) break;
      bytes += part.bytesRead;
      if (bytes > before.size) throw new Error("Artifact grew during verification");
      digest.update(buffer.subarray(0, part.bytesRead));
    }
    if (bytes !== before.size || identity(await file.stat()) !== version || identity(await fs.lstat(path)) !== version) throw new Error("Artifact changed during verification");
    return { digest: digest.digest("hex"), bytes, version };
  } finally { await file.close(); }
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
