import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { approveDockerfileLoad, createDockerfileLoadApproval, DOCKERFILE_LOAD_QUESTION } from "./dockerfile-load-approval.ts";
import { formatSettingsDiff } from "./settings-diff.ts";

const question = "Do you approve loading local built image using custom Dockerfile?";
const theme = { fg: (_role: string, text: string) => text } as Theme;
const keys = new KeybindingsManager(TUI_KEYBINDINGS);
function fixture(scope: "project" | "global" = "project", rows = 24, keybindings = keys, selectedTheme = theme) {
  const answers: boolean[] = [], abort = new AbortController();
  let renders = 0;
  const tui = { terminal: { rows, columns: 80 }, requestRender() { renders++; } };
  const view = createDockerfileLoadApproval(scope, tui, selectedTheme, keybindings, (answer) => answers.push(answer), abort.signal);
  return { view, answers, abort, tui, renders: () => renders };
}

for (const scope of ["project", "global"] as const) test(`load approval exact ${scope} content and semantic theme roles, Yes first and No selected`, () => {
  const calls: Array<[string, string]> = [];
  const selectedTheme = { fg: (role: string, text: string) => { calls.push([role, text]); return text; } } as Theme;
  const f = fixture(scope, 24, keys, selectedTheme);
  const label = scope === "project" ? "Project" : "Global";
  assert.equal(DOCKERFILE_LOAD_QUESTION, question);
  assert.deepEqual(f.view.render(80), [question, "", `Scope: ${label}`, "", "Yes", "No"]);
  assert.deepEqual(calls, [["accent", question], ["muted", "Scope: "], ["warning", label], ["text", "Yes"], ["accent", "No"]]);
  assert.equal(f.view.render(80)[2], formatSettingsDiff([{ kind: "scope", label: "Scope", text: label }], selectedTheme)[0]);
  calls.length = 0;
  f.view.handleInput!("\x1b[A"); f.view.render(80);
  assert.deepEqual(calls.slice(-2), [["accent", "Yes"], ["text", "No"]]);
  f.view.dispose();
});

test("load approval Enter on initial No denies once without any affirmative navigation", () => {
  const f = fixture(); f.view.render(80); f.view.handleInput!("\r");
  f.view.handleInput!("\x1b[A"); f.view.render(80); f.view.handleInput!("\r");
  assert.deepEqual(f.answers, [false]);
});

for (const direction of ["\x1b[A", "\x1b[B"]) test(`load approval wraps ${JSON.stringify(direction)} to Yes but requires its current rendered selection`, () => {
  const f = fixture(); f.view.render(80);
  f.view.handleInput!(direction); f.view.handleInput!("\r"); assert.deepEqual(f.answers, []);
  f.view.render(80); f.view.handleInput!("\r"); f.view.handleInput!("\r");
  assert.deepEqual(f.answers, [true]); assert.equal(f.renders(), 1);
});

test("load approval respects injected navigation/confirm/cancel keybindings", () => {
  const custom = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.up": "k", "tui.select.down": "j", "tui.select.confirm": "x", "tui.select.cancel": "q" });
  const f = fixture("project", 24, custom);
  f.view.render(80); f.view.handleInput!("j"); f.view.render(80); f.view.handleInput!("x");
  assert.deepEqual(f.answers, [true]);
  const denied = fixture("project", 24, custom); denied.view.render(80); denied.view.handleInput!("q");
  assert.deepEqual(denied.answers, [false]);
});

for (const action of ["escape", "ctrl-c", "abort", "dispose"] as const) test(`load approval ${action} cannot authorize an affirmative choice`, async () => {
  const f = fixture(); f.view.render(80); f.view.handleInput!("\x1b[A"); f.view.render(80);
  if (action === "abort") { f.abort.abort(); f.view.handleInput!("\r"); await Promise.resolve(); }
  else if (action === "dispose") f.view.dispose();
  else f.view.handleInput!(action === "escape" ? "\x1b" : "\x03");
  f.view.handleInput!("\r");
  assert.deepEqual(f.answers, action === "dispose" ? [] : [false]);
  assert.deepEqual(f.view.render(80), []);
});

test("load approval universally cancels Esc/Ctrl-C even when cancel is rebound", () => {
  const custom = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "q" });
  for (const cancel of ["\x1b", "\x03"]) {
    const f = fixture("project", 24, custom); f.view.handleInput!(cancel); assert.deepEqual(f.answers, [false]);
  }
});

test("load approval wraps safely and never authorizes clipped, invalidated or resized choices", () => {
  const f = fixture("global", 150);
  for (const width of [1, 2, 10, 24, 80]) {
    const lines = f.view.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.equal(lines.slice(-5).join("").replace(/\s/g, "").endsWith("YesNo"), true);
  }
  f.view.handleInput!("\x1b[A"); f.tui.terminal.rows = 7;
  f.view.render(80); f.view.handleInput!("\r"); assert.deepEqual(f.answers, []);
  f.tui.terminal.rows = 24; f.view.render(80); f.view.invalidate(); f.view.handleInput!("\r"); assert.deepEqual(f.answers, []);
  f.view.render(80); f.tui.terminal.rows = 7; f.view.handleInput!("\r"); assert.deepEqual(f.answers, []);
  f.tui.terminal.rows = 24; f.view.render(80); f.tui.terminal.columns = 10; f.view.handleInput!("\r"); assert.deepEqual(f.answers, []);
  f.view.render(10); f.view.handleInput!("\r"); assert.deepEqual(f.answers, [true]);
});

test("load approval ignores expansion/help keys and has no auxiliary visible content", () => {
  const f = fixture(); const before = f.view.render(80);
  for (const data of ["d", "?", "\x0f", "\t", "\x0e", "\x10"]) f.view.handleInput!(data);
  assert.deepEqual(f.view.render(80), before);
  assert.doesNotMatch(before.join("\n"), /Apply\?|Default|footer|details|inventory|artifact|FROM|Import|restart|notice|help/);
  const source = readFileSync(new URL("./dockerfile-load-approval.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\\x1b|\\u001b|\\033|"success"|"error"|"toolDiffAdded"|"toolDiffRemoved"/);
  f.view.dispose();
});

for (const approve of [false, true]) test(`load TUI helper inline completion approve=${approve}`, async () => {
  let view: ReturnType<typeof createDockerfileLoadApproval> | undefined;
  const ctx = { mode: "tui", hasUI: true, ui: {
    select() { assert.fail("Custom TUI must not invoke native fallback"); },
    custom(factory: any, options: unknown) {
      assert.deepEqual(options, { overlay: false });
      return new Promise<boolean>((done) => {
        view = factory({ terminal: { rows: 24, columns: 80 }, requestRender() {} }, theme, keys, done);
        assert.deepEqual(view!.render(80), [question, "", "Scope: Project", "", "Yes", "No"]);
        if (approve) { view!.handleInput!("\x1b[A"); view!.render(80); }
        view!.handleInput!("\r");
      });
    },
  } } as any;
  assert.equal(await approveDockerfileLoad(ctx, "project", new AbortController().signal), approve);
  assert.deepEqual(view!.render(80), [], "completion disposes the interaction");
});

for (const scope of ["project", "global"] as const) for (const mode of ["rpc", "tui"] as const) test(`load ${mode} fallback uses plain exact ${scope} question with safe No-first native order`, async () => {
  let calls = 0;
  const ctx = { mode, hasUI: true, ui: {
    ...(mode === "rpc" ? { custom() { assert.fail("RPC must not use custom components"); } } : {}),
    async select(title: string, choices: string[], options: { signal: AbortSignal }) {
      calls++; assert.equal(title, `${question}\n\nScope: ${scope === "project" ? "Project" : "Global"}`);
      assert.deepEqual(choices, ["No", "Yes"]); assert.deepEqual(Object.keys(options), ["signal"]);
      assert.doesNotMatch(title, /\x1b|Apply\?|FROM|artifact|Default/); return "Yes";
    },
  } } as any;
  assert.equal(await approveDockerfileLoad(ctx, scope, new AbortController().signal), true); assert.equal(calls, 1);
});

for (const response of ["No", undefined, "yes", "Project", true]) test(`load fallback only exact Yes authorizes, response=${String(response)}`, async () => {
  const ctx = { mode: "rpc", hasUI: true, ui: { async select() { return response; } } } as any;
  assert.equal(await approveDockerfileLoad(ctx, "project", new AbortController().signal), false);
});

for (const mode of ["print", "json", "tui", "rpc"]) test(`load helper no-UI/${mode} fails closed without accessing a dialog`, async () => {
  const ctx = { mode, hasUI: !["tui", "rpc"].includes(mode), ui: new Proxy({}, { get() { assert.fail("No prompt permitted"); } }) } as any;
  assert.equal(await approveDockerfileLoad(ctx, "project", new AbortController().signal), false);
});

test("load helper pre-abort and invalid scope fail closed without accessing UI", async () => {
  const ctx = { mode: "tui", hasUI: true, ui: new Proxy({}, { get() { assert.fail("No prompt permitted"); } }) } as any;
  const abort = new AbortController(); abort.abort();
  assert.equal(await approveDockerfileLoad(ctx, "project", abort.signal), false);
  assert.equal(await approveDockerfileLoad(ctx, "invalid" as any, new AbortController().signal), false);
});

test("load helper cannot authorize a forged custom return without rendered Yes confirmation", async () => {
  const ctx = { mode: "tui", hasUI: true, ui: { async custom() { return true; } } } as any;
  assert.equal(await approveDockerfileLoad(ctx, "project", new AbortController().signal), false);
});

for (const deferFactory of [false, true]) test(`load helper abort settles and disposes even with deferred factory=${deferFactory}`, async () => {
  const abort = new AbortController();
  let factory!: (...args: any[]) => any, complete!: (value: boolean) => void;
  let view: ReturnType<typeof createDockerfileLoadApproval> | undefined;
  const answers: boolean[] = [];
  const mount = () => { view = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, keys, (value: boolean) => { answers.push(value); complete(value); }); };
  const ctx = { mode: "tui", hasUI: true, ui: { custom(create: any) {
    factory = create;
    return new Promise<boolean>((resolve) => { complete = resolve; if (!deferFactory) mount(); });
  } } } as any;
  const pending = approveDockerfileLoad(ctx, "project", abort.signal);
  abort.abort(); assert.equal(await pending, false);
  if (deferFactory) mount();
  await Promise.resolve();
  assert.deepEqual(answers, [false]); assert.deepEqual(view!.render(80), []);
  view!.handleInput!("\x1b[A"); view!.handleInput!("\r"); assert.deepEqual(answers, [false]);
});

test("load RPC abort does not trust a late Yes from a client ignoring cancellation", async () => {
  const abort = new AbortController(); let resolve!: (value: string) => void;
  const ctx = { mode: "rpc", hasUI: true, ui: { select() { return new Promise<string>((done) => { resolve = done; }); } } } as any;
  const pending = approveDockerfileLoad(ctx, "project", abort.signal);
  abort.abort(); assert.equal(await pending, false); resolve("Yes"); await Promise.resolve();
});
