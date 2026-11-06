import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSettingsDiff, SETTINGS_APPROVAL_HEADING, type SettingsDiffLine } from "./settings-diff.ts";

export async function approveSettings(ctx: ExtensionContext, review: SettingsDiffLine[], signal: AbortSignal): Promise<boolean> {
  if (!ctx.hasUI || signal.aborted || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return false;
  const question = [SETTINGS_APPROVAL_HEADING, "", ...formatSettingsDiff(review.filter((line) => line.kind !== "warning"), ctx.mode === "tui" ? ctx.ui.theme : undefined)].join("\n");
  const choice = await ctx.ui.select(question, ["No", "Yes"], { signal });
  return choice === "Yes" && !signal.aborted;
}
