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
export type ProjectSettingsCandidate = PreparedProjectSettingsCandidate;
export function discardProjectCandidates(candidates: ProjectSettingsCandidate[] | undefined): void {
  candidates?.forEach((candidate) => candidate.draft.discard());
}
export function projectSettingsLabels(names: { repositoryName: string }): [string] {
  return [`Apply shared Project (${safeText(names.repositoryName)})`];
}
export function hostCommandAppendix(commands: string[]): string[] {
  return commands.length ? ["", "HOST secret commands (run with Pi's host privileges; JSON-quoted):",
    ...commands.map((command) => JSON.stringify(command).replace(/[\p{Cf}]/gu, (char) => char.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")))] : [];
}
/** Prepare the one shared Project target before requesting fresh authorization. */
export async function prepareProjectSettings(draft: SettingsDraft, preview: (draft: SettingsDraft) => Promise<SettingsPreview>, runtime?: unknown): Promise<ProjectSettingsCandidate[] | undefined> {
  const names = await draft.sharedProject();
  if (!names) return;
  if (draft.scope !== "project") throw new Error("Project review requires a Project draft");
  try {
    const proposed = await preview(draft);
    const review = await draft.reviewForApproval(proposed.effect, runtime);
    const result = [{ label: projectSettingsLabels(names)[0], draft, preview: proposed, review, hostCommands: await draft.hostCommandsForApproval() }];
    // Never truncate the complete review or executable command appendix.
    if (projectSettingsQuestion(result).length > 48_000) throw new Error("Project review too large; use a smaller change");
    return result;
  } catch (error) { draft.discard(); throw error; }
}

export function projectSettingsQuestion(candidates: ProjectSettingsCandidate[], theme?: Parameters<typeof formatSettingsDiff>[1], warnings = false): string {
  return [SETTINGS_APPROVAL_HEADING, "Only this shared Project target is authorized. No leaves settings unchanged.",
    ...candidates.flatMap((candidate) => {
      return ["", candidate.label, `Settings file: ${safeText(candidate.draft.path)}`,
        "Shared Project applies from main, linked and nested Git cwd on next start/reload, including future worktrees. The automatic read/write bind remains current cwd only.",
        ...(candidate.preview.shadowed.length ? [`Shadowed here (NOT currently effective): ${candidate.preview.shadowed.map(safeText).join(", ")}. Higher-priority overrides remain unchanged. Shared policy can still affect other/future worktrees.`] : []),
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
  return candidates.find((candidate) => candidate.label === choice);
}
