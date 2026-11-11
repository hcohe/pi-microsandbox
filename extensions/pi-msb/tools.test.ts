import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Type } from "typebox";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { highlightCode, initTheme } from "@earendil-works/pi-coding-agent";
import { createSandboxGrepExecute } from "./operations-exec.ts";
import { systemPromptNote } from "./command.ts";
import {
  hostApprovalMessage,
  registerSandboxTools,
  withExecutionTarget,
  withoutExecutionTarget,
} from "./tools.ts";
import { createSessionExecution } from "./types.ts";
import { createHostReadAccess } from "./skill-access.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import type {
  Config,
  HostReadAccess,
  RuntimeExecution,
  RuntimeState,
  SandboxTransport,
  SessionExecutionContext,
  ToolOpsProvider,
} from "./types.ts";

initTheme("dark");

const approvalTheme = {
  fg: (color: string, text: string) => `\x1b[${color === "warning" ? 33 : color === "accent" ? 36 : 37}m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};
const ROUTED = ["bash", "edit", "find", "grep", "ls", "read", "write"] as const;

function config(overrides: Partial<Config> = {}): Config {
  return {
    image: "ubuntu:24.04",
    pullPolicy: "if-missing",
    bootstrapTools: false,
    cpus: 1,
    memoryMiB: 512,
    idleTimeoutSec: 600,
    stopTimeoutMs: 10_000,
    detached: true,
    replace: false,
    replaceTimeoutMs: 10_000,
    sandboxName: null,
    network: { mode: "default", allowHosts: [], allowDns: true, publishPorts: [] },
    docker: { mode: "auto", startupTimeoutMs: 15_000 },
    secrets: [],
    mounts: [],
    blockThirdParty: true,
    routeTools: [...ROUTED],
    passThroughTools: [],
    allowHostExecution: true,
    allowSkillReads: true,
    fallbackMode: "block",
    exposeSessionEnvironment: false,
    hostEnv: [],
    autoStart: true,
    pruneOnStart: true,
    showFooter: false,
    lockDir: "/tmp/pi-msb-locks",
    ...overrides,
  };
}

function state(status: RuntimeState["status"] = "active"): RuntimeState {
  return {
    status,
    info: status === "active"
      ? {
          name: "pi-msb-full-id",
          displayId: "full-i",
          image: "ubuntu:24.04",
          pid: 42,
          cwd: process.cwd(),
          root: process.cwd(),
          createdAt: Date.now(),
          docker: { mode: "auto", readiness: "ready", version: "29.8.0", storageDriver: "vfs" },
        }
      : null,
  };
}

function operations(): RuntimeExecution["operations"] {
  return {
    read: {
      readFile: async (filePath) => Buffer.from(await readFile(filePath)),
      access: async (filePath) => readFile(filePath).then(() => undefined),
      detectImageMimeType: async () => null,
    },
    write: {
      mkdir: async () => {},
      writeFile: async (filePath, content) => writeFile(filePath, content),
    },
    edit: {
      readFile: async (filePath) => Buffer.from(await readFile(filePath)),
      writeFile: async (filePath, content) => writeFile(filePath, content),
      access: async (filePath) => readFile(filePath).then(() => undefined),
    },
    bash: { exec: async () => ({ exitCode: 0 }) },
    ls: {
      exists: async () => true,
      stat: async () => ({ isDirectory: () => false }),
      readdir: async () => [],
    },
    find: { exists: async () => true, glob: async () => [] },
    grep: { isDirectory: async () => false, readFile: async () => "" },
  };
}

function createHarness(options: {
  runtimeState?: RuntimeState;
  configReady?: boolean;
  omitHostExecutionToken?: boolean;
  omitExecution?: boolean;
  omitRootProof?: boolean;
  validateRoot?: () => Promise<void>;
  config?: Partial<Config>;
  hasUI?: boolean;
  confirm?: boolean;
  cancel?: boolean;
  mode?: ExtensionContext["mode"];
  configToolSource?: string | null;
  execution?: SessionExecutionContext;
  hostReads?: HostReadAccess;
  createHostReads?: () => HostReadAccess;
  grepResult?: unknown;
  grepTransport?: SandboxTransport;
  select?: () => Promise<string | undefined>;
  operations?: RuntimeExecution["operations"];
  promptNote?: (state: RuntimeState) => string;
} = {}) {
  const cwd = process.cwd();
  let current = options.runtimeState ?? state();
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const tools = new Map<string, any>();
  const confirmations: Array<{ title: string; choices: string[] }> = [];
  const allowedReads: string[] = [];
  const skillUpdates: unknown[][] = [];
  const grepCwds: string[] = [];
  const hostReads: HostReadAccess = options.hostReads ?? {
    updateSkills: (skills) => { skillUpdates.push([...skills]); },
    allowGeneratedFile: async (filePath) => { allowedReads.push(filePath); },
    resolve: async () => undefined,
    clear: () => {},
  };
  let ready = options.configReady ?? true;
  let token: object = {};
  const currentConfig = config(options.config);
  const provider: ToolOpsProvider = {
    execution: options.omitExecution ? undefined : options.execution ?? readyExecution(cwd).context,
    isActive: () => current.status === "active",
    getState: () => current,
    ...(options.omitHostExecutionToken ? {} : { hostExecutionToken: () => ready ? token : undefined }),
    ...(options.omitRootProof ? {} : { validateHostRecoveryRoot: async () => options.validateRoot?.() }),
    withRuntime: async (callback) => callback({ transport: options.grepTransport ?? {} as any, operations: options.operations ?? operations() }),
  };
  const ctx = {
    get cwd() { return provider.execution?.current().cwd ?? cwd; },
    mode: options.mode ?? "rpc",
    hasUI: options.hasUI ?? true,
    sessionManager: { getSessionId: () => "host-recovery-test", getSessionFile: () => undefined },
    ui: {
      theme: approvalTheme,
      select: async (title: string, choices: string[]) => {
        confirmations.push({ title, choices });
        return options.select ? options.select() : options.cancel ? undefined : options.confirm === false ? "No" : "Yes";
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    getAllTools() {
      return [...tools.values(), ...["msb_config_get", "msb_config_set", "msb_diagnostics", "msb_dockerfile_get", "msb_dockerfile_write", "msb_dockerfile_build", "msb_dockerfile_load"].map((name) => ({ name, configTool: true }))].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        sourceInfo: tool.configTool ? options.configToolSource === null ? undefined : { source: "local", path: options.configToolSource ?? fileURLToPath(new URL("./index.ts", import.meta.url)) } : { source: "builtin" },
      }));
    },
    on(name: string, handler: any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  registerSandboxTools(pi, {
    provider,
    config: currentConfig,
    cwd,
    hostReads,
    createHostReads: options.createHostReads,
    ownedConfigToolEntry: fileURLToPath(new URL("./index.ts", import.meta.url)),
    createGrepExecute: ({ cwd, provider, grepHelpers }) => options.grepTransport
      ? createSandboxGrepExecute({ provider, cwd, helpers: grepHelpers })
      : async () => {
        grepCwds.push(cwd);
        return options.grepResult ?? { content: [{ type: "text", text: "sandbox" }] };
      },
    grepHelpers: {
      DEFAULT_MAX_BYTES: 1000,
      DEFAULT_MAX_LINES: 100,
      truncateHead: (content: string) => ({ content, truncated: false }),
      truncateLine: (text: string) => ({ text, wasTruncated: false }),
      formatSize: (bytes: number) => `${bytes} bytes`,
    },
    systemPromptNote: options.promptNote ?? ((runtimeState) => `mode:${runtimeState.status}`),
  });
  return {
    tools,
    confirmations,
    allowedReads,
    skillUpdates,
    grepCwds,
    ctx,
    emit: async (name: string, event: any) => {
      const results = [];
      for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
      return results;
    },
    config: currentConfig,
    setConfigReady(next: boolean) { ready = next; token = {}; },
    setState(next: RuntimeState) { current = next; token = {}; },
  };
}

test("adds an optional Google-compatible target while preserving required fields", () => {
  const schema = Type.Object({ path: Type.String(), limit: Type.Optional(Type.Number()) });
  const routed = withExecutionTarget(schema);
  assert.deepEqual(routed.required, ["path"]);
  assert.deepEqual(routed.properties.execution_target.enum, ["sandbox", "host"]);
  assert.equal(routed.properties.execution_target.type, "string");
  assert.deepEqual(withoutExecutionTarget({ path: "x", execution_target: "host" as const }), { path: "x" });
});

test("approval messages omit routing and use a generic host-isolation warning", () => {
  const message = hostApprovalMessage("read", {
    z: 1,
    execution_target: "host",
    path: "README.md",
  }, "/work/repo");
  assert.match(message, /Tool: read/);
  assert.match(message, /Working directory: \/work\/repo/);
  assert.equal(message.split("\n").find((line) => line.startsWith("Warning:")), "Warning: this operation runs on the host and bypasses any isolation.");
  assert.doesNotMatch(message, /execution_target|mode|volume/i);
  assert.ok(message.indexOf('"path"') < message.indexOf('"z"'));
});

test("Bash approval shows the literal command without a timeout row or JSON", () => {
  const command = 'ls -la "$HOME/Desktop"\nprintf "hello\\n"';
  const message = hostApprovalMessage("bash", { command, timeout: 10, execution_target: "host" }, "/work/repo");
  assert.equal(message.split("Command:\n\n")[1], command);
  assert.doesNotMatch(message, /Timeout|timeout/);
  assert.doesNotMatch(message, /Exact arguments|"command"|execution_target/);
});

test("Bash approval uses the real Bash lexer without changing visible command text", () => {
  const command = 'ls -la "$HOME/Desktop"\nprintf "hello\\n"';
  const message = hostApprovalMessage("bash", { command }, "/work/repo", approvalTheme);
  const lines = message.split("\n");
  const code = lines.slice(lines.findIndex((line) => stripVTControlCharacters(line) === "Command:") + 2).join("\n");
  const greenStart = approvalTheme.fg("success", "BASE").split("BASE")[0]!;
  const codeLines = code.split("\n");
  for (const [index, line] of highlightCode(command, "bash").entries()) {
    assert.ok(codeLines[index]!.startsWith(greenStart));
    assert.ok(codeLines[index]!.endsWith("\x1b[39m"));
    for (const token of line.matchAll(/\x1b\[(?:38;[25];[0-9;]+|3[0-7]|9[0-7])m/g)) {
      assert.ok(codeLines[index]!.includes(token[0]), "Bash lexer token foregrounds remain intact");
    }
  }
  assert.equal(stripVTControlCharacters(code), command);
  assert.notEqual(code, approvalTheme.fg("syntaxString", command));
});

test("Bash approval escapes terminal controls rather than executing or hiding them", () => {
  const message = hostApprovalMessage("bash", { command: "echo \x1b[2J\r\u202e" }, "/work/repo");
  assert.equal(message.split("Command:\n\n")[1], "echo \\u{1b}[2J\\u{d}\\u{202e}");
});

test("approval styling preserves exact arguments and emphasizes the isolation warning", () => {
  const input = { path: 'file "name"', limit: 10, execution_target: "host" };
  const theme = approvalTheme;
  const plain = hostApprovalMessage("read", input, "/work/repo");
  const styled = hostApprovalMessage("read", input, "/work/repo", theme);
  assert.equal(stripVTControlCharacters(styled), plain);
  assert.ok(styled.includes(theme.bold(theme.fg("accent", "read"))));
  assert.match(styled, /\x1b\[33mWarning:/);
  assert.ok(plain.indexOf("Warning:") < plain.indexOf("Exact arguments:"));
  assert.deepEqual(JSON.parse(plain.split("Exact arguments:\n")[1]!), {
    path: input.path, limit: 10,
  });
  assert.match(styled.split("\n").find((line) => line.includes('"path"'))!, /\x1b\[/);
});

test("approval selector defaults to denial and keeps non-TUI prompts plain", async () => {
  const harness = createHarness();
  await harness.emit("tool_call", {
    toolName: "bash", toolCallId: "prompt", input: { command: "pwd", execution_target: "host" },
  });
  assert.deepEqual(harness.confirmations[0]!.choices, ["No", "Yes"]);
  assert.match(harness.confirmations[0]!.title, /^Allow host execution\?\n\nTool: bash/);
  assert.doesNotMatch(harness.confirmations[0]!.title, /\x1b/);

  const terminal = createHarness({ mode: "tui" });
  await terminal.emit("tool_call", {
    toolName: "bash", toolCallId: "themed", input: { command: "pwd", execution_target: "host" },
  });
  assert.doesNotMatch(terminal.confirmations[0]!.title, /\x1b|Timeout/);
  assert.equal(stripVTControlCharacters(terminal.confirmations[0]!.title), harness.confirmations[0]!.title);
  assert.match(stripVTControlCharacters(terminal.confirmations[0]!.title), /Command:\n\npwd$/);

  const canceled = createHarness({ cancel: true });
  const [result] = await canceled.emit("tool_call", {
    toolName: "bash", toolCallId: "cancel", input: { command: "pwd", execution_target: "host" },
  });
  assert.equal(result.block, true);
});

test("registers all routed schemas and keeps built-in prompt/render metadata", () => {
  const harness = createHarness();
  for (const name of ROUTED) {
    const tool = harness.tools.get(name);
    assert.ok(tool, `${name} registered`);
    assert.deepEqual(tool.parameters.properties.execution_target.enum, ["sandbox", "host"]);
    assert.equal(tool.parameters.properties.execution_target.type, "string");
    assert.ok(!tool.parameters.required?.includes("execution_target"));
    assert.equal(typeof tool.execute, "function");
  }
  assert.equal(typeof harness.tools.get("read").renderCall, "function");
  assert.equal(typeof harness.tools.get("read").renderResult, "function");
});

test("approves one exact host call and rejects changed arguments", async (t) => {
  const harness = createHarness();
  const directory = await mkdtemp(path.join(tmpdir(), "pi-msb-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "value.txt");
  await writeFile(filePath, "host data\n");
  const input = { path: filePath, execution_target: "host" as const };
  const [gate] = await harness.emit("tool_call", { toolName: "read", toolCallId: "read-1", input });
  assert.equal(gate, undefined);
  assert.equal(harness.confirmations.length, 1);
  const result = await harness.tools.get("read").execute("read-1", input, undefined, undefined, harness.ctx);
  assert.match(result.content[0].text, /host data/);
  await assert.rejects(
    harness.tools.get("read").execute("read-2", { path: directory, execution_target: "host" }, undefined, undefined, harness.ctx),
    /not approved for this exact tool call/,
  );
});

test("fails closed without UI and clears denied approvals", async () => {
  const harness = createHarness({ hasUI: false });
  const input = { path: "README.md", execution_target: "host" as const };
  const [result] = await harness.emit("tool_call", { toolName: "read", toolCallId: "no-ui", input });
  assert.deepEqual(result, {
    block: true,
    reason: "Host execution requires user approval, but no interactive UI is available.",
  });

  const denied = createHarness({ confirm: false });
  const [denial] = await denied.emit("tool_call", { toolName: "read", toolCallId: "denied", input });
  assert.deepEqual(denial, { block: true, reason: "Host execution was denied by the user." });
  await assert.rejects(
    denied.tools.get("read").execute("denied", input, undefined, undefined, denied.ctx),
    /not approved/,
  );
});

test("blocks routed tools when unavailable and supports configured host fallback", async () => {
  const blocked = createHarness({ runtimeState: { ...state("unavailable"), reason: "PRIVATE_STARTUP_REASON" } });
  const input = { path: "extensions/pi-msb/tools.ts" };
  const [gate] = await blocked.emit("tool_call", { toolName: "read", toolCallId: "blocked", input });
  assert.equal(gate.block, true);
  assert.doesNotMatch(gate.reason, /PRIVATE_STARTUP_REASON/);
  assert.match(gate.reason, /msb_diagnostics/);
  await assert.rejects(blocked.tools.get("read").execute("blocked", input, undefined, undefined, blocked.ctx), (error: Error) => /unavailable/.test(error.message) && !error.message.includes("PRIVATE_STARTUP_REASON"));

  const disabled = createHarness({ runtimeState: state("disabled"), config: { fallbackMode: "host" } });
  const [disabledGate] = await disabled.emit("tool_call", { toolName: "read", toolCallId: "disabled", input });
  assert.equal(disabledGate.block, true);
  await assert.rejects(disabled.tools.get("read").execute("disabled", input, undefined, undefined, disabled.ctx), /unavailable/);

  const fallback = createHarness({ runtimeState: state("host-fallback"), config: { fallbackMode: "host" } });
  const result = await fallback.tools.get("read").execute("fallback", input, undefined, undefined, fallback.ctx);
  assert.match(result.content[0].text, /.+/);
  const [gateResult] = await fallback.emit("tool_call", { toolName: "read", toolCallId: "fallback", input: { ...input, execution_target: "host" } });
  assert.equal(gateResult, undefined);
  assert.equal(fallback.confirmations.length, 0);
});

test("todo and ask_user_question require explicit pass-through configuration", async () => {
  const names = ["todo", "ask_user_question"];
  const defaults = createHarness({ config: { passThroughTools: [...DEFAULT_CONFIG.passThroughTools] } });
  const configured = createHarness({ config: { passThroughTools: [...DEFAULT_CONFIG.passThroughTools, ...names] } });
  for (const toolName of names) {
    const event = { toolName, toolCallId: toolName, input: {} };
    const [blocked] = await defaults.emit("tool_call", event);
    assert.equal(blocked.block, true, toolName);
    assert.equal((await configured.emit("tool_call", event))[0], undefined, toolName);
  }
  for (const toolName of DEFAULT_CONFIG.passThroughTools) {
    assert.equal((await defaults.emit("tool_call", { toolName, toolCallId: toolName, input: {} }))[0], undefined, toolName);
  }
});

test("applies the provenance gate and pass-through allowlist", async () => {
  const harness = createHarness({ config: { passThroughTools: ["ask_user"] } });
  (harness as any).emit;
  const toolCall = { toolName: "third_party", toolCallId: "third-party", input: {} };
  const [blocked] = await harness.emit("tool_call", toolCall);
  assert.match(blocked.reason, /pass-through/);
});

test("updates skill access, tracks Bash output, and proxies user_bash", async () => {
  const harness = createHarness();
  await harness.emit("before_agent_start", {
    systemPrompt: "base",
    systemPromptOptions: { skills: [{ filePath: "/tmp/SKILL.md", baseDir: "/tmp" }] },
  });
  const [prompt] = await harness.emit("before_agent_start", { systemPrompt: "base" });
  assert.ok(prompt.systemPrompt.startsWith("base\n\nmode:active\n"));
  assert.match(prompt.systemPrompt, /Before creating Dockerfile customization, call msb_dockerfile_get/);
  assert.match(prompt.systemPrompt, /msb_dockerfile_write.*explicit per-proposal approval/);
  assert.match(prompt.systemPrompt, /msb_dockerfile_build.*autonomous build\/export only, no approval dialog or UI needed/);
  assert.match(prompt.systemPrompt, /msb_dockerfile_load.*separate default-No approval/);
  assert.match(prompt.systemPrompt, /Never use host commands or sandbox file tools/);
  const [userBash] = await harness.emit("user_bash", { type: "user_bash", command: "true", cwd: process.cwd() });
  assert.ok(userBash.operations);
  await userBash.operations.exec("true", process.cwd(), { onData: () => {} });
  assert.deepEqual(harness.skillUpdates[0], [{ filePath: "/tmp/SKILL.md", baseDir: "/tmp" }]);
  assert.deepEqual(harness.skillUpdates[1], []);
  assert.deepEqual(harness.allowedReads, []);
});

test("third-party gate exempts only the exact owned configuration, diagnostics and Dockerfile get/set tools", async () => {
  for (const status of ["active", "unavailable", "off", "host-fallback", "booting", "stopping", "disabled"] as const) {
    const f = createHarness({ runtimeState: state(status) });
    for (const toolName of ["msb_config_get", "msb_config_set", "msb_diagnostics", "msb_dockerfile_get", "msb_dockerfile_write", "msb_dockerfile_build", "msb_dockerfile_load"]) {
      const outcomes = await f.emit("tool_call", { toolName, toolCallId: "config", input: {} });
      assert.ok(outcomes.every((outcome) => !outcome?.block));
    }
    if (status !== "off" && status !== "host-fallback") {
      for (const toolName of ["msb_config_get_extra", "msb_config_set_extra", "msb_diagnostics_extra", "msb_dockerfile_guide", "msb_dockerfile_get_extra", "msb_dockerfile_write_extra", "msb_other", "external_tool"]) {
        const outcomes = await f.emit("tool_call", { toolName, toolCallId: "external", input: {} });
        assert.ok(outcomes.some((outcome) => outcome?.block), toolName);
      }
    }
    assert.equal(f.confirmations.length, 0);
  }
});


function readyExecution(cwd: string) {
  const execution = createSessionExecution("one", cwd);
  execution.finish(execution.context.current());
  return execution;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("fresh built-ins, grep and approval paths follow workspace and same-session cwd replacements", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-msb-current-cwd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, "first"), second = path.join(root, "second"), nested = path.join(second, "nested");
  await mkdir(first); await mkdir(nested, { recursive: true });
  const execution = readyExecution(first);
  const h = createHarness({ execution: execution.context });
  for (const [cwd, text] of [[first, "first"], [second, "second"], [nested, "nested"]]) {
    execution.finish(execution.begin("one", cwd!));
    await writeFile(path.join(cwd!, "value.txt"), text!);
    const read = (id: string, params: unknown) => h.tools.get("read").execute(id, params, undefined, undefined, h.ctx);
    assert.match((await read("guest", { path: "value.txt" })).content[0].text, new RegExp(text!));
    await h.tools.get("write").execute("write", { path: "written.txt", content: text }, undefined, undefined, h.ctx);
    assert.equal(await readFile(path.join(cwd!, "written.txt"), "utf8"), text);
    const input = { path: "value.txt", execution_target: "host" };
    await h.emit("tool_call", { toolName: "read", toolCallId: "host", input });
    assert.ok(h.confirmations.at(-1)!.title.includes(`Working directory: ${cwd}`));
    assert.match((await read("host", input)).content[0].text, new RegExp(text!));
    await h.tools.get("grep").execute("grep", { pattern: "x" }, undefined, undefined, h.ctx);
  }
  assert.deepEqual(h.grepCwds, [first, second, nested]);
});

test("one-shot host approvals do not survive replacement even with identical session/cwd and arguments", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-msb-stale-approval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "value.txt"), "host");
  const execution = readyExecution(root), h = createHarness({ execution: execution.context });
  const input = { path: "value.txt", execution_target: "host" };
  const call = { toolName: "read", toolCallId: "host", input };
  const read = () => h.tools.get("read").execute("host", input, undefined, undefined, h.ctx);
  await h.emit("tool_call", call);
  execution.finish(execution.begin("one", root));
  await assert.rejects(read(), /not approved/);
  await h.emit("tool_call", call);
  assert.match((await read()).content[0].text, /host/);
  await assert.rejects(read(), /not approved/);
});

test("deferred host approval is blocked after replacement and cannot authorize the new context", async () => {
  const execution = readyExecution(process.cwd()), choice = deferred<string>();
  const h = createHarness({ execution: execution.context, select: () => choice.promise });
  const input = { path: "README.md", execution_target: "host" };
  const pending = h.emit("tool_call", { toolName: "read", toolCallId: "host", input });
  execution.finish(execution.begin("two", process.cwd()));
  choice.resolve("Yes");
  const [gate] = await pending;
  assert.equal(gate.block, true);
  await assert.rejects(h.tools.get("read").execute("host", input, undefined, undefined, h.ctx), /not approved/);
});

test("replacement invalidates discovered skill reads and already-captured user bash operations", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-msb-stale-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skill = path.join(root, "SKILL.md"); await writeFile(skill, "host skill");
  const execution = readyExecution(root), ops = operations();
  ops.read.access = async () => { throw new Error("sandbox-only sentinel"); };
  const h = createHarness({ execution: execution.context, hostReads: createHostReadAccess(), operations: ops });
  await h.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { skills: [{ filePath: skill, baseDir: root }] } });
  const read = () => h.tools.get("read").execute("read", { path: "SKILL.md" }, undefined, undefined, h.ctx);
  assert.match((await read()).content[0].text, /host skill/);
  const [bash] = await h.emit("user_bash", {});
  execution.finish(execution.begin("two", root));
  await assert.rejects(read(), /sandbox-only sentinel/);
  await assert.rejects(bash.operations.exec("true", root, { onData() {} }), /context changed/);
});

test("a skill resolution deferred across replacement cannot perform a host read", async () => {
  const execution = readyExecution(process.cwd()), skill = deferred<string | undefined>(), entered = deferred<void>();
  const h = createHarness({ execution: execution.context, hostReads: {
    updateSkills() {}, clear() {}, allowGeneratedFile: async () => {},
    resolve: () => { entered.resolve(); return skill.promise; },
  } });
  const pending = h.tools.get("read").execute("skill", { path: "README.md" }, undefined, undefined, h.ctx);
  await entered.promise;
  execution.finish(execution.begin("two", process.cwd()));
  skill.resolve(path.join(process.cwd(), "README.md"));
  await assert.rejects(pending, /context changed/);
});

test("deferred output grants stay in the retired host-read store without clearing replacement skills", async () => {
  const execution = readyExecution(process.cwd()), entered = deferred<void>(), release = deferred<void>();
  const stores: Array<{ skills: unknown[]; generated: string[]; access: HostReadAccess }> = [];
  const createHostReads = () => {
    const store = { skills: [] as unknown[], generated: [] as string[], access: undefined as unknown as HostReadAccess };
    store.access = {
      updateSkills(skills) { store.skills = [...skills]; },
      clear() { store.skills = []; store.generated = []; },
      resolve: async () => undefined,
      allowGeneratedFile: async (file) => { entered.resolve(); await release.promise; store.generated.push(file); },
    };
    stores.push(store);
    return store.access;
  };
  const h = createHarness({ execution: execution.context, hostReads: createHostReads(), createHostReads, grepResult: { content: [], details: { fullOutputPath: "/tmp/old-output" } } });
  const pending = h.tools.get("grep").execute("grep", { pattern: "x" }, undefined, undefined, h.ctx);
  await entered.promise;
  execution.finish(execution.begin("two", process.cwd()));
  await h.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { skills: [{ filePath: "/tmp/new/SKILL.md", baseDir: "/tmp/new" }] } });
  release.resolve(); await pending;
  assert.deepEqual(stores[0]!.generated, []);
  assert.deepEqual(stores[1]!.generated, []);
  assert.deepEqual(stores[1]!.skills, [{ filePath: "/tmp/new/SKILL.md", baseDir: "/tmp/new" }]);
});

test("unready execution boundary blocks old off mode, including user bash and tool-call hooks", async () => {
  const execution = readyExecution(process.cwd()), h = createHarness({ execution: execution.context, runtimeState: state("off") });
  execution.begin("two", process.cwd());
  const [gate] = await h.emit("tool_call", { toolName: "read", toolCallId: "read", input: { path: "README.md" } });
  assert.equal(gate.block, true);
  await assert.rejects(h.tools.get("read").execute("read", { path: "README.md" }, undefined, undefined, h.ctx), /not ready/);
  const [bash] = await h.emit("user_bash", {});
  assert.ok(bash.operations);
  await assert.rejects(bash.operations.exec("true", process.cwd(), { onData() {} }), /unavailable/);
});

test("management tools with missing or mismatched registration provenance receive no exemption", async () => {
  for (const configToolSource of [null, fileURLToPath(new URL("./settings-tools.ts", import.meta.url)), "/tmp/nonexistent/index.ts"]) {
    const f = createHarness({ configToolSource });
    for (const toolName of ["msb_config_get", "msb_config_set", "msb_diagnostics", "msb_dockerfile_get", "msb_dockerfile_write", "msb_dockerfile_build", "msb_dockerfile_load"]) {
      const outcomes = await f.emit("tool_call", { toolName, toolCallId: "spoof", input: {} });
      assert.ok(outcomes.some((outcome) => outcome?.block));
    }
  }
});

const recoveryInput = () => ({ command: "printf 'host-recovery-fixture\\n'; pwd", timeout: 5, execution_target: "host" });
const hostCall = (input: Record<string, unknown>, id = "recovery") => ({ toolName: "bash", toolCallId: id, input });
const runHost = (h: ReturnType<typeof createHarness>, input: Record<string, unknown>, id = "recovery") =>
  h.tools.get("bash").execute(id, input, undefined, undefined, h.ctx);

for (const status of ["unavailable", "disabled"] as const) test(`${status} permits only explicitly approved bounded host Bash in the fixed cwd`, async (t) => {
  const cwd = await mkdtemp("/tmp/pi-msb-host-recovery-");
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const execution = readyExecution(cwd);
  const h = createHarness({ runtimeState: state(status), execution: execution.context });
  const input = recoveryInput();
  const [gate] = await h.emit("tool_call", hostCall(input));
  assert.equal(gate, undefined);
  assert.deepEqual(h.confirmations[0]!.choices, ["No", "Yes"]);
  const title = h.confirmations[0]!.title;
  assert.ok(title.includes(input.command));
  assert.ok(title.includes(`Working directory: ${cwd}`));
  assert.doesNotMatch(title, /Timeout \(seconds\):/);
  assert.equal(title.split("\n").find((line) => line.startsWith("Warning:")), "Warning: this operation runs on the host and bypasses any isolation.");
  const result = await runHost(h, input);
  assert.ok(result.content[0].text.includes("host-recovery-fixture"));
  assert.ok(result.content[0].text.includes(cwd));
  await assert.rejects(runHost(h, input), /not approved/);
});

test("unavailable non-host calls, other host tools and lifecycle transitions remain blocked", async () => {
  for (const status of ["unavailable", "disabled", "booting", "stopping"] as const) {
    const h = createHarness({ runtimeState: state(status) });
    for (const tool of ROUTED) {
      const input = { ...recoveryInput(), path: "/tmp/not-read", content: "not-written", pattern: "x" };
      const [gate] = await h.emit("tool_call", { toolName: tool, toolCallId: tool, input });
      if ((status === "unavailable" || status === "disabled") && tool === "bash") continue;
      assert.equal(gate.block, true, `${status}/${tool}`);
      await assert.rejects(h.tools.get(tool).execute(tool, input, undefined, undefined, h.ctx), /not approved|unavailable/);
    }
    const input = { command: "false" };
    assert.equal((await h.emit("tool_call", hostCall(input)))[0].block, true);
    await assert.rejects(runHost(h, input), /unavailable/);
  }
});

test("recovery rejects missing, non-finite, non-positive and oversized timeouts before approval and execution", async () => {
  for (const timeout of [undefined, null, "5", NaN, Infinity, -Infinity, 0, -1, 120.001]) {
    const h = createHarness({ runtimeState: state("unavailable") });
    const input = { ...recoveryInput(), timeout };
    const [gate] = await h.emit("tool_call", hostCall(input));
    assert.match(gate.reason, /finite positive timeout <=120/);
    assert.equal(h.confirmations.length, 0);
    await assert.rejects(runHost(h, input), /not approved|timeout/);
  }
  const h = createHarness({ runtimeState: state("unavailable") });
  assert.equal((await h.emit("tool_call", hostCall({ ...recoveryInput(), timeout: 120 })))[0], undefined);
});

test("recovery fails closed for disabled permission, absent UI, No/cancel, unresolved or absent configuration signal", async () => {
  for (const options of [
    { config: { allowHostExecution: false } }, { hasUI: false }, { confirm: false }, { cancel: true },
    { configReady: false }, { omitHostExecutionToken: true }, { omitExecution: true }, { omitRootProof: true },
  ]) {
    const h = createHarness({ runtimeState: state("unavailable"), ...options });
    const input = recoveryInput();
    assert.equal((await h.emit("tool_call", hostCall(input)))[0].block, true);
    await assert.rejects(runHost(h, input), /not approved|disabled|trustworthy|unavailable/);
  }
  const execution = createSessionExecution("unready", "/tmp");
  const h = createHarness({ runtimeState: state("unavailable"), execution: execution.context });
  assert.equal((await h.emit("tool_call", hostCall(recoveryInput())))[0].block, true);
  await assert.rejects(runHost(h, recoveryInput()), /not ready/);
  assert.equal(h.confirmations.length, 0);
});

for (const status of ["active", "unavailable"] as const) test(`${status} approval rejects in-place input mutation while awaiting UI`, async () => {
  for (const mutate of [
    (input: Record<string, unknown>) => { input.command = "false"; },
    (input: Record<string, unknown>) => { input.timeout = 10; },
    (input: Record<string, unknown>) => { input.execution_target = "sandbox"; },
  ]) {
    const answer = deferred<string>();
    const h = createHarness({ runtimeState: state(status), select: () => answer.promise });
    const input = recoveryInput();
    const pending = h.emit("tool_call", hostCall(input));
    mutate(input);
    answer.resolve("Yes");
    assert.match((await pending)[0].reason, /changed while awaiting/);
    await assert.rejects(runHost(h, { ...input, execution_target: "host" }), /not approved/);
  }
});

for (const status of ["unavailable", "disabled"] as const) test(`${status} rejects replaced input before rendering host approval`, async (t) => {
  const cwd = await mkdtemp("/tmp/pi-msb-recovery-display-");
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const entered = deferred<void>(), release = deferred<void>();
  const command = "printf 'unapproved' > marker";
  const input = { ...recoveryInput(), command };
  let validations = 0;
  const h = createHarness({
    runtimeState: state(status), execution: readyExecution(cwd).context,
    validateRoot: async () => {
      if (++validations === 1) { entered.resolve(); await release.promise; }
    },
    select: async () => {
      // A vulnerable prompt renders the mutated old object, then accepts the
      // restored original command because event.input still matches its hash.
      input.command = command;
      return "Yes";
    },
  });
  const event = hostCall(input);
  const pending = h.emit("tool_call", event);
  await entered.promise;
  event.input = { ...input };
  input.command = "printf 'harmless'";
  release.resolve();
  assert.equal((await pending)[0]?.block, true);
  assert.equal(h.confirmations.length, 0);
  input.command = command;
  await assert.rejects(runHost(h, event.input), /not approved/);
  await assert.rejects(access(path.join(cwd, "marker")), { code: "ENOENT" });
});

test("recovery approval cannot authorize changed id/command/timeout/cwd or replay", async () => {
  for (const change of ["id", "command", "timeout", "cwd"] as const) {
    const execution = readyExecution("/tmp");
    const h = createHarness({ runtimeState: state("unavailable"), execution: execution.context });
    const input = recoveryInput();
    await h.emit("tool_call", hostCall(input));
    if (change === "command") input.command = "false";
    if (change === "timeout") input.timeout = 10;
    if (change === "cwd") execution.finish(execution.begin("one", "/tmp/replacement-not-used"));
    await assert.rejects(runHost(h, input, change === "id" ? "different" : "recovery"), /not approved/);
  }
});

for (const when of ["during approval", "before execution"] as const) test(`host recovery rechecks identity/readiness/configuration/state ${when}`, async () => {
  for (const change of ["identity", "unready", "config", "permission", "routing", "state", "state-roundtrip", "config-roundtrip", "noUI"] as const) {
    const execution = readyExecution("/tmp");
    const answer = deferred<string>();
    const h = createHarness({ runtimeState: state("unavailable"), execution: execution.context, select: () => answer.promise });
    const input = recoveryInput();
    const pending = h.emit("tool_call", hostCall(input));
    if (when === "before execution") { answer.resolve("Yes"); assert.equal((await pending)[0], undefined); }
    if (change === "identity") execution.finish(execution.begin("one", "/tmp"));
    if (change === "unready") execution.begin("one", "/tmp");
    if (change === "config" || change === "config-roundtrip") h.setConfigReady(false);
    if (change === "config-roundtrip") h.setConfigReady(true);
    if (change === "permission") h.config.allowHostExecution = false;
    if (change === "routing") h.config.routeTools = [];
    if (change === "state" || change === "state-roundtrip") h.setState(state("booting"));
    if (change === "state-roundtrip") h.setState(state("unavailable"));
    if (change === "noUI") h.ctx.hasUI = false;
    if (when === "during approval") {
      answer.resolve("Yes");
      assert.equal((await pending)[0].block, true, change);
    }
    await assert.rejects(runHost(h, input), /not approved|not ready|disabled|excluded|no interactive UI|trustworthy|unavailable/, change);
    // A failed invocation never restores its consumed approval.
    h.config.allowHostExecution = true;
    h.config.routeTools = [...ROUTED];
    h.ctx.hasUI = true;
    if (change === "config" || change === "config-roundtrip") h.setConfigReady(true);
    if (change === "state" || change === "state-roundtrip") h.setState(state("unavailable"));
    execution.finish(execution.context.current());
    await assert.rejects(runHost(h, input), /not approved/, change);
  }
});

test("active adapters and explicit off/fallback retain their existing host behavior", async () => {
  const active = createHarness({ omitHostExecutionToken: true });
  assert.equal((await active.emit("tool_call", hostCall({ command: "not-executed", execution_target: "host" })))[0], undefined);
  for (const status of ["off", "host-fallback"] as const) {
    const h = createHarness({ runtimeState: state(status), configReady: false, hasUI: false, config: { allowHostExecution: false } });
    assert.equal((await h.emit("tool_call", hostCall({ command: "not-executed", execution_target: "host" })))[0], undefined);
    assert.equal(h.confirmations.length, 0);
    const override = { command: "not-executed", execution_target: "host", cwd: "/tmp" };
    assert.match((await h.emit("tool_call", hostCall(override)))[0].reason, /cwd is supported only/);
    await assert.rejects(runHost(h, override), /cwd is supported only/);
  }
});

for (const phase of [1, 2, 3]) test(`recovery rechecks exact authorization across root validation await ${phase}`, async (t) => {
  const cwd = await mkdtemp("/tmp/pi-msb-root-await-");
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const change of ["command", "timeout", "target", "permission", "routing", "token", "readiness", "session", "state", "UI"] as const) {
    const entered = deferred<void>(), release = deferred<void>();
    let validations = 0;
    const execution = readyExecution(cwd);
    const h = createHarness({ runtimeState: state("unavailable"), execution: execution.context,
      validateRoot: async () => {
        if (++validations === phase) { entered.resolve(); await release.promise; }
      },
    });
    const input = { ...recoveryInput(), command: "printf 'no-handoff' > marker" };
    let gate: Promise<any>;
    let run: Promise<any> | undefined;
    if (phase === 3) {
      assert.equal((await h.emit("tool_call", hostCall(input)))[0], undefined);
      run = runHost(h, input);
      gate = Promise.resolve(undefined);
    } else gate = h.emit("tool_call", hostCall(input));
    await entered.promise;
    if (change === "command") input.command = "printf 'changed-command' > marker";
    if (change === "timeout") input.timeout = 10;
    if (change === "target") input.execution_target = "sandbox";
    if (change === "permission") h.config.allowHostExecution = false;
    if (change === "routing") h.config.routeTools = [];
    if (change === "token" || change === "readiness") h.setConfigReady(false);
    if (change === "token") h.setConfigReady(true);
    if (change === "session") execution.finish(execution.begin("one", cwd));
    if (change === "state") h.setState(state("booting"));
    if (change === "UI") h.ctx.hasUI = false;
    release.resolve();
    if (run) await assert.rejects(run, /not approved|not ready|disabled|trustworthy/);
    else assert.equal((await gate)[0].block, true, change);
    // Restore mutable inputs/policy without adding a new approval: a failed validation cannot revive one.
    input.command = "printf 'no-handoff' > marker"; input.timeout = 5; input.execution_target = "host";
    h.config.allowHostExecution = true; h.config.routeTools = [...ROUTED]; h.ctx.hasUI = true;
    if (change === "readiness") h.setConfigReady(true);
    if (change === "state") h.setState(state("unavailable"));
    await assert.rejects(runHost(h, input), /not approved/);
    await assert.rejects(access(path.join(cwd, "marker")), { code: "ENOENT" });
  }
});

for (const status of ["active", "unavailable"] as const) test(`${status} footerless host approval binds Yes to the exact input and timeout`, async () => {
  for (const change of ["none", "timeout", "command", "input swap"] as const) {
    const h = createHarness({ mode: "tui", runtimeState: state(status) });
    const entered = deferred<void>(); let approve!: () => void;
    let preview = "";
    (h.ctx.ui as any).custom = (factory: any, options: any) => new Promise((resolve) => {
      assert.equal(options.overlay, false);
      const view = factory({ requestRender() {}, terminal: { rows: 24 } }, approvalTheme, new KeybindingsManager(TUI_KEYBINDINGS), resolve);
      view.render(120); view.handleInput("\x1b[B");
      preview = stripVTControlCharacters(view.render(120).join("\n"));
      approve = () => { view.invalidate(); preview = stripVTControlCharacters(view.render(120).join("\n")); view.handleInput("\r"); view.dispose(); }; entered.resolve();
    });
    const input = recoveryInput(), event = hostCall(input, "custom-host"), originalCommand = input.command;
    const pending = h.emit("tool_call", event); await entered.promise;
    assert.ok(preview.includes(input.command)); assert.doesNotMatch(preview, /Timeout|navigate|select|cancel/);
    if (change === "timeout") input.timeout = 10;
    if (change === "command") input.command = "false";
    if (change === "input swap") event.input = { ...input };
    approve();
    assert.ok(preview.includes(originalCommand), "display invalidation retains the original reviewed command");
    const [gate] = await pending;
    assert.equal(h.confirmations.length, 0, "custom approval never opens a native selector");
    if (change === "none") {
      assert.equal(gate, undefined);
      await assert.rejects(runHost(h, { ...input, timeout: 10 }, "custom-host"), /not approved/);
      await assert.rejects(runHost(h, input, "custom-host"), /not approved/, "a mismatched handoff consumes the one-shot grant");
    } else {
      assert.match(gate.reason, /changed while awaiting/);
      await assert.rejects(runHost(h, { ...input, execution_target: "host" }, "custom-host"), /not approved/);
    }
  }
});

for (const status of ["active", "unavailable", "disabled"] as const) test(`${status} model-facing prompt and routed schemas require one simple host command per approval`, async () => {
  const h = createHarness({ runtimeState: state(status), promptNote: systemPromptNote });
  const [prompt] = await h.emit("before_agent_start", { systemPrompt: "base" });
  const descriptions = ROUTED.map((name) => h.tools.get(name).parameters.properties.execution_target.description as string);
  const instructions = [prompt.systemPrompt as string, ...descriptions];
  if (status !== "active") {
    const [blocked] = await h.emit("tool_call", { toolName: "bash", toolCallId: "blocked-guidance", input: { command: "not-run" } });
    assert.equal(blocked.block, true); instructions.push(blocked.reason);
  }
  for (const text of instructions) {
    assert.match(text, /expected host effects in one short sentence/);
    assert.match(text, /Do not repeat the literal command in the agent description or narration/);
    assert.match(text, /the approval dialog already shows the exact command/);
    assert.match(text, /Do not mention chosen timeout values or routine execution settings/);
    assert.match(text, /set them silently unless the user asks or a timeout failure needs diagnosis/);
    assert.match(text, /Mention the execution directory in request prose only when it differs from the default session cwd/);
    assert.match(text, /otherwise omit directory narration/);
    assert.match(text, /Avoid repetitive operational narration/);
    for (const required of ["Start with passive msb_diagnostics and msb_config_get", "exactly ONE simple, clear, human-readable command per call and per approval", "normal executable with literal arguments and only necessary quoting", "Run every step separately", "fresh approval for each step", "explain its purpose", "expected host effects", "No command chaining (&&, || or semicolons)", "pipelines", "multiline command sequences", "shell substitutions ($() or backticks)", "loops", "eval", "encoded payloads", "sh -c", "code-oneliners", "script wrappers hiding multiple operations", "Do not characterize arbitrary shell as harmless or read-only", "Never automatically retry on the host or reuse approval"]) {
      assert.ok(text.includes(required), `missing host command instruction: ${required}`);
    }
  }
  if (status !== "active") {
    assert.match(prompt.systemPrompt, /finite positive timeout <=120/);
    assert.match(prompt.systemPrompt, /host-execution permission.*fresh No-first human approval/);
  }
  assert.equal(h.confirmations.length, 0, "instructions and blocked recovery do not run host commands");
});

test("routed grep context, glob and limit use only guest transport with current Pi", async () => {
  const cwd = "/pi-msb-guest-only";
  const calls: unknown[] = [];
  const h = createHarness({ execution: readyExecution(cwd).context, grepTransport: {
    stat: async (path) => { assert.equal(path, cwd); return { kind: "directory", size: 0, mode: 0o755, readonly: false, modifiedAt: null }; },
    writeFile: async () => { throw new Error("unexpected guest write"); },
    exists: async () => { throw new Error("unexpected guest exists"); },
    list: async () => { throw new Error("unexpected guest list"); },
    exec: async () => { throw new Error("unexpected guest non-streaming exec"); },
    dispose: async () => {},
    readFile: async (path) => {
      calls.push(["read", path]);
      return Buffer.from("GUEST_BEFORE\nneedle\nGUEST_AFTER\n");
    },
    execStream: async (command, args, options) => {
      calls.push([command, args, options?.cwd]);
      options?.onStdout?.(Buffer.from(JSON.stringify({ type: "match", data: {
        path: { text: "file.txt" }, line_number: 2, lines: { text: "needle\n" },
      } }) + "\n"));
      assert.equal(options?.signal?.aborted, true);
      throw Object.assign(new Error("limit reached"), { code: "ABORTED" });
    },
  } });
  const result = await h.tools.get("grep").execute("grep", { pattern: "needle", context: 1, glob: "*.txt", limit: 1 }, undefined, undefined, h.ctx);
  assert.match(result.content[0].text, /file.txt-1- GUEST_BEFORE\nfile.txt:2: needle\nfile.txt-3- GUEST_AFTER/);
  assert.equal(result.details.matchLimitReached, 1);
  assert.deepEqual(calls, [
    ["rg", ["--json", "--line-number", "--color=never", "--hidden", "--glob", "*.txt", "--", "needle", cwd], cwd],
    ["read", `${cwd}/file.txt`],
  ]);
});


test("sandbox built-ins preserve original execution context and nested-tool capabilities", async () => {
  const ops = operations();
  ops.read = { access: async () => {}, readFile: async () => Buffer.from("guest-only"), detectImageMimeType: async () => null };
  const h = createHarness({ operations: ops });
  const tools = Object.freeze([]);
  const executeTool = async () => { throw new Error("unexpected nested call"); };
  Object.assign(h.ctx, { tools, executeTool });
  let contextReads = 0;
  Object.defineProperty(h.ctx, "model", { get() {
    assert.equal(this, h.ctx);
    assert.equal(Reflect.get(this, "tools"), tools); assert.equal(Reflect.get(this, "executeTool"), executeTool);
    contextReads++; return undefined;
  } });
  const result = await h.tools.get("read").execute("read", { path: "guest-only.txt" }, undefined, undefined, h.ctx);
  assert.equal(result.content[0].text, "guest-only");
  assert.ok(contextReads > 0);
});
