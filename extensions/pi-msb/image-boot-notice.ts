import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILD_ROOT_DISK_MIB, type DockerfileSource } from "./image-source.ts";
import { ImagePhaseError } from "./image-build.ts";
import type { ImagePreparationPhase } from "./types.ts";

export const imagePreparationMessages: Record<ImagePreparationPhase, string> = {
  "checking-source": "Checking Dockerfile source…",
  "source-changed": "Dockerfile or build context changed; preparing current image…",
  "image-missing": "Current Dockerfile image is missing; preparing image…",
  "using-cache": "Reusing cached Dockerfile image…",
  building: "Building Dockerfile image…",
  exporting: "Exporting Dockerfile image…",
  importing: "Importing/loading Dockerfile image…",
  booting: "Booting custom-image VM…",
};

export function notifyImagePreparation(ctx: Pick<ExtensionContext, "hasUI" | "mode" | "ui">, phase: ImagePreparationPhase): void {
  // The existing source-specific boot notice is the final step.
  if (!ctx.hasUI || phase === "booting") return;
  const message = imagePreparationMessages[phase];
  ctx.ui.notify(ctx.mode === "tui" ? ctx.ui.theme.fg("dim", message) : message, "info");
}

export interface ImagePreparationFailureSnapshot {
  readonly operation: "activation" | "build" | "load";
  readonly phase: string;
  readonly failureKind: string;
  readonly exitCode?: number;
  readonly command?: string;
  readonly message: string;
  readonly stderrTail: string;
  readonly stdoutTail: string;
  readonly outputTruncated: boolean;
  readonly outputWithheld: boolean;
  readonly imported?: boolean | "unknown";
  readonly selected?: boolean | "unknown";
  readonly recovery: string;
}
const safeFailureSnapshots = new WeakSet<object>();

/** Only failure-time sanitized snapshots may carry freeform output through diagnostics. */
export function isImagePreparationFailureSnapshot(value: unknown): value is ImagePreparationFailureSnapshot {
  return !!value && typeof value === "object" && safeFailureSnapshots.has(value);
}

/** Redact complete fields before normalization/truncation; never retain errors or raw logs. */
export function imagePreparationFailureSnapshot(error: unknown, redact: (text: string) => string,
  operation: ImagePreparationFailureSnapshot["operation"] = "activation",
  options: { allowUpstreamTruncatedOutput?: boolean } = {}): ImagePreparationFailureSnapshot {
  const safe = (text: string) => redact(text).replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, " ");
  const bounded = (text: string, length: number) => text.length > length ? `…${text.slice(-length)}` : text;
  const failure = error instanceof ImagePhaseError ? error : undefined;
  // Storage/cleanup failures must not attribute an earlier successful command's exit to this failure.
  const log = failure?.logs.filter((entry) => entry.phase === failure.phase).at(-1);
  const kind = failure?.diagnostics?.failureKind ?? log?.diagnostics?.failureKind;
  const failureKind = kind && ["commandNonzero", "streamEndedWithoutExit", "transport", "timeout", "cancelled", "disposed", "operation"].includes(kind)
    ? kind : log?.exitCode !== undefined && log.exitCode !== 0 ? "commandNonzero" : "operation";
  const phase = failure && ["validation", "build", "export", "storage", "import", "selection", "cleanup"].includes(failure.phase) ? failure.phase : "validation";
  // Untyped SDK/parser exceptions have no proven redaction context for their prose.
  const message = failure ? safe(failure.message) : "Image preparation failed; untyped error detail withheld. Inspect configuration and host runtime setup before retrying.";
  // The upstream collector may already have split a credential at its tail boundary.
  // Its combined truncation flag cannot prove either stream is complete.
  const outputWithheld = !!log?.truncated && options.allowUpstreamTruncatedOutput !== true;
  const withheld = "Output withheld: upstream truncation may have split sensitive text; full redaction cannot be established.";
  const stderr = outputWithheld ? withheld : log ? safe(log.stderr).trim() : "";
  const stdout = outputWithheld ? withheld : log ? safe(log.stdout).trim() : "";
  // Only bounded, redacted evidence authorizes the storage hint, never an exit code alone.
  const noSpace = [message, stderr, stdout].some((text) => /\bENOSPC\b|no space left on device/i.test(text.slice(-8192)));
  const recovery = noSpace
    ? `Storage exhaustion reported: the disposable builder has a fixed ${BUILD_ROOT_DISK_MIB / 1024} GiB writable disk. Docker's VFS driver copies full layers across RUN steps/stages and can fill it even with free host space. Host-backed temporary staging/exports or native cache can also run out; check host free space too. For build-phase exhaustion, reduce stages/dependencies or combine RUN steps with package/build-cache cleanup in the same step, then retry. Use msb_dockerfile_build then msb_dockerfile_load for diagnostics.`
    : "Fix the source and retry, or run msb_dockerfile_build then msb_dockerfile_load for diagnostics.";
  const snapshot: ImagePreparationFailureSnapshot = Object.freeze({
    operation, phase, failureKind,
    ...(Number.isSafeInteger(log?.exitCode) ? { exitCode: log!.exitCode } : {}),
    ...(log ? { command: safe([log.command, ...log.args].join(" ")).slice(0, 300) } : {}),
    ...(failure ? { imported: typeof failure.imported === "boolean" ? failure.imported : "unknown",
      selected: typeof failure.selected === "boolean" ? failure.selected : "unknown" } : {}),
    message: bounded(message, 500), stderrTail: bounded(stderr, 1200), stdoutTail: bounded(stdout, 1200),
    outputTruncated: !!log?.truncated || stderr.length > 1200 || stdout.length > 1200, outputWithheld, recovery,
  });
  safeFailureSnapshots.add(snapshot);
  return snapshot;
}

export function imagePreparationFailureMessage(error: unknown, redact: (text: string) => string): string {
  return formatImagePreparationFailure(imagePreparationFailureSnapshot(error, redact));
}

export function formatImagePreparationFailure(failure: ImagePreparationFailureSnapshot): string {
  const status = failure.exitCode !== undefined ? `exit status ${failure.exitCode}` : failure.failureKind;
  const tail = failure.stderrTail || failure.stdoutTail;
  return `Custom image preparation failed (${failure.phase}; ${status}${failure.command ? `; command ${failure.command}` : ""}): ${failure.message}${tail ? `\nOutput tail: ${tail}` : ""}\nSandbox activation blocked; no host fallback. ${failure.recovery}`;
}

export function notifyImagePreparationFailure(ctx: Pick<ExtensionContext, "hasUI" | "mode" | "ui">, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "error");
}

/** Presentation only: retain the configured agent alias, never rebase source ownership. */
export function customImageBootMessage(source: DockerfileSource, home = homedir()): string {
  const path = join(source.agentAlias, relative(source.agentRoot, source.dockerfile));
  const homeRelative = relative(home, path);
  const display = homeRelative === "" ? "~"
    : !isAbsolute(homeRelative) && homeRelative !== ".." && !homeRelative.startsWith(`..${sep}`) ? `~/${homeRelative}` : path;
  const safePath = display.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);
  return `Booting from custom image (${source.scope === "host-project" ? "Project" : "Global"} Dockerfile: ${safePath})`;
}

export function notifyCustomImageBoot(ctx: Pick<ExtensionContext, "hasUI" | "mode" | "ui">, source: DockerfileSource): void {
  if (!ctx.hasUI) return;
  const message = customImageBootMessage(source);
  ctx.ui.notify(ctx.mode === "tui" ? ctx.ui.theme.fg("dim", message) : message, "info");
}
