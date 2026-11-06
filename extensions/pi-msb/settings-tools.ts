import { approveSettings } from "./settings-approval.ts";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatSettingsDiff, settingsDiff, settingsOutcome } from "./settings-diff.ts";
import { MAX_SETTINGS_OPERATIONS } from "./settings-schema.ts";
import { inspectSettings, inspectionParameters, inspectionRequest, inspectionResult, inspectionText, SETTINGS_SCHEMA_VERSION } from "./settings-inspection.ts";
import { diagnoseConfigError, operationProblem, SettingsValidationError, validationMessage } from "./settings-validation.ts";
import { COLLECTION_REMOVALS, SETTINGS_PATHS, SettingsConflictError, type SettingsDraft } from "./settings.ts";
import type { Config, MsbControl } from "./types.ts";

type Operation = { path: string; operation: "set" | "inherit" | "upsert" | "remove"; value?: unknown; identity?: string; previousIdentity?: string };
type Scope = "session" | "project" | "global";
type Request = { scope: Scope; operations: Operation[] };
const operationProperties = {
  path: Type.String({ enum: [...SETTINGS_PATHS], description: "Supported snake_case leaf. See msb_config_get.settingsSchema for value schemas, constraints and semantics." }),
  operation: Type.Union([Type.Literal("set"), Type.Literal("inherit"), Type.Literal("upsert"), Type.Literal("remove")]),
  value: Type.Optional(Type.Unknown({ description: "set: complete value (arrays replace/clear). upsert: one native Config entry (camelCase keys), or one list string. Omit secret.value to retain its credential." })),
  identity: Type.Optional(Type.String({ description: "remove only: secret env, normalized mount guest path, or exact list string." })),
  previousIdentity: Type.Optional(Type.String({ description: "upsert only: existing identity when renaming." })),
};
const parameters = Type.Object({
  scope: Type.Union([Type.Literal("session"), Type.Literal("project"), Type.Literal("global")]),
  ...Object.fromEntries(Object.entries(operationProperties).map(([key, value]) => [key, Type.Optional(value)])),
  operations: Type.Optional(Type.Array(Type.Object(operationProperties, { additionalProperties: false }), {
    minItems: 1, maxItems: MAX_SETTINGS_OPERATIONS,
    description: "Ordered operations in this ONE scope: one combined review, atomic settings commit and at most one reload. Mutually exclusive with top-level path/operation/value/identity/previousIdentity.",
  })),
}, { additionalProperties: false, anyOf: [
  { required: ["path", "operation"], not: { required: ["operations"] } },
  { required: ["operations"], not: { anyOf: Object.keys(operationProperties).map((key) => ({ required: [key] })) } },
] });

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
function operation(input: unknown, scope: Scope, index = 0): Operation {
  const fail = (code: string, expected?: string): never => { throw new SettingsValidationError([operationProblem(index, input, code, expected)]); };
  if (!object(input) || Object.keys(input).some((key) => !Object.keys(operationProperties).includes(key))) return fail("invalid_operation_shape");
  if (typeof input.path !== "string" || !SETTINGS_PATHS.includes(input.path)) return fail("unsupported_path", "Choose a supported snake_case leaf from msb_config_get; no indexed or file paths.");
  const op = input.operation;
  if (!["set", "inherit", "upsert", "remove"].includes(String(op))) fail("unsupported_operation", "Choose set, inherit, upsert or remove as advertised for this leaf.");
  if ((op === "set" || op === "upsert") !== ("value" in input) || input.value === undefined && "value" in input) fail("invalid_value_argument", "value is required only for set/upsert; omit it for inherit/remove.");
  if (op === "remove" ? typeof input.identity !== "string" : "identity" in input) fail("invalid_identity_argument", "identity is required only for remove: secret env, mount guest path or exact list string.");
  if ("previousIdentity" in input && (op !== "upsert" || typeof input.previousIdentity !== "string")) fail("invalid_previous_identity", "previousIdentity is an optional string for upsert renames only.");
  if (op === "upsert" || op === "remove") {
    if (!COLLECTION_REMOVALS[input.path]) fail("unsupported_collection_operation", "Only collection leaves support upsert/remove; scalar leaves support set/inherit.");
    if (op === "upsert") { try { entry(input.value, input.path, true); } catch { fail("invalid_entry"); } }
  }
  if (op === "set") {
    if (COLLECTION_REMOVALS[input.path]) {
      if (!Array.isArray(input.value)) fail("invalid_collection", "set replaces a collection with an array; [] explicitly clears it.");
      try { (input.value as unknown[]).forEach((value) => entry(value, input.path as string, false)); } catch { fail("invalid_entry"); }
    } else {
      // The backend validates ranges/enums and sparse target values, including shadowed ones.
      if (object(input.value) || Array.isArray(input.value)) fail("invalid_scalar", "Supply one scalar value matching this setting's valueSchema.");
    }
    if (input.path === "sandbox_name" && input.value === null && scope !== "session") fail("invalid_scope_value", "Automatic naming (null) is Session-only; use inherit in Project/Global.");
  }
  return structuredClone(input) as Operation;
}
function request(input: unknown): Request {
  const fail = (): never => { throw new SettingsValidationError([{ code: "invalid_request", operationIndex: null,
    expected: "One explicit scope (session/project/global) and either one top-level operation or an operations array of 1–64 entries, not both. No nested scopes or extra request fields." }]); };
  if (!object(input) || !["session", "project", "global"].includes(String(input.scope))) return fail();
  const scope = input.scope as Scope;
  if ("operations" in input) {
    if (Object.keys(input).some((key) => !["scope", "operations"].includes(key)) || !Array.isArray(input.operations)
      || !input.operations.length || input.operations.length > MAX_SETTINGS_OPERATIONS) fail();
    return { scope, operations: (input.operations as unknown[]).map((item, index) => operation(item, scope, index)) };
  }
  const { scope: _scope, ...single } = input;
  return { scope, operations: [operation(single, scope)] };
}
function mutate(draft: SettingsDraft, input: Operation): void {
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
function setterResult(details: Record<string, unknown>) {
  const lines = details.review ? formatSettingsDiff(settingsDiff(details.review as Record<string, unknown>)) : [];
  return { content: [{ type: "text" as const, text: [settingsOutcome(details), ...lines].join("\n") }], details };
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
    description: "Read-only settings discovery and inspection. Filter sections and setting paths; text is human-readable by default, json is indented, and structured details contain the selected JSON. Cache schemas with knownSchemaVersion. Includes session-reset warnings, desired versus known adoption, reconnection guidance and DNS/IP limitations. Secrets/references masked. No bootstrap/start/reload. Use instead of reading extension source/docs.",
    parameters: inspectionParameters,
    renderCall(_args, theme) { return new Text(theme.bold(theme.fg("accent", "Microsandbox settings")), 0, 0); },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("muted", "Inspecting settings…"), 0, 0);
      const details = result.details as Record<string, unknown> | undefined;
      if (context.isError || !details || !["inspected", "rejected"].includes(String(details.outcome))) return new Text(theme.fg("error", "Settings inspection failed; no changes made."), 0, 0);
      return new Text(inspectionText(details, "text", !expanded), 0, 0);
    },
    async execute(_id, params) {
      let input;
      try { input = inspectionRequest(params); }
      catch { return inspectionResult({ outcome: "rejected", schemaVersion: SETTINGS_SCHEMA_VERSION,
        reason: "Invalid inspection filters. Use supported sections, setting leaves or network/docker groups, format text/json, and an optional positive knownSchemaVersion. No configuration was read or changed." }); }
      let inspection;
      try { inspection = { outcome: "inspected", ...await control.settings!.inspect(runtime(control), [control.getEffectiveConfig().config]) }; }
      catch { inspection = { outcome: "rejected", reason: "Settings unavailable or invalid. No configuration or runtime changes were made." }; }
      return inspectionResult(inspectSettings(inspection, input), input.format, !input.explicitSections);
    },
  });
  pi.registerTool({
    name: "msb_config_set", label: "Propose Microsandbox setting",
    description: "Propose one setting operation OR an ordered operations array in ONE explicit scope. A batch uses one combined No-first approval, one atomic settings commit and at most one reload; no intermediate VM policy is adopted. Inspect msb_config_get for value schemas and policy semantics. No headless mutation. Array set replaces/clears the whole list; prefer upsert/remove to preserve siblings/credentials. Session is memory-only. No lifecycle/reset/file-path overrides. After completion, explain relevant returned safety/impact warnings to the user.",
    parameters, executionMode: "sequential",
    // Arguments may contain credentials or repeat them in arbitrary identity fields.
    // Until execute has produced a bound sanitized review, display no argument data.
    renderCall(_args, theme) {
      return new Text(theme.bold(theme.fg("accent", "Microsandbox setting")), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("muted", "Awaiting configuration outcome…"), 0, 0);
      const details = result.details as Record<string, unknown> | undefined;
      if (context.isError || !details || typeof details.outcome !== "string") return new Text(theme.fg("error", "Configuration tool failed · no confirmed activation. Request a fresh review."), 0, 0);
      const failed = !["applied", "no_op", "cancelled"].includes(details.outcome);
      const lines = details.review ? settingsDiff(details.review as Record<string, unknown>).filter((line) => line.kind !== "warning") : [];
      return new Text([
        theme.fg(failed ? "error" : "muted", settingsOutcome(details)),
        ...formatSettingsDiff(expanded ? lines : lines.slice(0, 2), theme),
      ].join("\n"), 0, 0);
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      let draft: SettingsDraft | undefined;
      let release: (() => void) | undefined;
      let phase: "validate" | "review" | "commit" | "reload" = "validate";
      let saved = false;
      let approvedReview: Record<string, unknown> | undefined;
      let input: Request | undefined;
      try {
        input = request(params);
        if (!ctx.hasUI || !["tui", "rpc"].includes(ctx.mode)) return setterResult({ outcome: "rejected", reason: "Configuration changes require explicit user approval in an interactive TUI or RPC UI." });
        if (signal?.aborted) return setterResult({ outcome: "cancelled" });
        const editor = control.settings!;
        const lease = editor.acquireInteraction();
        if (!lease) return setterResult({ outcome: "rejected", reason: "Another settings panel or review is open. Retry as a new invocation after it closes." });
        release = lease.release;
        const abort = AbortSignal.any([lease.signal, ...(signal ? [signal] : [])]);
        const identity = session(ctx);
        const runtimeBefore = JSON.stringify(runtime(control));
        const check = () => {
          if (abort.aborted || identity !== session(ctx)) throw new SettingsConflictError();
          if (runtimeBefore !== JSON.stringify(runtime(control))) throw new SettingsConflictError();
        };
        draft = await editor.open(input.scope === "session" ? "temporary" : input.scope);
        for (const [index, item] of input.operations.entries()) {
          try { mutate(draft, item); }
          catch (error) {
            if (diagnoseConfigError(error, [item])) throw new SettingsValidationError([operationProblem(index, item, "invalid_entry_intent")]);
            throw error;
          }
        }
        const preview = await (control.previewSettings?.(draft) ?? draft.preview());
        const review = await draft.reviewForApproval(preview.effect, runtime(control));
        check();
        const diff = settingsDiff(review);
        // Refuse oversized proposals instead of hiding affected values from approval.
        if (formatSettingsDiff(diff).join("\n").length > 48_000) return setterResult({ outcome: "rejected", reason: "Review too large. Use a smaller per-entry operation." });
        phase = "review";
        const approved = await approveSettings(ctx, diff, abort);
        if (!approved || abort.aborted) return setterResult({ outcome: "cancelled" });
        check();
        approvedReview = review;
        phase = "commit";
        const applied = await draft.apply({ guard: check });
        saved = applied.saved;
        if (!saved) return setterResult({ outcome: "no_op", saved: false, reloaded: false, review });
        phase = "reload";
        await control.reload({ allowRestart: preview.effect === "restart", guard: async () => { check(); await applied.assertUnchanged?.(); check(); } });
        return setterResult({ outcome: "applied", saved: true, reloaded: true, runtimeStatus: control.getState().status, review });
      } catch (error) {
        if (phase === "reload") return setterResult({ outcome: "saved_but_reload_failed", saved, reloaded: false, review: approvedReview, reason: "Settings were saved but not fully activated. Inspect settings/runtime and request a new approved change or use /msb to reload." });
        if (signal?.aborted) return setterResult({ outcome: "cancelled" });
        if (error instanceof SettingsConflictError) return setterResult({ outcome: "conflict", saved: false, reloaded: false, reason: "Sources, Session settings, session identity or runtime changed. Request a fresh review; nothing was retried." });
        const validation = phase === "validate" ? error instanceof SettingsValidationError ? error.problems : diagnoseConfigError(error, draft ? input?.operations ?? [] : []) : undefined;
        if (validation) return setterResult({ outcome: "rejected", saved: false, reloaded: false, validation,
          reason: `${validationMessage(validation)} Nothing applied. Operation indices in details are zero-based.` });
        return setterResult({ outcome: phase === "commit" ? "apply_failed" : "rejected", saved: phase === "commit" ? "unknown" : false, reloaded: false,
          reason: phase === "commit" ? "Persistence failed; storage may have changed after an I/O error. Inspect before retrying. Runtime was not reloaded." : "Invalid or unavailable settings proposal. Inspect msb_config_get schemas/constraints; check scope, value shape, credential references and mount safety. Network domains must be exact; secret hosts also accept a single leading *. wildcard. IP/CIDR rules are network-only. Nothing applied." });
      } finally { draft?.discard(); release?.(); }
    },
  });
}
