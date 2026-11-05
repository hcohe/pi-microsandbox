import { SelectList, Text, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { formatSettingsDiff, SETTINGS_APPROVAL_HEADING, type SettingsDiffLine } from "./settings-diff.ts";

const approvalHeight = (rows: number): number => Math.max(1, Math.min(rows, 24, Math.max(10, rows - 4)));

/** Compact native-selector shell; explicit overlay bounds keep consent visible in any dock. */
export class SettingsApproval implements Component, Focusable {
  focused = true;
  #offset = 0;
  #selected = 0;
  #endSeen = false;
  #closed = false;
  #lines: string[] = [];
  #capacity = 0;
  #usable = false;
  #review: SettingsDiffLine[];
  #tui: Pick<TUI, "terminal" | "requestRender">;
  #theme: Pick<Theme, "fg" | "bold">;
  #keys: Pick<KeybindingsManager, "matches" | "getKeys">;
  #choices: SelectList;
  #border: DynamicBorder;
  #done: (approved: boolean) => void;
  constructor(review: SettingsDiffLine[], tui: Pick<TUI, "terminal" | "requestRender">, theme: Pick<Theme, "fg" | "bold">, keys: Pick<KeybindingsManager, "matches" | "getKeys">, done: (approved: boolean) => void) {
    this.#review = review; this.#tui = tui; this.#theme = theme; this.#keys = keys; this.#done = done;
    this.#border = new DynamicBorder((text: string) => theme.fg("border", text));
    this.#choices = new SelectList([{ value: "No", label: "No" }, { value: "Yes", label: "Yes" }], 2, {
      selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => theme.fg("muted", text),
    });
  }
  #finish(approved: boolean): void {
    if (this.#closed) return;
    this.#closed = true; this.focused = false; this.#review = []; this.#lines = [];
    this.#done(approved);
  }
  cancel(): void { this.#finish(false); }
  dispose(): void { this.cancel(); }
  invalidate(): void {}
  render(width: number): string[] {
    const height = approvalHeight(this.#tui.terminal.rows);
    this.#usable = width >= 32 && this.#tui.terminal.rows >= 10 && height >= 10;
    if (!this.#usable) {
      this.#selected = 0;
      return ["Review needs at least 32×10.", "Resize to read; Enter/Escape rejects."].slice(0, height).map((line) => truncateToWidth(line, Math.max(1, width), ""));
    }
    const roomy = height >= 16;
    const padded = (text: string) => new Text(text, 1, 0).render(width);
    const hint = (key: string, action: string) => this.#theme.fg("dim", key) + this.#theme.fg("muted", ` ${action}`);
    const confirm = this.#keys.getKeys("tui.select.confirm")[0] ?? "";
    const cancel = this.#keys.getKeys("tui.select.cancel")[0] ?? "";
    const navigation = padded(width >= 64 ? hint("↑↓", "navigate") + "  " + hint(confirm, "select") + "  " + hint(cancel, "cancel")
      : this.#theme.fg("dim", `↑↓  ${confirm}  ${cancel}`));
    const header = [...this.#border.render(width), ...(roomy ? [""] : []), ...padded(this.#theme.fg("accent", this.#theme.bold(SETTINGS_APPROVAL_HEADING))), ""];
    const footerHeight = 4 + navigation.length + (roomy ? 2 : 0);
    this.#lines = formatSettingsDiff(this.#review, this.#theme).flatMap((line) => wrapTextWithAnsi(line || " ", width - 2));
    const available = height - header.length - footerHeight;
    const scrollable = this.#lines.length > available;
    this.#capacity = available - (scrollable ? 1 : 0);
    if (this.#capacity < 1) {
      this.#usable = false; this.#selected = 0;
      return padded("Resize to read; Escape rejects.").slice(0, height);
    }
    this.#offset = Math.max(0, Math.min(this.#offset, this.#lines.length - this.#capacity));
    if (this.#offset + this.#capacity >= this.#lines.length) this.#endSeen = true;
    const scrollHint = scrollable ? [this.#theme.fg("muted", ` ${width >= 64 ? "ctrl+PgUp/PgDn" : "^PgUp/PgDn"} g/G · ${this.#offset + 1}–${Math.min(this.#lines.length, this.#offset + this.#capacity)}/${this.#lines.length}${width >= 64 && !this.#endSeen ? " · Read to end for Yes" : ""}`)] : [];
    this.#choices.setSelectedIndex(this.#selected);
    const footer = [
      "", ...this.#choices.render(width - 2).map((line, index) => " " + this.#theme.fg(index === 1 && !this.#endSeen ? "muted" : "text", line)),
      ...(roomy ? [""] : []), ...navigation, ...(roomy ? [""] : []), ...this.#border.render(width),
    ];
    return [...header, ...this.#lines.slice(this.#offset, this.#offset + this.#capacity).map((line) => " " + line), ...scrollHint, ...footer]
      .map((line) => truncateToWidth(line, Math.max(1, width), ""));
  }
  handleInput(data: string): void {
    if (this.#closed) return;
    if (this.#keys.matches(data, "tui.select.cancel")) { this.cancel(); return; }
    if (this.#keys.matches(data, "tui.select.confirm") || data === "\n") {
      this.#finish(this.#usable && this.#tui.terminal.columns >= 32 && this.#tui.terminal.rows >= 10 && this.#endSeen && this.#selected === 1);
      return;
    }
    if (!this.#usable) return;
    if (this.#keys.matches(data, "tui.select.up") || data === "k") this.#selected = 0;
    else if (this.#keys.matches(data, "tui.select.down") || data === "j") this.#selected = this.#endSeen ? 1 : 0;
    else if (this.#keys.matches(data, "tui.select.pageUp") || matchesKey(data, "ctrl+pageUp")) this.#offset -= this.#capacity;
    else if (this.#keys.matches(data, "tui.select.pageDown") || matchesKey(data, "ctrl+pageDown")) this.#offset += this.#capacity;
    else if (data === "g" || matchesKey(data, "home")) this.#offset = 0;
    else if (data === "G" || matchesKey(data, "end")) this.#offset = this.#lines.length;
    this.#choices.setSelectedIndex(this.#selected);
    this.#tui.requestRender();
  }
}

export async function approveSettings(ctx: ExtensionContext, review: SettingsDiffLine[], signal: AbortSignal): Promise<boolean> {
  if (!ctx.hasUI || signal.aborted) return false;
  if (ctx.mode === "rpc") return await ctx.ui.select([SETTINGS_APPROVAL_HEADING, "", ...formatSettingsDiff(review)].join("\n"), ["No", "Yes"], { signal }) === "Yes" && !signal.aborted;
  if (ctx.mode !== "tui") return false;
  let cancel: (() => void) | undefined;
  let terminal: Pick<TUI["terminal"], "rows"> | undefined;
  const abort = () => cancel?.();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const approved = await ctx.ui.custom<boolean>((tui, theme, keys, done) => {
      terminal = tui.terminal;
      const view = new SettingsApproval(review, tui, theme, keys, done);
      cancel = () => view.cancel();
      if (signal.aborted) queueMicrotask(cancel);
      return view;
    }, { overlay: true, overlayOptions: () => ({ anchor: "bottom-center", width: "100%", maxHeight: approvalHeight(terminal?.rows ?? 0), margin: 0 }) });
    return approved === true && !signal.aborted;
  } finally { signal.removeEventListener("abort", abort); cancel = undefined; }
}
