import { ConfigError } from "./config.ts";
import { SettingsConflictError } from "./settings-conflict.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSettingsDiff, settingsDiff, SETTINGS_APPROVAL_HEADING } from "./settings-diff.ts";
import { safeText } from "./settings-presentation.ts";
import type { SettingsDraft, SettingsPreview } from "./settings.ts";

export interface PreparedProjectSettingsCandidate {
  label: string;
  draft: SettingsDraft;
  preview: SettingsPreview;
  review: Record<string, unknown>;
  hostCommands: string[];
}
export type ProjectSettingsCandidate = PreparedProjectSettingsCandidate | { label: string; unavailable: true };
export const projectCandidateAvailable = (candidate: ProjectSettingsCandidate): candidate is PreparedProjectSettingsCandidate => !("unavailable" in candidate);
export function discardProjectCandidates(candidates: ProjectSettingsCandidate[] | undefined): void {
  candidates?.forEach((candidate) => { if (projectCandidateAvailable(candidate)) candidate.draft.discard(); });
}
export function projectSettingsLabels(names: { repositoryName: string; worktreeName: string }): [string, string] {
  return [`Yes (For ${safeText(names.repositoryName)} and all its worktrees)`, `Yes (Only for ${safeText(names.worktreeName)} worktree)`];
}
export function hostCommandAppendix(commands: string[]): string[] {
  return commands.length ? ["", "HOST secret commands (run with Pi's host privileges; JSON-quoted):",
    ...commands.map((command) => JSON.stringify(command).replace(/[\p{Cf}]/gu, (char) => char.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")))] : [];
}
/** Each destination is independently prepared and approval-bound BEFORE the human chooses it. */
export async function prepareProjectSettings(draft: SettingsDraft, preview: (draft: SettingsDraft) => Promise<SettingsPreview>, runtime?: unknown): Promise<ProjectSettingsCandidate[] | undefined> {
  const names = await draft.projectDestinations();
  if (!names) return;
  const labels = projectSettingsLabels(names);
  const result: ProjectSettingsCandidate[] = [];
  try {
    for (const [index, scope] of (["project", "worktree"] as const).entries()) {
      let candidate: SettingsDraft | undefined;
      try {
        candidate = draft.scope === scope ? draft : await draft.forScope(scope);
        const proposed = await preview(candidate);
        const review = await candidate.reviewForApproval(proposed.effect, runtime);
        result.push({ label: labels[index]!, draft: candidate, preview: proposed, review, hostCommands: await candidate.hostCommandsForApproval() });
      } catch (error) {
        if (candidate !== draft) candidate?.discard();
        if (error instanceof SettingsConflictError || !(error instanceof ConfigError)) throw error;
        result.push({ label: labels[index]!, unavailable: true });
      }
    }
    if (!result.some(projectCandidateAvailable)) throw new Error("No safely reviewable Project destination");
    // Reject, never truncate either complete candidate or executable command appendix.
    if (projectSettingsQuestion(result).length > 48_000) throw new Error("Project review too large; use a smaller change");
    return result;
  } catch (error) { discardProjectCandidates(result); throw error; }
}

export function projectSettingsQuestion(candidates: ProjectSettingsCandidate[], theme?: Parameters<typeof formatSettingsDiff>[1], warnings = false): string {
  return [SETTINGS_APPROVAL_HEADING, "Only the selected destination is authorized. No leaves settings unchanged.",
    ...candidates.flatMap((candidate) => {
      if (!projectCandidateAvailable(candidate)) return ["", candidate.label, "UNAVAILABLE: This destination cannot be safely reviewed against the current layers. Selecting it saves nothing. Repair that layer separately or choose a complete available review."];
      return ["", candidate.label, `Settings file: ${safeText(candidate.draft.path)}`,
        candidate.draft.scope === "project" ? "Shared policy applies to registered worktrees on next start/reload, including future worktrees." : "Only this checkout/cwd changes; other worktrees are unchanged.",
        ...(candidate.preview.shadowed.length ? [`Shadowed here (NOT currently effective): ${candidate.preview.shadowed.map(safeText).join(", ")}. Higher-priority overrides remain unchanged.${candidate.draft.scope === "project" ? " Shared policy can still affect other/future worktrees." : " This saved override applies when no higher layer shadows it."}`] : []),
        ...formatSettingsDiff(settingsDiff(candidate.review).filter((line) => warnings || line.kind !== "warning"), theme),
        ...hostCommandAppendix(candidate.hostCommands)];
    })].join("\n");
}
export async function approveProjectSettings(ctx: ExtensionContext, candidates: ProjectSettingsCandidate[], signal: AbortSignal): Promise<PreparedProjectSettingsCandidate | undefined> {
  if (!ctx.hasUI || signal.aborted || !["tui", "rpc"].includes(ctx.mode)) return;
  const question = projectSettingsQuestion(candidates, ctx.mode === "tui" ? ctx.ui.theme : undefined);
  if (question.length > 48_000) throw new Error("Project review too large");
  const choice = await ctx.ui.select(question, ["No", ...candidates.map((candidate) => candidate.label)], { signal });
  if (signal.aborted) return;
  return candidates.filter(projectCandidateAvailable).find((candidate) => candidate.label === choice);
}
