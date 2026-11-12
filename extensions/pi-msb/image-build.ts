import { randomUUID } from "node:crypto";
import { rewriteGlobalBase } from "./dockerfile-global.ts";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { MicrosandboxModule } from "./control.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { prepareBuildArchive } from "./image-archive.ts";
import { BUILD_ROOT_DISK_MIB, buildImageReference, selectedImageReference, snapshotDockerfile, type DockerfileSource } from "./image-source.ts";
import { lockPathFor, tryAcquireOrphanLock } from "./locks.ts";
import { cachedImage, copyArtifactFile, pendingArtifacts, PendingArtifacts, readArtifactFile, selectionVersion, type BuildArtifact } from "./image-artifact.ts";
import { buildLockDirectory } from "./image-build-lock.ts";
import { causalErrorDetails, createSdkTransport, SandboxTransportError, type StreamDiagnostics } from "./transport.ts";
import type { LockHandle, SandboxTransport } from "./types.ts";

const BUILD_TIMEOUT_MS = 20 * 60_000;
const PATH_ENV = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const BUILD_FAILURE = "No verified explicitly loaded Dockerfile image is available. Use msb_dockerfile_build then msb_dockerfile_load; no implicit build/import or host fallback was attempted.";
export interface BuildDiagnostics {
  sdk: "microsandbox@0.7.14";
  failureKind: "commandNonzero" | StreamDiagnostics["failureKind"] | "operation";
  elapsedMs: number;
  aggregateDeadlineMs: number;
  builderMaxDurationSec: number;
  cancellationSource?: "user" | "aggregateDeadline";
  causes: ReturnType<typeof causalErrorDetails>;
  observations?: {
    authority: "observationOnlyNotCompletionProof";
    builder: { outcome: string; status?: string };
    archive: { outcome: string; kind?: string; bytes?: number; modifiedAtMs?: number };
  };
  cleanup?: { builder: string; staging: string; lock: string };
  secondaryFailures: Array<{ operation: string; causes: ReturnType<typeof causalErrorDetails> }>;
}
export interface BuildLog { phase: string; command: string; args: string[]; stdout: string; stderr: string; truncated: boolean; exitCode?: number; diagnostics?: StreamDiagnostics }
export class ImagePhaseError extends Error {
  diagnostics?: BuildDiagnostics;
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
  artifacts?: PendingArtifacts;
  source: DockerfileSource;
  signal?: AbortSignal;
  guard?: () => Promise<void>;
  /** Test seam; production uses the bundled cross-process flock. */
  acquireLock?: (directory: string, identity: string) => Promise<LockHandle | null>;
}

/** Export only: this function never imports images or touches runtime lifecycle. */
export async function buildDockerfileImage(options: ImageBuildOptions): Promise<{ artifact: BuildArtifact; cacheHit: boolean; logs: BuildLog[] }> {
  const { sdk, source } = options;
  const started = performance.now();
  const logs: BuildLog[] = [];
  let primaryFailure: ImagePhaseError | undefined;
  let phase = "validation";
  const guard = async () => { options.signal?.throwIfAborted(); await options.guard?.(); options.signal?.throwIfAborted(); };
  const abort = new AbortController();
  let cancellationSource: BuildDiagnostics["cancellationSource"];
  const cancel = () => { if (!abort.signal.aborted) { cancellationSource = "user"; abort.abort(); } };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => {
    if (!abort.signal.aborted) { cancellationSource = "aggregateDeadline"; abort.abort(); }
  }, BUILD_TIMEOUT_MS);
  const check = () => { if (abort.signal.aborted) throw new Error(cancellationSource === "aggregateDeadline" ? "Build aggregate deadline elapsed" : "Build cancelled"); };
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
  let outputIdentity: { dev: number; ino: number } | undefined;
  // Read-only, identity-matched observations. No guest exec, reconnect, logs or config dump.
  const observeFailure = async (): Promise<BuildDiagnostics["observations"]> => {
    const unavailable = { outcome: "unavailable" };
    if (abort.signal.aborted) return { authority: "observationOnlyNotCompletionProof", builder: { outcome: "skippedCancellation" }, archive: { outcome: "skippedCancellation" } };
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort!: () => void;
    try {
      const sample = async (): Promise<NonNullable<BuildDiagnostics["observations"]>> => {
        const [builder, archive] = await Promise.all([
          (async () => {
            try {
              if (!raw || typeof raw.id !== "string" || !raw.id || sdk.defaultBackendKind?.() !== "local") return unavailable;
              const id = raw.id;
              const record = await sdk.Sandbox.get(builderName);
              if (record.id !== id || record.name !== builderName || record.backendKind !== "local" || sdk.defaultBackendKind?.() !== "local") return { outcome: "identityMismatch" };
              const statuses = ["created", "starting", "running", "draining", "paused", "stopped", "crashed"];
              return statuses.includes(record.status) ? { outcome: "sampled", status: record.status } : unavailable;
            } catch { return { outcome: "probeFailed" }; }
          })(),
          (async () => {
            try {
              if (!temporary || !outputIdentity) return unavailable;
              await validateTemporary(temporary);
              const output = join(temporary, "output");
              const parent = await fs.lstat(output);
              if (!parent.isDirectory() || parent.dev !== outputIdentity.dev || parent.ino !== outputIdentity.ino || await fs.realpath(temporary) !== temporary || await fs.realpath(output) !== output) return { outcome: "identityMismatch" };
              // lstat never follows the final archive component and never reads its bytes.
              const stat = await fs.lstat(join(output, "image.tar"));
              await validateTemporary(temporary);
              const after = await fs.lstat(output);
              if (!after.isDirectory() || after.dev !== parent.dev || after.ino !== parent.ino) return { outcome: "identityMismatch" };
              return { outcome: "sampled", kind: stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other", bytes: stat.size, modifiedAtMs: stat.mtimeMs };
            } catch (error) { return { outcome: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "probeFailed" }; }
          })(),
        ]);
        return { authority: "observationOnlyNotCompletionProof", builder, archive };
      };
      return await Promise.race([
        sample(),
        new Promise<NonNullable<BuildDiagnostics["observations"]>>((resolve) => {
          const finish = (outcome: string) => resolve({ authority: "observationOnlyNotCompletionProof", builder: { outcome }, archive: { outcome } });
          probeTimer = setTimeout(() => finish("probeBudgetElapsed"), 500);
          onAbort = () => finish("skippedCancellation");
          abort.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally { clearTimeout(probeTimer); if (onAbort) abort.signal.removeEventListener("abort", onAbort); }
  };
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
    const snapshot = await snapshotDockerfile(source, DEFAULT_CONFIG.image);
    if (snapshot.identity !== source.identity || snapshot.platform !== source.platform) throw new Error("Build source changed; inspect and reinvoke msb_dockerfile_build");
    const directory = await buildLockDirectory();
    const validateLocation = directory.check;
    const acquire = options.acquireLock ?? (async (path, identity) => {
      await directory.check();
      const session = `image-build:${identity}`;
      const lockPath = lockPathFor(path, session);
      try {
        const stat = await fs.lstat(lockPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw new Error("Unsafe build lock ownership");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const handle = await tryAcquireOrphanLock({ lockDir: path }, session);
      try { await directory.check(); return handle; }
      catch (error) { await handle?.release(); throw error; }
    });
    const reference = buildImageReference(source);
    while (!lock) {
      check(); await guard();
      lock = await acquire(directory.path, reference);
      if (!lock) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await validateLocation();
    const artifacts = options.artifacts ?? pendingArtifacts;
    const cached = await artifacts.current(source);
    if (cached) { await guard(); await cached.assertUnchanged(); check(); return { artifact: cached.artifact, cacheHit: true, logs }; }
    const native = await cachedImage(sdk, reference, source.platform);
    if (native) {
      const alias = await fs.mkdtemp("/tmp/pi-msb-export-");
      const owner = await fs.lstat(alias);
      let path = alias;
      const checkExportDirectory = async () => {
        const current = await fs.lstat(path);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error("Export staging identity changed");
      };
      try {
        path = await fs.realpath(alias); await checkExportDirectory();
        await guard(); check();
        await sdk.Image!.save(reference, { outputPath: join(path, "image.tar"), format: "docker" });
        if ((await cachedImage(sdk, reference, source.platform))?.manifestDigest !== native.manifestDigest) throw new Error("Native build reference changed during export");
        const artifact = await artifacts.publish(source, join(path, "image.tar"), async () => { check(); await guard();
          if ((await cachedImage(sdk, reference, source.platform))?.manifestDigest !== native.manifestDigest) throw new Error("Native build reference changed during export");
        });
        return { artifact, cacheHit: true, logs };
      } finally {
        await checkExportDirectory();
        await fs.rm(path, { recursive: true });
      }
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
    outputIdentity = await fs.lstat(output);
    const globalReference = `localhost/pi-msb-global:${owner}`;
    const globalInput = snapshot.global ? join(temporary, "global-input") : undefined;
    const stage = async (directory: string, entries: typeof snapshot.entries, rewrite = false) => {
      for (const entry of entries) {
        const path = join(directory, entry.path);
        if (entry.data === undefined) await fs.mkdir(path, { recursive: true, mode: entry.mode });
        else {
          const data = rewrite && entry.path === "Dockerfile" ? rewriteGlobalBase(entry.data, globalReference) : entry.data;
          if (!data) throw new Error("Missing FROM GLOBAL dependency");
          await fs.writeFile(path, data, { mode: entry.mode, flag: "wx" });
        }
      }
    };
    await stage(input, snapshot.entries, !!snapshot.global);
    if (globalInput) {
      await fs.mkdir(globalInput, { mode: 0o700 });
      await stage(globalInput, snapshot.global!.entries);
    }
    check();
    if (sdk.defaultBackendKind() !== "local") throw new Error("Builder backend changed");
    const publicPolicy = sdk.NetworkPolicy?.fromProfiles?.(["public"]);
    if (!publicPolicy) throw new Error("Public-only builder network policy unavailable");
    const builder = sdk.Sandbox.builder(builderName)
      .image(DEFAULT_CONFIG.image).rootDisk(BUILD_ROOT_DISK_MIB).pullPolicy("if-missing").cpus(2).memory(4096)
      .security("default").user("root").detached(false).maxDuration(BUILD_TIMEOUT_MS / 1000)
      // SDK 0.7.14 treats zero as immediate idle expiry, not disabled.
      .workdir("/pi-msb-input").labels({ "pi-msb.builder": owner });
    builder.network((network: any) => network.policy({ ...publicPolicy, defaultIngress: "deny" }));
    builder.volume("/pi-msb-input", (mount: any) => mount.bind(input).readonly());
    if (globalInput) builder.volume("/pi-msb-global-input", (mount: any) => mount.bind(globalInput).readonly());
    builder.volume("/pi-msb-output", (mount: any) => mount.bind(output));
    // Do not race create(): retain and clean up even a late SDK result after cancellation.
    await validateLocation();
    check();
    if (sdk.defaultBackendKind() !== "local") throw new Error("Builder backend changed");
    await validateTemporary(temporary);
    if (await fs.realpath(temporary) !== temporary || await fs.realpath(input) !== input || await fs.realpath(output) !== output || globalInput && await fs.realpath(globalInput) !== globalInput) throw new Error("Build staging path changed");
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
      let result: { exitCode: number };
      try { result = await transport!.execStream("/usr/bin/env", ["-i", PATH_ENV, "HOME=/root", command, ...args], {
        timeoutMs, signal: abort.signal, onStdout: (data) => append("stdout", data), onStderr: (data) => append("stderr", data),
      }); } catch (error) {
        if (error instanceof SandboxTransportError) {
          log.diagnostics = error.diagnostics;
          // An observed status remains evidence even if a later recv fails; never success.
          if (error.diagnostics?.observedExitCode !== undefined) log.exitCode = error.diagnostics.observedExitCode;
        }
        throw error;
      }
      log.exitCode = result.exitCode;
      if (result.exitCode !== 0) throw new Error(`${command} exited with status ${result.exitCode}`);
      await guard();
    };
    await run("/usr/local/sbin/pi-msb-docker-start", ["15000"], 17_000);
    const docker = ["--host=unix:///var/run/docker.sock"];
    if (snapshot.global) await run("/usr/local/bin/docker", [...docker, "buildx", "build", "--load", "--platform", source.platform, "--tag", globalReference, "--file", "/pi-msb-global-input/Dockerfile", "/pi-msb-global-input"], BUILD_TIMEOUT_MS);
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
    const artifact = await artifacts.publish(source, sanitizedArchive, async () => { check(); await guard(); await validateLocation(); });
    return { artifact, cacheHit: false, logs };
  } catch (error) {
    primaryFailure = new ImagePhaseError(phase, error instanceof Error ? error.message : String(error), logs);
    const last = logs.at(-1);
    primaryFailure.diagnostics = {
      sdk: "microsandbox@0.7.14",
      failureKind: cancellationSource === "aggregateDeadline" ? "timeout" : cancellationSource === "user" ? "cancelled" : last?.diagnostics?.failureKind ?? (last?.exitCode !== undefined && last.exitCode !== 0 ? "commandNonzero" : "operation"),
      elapsedMs: Math.round(performance.now() - started), aggregateDeadlineMs: BUILD_TIMEOUT_MS, builderMaxDurationSec: BUILD_TIMEOUT_MS / 1000,
      cancellationSource, causes: causalErrorDetails(error), secondaryFailures: [],
    };
    try { primaryFailure.diagnostics.observations = await observeFailure(); }
    catch (secondary) { primaryFailure.diagnostics.secondaryFailures.push({ operation: "diagnosticProbe", causes: causalErrorDetails(secondary) }); }
    // Cancellation arriving during observation still takes precedence.
    if (cancellationSource) {
      primaryFailure.diagnostics.cancellationSource = cancellationSource;
      primaryFailure.diagnostics.failureKind = cancellationSource === "user" ? "cancelled" : "timeout";
    }
    throw primaryFailure;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    let cleanupFailure: ImagePhaseError | undefined;
    const cleanup = { builder: builderRemoved ? "removed" : createAttempted ? "unconfirmed" : "notCreated", staging: temporaryAlias ? "retained" : "notCreated", lock: lock ? "unconfirmed" : "notAcquired" };
    const secondary = (operation: string, error: unknown, message: string) => {
      const failure = primaryFailure ?? cleanupFailure ?? (cleanupFailure = new ImagePhaseError("cleanup", message, logs));
      if (!failure.diagnostics) failure.diagnostics = { sdk: "microsandbox@0.7.14", failureKind: "operation", elapsedMs: Math.round(performance.now() - started), aggregateDeadlineMs: BUILD_TIMEOUT_MS, builderMaxDurationSec: BUILD_TIMEOUT_MS / 1000, causes: [], secondaryFailures: [] };
      failure.diagnostics.secondaryFailures.push({ operation, causes: causalErrorDetails(error) });
    };
    try { await cleanupBuilder(); cleanup.builder = builderRemoved ? "removed" : "notCreated"; }
    catch (error) {
      // Never remove output while stop/ownership is unconfirmed; retain primary phase.
      secondary("builderCleanup", error, "Builder cleanup failed; staging retained because builder ownership/stop is unconfirmed");
    }
    try {
      if ((!createAttempted || builderRemoved) && temporaryAlias) {
        const path = temporary ?? temporaryAlias;
        await validateTemporary(path); await fs.rm(path, { recursive: true, force: true }); cleanup.staging = "removed";
      }
    } catch (error) { secondary("stagingCleanup", error, "Staging cleanup refused; retained for host repair"); }
    try { await lock?.release(); if (lock) cleanup.lock = "released"; }
    catch (error) { cleanup.lock = "failed"; secondary("lockRelease", error, "Build lock release failed"); }
    const failure = primaryFailure ?? cleanupFailure;
    if (failure?.diagnostics) failure.diagnostics.cleanup = cleanup;
    if (!primaryFailure && cleanupFailure) throw cleanupFailure;
  }
}

export interface ImageLoadOptions extends ImageBuildOptions {
  artifactId: string;
  /** Required approval-time version (or exact absence), never recaptured after an SDK await. */
  expectedSelectionVersion: string;
  onSelectionPublished?: (assertSelected: () => Promise<void>) => void;
}

/** Explicit approved import only. Native aliases are additive and nontransactional. */
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
    assertSelection = async () => {
      if (await selectionVersion(sdk, source) !== expectedSelectionVersion) throw new Error("Loaded selection changed after approval; request fresh approval");
    };
    await guard();
    if (!sdk.Image || sdk.defaultBackendKind?.() !== "local") throw new Error("Local image backend required");
    const artifacts = options.artifacts ?? pendingArtifacts;
    const candidate = await artifacts.read(source, options.artifactId);
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
      const data = await readArtifactFile(archive);
      if (data.digest !== candidate.artifact.archiveDigest) throw new Error("Import copy content mismatch");
      await guard(); await candidate.assertUnchanged();
      const reference = candidate.artifact.reference;
      const selectedRef = selectedImageReference(source);
      const existingBuild = await cachedImage(sdk, reference, source.platform);
      const existingSelected = await cachedImage(sdk, selectedRef, source.platform);
      const inspectConfig = async (ref: string) => (await sdk.Image!.inspect(ref)).config?.digest;
      let digest: string;
      if (existingBuild && existingSelected && existingBuild.manifestDigest === existingSelected.manifestDigest
        && await inspectConfig(reference) === candidate.artifact.configDigest && await inspectConfig(selectedRef) === candidate.artifact.configDigest) {
        await guard(); await candidate.assertUnchanged();
        digest = existingBuild.manifestDigest!;
      } else {
        await guard(); await candidate.assertUnchanged();
        if ((await readArtifactFile(archive)).version !== data.version) throw new Error("Import copy changed");
        phase = "import"; imported = "unknown"; selected = "unknown";
        const handles = await sdk.Image.load(archive, { tag: selectedRef });
        // Image.load imports BOTH the sanitized RepoTag and the extra selected tag.
        const build = handles.find((image) => image.reference === reference);
        const chosen = handles.find((image) => image.reference === selectedRef);
        if (handles.length !== 2 || !build || !chosen || !/^sha256:[a-f0-9]{64}$/.test(build.manifestDigest ?? "")
          || handles.some((image) => image.manifestDigest !== build.manifestDigest || image.os !== "linux" || `linux/${image.architecture}` !== source.platform)) throw new Error("Import returned inconsistent native references; native aliases may be partially changed");
        digest = build.manifestDigest!;
        imported = true;
      }
      if ((await readArtifactFile(archive)).version !== data.version) throw new Error("Import copy changed during import; native aliases may be partially changed");
      phase = "selection";
      const assertSelected = async () => {
        for (const ref of [reference, selectedRef]) {
          if ((await cachedImage(sdk, ref, source.platform))?.manifestDigest !== digest || await inspectConfig(ref) !== candidate.artifact.configDigest) throw new Error("Approved native image selection changed; native aliases may be partially changed");
        }
      };
      await assertSelected();
      selected = true;
      assertSelection = assertSelected;
      options.onSelectionPublished?.(assertSelected);
      await guard(); await candidate.assertUnchanged(); await assertSelected();
      const loaded = { artifact: { ...candidate.artifact, reference: selectedRef }, digest };
      await artifacts.discard(options.artifactId);
      await guard(); await assertSelected();
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
  const image = await cachedImage(sdk, selectedImageReference(source), source.platform);
  if (image?.manifestDigest !== source.loadedDigest) throw new Error(BUILD_FAILURE);
}
