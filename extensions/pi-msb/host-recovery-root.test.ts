import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "./config.ts";
import { createMsbIntegration } from "./control.ts";
import { registerSandboxTools } from "./tools.ts";
import type { Config } from "./types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: test.TestContext, layout: "symlink" | "directory") {
  const root = await realpath(await mkdtemp("/tmp/pi-msb-host-root-"));
  const original = join(root, "original"), replacement = join(root, "replacement"), parked = join(root, "parked");
  await mkdir(original); await mkdir(replacement);
  const cwd = layout === "symlink" ? join(root, "alias") : original;
  if (layout === "symlink") await symlink(original, cwd, "dir");
  let sdkLoads = 0;
  const integration = createMsbIntegration({ cwd, sessionId: "root-proof", configDirName: ".pi", agentDir: join(root, "agent"), env: {},
    sdkLoader: async () => { sdkLoads++; throw new Error("fixture VM unavailable; no SDK loaded"); },
    acquireOwnerLock: async () => ({ path: join(root, "owner"), release: async () => undefined }),
    locksPort: { tryAcquire: async () => ({ path: join(root, "lock"), release: async () => undefined }) },
  });
  t.after(async () => { integration.endSession(); await integration.manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  await integration.configureSession({ sessionId: "root-proof", cwd, projectTrusted: true,
    config: { config: { ...structuredClone(DEFAULT_CONFIG), autoStart: true, bootstrapTools: false, pruneOnStart: false } as Config, provenance: {}, warnings: [] } });
  assert.equal(integration.provider.getState().status, "unavailable");
  assert.equal(integration.provider.execution!.isReady(), true);
  assert.ok(integration.provider.hostExecutionToken!());
  const baselineSdkLoads = sdkLoads;
  const tools = new Map<string, any>(), handlers = new Map<string, (event: any, ctx: any) => any>();
  const prompts: string[] = [], prompted = deferred<void>();
  let answer: () => Promise<string | undefined> = async () => "Yes";
  const ctx = { cwd, mode: "rpc", hasUI: true,
    sessionManager: { getSessionId: () => "root-proof", getSessionFile: () => undefined },
    ui: { select: async (title: string, choices: string[]) => {
      prompts.push(title); assert.deepEqual(choices, ["No", "Yes"]); prompted.resolve(); return answer();
    } },
  } as unknown as ExtensionContext;
  const pi = { registerTool(tool: any) { tools.set(tool.name, tool); }, on(name: string, handler: any) { handlers.set(name, handler); } } as unknown as ExtensionAPI;
  registerSandboxTools(pi, { provider: integration.provider, config: integration.configRef.value, cwd,
    hostReads: { clear() {}, updateSkills() {}, resolve: async () => undefined, allowGeneratedFile: async () => undefined },
    createGrepExecute: () => async () => { throw new Error("ordinary routed execution must remain blocked"); },
    grepHelpers: { DEFAULT_MAX_BYTES: 1000, DEFAULT_MAX_LINES: 100, truncateHead: () => ({}), truncateLine: (text) => ({ text, wasTruncated: false }), formatSize: String },
    systemPromptNote: () => "",
  });
  const input = { command: "printf 'approved-root' > recovery-marker", timeout: 5, execution_target: "host" };
  const request = (id = "recovery") => handlers.get("tool_call")!({ toolName: "bash", toolCallId: id, input }, ctx);
  const execute = (id = "recovery") => tools.get("bash").execute(id, input, undefined, undefined, ctx);
  const replace = async () => {
    if (layout === "symlink") { await unlink(cwd); await symlink(replacement, cwd, "dir"); }
    else { await rename(original, parked); await rename(replacement, original); }
  };
  const restore = async () => {
    if (layout === "symlink") { await unlink(cwd); await symlink(original, cwd, "dir"); }
    else { await rename(original, replacement); await rename(parked, original); }
  };
  const noHostAction = async () => {
    for (const directory of [original, replacement, parked]) {
      await assert.rejects(access(join(directory, "recovery-marker")), { code: "ENOENT" });
    }
    assert.equal(sdkLoads, baselineSdkLoads, "root validation must not wake/load the SDK");
  };
  return { integration, tools, handlers, input, ctx, prompts, prompted, request, execute, replace, restore, noHostAction, original,
    setAnswer(next: () => Promise<string | undefined>) { answer = next; } };
}

for (const layout of ["symlink", "directory"] as const) {
  for (const when of ["before prompt", "during approval", "before execution"] as const) {
    test(`native recovery rejects ${layout} root replacement ${when} and never revives failed approval`, async (t) => {
      const f = await fixture(t, layout);
      if (when === "before prompt") await f.replace();
      if (when === "during approval") {
        const answer = deferred<string>(); f.setAnswer(() => answer.promise);
        const pending = f.request(); await f.prompted.promise;
        await f.replace(); answer.resolve("Yes");
        assert.equal((await pending).block, true);
      } else {
        const gate = await f.request();
        if (when === "before prompt") { assert.equal(gate.block, true); assert.equal(f.prompts.length, 0); }
        else { assert.equal(gate, undefined); await f.replace(); }
      }
      await assert.rejects(f.execute(), /canonical cwd|not approved/);
      await f.noHostAction();
      await f.restore();
      await assert.rejects(f.execute(), /not approved/);
      await f.noHostAction();
    });
  }

  test(`native recovery accepts unchanged ${layout} root with exact lexical cwd and one-shot approval`, async (t) => {
    const f = await fixture(t, layout);
    assert.equal(await f.request(), undefined);
    assert.ok(f.prompts[0]!.includes(`Working directory: ${f.ctx.cwd}`));
    assert.ok(f.prompts[0]!.includes(f.input.command));
    assert.doesNotMatch(f.prompts[0]!, /Timeout \(seconds\):/);
    await f.execute();
    assert.equal(await readFile(join(f.original, "recovery-marker"), "utf8"), "approved-root");
    await assert.rejects(f.execute(), /not approved/);
  });
}

test("native recovery fails closed for an unreadable/missing root before prompt without host action", async (t) => {
  const f = await fixture(t, "symlink");
  await unlink(f.ctx.cwd);
  assert.match((await f.request()).reason, /canonical cwd.*physical directory/);
  assert.equal(f.prompts.length, 0);
  await assert.rejects(f.execute(), /not approved/);
  await f.noHostAction();
});

test("native root proof does not bypass ordinary routing, noUI, denial, permission or readiness gates", async (t) => {
  const f = await fixture(t, "symlink");
  const ordinary = { toolName: "bash", toolCallId: "ordinary", input: { command: f.input.command } };
  assert.equal((await f.handlers.get("tool_call")!(ordinary, f.ctx)).block, true);
  await assert.rejects(f.tools.get("bash").execute("ordinary", ordinary.input, undefined, undefined, f.ctx), /unavailable/);
  for (const answer of ["No", undefined]) {
    f.setAnswer(async () => answer);
    assert.equal((await f.request()).block, true);
    await assert.rejects(f.execute(), /not approved/);
  }
  f.ctx.hasUI = false;
  assert.match((await f.request()).reason, /no interactive UI/);
  f.ctx.hasUI = true;
  f.integration.configRef.value.allowHostExecution = false;
  assert.match((await f.request()).reason, /Host execution is disabled/);
  f.integration.endSession();
  assert.equal((await f.request()).block, true);
  await f.noHostAction();
});

for (const when of ["before prompt", "during approval", "before execution"] as const) test(`native recovery keeps original symlink-root proof with stable outside cwd: ${when}`, async (t) => {
  const f = await fixture(t, "symlink");
  const outside = join(f.original, "..", "outside-target"); await mkdir(outside);
  Object.assign(f.input, { cwd: outside });
  if (when === "before prompt") await f.replace();
  if (when === "during approval") {
    const answer = deferred<string>(); f.setAnswer(() => answer.promise);
    const pending = f.request(); await f.prompted.promise;
    await f.replace(); answer.resolve("Yes"); assert.equal((await pending).block, true);
  } else {
    const gate = await f.request();
    if (when === "before prompt") { assert.equal(gate.block, true); assert.equal(f.prompts.length, 0); }
    else { assert.equal(gate, undefined); await f.replace(); }
  }
  await assert.rejects(f.execute(), /canonical cwd|not approved|trustworthy|directory/);
  await f.restore(); await assert.rejects(f.execute(), /not approved|trustworthy/);
  await assert.rejects(access(join(outside, "recovery-marker")), { code: "ENOENT" });
  await f.noHostAction();
});
