import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
const APPLY = ["Apply for current running sandbox only", "Apply for all sandboxes in this project", "Apply for all sandboxes globally on this host"];
const ROOT_GROUPS = ["General", "Resources", "Network", "Secrets", "Mounts", "Advanced", "Status", "Sources & warnings", "Actions"];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text } as any;
async function fixture(t: any, theme = plainTheme, native = false) {
  const root = await realpath(await mkdtemp("/tmp/msb-panel-")); t.after(() => rm(root, { recursive: true, force: true }));
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
  const selected = () => full().split("\n").find((line) => line.startsWith("> "))?.slice(2).replace(/^\s*[▾▸]?\s*/, "").trimEnd().replace(/^\[ (.*) \]$/, "$1") ?? "";
  const seek = async (label: string) => { for (let n = 0; n < 300; n++) { if (selected().startsWith(label)) return; await key("j"); } assert.fail(`unreachable row: ${label}\n${text()}`); };
  const choose = async (label: string) => { await seek(label); await key("\r"); };
  const tree = async () => { for (let n = 0; n < 8 && !full().split("\n").some((line) => /^[> ] [▾▸] /.test(line) && ROOT_GROUPS.includes(line.slice(4).trimEnd())); n++) await key("\x1b"); };
  const expand = async (label: string) => { await seek(label); const line = full().split("\n").find((line) => line.startsWith("> ")); if (line?.includes("▸")) await key("l"); };
  const node = async (group: string, label?: string) => { await tree(); await expand(group); if (label) await seek(label); };
  const edit = async (group: string, label: string) => { await node(group, label); await key("e"); };
  const save = async (scope = 0) => { await choose(APPLY[scope]!); };
  const apply = async (scope = 0) => { await save(scope); if (full().includes("Review change")) await choose("Confirm"); await tree(); };
  const action = async (label: string) => { await node("Actions", label); await key("\r"); };
  const list = async (group: string, label: string) => { await node(group, label); await expand(label); };
  const number = async (value: string) => { await edit("Resources", "Virtual CPUs:"); await key("\x15"); await key(value); await key("\r"); };
  t.after(() => panel.dispose());
  return { root, input, settings, control, integration, sdk, ctx, calls, panel, terminal, key, seek, choose, tree, expand, node, edit, save, apply, action, list, number, selected, full, text, paths, closed: () => closed };
}

test("settings inventory describes every public schema leaf", () => {
  assert.deepEqual(SETTINGS_FIELDS.map((field) => field.path), SETTINGS_PATHS);
  assert.ok(SETTINGS_FIELDS.every((field) => field.description?.length > 10));
});

test("collapsed groups are direct roots under MICROSANDBOX with vim and arrow tree parity", async (t) => {
  const f = await fixture(t);
  const initial = f.text().split("\n");
  assert.equal(initial[0]!.trimEnd(), "MICROSANDBOX");
  assert.deepEqual(initial.slice(1, 1 + ROOT_GROUPS.length).map((line) => line.slice(4).trimEnd()), ROOT_GROUPS);
  assert.ok(initial.slice(1, 1 + ROOT_GROUPS.length).every((line) => /^[> ] ▸ /.test(line)));
  assert.doesNotMatch(f.full(), /Configuration|Section:|Search all|Apply temporarily/);
  assert.equal(f.selected(), "General");
  for (const group of ROOT_GROUPS) {
    await f.seek(group);
    for (const left of ["h", "\x1b[D"]) { await f.key(left); assert.equal(f.selected(), group); }
  }
  for (const [left, right, down, up] of [["h", "l", "j", "k"], ["\x1b[D", "\x1b[C", "\x1b[B", "\x1b[A"]]) {
    await f.seek("General");
    await f.key(right); assert.equal(f.selected(), "General"); assert.match(f.full(), /> ▾ General/);
    await f.key(right); assert.match(f.selected(), /Guest image/); assert.match(f.full(), />     Guest image:/);
    await f.key(left); assert.equal(f.selected(), "General");
    await f.key(left); assert.match(f.full(), /> ▸ General/);
    await f.key(left); assert.equal(f.selected(), "General");
    await f.key(down); assert.equal(f.selected(), "Resources");
    await f.key(up); assert.equal(f.selected(), "General");
  }
  await f.node("Status"); await f.key("h"); assert.equal(f.selected(), "Status"); assert.match(f.full(), /▸ Status *$/m);
  assert.doesNotMatch(f.full(), /State:|Runtime|Actually adopted|Policy snapshot unavailable/);
  assert.equal(f.full().split("\n").filter((line) => /^[> ] [▾▸] /.test(line)).length, ROOT_GROUPS.length);
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
      assert.doesNotMatch(footer, /w\/P\/G|w ephemeral/); assert.match(footer, /e/); assert.match(footer, /d/);
      assert.match(footer, /j\/k h\/l|↑↓←→|j\/k move/);
      assert.doesNotMatch(lines.slice(0, -1).join("\n"), /q close|w\/P\/G|w ephemeral/);
    }
  }
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

test("long dangerous confirmations remain readable with arrows at short heights", async (t) => {
  const f = await fixture(t); f.terminal.columns = 24; f.terminal.rows = 3; await f.action("Turn off"); await f.key("k");
  let seen = ""; for (let n = 0; n < 30; n++) { seen += f.text(); await f.key("\x1b[B"); }
  assert.match(seen, /HOST/); assert.match(seen, /ephemeral/); assert.match(seen, /lost/);
});

test("edit choices omit Use and Back uses the muted theme color", async (t) => {
  const colors: Array<[string, string]> = [];
  const theme = { ...plainTheme, fg: (role: string, text: string) => { colors.push([role, text]); return text; } };
  const f = await fixture(t, theme);
  await f.edit("General", "Show Footer:");
  assert.doesNotMatch(f.full(), /\bUse /);
  await f.seek("false"); assert.equal(f.selected(), "false");
  await f.seek("Back"); colors.length = 0; f.panel.render(80);
  assert.ok(colors.some(([role, text]) => role === "muted" && text === "Back"));
  assert.ok(colors.some(([role, text]) => role === "text" && text === "false"));
  await f.key("\r");
  await f.edit("General", "Sandbox name:");
  assert.doesNotMatch(f.full(), /\bUse /);
  await f.seek("Automatic session");
  assert.match(f.selected(), /^Automatic session name/);
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


async function addSecret(f: Awaited<ReturnType<typeof fixture>>, name = "TOKEN", value = "SECRET_SENTINEL_123") {
  await f.list("Secrets", "Secrets:"); await f.key("a");
  await f.choose("Environment name:"); await f.key(name); await f.key("\r");
  await f.choose("Allowed hosts:"); await f.key("api.example.com"); await f.key("\r");
  await f.choose("Replace value"); await f.key(`\x1b[200~${value}\x1b[201~`);
  assert.doesNotMatch(f.text(), /SECRET_SENTINEL/); await f.key("\r");
}
async function mount(f: Awaited<ReturnType<typeof fixture>>) {
  await f.list("Mounts", "Mounts:"); await f.key("a"); await f.choose("Type:"); await f.choose("tmpfs");
  await f.choose("Guest path:"); await f.key("/scratch"); await f.key("\r");
}
async function storage(f: Awaited<ReturnType<typeof fixture>>, scope: number) {
  return scope === 0 ? f.settings.temporary() : parseTomlConfig(await readFile(f.paths[scope === 1 ? "project" : "global"]!, "utf8"), "global").value;
}

for (const scope of [0, 1, 2]) {
  test(`isolated scalar edit, chosen-scope inheritance and automatic reload once: ${scope}`, async (t) => {
    const f = await fixture(t); await f.number("2");
    assert.match(f.full(), /Apply for current running sandbox only/); assert.doesNotMatch(f.full(), /unsaved|draft|\* draft/i);
    assert.deepEqual(f.calls, []); await f.save(scope); assert.match(f.full(), /RESTART/); assert.equal(f.selected(), "Cancel");
    await f.choose("Confirm"); assert.equal((await storage(f, scope)).cpus, 2); assert.deepEqual(f.calls, ["idle", "reload"]);
    await f.node("Resources", "Virtual CPUs:"); await f.key("d"); await f.save(scope);
    assert.match(f.full(), /inherit\s+→/); await f.choose("Confirm"); assert.equal((await storage(f, scope)).cpus, undefined);
    assert.deepEqual(f.calls, ["idle", "reload", "idle", "reload"]);
  });
  test(`list add/edit/remove keeps entry intent, no bulk clear: ${scope}`, async (t) => {
    const f = await fixture(t); await f.list("Network", "Allowed hosts:");
    const before = f.selected(); await f.key("d"); assert.equal(f.selected(), before); assert.doesNotMatch(f.full(), /Clear list/i);
    await f.key("a"); await f.key("api.example"); await f.key("\r"); await f.apply(scope);
    await f.list("Network", "Allowed hosts:"); await f.seek("api.example"); await f.key("e"); await f.key("\x15"); await f.key("new.example"); await f.key("\r"); await f.apply(scope);
    assert.deepEqual((await storage(f, scope)).network!.allowHosts, ["new.example"]);
    await f.list("Network", "Allowed hosts:"); await f.seek("new.example"); await f.key("d"); await f.save(scope);
    assert.match(f.full(), /REMOVE network.allow_hosts\[new.example\]/); assert.doesNotMatch(f.full(), /CLEAR|whole list/);
    await f.choose("Confirm"); assert.deepEqual((await storage(f, scope)).network!.allowHosts, []);
    assert.deepEqual(f.calls, ["idle", "reload", "idle", "reload", "idle", "reload"]);
  });
  test(`secret form scope buttons, masked retention, rename and remove: ${scope}`, async (t) => {
    const f = await fixture(t); await addSecret(f); assert.doesNotMatch(f.full(), /Keep draft|Save|Delete entry/);
    for (const label of APPLY) assert.ok(f.full().includes(label)); await f.apply(scope);
    assert.equal((await storage(f, scope)).secrets![0]!.value, "SECRET_SENTINEL_123");
    await f.list("Secrets", "Secrets:"); await f.expand("TOKEN:"); await f.key("l"); assert.match(f.selected(), /Environment name:/);
    await f.key("e"); await f.choose("Environment name:"); await f.key("\x15"); await f.key("RENAMED"); await f.key("\r"); await f.apply(scope);
    const secrets = (await storage(f, scope)).secrets!; assert.equal(secrets.length, 1); assert.equal(secrets[0]!.env, "RENAMED"); assert.equal(secrets[0]!.value, "SECRET_SENTINEL_123");
    await f.list("Secrets", "Secrets:"); await f.seek("RENAMED:"); await f.key("d"); await f.apply(scope); assert.deepEqual((await storage(f, scope)).secrets, []);
    assert.doesNotMatch(f.full(), /SECRET_SENTINEL/);
  });
  test(`mount add/edit/rename/remove preserves focus and expansion across resize: ${scope}`, async (t) => {
    const f = await fixture(t); await mount(f); await f.apply(scope); await f.seek("/scratch:"); await f.expand("/scratch:");
    await f.seek("Read only:"); await f.key("e"); await f.choose("Read only:"); await f.choose("false"); await f.apply(scope);
    await f.seek("/scratch:"); assert.match(f.selected(), /rw/); await f.key("e"); await f.choose("Guest path:"); await f.key("\x15"); await f.key("/renamed"); await f.key("\r"); await f.apply(scope);
    assert.match(f.selected(), /\/renamed:/); assert.match(f.full(), /Read only: false/); f.terminal.columns = 24; assert.match(f.selected(), /\/renamed:/);
    await f.key("d"); await f.apply(scope); assert.deepEqual((await storage(f, scope)).mounts, []); assert.match(f.selected(), /Mounts:/);
  });
}

test("cancel scalar/add/list/secret/mount/delete/inherit proposals never leaks into the next scope", async (t) => {
  const f = await fixture(t);
  const producers = [
    () => f.number("3"),
    async () => { await f.list("Network", "Allowed hosts:"); await f.key("a"); await f.key("canceled.example"); await f.key("\r"); },
    () => addSecret(f), () => mount(f),
    async () => { await f.node("Resources", "Virtual CPUs:"); await f.key("d"); },
  ];
  for (const produce of producers) { await produce(); await f.choose("Cancel"); assert.deepEqual(f.calls, []); assert.deepEqual(f.settings.temporary(), {}); }
  await f.number("2"); await f.apply(1);
  const raw = await readFile(f.paths.project!, "utf8"); assert.match(raw, /cpus/); assert.doesNotMatch(raw, /secret|mount|network|3/);
  await f.list("Network", "Allowed hosts:"); await f.key("a"); await f.key("kept.example"); await f.key("\r"); await f.apply(1);
  f.calls.length = 0; const before = await readFile(f.paths.project!, "utf8");
  await f.list("Network", "Allowed hosts:"); await f.seek("kept.example"); await f.key("d"); await f.save(1); await f.choose("Cancel");
  assert.equal(await readFile(f.paths.project!, "utf8"), before); assert.deepEqual(f.calls, []);
  await f.number("4"); await f.key("\x1b"); await f.edit("General", "Show Footer:"); await f.choose("false"); await f.apply(2);
  assert.doesNotMatch(await readFile(f.paths.global!, "utf8"), /cpus|secret|mount|network/);
});

test("q closes non-input screens, default-cancel restores proposal/confirmation and protects forms", async (t) => {
  for (const screen of ["scope", "confirmation", "secret", "choice", "help", "result"]) {
    const f = await fixture(t); let protectedScreen = true;
    if (screen === "scope" || screen === "confirmation") { await f.number("2"); if (screen === "confirmation") await f.save(1); }
    else if (screen === "secret") { await addSecret(f); }
    else { protectedScreen = false; if (screen === "choice") await f.edit("General", "Show Footer:"); else if (screen === "help") await f.action("Help"); else { await f.action("Reload settings"); await f.choose("Confirm"); } }
    const selected = f.selected(), calls = [...f.calls]; await f.key("q");
    if (protectedScreen) { assert.match(f.full(), /Discard proposed change/); assert.equal(f.selected(), "Cancel"); await f.key("q"); assert.equal(f.selected(), "Cancel"); await f.key("\r"); assert.equal(f.selected(), selected); await f.key("q"); await f.choose("Confirm"); }
    assert.equal(f.closed(), true); assert.equal(f.panel.focused, false); assert.deepEqual(f.settings.temporary(), {}); assert.deepEqual(f.calls, calls);
  }
  const f = await fixture(t); await f.number("2"); await f.save(1); await f.key("q"); await f.key("\r"); await f.choose("Confirm"); assert.equal((await storage(f, 1)).cpus, 2);
});

test("validation retry/cancel is redacted, isolated and readable at one/three rows", async (t) => {
  for (const height of [1, 3]) {
    const f = await fixture(t); f.terminal.columns = 24; f.terminal.rows = height;
    await f.number("0"); await f.save(); assert.match(f.text(), /Result: Validation/); assert.deepEqual(f.calls, []);
    let seen = ""; for (let n = 0; n < 45; n++) { seen += f.text() + "\n"; await f.key("\x1b[B"); }
    assert.match(seen, /Nothing applied/); await f.choose("Retry"); await f.save(2); assert.match(f.full(), /Validation failed/); await f.choose("Cancel");
    await f.number("2"); await f.apply(); assert.equal(f.settings.temporary().cpus, 2);
  }
});

test("current-only unavailable while inactive/off, including state loss before confirmation", async (t) => {
  for (const status of ["off", "unavailable", "host-fallback"] as const) {
    const f = await fixture(t); f.control.getState = () => ({ status, info: null }); await f.number("2");
    await f.seek(APPLY[0]!); assert.match(f.full(), /Unavailable: no running sandbox/); await f.key("\r"); assert.deepEqual(f.calls, []); assert.deepEqual(f.settings.temporary(), {});
    await f.apply(1); assert.equal((await storage(f, 1)).cpus, 2);
  }
  const f = await fixture(t); await f.number("2"); await f.save(); f.control.getState = () => ({ status: "off", info: null }); await f.choose("Confirm"); assert.match(f.full(), /Apply failed/); assert.deepEqual(f.settings.temporary(), {}); assert.deepEqual(f.calls, ["idle"]);
});

test("removed save keys do nothing in normal/Kitty/modifyOtherKeys; letters stay literal in editors", async (t) => {
  const commands = "qeadwPGjkh l".replaceAll(" ", "");
  for (const protocol of ["plain", "kitty", "paste"]) {
    const f = await fixture(t);
    for (const data of ["w", "P", "G", "p", "g", "\x1b[112:80;2u", "\x1b[71u", "\x1b[27;2;80~", "\x1b[80;2:3u"]) await f.key(data);
    assert.equal(f.selected(), "General"); assert.deepEqual(f.calls, []);
    const type = async () => { if (protocol === "paste") { await f.key(`\x1b[200~${commands.slice(0, 5)}`); await f.key(`${commands.slice(5)}\x1b[201~`); } else for (const char of commands) await f.key(protocol === "kitty" ? `\x1b[${char.codePointAt(0)}u` : char); };
    await f.list("Network", "Allowed hosts:"); await f.key("a"); await type(); await f.key("\r"); assert.match(f.full(), /Apply change/); assert.equal(f.closed(), false); await f.choose("Cancel");
    await addSecret(f, "TOKEN", "$ENV:PLACEHOLDER"); await f.choose("Replace value"); await type(); assert.doesNotMatch(f.text(), new RegExp(commands)); await f.key("\r"); await f.apply(); assert.equal(f.settings.temporary().secrets![0]!.value, commands);
    await f.number("2"); for (const key of ["w", "P", "G"]) await f.key(key); assert.deepEqual(f.calls, ["idle", "reload"]); await f.choose("Cancel");
  }
});

test("persistence conflict, apply retry, saved/runtime failure and refresh failure report truthful outcomes", async (t) => {
  const f = await fixture(t); await f.number("2"); await f.save(1);
  await mkdir(dirname(f.paths.project!), { recursive: true }); await writeFile(f.paths.project!, "cpus = 3\n");
  await f.choose("Confirm"); assert.match(f.full(), /Apply failed/); assert.deepEqual(f.calls, ["idle"]); assert.match(await readFile(f.paths.project!, "utf8"), /cpus = 3/);
  await f.choose("Retry"); await f.save(1); await f.choose("Confirm"); assert.equal((await storage(f, 1)).cpus, 2);
  await f.tree(); await f.number("4"); f.control.reload = async () => { throw new Error("SECRET_ERROR_SENTINEL"); }; await f.save(1); await f.choose("Confirm");
  assert.match(f.full(), /Saved, but runtime failed/); assert.doesNotMatch(f.full(), /SECRET_ERROR_SENTINEL/); assert.equal((await storage(f, 1)).cpus, 4);
  f.control.reload = async () => { f.calls.push("reload"); }; await f.action("Reload settings"); await f.choose("Confirm"); assert.match(f.full(), /Completed/);
  await f.number("5"); await f.save(1); const open = f.settings.open.bind(f.settings); f.settings.open = async () => { throw new Error("PRIVATE_REFRESH_ERROR"); };
  await f.choose("Confirm"); assert.match(f.full(), /Applied.*Settings refresh failed/); assert.doesNotMatch(f.full(), /PRIVATE_REFRESH_ERROR/); f.settings.open = open;
  await f.tree(); assert.match(f.full(), /Settings unavailable/); assert.doesNotMatch(f.full(), /Virtual CPUs:/);
  await f.action("Reload settings"); await f.choose("Confirm");
  await f.edit("General", "Show Footer:"); await f.choose("false"); await f.apply(2);
  assert.doesNotMatch(await readFile(f.paths.global!, "utf8"), /cpus/);
});

test("async busy rejects double apply/navigation/close and teardown drains without reload after close", async (t) => {
  for (const close of [false, true]) {
    const f = await fixture(t); await f.number("2"); await f.save(); await f.seek("Confirm");
    let release!: () => void, entered!: () => void; const idle = new Promise<void>((resolve) => { entered = resolve; });
    f.ctx.waitForIdle = async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); };
    f.panel.handleInput("\r"); await idle; const selected = f.selected();
    for (const key of ["\r", "q", "\x1b", "j"]) f.panel.handleInput(key); assert.equal(f.selected(), selected); assert.match(f.text(), /Working/);
    if (close) f.panel.close(); release(); await f.panel.waitForIdle();
    assert.deepEqual(f.calls, close ? [] : ["reload"]); assert.deepEqual(f.settings.temporary(), close ? {} : { cpus: 2 });
  }
});

test("network sealing has explicit scope actions; lifecycle retains independent destructive confirmation", async (t) => {
  const f = await fixture(t); await f.action("Seal network"); assert.match(f.full(), /Apply for all sandboxes/); assert.doesNotMatch(f.full(), /in draft/); await f.choose("Cancel"); assert.deepEqual(f.calls, []);
  await f.action("Seal network"); await f.apply(1); assert.equal((await storage(f, 1)).network!.mode, "deny");
  await f.action("Turn off"); assert.match(f.full(), /HOST.*ephemeral state is lost/); assert.equal(f.selected(), "Cancel"); await f.key("\r"); assert.deepEqual(f.calls, ["idle", "reload"]);
  await f.action("Turn off"); await f.choose("Confirm"); assert.deepEqual(f.calls, ["idle", "reload", "idle", "enabled:false"]);
});

test("automatic session name remains current-only; scalar inheritance previews lower chosen-scope value", async (t) => {
  const f = await fixture(t); await mkdir(dirname(f.paths.global!), { recursive: true }); await writeFile(f.paths.global!, 'sandbox_name = "lower-name"\ncpus = 3\n');
  await f.action("Reload settings"); await f.choose("Confirm"); await f.edit("General", "Sandbox name:"); await f.choose("Automatic session"); await f.save(1); assert.match(f.full(), /current-session-only/);
  await f.choose("Retry"); await f.apply(); assert.equal(f.settings.temporary().sandboxName, null);
  await f.node("Resources", "Virtual CPUs:"); await f.key("d"); await f.save(2); assert.match(f.full(), /inherit\s+→/); await f.choose("Confirm"); assert.doesNotMatch(await readFile(f.paths.global!, "utf8"), /cpus/);
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

for (const file of [false, true]) test(`global secret metadata/value edits retain raw credential/origin, never project siblings: FILE=${file}`, async (t) => {
  const f = await fixture(t); await seedScopedPanelSecrets(f, file); await openSecret(f); await panelSecretHostEdit(f, "edited.example"); await f.save(2);
  const preview = f.full().replace(/\s+/g, " "); assert.match(preview, /UPSERT secrets\[EDIT\]/); assert.match(preview, /from project/); assert.match(preview, /DELIBERATE higher-scope import/); assert.doesNotMatch(preview, /PRIVATE_LITERAL_BYTES|PRIVATE_FILE_BYTES|EDIT_FILE_BYTES|EDIT_REF/);
  await f.choose("Confirm"); const text = await readFile(f.paths.global!, "utf8"); const secrets = parseTomlConfig(text, "global").value.secrets!;
  assert.deepEqual(secrets.map((entry) => entry.env), ["TARGET_ONLY", "TARGET_FILE", "EDIT"]); assert.equal(secrets[1]!.value, "$FILE:global-token"); assert.equal(secrets[2]!.value, file ? `$FILE:${join(dirname(f.paths.project!), "edit-token")}` : "$ENV:EDIT_REF"); assert.deepEqual(secrets[2]!.allowHosts, ["edited.example"]); assert.doesNotMatch(text, /PRIVATE_|private-token|GLOBAL_FILE_BYTES/);
  await openSecret(f); await f.choose("Replace value"); await f.key("$ENV:NEW_REF"); await f.key("\r"); await f.apply(2); assert.equal((await storage(f, 2)).secrets![2]!.value, "$ENV:NEW_REF");
});

test("add/delete global secret intents exclude siblings, report shadowing and no-op; ephemeral never exported", async (t) => {
  for (const scope of [1, 2]) {
    const f = await fixture(t); await seedScopedPanelSecrets(f); const ephemeral = await f.settings.open("temporary"); ephemeral.upsertSecret({ env: "TEMP_PRIVATE", value: "TEMP_PRIVATE_BYTES", allowHosts: ["temp.example"] }); await ephemeral.apply(); ephemeral.discard();
    await f.action("Reload settings"); await f.choose("Confirm"); await addSecret(f, "NEW", "$ENV:NEW"); await f.apply(scope);
    const text = await readFile(scope === 1 ? f.paths.project! : f.paths.global!, "utf8"); assert.doesNotMatch(text, /TEMP_PRIVATE/); assert.match(text, /NEW/); if (scope === 2) assert.doesNotMatch(text, /PRIVATE_LITERAL|PRIVATE_FILE/);
  }
  const f = await fixture(t); await seedScopedPanelSecrets(f); const before = await readFile(f.paths.global!, "utf8");
  await f.list("Secrets", "Secrets:"); await f.seek("EDIT:"); await f.key("d"); await f.save(2); assert.match(f.full().replace(/\s+/g, " "), /REMOVE secrets\[EDIT\].*shadowed; not effective here/); await f.choose("Confirm"); assert.match(f.full(), /No changes.*secrets\[EDIT\]/); assert.equal(await readFile(f.paths.global!, "utf8"), before);
});

test("nested secret host and mount options CRUD is identity-scoped, cancel restores credential", async (t) => {
  const f = await fixture(t); await seedScopedPanelSecrets(f, true);
  await f.list("Secrets", "Secrets:"); await f.expand("EDIT:"); await f.expand("Allowed hosts:"); await f.key("a"); await f.key("second.example"); await f.key("\r"); await f.apply(1); assert.match(f.selected(), /second.example/);
  await f.key("e"); await f.key("\x15"); await f.key("chosen.example"); await f.key("\r"); await f.choose("Cancel"); await f.seek("second.example"); await f.key("d"); await f.apply(2);
  const entries = (await storage(f, 2)).secrets!; assert.deepEqual(entries.map((entry) => entry.env), ["TARGET_ONLY", "TARGET_FILE", "EDIT"]); assert.deepEqual(entries[2]!.allowHosts, ["edit.example"]); assert.equal(entries[2]!.value, `$FILE:${join(dirname(f.paths.project!), "edit-token")}`);
  await mount(f); await f.apply(1); await f.seek("/scratch:"); await f.expand("/scratch:"); await f.expand("Options:"); await f.key("a"); await f.key("noexec"); await f.key("\r"); await f.apply(1); assert.match(f.selected(), /noexec/); await f.key("d"); await f.apply(1); assert.deepEqual((await storage(f, 1)).mounts![0]!.options, []);
});

test("mount/list cross-scope edits preserve hidden target entries, raw removal controls and exclude siblings", async (t) => {
  const f = await fixture(t); await mkdir(dirname(f.paths.project!), { recursive: true });
  await writeFile(f.paths.global!, 'mounts = [{ type = "tmpfs", guest_path = "/mnt/global", readonly = true }]\nnetwork.allow_hosts = ["global.example"]\n');
  await writeFile(f.paths.project!, 'mounts = [{ type = "tmpfs", guest_path = "/mnt/edit", readonly = true }, { type = "tmpfs", guest_path = "/mnt/private-data", readonly = true }]\nnetwork.allow_hosts = ["edit.example", "private.example"]\nroute_tools = ["read"]\nremove_route_tools = ["bash"]\nremove_host_env = ["KEEP_REMOVED"]\n');
  await f.action("Reload settings"); await f.choose("Confirm"); await f.list("Mounts", "Mounts:"); await f.seek("/mnt/edit:"); await f.key("e"); await f.choose("Read only:"); await f.choose("false"); await f.apply(2);
  await f.list("Network", "Allowed hosts:"); await f.seek("edit.example"); await f.key("e"); await f.key("\x15"); await f.key("chosen.example"); await f.key("\r"); await f.apply(2);
  const text = await readFile(f.paths.global!, "utf8"); const raw = parseTomlConfig(text, "global").value;
  assert.deepEqual(raw.mounts!.map((mount) => mount.guestPath), ["/mnt/global", "/mnt/edit"]); assert.equal(raw.mounts![1]!.readonly, false); assert.deepEqual(raw.network!.allowHosts, ["global.example", "chosen.example"]); assert.doesNotMatch(text, /private/);
  await f.list("Advanced", "Route Tools:"); await f.key("a"); await f.key("bash"); await f.key("\r"); await f.apply(1);
  assert.deepEqual((await resolveConfig(f.input)).config.routeTools, ["read", "bash"]); const saved = await readFile(f.paths.project!, "utf8"); assert.match(saved, /KEEP_REMOVED/); assert.match(saved, /"remove_route_tools" = \[\]/);
});

for (const [scope, source, label] of [[0, "temporary", "ephemeral"], [1, "host-project", "project"], [2, "host-default", "global"]] as const) test(`native adoption freezes accurate scope origins, runtime readonly and automatic restart: ${scope}`, async (t) => {
  const f = await fixture(t, plainTheme, true); const before = f.control.getRuntimePolicy!()!;
  before.provenance.cpus = "temporary"; assert.notEqual(f.control.getRuntimePolicy!()!.provenance.cpus, "temporary"); const original = f.control.getRuntimePolicy!();
  await f.number("2"); assert.deepEqual(f.control.getRuntimePolicy!(), original); await f.apply(scope);
  const adopted = f.control.getRuntimePolicy!()!; assert.equal(adopted.provenance.cpus, source); assert.equal(parseTomlConfig(adopted.effectiveToml, "global").value.cpus, 2);
  await f.node("Resources", "Virtual CPUs:"); assert.match(f.selected(), new RegExp(`Virtual CPUs: 2 \\[${label}\\]`));
  await f.node("Advanced", "Allow Host Execution:"); assert.match(f.selected(), /\[environment\]/);
  await f.node("Status"); assert.match(f.full(), /State: active \[runtime\]/); assert.ok(f.full().includes(new Date(adopted.adoptedAt).toISOString())); assert.doesNotMatch(f.full().split("Status")[1]!, /Virtual CPUs:|Guest image:/);
  await f.seek("State:"); const selected = f.selected(); for (const key of ["e", "a", "d", "w", "P", "G"]) { await f.key(key); assert.equal(f.selected(), selected); }
  await f.control.setEnabled(false); await f.tree(); await f.node("Status"); assert.match(f.full(), /Last known policy \(not running\)/); f.integration!.endSession(); assert.equal(f.control.getRuntimePolicy!(), undefined);
});

test("native auto_start is live and never implicit host handoff; reconnect policy stays unverified until real restart", async (t) => {
  const f = await fixture(t, plainTheme, true); f.calls.length = 0; await f.edit("General", "Auto Start:"); await f.choose("false"); await f.save(); assert.match(f.full(), /Applied/);
  assert.equal(f.control.getState().status, "active"); assert.equal(f.integration!.provider.isActive(), true); assert.equal(f.integration!.configRef.value.autoStart, false); assert.equal(f.integration!.configRef.value.fallbackMode, "block"); assert.equal(f.integration!.configRef.value.allowHostExecution, false); assert.ok(!f.calls.some((call) => /^(stop|remove|create):/.test(call)));
  const { registerSandboxTools } = await import("./tools.ts"); const tools = new Map<string, any>();
  registerSandboxTools({ registerTool: (tool: any) => tools.set(tool.name, tool), on() {} } as any, { provider: f.integration!.provider, config: f.integration!.configRef.value, cwd: f.input.cwd, hostReads: (await import("./skill-access.ts")).createHostReadAccess(), createGrepExecute: () => async () => ({ content: [] }), grepHelpers: { DEFAULT_MAX_BYTES: 1000, DEFAULT_MAX_LINES: 100, truncateHead: (content: string) => ({ content, truncated: false }), truncateLine: (text: string) => ({ text, wasTruncated: false }), formatSize: (bytes: number) => `${bytes} bytes` }, systemPromptNote: () => "" });
  const ctx = { cwd: f.input.cwd, hasUI: true, ui: { confirm: async () => { assert.fail("Host approval must remain disabled"); } } } as any;
  const result = await tools.get("bash").execute("sandbox-routing", { command: "printf HOST_HANDOFF_SENTINEL" }, undefined, undefined, ctx); assert.doesNotMatch(JSON.stringify(result), /HOST_HANDOFF_SENTINEL/); await assert.rejects(tools.get("bash").execute("host-disabled", { command: "true", execution_target: "host" }, undefined, undefined, ctx), /host execution.*disabled/i);
  const handle = await f.sdk.Sandbox.get(f.control.getState().info!.name); handle.createdAt = new Date(Date.now() + 1000); await f.integration!.manager.withRuntime(async () => {});
  assert.equal(f.control.getRuntimePolicy!()!.verification, "reconnected"); await f.edit("General", "Show Footer:"); await f.choose("false"); await f.apply(); assert.ok(!f.control.getRuntimePolicy!()!.knownFields.includes("cpus")); await f.number("2"); await f.apply(); assert.equal(f.control.getRuntimePolicy!()!.verification, "created");
});

test("native runtime failure leaves immutable last-known policy; reset failures clear only committed overrides", async (t) => {
  const f = await fixture(t, plainTheme, true); const original = f.control.getRuntimePolicy!(); const builder = f.sdk.Sandbox.builder; let fail = true;
  f.sdk.Sandbox.builder = (name: string) => { const result = builder(name); if (fail) result.create = async () => { throw new Error("PRIVATE_REJECTED_CANDIDATE"); }; return result; };
  await f.number("2"); await f.save(1); await f.choose("Confirm"); assert.match(f.full(), /Saved.*runtime failed/); assert.equal(f.control.getState().status, "unavailable"); assert.deepEqual(f.control.getRuntimePolicy!(), original);
  await f.node("Status"); assert.match(f.full(), /Last known policy \(not running\)/); assert.doesNotMatch(f.full(), /PRIVATE_REJECTED_CANDIDATE/);
  fail = false; await f.action("Reload settings"); await f.choose("Confirm"); await f.number("3"); await f.apply(); fail = true;
  await f.action("Reset current sandbox overrides"); await f.choose("Confirm"); assert.match(f.full(), /Action failed/); assert.deepEqual(f.settings.temporary(), {}); fail = false;
  await f.number("4"); await f.apply(1); assert.equal(f.control.getState().status, "active"); assert.equal(f.integration!.configRef.value.cpus, 4);
});

test("one compact themed footer and distinct focusable actions remain accessible at mobile/tiny sizes", async (t) => {
  const theme = { fg: (role: string, text: string) => `\x1b[${role === "accent" ? 36 : role === "muted" ? 90 : 37}m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m`, inverse: (text: string) => `\x1b[7m${text}\x1b[27m` } as any;
  const f = await fixture(t, theme);
  for (const width of [24, 32, 40, 80, 120]) for (const height of [2, 3, 6, 12, 20, 40]) {
    f.terminal.columns = width; f.terminal.rows = height; await f.tree(); await f.seek("General");
    const lines = f.panel.render(width).map(stripTerminalSequences); assert.match(lines.at(-1)!, /q close/); assert.doesNotMatch(lines.at(-1)!, /w\/P\/G|w ephemeral/); assert.equal(lines.filter((line) => line.includes("q close")).length, 1); assert.equal(lines.length, height); assert.ok(lines.every((line) => visibleWidth(line) === width));
  }
  f.terminal.columns = 80; f.terminal.rows = 20; await f.number("2");
  for (const label of [...APPLY, "Cancel"]) { await f.seek(label); assert.equal(f.selected(), label); }
  const frame = f.panel.render(160).join("\n"); assert.ok(frame.includes(theme.fg("accent", theme.bold(`[ ${APPLY[0]} ]`)))); assert.ok(frame.includes(theme.fg("muted", theme.bold("[ Cancel ]")))); assert.match(frame, /\x1b\[7m/);
  for (const width of [24, 32]) for (const height of [1, 2, 3, 12]) { f.terminal.columns = width; f.terminal.rows = height; for (const label of [...APPLY, "Cancel"]) { await f.seek(label); let seen = ""; for (let n = 0; n < 30; n++) { seen += (height >= 2 ? f.text().split("\n").slice(0, -1).join("\n") : f.text()) + "\n"; await f.key("\x1b[6~"); } assert.ok(seen.replace(/\s+/g, " ").includes(label), `${width}x${height}: ${label}`); } }
  await f.choose("Cancel"); await f.list("Network", "Allowed hosts:"); await f.key("a");
  f.terminal.columns = 80; f.terminal.rows = 20; assert.match(f.text().split("\n").at(-1)!, /Enter keep.*Esc cancel.*q literal text/); await f.key("\x1b");
});

test("native live preview cannot authorize a late disruptive restart; saved outcome stays truthful", async (t) => {
  const f = await fixture(t, plainTheme, true); const original = f.control.getRuntimePolicy!();
  await mkdir(dirname(f.paths.project!), { recursive: true });
  f.ctx.waitForIdle = async () => { await writeFile(f.paths.project!, "cpus = 3\n"); };
  await f.edit("General", "Show Footer:"); await f.choose("false"); await f.save();
  assert.match(f.full(), /Saved, but runtime failed/); assert.equal(f.settings.temporary().showFooter, false);
  assert.equal(f.control.getState().status, "active"); assert.deepEqual(f.control.getRuntimePolicy!(), original);
});

test("stale session and retargeted policy anchors reject proposals without writes or promotion", async (t) => {
  const f = await fixture(t); await f.number("2"); await f.save(1);
  f.settings.beginSession(f.input, "different-session"); await f.choose("Confirm"); assert.match(f.full(), /Apply failed/); assert.deepEqual(f.settings.temporary(), {});
  await assert.rejects(readFile(f.paths.project!), { code: "ENOENT" }); await f.choose("Cancel");
  await mkdir(f.input.agentDir); await f.number("3"); await f.save(1); const { rename } = await import("node:fs/promises");
  await rename(f.input.agentDir, `${f.input.agentDir}-moved`); await mkdir(f.input.agentDir);
  await f.choose("Confirm"); assert.match(f.full(), /Apply failed/); await assert.rejects(readFile(f.paths.project!), { code: "ENOENT" });
});

test("theme roles, ANSI and Unicode remain bounded; scalar and entry origins are committed, never dirty", async (t) => {
  const roles = new Set<string>();
  const theme = { fg: (role: string, text: string) => { roles.add(role); return `\x1b[32m${text}\x1b[39m`; }, bold: (text: string) => `\x1b[1m${text}\x1b[22m`, inverse: (text: string) => `\x1b[7m${text}\x1b[27m` } as any;
  const f = await fixture(t, theme); f.paths.project = "/東京/🌱/e\u0301/\x1b[2Jhost-policy/config.toml";
  await f.number("2"); await f.choose("Cancel"); await f.node("Sources & warnings");
  for (const width of [24, 32, 40, 80, 120]) for (const height of [1, 3, 6, 24]) {
    f.terminal.columns = width; f.terminal.rows = height;
    for (let n = 0; n < 15; n++) { const lines = f.panel.render(width); assert.equal(lines.length, height); assert.ok(lines.every((line) => visibleWidth(line) === width)); assert.doesNotMatch(lines.join(""), /\x1b\[2J/); await f.key("j"); }
  }
  for (const role of ["accent", "text", "syntaxString", "dim", "muted"]) assert.ok(roles.has(role), role);
  assert.doesNotMatch(f.full(), /unsaved|\* draft/);
});

test("empty collection origins retain explicit scope after last-entry removal; parents never bulk-inherit", async (t) => {
  const f = await fixture(t);
  for (const [group, label] of [["Secrets", "Secrets:"], ["Mounts", "Mounts:"], ["Network", "Allowed hosts:"], ["Network", "Publish Ports:"]]) { await f.node(group!, label!); assert.match(f.selected(), /0 entries \[default\]/); }
  await f.list("Network", "Allowed hosts:"); await f.key("a"); await f.key("api.example"); await f.key("\r"); await f.apply(1);
  await f.list("Network", "Allowed hosts:"); await f.seek("api.example"); await f.key("d"); await f.apply(1); await f.node("Network", "Allowed hosts:"); assert.match(f.selected(), /0 entries \[project\]/);
  const before = await readFile(f.paths.project!, "utf8"), calls = [...f.calls]; await f.key("d"); assert.equal(await readFile(f.paths.project!, "utf8"), before); assert.deepEqual(f.calls, calls);
  assert.doesNotMatch(f.full(), /Clear list/);
  await f.node("Status"); assert.match(f.full(), /Policy snapshot unavailable: No current policy \[runtime\]/);
});

test("native disabled environment remains authoritative: defaults apply without starting and current-only is unavailable", async (t) => {
  const f = await fixture(t); const integration = createMsbIntegration({ sessionId: "disabled-panel", cwd: f.input.cwd, agentDir: f.input.agentDir, configDirName: ".pi", env: { PI_MSB_DISABLE: "1" }, sdkLoader: async () => { assert.fail("Disabled panel must not load SDK"); } });
  t.after(() => integration.manager.shutdown()); await integration.configureSession({ sessionId: "disabled-panel", cwd: f.input.cwd, projectTrusted: true });
  f.panel.dispose(); const draft = await integration.control.settings!.open("temporary"); let closed = false;
  const panel = new ControlPanel({ draft, control: integration.control, ctx: f.ctx, tui: { terminal: f.terminal, requestRender() {} } as any, theme: plainTheme, paths: f.paths, done: () => { closed = true; } }); t.after(() => panel.dispose());
  const key = async (data: string) => { panel.handleInput(data); await panel.waitForIdle(); };
  const select = async (label: string) => { for (let n = 0; n < 200; n++) { const selected = stripTerminalSequences(panel.render(160).join("\n")).split("\n").find((line) => line.startsWith("> ")); if (selected?.slice(2).replace(/^\s*[▾▸]?\s*/, "").replace(/^\[ /, "").startsWith(label)) return; await key("j"); } assert.fail(label); };
  await select("General"); await key("l"); await select("Show Footer:"); await key("e"); await select("false"); await key("\r"); await select(APPLY[0]!); await key("\r");
  assert.match(stripTerminalSequences(panel.render(160).join("\n")), /Unavailable: no running sandbox/); assert.deepEqual(integration.control.settings!.temporary(), {});
  await select(APPLY[1]!); await key("\r"); assert.equal(integration.control.getState().status, "off"); assert.match(stripTerminalSequences(panel.render(160).join("\n")), /Applied.*Runtime: off/); assert.equal(closed, false);
});

async function committedPanelSettings(f: Awaited<ReturnType<typeof fixture>>) {
  const files = await Promise.all([f.paths.project!, f.paths.global!].map(async (path) => {
    try { return await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }));
  return { files, memory: f.settings.temporary() };
}

for (const scope of [0, 1, 2]) {
  for (const intent of ["pass_through_tools", "block_third_party"] as const) test(`${intent} host-execution opt-out requires confirmation, cancel is inert, confirm reloads once: ${scope}`, async (t) => {
    const f = await fixture(t, plainTheme, true); f.calls.length = 0;
    const reload = f.control.reload.bind(f.control); f.control.reload = async (options) => { f.calls.push("reload"); await reload(options); };
    const before = await committedPanelSettings(f), runtime = f.control.getRuntimePolicy!();
    const propose = async () => {
      if (intent === "pass_through_tools") { await f.list("Advanced", "Pass Through Tools:"); await f.key("a"); await f.key("third_party_test_tool"); await f.key("\r"); }
      else { await f.edit("Advanced", "Block Third Party:"); await f.choose("false"); }
      await f.save(scope);
      const review = f.full().replace(/\s+/g, " ");
      assert.match(review, /Review change/); assert.ok(review.includes(intent)); assert.match(review, /execute on the HOST outside the sandbox without per-call host approval/);
      assert.doesNotMatch(review, /RESTART:/); assert.equal(f.selected(), "Cancel");
      assert.deepEqual(await committedPanelSettings(f), before); assert.deepEqual(f.control.getRuntimePolicy!(), runtime); assert.deepEqual(f.calls, []);
    };
    await propose(); await f.choose("Cancel");
    assert.deepEqual(await committedPanelSettings(f), before); assert.deepEqual(f.control.getRuntimePolicy!(), runtime); assert.deepEqual(f.calls, []);
    await propose(); await f.choose("Confirm"); assert.deepEqual(f.calls, ["idle", "reload"]);
    const raw = await storage(f, scope), adopted = parseTomlConfig(f.control.getRuntimePolicy!()!.effectiveToml, "global").value;
    if (intent === "pass_through_tools") { assert.ok(raw.passThroughTools!.includes("third_party_test_tool")); assert.ok(adopted.passThroughTools!.includes("third_party_test_tool")); }
    else { assert.equal(raw.blockThirdParty, false); assert.equal(adopted.blockThirdParty, false); }
    assert.equal(f.control.getState().status, "active");
  });

  for (const [path, label, lower, override, warning] of [
    ["block_third_party", "Block Third Party:", false, true, /HOST execution \/ sandbox bypass: block_third_party = false/],
    ["allow_skill_reads", "Allow Skill Reads:", true, false, /HOST read \/ sandbox bypass: allow_skill_reads = true/],
  ] as const) test(`${path} inheritance warns before loosening host boundary: ${scope}`, async (t) => {
    const f = await fixture(t);
    (f.input.env as Record<string, string>)[`PI_MSB_${path.toUpperCase()}`] = String(lower);
    const target = await f.settings.open((["temporary", "project", "global"] as const)[scope]!); target.set(path, override); await target.apply(); target.discard();
    await f.action("Reload settings"); await f.choose("Confirm"); f.calls.length = 0;
    const before = await committedPanelSettings(f);
    const propose = async () => {
      await f.node("Advanced", label); await f.key("d"); await f.save(scope);
      const review = f.full().replace(/\s+/g, " "); assert.match(review, /Review change/); assert.match(review, warning); assert.ok(review.includes(`${path}: inherit → ${lower}`));
      assert.deepEqual(await committedPanelSettings(f), before); assert.deepEqual(f.calls, []);
    };
    await propose(); await f.choose("Cancel"); assert.deepEqual(await committedPanelSettings(f), before); assert.deepEqual(f.calls, []);
    await propose(); await f.choose("Confirm"); assert.deepEqual(f.calls, ["idle", "reload"]);
    const fresh = await f.settings.open("temporary"); const effective = parseTomlConfig(fresh.snapshot().effectiveToml, "global").value; fresh.discard();
    assert.equal(path === "block_third_party" ? effective.blockThirdParty : effective.allowSkillReads, lower);
  });

  test(`benign footer edit still applies immediately and reloads once: ${scope}`, async (t) => {
    const f = await fixture(t); await f.edit("General", "Show Footer:"); await f.choose("false"); await f.save(scope);
    assert.match(f.full(), /Result: Applied/); assert.doesNotMatch(f.full(), /Review change/); assert.equal((await storage(f, scope)).showFooter, false); assert.deepEqual(f.calls, ["idle", "reload"]);
  });
}

test("pass-through entry rename/removal/no-op and shadowed intents retain explicit HOST warnings", async (t) => {
  const f = await fixture(t); await f.list("Advanced", "Pass Through Tools:"); await f.key("a"); await f.key("third_party_test_tool"); await f.key("\r"); await f.apply(1); f.calls.length = 0;
  const before = await committedPanelSettings(f);
  for (const operation of ["rename", "remove", "no-op", "shadowed"] as const) {
    await f.list("Advanced", "Pass Through Tools:"); await f.seek("third_party_test_tool");
    if (operation === "remove") await f.key("d");
    else { await f.key("e"); if (operation === "rename") { await f.key("\x15"); await f.key("renamed_third_party_tool"); } await f.key("\r"); }
    await f.save(operation === "shadowed" ? 2 : 1);
    const review = f.full().replace(/\s+/g, " "); assert.match(review, /HOST execution \/ sandbox bypass: tools allowed by pass_through_tools/);
    if (operation === "shadowed") assert.match(review, /shadowed/);
    await f.choose("Cancel"); assert.deepEqual(await committedPanelSettings(f), before); assert.deepEqual(f.calls, []);
  }
});

test("Reset current sandbox overrides is confirmed memory-only maintenance and reconciles automatically", async (t) => {
  const f = await fixture(t, plainTheme, true); await f.number("2"); await f.apply(1); await f.number("3"); await f.apply();
  const before = await committedPanelSettings(f); f.calls.length = 0;
  const reload = f.control.reload.bind(f.control); f.control.reload = async (options) => { f.calls.push("reload"); await reload(options); };
  await f.action("Reset current sandbox overrides");
  const confirmation = f.full().replace(/\s+/g, " "); assert.match(confirmation, /only current memory-only overrides; project\/global defaults are unchanged/); assert.match(confirmation, /Restart may lose guest state/); assert.doesNotMatch(confirmation, /Apply for all sandboxes|unsaved|draft/i); assert.equal(f.selected(), "Cancel");
  await f.choose("Cancel"); assert.deepEqual(await committedPanelSettings(f), before); assert.deepEqual(f.calls, []);
  await f.action("Reset current sandbox overrides"); await f.choose("Confirm");
  assert.deepEqual(f.settings.temporary(), {}); assert.deepEqual((await committedPanelSettings(f)).files, before.files); assert.equal(f.integration!.configRef.value.cpus, 2); assert.equal(f.control.getState().status, "active");
  assert.equal(f.calls.filter((call) => call === "idle").length, 1); assert.equal(f.calls.filter((call) => call === "reload").length, 1);
});
