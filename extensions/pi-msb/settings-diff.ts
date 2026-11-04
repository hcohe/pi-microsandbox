import type { Theme } from "@earendil-works/pi-coding-agent";
import { HOST_BOUNDARY_WARNINGS, safeText } from "./control-panel.ts";
import type { SettingsCollectionIntent, SettingsReviewDelta, SettingsReviewFocus } from "./settings.ts";

export interface SettingsDiffLine {
  kind: "context" | "added" | "removed" | "warning";
  label?: string;
  text: string;
}
export const SETTINGS_APPROVAL_HEADING = "MICROSANDBOX · Review change";
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const display = (value: unknown): string => value === undefined ? "inherit" : typeof value === "string" ? value : JSON.stringify(value);

/** Accept only the sanitized, bound review, never tool arguments or a private preview. */
export function settingsDiff(review: Record<string, unknown>): SettingsDiffLine[] {
  const lines: SettingsDiffLine[] = [];
  // Older transcript results predate focused display data; never fall back to their JSON.
  if (!Array.isArray(review.focus)) return lines;
  const context = (text: string) => lines.push({ kind: "context", text });
  const warning = (text: string) => lines.push({ kind: "warning", text });
  const deltas = (items: SettingsReviewDelta[]) => {
    let entry: string | undefined;
    for (const delta of items) {
      if (delta.entry !== entry) { entry = delta.entry; if (entry !== undefined) context(entry); }
      const { before, after, field } = delta;
      const emit = (kind: "removed" | "added", value: unknown, changed = false) => lines.push({ kind, label: field, text: display(value) + (changed ? " (changed)" : "") });
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
  for (const focus of review.focus as SettingsReviewFocus[]) {
    context(`${review.scope} · ${focus.path} · ${focus.operation}${focus.identity ? ` · ${focus.previousIdentity && focus.previousIdentity !== focus.identity ? `${focus.previousIdentity} → ` : ""}${focus.identity}` : ""}`);
    context(`Target: ${focus.targetBefore}${focus.targetBefore !== focus.targetAfter ? ` → ${focus.targetAfter}` : ""}${focus.baseline === "inherited" && focus.changed ? " · compared with inherited baseline" : ""}`);
    deltas(focus.deltas);
    if (!focus.changed) context("No stored change (no-op).");
    else if (!focus.effectiveChanged) context("Desired value unchanged; scope intent only.");
    if (focus.reconciledDeltas.length) { context("Reconciles target-scope removal controls"); deltas(focus.reconciledDeltas); }
    if (focus.inheritedDeltas.length) { context("Desired after inherit"); deltas(focus.inheritedDeltas); }
    if (focus.operation === "inherit" && focus.changed) warning("Removes this scope's assignment; lower layers may take effect.");
    if (focus.operation === "remove" && focus.changed) warning("Removes the selected entry from this scope's list.");
    const collection = (review.collections as SettingsCollectionIntent[]).filter((item) => item.path === focus.path);
    for (const intent of collection) {
      if (["replace", "clear"].includes(intent.operation) && focus.changed) warning(intent.operation === "clear" ? "Clears the whole target-scope list." : "Replaces the whole target-scope list.");
      if (intent.promoted) warning(`Promotion: selected entry copied from ${intent.source} into ${review.scope}; higher scope still wins.`);
      else if (focus.identity && intent.source !== "new entry") context(`Entry source: ${intent.source}`);
    }
    const shadowed = (review.shadowed as string[]).filter((path) => path === focus.path || path.startsWith(`${focus.path}[`));
    if (focus.shadowed || collection.some((item) => item.shadowed) || shadowed.length) warning("Shadowed: higher-precedence settings still win after saving.");
    if (focus.replacesEntry && focus.changed) warning("Rename replaces an existing entry at the destination identity.");
    if (focus.writableMount) warning("Writable mount: the guest can change actual HOST files.");
    for (const path of focus.hostBypass) if (HOST_BOUNDARY_WARNINGS[path]) warning(HOST_BOUNDARY_WARNINGS[path]);
  }
  if (review.effect === "restart" && (review.focus as SettingsReviewFocus[]).some((focus) => focus.changed)) warning("Restart: guest ephemeral state and nested containers may be lost.");
  if (review.mayStart && (review.focus as SettingsReviewFocus[]).some((focus) => focus.changed)) warning("Reload may start the inactive sandbox (auto_start=true).");
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
