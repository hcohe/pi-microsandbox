import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SettingsConflictError } from "./settings-conflict.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { BUILD_LIMITS } from "./image-source.ts";
import { BundlePersistenceError, DOCKERFILE_MAX_BYTES, validDockerfileText, type DockerfileScope, type DockerfileDestination, type DockerfileDraft } from "./dockerfile-storage.ts";
import { CONTEXT_LIMITS, validateContextEdits, validContextPath, type ContextEdit } from "./build-context-storage.ts";
import { approveDockerfileReview, dockerfileDisplay, unifiedDockerfileDiff, type DockerfileReviewCandidate } from "./dockerfile-review.ts";
import type { MsbControl, SessionExecutionContext } from "./types.ts";

const scopeSchema = Type.Union([Type.Literal("project"), Type.Literal("global")]);
const starter = () => `FROM ${DEFAULT_CONFIG.image}\n`;
const minimalEditGuidance = "Make the smallest Dockerfile edit needed, using minimal instructions. Do not add comments or explanatory boilerplate; put explanations and scope recommendations in the normal response, not the file. Preserve unrelated existing content and functional parser directives. New Dockerfiles start FROM the bundled digest pin.";
const warnings = [
  "Dockerfile, requested context text and full diff are returned to the model and may appear in the transcript. NEVER embed credentials or secrets.",
  "Approval authorizes saving this exact scope/path/content AND settings reload, build execution and possible VM start/restart. Restart can lose guest-local state.",
  "Dockerfile build instructions (including scripts they run) execute in the disposable builder VM. Copied inputs may also run inside the resulting sandbox VM, never as host commands. Builds can download over PUBLIC egress independently of runtime network deny; no host credentials, runtime secrets or mounts are supplied. Public egress can exfiltrate build inputs.",
  "Project at supported checkout roots offers shared Repository or this Worktree; nested/nonGit/unsupported cwd stays cwd-local. Shared registration adds only immutable host-owned repository metadata, never image/user intent. No existing Dockerfile/context is copied. Worktree overrides shared Project, which overrides Global; explicit image at a scope wins over that scope's Dockerfile. Session image can shadow it. Only reviewed repository registration can edit config metadata; this tool never changes image intent. Inspect msb_config_get; propose image inherit via msb_config_set separately with its own approval if needed.",
];
const guidance = () => ({
  baseImage: DEFAULT_CONFIG.image, minimalDockerfile: starter(),
  warnings, editing: minimalEditGuidance,
  selection: "No activation is inferred from file existence. Use msb_config_get for effective image intent/source; generated local image references must not be persisted. Saving a shadowed Dockerfile does not select it.",
  context: "Only the selected scope's optional build-context/ contents are COPY root, never the policy tree or repository. Use context PATCH entries {path,content,executable?} for bounded relative UTF-8 text edits; null deletes one file, unspecified files (including binary) are preserved. .dockerignore and nested executable scripts are supported. Use exact inventory spelling: case-folded/canonically Unicode-normalized aliases of files or ancestor directories (including between proposals) are rejected even on case-sensitive hosts; root Dockerfile aliases are reserved. Getter contextPaths explicitly requests text; inventory never reads unrequested file contents. No arbitrary host paths, mounts, secrets or user config intent changes. build-context/Dockerfile, symlinks, hardlinks and special files are rejected by the builder. The selected agent root symlink is supported; descendants cannot be symlinks.",
  limits: { dockerfileUtf8Bytes: DOCKERFILE_MAX_BYTES, build: BUILD_LIMITS, context: CONTEXT_LIMITS, text: "Valid UTF-8 without control/format characters except tab, CR and LF. Oversized/binary files are not returned or overwritten; no silent truncation." },
  lifecycle: "Getter is passive: no writes, approval, SDK, commands, build, VM start or reload. Setter requires per-proposal No-first UI approval, stages outside COPY root, atomically replaces each changed file (NOT jointly/crash atomic), then requests guarded settings reload respecting Off/autoStart. Build/import failures do not undo a saved file and never grant host fallback. Partial/unknown multi-artifact persistence never reloads; external replacements are retained. Unchanged bundle is a no-op; unchanged build inputs reuse the validated local never-pull cache. Mtime alone does not rebuild.",
  imageContract: "Use the bundled published digest pin above, NOT effective config.image. Keep required guest commands in the final image; Docker is optional unless docker.mode=require.",
});
// Escape untrusted display strings, including terminal/bidi controls in host-selected paths.
const display = (value: unknown) => JSON.stringify(value).replace(/[\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => char.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
function result(details: Record<string, unknown>) {
  const review = details.review as Record<string, unknown> | undefined;
  const text = details.readOnly ? display(details) : [
    `Dockerfile: ${String(details.outcome)} · ${details.saved === true ? "SAVED" : details.saved === "unknown" ? "SAVE UNCONFIRMED" : "not saved"} · ${details.reloaded ? "settings reloaded (activation separate)" : "not reloaded"}.`,
    review?.destinationLabel ? `Destination: ${String(review.destinationLabel)}.` : undefined,
    details.reason, details.activation ? `Activation: ${String((details.activation as Record<string, unknown>).status)}.` : undefined,
    details.persistedArtifacts ? `Confirmed publications: ${display(details.persistedArtifacts)}; uncertain: ${display(details.uncertainArtifact ?? null)}.` : undefined,
  ].filter(Boolean).join("\n");
  if (Buffer.byteLength(text) > 256 * 1024) return { content: [{ type: "text" as const, text: "Dockerfile/context report exceeds 256 KiB; inventory and requested contents are not returned or silently truncated. No activation inferred." }], details: { outcome: details.readOnly ? "unavailable" : details.outcome, saved: details.saved, reloaded: details.reloaded, inventoryComplete: false, persistedArtifacts: details.persistedArtifacts, uncertainArtifact: details.uncertainArtifact, target: details.target ?? (details.review as Record<string, unknown> | undefined)?.target, reason: "Complete report exceeds bounded output limit; inventory/contents omitted, not truncated. Use a human host editor for this large source inventory." } };
  return { content: [{ type: "text" as const, text }], details };
}
function request(params: unknown, set: boolean): { scope: DockerfileScope; content?: string; context?: ContextEdit[]; contextPaths?: string[]; destination?: DockerfileDestination } {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error();
  const input = params as Record<string, unknown>;
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !["scope", ...(set ? ["content", "context"] : ["contextPaths", "destination"])].includes(key))
    || typeof input.scope !== "string" || !["project", "global"].includes(input.scope)) throw new Error();
  if (set) {
    if (input.content === undefined && (!Array.isArray(input.context) || !input.context.length)) throw new Error();
    if ("content" in input && (typeof input.content !== "string" || !validDockerfileText(input.content))) throw new Error();
    if ("context" in input) {
      if (!Array.isArray(input.context) || input.context.some((edit) => !edit || typeof edit !== "object" || Array.isArray(edit)
        || Reflect.ownKeys(edit).some((key) => !["path", "content", "executable"].includes(String(key)))
        || typeof edit.path !== "string" || !("content" in edit))) throw new Error();
      validateContextEdits(input.context as ContextEdit[]);
    }
  } else {
    if ("destination" in input && (input.scope !== "project" || typeof input.destination !== "string" || !["repository", "worktree"].includes(input.destination))) throw new Error();
    if ("contextPaths" in input && (!Array.isArray(input.contextPaths) || input.contextPaths.length > CONTEXT_LIMITS.files
      || new Set(input.contextPaths).size !== input.contextPaths.length || !input.contextPaths.every((path) => typeof path === "string" && validContextPath(path)))) throw new Error();
  }
  return structuredClone(input) as ReturnType<typeof request>;
}
function selection(control: MsbControl, path: string) {
  try {
    const desired = control.getEffectiveConfig();
    const selected = desired.imageBuild?.dockerfile === path;
    const status = control.getState().status;
    const adopted = control.getAgentRuntimePolicy?.();
    const active = selected && status === "active" && adopted?.knownFields.includes("image") && adopted.settings.image === desired.config.image;
    return { selected, active: !!active, runtimeStatus: status, evidence: "Last-known desired/adopted state, not a fresh source inspection.",
      status: !selected ? "shadowed_or_not_selected" : active ? "active" : ["off", "disabled"].includes(status) ? "deferred" : "activation_unverified" };
  } catch { return { selected: false, active: false, status: "unknown" }; }
}
const session = (ctx: ExtensionContext) => JSON.stringify([ctx.sessionManager.getSessionId(), ctx.cwd]);

export function registerDockerfileTools(pi: ExtensionAPI, control: MsbControl, execution?: SessionExecutionContext): void {
  for (const set of [false, true]) pi.registerTool({
    name: set ? "msb_dockerfile_set" : "msb_dockerfile_get",
    label: set ? "Propose Microsandbox Dockerfile" : "Read Microsandbox Dockerfile",
    description: set
      ? "Propose Dockerfile replacement and/or relative UTF-8 build-context PATCH in Project or Global. Project combines the named config Repository/Worktree destination choice and candidate diff in ONE default-No approval at supported checkout roots; no copying between scopes. Fixed host-owned source roots only; no host execution permission needed. Explicit per-proposal No-first user review shows complete added/removed code above scope choices; d details hold full unified context, exact paths and all warnings. Approval authorizes save and possible build/restart. Before save, no UI/denial/cancellation/stale source means no write or reload. Cancellation after save preserves bytes but blocks activation. Unchanged is a no-op. Saves never edit image/config intent: inspect get/config_get for shadowing; inherit image separately. Never embed secrets: content/diff may enter transcript. Report SAVED separately from activation. " + minimalEditGuidance
      : "Read Project repository target (default; optional destination worktree) or Global host-owned Dockerfile and bounded build-context inventory/requested text plus exact config/context paths, bundled digest-pinned FROM starter, precedence, limits and build guidance. Passive even Off/blocked with canonical workspace known: no writes, SDK, commands, approval, build or reload. UTF-8 content up to 32 KiB, never truncated; unsafe/oversized sources return bounded metadata/reason. Content is intentionally returned to the model: no embedded credentials/secrets. " + minimalEditGuidance,
    parameters: Type.Object({ scope: scopeSchema, ...(set ? {
      content: Type.Optional(Type.String({ maxLength: DOCKERFILE_MAX_BYTES, description: "Optional complete Dockerfile replacement; at most 32768 UTF-8 bytes. Omit for context-only edits. " + minimalEditGuidance })),
      context: Type.Optional(Type.Array(Type.Object({ path: Type.String(), content: Type.Union([Type.String({ maxLength: CONTEXT_LIMITS.fileBytes }), Type.Null()]), executable: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), { maxItems: CONTEXT_LIMITS.files, description: "PATCH of relative build-context text files, not replacement of the tree. null deletes one file; unspecified files are preserved. 32KiB/file, 64KiB total; no secrets." })),
    } : {
      destination: Type.Optional(Type.Union([Type.Literal("repository"), Type.Literal("worktree")], { description: "Project reads default to repository target, matching config project; worktree explicitly reads this checkout override. Not accepted by setter: human chooses." })),
      contextPaths: Type.Optional(Type.Array(Type.String(), { maxItems: CONTEXT_LIMITS.files, description: "Only these relative context files are read as UTF-8 (32KiB/file, 64KiB total). Inventory metadata reads no file contents." })),
    }) }, { additionalProperties: false }),
    ...(set ? { executionMode: "sequential" as const } : {}),
    renderCall() { return new Text(set ? "Microsandbox Dockerfile proposal" : "Microsandbox Dockerfile inspection", 0, 0); },
    renderResult(output) {
      const details = output.details as Record<string, unknown>;
      return new Text(`Dockerfile: ${String(details?.outcome ?? "unavailable")}${details?.saved === true ? " · SAVED" : details?.saved === "unknown" ? " · SAVE UNCONFIRMED" : ""}. See tool content for source/activation details.`, 0, 0);
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      let input;
      try { input = request(params, set); }
      catch { return result({ outcome: "rejected", saved: false, reloaded: false, reason: "Supply scope project/global. Set accepts optional content and/or context PATCH (1–16 relative UTF-8 files, 32KiB/file, 64KiB total); get accepts optional destination (project only) and contextPaths. No arbitrary host paths, duplicate/overlapping paths, controls or binary content." }); }
      let release: (() => void) | undefined;
      let saved = false;
      let phase: "open" | "review" | "save" | "reload" = "open";
      let review: Record<string, unknown> | undefined;
      try {
        const caller = ctx ? session(ctx) : undefined;
        const current = execution?.current();
        const check = () => {
          if (signal?.aborted || execution?.current() !== current || ctx && session(ctx) !== caller
            || current && caller !== undefined && caller !== JSON.stringify([current.sessionId, current.cwd])) throw new SettingsConflictError();
        };
        check();
        if (set) {
          const lease = control.settings?.acquireInteraction();
          if (!lease) return result({ outcome: "rejected", saved: false, reloaded: false, reason: "Settings interaction unavailable or another review is open." });
          release = lease.release;
          const outerCheck = check;
          // Lease cancellation covers session changes even for adapters without execution context.
          const draftCheck = () => { outerCheck(); if (lease.signal.aborted) throw new SettingsConflictError(); };
          draftCheck();
          const runtimeBefore = JSON.stringify([control.getState(), control.getAgentRuntimePolicy?.()]);
          const names = input.scope === "project" ? await control.settings?.projectDestinations?.() : undefined;
          const stateBefore = names ? await control.settings!.reviewState() : undefined;
          const assertProjectReviewState = async () => {
            if (names && (await control.settings!.reviewState() !== stateBefore
              || JSON.stringify(await control.settings!.projectDestinations?.()) !== JSON.stringify(names))) throw new SettingsConflictError();
          };
          const destinations: Array<{ destination?: DockerfileDestination; label: string }> = names ? [
            { destination: "worktree", label: `This worktree — ${dockerfileDisplay(names.worktreeName)}` },
            { destination: "repository", label: `All worktrees — ${dockerfileDisplay(names.repositoryName)}` },
          ] : [{ label: "Apply" }];
          type Candidate = { draft: DockerfileDraft; review: Record<string, unknown>; changed: boolean };
          const candidates: Array<Candidate | undefined> = [];
          const views: DockerfileReviewCandidate[] = [];
          // Each target gets its OWN originals/context/registration. Never copy a baseline.
          for (const { destination, label } of destinations) {
            try {
              const draft = await control.openDockerfile?.(input.scope, destination);
              if (!draft) throw new Error("Unavailable backend");
              draftCheck();
              if (draft.source.reason) {
                if (!names) return result({ outcome: "rejected", saved: false, reloaded: false, reason: "Cannot review a complete original; human host repair required." });
                throw new Error("Original unavailable");
              }
              const bundle = await draft.prepare(input.content, input.context);
              const diff = input.content !== undefined && input.content !== draft.source.content
                ? unifiedDockerfileDiff({ path: "Dockerfile", before: draft.source.content, after: input.content, modeBefore: draft.source.mode ?? null, modeAfter: 0o600 }) : undefined;
              const context = bundle.context.map((edit) => ({ ...edit, diff: unifiedDockerfileDiff({ ...edit, path: `build-context/${edit.path}` }) }));
              const candidateReview = { scope: input.scope, destinationLabel: names ? label : input.scope === "global" ? "Global" : `Project · cwd-local (${dockerfileDisplay(basename(ctx.cwd))})`, destination: destination ?? input.scope, target: draft.target, path: draft.target.dockerfile,
                ...(diff ? { diff, dockerfileMode: { before: draft.source.mode ?? null, after: 0o600 } } : {}), context, registration: bundle.registration, warnings };
              candidates.push({ draft, review: candidateReview, changed: bundle.changed });
              views.push({ label, available: true, sections: [
                ...(!names ? [{ text: input.scope === "global" ? "Scope: Global" : `Scope: Project · cwd-local (${dockerfileDisplay(basename(ctx.cwd))})` }] : []),
                ...(diff ? [{ text: diff, dockerfile: true, source: { before: draft.source.content, after: input.content ?? null } }] : []), ...context.map((edit) => ({ text: edit.diff, diff: true })),
                ...(!bundle.changed ? [{ text: "No changes" }] : []),
              ], details: [
                ...(destination === "repository" ? ["Shared on next reload/start: current/future registered worktrees, subject to overrides."] : []),
                ...(bundle.registration ? ["Register immutable host-owned repository association in config.toml; preserve image/user intent and unknown keys. TOML formatting/comments may be rewritten."] : []),
                `Dockerfile: ${dockerfileDisplay(draft.target.dockerfile)}`, `Context: ${dockerfileDisplay(draft.target.buildContext)}`, `Config: ${dockerfileDisplay(draft.target.config)}`,
                ...(diff ? [`Dockerfile permissions: ${draft.source.mode === undefined ? "missing" : draft.source.mode.toString(8).padStart(4, "0")} → 0600`] : []),
                ...bundle.context.map((edit) => `build-context/${dockerfileDisplay(edit.path)} permissions: ${edit.modeBefore === null ? "missing" : edit.modeBefore.toString(8).padStart(4, "0")} → ${edit.modeAfter === null ? "deleted" : edit.modeAfter.toString(8).padStart(4, "0")}`),
                ...(bundle.registration ? [`Repository metadata: ${display(bundle.registration.metadata)}`] : []), ...warnings,
                "New directories are private (0700). Unspecified files stay unchanged. No activation after partial/unknown save."].join("\n") });
            } catch (error) {
              draftCheck();
              if (error instanceof SettingsConflictError || !names) throw error;
              candidates.push(undefined);
              views.push({ label, available: false, sections: [{ text: "UNAVAILABLE" }], details: "Cannot safely review this destination. No approval or writes here; inspect/repair with a human host editor. Originals unavailable; no target authorized." });
            }
          }
          draftCheck();
          if (candidates.every((candidate) => candidate && !candidate.changed)) return result({ outcome: "no_op", saved: false, reloaded: false, scope: input.scope });
          if (!candidates.some(Boolean)) throw new Error("No available target");
          if (!ctx?.hasUI || !["tui", "rpc"].includes(ctx.mode)) return result({ outcome: "rejected", saved: false, reloaded: false, reason: "Explicit approval in an interactive TUI or RPC UI is required; no changes made." });
          const guard = async () => { draftCheck(); if (phase !== "reload" && JSON.stringify([control.getState(), control.getAgentRuntimePolicy?.()]) !== runtimeBefore) throw new SettingsConflictError(); };
          await assertProjectReviewState();
          await guard();
          phase = "review";
          const abort = AbortSignal.any([lease.signal, ...(signal ? [signal] : [])]);
          const selected = await approveDockerfileReview(ctx, views, abort);
          if (selected === undefined || abort.aborted) return result({ outcome: "cancelled", saved: false, reloaded: false });
          const candidate = candidates[selected];
          if (!candidate) return result({ outcome: "cancelled", saved: false, reloaded: false });
          await guard();
          await assertProjectReviewState();
          const { draft } = candidate;
          review = candidate.review;
          if (!candidate.changed) return result({ outcome: "no_op", saved: false, reloaded: false, scope: input.scope, target: draft.target });
          phase = "save";
          const applied = await draft.save(input.content, guard);
          saved = true;
          phase = "reload";
          await control.reload({ allowRestart: true, signal: abort, guard: async () => { draftCheck(); await applied.assertUnchanged(); draftCheck(); } });
          draftCheck();
          await applied.assertUnchanged();
          draftCheck();
          const activation = selection(control, String(review.path));
          return result({ outcome: activation.active ? "applied" : activation.status === "shadowed_or_not_selected" ? "saved_shadowed" : "saved_deferred", saved: true, reloaded: true, activation, review, instruction: warnings[3] });
        }
        const draft = await control.openDockerfile?.(input.scope, input.destination);
        check();
        if (!draft) throw new Error("Unavailable backend");
        const { version: _version, ...source } = draft.source;
        const contextFiles = await draft.readContext(input.contextPaths ?? []);
        check();
        return result({ outcome: "inspected", readOnly: true, scope: input.scope, destination: input.scope === "global" ? "global" : input.destination === "worktree" ? "worktree" : draft.paths.worktree ? "repository" : "cwd_local", paths: draft.paths, target: draft.target, ...source,
          inventory: draft.context.map(({ version: _version, ...entry }) => entry), inventoryComplete: true, contextFiles, ...guidance(), lastKnownSelection: selection(control, draft.target.dockerfile) });
      } catch (error) {
        if (error instanceof BundlePersistenceError) return result({ outcome: "conflict", saved: "unknown", reloaded: false,
          persistedArtifacts: error.persisted, uncertainArtifact: error.uncertain, review,
          reason: "Partial or unknown multi-artifact persistence. Listed artifacts were individually confirmed at publication; inspect fresh because external replacements may exist. No reload/activation. No rollback or jointly/crash-atomic guarantee; unspecified files/external replacements retained." });
        if (phase === "reload" && control.getState().status === "off") return result({ outcome: "saved_deferred", saved, reloaded: false, review,
          activation: { active: false, status: "deferred_off" }, reason: "SAVED; activation deferred because sandbox is Off or disabled by the environment. No VM start/build/restart authorized beyond that safety boundary.", instruction: warnings[3] });
        if (phase === "reload") return result({ outcome: "saved_but_reload_failed", saved, reloaded: false, review, reason: "SAVED, but build/reload/activation failed or was superseded. No confirmed activation. Inspect msb_config_get/msb_diagnostics and use /msb to request reload; do not silently retry or use host fallback.", instruction: warnings[3] });
        return result({ outcome: signal?.aborted ? "cancelled" : phase === "open" ? "unavailable" : "conflict", saved: phase === "save" && !(error instanceof SettingsConflictError) ? "unknown" : false, reloaded: false,
          reason: "Unavailable/unsafe source, cancellation or changed file/path/workspace/session/runtime. No reload performed. Request a fresh inspection/review; raw host errors withheld." });
      } finally { release?.(); }
    },
  });
}
