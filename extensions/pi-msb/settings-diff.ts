import type { Theme } from "@earendil-works/pi-coding-agent";
import { safeText, settingsSourceLabel } from "./control-panel.ts";
import type { SettingsCollectionIntent, SettingsReviewDelta, SettingsReviewFocus } from "./settings.ts";

export interface SettingsDiffLine {
  kind: "context" | "added" | "removed" | "warning";
  label?: string;
  text: string;
}
export const SETTINGS_APPROVAL_HEADING = "Allow configuration change?";
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const display = (value: unknown): string => value === undefined ? "inherit" : typeof value === "string" ? value : JSON.stringify(value);

const fieldLabel = (field: string): string => ({
  allow_hosts: "Hosts", "network.allow_hosts": "Hosts", credential: "Credential", env: "Name", readonly: "Read only",
  host_path: "Host path", guest_path: "Guest path", host_env: "Host variables", cpus: "CPUs", memory_mib: "Memory (MiB)",
  remove_secrets: "Secret exclusions", "entry order": "Entry order", block_third_party: "Block third-party tools",
}[field] ?? field.replace(/[_.]/g, " ").replace(/^./, (letter) => letter.toUpperCase()));
const HOST_CONSEQUENCES: Readonly<Record<string, string>> = {
  pass_through_tools: "When listed: These tools run on the HOST without per-call host approval.",
  block_third_party: "When disabled: Unrecognized tools can run on the HOST without per-call host approval.",
  allow_skill_reads: "When enabled: Skills and generated prompts may be read from the HOST.",
  allow_host_execution: "When enabled: Allows HOST execution after individual tool-call approval.",
  fallback_mode: "With host fallback: Sandbox failure may run tools on the HOST.",
};

/** Accept only the sanitized, bound review, never tool arguments or a private preview. */
export function settingsDiff(review: Record<string, unknown>): SettingsDiffLine[] {
  const lines: SettingsDiffLine[] = [];
  // Older transcript results predate focused display data; never fall back to their JSON.
  if (!Array.isArray(review.focus)) return lines;
  const context = (text: string) => lines.push({ kind: "context", text });
  const warning = (text: string) => lines.push({ kind: "warning", text });
  const deltas = (items: SettingsReviewDelta[], selectedEntry?: string) => {
    let entry: string | undefined;
    for (const delta of items) {
      if (delta.entry !== entry) { entry = delta.entry; if (entry !== undefined && entry !== selectedEntry) context(entry); }
      const { before, after, field } = delta;
      const emit = (kind: "removed" | "added", value: unknown, changed = false) => lines.push({ kind, label: fieldLabel(field), text: display(value) + (changed ? " (changed)" : "") });
      if (Array.isArray(before) && Array.isArray(after)) {
        const removed = before.filter((item) => !after.some((other) => equal(item, other)));
        const added = after.filter((item) => !before.some((other) => equal(item, other)));
        if (removed.length || added.length) {
          removed.forEach((item) => emit("removed", item)); added.forEach((item) => emit("added", item));
        } else { emit("removed", before); emit("added", after, equal(before, after)); }
      } else {
        if (before !== undefined) emit("removed", before);
        if (after !== undefined) emit("added", after, equal(before, after));
      }
    }
  };
  context(`Scope: ${settingsSourceLabel(review.scope)}`);
  for (const focus of review.focus as SettingsReviewFocus[]) {
    const identity = focus.identity ? `${focus.previousIdentity && focus.previousIdentity !== focus.identity ? `${focus.previousIdentity} → ` : ""}${focus.identity}` : "";
    context(`${focus.path === "secrets" && identity ? `Secret ${identity}` : focus.path === "mounts" && identity ? `Mount ${identity}` : `${fieldLabel(focus.path)}${identity ? ` · ${identity}` : ""}`}`);
    if (focus.changed && focus.baseline === "inherited" && focus.deltas.some((delta) => delta.before !== undefined)) context("Overrides inherited values.");
    deltas(focus.deltas, focus.identity);
    if (!focus.changed) context("No change.");
    else if (!focus.effectiveChanged && !focus.shadowed) context("Saved settings change; current value stays the same.");
    if (focus.reconciledDeltas.length) { context("Updates exclusions"); deltas(focus.reconciledDeltas); }
    if (focus.inheritedDeltas.length) { context("Inherited changes"); deltas(focus.inheritedDeltas, focus.identity); }
    if (focus.operation === "inherit" && focus.changed) warning("Removes this override; inherited settings may take effect.");
    if (focus.operation === "remove" && focus.changed) warning("Removes this entry.");
    const collection = (review.collections as SettingsCollectionIntent[]).filter((item) => item.path === focus.path);
    for (const intent of collection) {
      if (["replace", "clear"].includes(intent.operation) && focus.changed) warning(intent.operation === "clear" ? "Clears this scope’s entire list." : "Replaces this scope’s entire list.");
      if (intent.promoted) warning(`Copies this entry from ${settingsSourceLabel(intent.source)} into ${settingsSourceLabel(review.scope)}; the higher scope still wins.`);
    }
    const shadowed = (review.shadowed as string[]).filter((path) => path === focus.path || path.startsWith(`${focus.path}[`));
    if (focus.shadowed || collection.some((item) => item.shadowed) || shadowed.length) warning("Higher-priority settings still apply.");
    if (focus.replacesEntry && focus.changed) warning("Replaces the entry with this name.");
    if (focus.writableMount) warning("This mount allows changes to HOST files.");
    for (const path of focus.hostBypass) if (HOST_CONSEQUENCES[path]) warning(HOST_CONSEQUENCES[path]);
  }
  if (review.effect === "restart" && (review.focus as SettingsReviewFocus[]).some((focus) => focus.changed)) warning("Restart: temporary guest data and nested containers may be lost.");
  if (review.mayStart && (review.focus as SettingsReviewFocus[]).some((focus) => focus.changed)) warning("May start the sandbox because auto-start is enabled.");
  return lines;
}

/** Semantic kinds, not user-controlled prefixes, determine styling. RPC omits the theme. */
export function formatSettingsDiff(lines: SettingsDiffLine[], theme?: Pick<Theme, "fg" | "bold">): string[] {
  return lines.map((line) => {
    const text = safeText(line.text);
    if (!theme) return `${line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : line.kind === "warning" ? "! " : ""}${line.label ? `${safeText(line.label)}: ` : ""}${text}`;
    if (line.kind === "context") return theme.fg("muted", text);
    if (line.kind === "warning") return theme.fg("warning", `! ${text}`);
    const role = line.kind === "added" ? "toolDiffAdded" : "toolDiffRemoved";
    return theme.fg(role, line.kind === "added" ? "+ " : "- ") + (line.label ? theme.fg("muted", `${safeText(line.label)}: `) : "") + theme.fg(role, text);
  });
}

export function settingsOutcome(details: Record<string, unknown>): string {
  const outcome = details.outcome;
  if (outcome === "applied") return `Saved · reloaded · runtime ${safeText(details.runtimeStatus)}`;
  if (outcome === "no_op") return "No change · not saved or reloaded";
  if (outcome === "cancelled") return "Cancelled · nothing applied";
  return `${safeText(outcome ?? "failed")}${typeof details.reason === "string" ? ` · ${safeText(details.reason)}` : " · configuration outcome unavailable"}`;
}
