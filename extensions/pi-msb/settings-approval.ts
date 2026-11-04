import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

/** Public custom overlay: native select titles cannot scroll in small/alternate-screen terminals. */
export class SettingsApproval implements Component, Focusable {
  focused = true;
  #offset = 0;
  #approve = false;
  #endSeen = false;
  #closed = false;
  #lines: string[] = [];
  #capacity = 0;
  #usable = false;
  #review: string;
  #tui: Pick<TUI, "terminal" | "requestRender">;
  #theme: Pick<Theme, "fg" | "bold">;
  #done: (approved: boolean) => void;
  constructor(review: string, tui: Pick<TUI, "terminal" | "requestRender">, theme: Pick<Theme, "fg" | "bold">, done: (approved: boolean) => void) {
    this.#review = review; this.#tui = tui; this.#theme = theme; this.#done = done;
  }
  #finish(approved: boolean): void {
    if (this.#closed) return;
    this.#closed = true; this.focused = false; this.#review = ""; this.#lines = [];
    this.#done(approved);
  }
  cancel(): void { this.#finish(false); }
  dispose(): void { this.cancel(); }
  invalidate(): void {}
  render(width: number): string[] {
    const height = Math.max(1, this.#tui.terminal.rows);
    this.#usable = width >= 32 && height >= 10;
    this.#capacity = Math.max(1, height - 5);
    this.#lines = this.#review.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(1, width - 2)));
    this.#offset = Math.max(0, Math.min(this.#offset, this.#lines.length - this.#capacity));
    if (this.#usable && this.#offset + this.#capacity >= this.#lines.length) this.#endSeen = true;
    const rows = this.#usable ? [
      this.#theme.bold("MICROSANDBOX CONFIGURATION APPROVAL"),
      `Review ${this.#offset + 1}–${Math.min(this.#lines.length, this.#offset + this.#capacity)}/${this.#lines.length}${this.#endSeen ? " · End seen" : " · Read to end to enable Approve"}`,
      ...this.#lines.slice(this.#offset, this.#offset + this.#capacity),
    ] : ["Review needs at least 32×10.", "Resize to read; Enter/Escape cancels."];
    while (rows.length < height - 2) rows.push("");
    if (height >= 2) rows.push("↑↓/j/k scroll · PgUp/PgDn · g/G · Tab choose");
    rows.push(`${this.#theme.fg(!this.#approve ? "accent" : "muted", "[ Cancel ]")}  ${this.#theme.fg(this.#approve && this.#usable ? "accent" : "muted", this.#endSeen && this.#usable ? "[ Approve ]" : "[ Approve disabled ]")}  Esc cancel`);
    return rows.slice(0, height).map((line) => {
      const clipped = truncateToWidth(line, Math.max(1, width), "");
      return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
    });
  }
  handleInput(data: string): void {
    if (this.#closed) return;
    if (matchesKey(data, "escape")) { this.cancel(); return; }
    if (matchesKey(data, "enter") || data === "\n") { this.#finish(this.#usable && this.#endSeen && this.#approve); return; }
    if (!this.#usable) return;
    if (matchesKey(data, "tab") || matchesKey(data, "left") || matchesKey(data, "right")) this.#approve = this.#endSeen && !this.#approve;
    else if (matchesKey(data, "up") || data === "k") this.#offset--;
    else if (matchesKey(data, "down") || data === "j") this.#offset++;
    else if (matchesKey(data, "pageUp")) this.#offset -= this.#capacity;
    else if (matchesKey(data, "pageDown")) this.#offset += this.#capacity;
    else if (data === "g" || matchesKey(data, "home")) this.#offset = 0;
    else if (data === "G" || matchesKey(data, "end")) this.#offset = this.#lines.length;
    this.#tui.requestRender();
  }
}

export async function approveSettings(ctx: ExtensionContext, review: string, signal: AbortSignal): Promise<boolean> {
  if (!ctx.hasUI || signal.aborted) return false;
  if (ctx.mode === "rpc") return await ctx.ui.select(review, ["Cancel", "Approve"], { signal }) === "Approve" && !signal.aborted;
  if (ctx.mode !== "tui") return false;
  let cancel: (() => void) | undefined;
  const abort = () => cancel?.();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const approved = await ctx.ui.custom<boolean>((tui, theme, _keys, done) => {
      const view = new SettingsApproval(review, tui, theme, done);
      cancel = () => view.cancel();
      if (signal.aborted) queueMicrotask(cancel);
      return view;
    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
    return approved === true && !signal.aborted;
  } finally { signal.removeEventListener("abort", abort); cancel = undefined; }
}
