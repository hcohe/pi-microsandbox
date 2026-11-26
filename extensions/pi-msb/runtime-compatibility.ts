export const SDK_VERSION = "0.8.2";

export interface RuntimeVersionMismatch {
  readonly sdkVersion: string;
  readonly runtimeVersion: string;
}

const snapshots = new WeakSet<object>();
const launchContractRefusal = /^(?:runtime error: )?no tested sandbox launch contract for runtime(?: |$)/;
const displayableVersion = /^(\d{1,6}\.\d{1,6}\.\d{1,6})([-+][0-9A-Za-z.+-]+)?$/;

export function isRuntimeVersionMismatch(value: unknown): value is RuntimeVersionMismatch {
  return !!value && typeof value === "object" && snapshots.has(value);
}

export function formatRuntimeVersionMismatch(failure: RuntimeVersionMismatch): string {
  const host = failure.runtimeVersion === "unknown" ? "the selected host runtime (version unavailable)" : `host runtime ${failure.runtimeVersion}`;
  return `Microsandbox SDK ${failure.sdkVersion} cannot start ${host}. Update pi-microsandbox to a compatible release, or select a compatible runtime and firmware pair. Check MSB_PATH and MSB_LIBKRUNFW_PATH overrides and your user-wide Microsandbox installation, then restart Pi. Sandbox execution remains blocked.`;
}

export class RuntimeVersionMismatchError extends Error {
  readonly mismatch: RuntimeVersionMismatch;

  constructor(mismatch: RuntimeVersionMismatch) {
    super(formatRuntimeVersionMismatch(mismatch));
    this.mismatch = mismatch;
  }
}

// Only the native SDK launch-contract error is evidence of incompatibility.
// Never relay its raw message, cause, path, or arbitrary semver suffix.
export function runtimeVersionMismatch(error: unknown): RuntimeVersionMismatch | undefined {
  if (error instanceof RuntimeVersionMismatchError && isRuntimeVersionMismatch(error.mismatch)) return error.mismatch;
  if (!(error instanceof Error) || error.name !== "RuntimeError" || (error as { code?: unknown }).code !== "runtime") return undefined;
  const marker = launchContractRefusal.exec(error.message);
  if (!marker) return undefined;
  const version = error.message.slice(marker[0].length, marker[0].length + 128);
  const match = marker[0].length + version.length === error.message.length ? displayableVersion.exec(version) : null;
  const runtimeVersion = match && match[0] === version ? match[1] + (match[2] ? " (non-release build)" : "") : "unknown";
  const failure = Object.freeze({ sdkVersion: SDK_VERSION, runtimeVersion });
  snapshots.add(failure);
  return failure;
}
