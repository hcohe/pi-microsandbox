import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SettingsConflictError } from "./settings-conflict.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { approveDockerfileLoad } from "./dockerfile-load-approval.ts";
import { ImagePhaseError, type BuildLog } from "./image-build.ts";
import { artifactStore, readArtifact, selectionPath } from "./image-artifact.ts";
import { snapshotDockerfile, type DockerfileSource } from "./image-source.ts";
import type { MsbControl, SessionExecutionContext } from "./types.ts";

const terminalText = (text: string) => text.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu,
  (char) => char === "\n" || char === "\t" ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`);
const buildConflictGuidance = "Configuration changed during build; inspect and reinvoke msb_dockerfile_build.";
const session = (ctx: ExtensionContext) => JSON.stringify([ctx.sessionManager.getSessionId(), ctx.cwd]);
function report(details: Record<string, unknown>) {
  const logs = details.logs as BuildLog[] | undefined;
  const text = [`Dockerfile ${details.phase}: ${details.code}.`, details.reason,
    details.artifactId ? `artifactId: ${details.artifactId}` : undefined,
    details.imported !== undefined || details.selected !== undefined ? `Effects: imported=${String(details.imported)}, selected=${String(details.selected)}, activation=${String(details.activation ?? "not_requested")}.` : undefined,
    `Next: ${details.nextAction}.`, details.recovery ? `Recovery: ${String(details.recovery)}` : undefined,
    ...(logs ?? []).map((log) => `${log.phase}: ${log.command} ${log.args.join(" ")}${log.exitCode === undefined ? " (exit status unavailable)" : ` (exit ${log.exitCode})`}\nstdout${log.truncated ? " (bounded tail; truncated)" : ""}:\n${log.stdout}\nstderr${log.truncated ? " (bounded tail; truncated)" : ""}:\n${log.stderr}`),
  ].filter(Boolean).join("\n");
  return { content: [{ type: "text" as const, text }], details };
}
export function registerDockerfilePhaseTools(pi: ExtensionAPI, control: MsbControl, execution?: SessionExecutionContext): void {
  for (const load of [false, true]) pi.registerTool({
    name: load ? "msb_dockerfile_load" : "msb_dockerfile_build",
    label: load ? "Load Microsandbox Dockerfile artifact" : "Build Microsandbox Dockerfile artifact",
    description: load
      ? "Explicitly import/select the exact successful artifactId from msb_dockerfile_build, then guarded settings reload under existing Off/autoStart policy. Never builds. Separate default-No approval binds source, artifact, policy and session. Changed source/artifact fails closed. Import/activation failures retain artifact for load retry; partial import/selection is reported. Shadowed sources remain shadowed; never changes image/config intent. Restart may lose guest-local state."
      : "Autonomously build/export current host-owned Project/Global Dockerfile/context in an isolated builder, including headless/print sessions. No approval dialog or interactive UI is required. Returns verified reusable artifactId, command stdout/stderr/actual exit status. Never imports, selects, reloads or restarts runtime. Public build egress may exfiltrate build inputs; no host secrets/mounts. Cache hit verifies artifact without building. After success inspect logs/artifactId, then explicitly call msb_dockerfile_load with its separate default-No approval. Failed builds preserve source and previously loaded/running image.",
    parameters: Type.Object({ scope: Type.Union([Type.Literal("project"), Type.Literal("global")]), ...(load ? { artifactId: Type.String({ pattern: "^[a-f0-9]{64}$" }) } : {}) }, { additionalProperties: false, description: load ? "Explicit artifact load requires interactive default-No approval." : "Autonomous build/export; no interactive approval or UI required." }),
    executionMode: "sequential",
    renderCall() { return new Text(load ? "Microsandbox artifact load" : "Microsandbox artifact build", 0, 0); },
    renderResult(output, { expanded }) {
      const details = output.details as Record<string, unknown> | undefined;
      const summary = `Dockerfile ${String(details?.phase ?? "unknown")}: ${String(details?.code ?? "UNAVAILABLE")}${details?.artifactId ? ` · artifactId: ${String(details.artifactId)}` : ""}.`;
      const text = expanded ? output.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : summary;
      return new Text(terminalText(text || summary), 0, 0);
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      let phase = "input";
      let release: (() => void) | undefined;
      let imported: boolean | "unknown" = false;
      let selected = false;
      let artifactId: string | undefined;
      let operationSignal: AbortSignal | undefined;
      try {
        let input = params as Record<string, unknown>;
        if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.scope !== "string" || !["project", "global"].includes(input.scope)
          || Reflect.ownKeys(input).some((key) => (typeof key !== "string" || !["scope", ...(load ? ["artifactId"] : [])].includes(key)))
          || load && (typeof input.artifactId !== "string" || !/^[a-f0-9]{64}$/.test(input.artifactId))) throw new Error("Supply scope project/global and, for load only, the exact artifactId returned by build");
        input = structuredClone(input);
        artifactId = load ? input.artifactId as string : undefined;
        phase = load ? "approval" : "validation";
        const lease = control.settings?.acquireInteraction();
        if (!lease) {
          if (load) throw new Error("Settings interaction unavailable or another review is open");
          throw Object.assign(new Error("Build interaction busy or unavailable; retry msb_dockerfile_build after the current operation completes"), { code: "BUILD_BUSY" });
        }
        release = lease.release;
        const abort = AbortSignal.any([lease.signal, ...(signal ? [signal] : [])]);
        operationSignal = abort;
        const current = execution?.current();
        const caller = session(ctx);
        const check = () => {
          abort.throwIfAborted();
          if (execution?.current() !== current || session(ctx) !== caller || current && caller !== JSON.stringify([current.sessionId, current.cwd])) throw new Error(load ? "Workspace/session changed; request fresh approval" : "Workspace/session changed; inspect and reinvoke msb_dockerfile_build");
        };
        check(); phase = "validation";
        const draft = await control.openDockerfile?.(input.scope as "project" | "global");
        if (!draft || !draft.source.exists) throw Object.assign(new Error("Source missing: restore it with msb_dockerfile_write before build/load; previous loaded selection is unchanged"), { code: "SOURCE_MISSING" });
        if (draft.source.reason) throw new Error(draft.source.reason);
        const partial = { dockerfile: draft.target.dockerfile, agentRoot: draft.paths.canonicalAgentDir, agentAlias: draft.paths.agentDir };
        const snapshot = await snapshotDockerfile(partial, DEFAULT_CONFIG.image);
        const source: DockerfileSource = { ...partial, cacheDir: join(partial.agentRoot, "pi-microsandbox", "build-cache"), scope: input.scope === "project" ? "host-project" : "host-default", identity: snapshot.identity, platform: snapshot.platform };
        const candidate = load ? await readArtifact(source, artifactId!) : undefined;
        let store: Awaited<ReturnType<typeof artifactStore>> | undefined;
        try { store = await artifactStore(source); }
        catch (error) { if (load || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const assertCache = async () => {
          if (store) { await store.check(); return; }
          try { await fs.lstat(source.cacheDir); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
          throw new Error(load ? "Artifact directory appeared after review; request fresh approval" : "Artifact directory appeared during build request; inspect and retry msb_dockerfile_build");
        };
        const selectionVersion = async () => {
          try { return (await store!.read(selectionPath(source))).version; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
        };
        const originalSelection = load ? await selectionVersion() : undefined;
        let assertSelected: (() => Promise<void>) | undefined;
        const runtime = JSON.stringify([control.getEffectiveConfig(), control.getState(), control.getAgentRuntimePolicy?.()]);
        let activating = false;
        const guard = async () => {
          check();
          try { await draft.assertUnchanged(); }
          catch (error) { if (!load && error instanceof SettingsConflictError) throw new Error(buildConflictGuidance); throw error; }
          await assertCache(); check();
          const now = await snapshotDockerfile(partial, DEFAULT_CONFIG.image);
          if (now.identity !== source.identity || now.platform !== source.platform) throw new Error(load ? "Source changed after approval; build the current source explicitly" : "Source changed during build request; inspect and reinvoke msb_dockerfile_build");
          await candidate?.assertUnchanged();
          if (assertSelected) await assertSelected();
          else if (load && await selectionVersion() !== originalSelection) throw new Error("Loaded selection changed after approval");
          if (!activating && JSON.stringify([control.getEffectiveConfig(), control.getState(), control.getAgentRuntimePolicy?.()]) !== runtime) throw new Error(load ? "Runtime/policy changed; request fresh approval" : "Runtime/policy changed during build request; inspect and retry msb_dockerfile_build");
          check();
        };
        await guard();
        if (load) {
          phase = "approval";
          if (!ctx.hasUI || !["tui", "rpc"].includes(ctx.mode)) throw new Error("Explicit interactive TUI/RPC approval required");
          const approved = await approveDockerfileLoad(ctx, input.scope as "project" | "global", abort);
          if (!approved || abort.aborted) return report({ success: false, code: "APPROVAL_CANCELLED", phase, nextAction: "msb_dockerfile_load", imported, selected, artifactId, reason: "No import/activation authorized." });
          phase = "validation";
          await guard();
        }
        if (!load) {
          if (!store) {
            phase = "storage";
            await fs.mkdir(source.cacheDir, { mode: 0o700 });
            store = await artifactStore(source);
          }
          phase = "build";
          if (!control.buildDockerfile) throw new Error("Build backend unavailable");
          const built = await control.buildDockerfile({ source, signal: abort, guard });
          await guard();
          return report({ success: true, code: "ARTIFACT_BUILT", phase: "export", nextAction: "msb_dockerfile_load", artifactId: built.artifact.artifactId, artifact: built.artifact, cacheHit: built.cacheHit, logs: built.logs, imported: false, selected: false, reason: "Verified artifact retained. Runtime and image selection unchanged." });
        }
        phase = "import";
        if (!control.loadDockerfile) throw new Error("Load backend unavailable");
        const loaded = await control.loadDockerfile({ source, artifactId: artifactId!, expectedSelectionVersion: originalSelection!,
          onSelectionPublished(proof) { assertSelected = proof; }, signal: abort, guard });
        imported = true; selected = true; assertSelected = loaded.assertSelected;
        await guard();
        phase = "activation"; activating = true;
        await control.reload({ allowRestart: true, signal: abort, guard });
        await guard();
        const desired = control.getEffectiveConfig();
        const state = control.getState();
        const active = state.status === "active" && desired.config.image === loaded.artifact.reference && control.getAgentRuntimePolicy?.()?.settings.image === loaded.artifact.reference;
        return report({ success: true, code: "ARTIFACT_LOADED", phase, nextAction: "none", imported, selected, artifactId, digest: loaded.digest, activation: active ? "active" : desired.imageBuild?.dockerfile !== source.dockerfile ? "shadowed" : "deferred_or_unverified", reason: "Imported and selected for this source. Existing scope precedence and Off/autoStart policy preserved." });
      } catch (error) {
        const failure = error instanceof ImagePhaseError ? error : undefined;
        phase = failure?.phase ?? phase;
        const explicitCode = (error as { code?: string })?.code;
        const code = !load && operationSignal?.aborted ? "BUILD_CANCELLED" : !load && explicitCode === "BUILD_BUSY" ? "BUILD_BUSY" : ["SOURCE_MISSING", "STALE_SOURCE"].includes(explicitCode ?? "") ? explicitCode : phase === "input" ? "INVALID_INPUT" : phase === "approval" ? "APPROVAL_FAILED" : phase === "validation" ? "VALIDATION_FAILED" : phase === "build" ? "BUILD_FAILED" : phase === "export" ? "EXPORT_FAILED" : phase === "import" ? "IMPORT_FAILED" : phase === "storage" ? "STORAGE_FAILED" : phase === "selection" ? "SELECTION_FAILED" : phase === "cleanup" ? "CLEANUP_FAILED" : "ACTIVATION_FAILED";
        return report({ success: false, code, phase, nextAction: code === "BUILD_BUSY" || code === "BUILD_CANCELLED" ? "msb_dockerfile_build" : phase === "validation" ? "msb_dockerfile_get" : load ? "msb_dockerfile_load" : "msb_dockerfile_build", reason: !load && error instanceof SettingsConflictError ? buildConflictGuidance : error instanceof Error ? error.message : String(error), logs: failure?.logs ?? [], imported: failure?.imported ?? imported, selected: failure?.selected ?? selected, artifactId, activation: phase === "activation" ? "partial_or_unverified" : "not_requested", recovery: load ? "Artifact retained; inspect source/artifact/policy conflict, then retry load without rebuilding unless source changed. No host fallback." : "Written source and prior loaded/running image preserved. Repair via write if needed, then retry build. No load attempted." });
      } finally { release?.(); }
    },
  });
}
