import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, ScrollView, sliceByColumn, visibleWidth, type Component, type KeybindingsManager } from "@earendil-works/pi-tui";

/** Hard-wrap without dropping command whitespace, even in a one-column terminal. */
function wrapHostApprovalLine(text: string, width: number): string[] {
  const display = width === 1 ? text.replace(/[^\x00-\x7f]/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`) : text;
  const columns = visibleWidth(display);
  if (columns <= width) return [display];
  const lines: string[] = [];
  for (let column = 0; column < columns;) {
    const line = sliceByColumn(display, column, width, true);
    lines.push(line);
    column += visibleWidth(line);
  }
  return lines;
}

/** Footerless, inline host permission prompt; the caller owns request validation. */
export function createHostApproval(message: (theme?: Theme) => string, tui: { requestRender(): void; terminal: { rows: number } }, theme: Theme,
  keys: KeybindingsManager, done: (value: string | undefined) => void, signal?: AbortSignal): Component & { dispose(): void } {
  let selected = 0, renderedSelection = -1, closed = false;
  let cachedWidth = -1, cachedBody: string[] | undefined;
  const invalidate = () => { cachedBody = undefined; };
  const cleanup = () => signal?.removeEventListener("abort", abort);
  const finish = (value?: string) => { if (closed) return; closed = true; cleanup(); done(value); };
  const abort = () => queueMicrotask(() => finish());
  const body: Component = { invalidate, render(width) {
    if (cachedBody && cachedWidth === width) return cachedBody;
    cachedWidth = width;
    cachedBody = [theme.fg("accent", theme.bold("Allow host execution?")), "", ...message(theme).split("\n")]
      .flatMap((line) => wrapHostApprovalLine(line, width));
    return cachedBody;
  } };
  const scroll = new ScrollView(body, { scrollbar: "hidden", overscroll: "contain" });
  const component: Component & { dispose(): void } = {
    invalidate,
    render(width) {
      const w = Math.max(1, width), rows = Math.max(3, Math.min(18, tui.terminal.rows - 5));
      const choices = ["No", "Yes"].flatMap((label, index) => wrapHostApprovalLine(index === selected
        ? theme.fg("accent", "→ ") + theme.fg("accent", label) : `  ${theme.fg("text", label)}`, w));
      const actionHeight = Math.min(choices.length, rows - 2);
      const spacing = rows >= choices.length + 4 ? 1 : 0;
      const height = rows - actionHeight - spacing - 1;
      const lines = scroll.render(w);
      scroll.updateLayout(lines.length, height, () => tui.requestRender());
      renderedSelection = choices.length <= actionHeight ? selected : -1;
      return [...lines.slice(scroll.scrollTop, scroll.scrollTop + height), ...(spacing ? [""] : []), ...choices.slice(0, actionHeight), ""];
    },
    handleInput(data) {
      if (closed) return;
      if (keys.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) return finish();
      if (keys.matches(data, "tui.select.confirm") || data === "\n") {
        if (!selected) return finish("No");
        if (renderedSelection === selected) finish("Yes");
        return;
      }
      if (keys.matches(data, "tui.select.up") || data === "k") selected = Math.max(0, selected - 1);
      else if (keys.matches(data, "tui.select.down") || data === "j") selected = Math.min(1, selected + 1);
      else if (matchesKey(data, Key.ctrl("n")) || matchesKey(data, Key.ctrl("p")) || matchesKey(data, Key.pageDown) || matchesKey(data, Key.pageUp)) {
        const forward = matchesKey(data, Key.ctrl("n")) || matchesKey(data, Key.pageDown);
        scroll.scrollBy((forward ? 1 : -1) * Math.max(1, scroll.viewportHeight - 1)); tui.requestRender(); return;
      } else return;
      renderedSelection = -1;
      tui.requestRender();
    },
    dispose() { closed = true; cleanup(); },
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return component;
}

export async function approveHostExecution(ctx: ExtensionContext, message: (theme?: Theme) => string): Promise<string | undefined> {
  if (!ctx.hasUI || ctx.signal?.aborted || !["tui", "rpc"].includes(ctx.mode)) return;
  let choice: string | undefined;
  if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
    let component: ReturnType<typeof createHostApproval> | undefined;
    const options = { overlay: false, blocked: { kind: "permission" as const, message: "Allow host execution?" } };
    try {
      choice = await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
        component = createHostApproval(message, tui, theme, keys, done, ctx.signal);
        return component;
      }, options);
    } finally { component?.dispose(); }
  } else {
    choice = await ctx.ui.select(`Allow host execution?\n\n${message()}`, ["No", "Yes"], { signal: ctx.signal });
  }
  return !ctx.signal?.aborted && (choice === "Yes" || choice === "No") ? choice : undefined;
}
