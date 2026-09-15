import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export type FlockOperation = "exnb" | "un";
export type FlockTarget = "darwin-arm64" | "linux-x64-gnu" | "linux-arm64-gnu";

export interface FlockRuntime {
  platform: string;
  arch: string;
  glibcVersionRuntime?: unknown;
}

interface NativeFlockBinding {
  flock(fd: number, operation: FlockOperation): undefined;
}

export interface LoadFlockOptions {
  runtime?: FlockRuntime;
  requireAddon?: (absolutePath: string) => unknown;
}

const SUPPORTED_TARGETS = "darwin-arm64, linux-x64-gnu, linux-arm64-gnu";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentRuntime(): FlockRuntime {
  const report = process.platform === "linux"
    ? process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined
    : undefined;
  return {
    platform: process.platform,
    arch: process.arch,
    glibcVersionRuntime: report?.header?.glibcVersionRuntime,
  };
}

export function flockTarget(runtime: FlockRuntime): FlockTarget {
  if (runtime.platform === "darwin" && runtime.arch === "arm64") return "darwin-arm64";
  if (runtime.platform === "linux" && (runtime.arch === "x64" || runtime.arch === "arm64")) {
    if (typeof runtime.glibcVersionRuntime !== "string" || runtime.glibcVersionRuntime.length === 0) {
      throw new Error(
        `Bundled owner-lock addon requires glibc on Linux; libc is musl or indeterminate for linux-${runtime.arch}; `
        + `supported targets: ${SUPPORTED_TARGETS}; refusing to use an unsafe fallback`,
      );
    }
    return `linux-${runtime.arch}-gnu`;
  }
  throw new Error(
    `Bundled owner-lock addon does not support ${runtime.platform}-${runtime.arch}; `
    + `supported targets: ${SUPPORTED_TARGETS}; refusing to use an unsafe fallback`,
  );
}

export function flockBinaryPath(target: FlockTarget): string {
  return fileURLToPath(new URL(`../../native/flock/prebuilds/${target}/flock.node`, import.meta.url));
}

export function loadFlockBinding(options: LoadFlockOptions = {}): NativeFlockBinding {
  const target = flockTarget(options.runtime ?? currentRuntime());
  const relativePath = `native/flock/prebuilds/${target}/flock.node`;
  const absolutePath = flockBinaryPath(target);
  const requireAddon = options.requireAddon ?? ((path: string) => createRequire(import.meta.url)(path));

  try {
    const candidate = requireAddon(absolutePath);
    if (typeof candidate !== "object" || candidate === null
      || Object.keys(candidate).length !== 1
      || typeof (candidate as { flock?: unknown }).flock !== "function") {
      throw new TypeError("native binding must export only flock() as a callable property");
    }
    return candidate as NativeFlockBinding;
  } catch (error) {
    throw new Error(
      `Unable to load bundled owner-lock addon for ${target} from ${relativePath}; `
      + `refusing to use an unsafe fallback: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

let binding: NativeFlockBinding | undefined;

export async function flock(fd: number, operation: FlockOperation): Promise<void> {
  if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fff_ffff) {
    throw new TypeError("file descriptor must be a non-negative integer");
  }
  if (operation !== "exnb" && operation !== "un") {
    throw new TypeError('operation must be "exnb" or "un"');
  }
  binding ??= loadFlockBinding();
  binding.flock(fd, operation);
}
