import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, resolveConfig, toEffectiveToml, parseTomlConfig } from "./config.ts";
import { ControlPanel, openControlPanel, closeControlPanel } from "./control-panel.ts";
import { SettingsEditor, SETTINGS_PATHS } from "./settings.ts";
import { SETTINGS_FIELDS } from "./settings-fields.ts";
import { MaskedInput } from "./masked-input.ts";
import { createMsbIntegration } from "./control.ts";
import { fakeSdk } from "../../test/fake-msb-sdk.ts";
import { createCommandHandler } from "./command.ts";
import type { MsbControl } from "./types.ts";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text } as any;
async function fixture(t: any, theme = plainTheme, native = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "msb-panel-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const input = { cwd, repoRoot: cwd, configDirName: ".pi", projectTrusted: true, env: {}, agentDir: join(root, "agent") };
  const calls: string[] = []; const sdk = fakeSdk(calls);
  const integration = native ? createMsbIntegration({ sessionId: "panel-session", cwd, agentDir: input.agentDir, configDirName: ".pi", env: { PI_MSB_ALLOW_HOST_EXECUTION: "false", PI_MSB_FALLBACK_MODE: "block" }, sdkLoader: async () => sdk, acquireOwnerLock: async () => ({ path: join(root, "owner.lock"), release: async () => {} }) }) : undefined;
  if (integration) { await integration.configureSession({ sessionId: "panel-session", cwd, projectTrusted: true }); t.after(() => integration.manager.shutdown()); }
  const settings = integration?.control.settings ?? new SettingsEditor(input, "panel-session");
  const control: MsbControl = integration?.control ?? {
    settings, getState: () => ({ status: "active", info: null }),
    getEffectiveConfig: () => ({ config: structuredClone(DEFAULT_CONFIG), warnings: [], provenance: {} }) as any,
    getEffectiveConfigToml: () => toEffectiveToml(control.getEffectiveConfig()),
    reload: async () => { calls.push("reload"); }, setEnabled: async (enabled) => { calls.push(`enabled:${enabled}`); },
    pruneNow: async () => { calls.push("prune"); return { inspected: 2, removed: ["stale"], kept: ["live"], errors: [] }; },
    getLogs: async () => "redacted logs", setOverride: async () => {}, unsetOverride: async () => {}, resetOverrides: async () => { calls.push("reset"); },
  };
  const ctx = { waitForIdle: async () => { calls.push("idle"); }, ui: { notify() {} } } as any;
  const terminal = { rows: 24, columns: 80 }; let closed = false;
  const draft = await settings.open("temporary"); const paths: Record<string, string> = {};
  for (const scope of ["global", "project"] as const) { const source = await settings.open(scope); paths[scope] = source.path!; source.discard(); }
  const panel = new ControlPanel({ draft, control, ctx, tui: { terminal, requestRender() {} } as any, theme, paths, done: () => { closed = true; } });
  const key = async (data: string) => { panel.handleInput(data); await tick(); await panel.waitForIdle(); };
  const text = () => stripTerminalSequences(panel.render(terminal.columns).join("\n"));
  // Inspect the selected label without depending on wrapping at the tested viewport size.
  const full = () => { const rows = terminal.rows; terminal.rows = 300; const result = stripTerminalSequences(panel.render(160).join("\n")); terminal.rows = rows; panel.render(terminal.columns); return result; };
  const selected = () => full().split("\n").find((line) => line.startsWith("> "))?.slice(2).replace(/^\s*[▾▸]?\s*/, "").trimEnd() ?? "";
  const seek = async (label: string) => { for (let n = 0; n < 300; n++) { if (selected().startsWith(label)) return; await key("j"); } assert.fail(`unreachable row: ${label}\n${text()}`); };
  const choose = async (label: string) => { await seek(label); await key("\r"); };
  const tree = async () => { for (let n = 0; n < 8 && !full().includes("▾ Configuration") && !full().includes("▸ Configuration"); n++) await key("\x1b"); };
  const expand = async (label: string) => { await seek(label); const line = full().split("\n").find((line) => line.startsWith("> ")); if (line?.includes("▸")) await key("l"); };
  const node = async (group: string, label?: string) => { await tree(); await expand("Configuration"); await expand(group); if (label) await seek(label); };
  const edit = async (group: string, label: string) => { await node(group, label); await key("e"); };
  const save = async (scope = 0) => { await tree(); await key(["w", "P", "G"][scope]!); };
  const action = async (label: string) => { await node("Actions", label); await key("\r"); };
  const list = async (group: string, label: string) => { await node(group, label); await expand(label); };
  const number = async (value: string) => { await edit("Resources", "Virtual CPUs:"); await key("\x15"); await key(value); await key("\r"); };
  t.after(() => panel.dispose());
  return { root, input, settings, control, integration, sdk, ctx, calls, panel, terminal, key, seek, choose, tree, expand, node, edit, save, action, list, number, selected, full, text, paths, closed: () => closed };
}

test("settings inventory describes every public schema leaf", () => {
  assert.deepEqual(SETTINGS_FIELDS.map((field) => field.path), SETTINGS_PATHS);
  assert.ok(SETTINGS_FIELDS.every((field) => field.description?.length > 10));
});

test("one Configuration root with collapsed runtime Status, tree h/l and arrow parity", async (t) => {
  const f = await fixture(t); assert.doesNotMatch(f.full(), /Section:|Search all|Apply temporarily/);
  assert.equal(f.selected(), "Configuration"); await f.key("h"); assert.equal(f.selected(), "Configuration");
  assert.match(f.full(), /▸ Configuration/); await f.key("l"); assert.equal(f.selected(), "Configuration");
  await f.key("l"); assert.equal(f.selected(), "General"); await f.key("\x1b[D"); assert.equal(f.selected(), "Configuration");
  await f.key("\x1b[C"); assert.equal(f.selected(), "General"); await f.key("l"); await f.key("l"); assert.match(f.selected(), /Guest image/);
  await f.key("h"); assert.equal(f.selected(), "General"); await f.key("h"); assert.match(f.full(), /▸ General/);
  await f.node("Status"); await f.key("h"); assert.match(f.full(), /▸ Status: read-only \[runtime\]/);
  assert.doesNotMatch(f.full(), /State:|Runtime|Actually adopted|Policy snapshot unavailable/);
  assert.equal(f.full().split("\n").filter((line) => /^[> ] [▾▸] /.test(line)).length, 1);
  await f.key("h"); assert.equal(f.selected(), "Configuration"); await f.key("h"); await f.key("j"); assert.equal(f.selected(), "Configuration");
  await f.key("\x1b[B"); assert.equal(f.selected(), "Configuration");
  assert.deepEqual(f.calls, []);
});

test("responsive render is opaque, bounded and focused at 24/32/40/80/120 and tiny heights", async (t) => {
  const f = await fixture(t);
  await f.node("Resources", "Virtual CPUs:");
  for (const width of [24, 32, 40, 80, 120]) for (const height of [1, 2, 3, 4, 6, 16, 24, 40]) {
    f.terminal.columns = width; f.terminal.rows = height;
    const lines = f.panel.render(width); assert.equal(lines.length, height);
    assert.ok(lines.every((line) => visibleWidth(line) === width), `${width}x${height}`);
    assert.ok(lines.some((line) => line.startsWith("> ")), `${width}x${height}: focus visible`);
    if (height >= 2) {
      const footer = stripTerminalSequences(lines.at(-1)!); assert.match(footer, /q close/);
      assert.match(footer, /w\/P\/G|w ephemeral/); assert.match(footer, /e/); assert.match(footer, /d/);
      assert.match(footer, /j\/k h\/l|↑↓←→|j\/k move/);
      assert.doesNotMatch(lines.slice(0, -1).join("\n"), /q close|w\/P\/G|w ephemeral/);
    }
  }
});

test("footer is one pinned row on short trees, with full labels or lossless compact keys", async (t) => {
  const f = await fixture(t);
  for (const width of [24, 32, 40, 80, 120]) for (const height of [2, 3, 6, 12, 20, 40]) {
    f.terminal.columns = width; f.terminal.rows = height;
    await f.seek("Configuration"); await f.key("h");
    const lines = f.panel.render(width).map(stripTerminalSequences);
    assert.match(lines.at(-1)!, /q close/); assert.match(lines.at(-1)!, /w\/P\/G|w ephemeral/);
    assert.equal(lines.filter((line) => line.includes("q close")).length, 1);
    assert.ok(lines.slice(height >= 8 ? 2 : 1, -1).every((line) => !line.trim()), `${width}x${height}: footer below padding`);
    await f.node("Secrets", "Secrets:"); await f.key("a");
    await f.choose("Environment name:"); await f.key("TOKEN"); await f.key("\r");
    await f.choose("Allowed hosts:"); await f.key("a.example"); await f.key("\r");
    await f.choose("Replace value"); await f.key("private"); await f.key("\r"); await f.choose("Keep draft entry");
    const entryFooter = f.text().split("\n").at(-1)!;
    if (width >= 120) for (const hint of ["e edit", "a add", "d delete", "w ephemeral", "P project", "G global"]) assert.ok(entryFooter.includes(hint), hint);
    if (width <= 32) assert.match(entryFooter, /e\/a\/d.*w\/P\/G/);
    await f.key("d");
  }
});

test("footer separates bold accent keys from muted actions in actual ANSI output", async (t) => {
  const theme = { fg: (role: string, text: string) => `\x1b[${role === "accent" ? 36 : role === "muted" ? 90 : 37}m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m`, inverse: (text: string) => `\x1b[7m${text}\x1b[27m` } as any;
  const f = await fixture(t, theme); f.terminal.columns = 120;
  await f.node("Resources", "Virtual CPUs:");
  let footer = f.panel.render(120).at(-1)!;
  assert.ok(footer.includes("\x1b[1m\x1b[36mq\x1b[39m\x1b[22m\x1b[90m close\x1b[39m"));
  assert.ok(footer.includes("\x1b[1m\x1b[36me\x1b[39m\x1b[22m\x1b[90m edit\x1b[39m"));
  assert.ok(footer.includes("\x1b[1m\x1b[36mw\x1b[39m\x1b[22m\x1b[90m ephemeral\x1b[39m"));
  f.terminal.columns = 24; footer = f.panel.render(24).at(-1)!;
  assert.ok(footer.includes("\x1b[1m\x1b[36me/d\x1b[39m\x1b[22m"));
  assert.ok(footer.includes("\x1b[1m\x1b[36mw/P/G\x1b[39m\x1b[22m"));
});

test("editor, transient and busy footers are mode-correct and never displace content", async (t) => {
  const f = await fixture(t);
  await f.list("Network", "Allowed hosts:"); await f.key("a");
  for (const width of [24, 32, 40, 80, 120]) for (const height of [1, 2, 3, 12]) {
    f.terminal.columns = width; f.terminal.rows = height;
    const lines = f.panel.render(width).map(stripTerminalSequences);
    if (height >= 2) { assert.match(lines.at(-1)!, /Enter keep.*Esc cancel/); assert.doesNotMatch(lines.at(-1)!, /q close|w\/P\/G/); }
    if (height >= 2 && width >= 40) assert.match(lines.at(-1)!, /q literal text/);
    assert.equal(lines.length, height); assert.ok(lines.every((line) => visibleWidth(line) === width));
  }
  await f.key("qeadwPG"); await f.key("\r"); assert.match(f.selected(), /qeadwPG/); assert.equal(f.closed(), false);
  f.terminal.columns = 80; f.terminal.rows = 20;
  await f.action("Help"); assert.match(f.text().split("\n").at(-1)!, /q close.*Enter select.*Esc back.*scroll.*Tab next/);
  for (const width of [24, 32, 40, 80, 120]) {
    const footer = stripTerminalSequences(f.panel.render(width).at(-1)!);
    assert.match(footer, /q close/); assert.match(footer, /Esc/); assert.match(footer, /Tab/); assert.doesNotMatch(footer, /…/);
  }
  await f.tree(); await f.save(); await f.seek("Confirm");
  let release!: () => void; f.ctx.waitForIdle = () => new Promise<void>((resolve) => { release = resolve; });
  f.panel.handleInput("\r"); await tick();
  assert.match(f.text().split("\n").at(-1)!, /Working.*keys after completion/);
  assert.doesNotMatch(f.text().split("\n").at(-1)!, /q close|w ephemeral/);
  release(); await f.panel.waitForIdle();
});

test("Status metadata is runtime-only, collapsed, truthful when inactive/unknown/pending", async (t) => {
  const f = await fixture(t, plainTheme, true);
  assert.match(f.full(), /▸ Status: read-only \[runtime\]/);
  assert.doesNotMatch(f.full(), /Actually adopted|State:/);
  const snapshot = f.control.getRuntimePolicy!()!;
  await f.node("Status"); assert.match(f.full(), /State: active \[runtime\]/);
  assert.ok(f.full().includes(`${new Date(snapshot.adoptedAt).toISOString()} [runtime]`));
  assert.doesNotMatch(f.full(), /Virtual CPUs:|Network mode:|Guest image:|Docker mode:/);
  await f.number("2"); assert.match(f.full(), /Desired changes pending \(not running\) \[runtime\]/);
  f.control.getState = () => ({ status: "off", info: null });
  assert.match(f.full(), /State: off \[runtime\]/); assert.match(f.full(), /Last known policy \(not running\)/);
  f.control.getRuntimePolicy = () => undefined;
  assert.match(f.full(), /No running policy adopted: No current policy \[runtime\]/);
  delete f.control.getRuntimePolicy;
  assert.match(f.full(), /Policy snapshot unavailable: No current policy \[runtime\]/);
});

test("Status state reasons remain safe and scrollable on one/short-row screens", async (t) => {
  const f = await fixture(t);
  f.control.getState = () => ({ status: "unavailable", info: null, reason: "Sandbox unavailable. \x1b[2JRepair host-owned policy and retry Reload; no automatic host escape." });
  await f.node("Status", "State:");
  for (const height of [1, 2, 3]) {
    f.terminal.rows = height; f.terminal.columns = 24; let seen = "";
    for (let n = 0; n < 30; n++) {
      const lines = f.text().split("\n"); seen += (height >= 2 ? lines.slice(0, -1) : lines).join("\n") + "\n";
      await f.key("\x1b[6~");
    }
    assert.match(seen.replace(/\s+/g, " "), /no automatic host escape/); assert.doesNotMatch(seen, /\x1b\[2J/);
    for (let n = 0; n < 30; n++) await f.key("\x1b[5~");
  }
});

test("resources edit, disruption preview, cancel and ephemeral sparse apply via w", async (t) => {
  const f = await fixture(t); await f.number("2"); assert.match(f.text(), /unsaved/);
  await f.save(); assert.match(f.full(), /RESTART/); await f.key("\r"); assert.deepEqual(f.settings.temporary(), {});
  await f.save(); await f.choose("Confirm"); assert.equal(f.settings.temporary().cpus, 2);
  assert.deepEqual(f.calls, ["idle", "reload"]); assert.doesNotMatch(f.text(), /unsaved/);
});

async function addSecret(f: Awaited<ReturnType<typeof fixture>>, name = "TOKEN", value = "SECRET_SENTINEL_123") {
  await f.list("Secrets", "Secrets:"); await f.key("a");
  await f.choose("Environment name:"); await f.key(name); await f.key("\r");
  await f.choose("Allowed hosts:"); await f.key("api.example.com"); await f.key("\r");
  await f.choose("Replace value"); await f.key(`\x1b[200~${value}\x1b[201~`);
  assert.doesNotMatch(f.text(), /SECRET_SENTINEL/); await f.key("\r"); await f.choose("Keep draft entry");
}

test("secret CRUD is nested, masked, metadata-retaining and entry-level draft labeled", async (t) => {
  const f = await fixture(t); await addSecret(f); assert.match(f.full(), /TOKEN: \*+/); assert.doesNotMatch(f.full(), /SECRET_SENTINEL/);
  await f.expand("TOKEN:"); await f.key("l"); assert.match(f.selected(), /Environment name:/);
  await f.key("e"); await f.choose("Environment name:"); await f.key("\x1b"); await f.choose("Cancel entry");
  await f.seek("TOKEN:"); await f.key("d"); assert.doesNotMatch(f.full(), /TOKEN:/);
});

test("network list CRUD and uppercase project sparse persistence", async (t) => {
  const f = await fixture(t); await f.list("Network", "Allowed hosts:"); await f.key("a"); await f.key("api.example.com"); await f.key("\r");
  await f.key("d"); assert.doesNotMatch(f.full(), /api\.example\.com/);
  await f.key("a"); await f.key("new.example.com"); await f.key("\r"); await f.save(1); await f.choose("Confirm");
  const text = await readFile(f.paths.project!, "utf8"); assert.match(text, /new\.example\.com/); assert.doesNotMatch(text, /cpus|memory|secret|image/);
  assert.deepEqual(f.calls, ["idle", "reload"]);
});

test("q clean close and dirty discard default cancel; dangerous lifecycle still waits idle", async (t) => {
  const f = await fixture(t); await f.action("Turn off"); assert.deepEqual(f.calls, []); await f.key("\r"); assert.deepEqual(f.calls, []);
  await f.action("Turn off"); await f.choose("Confirm"); assert.deepEqual(f.calls, ["idle", "enabled:false"]);
  await f.action("Seal network"); await f.key("q"); assert.match(f.full(), /Discard unsaved/); await f.key("\r"); assert.equal(f.closed(), false);
  await f.key("q"); await f.choose("Confirm"); assert.equal(f.closed(), true);
  const clean = await fixture(t); await clean.key("q"); assert.equal(clean.closed(), true); clean.panel.dispose();
});

test("q closes every non-input screen; dirty cancel restores pending screen without applying", async (t) => {
  for (const dirty of [false, true]) for (const screen of ["choice", "entry", "save", "result", "diagnostic"]) {
    const f = await fixture(t);
    if (dirty) await f.number("2");
    if (screen === "choice") await f.edit("General", "Show Footer:");
    else if (screen === "entry") { await f.list("Secrets", "Secrets:"); await f.key("a"); }
    else if (screen === "save") await f.save();
    else if (screen === "result") { await f.action("Reload settings"); await f.choose("Confirm"); }
    else await f.action("Help");
    const selected = f.selected(); const calls = [...f.calls];
    assert.match(f.text(), /q close/);
    await f.key("q");
    if (dirty) {
      assert.match(f.full(), /Discard unsaved changes/); assert.equal(f.selected(), "Cancel");
      await f.key("q"); assert.equal(f.selected(), "Cancel"); // repeated q cannot confirm or stack prompts
      await f.key("\r"); assert.equal(f.closed(), false); assert.equal(f.selected(), selected);
      await f.key("q"); await f.choose("Confirm");
    }
    assert.equal(f.closed(), true, `${screen}, dirty=${dirty}`); assert.equal(f.panel.focused, false);
    assert.deepEqual(f.settings.temporary(), {}); assert.deepEqual(f.calls, calls);
  }
});

test("canceling q at a save confirmation retains its guarded pending draft", async (t) => {
  const f = await fixture(t); await f.number("2"); await f.save(1);
  await f.key("q"); await f.key("\r"); assert.equal(f.closed(), false); assert.match(f.full(), /Save project \+ reload/);
  assert.equal(f.selected(), "Cancel"); await f.choose("Confirm");
  assert.match(await readFile(f.paths.project!, "utf8"), /"cpus" = 2/); assert.deepEqual(f.calls, ["idle", "reload"]);
  await f.key("q"); assert.equal(f.closed(), true);
});

test("q protects unkept secret form changes and Escape remains back without closing", async (t) => {
  const f = await fixture(t); await f.list("Secrets", "Secrets:"); await f.key("a");
  await f.choose("Replace value"); await f.key("PRIVATE_FORM_SENTINEL"); await f.key("\r");
  await f.key("q"); assert.match(f.full(), /Discard unsaved/); assert.equal(f.selected(), "Cancel");
  await f.key("\r"); assert.match(f.full(), /replacement/); assert.doesNotMatch(f.full(), /PRIVATE_FORM_SENTINEL/);
  await f.key("\x1b"); assert.equal(f.closed(), false); assert.match(f.full(), /▾ Configuration/);
  await f.key("q"); assert.equal(f.closed(), true); assert.deepEqual(f.settings.temporary(), {});
});

test("empty collection origins are default, retain explicit scope, and return to default after inheritance", async (t) => {
  const f = await fixture(t);
  for (const [group, label] of [["Secrets", "Secrets:"], ["Mounts", "Mounts:"], ["Network", "Allowed hosts:"], ["Network", "Publish Ports:"]]) {
    await f.node(group!, label!); assert.match(f.selected(), /0 entries \[default\]/);
  }
  const project = await f.settings.open("project"); project.set("network.allow_hosts", ["api.example"]); await project.apply(); project.discard();
  await f.action("Reload settings"); await f.choose("Confirm"); await f.list("Network", "Allowed hosts:"); assert.match(f.selected(), /\[project\]/);
  await f.seek("api.example"); await f.key("d"); await f.save(1); await f.choose("Confirm");
  await f.node("Network", "Allowed hosts:"); assert.match(f.selected(), /0 entries \[project\]/);
  await f.key("d"); assert.match(f.selected(), /inherit on save/); await f.save(1); await f.choose("Confirm");
  await f.node("Network", "Allowed hosts:"); assert.match(f.selected(), /0 entries \[default\]/);
  const global = await f.settings.open("global"); global.set("secrets", []); global.set("mounts", []); await global.apply(); global.discard();
  await f.action("Reload settings"); await f.choose("Confirm");
  for (const group of ["Secrets", "Mounts"]) {
    await f.node(group, `${group}:`); assert.match(f.selected(), /0 entries \[global\]/);
    await f.key("d"); await f.save(2); await f.choose("Confirm"); await f.node(group, `${group}:`); assert.match(f.selected(), /0 entries \[default\]/);
  }
});

test("validation errors keep draft and never echo secrets or apply", async (t) => {
  const f = await fixture(t); await f.number("0"); await f.save(2); assert.match(f.text(), /Validation failed/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.settings.temporary(), {});
});

test("masked input supports split paste, cursor edits and cleanup without plaintext rendering", () => {
  const input = new MaskedInput(); input.focused = true;
  input.handleInput("\x1b[200~secret"); input.handleInput("_sentinel\x1b[201~"); assert.doesNotMatch(input.render(24).join(""), /secret|sentinel/);
  input.handleInput("\x1b[D"); input.handleInput("\x7f"); assert.equal(input.take(), "secret_sentinl"); assert.equal(input.take(), "");
  input.handleInput("hidden"); input.clear(); assert.doesNotMatch(input.render(24).join(""), /\*/);
});

test("bare /msb opens native full viewport once; teardown/errors clean up", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t); f.panel.dispose(); let component: any;
  let signalMounted!: () => void; const mounted = new Promise<void>((resolve) => { signalMounted = resolve; });
  f.ctx.hasUI = true; f.ctx.mode = "tui";
  f.ctx.ui.custom = async (factory: any, options: any) => {
    assert.equal(options.overlay, true); assert.deepEqual(options.overlayOptions, { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 });
    return new Promise<void>((resolve) => { component = factory({ terminal: f.terminal, requestRender() {} }, plainTheme, {}, () => { component.dispose(); resolve(); }); signalMounted(); });
  };
  const opening = createCommandHandler(f.control)("", f.ctx); await Promise.race([mounted, opening]);
  assert.ok(component); assert.equal(component.render(24).length, 24); await assert.rejects(openControlPanel(f.ctx, f.control), /already open/);
  await closeControlPanel(); await opening;
  f.ctx.ui.custom = async () => { throw new Error("custom failed"); }; await assert.rejects(openControlPanel(f.ctx, f.control), /interactive overlay/);
  f.ctx.ui.custom = async () => {}; await openControlPanel(f.ctx, f.control);
});

test("native regular/viewport renderers cover viewport and restore input focus", { timeout: 30_000 }, async (t) => {
  const { TuiMainScreen, TuiAltScreen } = await import("@earendil-works/pi-tui");
  for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
    const f = await fixture(t); let output = ""; let input: ((data: string) => void) | undefined;
    const terminal = { rows: 10, columns: 32, kittyProtocolActive: false, start(onInput: (data: string) => void) { input = onInput; }, stop() {}, drainInput: async () => {}, write(data: string) { output += data; }, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
    const tui = new Renderer(terminal, false, "/tmp"); let baseKeys = 0;
    const base = { focused: false, render: () => Array.from({ length: 10 }, () => "UNDERLYING CHAT/FOOTER"), invalidate() {}, handleInput() { baseKeys++; } };
    tui.addChild(base); if (tui instanceof TuiAltScreen) tui.setLayoutRoot(base); tui.setFocus(base); tui.start();
    let finish: (() => void) | undefined; let signalMounted!: () => void; const mounted = new Promise<void>((resolve) => { signalMounted = resolve; });
    f.ctx.ui.custom = async (factory: any, options: any) => new Promise<void>((resolve) => { const panel = factory(tui, plainTheme, {}, () => { tui.hideOverlay(); panel.dispose(); resolve(); }); tui.showOverlay(panel, options.overlayOptions); finish = () => { void closeControlPanel(); }; signalMounted(); });
    const opening = openControlPanel(f.ctx, f.control); await Promise.race([mounted, opening]); assert.ok(finish);
    for (const width of [24, 32, 40, 80, 120]) for (const height of [1, 3, 6, 24]) {
      terminal.columns = width; terminal.rows = height; output = ""; tui.renderNow(true);
      const frame = tui instanceof TuiMainScreen ? tui.captureRenderState().previousLines.slice(-height).join("\n") : output;
      assert.doesNotMatch(frame, /UNDERLYING/); input?.("j"); assert.equal(baseKeys, 0);
    }
    finish(); await opening; assert.equal(base.focused, true); assert.equal(tui.hasOverlay(), false);
    output = ""; tui.renderNow(true); assert.match(output, /UNDERLYING/); input?.("x"); assert.equal(baseKeys, 1); tui.stop();
  }
});

test("nested mount forms add/edit/delete, focus and expansion survive rename/resize", async (t) => {
  const f = await fixture(t); await f.list("Mounts", "Mounts:"); await f.key("a"); await f.choose("Type:"); await f.choose("tmpfs");
  await f.choose("Guest path:"); await f.key("/scratch"); await f.key("\r"); await f.choose("Keep draft entry"); assert.match(f.selected(), /\/scratch: ro/);
  await f.expand("/scratch:"); await f.seek("Read only:"); await f.key("e"); await f.choose("Read only:"); await f.choose("false"); await f.choose("Keep draft entry");
  assert.match(f.selected(), /\/scratch: rw/); await f.key("e"); await f.choose("Guest path:"); await f.key("\x15"); await f.key("/renamed"); await f.key("\r"); await f.choose("Keep draft entry");
  assert.match(f.selected(), /\/renamed:/); assert.match(f.full(), /Read only: false/); f.terminal.columns = 24; assert.match(f.selected(), /\/renamed:/);
  await f.key("d"); assert.doesNotMatch(f.full(), /\/renamed:/); assert.match(f.selected(), /Mounts:/);
});

test("teardown drains in-flight apply and never reloads after close", async (t) => {
  const f = await fixture(t); await f.action("Seal network"); await f.save();
  let release!: () => void; let entered!: () => void; const enteredIdle = new Promise<void>((resolve) => { entered = resolve; });
  f.ctx.waitForIdle = async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); };
  await f.seek("Confirm"); f.panel.handleInput("\r"); await enteredIdle; f.panel.close(); release(); await f.panel.waitForIdle();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.settings.temporary(), {});
});

test("long dangerous confirmations remain readable with arrows at short heights", async (t) => {
  const f = await fixture(t); f.terminal.columns = 24; f.terminal.rows = 3; await f.action("Turn off"); await f.key("k");
  let seen = ""; for (let n = 0; n < 30; n++) { seen += f.text(); await f.key("\x1b[B"); }
  assert.match(seen, /HOST/); assert.match(seen, /ephemeral/); assert.match(seen, /lost/);
});

test("theme tokens color groups/values/origins/draft/selection, ANSI and Unicode bounded", async (t) => {
  const roles = new Set<string>(); const theme = { fg: (color: string, text: string) => { roles.add(color); return `\x1b[32m${text}\x1b[39m`; }, bold: (text: string) => `\x1b[1m${text}\x1b[22m`, inverse: (text: string) => `\x1b[7m${text}\x1b[27m` } as any;
  const f = await fixture(t, theme); f.paths.project = "/東京/🌱/e\u0301/\x1b[2Jhost-policy/config.toml"; await f.number("2"); await f.node("Sources & warnings");
  for (const width of [24, 32, 40, 80, 120]) for (const height of [1, 3, 6, 24]) {
    f.terminal.columns = width; f.terminal.rows = height;
    for (let n = 0; n < 15; n++) { const lines = f.panel.render(width); assert.equal(lines.length, height); assert.ok(lines.every((line) => visibleWidth(line) === width)); assert.doesNotMatch(lines.join(""), /\x1b\[2J/); await f.key("j"); }
  }
  for (const role of ["accent", "text", "syntaxString", "dim", "warning", "muted"]) assert.ok(roles.has(role), role);
});

test("native auto_start remains live, never implicit host handoff", async (t) => {
  const f = await fixture(t, plainTheme, true); f.calls.length = 0; await f.edit("General", "Auto Start:"); await f.choose("Use false"); await f.save(); assert.doesNotMatch(f.full(), /RESTART/); await f.choose("Confirm");
  assert.equal(f.control.getState().status, "active"); assert.equal(f.integration!.provider.isActive(), true); assert.equal(f.integration!.configRef.value.autoStart, false);
  assert.equal(f.integration!.configRef.value.fallbackMode, "block"); assert.equal(f.integration!.configRef.value.allowHostExecution, false); assert.ok(!f.calls.some((call) => /^(stop|remove|create):/.test(call)));
  const { registerSandboxTools } = await import("./tools.ts"); const tools = new Map<string, any>();
  registerSandboxTools({ registerTool: (tool: any) => tools.set(tool.name, tool), on() {} } as any, { provider: f.integration!.provider, config: f.integration!.configRef.value, cwd: f.input.cwd, hostReads: (await import("./skill-access.ts")).createHostReadAccess(), createGrepExecute: () => async () => ({ content: [] }), grepHelpers: { DEFAULT_MAX_BYTES: 1000, DEFAULT_MAX_LINES: 100, truncateHead: (content: string) => ({ content, truncated: false }), truncateLine: (text: string) => ({ text, wasTruncated: false }), formatSize: (bytes: number) => `${bytes} bytes` }, systemPromptNote: () => "" });
  const ctx = { cwd: f.input.cwd, hasUI: true, ui: { confirm: async () => { assert.fail("Host approval must remain disabled"); } } } as any;
  const result = await tools.get("bash").execute("sandbox-routing", { command: "printf HOST_HANDOFF_SENTINEL" }, undefined, undefined, ctx); assert.doesNotMatch(JSON.stringify(result), /HOST_HANDOFF_SENTINEL/);
  await assert.rejects(tools.get("bash").execute("host-disabled", { command: "true", execution_target: "host" }, undefined, undefined, ctx), /host execution.*disabled/i);
});

test("Reload and Enable preserve deliberate unsaved edits", async (t) => {
  const f = await fixture(t, plainTheme, true); await f.number("2");
  for (const action of ["Reload settings", "Enable sandbox"]) { await f.action(action); await f.choose("Confirm"); assert.doesNotMatch(f.text(), /Draft refresh failed/); }
  await f.edit("General", "Show Footer:"); await f.choose("Use false"); await f.save(); await f.choose("Confirm");
  assert.equal(f.integration!.configRef.value.cpus, 2); assert.equal(f.integration!.configRef.value.showFooter, false); assert.match(f.text(), /Applied/);
});

test("Runtime snapshot is actual, immutable, frozen provenance; failed apply is last-known not current", async (t) => {
  const f = await fixture(t, plainTheme, true); const before = f.control.getRuntimePolicy!()!; assert.ok(before);
  before.provenance.cpus = "temporary"; assert.notEqual(f.control.getRuntimePolicy!()!.provenance.cpus, "temporary");
  const original = f.control.getRuntimePolicy!()!; assert.doesNotMatch(f.full(), /Desired changes pending/); await f.number("2"); assert.deepEqual(f.control.getRuntimePolicy!(), original);
  await mkdir(dirname(f.paths.project!), { recursive: true }); await writeFile(f.paths.project!, "cpus = 3\n"); assert.deepEqual(f.control.getRuntimePolicy!(), original);
  await f.save(); await f.key("\r"); assert.deepEqual(f.control.getRuntimePolicy!(), original); // canceled
  const builder = f.sdk.Sandbox.builder; let fail = true;
  f.sdk.Sandbox.builder = (name: string) => { const result = builder(name); if (fail) result.create = async () => { throw new Error("PRIVATE_REJECTED_CANDIDATE"); }; return result; };
  await f.save(); await f.choose("Confirm"); assert.match(f.text(), /Saved.*runtime failed/); assert.equal(f.control.getState().status, "unavailable"); assert.deepEqual(f.control.getRuntimePolicy!(), original);
  await f.node("Status"); assert.match(f.full(), /Last known policy \(not running\)/); assert.doesNotMatch(f.full(), /PRIVATE_REJECTED_CANDIDATE/);
  await f.edit("General", "Show Footer:"); await f.choose("Use false"); fail = false; await f.action("Reload settings"); await f.choose("Confirm"); assert.equal(f.control.getState().status, "active");
  await f.save(); await f.choose("Confirm"); const adopted = f.control.getRuntimePolicy!()!; assert.equal(parseTomlConfig(adopted.effectiveToml, "global").value.cpus, 2); assert.equal(adopted.provenance.cpus, "temporary");
  await f.control.setEnabled(false); await f.tree(); assert.match(f.full(), /Last known policy \(not running\)/);
  f.integration!.endSession(); assert.equal(f.control.getRuntimePolicy!(), undefined);
});

test("Status e/a/d unavailable, save from Status still targets Configuration draft only", async (t) => {
  const f = await fixture(t, plainTheme, true); const original = f.control.getRuntimePolicy!(); await f.number("2");
  await f.node("Status");
  const labels = f.full().split("\n").filter((line) => line.includes("[runtime]"));
  assert.ok(labels.length >= 9);
  for (let n = 0; n < labels.length; n++) {
    const selected = f.selected();
    assert.match(selected, /\[runtime\]/);
    for (const key of ["e", "a", "d"]) { await f.key(key); assert.equal(f.selected(), selected); }
    assert.doesNotMatch(f.text().split("\n").at(-1)!, /e edit|a add|d inherit|d delete/);
    await f.key("j");
  }
  assert.deepEqual(f.control.getRuntimePolicy!(), original);
  await f.seek("Status:"); assert.match(f.selected(), /read-only/);
  await f.key("w"); await f.choose("Confirm"); assert.equal(f.settings.temporary().cpus, 2); assert.equal(parseTomlConfig(f.control.getRuntimePolicy!()!.effectiveToml, "global").value.cpus, 2);
});

test("validation and success feedback readable at 24x1/24x3", async (t) => {
  for (const height of [1, 3]) {
    const f = await fixture(t); f.terminal.columns = 24; f.terminal.rows = height; await f.number("0"); await f.save(); assert.match(f.text(), /Result: Validation/);
    await f.key("\r"); let seen = ""; for (let n = 0; n < 35; n++) { seen += f.text() + "\n"; await f.key("\x1b[B"); } assert.match(seen, /Draft retained/);
    await f.number("2"); await f.save(); await f.choose("Confirm"); assert.match(f.text(), /Result: Applied/);
  }
});

test("all command letters are literal in text/secret normal, Kitty and split paste modes", async (t) => {
  const commands = "qeadwPGjkh l".replaceAll(" ", "");
  for (const protocol of ["plain", "kitty", "paste"]) {
    const f = await fixture(t); await f.list("Network", "Allowed hosts:"); await f.key("a");
    const type = async () => { if (protocol === "paste") { await f.key(`\x1b[200~${commands.slice(0, 5)}`); await f.key(`${commands.slice(5)}\x1b[201~`); } else for (const char of commands) await f.key(protocol === "kitty" ? `\x1b[${char.codePointAt(0)}u` : char); };
    await type(); await f.key("\r"); assert.match(f.selected(), new RegExp(commands)); assert.equal(f.closed(), false); assert.deepEqual(f.calls, []);
    await f.list("Secrets", "Secrets:"); await f.key("a"); await f.choose("Environment name:"); await f.key("TOKEN"); await f.key("\r"); await f.choose("Allowed hosts:"); await f.key("a.example"); await f.key("\r"); await f.choose("Replace value"); await type(); assert.doesNotMatch(f.text(), new RegExp(commands)); await f.key("\r"); await f.choose("Keep draft entry"); await f.save(); await f.choose("Confirm"); assert.equal(f.settings.temporary().secrets![0]!.value, commands);
  }
});

test("uppercase bindings support Kitty shifted codes/modifyOtherKeys, lowercase p/g do nothing", async (t) => {
  for (const [sequence, scope] of [["\x1b[112:80;2u", "project"], ["\x1b[71u", "global"], ["\x1b[27;2;80~", "project"], ["G", "global"]]) {
    const f = await fixture(t); await f.number("2"); await f.key("p"); await f.key("g"); assert.deepEqual(f.calls, []); await f.key("\x1b[80;2:3u"); assert.deepEqual(f.calls, []);
    await f.key(sequence!); assert.match(f.full(), new RegExp(`Save ${scope}`)); await f.choose("Confirm"); assert.match(await readFile(f.paths[scope!]!, "utf8"), /cpus/);
  }
});

test("scalar d inherits at chosen save scope and ephemeral automatic name stays scope-limited", async (t) => {
  const f = await fixture(t); await mkdir(dirname(f.paths.global!), { recursive: true }); await writeFile(f.paths.global!, 'sandbox_name = "lower-name"\ncpus = 3\n');
  await f.action("Reload settings"); await f.choose("Confirm"); await f.edit("General", "Sandbox name:"); await f.choose("Use automatic session");
  await f.save(1); assert.match(f.full(), /ephemeral-only override/); assert.match(await readFile(f.paths.global!, "utf8"), /lower-name/);
  await f.save(); await f.choose("Confirm"); assert.equal(f.settings.temporary().sandboxName, null); assert.equal((await f.settings.open("temporary")).snapshot().automaticSandboxName, true);
  await f.node("Resources", "Virtual CPUs:"); await f.key("d"); assert.match(f.full(), /inherit on save/); await f.save(2); await f.choose("Confirm"); assert.doesNotMatch(await readFile(f.paths.global!, "utf8"), /cpus/);
});

test("diagnostics preserve log-tail validation, prune errors and Docker reasons", async (t) => {
  const f = await fixture(t); let tail: number | undefined; f.control.getLogs = async (value) => { tail = value; return "selected log"; };
  f.control.pruneNow = async () => ({ inspected: 1, removed: [], kept: ["live"], errors: ["Test diagnostic: owner conflict"] });
  f.control.getState = () => ({ status: "active", info: { name: "guest", displayId: "guest", image: "test", pid: 1, createdAt: Date.now(), root: "/repo", cwd: "/repo", docker: { mode: "auto", readiness: "missing", reason: "Docker components not present" } } });
  await f.node("Status", "Docker readiness:"); assert.match(f.full(), /Docker components not present/);
  assert.doesNotMatch(f.full(), /Docker mode:|image: test/);
  await f.action("Recent logs"); await f.key("\x15"); await f.key("25"); await f.key("\r"); assert.equal(tail, 25); assert.match(f.text(), /selected log/);
  await f.action("Prune stale"); await f.choose("Confirm"); assert.match(f.text(), /Test diagnostic: owner conflict/);
  await f.action("Recent logs"); await f.key("\x15"); await f.key("-1"); f.terminal.columns = 24; f.terminal.rows = 3; await f.key("\r"); assert.match(f.text(), /Result: Invalid log/); assert.equal(tail, 25);
});

test("project list saves reconcile raw removal controls without unrelated edits", async (t) => {
  const f = await fixture(t); await mkdir(dirname(f.paths.project!), { recursive: true }); await writeFile(f.paths.project!, 'route_tools = ["read"]\nremove_route_tools = ["bash"]\nremove_host_env = ["KEEP_REMOVED"]\n');
  await f.action("Reload settings"); await f.choose("Confirm"); await f.list("Advanced", "Route Tools:"); await f.key("a"); await f.key("bash"); await f.key("\r"); await f.save(1); assert.match(f.full(), /remove_route_tools/); await f.choose("Confirm");
  assert.deepEqual((await resolveConfig(f.input)).config.routeTools, ["read", "bash"]); const saved = await readFile(f.paths.project!, "utf8"); assert.match(saved, /KEEP_REMOVED/); assert.match(saved, /"remove_route_tools" = \[\]/);
});

test("failed native reset discards explicitly confirmed draft and permits new edits", async (t) => {
  const f = await fixture(t, plainTheme, true); await f.number("2"); await f.save(); await f.choose("Confirm");
  const builder = f.sdk.Sandbox.builder; let fail = true; f.sdk.Sandbox.builder = (name: string) => { const result = builder(name); if (fail) result.create = async () => { throw new Error("test reset failure"); }; return result; };
  await f.edit("General", "Show Footer:"); await f.choose("Use false"); await f.action("Reset ephemeral"); await f.choose("Confirm");
  assert.match(f.text(), /Action failed/); assert.doesNotMatch(f.text(), /unsaved|Draft refresh failed/); assert.deepEqual(f.settings.temporary(), {});
  fail = false; await f.number("3"); await f.save(); await f.choose("Confirm"); assert.equal(f.control.getState().status, "active"); assert.equal(f.integration!.configRef.value.cpus, 3); assert.equal(f.integration!.configRef.value.showFooter, true);
});

async function seedScopedPanelSecrets(f: Awaited<ReturnType<typeof fixture>>, editFile = false) {
  await mkdir(dirname(f.paths.project!), { recursive: true });
  await writeFile(join(dirname(f.paths.project!), "private-token"), "PRIVATE_FILE_BYTES"); await writeFile(join(dirname(f.paths.project!), "edit-token"), "EDIT_FILE_BYTES"); await writeFile(join(dirname(f.paths.global!), "global-token"), "GLOBAL_FILE_BYTES");
  await writeFile(f.paths.global!, 'secrets = [{ env = "TARGET_ONLY", value = "$ENV:GLOBAL_REF", allow_hosts = ["global.example"] }, { env = "TARGET_FILE", value = "$FILE:global-token", allow_hosts = ["global.example"] }]\n');
  await writeFile(f.paths.project!, `secrets = [{ env = "EDIT", value = "${editFile ? "$FILE:edit-token" : "$ENV:EDIT_REF"}", allow_hosts = ["edit.example"] }, { env = "PRIVATE_LITERAL", value = "PRIVATE_LITERAL_BYTES", allow_hosts = ["private.example"] }, { env = "PRIVATE_FILE", value = "$FILE:private-token", allow_hosts = ["private.example"] }]\n`);
  await f.action("Reload settings"); await f.choose("Confirm"); f.terminal.columns = 120; f.terminal.rows = 40;
}
async function panelSecretHostEdit(f: Awaited<ReturnType<typeof fixture>>, host: string) { await f.choose("Allowed hosts"); await f.key("\x15"); await f.key(host); await f.key("\r"); }
async function openSecret(f: Awaited<ReturnType<typeof fixture>>, name = "EDIT") { await f.list("Secrets", "Secrets:"); await f.seek(`${name}:`); await f.key("e"); }

test("global secret metadata/value edits preserve target credentials, entry origins and exclude project siblings", async (t) => {
  const f = await fixture(t); await seedScopedPanelSecrets(f); await openSecret(f); await panelSecretHostEdit(f, "edited.example"); await f.choose("Keep draft entry");
  assert.match(f.full(), /EDIT:.*\[project\].*draft entry/); assert.match(f.full(), /PRIVATE_LITERAL:.*\[project\]/); assert.doesNotMatch(f.full(), /PRIVATE_LITERAL:.*draft entry/);
  await openSecret(f); await f.choose("Replace value"); await f.key("$ENV:NEW_REF"); assert.doesNotMatch(f.text(), /\$ENV:NEW_REF/); await f.key("\r"); await f.choose("Keep draft entry");
  await openSecret(f); await panelSecretHostEdit(f, "final.example"); await f.choose("Keep draft entry"); await f.save(2);
  const preview = f.full().replace(/\s+/g, " "); assert.match(preview, /UPSERT secrets\[EDIT\]/); assert.match(preview, /from project/); assert.match(preview, /DELIBERATE higher-scope import/); assert.doesNotMatch(f.full(), /PRIVATE_LITERAL_BYTES|PRIVATE_FILE_BYTES|NEW_REF/);
  await f.choose("Confirm"); const text = await readFile(f.paths.global!, "utf8"); const secrets = parseTomlConfig(text, "global").value.secrets!;
  assert.deepEqual(secrets.map((entry) => entry.env), ["TARGET_ONLY", "TARGET_FILE", "EDIT"]); assert.equal(secrets[1]!.value, "$FILE:global-token"); assert.equal(secrets[2]!.value, "$ENV:NEW_REF"); assert.deepEqual(secrets[2]!.allowHosts, ["final.example"]); assert.doesNotMatch(text, /PRIVATE_|private-token|GLOBAL_FILE_BYTES/);
});

test("global FILE metadata edit preserves project reference origin without unrelated entries", async (t) => {
  const f = await fixture(t); await seedScopedPanelSecrets(f, true); await openSecret(f); await panelSecretHostEdit(f, "edited.example"); await f.choose("Keep draft entry"); await f.save(2); await f.choose("Confirm");
  const text = await readFile(f.paths.global!, "utf8"); assert.ok(text.includes(`$FILE:${join(dirname(f.paths.project!), "edit-token")}`)); assert.doesNotMatch(text, /EDIT_FILE_BYTES|PRIVATE_|private-token/);
});

test("add/delete global secret intents exclude project siblings and report shadowing", async (t) => {
  const f = await fixture(t); await seedScopedPanelSecrets(f); await addSecret(f, "NEW", "$ENV:NEW"); await f.save(2); await f.choose("Confirm");
  const text = await readFile(f.paths.global!, "utf8"); assert.doesNotMatch(text, /PRIVATE_|env = "EDIT"/); assert.match(text, /NEW/); assert.match(text, /TARGET_ONLY/);
  await f.list("Secrets", "Secrets:"); await f.seek("EDIT:"); await f.key("d"); await f.save(2); assert.match(f.full().replace(/\s+/g, " "), /REMOVE secrets\[EDIT\]/); assert.match(f.full().replace(/\s+/g, " "), /shadowed; not effective here/); await f.choose("Confirm");
  assert.match(f.text(), /No changes/); assert.match(f.text(), /secrets\[EDIT\]/); assert.equal(await readFile(f.paths.global!, "utf8"), text);
});

test("explicit collection clear versus inherit remain distinct chosen-scope intents", async (t) => {
  const f = await fixture(t); await seedScopedPanelSecrets(f); await f.list("Secrets", "Secrets:"); await f.choose("Clear list"); await f.save(2);
  assert.match(f.full().replace(/\s+/g, " "), /CLEAR secrets\[whole list\]/); assert.match(f.full().replace(/\s+/g, " "), /explicit whole-list intent/); await f.choose("Confirm"); assert.deepEqual(parseTomlConfig(await readFile(f.paths.global!, "utf8"), "global").value.secrets, []); assert.match(await readFile(f.paths.project!, "utf8"), /PRIVATE_LITERAL/);
});

test("mount/list entry edits preserve global entries without importing project siblings", async (t) => {
  const f = await fixture(t); await mkdir(dirname(f.paths.project!), { recursive: true });
  await writeFile(f.paths.global!, 'mounts = [{ type = "tmpfs", guest_path = "/mnt/global", readonly = true }]\nnetwork.allow_hosts = ["global.example"]\n');
  await writeFile(f.paths.project!, 'mounts = [{ type = "tmpfs", guest_path = "/mnt/edit", readonly = true }, { type = "tmpfs", guest_path = "/mnt/private-data", readonly = true }]\nnetwork.allow_hosts = ["edit.example", "private.example"]\n');
  await f.action("Reload settings"); await f.choose("Confirm"); await f.list("Mounts", "Mounts:"); await f.seek("/mnt/edit:"); await f.key("e"); await f.choose("Read only:"); await f.choose("false"); await f.choose("Keep draft entry");
  await f.list("Network", "Allowed hosts:"); await f.seek("edit.example"); await f.key("e"); await f.key("\x15"); await f.key("chosen.example"); await f.key("\r"); await f.save(2); await f.choose("Confirm");
  const text = await readFile(f.paths.global!, "utf8"); const raw = parseTomlConfig(text, "global").value;
  assert.deepEqual(raw.mounts!.map((mount) => mount.guestPath), ["/mnt/global", "/mnt/edit"]); assert.equal(raw.mounts![1]!.readonly, false); assert.deepEqual(raw.network!.allowHosts, ["global.example", "chosen.example"]); assert.doesNotMatch(text, /private/);
});

test("nested secret host list CRUD retains credential and identity-scoped intent", async (t) => {
  const f = await fixture(t); await seedScopedPanelSecrets(f, true); await f.list("Secrets", "Secrets:"); await f.expand("EDIT:"); await f.expand("Allowed hosts:");
  await f.key("a"); await f.key("second.example"); await f.key("\r"); assert.match(f.selected(), /second.example/);
  await f.key("e"); await f.key("\x15"); await f.key("chosen.example"); await f.key("\r"); assert.match(f.selected(), /chosen.example/);
  await f.key("d"); assert.match(f.selected(), /Allowed hosts:/); assert.doesNotMatch(f.full(), /chosen.example/);
  await f.save(2); await f.choose("Confirm");
  const entries = parseTomlConfig(await readFile(f.paths.global!, "utf8"), "global").value.secrets!;
  assert.deepEqual(entries.map((entry) => entry.env), ["TARGET_ONLY", "TARGET_FILE", "EDIT"]);
  assert.deepEqual(entries[2]!.allowHosts, ["edit.example"]); assert.equal(entries[2]!.value, `$FILE:${join(dirname(f.paths.project!), "edit-token")}`);
});

test("successful w/P/G adoption freezes accurate origins and tree distinguishes draft provenance", async (t) => {
  for (const [scope, source, label] of [[0, "temporary", "ephemeral"], [1, "host-project", "project"], [2, "host-default", "global"]] as const) {
    const f = await fixture(t, plainTheme, true); await f.number("2"); assert.match(f.full(), /Virtual CPUs: 2 \[default\] \* draft/);
    await f.save(scope); await f.choose("Confirm"); const snapshot = f.control.getRuntimePolicy!()!;
    assert.equal(snapshot.provenance.cpus, source); assert.equal(parseTomlConfig(snapshot.effectiveToml, "global").value.cpus, 2);
    await f.node("Resources", "Virtual CPUs:"); assert.match(f.selected(), new RegExp(`Virtual CPUs: 2 \\[${label}\\]`));
    await f.node("Advanced", "Allow Host Execution:"); assert.match(f.selected(), /\[environment\]/);
  }
});

test("saved-but-rejected restart and failed resolution keep active runtime snapshot unchanged", async (t) => {
  const f = await fixture(t, plainTheme, true); const original = f.control.getRuntimePolicy!();
  await mkdir(dirname(f.paths.project!), { recursive: true }); await writeFile(f.paths.project!, "cpus = 3\n");
  await assert.rejects(f.control.reload({ allowRestart: false }), /restart confirmation/);
  assert.equal(f.control.getState().status, "active"); assert.deepEqual(f.control.getRuntimePolicy!(), original);
  await writeFile(f.paths.project!, "cpus = 0\n"); await assert.rejects(f.control.reload());
  assert.equal(f.control.getState().status, "active"); assert.deepEqual(f.control.getRuntimePolicy!(), original);
});

test("reconnect with missing or conflicting actual image never guesses disk VM policy as running", async (t) => {
  for (const actualImage of [undefined, "different-actual-image"]) {
    const f = await fixture(t, plainTheme, true); const name = f.control.getState().info!.name;
    const labels = (await f.sdk.Sandbox.get(name)).config().labels;
    const calls: string[] = []; const sdk = fakeSdk(calls, { name, status: "running", labels });
    const handle = await sdk.Sandbox.get(name); handle.config = () => ({ name, labels, ...(actualImage ? { image: actualImage } : {}) });
    await writeFile(f.paths.global!, 'cpus = 2\nmemory_mib = 2048\n[network]\nmode = "deny"\n');
    const integration = createMsbIntegration({ sessionId: "panel-session", cwd: f.input.cwd, agentDir: f.input.agentDir, configDirName: ".pi", env: {}, sdkLoader: async () => sdk, acquireOwnerLock: async () => ({ path: join(f.root, "second.lock"), release: async () => {} }) });
    t.after(() => integration.manager.shutdown()); await integration.configureSession({ sessionId: "panel-session", cwd: f.input.cwd, projectTrusted: true });
    assert.ok(calls.some((call) => call.startsWith("connect:"))); assert.ok(!calls.some((call) => call.startsWith("create:")));
    const snapshot = integration.control.getRuntimePolicy!()!; assert.equal(snapshot.verification, "reconnected"); assert.ok(!snapshot.knownFields.includes("image")); assert.ok(snapshot.knownFields.includes("fallbackMode"));
    assert.ok(!snapshot.knownFields.includes("cpus")); assert.ok(!snapshot.knownFields.includes("network")); assert.doesNotMatch(snapshot.effectiveToml, /image|cpus|memory_mib|network|mounts|secrets/); assert.equal(snapshot.provenance.image, undefined);
    f.control.getRuntimePolicy = () => snapshot; f.control.getState = integration.control.getState;
    await f.node("Status");
    assert.match(f.full(), /VM instance not verified/);
    assert.doesNotMatch(f.full(), /image: ghcr|verified inspection|Virtual CPUs:|Guest image:|Docker mode:/);
    await f.seek("VM instance not verified:");
    for (const key of ["e", "a", "d"]) await f.key(key);
    assert.match(f.selected(), /VM instance not verified:.*\[runtime\]/);
    await f.node("Resources", "Virtual CPUs:"); assert.equal(f.selected(), `Virtual CPUs: ${DEFAULT_CONFIG.cpus} [default]`);
    assert.equal(f.full().split("\n").filter((line) => line.includes("Virtual CPUs:")).length, 1);
  }
});

test("same-name reconnect downgrades known VM policy; live/no-op cannot silently promote it", async (t) => {
  for (const status of ["running", "stopped"]) {
    const f = await fixture(t, plainTheme, true); assert.equal(f.control.getRuntimePolicy!()!.verification, "created"); assert.ok(f.control.getRuntimePolicy!()!.knownFields.includes("image"));
    const handle = await f.sdk.Sandbox.get(f.control.getState().info!.name);
    handle.status = status; handle.createdAt = new Date(Date.now() + 1000); // name/session/image still match, instance is not proven
    await f.integration!.manager.withRuntime(async () => {});
    assert.equal(f.control.getRuntimePolicy!()!.verification, "reconnected"); assert.ok(!f.control.getRuntimePolicy!()!.knownFields.includes("cpus"));
    await f.action("Reload settings"); await f.choose("Confirm"); assert.ok(!f.control.getRuntimePolicy!()!.knownFields.includes("cpus"));
    await f.edit("General", "Show Footer:"); await f.choose("Use false"); await f.save(); await f.choose("Confirm"); assert.ok(!f.control.getRuntimePolicy!()!.knownFields.includes("cpus"));
    await f.number("2"); await f.save(); await f.choose("Confirm"); assert.equal(f.control.getRuntimePolicy!()!.verification, "created"); assert.ok(f.control.getRuntimePolicy!()!.knownFields.includes("cpus"));
  }
});

test("runtime API excludes literal secrets and raw FILE/ENV references and resets session identity", async (t) => {
  const f = await fixture(t, plainTheme, true); await mkdir(dirname(f.paths.global!), { recursive: true });
  await writeFile(join(dirname(f.paths.global!), "private-token"), "FILE_PRIVATE_BYTES");
  await writeFile(f.paths.global!, 'secrets = [{ env = "LITERAL", value = "LITERAL_PRIVATE_BYTES", allow_hosts = ["a.example"] }, { env = "FILE", value = "$FILE:private-token", allow_hosts = ["a.example"] }, { env = "ENV_REF", value = "$ENV:PI_MSB_FALLBACK_MODE", allow_hosts = ["a.example"] }]\n');
  await f.action("Reload settings"); await f.choose("Confirm"); await f.tree(); const snapshot = f.control.getRuntimePolicy!()!;
  assert.doesNotMatch(f.full(), /Desired changes pending/);
  assert.doesNotMatch(JSON.stringify(snapshot), /LITERAL_PRIVATE_BYTES|FILE_PRIVATE_BYTES|\$FILE:|private-token|\$ENV:/);
  await f.integration!.configureSession({ sessionId: "different-session", cwd: f.input.cwd, projectTrusted: true, config: { config: { ...structuredClone(DEFAULT_CONFIG), autoStart: false }, provenance: {}, warnings: [] } as any });
  assert.equal(f.control.getRuntimePolicy!(), undefined); assert.equal(f.control.getState().status, "off");
});

test("project/global entry saves exclude committed ephemeral entries", async (t) => {
  for (const scope of [1, 2]) {
    const f = await fixture(t); await seedScopedPanelSecrets(f); const ephemeral = await f.settings.open("temporary"); ephemeral.upsertSecret({ env: "TEMP_PRIVATE", value: "TEMP_PRIVATE_BYTES", allowHosts: ["temp.example"] }); await ephemeral.apply();
    await f.action("Reload settings"); await f.choose("Confirm"); await addSecret(f, "NEW", "$ENV:NEW"); await f.save(scope); await f.choose("Confirm");
    const text = await readFile(scope === 1 ? f.paths.project! : f.paths.global!, "utf8"); assert.doesNotMatch(text, /TEMP_PRIVATE/); assert.match(text, /NEW/); if (scope === 2) assert.doesNotMatch(text, /PRIVATE_LITERAL|PRIVATE_FILE/);
  }
});
