import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { MicrosandboxModule } from "./control.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { prepareBuildArchive } from "./image-archive.ts";
import { assertBuildPath, buildImageReference, snapshotDockerfile, type DockerfileSource } from "./image-source.ts";
import { lockPathFor, tryAcquireOrphanLock } from "./locks.ts";
import { createSdkTransport } from "./transport.ts";
import type { LockHandle, SandboxTransport } from "./types.ts";

const BUILD_TIMEOUT_MS = 20 * 60_000;
const PATH_ENV = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const BUILD_FAILURE = "Host-owned Dockerfile build/import failed; runtime activation is blocked. Check the host source, build limits, public download access and local Microsandbox installation; no host fallback was attempted.";
interface CacheRecord { identity: string; reference: string; digest: string; platform: string }
export interface ImageBuildOptions {
  sdk: MicrosandboxModule;
  source: DockerfileSource;
  signal?: AbortSignal;
  /** Test seam; production uses the bundled cross-process flock. */
  acquireLock?: (directory: string, identity: string) => Promise<LockHandle | null>;
}

/** The build port uses only the pinned SDK: no host Docker, CLI, commands or registry push. */
export async function ensureDockerfileImage(options: ImageBuildOptions): Promise<void> {
  try { await buildDockerfileImage(options); }
  catch { throw new Error(BUILD_FAILURE); }
}

async function buildDockerfileImage(options: ImageBuildOptions): Promise<void> {
  const { sdk, source } = options;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(cancel, BUILD_TIMEOUT_MS);
  const check = () => { if (abort.signal.aborted) throw new Error("Build cancelled"); };
  let lock: LockHandle | null = null;
  let temporary: string | undefined;
  let raw: any;
  const owner = randomUUID();
  let transport: SandboxTransport | undefined;
  const cleanupBuilder = async () => {
    // Use the owned object, never a fresh name lookup that might select a replacement.
    if (transport) { await transport.dispose(); transport = undefined; }
    if (raw) {
      const config = await raw.config();
      const labels = Array.isArray(config.labels) ? Object.fromEntries(config.labels) : config.labels;
      if (raw.ownsLifecycle !== true || labels?.["pi-msb.builder"] !== owner) throw new Error("Builder ownership changed");
      await raw.destroy({ timeoutMs: 10_000 });
      raw = undefined;
    }
  };
  try {
    check();
    if (!sdk.Image || !sdk.defaultBackendKind || sdk.defaultBackendKind() !== "local") throw new Error("Local image backend required");
    await assertBuildPath(source.agentRoot, source.cacheDir);
    const snapshot = await snapshotDockerfile(source, DEFAULT_CONFIG.image);
    if (snapshot.identity !== source.identity || snapshot.platform !== source.platform) throw new Error("Build source changed; reload required");
    check();
    await fs.mkdir(source.cacheDir, { recursive: true, mode: 0o700 });
    await assertBuildPath(source.agentRoot, source.cacheDir);
    const cacheStat = await fs.stat(source.cacheDir);
    const validateLocation = async () => {
      await assertBuildPath(source.agentRoot, source.cacheDir);
      const current = await fs.stat(source.cacheDir);
      if (await fs.realpath(source.agentAlias) !== source.agentRoot || await fs.realpath(source.agentRoot) !== source.agentRoot || current.dev !== cacheStat.dev || current.ino !== cacheStat.ino) throw new Error("Build cache identity changed");
    };
    const acquire = options.acquireLock ?? (async (directory, identity) => {
      const session = `image-build:${identity}`;
      await assertBuildPath(source.agentRoot, lockPathFor(directory, session));
      return tryAcquireOrphanLock({ lockDir: directory }, session);
    });
    while (!lock) {
      check();
      lock = await acquire(source.cacheDir, source.identity);
      if (!lock) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await validateLocation();
    const reference = buildImageReference(source.identity);
    const metadata = join(source.cacheDir, `${source.identity}.json`);
    await assertBuildPath(source.agentRoot, metadata);
    const inspectImage = async (): Promise<string> => {
      const image = await sdk.Image!.get(reference);
      if (image.reference !== reference || image.os !== "linux" || `linux/${image.architecture}` !== source.platform || !/^sha256:[a-f0-9]{64}$/.test(image.manifestDigest ?? "")) throw new Error("Invalid imported image metadata");
      return image.manifestDigest!;
    };
    try {
      const stat = await fs.lstat(metadata);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error("Invalid cache record");
      const record = JSON.parse(await fs.readFile(metadata, "utf8")) as CacheRecord;
      if (record.identity === source.identity && record.reference === reference && record.platform === source.platform && record.digest === await inspectImage()) { check(); return; }
    } catch { /* A missing/invalid cache record is never proof that an image is reusable. */ }
    check();
    temporary = await fs.mkdtemp("/tmp/pi-msb-build-");
    const input = join(temporary, "input");
    const output = join(temporary, "output");
    await fs.mkdir(input, { mode: 0o700 });
    await fs.mkdir(output, { mode: 0o700 });
    for (const entry of snapshot.entries) {
      const path = join(input, entry.path);
      if (entry.data === undefined) await fs.mkdir(path, { recursive: true, mode: entry.mode });
      else await fs.writeFile(path, entry.data, { mode: entry.mode, flag: "wx" });
    }
    check();
    if (sdk.defaultBackendKind() !== "local") throw new Error("Builder backend changed");
    const publicPolicy = sdk.NetworkPolicy?.fromProfiles?.(["public"]);
    if (!publicPolicy) throw new Error("Public-only builder network policy unavailable");
    const builder = sdk.Sandbox.builder(`pi-msb-builder-${owner}`)
      .image(DEFAULT_CONFIG.image).pullPolicy("if-missing").cpus(2).memory(4096)
      .security("default").user("root").detached(false).maxDuration(BUILD_TIMEOUT_MS / 1000)
      .idleTimeout(0).workdir("/pi-msb-input").labels({ "pi-msb.builder": owner });
    builder.network((network: any) => network.policy({ ...publicPolicy, defaultIngress: "deny" }));
    builder.volume("/pi-msb-input", (mount: any) => mount.bind(input).readonly());
    builder.volume("/pi-msb-output", (mount: any) => mount.bind(output));
    // Do not race create(): retain and clean up even a late SDK result after cancellation.
    await validateLocation();
    check();
    if (sdk.defaultBackendKind() !== "local") throw new Error("Builder backend changed");
    const created = await builder.create();
    if (created.ownsLifecycle !== true) throw new Error("Builder ownership could not be verified");
    raw = created;
    check();
    if (raw.backendKind !== "local") throw new Error("Builder backend could not be verified");
    transport = createSdkTransport(raw);
    const run = async (command: string, args: string[], timeoutMs: number) => {
      check();
      const result = await transport!.execStream("/usr/bin/env", ["-i", PATH_ENV, "HOME=/root", command, ...args], { timeoutMs, signal: abort.signal });
      if (result.exitCode !== 0) throw new Error("Guest build step failed");
    };
    await run("/usr/local/sbin/pi-msb-docker-start", ["15000"], 17_000);
    const docker = ["--host=unix:///var/run/docker.sock"];
    await run("/usr/local/bin/docker", [...docker, "buildx", "build", "--load", "--platform", source.platform, "--tag", reference, "--file", "/pi-msb-input/Dockerfile", "/pi-msb-input"], BUILD_TIMEOUT_MS);
    await run("/usr/local/bin/docker", [...docker, "save", "--output", "/pi-msb-output/image.tar", reference], BUILD_TIMEOUT_MS);
    // Stop guest access to the output before inspecting or importing its archive.
    await cleanupBuilder();
    check();
    const archive = join(output, "image.tar");
    const sanitizedArchive = join(temporary, "validated-image.tar");
    await prepareBuildArchive(archive, sanitizedArchive, reference, source.platform, abort.signal);
    check();
    await sdk.Image.load(sanitizedArchive, { tag: reference });
    check();
    const digest = await inspectImage();
    await validateLocation();
    await assertBuildPath(source.agentRoot, metadata);
    const record: CacheRecord = { identity: source.identity, reference, digest, platform: source.platform };
    const pending = `${metadata}.${randomUUID()}`;
    let pendingOwned = false;
    try {
      const file = await fs.open(pending, "wx", 0o600);
      pendingOwned = true;
      try { await file.writeFile(JSON.stringify(record)); }
      finally { await file.close(); }
      await validateLocation();
      check();
      await fs.rename(pending, metadata);
    } finally {
      if (pendingOwned) {
        await validateLocation();
        await fs.rm(pending, { force: true });
      }
    }
  } catch {
    throw new Error(BUILD_FAILURE);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    try {
      await cleanupBuilder();
    } catch {
      // Never remove host output while a failed-to-stop builder might still access it.
      throw new Error(BUILD_FAILURE);
    } finally {
      if (!raw && temporary) await fs.rm(temporary, { recursive: true, force: true });
      await lock?.release();
    }
  }
}
