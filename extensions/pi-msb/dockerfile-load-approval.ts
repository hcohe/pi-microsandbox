import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, wrapTextWithAnsi, type Component, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { DockerfileScope } from "./dockerfile-storage.ts";
import { formatSettingsDiff } from "./settings-diff.ts";

export const DOCKERFILE_LOAD_QUESTION = "Do you approve loading local built image using custom Dockerfile?";
const scopeLine = (scope: DockerfileScope, theme?: Theme) => formatSettingsDiff([
  { kind: "scope", label: "Scope", text: scope === "project" ? "Project" : "Global" },
], theme)[0]!;
type ApprovalUi = { requestRender(): void; terminal: { rows: number; columns?: number } };

export function createDockerfileLoadApproval(scope: DockerfileScope, tui: ApprovalUi, theme: Theme, keys: KeybindingsManager,
  done: (approved: boolean) => void, signal: AbortSignal): Component & { dispose(): void } {
  let selected = 1, renderedSelection = -1, renderedRows = 0, renderedColumns: number | undefined, closed = false;
  const height = () => Math.max(1, tui.terminal.rows - 5);
  const cleanup = () => signal.removeEventListener("abort", abort);
  const finish = (approved: boolean) => { if (closed) return; closed = true; cleanup(); done(approved); };
  const abort = () => queueMicrotask(() => finish(false));
  const invalidate = () => { renderedSelection = -1; };
  const component: Component & { dispose(): void } = {
    invalidate,
    render(width) {
      invalidate();
      if (closed || signal.aborted) return [];
      const wrap = (text: string) => wrapTextWithAnsi(text, Math.max(1, width));
      const lines = [...wrap(theme.fg("accent", DOCKERFILE_LOAD_QUESTION)), "", ...wrap(scopeLine(scope, theme)), "",
        ...["Yes", "No"].flatMap((choice, index) => wrap(theme.fg(index === selected ? "accent" : "text", choice)))];
      renderedRows = lines.length; renderedColumns = tui.terminal.columns;
      if (lines.length <= height()) renderedSelection = selected;
      return lines.slice(0, height());
    },
    handleInput(data) {
      if (closed) return;
      if (signal.aborted || keys.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return finish(false);
      if (keys.matches(data, "tui.select.confirm")) {
        if (selected === 1) return finish(false);
        if (renderedSelection === selected && renderedRows <= height() && renderedColumns === tui.terminal.columns) finish(true);
      } else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
        selected = 1 - selected; invalidate(); tui.requestRender();
      }
    },
    dispose() { closed = true; invalidate(); cleanup(); },
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return component;
}

export async function approveDockerfileLoad(ctx: ExtensionContext, scope: DockerfileScope, signal: AbortSignal): Promise<boolean> {
  if (!ctx.hasUI || signal.aborted || !["tui", "rpc"].includes(ctx.mode) || !["project", "global"].includes(scope)) return false;
  let component: ReturnType<typeof createDockerfileLoadApproval> | undefined;
  let finished = false, explicitlyApproved = false;
  let completeCustom: ((approved: boolean) => void) | undefined;
  let cancel!: () => void;
  const cancelled = new Promise<false>((resolve) => { cancel = () => { resolve(false); completeCustom?.(false); }; });
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
      const result = await Promise.race([ctx.ui.custom<boolean>((tui, theme, keys, done) => {
        let delivered = false;
        const complete = (approved: boolean) => {
          if (delivered) return;
          delivered = true;
          explicitlyApproved = !finished && !signal.aborted && approved;
          done(explicitlyApproved);
        };
        completeCustom = complete;
        component = createDockerfileLoadApproval(scope, tui, theme, keys, complete, signal);
        // A cancelled host may invoke its factory only after this interaction has ended.
        if (finished) { component.dispose(); queueMicrotask(() => complete(false)); }
        return component;
      }, { overlay: false }), cancelled]);
      return !signal.aborted && result === true && explicitlyApproved;
    }
    // Native select has no initial-index option: No-first is required to keep denial the default.
    const result = await Promise.race([ctx.ui.select(`${DOCKERFILE_LOAD_QUESTION}\n\n${scopeLine(scope)}`, ["No", "Yes"], { signal }), cancelled]);
    return !signal.aborted && result === "Yes";
  } finally {
    finished = true;
    signal.removeEventListener("abort", cancel);
    component?.dispose();
  }
}
