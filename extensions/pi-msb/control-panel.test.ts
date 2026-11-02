import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, resolveConfig, toEffectiveToml } from "./config.ts";
import { ControlPanel, SAVE_LABELS, openControlPanel, closeControlPanel } from "./control-panel.ts";
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
  const calls: string[] = [];
  const sdk = fakeSdk(calls);
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
  const draft = await settings.open("temporary");
  const paths: Record<string, string> = {};
  for (const scope of ["global", "project"] as const) { const source = await settings.open(scope); paths[scope] = source.path!; source.discard(); }
  const panel = new ControlPanel({ draft, control, ctx, tui: { terminal, requestRender() {} } as any, theme, paths, done: () => { closed = true; } });
  const key = async (data: string) => { panel.handleInput(data); await tick(); await panel.waitForIdle(); };
  const text = () => panel.render(terminal.columns).join("\n");
  const seek = async (label: string) => {
    for (let count = 0; count < 300; count++) {
      if (text().split("\n").some((line) => line.startsWith(`> ${label}`))) return;
      await key("\t");
    }
    assert.fail(`unreachable row: ${label}\n${text()}`);
  };
  const choose = async (label: string) => { await seek(label); await key("\r"); };
  t.after(() => panel.dispose());
  return { root, input, settings, control, integration, sdk, ctx, calls, panel, terminal, key, seek, choose, text, paths, closed: () => closed };
}

test("settings inventory describes every public schema leaf", () => {
  assert.deepEqual(SETTINGS_FIELDS.map((field) => field.path), SETTINGS_PATHS);
  assert.ok(SETTINGS_FIELDS.every((field) => field.description?.length > 10));
});

test("responsive render is opaque, bounded and all three save buttons remain focusable", async (t) => {
  const f = await fixture(t);
  for (const width of [24, 32, 40, 80, 120]) for (const height of [1, 3, 6, 10, 24, 40]) {
    f.terminal.columns = width; f.terminal.rows = height;
    const lines = f.panel.render(width);
    assert.equal(lines.length, height);
    assert.ok(lines.every((line) => visibleWidth(line) === width), `${width}x${height}`);
    for (const scope of ["Apply temporarily", "Apply to project", "Apply to global"]) await f.seek(scope);
  }
});

test("resources edit, disruption preview, cancel, and real temporary apply via keyboard", async (t) => {
  const f = await fixture(t);
  await f.choose("Section"); await f.choose("Resources"); await f.choose("cpus:"); await f.choose("Edit value");
  await f.key("\x7f"); await f.key("2"); await f.key("\r");
  assert.match(f.text(), /unsaved/);
  await f.choose(SAVE_LABELS[0]); assert.match(f.text(), /RESTART/);
  await f.choose("Cancel"); assert.deepEqual(f.settings.temporary(), {});
  await f.choose(SAVE_LABELS[0]); await f.choose("Confirm");
  assert.equal(f.settings.temporary().cpus, 2);
  assert.deepEqual(f.calls, ["idle", "reload"]);
  assert.doesNotMatch(f.text(), /unsaved/);
});

test("secret CRUD uses masked input, retains no rendered replacement, supports cancel/delete", async (t) => {
  const f = await fixture(t);
  await f.choose("Section"); await f.choose("Secrets"); await f.choose("secrets:"); await f.choose("Add secret");
  await f.choose("Environment name"); await f.key("TOKEN"); await f.key("\r");
  await f.choose("Allowed hosts"); await f.key("api.example.com"); await f.key("\r");
  await f.choose("Replace value");
  await f.key("\x1b[200~SECRET_SENTINEL_123\x1b[201~");
  assert.doesNotMatch(f.text(), /SECRET_SENTINEL/); assert.match(f.text(), /\*\*\*/);
  await f.key("\r"); assert.doesNotMatch(f.text(), /SECRET_SENTINEL/);
  await f.choose("Keep draft entry"); assert.match(f.text(), /TOKEN: \*+/); assert.doesNotMatch(f.text(), /SECRET_SENTINEL/);
  await f.choose("TOKEN:"); await f.choose("Environment name"); await f.key("\x1b");
  assert.doesNotMatch(f.text(), /SECRET_SENTINEL/);
  await f.choose("Cancel entry"); await f.choose("TOKEN:"); await f.choose("Delete entry"); assert.doesNotMatch(f.text(), /TOKEN:/);
});

test("network list CRUD and project sparse persistence are actionable", async (t) => {
  const f = await fixture(t);
  await f.choose("Section"); await f.choose("Network"); await f.choose("network.allow_hosts:"); await f.choose("Add entry");
  await f.choose("Value:"); await f.key("api.example.com"); await f.key("\r"); await f.choose("Keep draft entry");
  await f.choose("api.example.com"); await f.choose("Delete entry");
  await f.choose("Add entry"); await f.choose("Value:"); await f.key("new.example.com"); await f.key("\r"); await f.choose("Keep draft entry"); await f.choose("Back");
  await f.choose(SAVE_LABELS[1]); await f.choose("Confirm");
  const text = await readFile(f.paths.project!, "utf8"); assert.match(text, /new\.example\.com/); assert.doesNotMatch(text, /cpus|memory|secret|image/);
  assert.deepEqual(f.calls, ["idle", "reload"]);
});

test("unsaved exit defaults to cancel and host/lifecycle actions require confirmation and idle", async (t) => {
  const f = await fixture(t);
  await f.choose("Section"); await f.choose("Actions"); await f.choose("Turn off");
  assert.deepEqual(f.calls, []); await f.key("\r"); assert.deepEqual(f.calls, []); // cancel selected by default
  await f.choose("Turn off"); await f.choose("Confirm"); assert.deepEqual(f.calls, ["idle", "enabled:false"]);
  await f.choose("Seal network"); await f.key("\x1b"); assert.match(f.text(), /Discard unsaved/);
  await f.key("\r"); assert.equal(f.closed(), false); await f.key("\x1b"); await f.choose("Confirm"); assert.equal(f.closed(), true);
});

test("validation errors do not echo secret values or apply anything", async (t) => {
  const f = await fixture(t);
  await f.choose("Search all"); await f.key("cpus"); await f.key("\r"); await f.choose("cpus:"); await f.choose("Edit value"); await f.key("\x7f"); await f.key("0"); await f.key("\r");
  await f.choose(SAVE_LABELS[2]); assert.match(f.text(), /Validation failed/); assert.deepEqual(f.calls, []); assert.deepEqual(f.settings.temporary(), {});
});

test("masked input supports split paste, cursor edits and cleanup without plaintext rendering", () => {
  const input = new MaskedInput(); input.focused = true;
  input.handleInput("\x1b[200~secret"); input.handleInput("_sentinel\x1b[201~");
  assert.doesNotMatch(input.render(24).join(""), /secret|sentinel/);
  input.handleInput("\x1b[D"); input.handleInput("\x7f");
  assert.equal(input.take(), "secret_sentinl"); assert.equal(input.take(), "");
  input.handleInput("hidden"); input.clear(); assert.doesNotMatch(input.render(24).join(""), /\*/);
});

test("bare /msb opens native full-viewport overlay once; teardown and errors clean up", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t); f.panel.dispose(); let component: any;
  let signalMounted!: () => void;
  const mounted = new Promise<void>((resolve) => { signalMounted = resolve; });
  f.ctx.hasUI = true; f.ctx.mode = "tui";
  f.ctx.ui.custom = async (factory: any, options: any) => {
    assert.equal(options.overlay, true); assert.deepEqual(options.overlayOptions, { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 });
    return new Promise<void>((resolve) => { component = factory({ terminal: f.terminal, requestRender() {} }, plainTheme, {}, () => { component.dispose(); resolve(); }); signalMounted(); });
  };
  const opening = createCommandHandler(f.control)("", f.ctx);
  await Promise.race([mounted, opening]);
  assert.ok(component); assert.equal(component.render(24).length, 24);
  await assert.rejects(openControlPanel(f.ctx, f.control), /already open/);
  closeControlPanel(); await opening;
  f.ctx.ui.custom = async () => { throw new Error("custom failed"); };
  await openControlPanel(f.ctx, f.control).catch(() => {});
  f.ctx.ui.custom = async () => {};
  await openControlPanel(f.ctx, f.control); // error path did not retain global ownership
});

test("native regular and viewport renderers cover the whole viewport and restore input/focus", { timeout: 30_000 }, async (t) => {
  const { TuiMainScreen, TuiAltScreen } = await import("@earendil-works/pi-tui");
  for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
    const f = await fixture(t);
    let output = ""; let input: ((data: string) => void) | undefined;
    const terminal = {
      rows: 10, columns: 32, kittyProtocolActive: false,
      start(onInput: (data: string) => void) { input = onInput; }, stop() {}, drainInput: async () => {},
      write(data: string) { output += data; }, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
    };
    const tui = new Renderer(terminal, false, "/tmp");
    let baseKeys = 0;
    const base = { focused: false, render: () => Array.from({ length: 10 }, () => "UNDERLYING CHAT/FOOTER"), invalidate() {}, handleInput() { baseKeys++; } };
    tui.addChild(base); if (tui instanceof TuiAltScreen) tui.setLayoutRoot(base);
    tui.setFocus(base); tui.start();
    let finish: (() => void) | undefined;
    let signalMounted!: () => void;
    const mounted = new Promise<void>((resolve) => { signalMounted = resolve; });
    f.ctx.ui.custom = async (factory: any, options: any) => new Promise<void>((resolve) => {
      const panel = factory(tui, plainTheme, {}, () => { tui.hideOverlay(); panel.dispose(); resolve(); });
      tui.showOverlay(panel, options.overlayOptions); finish = () => closeControlPanel(); signalMounted();
    });
    const opening = openControlPanel(f.ctx, f.control);
    await Promise.race([mounted, opening]);
    assert.ok(finish);
    for (const width of [24, 32, 40, 80, 120]) for (const height of [1, 3, 6, 24]) {
      terminal.columns = width; terminal.rows = height; output = "";
      tui.renderNow(true);
      const visibleFrame = tui instanceof TuiMainScreen ? tui.captureRenderState().previousLines.slice(-height).join("\n") : output;
      assert.doesNotMatch(visibleFrame, /UNDERLYING/);
      input?.("\t"); assert.equal(baseKeys, 0);
    }
    finish(); await opening;
    assert.equal(base.focused, true); assert.equal(tui.hasOverlay(), false);
    output = ""; tui.renderNow(true); assert.match(output, /UNDERLYING/);
    input?.("x"); assert.equal(baseKeys, 1);
    tui.stop();
  }
});

test("mount forms add, edit and delete draft entries using only keyboard navigation", async (t) => {
  const f = await fixture(t);
  await f.choose("Section"); await f.choose("Mounts"); await f.choose("mounts:"); await f.choose("Add mount");
  await f.choose("Type:"); await f.choose("tmpfs");
  await f.choose("Guest path:"); await f.key("/scratch"); await f.key("\r");
  await f.choose("Keep draft entry"); assert.match(f.text(), /\/scratch \(ro\)/);
  await f.choose("/scratch"); await f.choose("Read only:"); await f.choose("false"); await f.choose("Keep draft entry");
  assert.match(f.text(), /\/scratch \(rw\)/);
  await f.choose("/scratch"); await f.choose("Delete entry"); assert.doesNotMatch(f.text(), /\/scratch \(rw\)/);
});

test("teardown drains an in-flight apply and never reloads after panel closure", async (t) => {
  const f = await fixture(t);
  await f.choose("Section"); await f.choose("Actions"); await f.choose("Seal network"); await f.choose(SAVE_LABELS[0]);
  let release!: () => void; let entered!: () => void;
  const enteredIdle = new Promise<void>((resolve) => { entered = resolve; });
  f.ctx.waitForIdle = async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); };
  await f.seek("Confirm"); f.panel.handleInput("\r"); await enteredIdle;
  f.panel.close(); release(); await f.panel.waitForIdle();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.settings.temporary(), {});
});

test("long confirmations/descriptions are readable with arrows at short heights", async (t) => {
  const f = await fixture(t); f.terminal.columns = 24; f.terminal.rows = 3;
  await f.choose("Section"); await f.choose("Actions"); await f.choose("Turn off");
  await f.key("\x1b[A"); // warning row before Cancel
  let seen = "";
  for (let i = 0; i < 20; i++) { seen += f.text(); await f.key("\x1b[B"); }
  assert.match(seen, /HOST/); assert.match(seen, /ephemeral/); assert.match(seen, /lost/);
});

test("themed ANSI and wide Unicode paths remain bounded and terminal-control labels are inert", async (t) => {
  const theme = { fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m`, inverse: (text: string) => `\x1b[7m${text}\x1b[27m` } as any;
  const f = await fixture(t, theme);
  f.paths.project = "/東京/🌱/e\u0301/\x1b[2Jhost-policy/config.toml";
  // Rebuild the home rows after replacing the source-path metadata.
  f.panel.handleInput("\r"); await tick();
  f.panel.handleInput("\r"); await tick();
  for (const width of [24, 32, 40, 80, 120]) for (const height of [1, 3, 6, 24]) {
    f.terminal.columns = width; f.terminal.rows = height;
    for (let i = 0; i < 15; i++) {
      const lines = f.panel.render(width);
      assert.equal(lines.length, height); assert.ok(lines.every((line) => visibleWidth(line) === width));
      assert.doesNotMatch(lines.join(""), /\x1b\[2J/);
      f.panel.handleInput("\t");
    }
  }
});

test("native auto_start edits are live preferences, never an implicit host handoff", async (t) => {
  const f = await fixture(t, plainTheme, true); f.calls.length = 0;
  await f.choose("Section"); await f.choose("General"); await f.choose("auto_start:"); await f.choose("Use false");
  await f.choose(SAVE_LABELS[0]); assert.doesNotMatch(f.text(), /RESTART/); await f.choose("Confirm");
  assert.equal(f.control.getState().status, "active"); assert.equal(f.integration!.provider.isActive(), true);
  assert.equal(f.integration!.configRef.value.autoStart, false); assert.equal(f.integration!.configRef.value.fallbackMode, "block"); assert.equal(f.integration!.configRef.value.allowHostExecution, false);
  assert.ok(!f.calls.some((call) => /^(stop|remove|create):/.test(call)));
  const { registerSandboxTools } = await import("./tools.ts");
  const tools = new Map<string, any>();
  registerSandboxTools({ registerTool: (tool: any) => tools.set(tool.name, tool), on() {} } as any, { provider: f.integration!.provider, config: f.integration!.configRef.value, cwd: f.input.cwd,
    hostReads: (await import("./skill-access.ts")).createHostReadAccess(),
    createGrepExecute: () => async () => ({ content: [] }),
    grepHelpers: { DEFAULT_MAX_BYTES: 1000, DEFAULT_MAX_LINES: 100, truncateHead: (content: string) => ({ content, truncated: false }), truncateLine: (text: string) => ({ text, wasTruncated: false }), formatSize: (bytes: number) => `${bytes} bytes` },
    systemPromptNote: () => "" });
  const ctx = { cwd: f.input.cwd, hasUI: true, ui: { confirm: async () => { assert.fail("Host approval must remain disabled"); } } } as any;
  const result = await tools.get("bash").execute("sandbox-routing", { command: "printf HOST_HANDOFF_SENTINEL" }, undefined, undefined, ctx);
  assert.doesNotMatch(JSON.stringify(result), /HOST_HANDOFF_SENTINEL/);
  await assert.rejects(tools.get("bash").execute("host-disabled", { command: "true", execution_target: "host" }, undefined, undefined, ctx), /host execution.*disabled/i);
});

test("native Reload and Enable refresh the retained draft while preserving deliberate edits", async (t) => {
  const f = await fixture(t, plainTheme, true);
  await f.choose("Section"); await f.choose("Resources"); await f.choose("cpus:"); await f.choose("Edit value"); await f.key("\x7f"); await f.key("2"); await f.key("\r");
  for (const action of ["Reload settings", "Enable sandbox"]) {
    await f.choose("Section"); await f.choose("Actions"); await f.choose(action); await f.choose("Confirm");
    assert.doesNotMatch(f.text(), /Draft refresh failed/);
  }
  await f.choose("Section"); await f.choose("General"); await f.choose("show_footer:"); await f.choose("Use false");
  await f.choose(SAVE_LABELS[0]); await f.choose("Confirm");
  assert.equal(f.integration!.configRef.value.cpus, 2); assert.equal(f.integration!.configRef.value.showFooter, false);
  assert.match(f.text(), /Applied/); assert.doesNotMatch(f.text(), /stale|refresh failed/);
});

test("saved settings with failed native activation leave an editable panel and retryable runtime", async (t) => {
  const f = await fixture(t, plainTheme, true);
  const builder = f.sdk.Sandbox.builder; let fail = true;
  f.sdk.Sandbox.builder = (name: string) => { const result = builder(name); if (fail) result.create = async () => { throw new Error("test activation failure"); }; return result; };
  await f.choose("Section"); await f.choose("Resources"); await f.choose("cpus:"); await f.choose("Edit value"); await f.key("\x7f"); await f.key("2"); await f.key("\r");
  f.terminal.columns = 24; f.terminal.rows = 3;
  await f.choose("Apply temporarily"); await f.choose("Confirm");
  assert.match(f.text(), /Result: Saved/); assert.equal(f.control.getState().status, "unavailable");
  assert.doesNotMatch(f.text(), /unsaved/);
  await f.choose("Section"); await f.choose("General"); await f.choose("show_footer:"); await f.choose("Use false");
  fail = false;
  await f.choose("Section"); await f.choose("Actions"); await f.choose("Reload settings"); await f.choose("Confirm");
  assert.equal(f.control.getState().status, "active");
  await f.choose("Apply temporarily"); await f.choose("Confirm");
  assert.equal(f.integration!.configRef.value.cpus, 2); assert.equal(f.integration!.configRef.value.showFooter, false); assert.match(f.text(), /Applied/);
});

test("validation and successful save feedback is visible and scrollable at 24x1 and 24x3", async (t) => {
  for (const height of [1, 3]) {
    const f = await fixture(t); f.terminal.columns = 24; f.terminal.rows = height;
    await f.choose("Search all"); await f.key("cpus"); await f.key("\r"); await f.choose("cpus:"); await f.choose("Edit value"); await f.key("\x7f"); await f.key("0"); await f.key("\r");
    await f.choose("Apply temporarily"); assert.match(f.text(), /Result: Validation/);
    await f.key("\r"); // focusable result opens the complete result text
    let seen = ""; for (let i = 0; i < 30; i++) { seen += f.text() + "\n"; await f.key("\x1b[B"); }
    assert.match(seen, /Draft retained/); await f.key("\x1b");
    await f.choose("Search all"); await f.key("cpus"); await f.key("\r"); await f.choose("cpus:"); await f.choose("Edit value"); await f.key("\x7f"); await f.key("2"); await f.key("\r");
    await f.choose("Apply temporarily"); await f.choose("Confirm"); assert.match(f.text(), /Result: Applied/);
  }
});

test("panel inputs preserve Kitty printable keys and ordinary split paste", async (t) => {
  const f = await fixture(t);
  await f.choose("Section"); await f.choose("Network"); await f.choose("network.allow_hosts:"); await f.choose("Add entry"); await f.choose("Value:");
  for (const chunk of ["\x1b[200~api.", "example", ".com\x1b[201~"]) await f.key(chunk);
  await f.key("\r"); await f.choose("Keep draft entry"); assert.match(f.text(), /api\.example\.com/);
  await f.choose("Back"); await f.choose("Section"); await f.choose("Secrets"); await f.choose("secrets:"); await f.choose("Add secret");
  await f.choose("Environment name"); await f.key("TOKEN"); await f.key("\r"); await f.choose("Allowed hosts"); await f.key("a.example"); await f.key("\r"); await f.choose("Replace value");
  for (const char of "KITTY_SECRET") { await f.key(`\x1b[${char.codePointAt(0)}u`); assert.doesNotMatch(f.text(), /KITTY_SECRET/); }
  await f.key("\r"); await f.choose("Keep draft entry"); await f.choose("Back"); await f.choose("Apply temporarily"); await f.choose("Confirm");
  assert.equal(f.settings.temporary().secrets![0]!.value, "KITTY_SECRET");
});

test("automatic sandbox naming overrides a lower-layer custom name only in temporary scope", async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.paths.global!), { recursive: true });
  await writeFile(f.paths.global!, 'sandbox_name = "lower-name"\n');
  await f.choose("Section"); await f.choose("Actions"); await f.choose("Reload settings"); await f.choose("Confirm");
  await f.choose("Section"); await f.choose("General"); await f.choose("sandbox_name:"); await f.choose("Use automatic session");
  await f.choose(SAVE_LABELS[1]); assert.match(f.text(), /temporary-only override/);
  assert.match(await readFile(f.paths.global!, "utf8"), /lower-name/);
  await f.choose(SAVE_LABELS[0]); await f.choose("Confirm"); assert.equal(f.settings.temporary().sandboxName, null);
  assert.equal((await f.settings.open("temporary")).snapshot().automaticSandboxName, true);
});

test("diagnostics include a validated log-tail selector, prune errors and Docker reasons", async (t) => {
  const f = await fixture(t); let tail: number | undefined;
  f.control.getLogs = async (value) => { tail = value; return "selected log"; };
  f.control.pruneNow = async () => ({ inspected: 1, removed: [], kept: ["live"], errors: ["Test diagnostic: owner conflict"] });
  f.control.getState = () => ({ status: "active", info: { name: "guest", displayId: "guest", image: "test", pid: 1, createdAt: Date.now(), root: "/repo", cwd: "/repo", docker: { mode: "auto", readiness: "missing", reason: "Docker components not present" } } });
  await f.choose("Section"); await f.choose("Overview"); await f.seek("Docker detail:"); assert.match(f.text(), /Docker components not present/);
  await f.choose("Section"); await f.choose("Actions"); await f.choose("Recent logs"); await f.key("\x7f"); await f.key("\x7f"); await f.key("\x7f"); await f.key("25"); await f.key("\r"); assert.equal(tail, 25); assert.match(f.text(), /selected log/);
  await f.choose("Back"); await f.choose("Prune stale"); await f.choose("Confirm"); assert.match(f.text(), /Test diagnostic: owner conflict/);
});

test("project collection saves reconcile an existing raw removal control instead of silently vetoing the edit", async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.paths.project!), { recursive: true });
  await writeFile(f.paths.project!, 'route_tools = ["read"]\nremove_route_tools = ["bash"]\nremove_host_env = ["KEEP_REMOVED"]\n');
  await f.choose("Section"); await f.choose("Actions"); await f.choose("Reload settings"); await f.choose("Confirm");
  await f.choose("Section"); await f.choose("Advanced"); await f.choose("route_tools:"); await f.choose("Add entry"); await f.choose("Value:"); await f.key("bash"); await f.key("\r"); await f.choose("Keep draft entry"); await f.choose("Back");
  await f.choose(SAVE_LABELS[1]); assert.match(f.text(), /remove_route_tools/); await f.choose("Confirm");
  const config = await resolveConfig(f.input); assert.deepEqual(config.config.routeTools, ["read", "bash"]);
  const saved = await readFile(f.paths.project!, "utf8"); assert.match(saved, /KEEP_REMOVED/); assert.match(saved, /"remove_route_tools" = \[\]/);
});

test("invalid log-tail input is actionable even on a short terminal and never calls diagnostics", async (t) => {
  const f = await fixture(t); let calls = 0; f.control.getLogs = async () => { calls++; return ""; };
  await f.choose("Section"); await f.choose("Actions"); await f.choose("Recent logs");
  await f.key("\x7f"); await f.key("\x7f"); await f.key("\x7f"); await f.key("-1");
  f.terminal.columns = 24; f.terminal.rows = 3; await f.key("\r");
  assert.match(f.text(), /Result: Invalid log/); assert.equal(calls, 0);
});

test("failed native reset still discards the explicitly confirmed draft and permits new edits", async (t) => {
  const f = await fixture(t, plainTheme, true);
  await f.choose("Section"); await f.choose("Resources"); await f.choose("cpus:"); await f.choose("Edit value"); await f.key("\x7f"); await f.key("2"); await f.key("\r"); await f.choose(SAVE_LABELS[0]); await f.choose("Confirm");
  const builder = f.sdk.Sandbox.builder; let fail = true;
  f.sdk.Sandbox.builder = (name: string) => { const result = builder(name); if (fail) result.create = async () => { throw new Error("test reset failure"); }; return result; };
  await f.choose("Section"); await f.choose("General"); await f.choose("show_footer:"); await f.choose("Use false");
  await f.choose("Section"); await f.choose("Actions"); await f.choose("Reset temporary"); await f.choose("Confirm");
  assert.match(f.text(), /Action failed/); assert.doesNotMatch(f.text(), /unsaved|Draft refresh failed/); assert.deepEqual(f.settings.temporary(), {});
  fail = false;
  await f.choose("Section"); await f.choose("Resources"); await f.choose("cpus:"); await f.choose("Edit value"); await f.key("\x7f"); await f.key("3"); await f.key("\r"); await f.choose(SAVE_LABELS[0]); await f.choose("Confirm");
  assert.equal(f.control.getState().status, "active"); assert.equal(f.integration!.configRef.value.cpus, 3); assert.equal(f.integration!.configRef.value.showFooter, true);
});

async function seedScopedPanelSecrets(f: Awaited<ReturnType<typeof fixture>>, editFile = false) {
  await mkdir(dirname(f.paths.project!), { recursive: true });
  await writeFile(join(dirname(f.paths.project!), "private-token"), "PRIVATE_FILE_BYTES");
  await writeFile(join(dirname(f.paths.project!), "edit-token"), "EDIT_FILE_BYTES");
  await writeFile(join(dirname(f.paths.global!), "global-token"), "GLOBAL_FILE_BYTES");
  await writeFile(f.paths.global!, 'secrets = [{ env = "TARGET_ONLY", value = "$ENV:GLOBAL_REF", allow_hosts = ["global.example"] }, { env = "TARGET_FILE", value = "$FILE:global-token", allow_hosts = ["global.example"] }]\n');
  await writeFile(f.paths.project!, `secrets = [{ env = "EDIT", value = "${editFile ? "$FILE:edit-token" : "$ENV:EDIT_REF"}", allow_hosts = ["edit.example"] }, { env = "PRIVATE_LITERAL", value = "PRIVATE_LITERAL_BYTES", allow_hosts = ["private.example"] }, { env = "PRIVATE_FILE", value = "$FILE:private-token", allow_hosts = ["private.example"] }]\n`);
  await f.choose("Section"); await f.choose("Actions"); await f.choose("Reload settings"); await f.choose("Confirm");
  f.terminal.columns = 120; f.terminal.rows = 40;
}

async function panelSecretHostEdit(f: Awaited<ReturnType<typeof fixture>>, host: string) {
  await f.choose("Allowed hosts"); await f.key("\x15"); await f.key(host); await f.key("\r");
}

async function openPanelSecrets(f: Awaited<ReturnType<typeof fixture>>) {
  await f.choose("Section"); await f.choose("Secrets"); await f.choose("secrets:");
}

test("UI global secret metadata/value editing preserves target-only credentials and never promotes unrelated project secrets", async (t) => {
  const f = await fixture(t); await seedScopedPanelSecrets(f); await openPanelSecrets(f);
  await f.choose("EDIT:"); await panelSecretHostEdit(f, "edited.example"); await f.choose("Keep draft entry");
  await f.choose("EDIT:"); await f.choose("Replace value"); await f.key("$ENV:NEW_REF"); assert.doesNotMatch(f.text(), /\$ENV:NEW_REF/); await f.key("\r"); await f.choose("Keep draft entry");
  await f.choose("EDIT:"); await panelSecretHostEdit(f, "final.example"); await f.choose("Keep draft entry"); await f.choose("Back");
  await f.choose(SAVE_LABELS[2]);
  for (const width of [80, 120]) {
    f.terminal.columns = width;
    const preview = f.text().replace(/\s+/g, " ");
    assert.match(preview, /UPSERT secrets\[EDIT\]/); assert.match(preview, /host-project/); assert.ok(f.text().split("\n").map((line) => line.trim()).join("").includes(f.paths.project!)); assert.match(preview, /DELIBERATE higher-scope import/);
    assert.doesNotMatch(f.text(), /PRIVATE_LITERAL_BYTES|PRIVATE_FILE_BYTES|NEW_REF/);
  }
  await f.choose("Confirm");
  const text = await readFile(f.paths.global!, "utf8"); const secrets = (await import("./config.ts")).parseTomlConfig(text, "global").value.secrets!;
  assert.deepEqual(secrets.map((entry) => entry.env), ["TARGET_ONLY", "TARGET_FILE", "EDIT"]); assert.equal(secrets[1]!.value, "$FILE:global-token"); assert.equal(secrets[2]!.value, "$ENV:NEW_REF"); assert.deepEqual(secrets[2]!.allowHosts, ["final.example"]);
  assert.doesNotMatch(text, /PRIVATE_|private-token|GLOBAL_FILE_BYTES/);
});

test("UI global FILE metadata editing preserves the chosen project reference origin but no unrelated entry", async (t) => {
  const f = await fixture(t); await seedScopedPanelSecrets(f, true); await openPanelSecrets(f);
  await f.choose("EDIT:"); await panelSecretHostEdit(f, "edited.example"); await f.choose("Keep draft entry"); await f.choose("Back"); await f.choose(SAVE_LABELS[2]); await f.choose("Confirm");
  const text = await readFile(f.paths.global!, "utf8"); assert.ok(text.includes(`$FILE:${join(dirname(f.paths.project!), "edit-token")}`)); assert.doesNotMatch(text, /EDIT_FILE_BYTES|PRIVATE_|private-token/);
});

test("UI add/delete global secret intents exclude project siblings and report shadowed higher-scope deletion", async (t) => {
  const f = await fixture(t); await seedScopedPanelSecrets(f); await openPanelSecrets(f);
  await f.choose("Add secret"); await f.choose("Environment name"); await f.key("NEW"); await f.key("\r"); await panelSecretHostEdit(f, "new.example"); await f.choose("Replace value"); await f.key("$ENV:NEW"); await f.key("\r"); await f.choose("Keep draft entry"); await f.choose("Back"); await f.choose(SAVE_LABELS[2]); await f.choose("Confirm");
  let text = await readFile(f.paths.global!, "utf8"); assert.doesNotMatch(text, /PRIVATE_|env = "EDIT"/); assert.match(text, /NEW/); assert.match(text, /TARGET_ONLY/);
  await openPanelSecrets(f); await f.choose("EDIT:"); await f.choose("Delete entry"); await f.choose("Back"); await f.choose(SAVE_LABELS[2]);
  for (const width of [80, 120]) {
    f.terminal.columns = width;
    const preview = f.text().replace(/\s+/g, " ");
    assert.match(preview, /REMOVE secrets\[EDIT\]/); assert.match(preview, /shadowed; not effective here/);
  }
  await f.choose("Confirm");
  assert.match(f.text(), /No changes/); assert.match(f.text(), /secrets\[EDIT\]/); assert.equal(await readFile(f.paths.global!, "utf8"), text);
});

test("UI explicit secret clear is distinguished from CRUD and affects only the chosen scope", async (t) => {
  const f = await fixture(t); await seedScopedPanelSecrets(f); await openPanelSecrets(f);
  await f.choose("Clear secrets"); await f.choose("Back"); await f.choose(SAVE_LABELS[2]);
  for (const width of [80, 120]) {
    f.terminal.columns = width;
    const preview = f.text().replace(/\s+/g, " ");
    assert.match(preview, /CLEAR secrets\[whole list\]/); assert.match(preview, /explicit whole-list intent/);
  }
  await f.choose("Confirm");
  assert.deepEqual((await import("./config.ts")).parseTomlConfig(await readFile(f.paths.global!, "utf8"), "global").value.secrets, []);
  assert.match(await readFile(f.paths.project!, "utf8"), /PRIVATE_LITERAL/);
});

test("UI mount and allow-host entry edits preserve global entries without importing project siblings", async (t) => {
  const f = await fixture(t); await mkdir(dirname(f.paths.project!), { recursive: true });
  await writeFile(f.paths.global!, 'mounts = [{ type = "tmpfs", guest_path = "/mnt/global", readonly = true }]\nnetwork.allow_hosts = ["global.example"]\n');
  await writeFile(f.paths.project!, 'mounts = [{ type = "tmpfs", guest_path = "/mnt/edit", readonly = true }, { type = "tmpfs", guest_path = "/mnt/private-data", readonly = true }]\nnetwork.allow_hosts = ["edit.example", "private.example"]\n');
  await f.choose("Section"); await f.choose("Actions"); await f.choose("Reload settings"); await f.choose("Confirm");
  await f.choose("Section"); await f.choose("Mounts"); await f.choose("mounts:"); await f.choose("/mnt/edit"); await f.choose("Read only:"); await f.choose("false"); await f.choose("Keep draft entry"); await f.choose("Back");
  await f.choose("Section"); await f.choose("Network"); await f.choose("network.allow_hosts:"); await f.choose("edit.example"); await f.choose("Value:"); await f.key("\x15"); await f.key("chosen.example"); await f.key("\r"); await f.choose("Keep draft entry"); await f.choose("Back"); await f.choose(SAVE_LABELS[2]); await f.choose("Confirm");
  const text = await readFile(f.paths.global!, "utf8"); const raw = (await import("./config.ts")).parseTomlConfig(text, "global").value;
  assert.deepEqual(raw.mounts!.map((mount) => mount.guestPath), ["/mnt/global", "/mnt/edit"]); assert.equal(raw.mounts![1]!.readonly, false);
  assert.deepEqual(raw.network!.allowHosts, ["global.example", "chosen.example"]); assert.doesNotMatch(text, /private/);
});

test("UI project/global entry saves exclude committed temporary entries from their baselines", async (t) => {
  for (const scope of [1, 2]) {
    const f = await fixture(t); await seedScopedPanelSecrets(f);
    const temporary = await f.settings.open("temporary"); temporary.upsertSecret({ env: "TEMP_PRIVATE", value: "TEMP_PRIVATE_BYTES", allowHosts: ["temp.example"] }); await temporary.apply();
    await f.choose("Section"); await f.choose("Actions"); await f.choose("Reload settings"); await f.choose("Confirm");
    await openPanelSecrets(f); await f.choose("Add secret"); await f.choose("Environment name"); await f.key("NEW"); await f.key("\r"); await panelSecretHostEdit(f, "new.example"); await f.choose("Replace value"); await f.key("$ENV:NEW"); await f.key("\r"); await f.choose("Keep draft entry"); await f.choose("Back"); await f.choose(SAVE_LABELS[scope]!); await f.choose("Confirm");
    const text = await readFile(scope === 1 ? f.paths.project! : f.paths.global!, "utf8"); assert.doesNotMatch(text, /TEMP_PRIVATE/); assert.match(text, /NEW/);
    if (scope === 2) assert.doesNotMatch(text, /PRIVATE_LITERAL|PRIVATE_FILE/);
  }
});
