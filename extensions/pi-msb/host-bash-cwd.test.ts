import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { fakeSdk } from "../../test/fake-msb-sdk.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { createMsbIntegration } from "./control.ts";
import { discoverHostBashCwd, validHostBashCwd } from "./host-bash-cwd.ts";
import { registerSandboxTools, hostApprovalMessage } from "./tools.ts";
import { systemPromptNote } from "./command.ts";
import type { Config } from "./types.ts";

process.env.PI_PACKAGE_DIR = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent", import.meta.url));
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t: TestContext, active = false) {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/pi-msb-host-cwd-"));
  const cwd = join(root, "workspace"), inside = join(cwd, "inside"), outside = join(root, "outside"), sibling = join(root, "workspace-sibling"), replacement = join(root, "replacement");
  for (const directory of [inside, outside, sibling, replacement]) await fs.mkdir(directory, { recursive: true });
  const escape = join(cwd, "escape"), alias = join(cwd, "inside-alias");
  await fs.symlink(outside, escape, "dir"); await fs.symlink(inside, alias, "dir");
  let sdkLoads = 0;
  const integration = createMsbIntegration({ cwd, sessionId: "host-cwd", configDirName: ".pi", agentDir: join(root, "agent"), env: {},
    sdkLoader: async () => { sdkLoads++; if (!active) throw new Error("fixture unavailable"); return fakeSdk([]); },
    acquireOwnerLock: async () => ({ path: join(root, "owner"), release: async () => undefined }),
    locksPort: { tryAcquire: async () => ({ path: join(root, "lock"), release: async () => undefined }) },
  });
  t.after(async () => { integration.endSession(); await integration.manager.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  await integration.configureSession({ sessionId: "host-cwd", cwd, projectTrusted: true,
    config: { config: { ...structuredClone(DEFAULT_CONFIG), autoStart: true, allowHostExecution: true, bootstrapTools: false, pruneOnStart: false } as Config, provenance: {}, warnings: [] } });
  assert.equal(integration.provider.getState().status, active ? "active" : "unavailable");
  const initialSdkLoads = sdkLoads;
  const tools = new Map<string, any>(), handlers = new Map<string, (event: any, ctx: any) => any>(), prompts: string[] = [];
  let answer: () => Promise<string | undefined> = async () => "Yes";
  const ctx: any = { cwd, mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "host-cwd", getSessionFile: () => undefined }, ui: {
    async select(question: string, choices: string[]) { prompts.push(question); assert.deepEqual(choices, ["No", "Yes"]); return answer(); },
  } };
  registerSandboxTools({ registerTool(tool: any) { tools.set(tool.name, tool); }, on(name: string, handler: any) { handlers.set(name, handler); } } as any,
    { provider: integration.provider, config: integration.configRef.value, cwd,
      hostReads: { clear() {}, updateSkills() {}, resolve: async () => undefined, allowGeneratedFile: async () => undefined },
      createGrepExecute: () => async () => { throw new Error("sandbox execution forbidden in this fixture"); },
      grepHelpers: { DEFAULT_MAX_BYTES: 1000, DEFAULT_MAX_LINES: 100, truncateHead: () => ({}), truncateLine: (text) => ({ text, wasTruncated: false }), formatSize: String }, systemPromptNote });
  const input = (requested?: unknown): Record<string, any> => ({ command: "pwd", timeout: 5, execution_target: "host", ...(requested === undefined ? {} : { cwd: requested }) });
  const event = (params: Record<string, any>, id = "cwd-call", toolName = "bash") => ({ toolName, toolCallId: id, input: params });
  const request = (call: ReturnType<typeof event>) => handlers.get("tool_call")!(call, ctx);
  const execute = (params: Record<string, any>, id = "cwd-call", toolName = "bash") => tools.get(toolName).execute(id, params, undefined, undefined, ctx);
  return { root, cwd, inside, outside, sibling, replacement, escape, alias, ctx, tools, handlers, prompts, integration, input, event, request, execute,
    setAnswer(next: () => Promise<string | undefined>) { answer = next; },
    assertNoSdkWake() { assert.equal(sdkLoads, initialSdkLoads); },
    async noMarker() { for (const directory of [cwd, inside, outside, replacement]) await assert.rejects(fs.access(join(directory, "cwd-marker")), { code: "ENOENT" }); },
  };
}

for (const active of [false, true]) test(`native ${active ? "active" : "blocked recovery"} host Bash executes omitted, relative and absolute cwd in exactly the approved directory`, async (t) => {
  const f = await fixture(t, active);
  for (const [requested, expected] of [[undefined, f.cwd], [f.cwd, f.cwd], ["inside", f.inside], [f.inside, f.inside], ["../outside", f.outside], [f.sibling, f.sibling], [f.escape, f.outside], [f.alias, f.inside]] as const) {
    const input = f.input(requested);
    assert.equal(await f.request(f.event(input)), undefined);
    const result = await f.execute(input);
    assert.equal(result.content[0].text.trim(), expected);
    await assert.rejects(f.execute(input), /not approved/);
    assert.ok(f.prompts.at(-1)!.includes(`Working directory: ${requested === undefined ? f.cwd : requested === "inside" ? f.inside : requested === "../outside" ? f.outside : requested}`));
    if (requested === f.escape || requested === f.alias) assert.ok(f.prompts.at(-1)!.includes(`Canonical directory (execution target): ${expected}`));
    assert.doesNotMatch(f.prompts.at(-1)!, /Timeout|\x1b/);
  }
  const input = { ...f.input(f.outside), command: "touch cwd-marker" };
  assert.equal(await f.request(f.event(input)), undefined); await f.execute(input);
  await fs.access(join(f.outside, "cwd-marker")); await assert.rejects(fs.access(join(f.cwd, "cwd-marker")), { code: "ENOENT" });
  const next = f.input("inside"); assert.equal(await f.request(f.event(next)), undefined);
  assert.equal((await f.execute(next)).content[0].text.trim(), f.inside, "relative cwd never follows a previous command");
  f.assertNoSdkWake();
});

test("host Bash cwd rejects missing/file/malformed paths and unsupported targets without approval or execution", async (t) => {
  const f = await fixture(t, true); const file = join(f.root, "not-a-directory"); await fs.writeFile(file, "fixture");
  for (const cwd of ["", " ", "bad\npath", "bad\rpath", "bad\x1bpath", "bad\u202epath", "bad\u2028path", "bad\ud800path", "x".repeat(4097), "界".repeat(1400), 1, null, {}, join(f.root, "missing"), file]) {
    const input = f.input(cwd);
    assert.equal((await f.request(f.event(input))).block, true, String(cwd));
    await assert.rejects(f.execute(input), /cwd|not approved|directory/);
  }
  for (const tool of ["bash", "read", "write", "edit", "find", "grep", "ls"]) for (const target of ["sandbox", "host"]) {
    if (tool === "bash" && target === "host") continue;
    const input = { ...f.input(f.inside), execution_target: target };
    assert.match((await f.request(f.event(input, "invalid", tool))).reason, /cwd is supported only/);
    await assert.rejects(f.execute(input, "invalid", tool), /cwd is supported only/);
  }
  const explicitUndefined = { ...f.input(), cwd: undefined };
  assert.equal((await f.request(f.event(explicitUndefined))).block, true);
  assert.equal(f.prompts.length, 0); await f.noMarker(); f.assertNoSdkWake();
});

test("host Bash cwd schema and actual model prompt explain fixed-relative execution and fresh directory approval", async (t) => {
  const f = await fixture(t);
  const cwd = f.tools.get("bash").parameters.properties.cwd;
  assert.equal(cwd.type, "string"); assert.equal(cwd.maxLength, 4096); assert.ok(!f.tools.get("bash").parameters.required.includes("cwd"));
  assert.match(cwd.description, /fixed session cwd/); assert.match(cwd.description, /Outside-workspace directories are allowed/);
  for (const name of ["read", "write", "edit", "find", "grep", "ls"]) assert.equal(f.tools.get(name).parameters.properties.cwd, undefined);
  const note = f.handlers.get("before_agent_start")!({ systemPrompt: "base" }, f.ctx).systemPrompt;
  assert.match(note, /cwd parameter instead of cd or chaining/); assert.match(note, /changing cwd requires fresh approval/);
  assert.match(note, /exactly ONE simple/); assert.match(note, /finite positive timeout <=120/);
});

function palette(appearance: "dark" | "light"): Theme {
  const json = JSON.parse(readFileSync(new URL(`../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${appearance}.json`, import.meta.url), "utf8"));
  const resolve = (value: string | number): string | number => typeof value === "string" && json.vars[value] !== undefined ? resolve(json.vars[value]) : value;
  const colors = Object.fromEntries(Object.entries(json.colors).map(([key, value]) => [key, resolve(value as string | number)]));
  return new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor");
}
for (const appearance of ["dark", "light"] as const) test(`host Bash cwd uses theme error/red only outside the canonical session workspace in ${appearance}`, async (t) => {
  const f = await fixture(t); initTheme(appearance, false); const theme = palette(appearance);
  for (const [path, outside] of [[f.cwd, false], [f.inside, false], [f.alias, false], [f.sibling, true], [f.outside, true], [f.escape, true], [f.root, true]] as const) {
    const proof = await discoverHostBashCwd(f.cwd, path, () => {});
    assert.equal(proof.outsideWorkspace, outside);
    const text = hostApprovalMessage("bash", f.input(path), f.cwd, theme, proof);
    assert.ok(text.includes(theme.fg(outside ? "error" : "text", path)));
    if (proof.target.canonicalPath !== path) assert.ok(text.includes(theme.fg(outside ? "error" : "text", proof.target.canonicalPath)));
    assert.equal(strip(text), hostApprovalMessage("bash", f.input(path), f.cwd, undefined, proof));
    assert.equal(strip(text).split("\n").find((line) => line.startsWith("Warning:")), "Warning: this operation runs on the host and bypasses any isolation.");
  }
  const nested = await discoverHostBashCwd(f.inside, f.cwd, () => {});
  assert.equal(nested.outsideWorkspace, true, "a parent project/main checkout is outside a nested session workspace");
  f.ctx.mode = "tui"; f.ctx.ui.theme = theme;
  f.ctx.ui.custom = async (factory: any, options: any) => new Promise((resolve) => {
    assert.equal(options.overlay, false);
    const view = factory({ requestRender() {}, terminal: { rows: 24 } }, theme, new KeybindingsManager(TUI_KEYBINDINGS), resolve);
    const lines = view.render(1000);
    assert.ok(lines.includes(theme.fg("muted", "Working directory:") + " " + theme.fg("error", f.escape)));
    assert.ok(lines.includes(theme.fg("muted", "Canonical directory (execution target):") + " " + theme.fg("error", f.outside)));
    assert.ok(strip(lines.join("\n")).endsWith("→ No\n  Yes")); assert.doesNotMatch(strip(lines.join("\n")), /Timeout|navigate|details/);
    view.handleInput("\r"); view.dispose();
  });
  assert.match((await f.request(f.event(f.input(f.escape)))).reason, /denied/);
});

test("host cwd display escapes inherited session path controls and validates requested path Unicode", () => {
  assert.ok(hostApprovalMessage("bash", { command: "pwd" }, "bad\n\x1b\u202e").includes("bad\\u{a}\\u{1b}\\u{202e}"));
  for (const value of [undefined, "", "\n", "\u200e", "\u2029", "\ud800"]) assert.equal(validHostBashCwd(value), false);
  assert.equal(validHostBashCwd("directory with 'quotes'"), true);
});

for (const phase of [1, 2, 3]) test(`native cwd request guards survive original session-root filesystem await ${phase}`, async (t) => {
  for (const change of ["cwd", "input", "timeout", "permission", "UI", "state", "session"] as const) {
    const f = await fixture(t);
    const entered = deferred<void>(), release = deferred<void>(); let checks = 0;
    const original = f.integration.provider.validateHostRecoveryRoot!;
    f.integration.provider.validateHostRecoveryRoot = async (...args) => {
      await original(...args);
      if (++checks === phase) { entered.resolve(); await release.promise; }
    };
    const input = f.input(f.outside), event = f.event(input, `root-${change}`);
    let pending: Promise<any>;
    if (phase === 3) { assert.equal(await f.request(event), undefined); pending = f.execute(input, event.toolCallId); }
    else pending = f.request(event);
    await entered.promise;
    if (change === "cwd") input.cwd = f.inside;
    if (change === "input") event.input = { ...input };
    if (change === "timeout") input.timeout = 10;
    if (change === "permission") f.integration.configRef.value.allowHostExecution = false;
    if (change === "UI") f.ctx.hasUI = false;
    if (change === "state" || change === "session") {
      // Native lifecycle replacement invalidates both status and identity/token, without SDK work.
      f.integration.endSession();
    }
    release.resolve();
    if (phase === 3) await assert.rejects(pending, /not approved|context changed|directory|cwd/);
    else assert.equal((await pending).block, true);
    await assert.rejects(f.execute(input, event.toolCallId), /not approved|not ready|disabled|unavailable|context changed/);
    f.integration.provider.validateHostRecoveryRoot = original;
    f.integration.configRef.value.allowHostExecution = true; f.ctx.hasUI = true;
    await f.noMarker(); f.assertNoSdkWake();
  }
});

for (const phase of ["discovery", "after Yes", "handoff"] as const) test(`host cwd guards recheck input identity/value after requested-directory filesystem await: ${phase}`, async (t) => {
  for (const change of ["cwd", "input", "timeout"] as const) {
    const f = await fixture(t), entered = deferred<void>(), release = deferred<void>();
    let armed = phase === "discovery", paused = false;
    const stat = fs.stat;
    const mock = t.mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
      const value = await stat(...args);
      if (armed && !paused && String(args[0]) === f.outside) { paused = true; entered.resolve(); await release.promise; }
      return value;
    });
    f.setAnswer(async () => { if (phase === "after Yes") armed = true; return "Yes"; });
    const input: Record<string, any> = { ...f.input(f.outside), command: "touch cwd-marker" };
    const event = f.event(input);
    let pending: Promise<any>;
    if (phase === "handoff") { assert.equal(await f.request(event), undefined); armed = true; pending = f.execute(input); }
    else pending = f.request(event);
    await entered.promise;
    if (change === "cwd") input.cwd = f.inside;
    if (change === "input") event.input = { ...input };
    if (change === "timeout") input.timeout = 10;
    release.resolve();
    if (phase === "handoff") await assert.rejects(pending, /not approved|cwd|directory/);
    else assert.equal((await pending).block, true);
    input.cwd = f.outside; input.timeout = 5;
    await assert.rejects(f.execute(input), /not approved/);
    if (phase === "discovery") assert.equal(f.prompts.length, 0);
    await f.noMarker(); f.assertNoSdkWake(); mock.mock.restore();
  }
});

for (const active of [false, true]) for (const kind of ["symlink", "directory"] as const) for (const when of ["before prompt", "during approval", "before execution"] as const)
test(`native ${active ? "active" : "recovery"} host cwd rejects ${kind} replacement ${when}; restoration cannot revive approval`, async (t) => {
  const f = await fixture(t, active), target = kind === "symlink" ? f.escape : f.outside, parked = join(f.root, "parked-target");
  const replace = async () => {
    if (kind === "symlink") { await fs.unlink(target); await fs.symlink(f.replacement, target, "dir"); }
    else { await fs.rename(target, parked); await fs.rename(f.replacement, target); }
  };
  const restore = async () => {
    if (kind === "symlink") { await fs.unlink(target); await fs.symlink(f.outside, target, "dir"); }
    else { await fs.rename(target, f.replacement); await fs.rename(parked, target); }
  };
  const input = { ...f.input(target), command: "touch cwd-marker" }, event = f.event(input);
  let replaced = false;
  if (when === "before prompt") {
    const stat = fs.stat;
    t.mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
      const value = await stat(...args);
      if (!replaced && String(args[0]) === target) { replaced = true; await replace(); }
      return value;
    });
  }
  f.setAnswer(async () => { if (when === "during approval") await replace(); return "Yes"; });
  if (when === "before execution") { assert.equal(await f.request(event), undefined); await replace(); }
  else assert.equal((await f.request(event)).block, true);
  await assert.rejects(f.execute(input), /cwd|directory|not approved/);
  await restore(); await assert.rejects(f.execute(input), /not approved/);
  if (when === "before prompt") assert.equal(f.prompts.length, 0);
  await f.noMarker(); f.assertNoSdkWake();
});

for (const active of [false, true]) for (const when of ["before prompt", "during approval", "before execution"] as const)
test(`native ${active ? "active" : "recovery"} original workspace proof survives outside cwd: replacement ${when} fails closed`, async (t) => {
  const f = await fixture(t, active), parked = join(f.root, "parked-workspace");
  const replace = async () => { await fs.rename(f.cwd, parked); await fs.mkdir(f.cwd); };
  const input = { ...f.input(f.outside), command: "touch cwd-marker" }, event = f.event(input);
  if (when === "before prompt") await replace();
  f.setAnswer(async () => { if (when === "during approval") await replace(); return "Yes"; });
  if (when === "before execution") { assert.equal(await f.request(event), undefined); await replace(); }
  else assert.equal((await f.request(event)).block, true);
  await assert.rejects(f.execute(input), /canonical cwd|not approved|trustworthy|cwd|directory/);
  await fs.rmdir(f.cwd); await fs.rename(parked, f.cwd);
  await assert.rejects(f.execute(input), /not approved|trustworthy/);
  if (when === "before prompt") assert.equal(f.prompts.length, 0);
  await f.noMarker(); f.assertNoSdkWake();
});

for (const active of [false, true]) test(`native ${active ? "active" : "recovery"} cwd mutation or replaced input during UI cannot authorize another directory`, async (t) => {
  for (const change of ["cwd", "input", "timeout"] as const) {
    const f = await fixture(t, active), input = f.input(f.outside), event = f.event(input);
    f.setAnswer(async () => {
      assert.ok(f.prompts.at(-1)!.includes(`Working directory: ${f.outside}`));
      if (change === "cwd") input.cwd = f.inside;
      if (change === "input") event.input = { ...input };
      if (change === "timeout") input.timeout = 10;
      return "Yes";
    });
    assert.equal((await f.request(event)).block, true);
    input.cwd = f.outside; input.timeout = 5; event.input = input;
    await assert.rejects(f.execute(input), /not approved/);
    await f.noMarker(); f.assertNoSdkWake();
  }
});

test("host cwd final validation also guards a separately supplied execution input and consumes approval before waiting", async (t) => {
  const f = await fixture(t), input = f.input(f.outside);
  assert.equal(await f.request(f.event(input)), undefined);
  const executionInput = { ...input }, entered = deferred<void>(), release = deferred<void>();
  const stat = fs.stat; let paused = false;
  t.mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
    const value = await stat(...args);
    if (!paused && String(args[0]) === f.outside) { paused = true; entered.resolve(); await release.promise; }
    return value;
  });
  const pending = f.execute(executionInput); await entered.promise;
  await assert.rejects(f.execute(input), /not approved/, "the grant is consumed while validation is still waiting");
  executionInput.cwd = f.inside; release.resolve();
  await assert.rejects(pending, /cwd|directory|not approved/);
  executionInput.cwd = f.outside; await assert.rejects(f.execute(executionInput), /not approved/);
  f.assertNoSdkWake();
});

test("host cwd rejects an otherwise safe alias whose canonical target contains display controls", async (t) => {
  const f = await fixture(t), unsafe = join(f.root, "target\u202e"), alias = join(f.cwd, "safe-alias");
  await fs.mkdir(unsafe); await fs.symlink(unsafe, alias, "dir");
  const input = f.input(alias);
  assert.equal((await f.request(f.event(input))).block, true);
  assert.equal(f.prompts.length, 0); await assert.rejects(f.execute(input), /not approved/);
});

test("host cwd never resolves against ambient process cwd when the session root is not absolute", async () => {
  await assert.rejects(discoverHostBashCwd("relative-session", "child", () => {}), /cwd/);
});
