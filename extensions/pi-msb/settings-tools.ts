import { approveSettings } from "./settings-approval.ts";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HOST_BOUNDARY_WARNINGS } from "./control-panel.ts";
import { COLLECTION_REMOVALS, SETTINGS_PATHS, SettingsConflictError, type SettingsDraft } from "./settings.ts";
import type { Config, MsbControl } from "./types.ts";

type Request = { scope: "ephemeral" | "project" | "global"; path: string; operation: "set" | "inherit" | "upsert" | "remove"; value?: unknown; identity?: string; previousIdentity?: string };
const parameters = Type.Object({
  scope: Type.Union([Type.Literal("ephemeral"), Type.Literal("project"), Type.Literal("global")]),
  path: Type.String({ enum: [...SETTINGS_PATHS], description: "One supported snake_case setting leaf. No indexed paths or file paths." }),
  operation: Type.Union([Type.Literal("set"), Type.Literal("inherit"), Type.Literal("upsert"), Type.Literal("remove")]),
  value: Type.Optional(Type.Unknown({ description: "set: complete value (arrays replace/clear). upsert: one native Config entry (camelCase keys), or one list string. Omit secret.value to retain its credential." })),
  identity: Type.Optional(Type.String({ description: "remove only: secret env, normalized mount guest path, or exact list string." })),
  previousIdentity: Type.Optional(Type.String({ description: "upsert only: existing identity when renaming." })),
}, { additionalProperties: false });

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
function entry(value: unknown, path: string, retainSecret: boolean): void {
  if (path !== "secrets" && path !== "mounts") { if (typeof value !== "string") throw new Error(); return; }
  if (!object(value)) throw new Error();
  const allowed = path === "secrets" ? ["env", "allowHosts", "value"] : ["type", "hostPath", "guestPath", "readonly", "options"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error();
  if (path === "secrets") {
    if (typeof value.env !== "string" || !stringList(value.allowHosts) || (!retainSecret || "value" in value) && typeof value.value !== "string") throw new Error();
    if (typeof value.value === "string" && /<redacted>|\[redacted\]/i.test(value.value)) throw new Error();
  } else {
    if (!["dir", "file", "named", "tmpfs"].includes(String(value.type)) || typeof value.guestPath !== "string" || typeof value.readonly !== "boolean" || !stringList(value.options)) throw new Error();
    if ("hostPath" in value && typeof value.hostPath !== "string") throw new Error();
  }
}
/** Validate inside execute: later tool_call hooks may have changed schema-validated inputs. */
function request(input: unknown): Request {
  if (!object(input) || Object.keys(input).some((key) => !["scope", "path", "operation", "value", "identity", "previousIdentity"].includes(key))) throw new Error();
  if (!["ephemeral", "project", "global"].includes(String(input.scope)) || typeof input.path !== "string" || !SETTINGS_PATHS.includes(input.path)) throw new Error();
  const op = input.operation;
  if (!["set", "inherit", "upsert", "remove"].includes(String(op))) throw new Error();
  if ((op === "set" || op === "upsert") !== ("value" in input) || input.value === undefined && "value" in input) throw new Error();
  if (op === "remove" ? typeof input.identity !== "string" : "identity" in input) throw new Error();
  if ("previousIdentity" in input && (op !== "upsert" || typeof input.previousIdentity !== "string")) throw new Error();
  if (op === "upsert" || op === "remove") {
    if (!COLLECTION_REMOVALS[input.path]) throw new Error();
    if (op === "upsert") entry(input.value, input.path, true);
  }
  if (op === "set") {
    if (COLLECTION_REMOVALS[input.path]) {
      if (!Array.isArray(input.value)) throw new Error();
      input.value.forEach((value) => entry(value, input.path as string, false));
    } else {
      // The backend validates ranges/enums and sparse target values, including shadowed ones.
      if (object(input.value) || Array.isArray(input.value)) throw new Error();
    }
    if (input.path === "sandbox_name" && input.value === null && input.scope !== "ephemeral") throw new Error();
  }
  return structuredClone(input) as Request;
}
function mutate(draft: SettingsDraft, input: Request): void {
  if (input.operation === "set") draft.set(input.path, input.value);
  else if (input.operation === "inherit") draft.inherit(input.path);
  else if (input.operation === "remove") {
    if (input.path === "secrets") draft.removeSecret(input.identity!);
    else if (input.path === "mounts") draft.removeMount(input.identity!);
    else draft.removeListEntry(input.path, input.identity!);
  } else {
    if (input.path === "secrets") draft.upsertSecret(input.value as Config["secrets"][number], input.previousIdentity);
    else if (input.path === "mounts") draft.upsertMount(input.value as Config["mounts"][number], input.previousIdentity);
    else draft.upsertListEntry(input.path, input.value as string, input.previousIdentity);
  }
}
function result(details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}
function runtime(control: MsbControl) {
  return {
    status: control.getState().status,
    adopted: control.getAgentRuntimePolicy?.() ?? null,
    note: "Only agent-safe known adopted fields are shown; unavailable safe snapshots mean adopted values are unknown. Desired settings and raw scope intent are separate. Off/unavailable does not imply adopted VM state.",
  };
}
function session(ctx: ExtensionContext): string { return JSON.stringify([ctx.sessionManager.getSessionId(), ctx.cwd]); }

export function registerConfigTools(pi: ExtensionAPI, control: MsbControl): void {
  pi.registerTool({
    name: "msb_config_get", label: "Inspect Microsandbox settings",
    description: "Read all desired settings, sparse global/project/ephemeral layers, provenance, warnings and known adopted runtime state as JSON. Secrets and credential references are masked. No writes, bootstrap, sandbox start or reload; works headlessly.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, params) {
      try {
        if (Object.keys(params).length) return result({ outcome: "rejected", reason: "This inspection accepts no arguments." });
        return result({ outcome: "inspected", ...await control.settings!.inspect(runtime(control), [control.getEffectiveConfig().config]) });
      } catch { return result({ outcome: "rejected", reason: "Settings unavailable or invalid. No configuration or runtime changes were made." }); }
    },
  });
  pi.registerTool({
    name: "msb_config_set", label: "Propose Microsandbox setting",
    description: "Propose ONE setting operation in ONE explicit scope. Every invocation requires fresh, cancel-first user approval. No headless mutation. Arrays set replaces/clears the whole list; prefer native upsert/remove to preserve siblings and credentials. Ephemeral lasts only this session. No lifecycle/reset/file-path overrides.",
    parameters, executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      let draft: SettingsDraft | undefined;
      let release: (() => void) | undefined;
      let phase: "validate" | "review" | "commit" | "reload" = "validate";
      let saved = false;
      try {
        const input = request(params);
        if (!ctx.hasUI || !["tui", "rpc"].includes(ctx.mode)) return result({ outcome: "rejected", reason: "Configuration changes require explicit user approval in an interactive TUI or RPC UI." });
        if (signal?.aborted) return result({ outcome: "cancelled" });
        const editor = control.settings!;
        const lease = editor.acquireInteraction();
        if (!lease) return result({ outcome: "rejected", reason: "Another settings panel or review is open. Retry as a new invocation after it closes." });
        release = lease.release;
        const abort = AbortSignal.any([lease.signal, ...(signal ? [signal] : [])]);
        const identity = session(ctx);
        const runtimeBefore = JSON.stringify(runtime(control));
        const check = () => {
          if (abort.aborted || identity !== session(ctx)) throw new SettingsConflictError();
          if (runtimeBefore !== JSON.stringify(runtime(control))) throw new SettingsConflictError();
        };
        draft = await editor.open(input.scope === "ephemeral" ? "temporary" : input.scope);
        mutate(draft, input);
        const preview = await (control.previewSettings?.(draft) ?? draft.preview());
        const review = await draft.reviewForApproval(preview.effect, runtime(control));
        check();
        const title = [
          "Approve ONE Microsandbox configuration change?",
          `Scope: ${input.scope}. Setting: ${input.path}. Operation: ${input.operation}.`,
          input.scope === "ephemeral" ? "Memory only until session/workspace identity changes; no disk write." : "Persist host-owned defaults for this scope; reload only this session. Other sessions pick up on their next start/reload.",
          "HOST boundary reminders below describe consequences WHEN configured, not changes to every listed field:",
          ...Object.values(HOST_BOUNDARY_WARNINGS),
          "Host bypass, network, mount and environment settings can widen access. Existing host-execution permission does NOT approve configuration changes.",
          preview.effect === "restart" ? "RESTART authorized by approval: guest ephemeral state and nested containers may be lost." : `Runtime effect: ${preview.effect}. No guest recreation authorized.`,
          "Approved reload may start an inactive sandbox when desired auto_start=true; active guest recreation requires the restart approval above.",
          "set on an array REPLACES/CLEARS that scope's entire list. remove/inherit can be destructive. Collections show origins, promotion and shadowing. Before/after below are desired, not adopted VM state.",
          JSON.stringify(review, null, 2),
        ].join("\n");
        // Refuse oversized proposals instead of hiding affected values from approval.
        if (title.length > 48_000) return result({ outcome: "rejected", reason: "Review too large. Use a smaller per-entry operation." });
        phase = "review";
        const approved = await approveSettings(ctx, title, abort);
        if (!approved || abort.aborted) return result({ outcome: "cancelled" });
        check();
        phase = "commit";
        const applied = await draft.apply({ guard: check });
        saved = applied.saved;
        if (!saved) return result({ outcome: "no_op", saved: false, reloaded: false, review });
        phase = "reload";
        await control.reload({ allowRestart: preview.effect === "restart", guard: async () => { check(); await applied.assertUnchanged?.(); check(); } });
        return result({ outcome: "applied", saved: true, reloaded: true, runtimeStatus: control.getState().status, review });
      } catch (error) {
        if (phase === "reload") return result({ outcome: "saved_but_reload_failed", saved, reloaded: false, reason: "Settings were saved but not fully activated. Inspect settings/runtime and request a new approved change or use /msb to reload." });
        if (signal?.aborted) return result({ outcome: "cancelled" });
        if (error instanceof SettingsConflictError) return result({ outcome: "conflict", saved: false, reloaded: false, reason: "Sources, ephemeral settings, session or runtime changed. Request a fresh review; nothing was retried." });
        return result({ outcome: phase === "commit" ? "apply_failed" : "rejected", saved: phase === "commit" ? "unknown" : false, reloaded: false,
          reason: phase === "commit" ? "Persistence failed; storage may have changed after an I/O error. Inspect before retrying. Runtime was not reloaded." : "Invalid or unavailable settings proposal. Check setting, scope, value shape, credential references and mount safety. Nothing applied." });
      } finally { draft?.discard(); release?.(); }
    },
  });
}
