import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { approveSettings, SettingsApproval } from "./settings-approval.ts";

const reviewLines = (review: string) => review.split("\n").map((text) => ({ kind: "context" as const, text }));
const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
function view(review = "short review") {
  const terminal = { rows: 12 };
  const results: boolean[] = [];
  const component = new SettingsApproval(reviewLines(review), { terminal, requestRender() {} } as any, theme, (value) => results.push(value));
  return { component, terminal, results };
}

test("settings approval: default Enter and Escape cancel, settle once even on dispose", () => {
  for (const key of ["\r", "\x1b"]) {
    const f = view(); f.component.render(80); f.component.handleInput(key); f.component.dispose(); f.component.handleInput("\r");
    assert.deepEqual(f.results, [false]);
  }
});

test("settings approval: long/wrapped review requires end visibility and deliberate selection", () => {
  const f = view(Array.from({ length: 80 }, (_, n) => `line ${n}: ${"long wrapped review ".repeat(10)}`).join("\n"));
  assert.match(f.component.render(40).join("\n"), /Approve disabled/);
  f.component.handleInput("\t"); f.component.handleInput("G");
  assert.match(f.component.render(40).join("\n"), /End seen/);
  f.component.handleInput("\r"); assert.deepEqual(f.results, [false]);
  const approved = view("one\ntwo"); approved.component.render(80); approved.component.handleInput("\t"); approved.component.handleInput("\r");
  assert.deepEqual(approved.results, [true]);
});

test("settings approval: unusable viewports fail closed; responsive frames stay exactly bounded", () => {
  const f = view("日本語 ".repeat(1000));
  for (const [width, height] of [[1, 1], [24, 2], [32, 10], [80, 24], [120, 40]]) {
    f.terminal.rows = height!;
    const lines = f.component.render(width!);
    assert.equal(lines.length, height); assert.ok(lines.every((line) => visibleWidth(line) === width));
  }
  f.component.handleInput("G"); f.component.render(80); f.component.handleInput("\t");
  f.terminal.rows = 2; f.component.render(24); f.component.handleInput("\r"); assert.deepEqual(f.results, [false]);
});

test("settings approval: abort closes custom UI, cleans listener; errors never downgrade to selector", async () => {
  const abort = new AbortController(); let finished = 0; let selected = 0; let component: SettingsApproval | undefined;
  let ready!: () => void; const opened = new Promise<void>((resolve) => { ready = resolve; });
  const ctx = { hasUI: true, mode: "tui", ui: {
    custom: async (factory: any) => new Promise<boolean>((resolve) => { component = factory({ terminal: { rows: 12 }, requestRender() {} }, theme, {}, (value: boolean) => { finished++; resolve(value); }); ready(); }),
    select: async () => { selected++; return "Approve"; },
  } } as unknown as ExtensionContext;
  const pending = approveSettings(ctx, reviewLines("review"), abort.signal); await opened; abort.abort();
  assert.equal(await pending, false); component!.dispose(); abort.abort(); assert.equal(finished, 1); assert.equal(selected, 0);
  ctx.ui.custom = async () => { throw new Error("custom failure"); };
  await assert.rejects(approveSettings(ctx, reviewLines("review"), new AbortController().signal), /custom failure/); assert.equal(selected, 0);
});

test("settings approval: only interactive RPC/TUI supports mutation approval", async () => {
  let calls = 0;
  for (const mode of ["print", "json"] as const) {
    const ctx = { hasUI: true, mode, ui: { select: async () => { calls++; return "Approve"; } } } as unknown as ExtensionContext;
    assert.equal(await approveSettings(ctx, reviewLines("review"), new AbortController().signal), false);
  }
  assert.equal(calls, 0);
});

test("settings approval: every changed value remains reachable through wrapping/scrolling, including after resize", () => {
  const terminal = { rows: 10 }; const results: boolean[] = [];
  const hosts = Array.from({ length: 60 }, (_, n) => `host-${n}.example`);
  const component = new SettingsApproval(hosts.map((text) => ({ kind: "added", label: "allow_hosts", text })), { terminal, requestRender() {} } as any, theme, (value) => results.push(value));
  let observed = "";
  for (let n = 0; n < 300; n++) { observed += component.render(32).join("\n") + "\n"; component.handleInput("j"); }
  for (const host of hosts) assert.ok(observed.includes(host), host);
  component.handleInput("g"); component.render(80); terminal.rows = 2; component.render(24);
  component.handleInput("\t"); component.handleInput("\r"); assert.deepEqual(results, [false]);
});

test("settings approval: RPC uses the same compact plain diff with Cancel first", async () => {
  let text = "";
  const ctx = { hasUI: true, mode: "rpc", ui: { select: async (title: string, choices: string[]) => {
    text = title; assert.deepEqual(choices, ["Cancel", "Approve"]); return "Cancel";
  } } } as unknown as ExtensionContext;
  assert.equal(await approveSettings(ctx, [{ kind: "removed", label: "cpus", text: "2" }, { kind: "added", label: "cpus", text: "4" }], new AbortController().signal), false);
  assert.match(text, /MICROSANDBOX · Review change\n- cpus: 2\n\+ cpus: 4/); assert.doesNotMatch(text, /\x1b|"before"|"after"/);
});
