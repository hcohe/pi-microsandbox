import {
  type ContextUsage,
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

const STATUS_KEY = "pi-msb";
const MIN_GAP = 2;

type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

type UsageTotals = Required<Omit<UsageLike, "cost">> & { cost: number };

function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const insideHome = relativeToHome === "" || (
    relativeToHome !== ".." &&
    !relativeToHome.startsWith(`..${sep}`) &&
    !isAbsolute(relativeToHome)
  );
  if (!insideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function usageFromEntry(entry: unknown): UsageLike | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const value = entry as {
    type?: string;
    usage?: UsageLike;
    message?: { role?: string; usage?: UsageLike };
  };
  if (value.type === "message" && (value.message?.role === "assistant" || value.message?.role === "toolResult")) {
    return value.message.usage;
  }
  if (value.type === "branch_summary" || value.type === "compaction") return value.usage;
  return undefined;
}

function totalUsage(entries: readonly unknown[]): { totals: UsageTotals; latestCacheHitRate?: number } {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let latestCacheHitRate: number | undefined;
  for (const entry of entries) {
    const usage = usageFromEntry(entry);
    if (!usage) continue;
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    totals.cost += usage.cost?.total ?? 0;

    const value = entry as { type?: string; message?: { role?: string } };
    if (value.type === "message" && value.message?.role === "assistant") {
      const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      latestCacheHitRate = promptTokens > 0 ? ((usage.cacheRead ?? 0) / promptTokens) * 100 : undefined;
    }
  }
  return { totals, latestCacheHitRate };
}

/** Align two ANSI-styled values while keeping the right value visible. */
export function alignFooterRow(left: string, right: string, width: number, ellipsis = "..."): string {
  if (width <= 0) return "";
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width, "");
  const maxLeftWidth = Math.max(0, width - rightWidth - MIN_GAP);
  const fittedLeft = truncateToWidth(left, maxLeftWidth, ellipsis);
  const padding = " ".repeat(Math.max(0, width - visibleWidth(fittedLeft) - rightWidth));
  return fittedLeft + padding + right;
}

function sanitizeStatus(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function isUsingSubscription(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  if (!model) return false;
  if (model.provider === "kimi-coding") return true;
  const provider = ctx.modelRegistry.getProvider(model.provider);
  return ctx.modelRegistry.isUsingOAuth(model) && provider?.auth.oauth?.isSubscription === true;
}

function renderContextUsage(theme: Theme, usage: ContextUsage | undefined, contextWindow: number): string {
  const percentValue = usage?.percent ?? 0;
  const percent = usage?.percent === null ? "?" : (usage?.percent ?? 0).toFixed(1);
  const text = `${percent}%/${formatTokens(usage?.contextWindow ?? contextWindow)}`;
  if (percentValue > 90) return theme.fg("error", text);
  if (percentValue > 70) return theme.fg("warning", text);
  return text;
}

/** Build a two-row Pi footer with the MSB status in the upper-right corner. */
export function createMsbFooter(
  tui: TUI,
  theme: Theme,
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
): Component & { dispose(): void } {
  const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

  return {
    invalidate() {},
    dispose: unsubscribe,
    render(width: number): string[] {
      const statuses = footerData.getExtensionStatuses();
      const msbStatus = sanitizeStatus(statuses.get(STATUS_KEY) ?? "");

      let location = formatCwd(
        ctx.sessionManager.getCwd(),
        process.env.HOME || process.env.USERPROFILE,
      );
      const branch = footerData.getGitBranch();
      if (branch) location += ` (${branch})`;
      const sessionName = ctx.sessionManager.getSessionName();
      if (sessionName) location += ` • ${sessionName}`;

      const dimEllipsis = theme.fg("dim", "...");
      const locationText = theme.fg("dim", location);
      const locationLine = msbStatus
        ? alignFooterRow(locationText, msbStatus, width, dimEllipsis)
        : truncateToWidth(locationText, width, dimEllipsis);

      const { totals, latestCacheHitRate } = totalUsage(ctx.sessionManager.getEntries());
      const stats: string[] = [];
      if (totals.input) stats.push(`↑${formatTokens(totals.input)}`);
      if (totals.output) stats.push(`↓${formatTokens(totals.output)}`);
      if (totals.cacheRead) stats.push(`R${formatTokens(totals.cacheRead)}`);
      if (totals.cacheWrite) stats.push(`W${formatTokens(totals.cacheWrite)}`);
      if ((totals.cacheRead || totals.cacheWrite) && latestCacheHitRate !== undefined) {
        stats.push(`CH${latestCacheHitRate.toFixed(1)}%`);
      }
      const usingSubscription = isUsingSubscription(ctx);
      if (totals.cost || usingSubscription) {
        stats.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
      }
      stats.push(renderContextUsage(theme, ctx.getContextUsage(), ctx.model?.contextWindow ?? 0));

      const modelName = ctx.model?.id ?? "no-model";
      const thinkingLevel = ctx.thinkingLevel ?? "off";
      const modelAndThinking = ctx.model?.reasoning
        ? `${modelName} • ${thinkingLevel === "off" ? "thinking off" : thinkingLevel}`
        : modelName;
      let modelText = modelAndThinking;
      if (ctx.model && footerData.getAvailableProviderCount() > 1) {
        const withProvider = `(${ctx.model.provider}) ${modelAndThinking}`;
        if (visibleWidth(stats.join(" ")) + MIN_GAP + visibleWidth(withProvider) <= width) modelText = withProvider;
      }
      const statsLine = alignFooterRow(
        theme.fg("dim", stats.join(" ")),
        theme.fg("dim", modelText),
        width,
        dimEllipsis,
      );

      const lines = [locationLine, statsLine];
      const otherStatuses = Array.from(statuses.entries())
        .filter(([key]) => key !== STATUS_KEY)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => sanitizeStatus(text));
      if (otherStatuses.length > 0) {
        lines.push(truncateToWidth(otherStatuses.join(" "), width, dimEllipsis));
      }
      return lines;
    },
  };
}
