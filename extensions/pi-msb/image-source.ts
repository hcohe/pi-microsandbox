import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { rewriteGlobalBase } from "./dockerfile-global.ts";

export interface DockerfileSource {
  dockerfile: string;
  agentRoot: string;
  agentAlias: string;
  scope: "host-default" | "host-project";
  identity: string;
  platform: string;
  loadedDigest?: string;
}
export interface BuildEntry { path: string; data?: Buffer; mode: number }
export const BUILD_LIMITS = { bytes: 32 * 1024 * 1024, entries: 2048, depth: 16 } as const;
export const BUILD_VERSION = "pi-msb-dockerfile-v2-global-sdk-0.7.14-public-egress-deny-ingress";
// VFS copies full layers per RUN/stage; allow multi-stage builds beyond the bundled base.
// This finite disposable-builder allowance also participates in source/cache identity.
export const BUILD_ROOT_DISK_MIB = 32768;

export function nativeBuildPlatform(): string {
  if (!["arm64", "x64"].includes(process.arch)) throw new Error("Dockerfile builds require a native ARM64 or AMD64 host");
  return `linux/${process.arch === "x64" ? "amd64" : "arm64"}`;
}

/** The agent root may itself be a symlink; none of its descendants may be. */
export async function assertBuildPath(agentRoot: string, path: string): Promise<void> {
  const rel = relative(agentRoot, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Invalid host-owned build path");
  let current = agentRoot;
  for (const component of rel.split(sep)) {
    current = join(current, component);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Build paths must not contain symlinks");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
export async function discoverDockerfile(agentRoot: string, path: string): Promise<boolean> {
  try {
    await assertBuildPath(agentRoot, path);
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Dockerfile must be an unlinked regular file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface DockerfileSnapshot {
  entries: BuildEntry[];
  global?: { entries: BuildEntry[] };
  identity: string;
  platform: string;
}

/** No repository or adjacent policy files enter this bounded, in-memory snapshot. */
export async function snapshotDockerfile(source: Pick<DockerfileSource, "dockerfile" | "agentRoot" | "agentAlias">, builderImage: string): Promise<DockerfileSnapshot> {
  const assertRoot = async () => {
    if (await fs.realpath(source.agentRoot) !== source.agentRoot || await fs.realpath(source.agentAlias) !== source.agentRoot) throw new Error("Agent directory identity changed");
  };
  await assertRoot();
  let bytes = 0;
  let entryCount = 0;
  const readEntries = async (dockerfile: string): Promise<BuildEntry[]> => {
    await assertBuildPath(source.agentRoot, dockerfile);
    const context = join(dirname(dockerfile), "build-context");
    await assertBuildPath(source.agentRoot, context);
    const entries: BuildEntry[] = [];
    const visit = async (host: string, path: string, depth: number): Promise<void> => {
      if (depth > BUILD_LIMITS.depth || entryCount >= BUILD_LIMITS.entries) throw new Error("Build context limit exceeded");
      const before = await fs.lstat(host);
      entryCount++;
      if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory()) || before.isFile() && before.nlink !== 1) throw new Error("Build context requires unlinked regular files and directories");
      const unchanged = (after: typeof before) => before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
      if (before.isDirectory()) {
        entries.push({ path, mode: 0o755 });
        const names = (await fs.readdir(host)).sort();
        for (const name of names) {
          if (path === "" && name === "Dockerfile") throw new Error("build-context must not contain Dockerfile");
          await visit(join(host, name), path ? `${path}/${name}` : name, depth + 1);
        }
      } else {
        bytes += before.size;
        if (bytes > BUILD_LIMITS.bytes) throw new Error("Build context byte limit exceeded");
        const file = await fs.open(host, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (!unchanged(await file.stat())) throw new Error("Build source changed while reading");
          // A bounded read also handles concurrent growth without allocating arbitrary data.
          const data = Buffer.alloc(before.size + 1);
          let length = 0;
          while (length < data.length) {
            const result = await file.read(data, length, data.length - length, length);
            if (!result.bytesRead) break;
            length += result.bytesRead;
          }
          if (length !== before.size || !unchanged(await file.stat())) throw new Error("Build source changed while reading");
          entries.push({ path, data: data.subarray(0, length), mode: before.mode & 0o111 ? 0o755 : 0o644 });
        } finally { await file.close(); }
      }
      if (!unchanged(await fs.lstat(host))) throw new Error("Build source changed while reading");
    };
    await visit(dockerfile, "Dockerfile", 0);
    try { await visit(context, "", 0); }
    catch (error) {
      // Only a missing context root is optional, not a disappearing child.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || entries.length !== 1) throw error;
      try { await fs.lstat(context); throw new Error("Build context changed while reading"); }
      catch (check) { if ((check as NodeJS.ErrnoException).code !== "ENOENT") throw check; }
    }
    await assertBuildPath(source.agentRoot, dockerfile);
    await assertBuildPath(source.agentRoot, context);
    return entries;
  };
  const entries = await readEntries(source.dockerfile);
  let global: DockerfileSnapshot["global"];
  if (rewriteGlobalBase(entries[0]!.data!, "GLOBAL")) {
    const globalPath = join(source.agentRoot, "pi-microsandbox", "Dockerfile");
    if (source.dockerfile === globalPath) throw new Error("Global Dockerfile cannot inherit FROM GLOBAL");
    try { global = { entries: await readEntries(globalPath) }; }
    catch (error) { throw new Error("FROM GLOBAL requires a safe current Global Dockerfile and build-context", { cause: error }); }
    if (rewriteGlobalBase(global.entries[0]!.data!, "GLOBAL")) throw new Error("Global Dockerfile cannot inherit FROM GLOBAL");
  }
  await assertRoot();
  const platform = nativeBuildPlatform();
  const hash = createHash("sha256").update(JSON.stringify([BUILD_VERSION, builderImage, platform, 2, 4096, BUILD_ROOT_DISK_MIB]));
  for (const entry of entries) {
    hash.update(JSON.stringify([entry.path, entry.mode, entry.data?.length ?? null]));
    if (entry.data) hash.update(entry.data);
  }
  if (global) {
    hash.update(JSON.stringify(["global", global.entries.length]));
    for (const entry of global.entries) {
      hash.update(JSON.stringify([entry.path, entry.mode, entry.data?.length ?? null]));
      if (entry.data) hash.update(entry.data);
    }
  }
  return { entries, ...(global ? { global } : {}), identity: hash.digest("hex"), platform };
}
export const IMAGE_REFERENCE_VERSION = "pi-msb-native-image-v1";
type NativeSource = Pick<DockerfileSource, "dockerfile" | "platform">;
const referenceKey = (values: string[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex");
export function buildImageReference(source: NativeSource & Pick<DockerfileSource, "identity">): string {
  return `localhost/pi-msb-build:${referenceKey([IMAGE_REFERENCE_VERSION, source.dockerfile, source.platform, source.identity])}`;
}
export function selectedImageReference(source: NativeSource): string {
  return `localhost/pi-msb-selected:${referenceKey([IMAGE_REFERENCE_VERSION, source.dockerfile, source.platform])}`;
}
