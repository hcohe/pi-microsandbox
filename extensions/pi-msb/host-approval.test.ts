import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { highlightCode, initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { Container, isViewportTUI, KeybindingsManager, ScrollView, Text, TUI_KEYBINDINGS, TuiAltScreen, TuiMainScreen, visibleWidth, VStack, type Terminal } from "@earendil-works/pi-tui";
import { approveHostExecution, createHostApproval } from "./host-approval.ts";
import { hostApprovalMessage } from "./tools.ts";

process.env.PI_PACKAGE_DIR = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent", import.meta.url));
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const keys = new KeybindingsManager(TUI_KEYBINDINGS);
const plainTheme = { fg: (_token: string, text: string) => text, bold: (text: string) => text } as Theme;
const message = (command = "msb --help", theme?: Theme) => hostApprovalMessage("bash", { command, timeout: 10, execution_target: "host" }, "/work/repo", theme);
function palette(appearance: "dark" | "light"): Theme {
  const json = JSON.parse(readFileSync(new URL(`../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${appearance}.json`, import.meta.url), "utf8"));
  const resolve = (value: string | number): string | number => typeof value === "string" && json.vars[value] !== undefined ? resolve(json.vars[value]) : value;
  const colors = Object.fromEntries(Object.entries(json.colors).map(([key, value]) => [key, resolve(value as string | number)]));
  return new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor");
}
// Track effective terminal foreground independently of the formatter's reset-restoration logic.
function foregrounds(text: string): { colors: Array<string | undefined>; final?: string } {
  const colors: Array<string | undefined> = []; let foreground: string | undefined;
  for (const match of text.matchAll(/\x1b\[([0-9;]*)m|([^\x1b])/gu)) {
    if (match[1] === undefined) { if (match[2] !== "\n") colors.push(foreground); continue; }
    const codes = match[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code === 0 || code === 39) foreground = undefined;
      else if (code >= 30 && code <= 37 || code >= 90 && code <= 97) foreground = String(code);
      else if (code === 38 && (codes[i + 1] === 2 || codes[i + 1] === 5)) {
        const count = codes[i + 1] === 2 ? 5 : 3;
        foreground = codes.slice(i, i + count).join(";"); i += count - 1;
      }
    }
  }
  return { colors, final: foreground };
}
function assertGreenBaseWithLexerTokens(code: string, sanitized: string, theme: Pick<Theme, "fg">) {
  const raw = highlightCode(sanitized, "bash").join("\n");
  const green = foregrounds(theme.fg("success", "base")).colors[0];
  assert.ok(green, "the supplied theme must define a base foreground");
  assert.deepEqual(foregrounds(code).colors, foregrounds(raw).colors.map((color) => color ?? green),
    "every default span is green while every lexer token keeps its own color");
  assert.equal(strip(code), sanitized);
  for (const line of code.split("\n")) assert.equal(foregrounds(line).final, undefined, "every line terminates its foreground");
}
function commandBody(text: string): string {
  const lines = text.split("\n");
  return lines.slice(lines.findIndex((line) => strip(line) === "Command:") + 2).join("\n");
}
function fixture(text = message(), theme = plainTheme, bindings = keys) {
  const answers: Array<string | undefined> = [], abort = new AbortController();
  const terminal = { rows: 24 };
  const view = createHostApproval(() => text, { requestRender() {}, terminal }, theme, bindings, (answer) => answers.push(answer), abort.signal);
  return { view, answers, abort, terminal };
}

for (const appearance of ["dark", "light"] as const) test(`host approval is footerless with native No/Yes colors and exact command in ${appearance}`, () => {
  initTheme(appearance, false);
  const theme = palette(appearance), f = fixture(message("msb --help", theme), theme);
  const lines = f.view.render(120), plain = lines.map(strip);
  assert.equal(lines[0], theme.fg("accent", theme.bold("Allow host execution?")));
  assert.ok(plain.includes("Tool: bash")); assert.ok(plain.includes("Working directory: /work/repo"));
  assertGreenBaseWithLexerTokens(lines[plain.indexOf("msb --help")]!, "msb --help", theme);
  assert.equal(plain.find((line) => line.startsWith("Warning:")), "Warning: this operation runs on the host and bypasses any isolation.");
  assert.deepEqual(lines.slice(-2), [theme.fg("accent", "→ ") + theme.fg("accent", "No"), `  ${theme.fg("text", "Yes")}`]);
  assert.doesNotMatch(plain.join("\n"), /Timeout|navigate|select|cancel|↑↓|Ctrl|\d+–\d+\/\d+/);
  f.view.handleInput!("\x1b[B");
  assert.deepEqual(f.view.render(120).slice(-2), [`  ${theme.fg("text", "No")}`, theme.fg("accent", "→ ") + theme.fg("accent", "Yes")]);
  f.view.handleInput!("\r"); f.view.handleInput!("\r"); assert.deepEqual(f.answers, ["Yes"]); f.view.dispose();
});

test("host approval defaults to No, handles Escape/Ctrl+C/abort/disposal and injected selection keybindings", async () => {
  for (const action of ["default", "escape", "ctrlC", "abort", "dispose"] as const) {
    const f = fixture(); f.view.render(80);
    if (action === "abort") { f.abort.abort(); await Promise.resolve(); }
    else if (action === "dispose") f.view.dispose();
    else f.view.handleInput!(action === "default" ? "\r" : action === "escape" ? "\x1b" : "\x03");
    f.view.handleInput!("\x1b[B"); f.view.render(80); f.view.handleInput!("\r");
    assert.deepEqual(f.answers, action === "dispose" ? [] : [action === "default" ? "No" : undefined]); f.view.dispose();
  }
  const custom = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "j", "tui.select.confirm": "x", "tui.select.cancel": "q" });
  const f = fixture(message(), plainTheme, custom);
  f.view.handleInput!("j"); f.view.handleInput!("x"); assert.deepEqual(f.answers, [], "Yes requires a rendered choice");
  f.view.render(80); f.view.handleInput!("x"); assert.deepEqual(f.answers, ["Yes"]); f.view.dispose();
  const canceled = fixture(message(), plainTheme, custom); canceled.view.handleInput!("q"); assert.deepEqual(canceled.answers, [undefined]);
});

for (const appearance of ["dark", "light"] as const) test(`host approval wraps every syntax-highlighted long-command byte and whitespace without a footer or clipped approval in ${appearance}`, () => {
  initTheme(appearance, false); const theme = palette(appearance);
  const source = Array.from({ length: 60 }, (_, index) => `printf 'row-${index}-  ${"abcdef0123456789".repeat(4)}'  \\`).join("\n");
  const f = fixture(message(source, theme), theme);
  for (const width of [1, 2, 7, 20, 80]) {
    const lines = f.view.render(width); assert.ok(lines.length <= 18);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  f.terminal.rows = 8;
  f.view.handleInput!("\x1b[B"); f.view.render(1); f.view.handleInput!("\r");
  assert.deepEqual(f.answers, [], "hidden Yes cannot authorize");
  f.terminal.rows = 24;
  const seen = new Set<string>();
  for (let i = 0; i < 150; i++) {
    for (const line of f.view.render(20)) seen.add(strip(line));
    f.view.handleInput!("\x0e");
  }
  for (const line of source.split("\n")) for (let column = 0; column < line.length; column += 20) {
    assert.ok(seen.has(line.slice(column, column + 20)), `unreachable command fragment ${line.slice(column, column + 20)}`);
  }
  assert.doesNotMatch([...seen].join("\n"), /Timeout|navigate|select|cancel|↑↓|\d+–\d+\/\d+/);
  const end = f.view.render(20);
  f.view.handleInput!("\x1b[5~"); assert.notDeepEqual(f.view.render(20), end);
  f.view.handleInput!("\x1b[6~"); assert.deepEqual(f.view.render(20), end);
  f.view.invalidate(); f.view.render(120); f.view.handleInput!("\r"); assert.deepEqual(f.answers, ["Yes"]); f.view.dispose();
  const wide = fixture(message("printf '界🙂'  \\", theme), theme);
  for (const width of [1, 2, 3, 7]) assert.ok(wide.view.render(width).every((line) => visibleWidth(line) <= width));
  wide.view.dispose();
});

test("host approval adapter uses plain No-first selection for RPC/select-only TUI and fails closed without UI or on unexpected responses", async () => {
  for (const mode of ["rpc", "tui"] as const) for (const answer of ["No", "Yes", undefined, "unexpected"]) {
    const ctx = { hasUI: true, mode, ui: { ...(mode === "rpc" ? { custom() { assert.fail("RPC cannot use custom TUI"); } } : {}), async select(question: string, choices: string[]) {
      assert.equal(question, `Allow host execution?\n\n${message()}`);
      assert.doesNotMatch(question, /Timeout|\x1b/); assert.deepEqual(choices, ["No", "Yes"]); return answer;
    } } } as any;
    assert.equal(await approveHostExecution(ctx, () => message()), answer === "Yes" || answer === "No" ? answer : undefined);
  }
  for (const mode of ["rpc", "tui", "json", "print"] as const) {
    const ctx = { hasUI: false, mode, ui: { select() { assert.fail("no UI"); }, custom() { assert.fail("no UI"); } } } as any;
    assert.equal(await approveHostExecution(ctx, () => message()), undefined);
  }
  const abort = new AbortController(); abort.abort();
  assert.equal(await approveHostExecution({ hasUI: true, mode: "tui", signal: abort.signal } as any, () => message()), undefined);
});

test("host approval custom UI is inline, disposes on return/failure/abort and never falls back to another prompt", async () => {
  for (const action of ["yes", "no", "abort", "failure"] as const) {
    const abort = new AbortController(); let disposals = 0, calls = 0, returned = false;
    const ctx = { hasUI: true, mode: "tui", signal: abort.signal, ui: { select() { assert.fail("no fallback after custom UI"); }, custom(factory: any, options: any) {
      calls++; assert.equal(options.overlay, false); assert.equal(options.overlayOptions, undefined);
      assert.deepEqual(options.blocked, { kind: "permission", message: "Allow host execution?" });
      if (action === "abort") abort.abort();
      return new Promise((resolve, reject) => {
        const view = factory({ requestRender() {}, terminal: { rows: 24 } }, plainTheme, keys, (answer: string | undefined) => { assert.ok(returned); resolve(answer); });
        const dispose = view.dispose.bind(view); view.dispose = () => { disposals++; dispose(); };
        returned = true;
        if (action === "failure") reject(new Error("UI factory failure"));
        else if (action !== "abort") { view.render(80); if (action === "yes") { view.handleInput("\x1b[B"); view.render(80); } view.handleInput("\r"); }
      });
    } } } as any;
    if (action === "failure") await assert.rejects(approveHostExecution(ctx, () => message()), /UI factory failure/);
    else assert.equal(await approveHostExecution(ctx, () => message()), action === "yes" ? "Yes" : action === "no" ? "No" : undefined);
    assert.equal(calls, 1); assert.equal(disposals, 1);
  }
});

for (const Renderer of [TuiMainScreen, TuiAltScreen]) test(`footerless host approval in ${Renderer.name} preserves the application footer, scrolling, resize and confirmation`, async () => {
  let input!: (data: string) => void, resize!: () => void;
  const terminal = { columns: 70, rows: 24, kittyProtocolActive: false,
    start(onInput, onResize) { input = onInput; resize = onResize; }, stop() {}, async drainInput() {},
    write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  } satisfies Terminal;
  const tui = new Renderer(terminal, false, "/tmp"), editor = new Container(), answers: Array<string | undefined> = [];
  const transcript = new ScrollView(new Text("Transcript", 0, 0), { primary: true });
  const root = new VStack([{ component: transcript, grow: 1, shrink: 1, minSize: 1 }, { component: editor, shrink: 0 }, new Text("Application footer", 0, 0)]);
  tui.addChild(root); if (isViewportTUI(tui)) tui.setLayoutRoot(root);
  const view = createHostApproval(() => message(Array.from({ length: 45 }, (_, index) => `echo host-row-${index}`).join("\n")), tui, plainTheme, keys, (answer) => answers.push(answer));
  editor.addChild(view); tui.setFocus(view);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
  try {
    tui.start(); await tick(); assert.equal(tui.hasOverlay(), false);
    assert.ok(root.render(70).some((line) => line.includes("Application footer")));
    assert.ok(strip(view.render(70).join("\n")).endsWith("→ No\n  Yes"));
    input("\x1b[B"); await tick(); const start = view.render(70);
    input("\x0e"); await tick(); assert.notDeepEqual(view.render(70), start);
    input("\x10"); await tick(); assert.deepEqual(view.render(70), start);
    terminal.columns = 1; terminal.rows = 8; resize(); await tick(); input("\r"); await tick(); assert.deepEqual(answers, []);
    terminal.columns = 70; terminal.rows = 24; resize(); await tick(); input("\r"); await tick(); assert.deepEqual(answers, ["Yes"]);
  } finally { view.dispose(); tui.stop(); }
});

for (const appearance of ["dark", "light"] as const) test(`host approval Bash lexer styles tokens while preserving sanitized controls, Unicode, blank lines and trailing newline in ${appearance}`, () => {
  initTheme(appearance, false); const theme = palette(appearance);
  const command = `printf "%s\\n" "hello"\n\nprintf '%s' '界🙂'\n# visible comment\nprintf '%s' 'bad\x1b[2J\t\u202e'\n`;
  const plain = message(command), styled = message(command, theme);
  const sanitized = plain.split("Command:\n\n")[1]!;
  const lines = styled.split("\n");
  const code = lines.slice(lines.findIndex((line) => strip(line) === "Command:") + 2).join("\n");
  assertGreenBaseWithLexerTokens(code, sanitized, theme);
  assert.equal(strip(code), sanitized);
  assert.equal(strip(styled), plain);
  assert.ok(sanitized.includes("\\u{1b}[2J\\u{9}\\u{202e}"));
  assert.ok(sanitized.endsWith("\n"));
  const colors = new Set(code.match(/\x1b\[(?:38;2;|38;5;)[^m]*m/g));
  assert.ok(colors.size >= 2, "the real lexer must distinguish token colors, not paint one flat string color");
  assert.notEqual(code, theme.fg("syntaxString", sanitized));
  assert.doesNotMatch(plain, /\x1b/);
});

for (const appearance of ["dark", "light"] as const) test(`host Bash base foreground is theme green before, between and after tokens in ${appearance}`, () => {
  initTheme(appearance, false); const theme = palette(appearance);
  const command = `raw_before 'literal' raw_between "second" raw_after\nraw_tail`;
  const rawColors = foregrounds(highlightCode(command, "bash").join("\n")).colors;
  assert.equal(rawColors[0], undefined); assert.equal(rawColors.at(-1), undefined);
  assert.ok(rawColors.some((color) => color !== undefined), "fixture must contain colored tokens as well as raw spans");
  const code = commandBody(message(command, theme));
  assertGreenBaseWithLexerTokens(code, command, theme);
  assert.notEqual(code, theme.fg("success", command), "tokens must not be flattened to green");
});

test("host Bash honors a custom green theme adapter and multiline token colors without mutating the lexer theme", () => {
  initTheme("dark", false);
  const theme: Pick<Theme, "fg" | "bold"> = {
    fg: (role, text) => role === "success" ? `\x1b[38;2;12;203;47m${text}\x1b[0m` : text,
    bold: (text) => text,
  };
  const command = "raw_before 'first\nsecond' raw_after";
  const raw = highlightCode(command, "bash").join("\n");
  const code = commandBody(hostApprovalMessage("bash", { command }, "/work/repo", theme));
  assertGreenBaseWithLexerTokens(code, command, theme);
  assert.equal(highlightCode(command, "bash").join("\n"), raw, "custom base coloring never mutates global syntax colors");
  assert.equal(commandBody(hostApprovalMessage("bash", { command }, "/work/repo")), command);
  assert.doesNotMatch(hostApprovalMessage("bash", { command }, "/work/repo"), /\x1b/);
  const simple = "raw_before 'literal' raw_after";
  assert.equal(commandBody(hostApprovalMessage("bash", { command: simple }, "/work/repo", plainTheme)),
    highlightCode(simple, "bash").join("\n"), "transparent fg/bold adapters need no private theme API");
});
