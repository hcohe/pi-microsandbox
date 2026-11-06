import { Type } from "typebox";
import { normalizeConfigPath } from "./config.ts";
import { COLLECTION_REMOVALS, SETTINGS_PATHS } from "./settings.ts";
import { safeText } from "./control-panel.ts";
import { effectiveNetworkPolicy, settingsCapabilities, settingsSchema } from "./settings-schema.ts";
import { POLICY_VERIFICATION_GUIDANCE, RECONNECTED_POLICY_WARNING, SESSION_LIFETIME } from "./settings-safety.ts";

export const SETTINGS_SCHEMA_VERSION = 5;
export const INSPECTION_SECTIONS = ["summary", "desired", "layers", "origins", "runtime", "schema", "capabilities", "policy", "warnings", "recovery"] as const;
const pathNames = [...SETTINGS_PATHS, "network", "docker"];
export const inspectionParameters = Type.Object({
  sections: Type.Optional(Type.Array(Type.String({ enum: [...INSPECTION_SECTIONS] }), { minItems: 1, maxItems: INSPECTION_SECTIONS.length,
    description: "Return only these sections. Omit for the full inventory. summary includes safety/lifetime/adoption guidance." })),
  paths: Type.Optional(Type.Array(Type.String({ enum: pathNames }), { minItems: 1, maxItems: pathNames.length,
    description: "Filter setting leaves in desired/layers/origins/runtime/schema; network/docker select a group. No indexed or file paths. Policy/summary safety context is not path-filtered." })),
  format: Type.Optional(Type.String({ enum: ["text", "json"], description: "text (default) is a readable report. json is indented JSON. Structured details always contain the selected machine-readable fields." })),
  knownSchemaVersion: Type.Optional(Type.Integer({ minimum: 1, description: "Omit schema/capabilities when this equals schemaVersion; cache discovery per version. No server-side session cache." })),
}, { additionalProperties: false });
export interface InspectionRequest { sections: readonly string[]; paths?: string[]; format: "text" | "json"; knownSchemaVersion?: number; explicitSections: boolean }
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
export function inspectionRequest(value: unknown): InspectionRequest {
  if (!record(value) || Object.keys(value).some((key) => !["sections", "paths", "format", "knownSchemaVersion"].includes(key))) throw new Error();
  const list = (input: unknown, choices: readonly string[]) => Array.isArray(input) && input.length > 0 && input.length <= choices.length && input.every((item) => typeof item === "string" && choices.includes(item));
  if ("sections" in value && !list(value.sections, INSPECTION_SECTIONS) || "paths" in value && !list(value.paths, pathNames)
    || "format" in value && !["text", "json"].includes(value.format)
    || "knownSchemaVersion" in value && (!Number.isSafeInteger(value.knownSchemaVersion) || value.knownSchemaVersion < 1)) throw new Error();
  return { sections: [...new Set<string>(value.sections ?? INSPECTION_SECTIONS)],
    ...(value.paths ? { paths: SETTINGS_PATHS.filter((path) => value.paths.some((selected: string) => path === selected || path.startsWith(`${selected}.`))) } : {}),
    format: value.format ?? "text", knownSchemaVersion: value.knownSchemaVersion, explicitSections: "sections" in value };
}
function pickLeaves(input: unknown, paths: readonly string[]): Record<string, unknown> {
  const output: Record<string, any> = {};
  for (const path of paths) {
    const parts = path.split("."); let source: any = input;
    for (const part of parts) source = record(source) && Object.hasOwn(source, part) ? source[part] : undefined;
    if (source === undefined) continue;
    let target = output;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)!] = source;
  }
  return output;
}
function pickOrigins(input: unknown, paths: readonly string[]): Record<string, unknown> {
  if (!record(input)) return {};
  const names = paths.flatMap((path) => [path, normalizeConfigPath(path).join(".")]);
  return Object.fromEntries(Object.entries(input).filter(([key]) => names.some((name) => key === name || key.startsWith(`${name}[`))));
}

/** Filtering/rendering happens after the complete private redaction boundary, never on raw configuration. */
export function inspectSettings(inspection: Record<string, any>, request: InspectionRequest): Record<string, any> {
  const state = inspection.runtime;
  const desired = effectiveNetworkPolicy(inspection.desired);
  const adopted = effectiveNetworkPolicy(state?.adopted?.settings);
  const unknown = !adopted;
  const summary = {
    configurationValid: inspection.recovery?.configurationValid ?? (inspection.desired ? true : null),
    recoveryAvailable: inspection.recovery?.available ?? null,
    runtimeStatus: state?.status ?? "unknown", desiredNetworkMode: desired?.mode ?? "unknown",
    adoptedNetworkMode: adopted?.mode ?? "unknown", verification: state?.adopted?.verification ?? "unknown",
    adoptionNote: unknown ? state?.adopted?.verification === "reconnected" ? RECONNECTED_POLICY_WARNING
      : "No agent-safe adopted network snapshot is available; desired settings are not proof of enforcement."
      : "Adopted settings are last-known, not a live connectivity probe. An inactive VM does not imply enforcement.",
    ...(unknown ? { howToVerify: POLICY_VERIFICATION_GUIDANCE } : {}),
    sessionLifetime: { ...SESSION_LIFETIME, overridesPresent: record(inspection.layers?.session) ? Object.keys(inspection.layers.session).length > 0 : null },
    networkLimitations: [...new Set([...(desired?.warnings as string[] ?? []), ...(adopted?.warnings as string[] ?? [])])],
  };
  const output: Record<string, any> = { outcome: inspection.outcome ?? "inspected", schemaVersion: SETTINGS_SCHEMA_VERSION };
  const selected = new Set(request.sections);
  const paths = request.paths;
  if (inspection.reason) output.reason = inspection.reason;
  // An invalid baseline is safety context, not a filtered desired-policy value.
  if (inspection.recovery && (selected.has("recovery") || inspection.recovery.configurationValid === false)) output.recovery = inspection.recovery;
  if (selected.has("summary")) output.summary = summary;
  if (selected.has("desired") && inspection.desired) output.desired = paths ? pickLeaves(inspection.desired, paths) : inspection.desired;
  if (selected.has("layers") && inspection.layers) {
    const layerPaths = paths?.flatMap((path) => [path, ...(COLLECTION_REMOVALS[path] ? [COLLECTION_REMOVALS[path]!] : [])]);
    output.layers = Object.fromEntries(["global", "project", "session"].map((scope) => [scope, layerPaths ? pickLeaves(inspection.layers[scope], layerPaths) : inspection.layers[scope]]));
    output.layerSemantics = inspection.layerSemantics;
  }
  if (selected.has("origins")) {
    if (inspection.origins) output.origins = paths ? pickOrigins(inspection.origins, paths) : inspection.origins;
    if (inspection.provenance) output.provenance = paths ? pickOrigins(inspection.provenance, paths) : inspection.provenance;
    output.otherOrigins = inspection.otherOrigins;
  }
  if (selected.has("runtime") && state) {
    output.runtime = { ...state, ...(state.adopted && paths ? { adopted: { ...state.adopted,
      settings: pickLeaves(state.adopted.settings, paths), provenance: pickOrigins(state.adopted.provenance, paths),
      knownFields: state.adopted.knownFields?.filter((field: string) => paths.some((path) => normalizeConfigPath(path)[0] === field)),
    } } : {}), networkVerification: { known: !unknown, explanation: summary.adoptionNote, ...(unknown ? { howToVerify: POLICY_VERIFICATION_GUIDANCE } : {}) } };
  }
  if (request.knownSchemaVersion === SETTINGS_SCHEMA_VERSION) {
    if (selected.has("schema") || selected.has("capabilities")) output.schemaUnchanged = true;
  } else {
    if (selected.has("schema")) {
      const schemas = settingsSchema();
      output.supportedPaths = paths ? inspection.supportedPaths?.filter((path: string) => paths.includes(path)) ?? paths : inspection.supportedPaths ?? SETTINGS_PATHS;
      output.settingsSchema = paths ? Object.fromEntries(Object.entries(schemas).filter(([path]) => paths.includes(path))) : schemas;
    }
    if (selected.has("capabilities")) output.capabilities = settingsCapabilities;
  }
  if (selected.has("policy")) output.effectivePolicy = {
    desired, adopted, runtimeStatus: state?.status, verification: state?.adopted?.verification ?? null,
    note: `${summary.adoptionNote} HOST/pass-through tools are outside this VM network boundary.`,
    ...(unknown ? { howToVerify: POLICY_VERIFICATION_GUIDANCE } : {}),
  };
  if (selected.has("warnings") && inspection.warnings) output.warnings = inspection.warnings;
  // Keep structured details identical to their JSON representation (no undefined object fields).
  return JSON.parse(JSON.stringify(output));
}

function report(details: Record<string, any>, compact: boolean): string {
  const lines = [`Microsandbox settings · ${safeText(details.outcome)}`, `Schema version: ${SETTINGS_SCHEMA_VERSION}${details.schemaUnchanged ? " (unchanged; cached discovery omitted)" : ""}`];
  const add = (heading: string, value: unknown) => {
    if (value === undefined) return;
    lines.push("", heading);
    const visit = (item: unknown, key: string, depth: number) => {
      const pad = "  ".repeat(depth);
      if (Array.isArray(item) && item.length) { lines.push(`${pad}${safeText(key)}:`); item.forEach((child, i) => visit(child, `[${i}]`, depth + 1)); }
      else if (record(item) && Object.keys(item).length) { lines.push(`${pad}${safeText(key)}:`); Object.entries(item).forEach(([k, v]) => visit(v, k, depth + 1)); }
      else lines.push(`${pad}${safeText(key)}: ${safeText(typeof item === "string" ? item : JSON.stringify(item))}`);
    };
    if (record(value)) Object.entries(value).forEach(([key, item]) => visit(item, key, 1));
    else visit(value, "items", 1);
  };
  if (details.reason) lines.push(safeText(details.reason));
  if (details.summary) {
    const s = details.summary;
    lines.push(`Runtime: ${safeText(s.runtimeStatus)} · verification: ${safeText(s.verification)}`,
      `Network: desired ${safeText(s.desiredNetworkMode)} · adopted ${safeText(s.adoptedNetworkMode)}`,
      safeText(s.adoptionNote));
    if (s.howToVerify) lines.push(safeText(s.howToVerify));
    lines.push(`! ${safeText(s.sessionLifetime.warning)}`);
    for (const warning of s.networkLimitations ?? []) lines.push(`! ${safeText(warning)}`);
  }
  if (compact) {
    if (!details.summary) lines.push("Expand for the selected inspection sections.");
    return lines.join("\n");
  }
  for (const [key, heading] of [["desired", "Desired settings (intent, not enforcement)"], ["layers", "Sparse scope layers"], ["origins", "Origins"], ["provenance", "Provenance"], ["runtime", "Runtime (known adoption only)"], ["effectivePolicy", "Network policy"], ["warnings", "Configuration warnings"], ["recovery", "Configuration recovery"]]) add(heading!, details[key!]);
  if (details.settingsSchema) {
    lines.push("", "Setting schemas");
    for (const [path, field] of Object.entries(details.settingsSchema) as Array<[string, any]>) {
      const shape = field.valueSchema;
      const type = shape.enum ? shape.enum.map((v: unknown) => JSON.stringify(v)).join(" | ") : Array.isArray(shape.type) ? shape.type.join(" | ") : shape.type;
      lines.push(`  ${path}: ${type}${shape.minimum !== undefined ? ` ≥ ${shape.minimum}` : ""}${shape.maximum !== undefined ? ` ≤ ${shape.maximum}` : ""}`,
        `    ${safeText(field.description)}`, `    Operations: ${field.operations.join(", ")} · scopes: ${field.scopes.join(", ")} · ${field.effect}`);
      if (field.constraints) lines.push(`    ${safeText(field.constraints)}`);
      if (field.choices) Object.entries(field.choices).forEach(([key, value]) => lines.push(`    ${safeText(key)}: ${safeText(value)}`));
      if (field.upsertSchema) add(`    ${path} upsert entry schema`, field.upsertSchema);
      if (field.semantics) add(`    ${path} matching`, field.semantics);
    }
  }
  if (details.capabilities) add("Capabilities and safety semantics", details.capabilities);
  return lines.join("\n");
}
export function inspectionText(details: Record<string, any>, format: "text" | "json" = "text", compact = false): string {
  const output = format === "json" ? JSON.stringify(details, null, 2) : report(details, compact);
  if (Buffer.byteLength(output, "utf8") <= 48000) return output;
  const reason = "Display truncated. Use sections/paths filters; structured details contain the selected complete result.";
  if (format === "json") return JSON.stringify({ outcome: details.outcome, schemaVersion: SETTINGS_SCHEMA_VERSION, outputTruncated: true, reason }, null, 2);
  return Buffer.from(output, "utf8").subarray(0, 47000).toString("utf8") + `\n\n[${reason}]`;
}
export function inspectionResult(details: Record<string, any>, format: "text" | "json" = "text", overview = false) {
  const presentation = overview && format === "text" ? Object.fromEntries(Object.entries(details).filter(([key]) => ["outcome", "schemaVersion", "schemaUnchanged", "reason", "summary", "desired", "recovery"].includes(key))) : details;
  const hint = overview && format === "text" ? "\n\nOther selected sections remain in structured details. Request sections explicitly (or format=json) for their full report; expand the tool row to inspect them." : "";
  return { content: [{ type: "text" as const, text: inspectionText(presentation, format) + hint }], details };
}
