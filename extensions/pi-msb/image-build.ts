import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { MicrosandboxModule } from "./control.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { prepareBuildArchive } from "./image-archive.ts";
import { assertBuildPath, BUILD_ROOT_DISK_MIB, buildImageReference, snapshotDockerfile, type DockerfileSource } from "./image-source.ts";
import { lockPathFor, tryAcquireOrphanLock } from "./locks.ts";
import { artifactStore, copyArtifactFile, buildRecordPath, publishArtifact, readArtifact, selectLoadedImage, selectionPath, type BuildArtifact } from "./image-artifact.ts";
import { createSdkTransport } from "./transport.ts";
import type { LockHandle, SandboxTransport } from "./types.ts";

const BUILD_TIMEOUT_MS = 20 * 60_000;
const PATH_ENV = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const BUILD_FAILURE = "No verified explicitly loaded Dockerfile image is available. Use msb_dockerfile_build then msb_dockerfile_load; no implicit build/import or host fallback was attempted.";
export interface BuildLog { phase: string; command: string; args: string[]; stdout: string; stderr: string; truncated: boolean; exitCode?: number }
export class ImagePhaseError extends Error {
  readonly phase: string;
  readonly logs: BuildLog[];
  readonly imported: boolean | "unknown";
  readonly selected: boolean | "unknown";
  constructor(phase: string, message: string, logs: BuildLog[] = [], imported: boolean | "unknown" = false, selected: boolean | "unknown" = false) {
    super(message); this.phase = phase; this.logs = logs; this.imported = imported; this.selected = selected;
  }
}
export interface ImageBuildOptions {
  sdk: MicrosandboxModule;
  source: DockerfileSource;
  signal?: AbortSignal;
  guard?: () => Promise<void>;
  /** Test seam; production uses the bundled cross-process flock. */
  acquireLock?: (directory: string, identity: string) => Promise<LockHandle | null>;
}

/** Export only: this function never imports images or touches runtime lifecycle. */
export async function buildDockerfileImage(options: ImageBuildOptions): Promise<{ artifact: BuildArtifact; cacheHit: boolean; logs: BuildLog[] }> {
  const { sdk, source } = options;
  const logs: BuildLog[] = [];
  let primaryFailure: ImagePhaseError | undefined;
  let phase = "validation";
  const guard = async () => { options.signal?.throwIfAborted(); await options.guard?.(); options.signal?.throwIfAborted(); };
  const abort = new AbortController();
  const cancel = () => abort.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(cancel, BUILD_TIMEOUT_MS);
  const check = () => { if (abort.signal.aborted) throw new Error("Build cancelled"); };
  let lock: LockHandle | null = null;
  let temporary: string | undefined;
  let temporaryAlias: string | undefined;
  let temporaryIdentity: { dev: number; ino: number } | undefined;
  let raw: any;
  const owner = randomUUID();
  const builderName = `pi-msb-builder-${owner}`;
  let createAttempted = false;
  let builderRemoved = false;
  const validateTemporary = async (path: string) => {
    const stat = await fs.lstat(path);
    if (!temporaryIdentity || !stat.isDirectory() || stat.dev !== temporaryIdentity.dev || stat.ino !== temporaryIdentity.ino) throw new Error("Build staging identity changed");
  };
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
      builderRemoved = true;
    } else if (createAttempted && !builderRemoved) {
      // create() can register a VM and then fail to boot. get() reads only the
      // database; destroy() on this same handle rejects same-name replacements.
      if (sdk.defaultBackendKind?.() !== "local") throw new Error("Builder backend changed");
      let handle: any;
      try { handle = await sdk.Sandbox.get(builderName); }
      catch (error) {
        if ((error as { code?: string })?.code !== "sandboxNotFound" || sdk.defaultBackendKind?.() !== "local") throw error;
        builderRemoved = true;
        return;
      }
      const config = await handle.config();
      const labels = Array.isArray(config.labels) ? Object.fromEntries(config.labels) : config.labels;
      if (handle.name !== builderName || handle.backendKind !== "local" || typeof handle.id !== "string" || !handle.id || config.name !== builderName || labels?.["pi-msb.builder"] !== owner) throw new Error("Builder ownership could not be verified");
      await handle.destroy({ timeoutMs: 10_000 });
      builderRemoved = true;
    }
  };
  try {
    check();
    await guard();
    if (!sdk.defaultBackendKind || sdk.defaultBackendKind() !== "local") throw new Error("Local image backend required");
    await assertBuildPath(source.agentRoot, source.cacheDir);
    const snapshot = await snapshotDockerfile(source, DEFAULT_CONFIG.image);
    if (snapshot.identity !== source.identity || snapshot.platform !== source.platform) throw new Error("Build source changed; inspect and reinvoke msb_dockerfile_build");
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
    const store = await artifactStore(source, true);
    try {
      const record = JSON.parse((await store.read(buildRecordPath(source))).text);
      const cached = await readArtifact(source, record.artifactId);
      await guard(); await cached.assertUnchanged(); check();
      return { artifact: cached.artifact, cacheHit: true, logs };
    } catch (error) {
      // Only absence is a cache miss; tampering is not authorization to overwrite.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    check();
    // Keep staging in /tmp, but never pass its platform-specific aliases to
    // no-follow SDK binds (macOS /tmp is a symlink to /private/tmp).
    temporaryAlias = await fs.mkdtemp("/tmp/pi-msb-build-");
    temporaryIdentity = await fs.lstat(temporaryAlias);
    temporary = await fs.realpath(temporaryAlias);
    await validateTemporary(temporary);
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
    const builder = sdk.Sandbox.builder(builderName)
      .image(DEFAULT_CONFIG.image).rootDisk(BUILD_ROOT_DISK_MIB).pullPolicy("if-missing").cpus(2).memory(4096)
      .security("default").user("root").detached(false).maxDuration(BUILD_TIMEOUT_MS / 1000)
      .idleTimeout(0).workdir("/pi-msb-input").labels({ "pi-msb.builder": owner });
    builder.network((network: any) => network.policy({ ...publicPolicy, defaultIngress: "deny" }));
    builder.volume("/pi-msb-input", (mount: any) => mount.bind(input).readonly());
    builder.volume("/pi-msb-output", (mount: any) => mount.bind(output));
    // Do not race create(): retain and clean up even a late SDK result after cancellation.
    await validateLocation();
    check();
    if (sdk.defaultBackendKind() !== "local") throw new Error("Builder backend changed");
    await validateTemporary(temporary);
    if (await fs.realpath(temporary) !== temporary || await fs.realpath(input) !== input || await fs.realpath(output) !== output) throw new Error("Build staging path changed");
    phase = "build";
    await guard();
    createAttempted = true;
    raw = await builder.create();
    if (raw.ownsLifecycle !== true) throw new Error("Builder ownership could not be verified");
    check();
    if (raw.backendKind !== "local") throw new Error("Builder backend could not be verified");
    transport = createSdkTransport(raw);
    const run = async (command: string, args: string[], timeoutMs: number) => {
      check(); await guard();
      const log: BuildLog = { phase, command, args, stdout: "", stderr: "", truncated: false };
      logs.push(log);
      const append = (key: "stdout" | "stderr", bytes: Uint8Array) => {
        const text = log[key] + Buffer.from(bytes).toString("utf8");
        log.truncated ||= Buffer.byteLength(text) > 32 * 1024;
        log[key] = Buffer.from(text).subarray(-32 * 1024).toString("utf8");
      };
      const result = await transport!.execStream("/usr/bin/env", ["-i", PATH_ENV, "HOME=/root", command, ...args], {
        timeoutMs, signal: abort.signal, onStdout: (data) => append("stdout", data), onStderr: (data) => append("stderr", data),
      });
      log.exitCode = result.exitCode;
      if (result.exitCode !== 0) throw new Error(`${command} exited with status ${result.exitCode}`);
      await guard();
    };
    await run("/usr/local/sbin/pi-msb-docker-start", ["15000"], 17_000);
    const docker = ["--host=unix:///var/run/docker.sock"];
    await run("/usr/local/bin/docker", [...docker, "buildx", "build", "--load", "--platform", source.platform, "--tag", reference, "--file", "/pi-msb-input/Dockerfile", "/pi-msb-input"], BUILD_TIMEOUT_MS);
    phase = "export";
    await run("/usr/local/bin/docker", [...docker, "save", "--output", "/pi-msb-output/image.tar", reference], BUILD_TIMEOUT_MS);
    // Stop guest access to the output before inspecting or importing its archive.
    await cleanupBuilder();
    check();
    const archive = join(output, "image.tar");
    const sanitizedArchive = join(temporary, "validated-image.tar");
    await prepareBuildArchive(archive, sanitizedArchive, reference, source.platform, abort.signal);
    check();
    await guard();
    phase = "storage";
    const artifact = await publishArtifact(source, sanitizedArchive, async () => { check(); await guard(); await validateLocation(); });
    return { artifact, cacheHit: false, logs };
  } catch (error) {
    primaryFailure = new ImagePhaseError(phase, error instanceof Error ? error.message : String(error), logs);
    throw primaryFailure;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    try {
      await cleanupBuilder();
    } catch (error) {
      // Never remove host output while a failed-to-stop builder might still access it.
      throw new ImagePhaseError("cleanup", `${primaryFailure ? primaryFailure.message + "; " : ""}Builder cleanup failed; staging retained because builder ownership/stop is unconfirmed: ${error instanceof Error ? error.message : String(error)}`, logs);
    } finally {
      try {
        if ((!createAttempted || builderRemoved) && temporaryAlias) {
          const path = temporary ?? temporaryAlias;
          try { await validateTemporary(path); await fs.rm(path, { recursive: true, force: true }); }
          catch (error) { throw new ImagePhaseError("cleanup", `${primaryFailure ? primaryFailure.message + "; " : ""}Staging cleanup refused: ${error instanceof Error ? error.message : String(error)}`, logs); }
        }
      } finally { await lock?.release(); }
    }
  }
}

export interface ImageLoadOptions extends ImageBuildOptions {
  artifactId: string;
  /** Required approval-time version (or exact absence), never recaptured after an SDK await. */
  expectedSelectionVersion: string;
  onSelectionPublished?: (assertSelected: () => Promise<void>) => void;
}

/** Explicit import only; successful artifacts remain available after every failure. */
export async function loadDockerfileImage(options: ImageLoadOptions): Promise<{ artifact: BuildArtifact; digest: string; assertSelected(): Promise<void> }> {
  let phase = "validation";
  let imported: boolean | "unknown" = false;
  let selected: boolean | "unknown" = false;
  const expectedSelectionVersion = options.expectedSelectionVersion;
  let assertSelection: (() => Promise<void>) | undefined;
  const guard = async () => {
    options.signal?.throwIfAborted(); await options.guard?.(); await assertSelection?.(); options.signal?.throwIfAborted();
    const snapshot = await snapshotDockerfile(options.source, DEFAULT_CONFIG.image);
    if (snapshot.identity !== options.source.identity || snapshot.platform !== options.source.platform) throw new Error("Stale source; build the current source explicitly");
  };
  try {
    const { sdk, source } = options;
    if (typeof expectedSelectionVersion !== "string" || !expectedSelectionVersion) throw new Error("Approval-time loaded selection expectation required");
    const store = await artifactStore(source);
    assertSelection = async () => {
      let version: string;
      try { version = (await store.read(selectionPath(source))).version; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; version = "missing"; }
      if (version !== expectedSelectionVersion) throw new Error("Loaded selection changed after approval; request fresh approval");
    };
    await guard();
    if (!sdk.Image || sdk.defaultBackendKind?.() !== "local") throw new Error("Local image backend required");
    const candidate = await readArtifact(source, options.artifactId);
    await guard(); await candidate.assertUnchanged();
    // Import from an exclusive verified copy, not a mutable cache pathname passed to the SDK.
    const alias = await fs.mkdtemp("/tmp/pi-msb-load-");
    const owner = await fs.lstat(alias);
    let temporary = alias;
    let primaryError: unknown;
    try {
      temporary = await fs.realpath(alias);
      const current = await fs.lstat(temporary);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error("Import staging identity changed");
      const archive = join(temporary, "image.tar");
      await copyArtifactFile(candidate.path, archive);
      // Verify the copy through the same no-follow digest reader before giving it to the importer.
      const copied = await artifactStore({ agentRoot: temporary, agentAlias: temporary, cacheDir: join(temporary, "verify") }, true);
      const data = await copied.read(archive, true);
      if (data.digest !== candidate.artifact.archiveDigest) throw new Error("Import copy content mismatch");
      await guard(); await candidate.assertUnchanged();
      phase = "import"; imported = "unknown";
      await sdk.Image.load(archive, { tag: candidate.artifact.reference });
      imported = true;
      await guard(); await candidate.assertUnchanged();
      const image = await sdk.Image.get(candidate.artifact.reference);
      if (image.reference !== candidate.artifact.reference || image.os !== "linux" || `linux/${image.architecture}` !== source.platform || !/^sha256:[a-f0-9]{64}$/.test(image.manifestDigest ?? "")) throw new Error("Imported image metadata mismatch");
      phase = "selection";
      const loaded = { artifact: candidate.artifact, digest: image.manifestDigest! };
      selected = "unknown";
      const assertSelected = await selectLoadedImage(source, loaded, async () => { await guard(); await candidate.assertUnchanged(); });
      selected = true;
      assertSelection = assertSelected;
      options.onSelectionPublished?.(assertSelected);
      await guard(); await candidate.assertUnchanged();
      await assertSelected();
      return { ...loaded, assertSelected };
    } catch (error) { primaryError = error; throw error; }
    finally {
      try {
        const current = await fs.lstat(temporary);
        if (!current.isDirectory() || current.dev !== owner.dev || current.ino !== owner.ino || await fs.realpath(temporary) !== temporary) throw new Error("Import staging identity changed; retained for host repair");
        await fs.rm(temporary, { recursive: true });
      } catch (error) {
        phase = "cleanup";
        throw new Error(`${primaryError ? (primaryError instanceof Error ? primaryError.message : String(primaryError)) + "; " : ""}Import staging cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) { throw new ImagePhaseError(phase, error instanceof Error ? error.message : String(error), [], imported, selected); }
}

/** Runtime may only verify a previously explicitly loaded selection. Never build or import. */
export async function verifyDockerfileImage(options: ImageBuildOptions): Promise<void> {
  const { sdk, source } = options;
  if (!source.loadedDigest || !sdk.Image || sdk.defaultBackendKind?.() !== "local") throw new Error(BUILD_FAILURE);
  const image = await sdk.Image.get(buildImageReference(source.identity));
  if (image.reference !== buildImageReference(source.identity) || image.manifestDigest !== source.loadedDigest || image.os !== "linux" || `linux/${image.architecture}` !== source.platform) throw new Error(BUILD_FAILURE);
}
