import assert from "node:assert/strict";
import test from "node:test";
import { SettingsInput } from "./settings-input.ts";
import { MaskedInput } from "./masked-input.ts";

test("ordinary fields accept Kitty printable keys and sanitized chunked bracketed paste", () => {
  const input = new SettingsInput();
  input.handleInput("\x1b[97u"); assert.equal(input.getValue(), "a");
  input.clear();
  for (const chunk of ["\x1b[200~api.", "example", ".com\x1b[201~"]) input.handleInput(chunk);
  assert.equal(input.getValue(), "api.example.com"); assert.equal(input.isPasting, false);
  input.clear();
  for (const chunk of ["\x1b[200~a\x1b[", "2Jb\x1b]52;c;BAD\x07c\x1b[20", "1~"]) input.handleInput(chunk);
  assert.equal(input.getValue(), "abc"); assert.doesNotMatch(input.render(24).join(""), /BAD|2J/);
});

test("masked fields decode Kitty printable keys without rendering them and retain paste state", () => {
  const input = new MaskedInput(); input.focused = true;
  input.handleInput("\x1b[97u"); input.handleInput("\x1b[98u");
  assert.doesNotMatch(input.render(24).join(""), /ab/); assert.equal(input.take(), "ab");
  for (const chunk of ["\x1b[200~secret", "\x1b[2J", "_sentinel\x1b[201~"]) input.handleInput(chunk);
  assert.doesNotMatch(input.render(24).join(""), /secret|sentinel|2J/);
  assert.equal(input.take(), "secret_sentinel"); assert.equal(input.isPasting, false);
  input.handleInput("\x1b[200~cancelled"); input.clear(); assert.equal(input.isPasting, false); assert.equal(input.take(), "");
});
