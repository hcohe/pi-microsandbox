import { CURSOR_MARKER, decodeKittyPrintable, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";

import { sanitizeInputText } from "./settings-input.ts";

/** No plaintext Input, undo stack, kill ring, render string or snapshot is created. */
export class MaskedInput implements Component, Focusable {
  focused = false;
  #value = "";
  #cursor = 0;
  #pasting = false;
  #pending = "";
  take(): string { const value = this.#value; this.clear(); return value; }
  clear(): void { this.#value = ""; this.#cursor = 0; this.#pending = ""; this.#pasting = false; }
  get isPasting(): boolean { return this.#pasting; }
  invalidate(): void {}
  handleInput(data: string): void {
    if (data.includes("\x1b[200~") || this.#pasting) {
      this.#pending += data.replace("\x1b[200~", "");
      this.#pasting = true;
      const end = this.#pending.indexOf("\x1b[201~");
      if (end < 0) return;
      this.#insert(this.#pending.slice(0, end));
      this.#pending = ""; this.#pasting = false;
      return;
    }
    const chars = Array.from(this.#value);
    if (matchesKey(data, "left")) this.#cursor = Math.max(0, this.#cursor - 1);
    else if (matchesKey(data, "right")) this.#cursor = Math.min(chars.length, this.#cursor + 1);
    else if (matchesKey(data, "home")) this.#cursor = 0;
    else if (matchesKey(data, "end")) this.#cursor = chars.length;
    else if (matchesKey(data, "backspace")) { if (this.#cursor) chars.splice(--this.#cursor, 1); this.#value = chars.join(""); }
    else if (matchesKey(data, "delete")) { chars.splice(this.#cursor, 1); this.#value = chars.join(""); }
    else {
      const printable = decodeKittyPrintable(data);
      if (printable !== undefined) this.#insert(printable);
      else if (!data.includes("\x1b")) this.#insert(data);
    }
  }
  #insert(data: string): void {
    const safe = sanitizeInputText(data);
    const chars = Array.from(this.#value);
    chars.splice(this.#cursor, 0, ...Array.from(safe));
    this.#cursor += Array.from(safe).length; this.#value = chars.join("");
  }
  render(width: number): string[] {
    const count = Math.max(0, Math.min(Array.from(this.#value).length, width - 1));
    const cursor = Math.min(this.#cursor, count);
    return ["*".repeat(cursor) + (this.focused ? CURSOR_MARKER : "") + "*".repeat(count - cursor)];
  }
}
