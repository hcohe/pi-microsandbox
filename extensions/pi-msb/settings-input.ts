import { Input } from "@earendil-works/pi-tui";

/** Remove terminal controls before pasted text reaches an Input's render/undo state. */
export const sanitizeInputText = (text: string): string => text
  .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/[\p{Cc}\p{Cf}]/gu, "");

/** Native protocol/key handling, with completed-paste sanitization across input chunks. */
export class SettingsInput extends Input {
  #paste: string | undefined;
  get isPasting(): boolean { return this.#paste !== undefined; }
  clear(): void { this.#paste = undefined; this.setValue(""); }
  override handleInput(data: string): void {
    const start = data.indexOf("\x1b[200~");
    if (this.isPasting || start >= 0) {
      if (!this.isPasting) {
        if (start > 0) super.handleInput(data.slice(0, start));
        this.#paste = "";
        data = data.slice(start + 6);
      }
      this.#paste += data;
      const end = this.#paste!.indexOf("\x1b[201~");
      if (end < 0) return;
      const text = sanitizeInputText(this.#paste!.slice(0, end));
      const remaining = this.#paste!.slice(end + 6);
      this.#paste = undefined;
      super.handleInput(`\x1b[200~${text}\x1b[201~`);
      if (remaining) this.handleInput(remaining);
      return;
    }
    // Input decodes Kitty printable keys and rejects unrecognized control sequences.
    super.handleInput(data);
  }
}
