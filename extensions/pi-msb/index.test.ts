import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { footerStatus, styleFooterStatus } from "./index.ts";
import { displayId, type RuntimeState } from "./types.ts";

const active: RuntimeState = {
  status: "active",
  info: {
    name: "pi-msb-example",
    displayId: "bf9379",
    image: "ubuntu:24.04",
    pid: 123,
    cwd: "/repo/packages/app",
    root: "/repo",
    createdAt: 0,
    docker: { mode: "auto", readiness: "ready", version: "29.8.0", storageDriver: "vfs" },
  },
};

test("index bare import and factory registration do not create host configuration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-index-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    const { default: register } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
    register({ registerTool() {}, registerCommand() {}, on() {} });
  `], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: "pipe" });
  await assert.rejects(stat(agentDir), { code: "ENOENT" });
});

test("blocked invalid startup exposes passive diagnostics and approval-bound host settings repair", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-blocked-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { mkdir, readFile, writeFile } from 'node:fs/promises';
    import { dirname } from 'node:path';
    const { hostConfigPaths } = await import(${JSON.stringify(new URL("./config.ts", import.meta.url).href)});
    const paths = await hostConfigPaths({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, env: process.env });
    await mkdir(dirname(paths.global), { recursive: true });
    const original = 'cpus = 0\\nauto_start = false\\n';
    await writeFile(paths.global, original);
    const { default: register } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
    const tools = new Map(), hooks = new Map(); let answer = 'No', approvals = 0;
    register({ registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, appendEntry() {},
      on(event, handler) { hooks.set(event, [...(hooks.get(event) ?? []), handler]); } });
    const ctx = { cwd: process.cwd(), mode: 'rpc', hasUI: true, isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => 'blocked-repair', getEntries: () => [] },
      ui: { theme: { fg: (_role, text) => text }, setFooter() {}, setStatus() {}, notify() {},
        select: async (_question, options) => { approvals++; assert.deepEqual(options, ['No', 'Yes']); return answer; } } };
    await hooks.get('session_start').at(-1)({}, ctx);
    const run = (name, args) => tools.get(name).execute(name, args, undefined, undefined, ctx);
    const diagnostic = await run('msb_diagnostics', {format:'json'});
    assert.equal(diagnostic.details.runtime.status, 'unavailable');
    assert.equal(diagnostic.details.readiness.configReady, false);
    assert.equal(diagnostic.details.readOnly, true);
    assert.equal(approvals, 0);
    const inspection = await run('msb_config_get', {});
    assert.equal(inspection.details.recovery.available, true);
    assert.equal(inspection.details.recovery.configurationValid, false);
    const proposal = {scope:'global',path:'cpus',operation:'set',value:2};
    assert.equal((await run('msb_config_set', proposal)).details.outcome, 'cancelled');
    assert.equal(await readFile(paths.global, 'utf8'), original);
    answer = 'Yes';
    const repaired = await run('msb_config_set', proposal);
    assert.equal(repaired.details.saved, true, JSON.stringify(repaired.details));
    assert.ok(['applied', 'saved_but_reload_failed'].includes(repaired.details.outcome));
    assert.equal(approvals, 2);
    const after = await run('msb_config_get', {});
    assert.equal(after.details.desired.cpus, 2);
    assert.equal(after.details.recovery, undefined);
    const afterDiagnostic = await run('msb_diagnostics', {});
    assert.equal(afterDiagnostic.details.readiness.configReady, true);
    assert.equal(afterDiagnostic.details.runtime.status, 'disabled');
    assert.equal(afterDiagnostic.details.runtime.execution, 'blocked');
    await hooks.get('session_shutdown').at(-1)({}, ctx);
    console.log('PASS blocked-repair');
  `], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_MSB_DISABLE: "0", PI_MSB_AUTO_START: "false", PI_MSB_PRUNE_ON_START: "false" }, encoding: "utf8", stdio: "pipe" });
  assert.match(output, /PASS blocked-repair/);
});

for (const event of ["session_shutdown", "session_info_changed"]) for (const throws of [false, true]) test(`${event} warns before clearing overrides, including Pi reload; notification failure=${throws}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-session-warning-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    const { default: register } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
    const tools = new Map(); const hooks = new Map(); const notices = [];
    register({ registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, appendEntry() {},
      on(event, handler) { hooks.set(event, [...(hooks.get(event) ?? []), handler]); } });
    const ctx = { cwd: process.cwd(), mode: 'rpc', hasUI: true, isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => 'warning-test', getEntries: () => [] },
      ui: { theme: { fg: (_role, text) => text }, setFooter() {}, setStatus() {}, select: async () => 'Yes',
        notify(message, level) { notices.push([message, level]); if (${throws} && message.includes('Session sandbox overrides are being cleared')) throw Error('synthetic-notification-failure'); } } };
    await hooks.get('session_start').at(-1)({}, ctx);
    const result = await tools.get('msb_config_set').execute('set', {scope:'session',path:'show_footer',operation:'set',value:false}, undefined, undefined, ctx);
    assert.equal(result.details.outcome, 'applied', JSON.stringify(result.details));
    assert.equal((await tools.get('msb_config_get').execute('get', {}, undefined, undefined, ctx)).details.layers.session.show_footer, false);
    if ('${event}' === 'session_info_changed') ctx.sessionManager.getSessionId = () => 'warning-next';
    await hooks.get('${event}').at(-1)({reason:'reload'}, ctx);
    const warning = notices.find(([message]) => message.includes('Session sandbox overrides are being cleared'));
    assert.ok(warning); assert.equal(warning[1], 'warning'); assert.match(warning[0], /Pi \\/reload/); assert.match(warning[0], /broader access/);
    if ('${event}' === 'session_shutdown') {
      ctx.sessionManager.getSessionId = () => 'warning-next';
      await hooks.get('session_start').at(-1)({}, ctx);
    }
    assert.deepEqual((await tools.get('msb_config_get').execute('get', {}, undefined, undefined, ctx)).details.layers.session, {});
    await hooks.get('session_shutdown').at(-1)({reason:'quit'}, ctx);
    assert.equal(notices.filter(([message]) => message.includes('Session sandbox overrides are being cleared')).length, 1);
    console.log('PASS session-warning');
  `], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_MSB_AUTO_START: "false", PI_MSB_PRUNE_ON_START: "false" }, encoding: "utf8", stdio: "pipe" });
  assert.match(output, /PASS session-warning/);
});

test("lifecycle cwd replacement routes fresh host-mode tools to the current cwd and fails closed on discovery failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-index-cwd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { mkdir, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const first = join(process.cwd(), 'first'), second = join(process.cwd(), 'second');
    await mkdir(first); await mkdir(second);
    await writeFile(join(first, 'value.txt'), 'first workspace');
    await writeFile(join(second, 'value.txt'), 'second workspace');
    const { default: register } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
    const tools = new Map(), hooks = new Map();
    register({ registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, appendEntry() {},
      on(event, handler) { hooks.set(event, [...(hooks.get(event) ?? []), handler]); } });
    let sessionId = 'one';
    const ctx = { cwd: first, mode: 'rpc', hasUI: true, isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
      ui: { theme: { fg: (_role, text) => text }, setFooter() {}, setStatus() {}, notify() {} } };
    const read = () => tools.get('read').execute('read', {path:'value.txt'}, undefined, undefined, ctx);
    const info = () => hooks.get('session_info_changed').at(-1)({}, ctx);
    await hooks.get('session_start').at(-1)({}, ctx);
    assert.match((await read()).content[0].text, /first workspace/);
    ctx.cwd = second;
    const pending = info();
    await assert.rejects(read(), /not ready|unavailable/);
    await pending;
    assert.match((await read()).content[0].text, /second workspace/);
    sessionId = 'two'; await info();
    assert.match((await read()).content[0].text, /second workspace/);
    ctx.cwd = join(process.cwd(), 'missing'); await info();
    await assert.rejects(read(), /unavailable/);
    const diagnostic = await tools.get('msb_diagnostics').execute('diag', {}, undefined, undefined, ctx);
    assert.equal(diagnostic.details.runtime.status, 'unavailable');
    assert.equal(diagnostic.details.runtime.execution, 'blocked');
    for (const hook of hooks.get('session_shutdown')) await hook({}, ctx);
    console.log('PASS current-cwd');
  `], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_MSB_DISABLE: "1" }, encoding: "utf8", stdio: "pipe" });
  assert.match(output, /PASS current-cwd/);
});

test("footer status follows the visibility setting", () => {
  assert.equal(footerStatus(active, false), undefined);
  assert.equal(footerStatus(active, true), "msb-bf9379");
});

test("booting shows the real current-session ID before sandbox info exists", () => {
  const booting: RuntimeState = { status: "booting", info: null };
  assert.equal(footerStatus(booting, true, "session-one"), `msb-${displayId("session-one")}`);
  assert.equal(footerStatus({ ...booting, info: active.info }, true, "session-two"), `msb-${displayId("session-two")}`);
  assert.equal(footerStatus(booting, true), "msb-…");
  assert.equal(footerStatus(booting, false, "session-one"), undefined);
});

test("live footer puts a theme-success circle on the right of the dim label", () => {
  const calls: Array<[string, string]> = [];
  const theme = { fg: (role: string, text: string) => { calls.push([role, text]); return text; } };
  assert.equal(styleFooterStatus(theme, footerStatus(active, true)!, active), "\x1b[22mmsb-bf9379 ●\x1b[22m");
  assert.deepEqual(calls, [["dim", "msb-bf9379"], ["success", "●"]]);
});

test("boot frames flash only the right-hand circle between theme warning and dim", () => {
  const calls: Array<[string, string]> = [];
  const theme = { fg: (role: string, text: string) => { calls.push([role, text]); return text; } };
  const label = footerStatus({ status: "booting", info: null }, true, "session-one")!;
  for (let frame = 0; frame < 4; frame++) {
    calls.length = 0;
    assert.equal(styleFooterStatus(theme, label, { status: "booting", info: null }, frame), `\x1b[22m${label} ●\x1b[22m`);
    assert.deepEqual(calls, [["dim", label], [frame % 2 === 0 ? "warning" : "dim", "●"]]);
  }
});

test("active sandbox Docker issues stay red; ready or intentionally disabled Docker stays green", () => {
  const calls: Array<[string, string]> = [];
  const theme = { fg: (role: string, text: string) => { calls.push([role, text]); return text; } };
  for (const readiness of ["missing", "unavailable", "ready", "disabled"] as const) {
    const state: RuntimeState = { ...active, info: { ...active.info!, docker: { mode: readiness === "disabled" ? "disabled" : "auto", readiness } } };
    for (const frame of [0, 1]) {
      calls.length = 0;
      styleFooterStatus(theme, footerStatus(state, true)!, state, frame);
      assert.deepEqual(calls, [["dim", "msb-bf9379"], [readiness === "missing" || readiness === "unavailable" ? "error" : "success", "●"]]);
    }
  }
});

test("non-live footers retain explicit host/blocked/disabled labels and never show success", () => {
  const calls: Array<[string, string]> = [];
  const theme = { fg: (role: string, text: string) => { calls.push([role, text]); return text; } };
  for (const [status, label, color] of [
    ["off", "Microsandbox disabled - Running on host", "error"], ["host-fallback", "MSB host fallback", "error"],
    ["unavailable", "Microsandbox Blocked", "error"], ["stopping", "MSB stopping", "warning"], ["disabled", "MSB disabled", "dim"],
  ] as const) {
    calls.length = 0;
    assert.equal(footerStatus({ status, info: null }, true), label);
    styleFooterStatus(theme, label, { status, info: null });
    assert.deepEqual(calls, [["dim", label], [color, "●"]]);
  }
});
