import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSettingsDiff, SETTINGS_APPROVAL_HEADING, type SettingsDiffLine } from "./settings-diff.ts";

export async function approveSettings(ctx: ExtensionContext, review: SettingsDiffLine[], signal: AbortSignal, hostCommands: string[] = []): Promise<boolean> {
  if (!ctx.hasUI || signal.aborted || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return false;
  // Commands are executable host code: the human must see exactly what they authorize.
  // Keep this private UI-only appendix out of sanitized reviews and tool results.
  const commandReview = hostCommands.length ? ["", "HOST secret commands (run with Pi's host privileges; JSON-quoted):",
    ...hostCommands.map((command) => JSON.stringify(command).replace(/[\p{Cf}]/gu, (char) => char.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")))] : [];
  const question = [SETTINGS_APPROVAL_HEADING, "", ...formatSettingsDiff(review.filter((line) => line.kind !== "warning"), ctx.mode === "tui" ? ctx.ui.theme : undefined), ...commandReview].join("\n");
  const choice = await ctx.ui.select(question, ["No", "Yes"], { signal });
  return choice === "Yes" && !signal.aborted;
}
