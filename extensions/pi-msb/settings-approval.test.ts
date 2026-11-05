import assert from "node:assert/strict";
import { test } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { approveSettings, SettingsApproval } from "./settings-approval.ts";
import type { SettingsDiffLine } from "./settings-diff.ts";

const reviewLines = (review: string): SettingsDiffLine[] => review.split("\n").map((text) => ({ kind: "context", text }));
const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const keys = new KeybindingsManager(TUI_KEYBINDINGS);
function view(review: SettingsDiffLine[] = reviewLines("short review")) {
  const terminal = { rows: 24, columns: 80 };
  const results: boolean[] = [];
  const component = new SettingsApproval(review, { terminal, requestRender() {} } as any, theme, keys, (value) => results.push(value));
  return { component, terminal, results };
}

test("settings approval: native-style compact question, padded vertical No/Yes, no dashboard or short-review status", () => {
  const f = view([
    { kind: "context", text: "project · secrets · upsert · TOKEN" },
    { kind: "removed", label: "allow_hosts", text: "old.example" },
    { kind: "added", label: "allow_hosts", text: "new.example" },
  ]);
  const rows = f.component.render(80);
  assert.ok(rows.length < f.terminal.rows);
  assert.equal(rows[0], "─".repeat(80)); assert.equal(rows.at(-1), rows[0]);
  assert.match(rows.join("\n"), /\n Allow configuration change\? *\n\n project/);
  assert.match(rows.join("\n"), /\n → No\n   Yes\n/);
  assert.doesNotMatch(rows.join("\n"), /MICROSANDBOX|End seen|Read to end|PgUp|Cancel|Approve|\[ No \]/);
});

test("settings approval: default Enter, Escape and Ctrl+C reject and settle once", () => {
  for (const key of ["\r", "\x1b", "\x03"]) {
    const f = view(); f.component.render(80); f.component.handleInput(key); f.component.dispose(); f.component.handleInput("\r");
    assert.deepEqual(f.results, [false]);
  }
});

test("settings approval: native arrow/j/k choices clamp instead of wrapping; only explicit Yes authorizes", () => {
  const f = view(); f.component.render(80);
  f.component.handleInput("\x1b[A"); assert.match(f.component.render(80).join("\n"), /→ No/);
  f.component.handleInput("\x1b[B"); f.component.handleInput("\x1b[B");
  assert.match(f.component.render(80).join("\n"), /→ Yes/);
  f.component.handleInput("k"); assert.match(f.component.render(80).join("\n"), /→ No/);
  f.component.handleInput("j"); f.component.handleInput("\r"); assert.deepEqual(f.results, [true]);
});

test("settings approval: long/wrapped review gates Yes until its end is visible, without preselecting Yes", () => {
  const f = view(reviewLines(Array.from({ length: 80 }, (_, n) => `line ${n}: ${"long wrapped review ".repeat(10)}`).join("\n")));
  assert.match(f.component.render(80).join("\n"), /Read to end for Yes/);
  f.component.handleInput("j"); assert.match(f.component.render(80).join("\n"), /→ No/);
  f.component.handleInput("G"); assert.doesNotMatch(f.component.render(80).join("\n"), /Read to end/);
  f.component.handleInput("\r"); assert.deepEqual(f.results, [false]);
  const approved = view(fixtureLongReview()); approved.component.render(80); approved.component.handleInput("G"); approved.component.render(80);
  approved.component.handleInput("j"); approved.component.handleInput("\r"); assert.deepEqual(approved.results, [true]);
});

function fixtureLongReview(): SettingsDiffLine[] {
  return Array.from({ length: 60 }, (_, n) => ({ kind: n % 2 ? "warning" : "added", label: n % 2 ? undefined : "allow_hosts", text: n % 2 ? `warning-${n}: relevant consequence` : `host-${n}.example` }));
}

test("settings approval: all long values and warnings remain reachable across wrapping/resize; unusable views reject", () => {
  const f = view(fixtureLongReview());
  for (const [width, height] of [[1, 1], [24, 2], [32, 10], [80, 24], [120, 40]]) {
    f.terminal.rows = height!;
    const lines = f.component.render(width!);
    assert.ok(lines.length <= height!); assert.ok(lines.every((line) => visibleWidth(line) <= width!));
  }
  f.terminal.rows = 10; f.component.handleInput("g");
  let observed = "";
  for (let n = 0; n < 200; n++) { observed += f.component.render(32).join("\n") + "\n"; f.component.handleInput("\x1b[6;5~"); }
  for (let n = 0; n < 60; n++) assert.ok(observed.includes(n % 2 ? `warning-${n}` : `host-${n}.example`), String(n));
  f.component.handleInput("j"); f.terminal.rows = 2; f.component.render(24); f.component.handleInput("\r"); assert.deepEqual(f.results, [false]);
});

test("settings approval: uses injected selector keybindings and keeps custom navigation hints", () => {
  const custom = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "ctrl+n", "tui.select.confirm": "ctrl+y" });
  const results: boolean[] = [];
  const component = new SettingsApproval(reviewLines("review"), { terminal: { rows: 24, columns: 80 }, requestRender() {} } as any, theme, custom, (value) => results.push(value));
  assert.match(component.render(80).join("\n"), /ctrl\+y select/);
  component.handleInput("\x0e"); component.handleInput("\x19"); assert.deepEqual(results, [true]);
});

test("settings approval: abort closes compact custom overlay, cleans listener; errors never downgrade to native title", async () => {
  const abort = new AbortController(); let finished = 0; let selected = 0; let component: SettingsApproval | undefined;
  let ready!: () => void; const opened = new Promise<void>((resolve) => { ready = resolve; });
  const ctx = { hasUI: true, mode: "tui", ui: {
    custom: async (factory: any, options: any) => new Promise<boolean>((resolve) => {
      component = factory({ terminal: { rows: 24, columns: 80 }, requestRender() {} }, theme, keys, (value: boolean) => { finished++; resolve(value); });
      assert.equal(options.overlay, true); assert.deepEqual(options.overlayOptions(), { anchor: "bottom-center", width: "100%", maxHeight: 20, margin: 0 }); ready();
    }),
    select: async () => { selected++; return "Yes"; },
  } } as unknown as ExtensionContext;
  const pending = approveSettings(ctx, reviewLines("review"), abort.signal); await opened; abort.abort();
  assert.equal(await pending, false); component!.dispose(); abort.abort(); assert.equal(finished, 1); assert.equal(selected, 0);
  ctx.ui.custom = async () => { throw new Error("custom failure"); };
  await assert.rejects(approveSettings(ctx, reviewLines("review"), new AbortController().signal), /custom failure/); assert.equal(selected, 0);
});

test("settings approval: only interactive RPC/TUI supports mutation approval", async () => {
  let calls = 0;
  for (const mode of ["print", "json"] as const) {
    const ctx = { hasUI: true, mode, ui: { select: async () => { calls++; return "Yes"; } } } as unknown as ExtensionContext;
    assert.equal(await approveSettings(ctx, reviewLines("review"), new AbortController().signal), false);
  }
  assert.equal(calls, 0);
});

test("settings approval: RPC question uses compact plain diff, No first and explicit Yes only", async () => {
  for (const answer of [undefined, "No", "Approve", "Yes"]) {
    let text = "";
    const ctx = { hasUI: true, mode: "rpc", ui: { select: async (title: string, choices: string[]) => {
      text = title; assert.deepEqual(choices, ["No", "Yes"]); return answer;
    } } } as unknown as ExtensionContext;
    assert.equal(await approveSettings(ctx, [{ kind: "removed", label: "cpus", text: "2" }, { kind: "added", label: "cpus", text: "4" }], new AbortController().signal), answer === "Yes");
    assert.match(text, /Allow configuration change\?\n\n- cpus: 2\n\+ cpus: 4/); assert.doesNotMatch(text, /\x1b|"before"|"after"/);
  }
});


test("settings approval: shrinking below the usable size rejects even before the resize repaint", () => {
  const f = view(); f.component.render(80); f.component.handleInput("j");
  f.terminal.rows = 2; f.terminal.columns = 24;
  f.component.handleInput("\r"); assert.deepEqual(f.results, [false]);
});
