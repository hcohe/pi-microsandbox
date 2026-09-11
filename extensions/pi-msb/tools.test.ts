import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  hostApprovalMessage,
  registerSandboxTools,
  withExecutionTarget,
  withoutExecutionTarget,
} from "./tools.ts";
import type {
  Config,
  HostReadAccess,
  RuntimeExecution,
  RuntimeState,
  ToolOpsProvider,
} from "./types.ts";

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
    mode: "auto",
    cloneBranch: "current",
    cloneDepth: "unlimited",
    shallowArchive: false,
    volumeQuotaMiB: 1024,
    network: { mode: "default", allowHosts: [], allowDns: true, publishPorts: [] },
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
    hostRoAllowlist: [],
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
          mode: "git",
          image: "ubuntu:24.04",
          pid: 42,
          cwd: process.cwd(),
          createdAt: Date.now(),
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
  config?: Partial<Config>;
  hasUI?: boolean;
  confirm?: boolean;
} = {}) {
  const cwd = process.cwd();
  let current = options.runtimeState ?? state();
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const tools = new Map<string, any>();
  const confirmations: Array<{ title: string; message: string }> = [];
  const allowedReads: string[] = [];
  const skillUpdates: unknown[][] = [];
  const hostReads: HostReadAccess = {
    updateSkills: (skills) => { skillUpdates.push([...skills]); },
    allowGeneratedFile: async (filePath) => { allowedReads.push(filePath); },
    resolve: async () => undefined,
    clear: () => {},
  };
  const provider: ToolOpsProvider = {
    isActive: () => current.status === "active",
    getState: () => current,
    withRuntime: async (callback) => callback({ transport: {} as any, operations: operations() }),
  };
  const ctx = {
    cwd,
    hasUI: options.hasUI ?? true,
    ui: {
      confirm: async (title: string, message: string) => {
        confirmations.push({ title, message });
        return options.confirm ?? true;
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    getAllTools() {
      return [...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        sourceInfo: { source: "builtin" },
      }));
    },
    on(name: string, handler: any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  registerSandboxTools(pi, {
    provider,
    config: config(options.config),
    cwd,
    hostReads,
    createGrepExecute: () => async () => ({ content: [{ type: "text", text: "sandbox" }] }),
    grepHelpers: {
      DEFAULT_MAX_BYTES: 1000,
      DEFAULT_MAX_LINES: 100,
      truncateHead: (content: string) => ({ content, truncated: false }),
      truncateLine: (text: string) => ({ text, wasTruncated: false }),
      formatSize: (bytes: number) => `${bytes} bytes`,
    },
    systemPromptNote: (runtimeState) => `mode:${runtimeState.status}`,
  });
  return {
    tools,
    confirmations,
    allowedReads,
    skillUpdates,
    ctx,
    emit: async (name: string, event: any) => {
      const results = [];
      for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
      return results;
    },
    setState(next: RuntimeState) { current = next; },
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

test("approval messages omit routing and warn about retained git volume", () => {
  const message = hostApprovalMessage("bash", {
    z: 1,
    execution_target: "host",
    command: "git status",
  }, "/work/repo", "git");
  assert.match(message, /Tool: bash/);
  assert.match(message, /Working directory: \/work\/repo/);
  assert.match(message, /bypass.*retained git volume/i);
  assert.doesNotMatch(message, /execution_target/);
  assert.ok(message.indexOf('"command"') < message.indexOf('"z"'));
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
  const blocked = createHarness({ runtimeState: state("unavailable") });
  const input = { path: "extensions/pi-msb/tools.ts" };
  const [gate] = await blocked.emit("tool_call", { toolName: "read", toolCallId: "blocked", input });
  assert.equal(gate.block, true);
  await assert.rejects(blocked.tools.get("read").execute("blocked", input, undefined, undefined, blocked.ctx), /unavailable/);

  const fallback = createHarness({ runtimeState: state("host-fallback"), config: { fallbackMode: "host" } });
  const result = await fallback.tools.get("read").execute("fallback", input, undefined, undefined, fallback.ctx);
  assert.match(result.content[0].text, /.+/);
  const [gateResult] = await fallback.emit("tool_call", { toolName: "read", toolCallId: "fallback", input: { ...input, execution_target: "host" } });
  assert.equal(gateResult, undefined);
  assert.equal(fallback.confirmations.length, 0);
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
  assert.equal(prompt.systemPrompt, "base\n\nmode:active");
  const [userBash] = await harness.emit("user_bash", { type: "user_bash", command: "true", cwd: process.cwd() });
  assert.ok(userBash.operations);
  await userBash.operations.exec("true", process.cwd(), { onData: () => {} });
  assert.deepEqual(harness.skillUpdates[0], [{ filePath: "/tmp/SKILL.md", baseDir: "/tmp" }]);
  assert.deepEqual(harness.skillUpdates[1], []);
  assert.deepEqual(harness.allowedReads, []);
});
