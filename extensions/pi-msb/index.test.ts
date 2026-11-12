import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { footerStatus, styleFooterStatus } from "./index.ts";
import { imagePreparationMessages } from "./image-boot-notice.ts";
import type { ImagePreparationPhase, RuntimeState } from "./types.ts";

const active: RuntimeState = {
  status: "active",
  info: {
    name: "great-cullen",
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
    const tools = new Map(), hooks = new Map(), notices = []; let answer = 'No', approvals = 0;
    register({ registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, appendEntry() {},
      on(event, handler) { hooks.set(event, [...(hooks.get(event) ?? []), handler]); } });
    const ctx = { cwd: process.cwd(), mode: 'rpc', hasUI: true, isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => 'blocked-repair', getEntries: () => [] },
      ui: { theme: { fg: (_role, text) => text }, setFooter() {}, setStatus() {}, notify(message, level) { notices.push([message, level]); },
        select: async (_question, options) => { approvals++; assert.deepEqual(options, ['No', 'Yes']); return answer; } } };
    await hooks.get('session_start').at(-1)({}, ctx);
    const run = (name, args) => tools.get(name).execute(name, args, undefined, undefined, ctx);
    assert.ok(tools.has('msb_dockerfile_write'));
    assert.ok(tools.has('msb_dockerfile_build'));
    assert.ok(tools.has('msb_dockerfile_load'));
    assert.equal(tools.has('msb_dockerfile_set'), false);
    assert.equal(tools.has('msb_dockerfile_guide'), false);
    const guide = await run('msb_dockerfile_get', {scope:'project'});
    assert.equal(guide.details.outcome, 'inspected');
    assert.equal(guide.details.paths.global.config, paths.global);
    assert.equal(guide.details.paths.project.config, paths.project);
    assert.equal(approvals, 0);
    assert.equal(await readFile(paths.global, 'utf8'), original);
    const diagnostic = await run('msb_diagnostics', {format:'json'});
    assert.equal(diagnostic.details.runtime.status, 'unavailable');
    assert.equal(diagnostic.details.readiness.configReady, false);
    assert.equal(diagnostic.details.readOnly, true);
    assert.equal(diagnostic.details.configurationFailure.problems[0].path, 'cpus');
    const configErrors = () => notices.filter(([message, level]) => level === 'error' && message.includes('Microsandbox configuration failed'));
    assert.equal(configErrors().length, 1, 'startup automatically notifies without /msb');
    assert.match(configErrors()[0][0], /cpus:.*1–64/);
    await run('msb_diagnostics', {});
    assert.equal(configErrors().length, 1, 'passive reads do not notify');
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
    assert.equal(afterDiagnostic.details.configurationFailure, undefined);
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
  assert.equal(footerStatus(active, true), "great-cullen");
});

test("active footer shows actual sandbox names, including explicit overrides", () => {
  assert.equal(footerStatus(active, true), "great-cullen");
  assert.equal(footerStatus({ ...active, info: { ...active.info!, name: "custom-sandbox" } }, true), "custom-sandbox");
  assert.equal(footerStatus({ ...active, info: null }, true), "MSB active");
});

test("booting shows the sandbox name when known and never a session hash", () => {
  const booting: RuntimeState = { status: "booting", info: null };
  assert.equal(footerStatus(booting, true), "MSB starting");
  assert.equal(footerStatus({ ...booting, pendingName: "great-cullen" }, true), "great-cullen");
  assert.equal(footerStatus({ ...booting, pendingName: "explicit-name" }, true), "explicit-name");
  assert.equal(footerStatus(booting, false), undefined);
});

test("live footer puts a theme-success circle on the right of the dim label", () => {
  const calls: Array<[string, string]> = [];
  const theme = { fg: (role: string, text: string) => { calls.push([role, text]); return text; } };
  assert.equal(styleFooterStatus(theme, footerStatus(active, true)!, active), "\x1b[22mgreat-cullen ●\x1b[22m");
  assert.deepEqual(calls, [["dim", "great-cullen"], ["success", "●"]]);
});

test("boot frames flash only the right-hand circle between theme warning and dim", () => {
  const calls: Array<[string, string]> = [];
  const theme = { fg: (role: string, text: string) => { calls.push([role, text]); return text; } };
  const label = footerStatus({ status: "booting", info: null }, true)!;
  assert.equal(label, "MSB starting");
  for (let frame = 0; frame < 4; frame++) {
    calls.length = 0;
    assert.equal(styleFooterStatus(theme, label, { status: "booting", info: null }, frame), `\x1b[22m${label} ●\x1b[22m`);
    assert.deepEqual(calls, [["dim", label], [frame % 2 === 0 ? "warning" : "dim", "●"]]);
  }
});

test("active sandbox stays green regardless of Docker capability readiness", () => {
  const calls: Array<[string, string]> = [];
  const theme = { fg: (role: string, text: string) => { calls.push([role, text]); return text; } };
  for (const readiness of ["missing", "unavailable", "ready", "disabled"] as const) {
    const state: RuntimeState = { ...active, info: { ...active.info!, docker: { mode: readiness === "disabled" ? "disabled" : "auto", readiness } } };
    for (const frame of [0, 1]) {
      calls.length = 0;
      styleFooterStatus(theme, footerStatus(state, true)!, state, frame);
      assert.deepEqual(calls, [["dim", "great-cullen"], ["success", "●"]]);
    }
  }
});

test("non-live footers retain explicit host/blocked/disabled labels and never show success", () => {
  const calls: Array<[string, string]> = [];
  const theme = { fg: (role: string, text: string) => { calls.push([role, text]); return text; } };
  for (const [status, label, color] of [
    ["off", "Microsandbox disabled - Running on host", "warning"], ["host-fallback", "MSB host fallback", "warning"],
    ["unavailable", "Microsandbox Blocked", "error"], ["stopping", "MSB stopping", "warning"], ["disabled", "MSB disabled", "error"],
  ] as const) {
    calls.length = 0;
    assert.equal(footerStatus({ status, info: null }, true), label);
    styleFooterStatus(theme, label, { status, info: null });
    assert.deepEqual(calls, [["dim", label], [color, "●"]]);
  }
});

test("observed asleep and unknown guests use orange without changing active routing status", () => {
  const theme = { fg: (role: string, text: string) => `${role}:${text}` };
  for (const observation of ["asleep", "unknown"] as const) {
    const state: RuntimeState = { ...active, observation };
    const label = footerStatus(state, true)!;
    assert.equal(label, observation === "asleep" ? "great-cullen asleep" : "great-cullen uncertain");
    assert.match(styleFooterStatus(theme, label, state), /warning:●/);
    assert.equal(state.status, "active");
  }
});

test("footer polling, boot/reload animation and stale callbacks stop on hidden footer and shutdown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-footer-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    const timers = new Map(), created = [];
    let nextTimer = 0;
    globalThis.setInterval = (callback, delay) => {
      const id = ++nextTimer;
      const timer = {callback, delay}; timers.set(id, timer); created.push(timer);
      if (delay === 400) callback();
      return id;
    };
    globalThis.clearInterval = (id) => timers.delete(id);
    const {default: register} = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
    const tools = new Map(), hooks = new Map(), statuses = [];
    let session = 'first', footers = 0;
    register({registerTool(tool) {tools.set(tool.name, tool);}, registerCommand() {}, appendEntry() {},
      on(event, handler) {hooks.set(event, [...(hooks.get(event) ?? []), handler]);}});
    const ctx = {cwd: process.cwd(), mode: 'rpc', hasUI: true, isProjectTrusted: () => true,
      sessionManager: {getSessionId: () => session, getEntries: () => []},
      ui: {theme: {fg: (role, text) => role + ':' + text}, setFooter() {footers++;},
        setStatus(_key, value) {statuses.push(value);}, notify() {}, select: async () => 'Yes'}};
    const lifecycle = (event) => hooks.get(event).at(-1)({}, ctx);
    await lifecycle('session_start');
    assert.equal(timers.size, 1); assert.equal([...timers.values()][0].delay, 2000);
    assert.ok(statuses.some(value => value?.includes('warning:●')));
    assert.ok(statuses.some(value => value?.includes('dim:●')));
    assert.match(statuses.at(-1), /warning:●/);
    const run = (value) => tools.get('msb_config_set').execute('set',
      {scope:'session', path:'show_footer', operation:'set', value}, undefined, undefined, ctx);
    const animations = () => created.filter(timer => timer.delay === 400).length;
    const beforeReload = animations();
    assert.equal((await run(true)).details.outcome, 'applied');
    assert.ok(animations() > beforeReload, 'config reload must animate');
    assert.equal(timers.size, 1, 'reload settles and stops animation');
    assert.equal((await run(false)).details.outcome, 'applied');
    assert.equal(timers.size, 0); assert.equal(statuses.at(-1), undefined);
    const hiddenCount = statuses.length;
    for (const timer of created) timer.callback();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(statuses.length, hiddenCount, 'hidden footer rejects stale timer callbacks');
    session = 'replacement';
    await lifecycle('session_info_changed');
    assert.equal(timers.size, 1);
    const poll = [...timers.values()][0];
    poll.callback();
    const shuttingDown = lifecycle('session_shutdown');
    const shutdownCount = statuses.length;
    for (const timer of created) timer.callback();
    await shuttingDown; await Promise.resolve(); await Promise.resolve();
    assert.equal(statuses.length, shutdownCount, 'late poll/animation cannot restore shutdown footer');
    assert.equal(timers.size, 0); assert.equal(statuses.at(-1), undefined);
    await lifecycle('session_start');
    assert.equal(footers, 2, 'new session reinstalls the custom footer after shutdown');
    await lifecycle('session_shutdown');
    assert.equal(timers.size, 0);
    console.log('PASS footer-lifecycle');
  `], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_MSB_DISABLE: "0", PI_MSB_AUTO_START: "false", PI_MSB_PRUNE_ON_START: "false" }, encoding: "utf8", stdio: "pipe" });
  assert.match(output, /PASS footer-lifecycle/);
});

test("headless sessions never start footer polling or animation timers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-headless-footer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    const intervals = [];
    globalThis.setInterval = (_callback, delay) => { intervals.push(delay); return intervals.length; };
    globalThis.clearInterval = () => {};
    const {default: register} = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
    const hooks = new Map();
    register({registerTool() {}, registerCommand() {}, appendEntry() {},
      on(event, handler) {hooks.set(event, [...(hooks.get(event) ?? []), handler]);}});
    let session = 'headless';
    const ctx = {cwd: process.cwd(), mode: 'print', hasUI: false, isProjectTrusted: () => true,
      sessionManager: {getSessionId: () => session, getEntries: () => []},
      ui: {theme: {fg() { throw Error("headless UI"); }}, setFooter() { throw Error("headless UI"); }, setStatus() { throw Error("headless UI"); }, notify() { throw Error("headless UI"); }}};
    const lifecycle = (event) => hooks.get(event).at(-1)({}, ctx);
    await lifecycle('session_start');
    assert.deepEqual(intervals, [], 'headless boot and terminal state must not start UI timers');
    session = 'headless-replacement';
    await lifecycle('session_info_changed');
    assert.deepEqual(intervals, [], 'headless session replacement must not start polling');
    await lifecycle('session_shutdown');
    assert.deepEqual(intervals, []);
    console.log('PASS headless-footer');
  `], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_MSB_DISABLE: "0", PI_MSB_AUTO_START: "false", PI_MSB_PRUNE_ON_START: "false" }, encoding: "utf8", stdio: "pipe" });
  assert.match(output, /PASS headless-footer/);
});

test("renaming a session during deferred reload preserves flashing until reload settles", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-footer-rename-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const timers = new Map();
    let nextTimer = 0, watchReload = false, deferReload = false;
    globalThis.setInterval = (callback, delay) => {
      const id = ++nextTimer; timers.set(id, {callback, delay});
      if (watchReload && delay === 400) deferReload = true;
      return id;
    };
    globalThis.clearInterval = (id) => timers.delete(id);
    const {default: register} = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
    const tools = new Map(), hooks = new Map(), statuses = [];
    register({registerTool(tool) {tools.set(tool.name, tool);}, registerCommand() {}, appendEntry() {},
      on(event, handler) {hooks.set(event, [...(hooks.get(event) ?? []), handler]);}});
    let name = 'Original name';
    const ctx = {cwd: process.cwd(), mode: 'rpc', hasUI: true, isProjectTrusted: () => true,
      sessionManager: {getSessionId: () => 'same-identity', getSessionName: () => name, getEntries: () => []},
      ui: {theme: {fg: (role, text) => role + ':' + text}, setFooter() {},
        setStatus(_key, value) {statuses.push(value);}, notify() {}, select: async () => 'Yes'}};
    const lifecycle = (event) => hooks.get(event).at(-1)({}, ctx);
    await lifecycle('session_start');
    let enter, release;
    const entered = new Promise(resolve => {enter = resolve;});
    const released = new Promise(resolve => {release = resolve;});
    const realpath = fs.promises.realpath;
    fs.promises.realpath = async (...args) => {
      if (deferReload && args[0] === process.cwd()) {enter(); await released;}
      return realpath(...args);
    };
    syncBuiltinESMExports();
    watchReload = true;
    const reloading = tools.get('msb_config_set').execute('set',
      {scope:'session', path:'show_footer', operation:'set', value:true}, undefined, undefined, ctx);
    await entered;
    const animation = [...timers.values()].find(timer => timer.delay === 400);
    assert.ok(animation, 'reload starts flashing before workspace discovery settles');
    const count = statuses.length;
    name = 'Renamed session';
    await lifecycle('session_info_changed');
    assert.equal(statuses.length, count, 'rename must not overwrite the reload presentation');
    assert.ok([...timers.values()].includes(animation), 'rename must not stop the reload timer');
    animation.callback();
    assert.match(statuses.at(-1), /dim:●/);
    animation.callback();
    assert.match(statuses.at(-1), /warning:●/);
    deferReload = false; release();
    assert.equal((await reloading).details.outcome, 'applied');
    assert.equal([...timers.values()].some(timer => timer.delay === 400), false);
    assert.match(statuses.at(-1), /Running on host warning:●/, 'settled host state replaces flashing');
    await lifecycle('session_shutdown');
    assert.equal(timers.size, 0);
    console.log('PASS rename-reload');
  `], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_MSB_DISABLE: "0", PI_MSB_AUTO_START: "false", PI_MSB_PRUNE_ON_START: "false" }, encoding: "utf8", stdio: "pipe" });
  assert.match(output, /PASS rename-reload/);
});

test("selected boot names reach the footer through deferred lock, create, preparation and reload without crossing session identities", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-footer-pending-name-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {join} from 'node:path';
    import {registerHooks, syncBuiltinESMExports} from 'node:module';
    const {fakeSdk} = await import(${JSON.stringify(new URL("../../test/fake-msb-sdk.ts", import.meta.url).href)});
    const {STATE_SCHEMA_VERSION} = await import(${JSON.stringify(new URL("./types.ts", import.meta.url).href)});
    const controlUrl = ${JSON.stringify(new URL("./control.ts", import.meta.url).href)};
    const indexUrl = ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    const wrapper = 'data:text/javascript,' + encodeURIComponent(
      'import {createMsbIntegration as create} from ' + JSON.stringify(controlUrl) + ';' +
      'export function createMsbIntegration(options) {' +
      'const fixture = globalThis.bootFixture;' +
      'const value = create({...options, sdkLoader:async()=>fixture.sdk, acquireOwnerLock:fixture.acquire,' +
      'onState(state) {fixture.notifications.push(state); options.onState?.(state);}});' +
      'fixture.integration = value; return value;}');
    registerHooks({resolve(specifier, context, next) {
      if (context.parentURL === indexUrl && specifier === './control.ts') return {url:wrapper, shortCircuit:true};
      return next(specifier, context);
    }});
    const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
    const gates = () => ({locking:deferred(), locked:deferred(), creating:deferred(), created:deferred(), preparing:deferred(), prepared:deferred()});
    let currentGates = gates();
    const timers = new Map(); let timerId = 0;
    globalThis.setInterval = (callback, delay) => {const id = ++timerId; timers.set(id, {callback, delay}); return id;};
    globalThis.clearInterval = id => timers.delete(id);
    const sdk = fakeSdk([]), builder = sdk.Sandbox.builder;
    sdk.Sandbox.builder = name => {
      const value = builder(name), create = value.create.bind(value), pending = currentGates;
      value.create = async () => {
        pending.creating.resolve(); await pending.created.promise;
        const raw = await create(), exec = raw.execWith;
        raw.execWith = async (...args) => {pending.preparing.resolve(); await pending.prepared.promise; return exec(...args);};
        return raw;
      };
      return value;
    };
    globalThis.bootFixture = {sdk, notifications:[], acquire:async (_request, name) => {
      const pending = currentGates; pending.name = name; pending.locking.resolve(); await pending.locked.promise;
      return {path:'fixture', release:async()=>{}};
    }};
    const fixture = globalThis.bootFixture;
    const {default:register} = await import(indexUrl);
    const hooks = new Map(), statuses = []; let session = 'automatic', entries = [];
    register({registerTool() {}, registerCommand() {}, appendEntry(customType, data) {entries.push({type:'custom', customType, data});},
      on(event, handler) {hooks.set(event, [...(hooks.get(event) ?? []), handler]);}});
    const ctx = {cwd:process.cwd(), mode:'rpc', hasUI:true, isProjectTrusted:()=>true,
      sessionManager:{getSessionId:()=>session, getEntries:()=>entries},
      ui:{theme:{fg:(role,text)=>role+':'+text}, setFooter() {}, setStatus(_key,value) {statuses.push(value);}, notify() {}}};
    const lifecycle = event => hooks.get(event).at(-1)({},ctx);
    const animation = () => [...timers.values()].find(timer=>timer.delay===400);
    const tick = () => {assert.ok(animation()); animation().callback();};
    const assertPending = (pending, ready) => {
      const expected = {status:'booting', info:null, pendingName:pending.name};
      assert.deepEqual(fixture.integration.control.getState(), expected);
      assert.deepEqual(fixture.integration.provider.getState(), expected);
      assert.deepEqual(fixture.notifications.at(-1), expected, 'onState must preserve the selected name');
      assert.equal(fixture.integration.provider.execution.isReady(), ready);
      assert.equal(fixture.integration.provider.isActive(), false);
      assert.ok(statuses.at(-1).includes('dim:'+pending.name+' '), 'selection updates the footer before the next tick');
      tick(); assert.ok(statuses.at(-1).includes('dim:'+pending.name+' '), statuses.at(-1));
      assert.doesNotMatch(statuses.at(-1), /MSB starting/);
    };
    const complete = async (starting, pending, ready) => {
      await pending.locking.promise; assertPending(pending, ready); pending.locked.resolve();
      await pending.creating.promise; assertPending(pending, ready); pending.created.resolve();
      await pending.preparing.promise; assertPending(pending, ready); pending.prepared.resolve();
      await starting;
      assert.equal(fixture.integration.control.getState().info.name, pending.name);
      assert.equal(fixture.integration.control.getState().pendingName, undefined);
      assert.ok(statuses.at(-1).includes('dim:'+pending.name+' success:●'), statuses.at(-1));
      assert.equal(animation(), undefined);
    };
    delete process.env.PI_MSB_SANDBOX_NAME;
    for (const naming of ['automatic','restored','explicit']) {
      session = naming; entries = [];
      if (naming === 'restored') entries.push({type:'custom', customType:'pi-msb.state', data:{
        version:STATE_SCHEMA_VERSION, sessionId:session, sandboxName:'saved-random-name', cwd:ctx.cwd,
        root:ctx.cwd, guestRoot:ctx.cwd, image:'saved-image', enabled:true, createdAt:1}});
      if (naming === 'explicit') process.env.PI_MSB_SANDBOX_NAME = 'user-selected-name';
      const pending = currentGates = gates();
      await complete(lifecycle('session_start'), pending, false);
      if (naming === 'automatic') {
        process.env.PI_MSB_CPUS = '3';
        const reloading = currentGates = gates();
        const reload = fixture.integration.control.reload();
        await complete(reload, reloading, true);
        assert.equal(reloading.name, pending.name, 'reload retains the original random name');
        delete process.env.PI_MSB_CPUS;
      } else assert.equal(pending.name, naming === 'restored' ? 'saved-random-name' : 'user-selected-name');
      await lifecycle('session_shutdown');
    }
    delete process.env.PI_MSB_SANDBOX_NAME;
    const firstCwd = ctx.cwd, secondCwd = join(firstCwd, 'second'); await fs.promises.mkdir(secondCwd);
    for (const change of ['session','cwd']) {
      ctx.cwd = firstCwd; session = 'old-'+change; entries = [];
      const old = currentGates = gates(), oldStarting = lifecycle('session_start');
      await old.locking.promise; old.locked.resolve(); await old.creating.promise;
      assertPending(old, false);
      const staleAnimation = animation();
      const replacement = currentGates = gates();
      let discoveryHeld = true;
      const discovering = deferred(), discovered = deferred(), realpath = fs.promises.realpath;
      fs.promises.realpath = async (...args) => {
        if (discoveryHeld && args[0] === ctx.cwd) {discovering.resolve(); await discovered.promise;}
        return realpath(...args);
      };
      syncBuiltinESMExports();
      if (change === 'session') session = 'replacement-session'; else ctx.cwd = secondCwd;
      process.env.PI_MSB_SANDBOX_NAME = 'replacement-'+change;
      const switching = lifecycle('session_info_changed'), count = statuses.length;
      staleAnimation.callback(); assert.equal(statuses.length, count, 'obsolete animation cannot update replacement UI');
      tick(); assert.match(statuses.at(-1), /MSB starting/);
      assert.equal(fixture.integration.control.getState().pendingName, undefined, 'old manager name must not cross identity boundary');
      old.created.resolve(); old.prepared.resolve(); await oldStarting; await discovering.promise;
      tick(); assert.match(statuses.at(-1), /MSB starting/);
      assert.ok(!statuses.slice(count).some(value=>value?.includes(old.name)), 'old boot completion must not republish its name');
      discoveryHeld = false; discovered.resolve();
      await complete(switching, replacement, false);
      assert.equal(replacement.name, 'replacement-'+change);
      fs.promises.realpath = realpath; syncBuiltinESMExports();
      await lifecycle('session_shutdown'); delete process.env.PI_MSB_SANDBOX_NAME;
    }
    assert.equal(timers.size, 0);
    console.log('PASS pending-footer');
  `], {
    cwd, timeout: 20_000,
    env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_MSB_DISABLE: "0", PI_MSB_AUTO_START: "true", PI_MSB_BOOTSTRAP_TOOLS: "false", PI_MSB_PRUNE_ON_START: "false", PI_MSB_DOCKER__MODE: "disabled" },
    encoding: "utf8", stdio: "pipe",
  });
  assert.match(output, /PASS pending-footer/);
});


test("custom image preparation footer names each phase, respects visibility and keeps the boot animation", () => {
  for (const phase of Object.keys(imagePreparationMessages) as ImagePreparationPhase[]) {
    const state: RuntimeState = { status: "booting", info: null, pendingName: "vm-name", imagePreparation: phase };
    assert.equal(footerStatus(state, true), imagePreparationMessages[phase]);
    assert.equal(footerStatus(state, false), undefined);
    const colors: string[] = [];
    const theme = { fg: (role: string, text: string) => { if (text === "●") colors.push(role); return text; } };
    for (const frame of [0, 1]) styleFooterStatus(theme, footerStatus(state, true)!, state, frame);
    assert.deepEqual(colors, ["warning", "dim"]);
  }
});

for (const hasUI of [true, false]) test(`automatic safe configuration notifications follow replacement lifecycle, hasUI=${hasUI}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-config-notice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { mkdir, writeFile } from 'node:fs/promises';
    import { dirname } from 'node:path';
    const { hostConfigPaths } = await import(${JSON.stringify(new URL("./config.ts", import.meta.url).href)});
    const paths = await hostConfigPaths({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, env: process.env });
    await mkdir(dirname(paths.global), { recursive: true });
    await writeFile(paths.global, '[broken\\n# REJECTED_PRIVATE_VALUE\\n');
    const { default: register } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
    const hooks = new Map(), tools = new Map(), notices = [];
    register({ registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, appendEntry() {},
      on(event, handler) { hooks.set(event, [...(hooks.get(event) ?? []), handler]); } });
    let sessionId = 'first';
    const ctx = { cwd: process.cwd(), mode: 'tui', hasUI: ${hasUI}, isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
      ui: { theme: { fg: (_role, text) => text }, setFooter() {}, setStatus() {}, notify(message, level) { notices.push([message, level]); } } };
    const errors = () => notices.filter(([message, level]) => level === 'error' && message.includes('Microsandbox configuration failed'));
    await hooks.get('session_start').at(-1)({}, ctx);
    assert.equal(errors().length, ${hasUI ? 1 : 0});
    if (${hasUI}) assert.match(errors()[0][0], /TOML syntax/);
    for (let i = 0; i < 3; i++) await tools.get('msb_diagnostics').execute('diag', {}, undefined, undefined, ctx);
    await hooks.get('session_info_changed').at(-1)({}, ctx);
    assert.equal(errors().length, ${hasUI ? 1 : 0}, 'polling/reads/same-session churn cannot notify');
    sessionId = 'replacement';
    await hooks.get('session_info_changed').at(-1)({}, ctx);
    assert.equal(errors().length, ${hasUI ? 2 : 0}, 'replacement owns a fresh failure notification');
    assert.doesNotMatch(JSON.stringify(notices), /REJECTED_PRIVATE_VALUE/);
    await writeFile(paths.global, 'auto_start = false\\n');
    sessionId = 'recovered';
    await hooks.get('session_info_changed').at(-1)({}, ctx);
    const report = await tools.get('msb_diagnostics').execute('diag', {}, undefined, undefined, ctx);
    assert.equal(report.details.configurationFailure, undefined);
    assert.equal(errors().length, ${hasUI ? 2 : 0});
    await hooks.get('session_shutdown').at(-1)({}, ctx);
    console.log('PASS configuration notices');
  `], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_MSB_DISABLE: "0", PI_MSB_AUTO_START: "false", PI_MSB_PRUNE_ON_START: "false" }, encoding: "utf8", stdio: "pipe" });
  assert.match(output, /PASS configuration notices/);
});
