import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fakeSdk } from "../../test/fake-msb-sdk.ts";
import { DEFAULT_CONFIG, hostConfigPaths } from "./config.ts";
import { SettingsEditor } from "./settings.ts";
import type { MsbControl } from "./types.ts";
import { createMsbIntegration } from "./control.ts";
import { registerDiagnosticsTool } from "./diagnostics-tools.ts";
import { registerConfigTools } from "./settings-tools.ts";

test("blocked startup can be diagnosed and repaired through one approved tool invocation without host fallback", async (t) => {
  const root = await realpath(await mkdtemp("/tmp/pi-msb-diagnostic-repair-"));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const agentDir = join(root, "agent");
  const input = { cwd, agentDir, env: {}, projectTrusted: true, configDirName: ".pi" };
  const paths = await hostConfigPaths(input);
  await mkdir(dirname(paths.global), { recursive: true });
  const original = 'cpus = 0\nauto_start = true\nallow_host_execution = false\nbootstrap_tools = false\nprune_on_start = false\n[docker]\nmode = "disabled"\n';
  await writeFile(paths.global, original);
  let sdkLoads = 0, approvals = 0, answer = "No";
  const calls: string[] = [];
  const integration = createMsbIntegration({ ...input, sessionId: "repair",
    sdkLoader: async () => { sdkLoads++; return fakeSdk(calls); },
    acquireOwnerLock: async () => ({ path: join(root, "owner"), release: async () => undefined }),
    locksPort: { tryAcquire: async () => ({ path: join(root, "lock"), release: async () => undefined }) },
  });
  t.after(async () => { await integration.manager.shutdown(); integration.endSession(); await rm(root, { recursive: true, force: true }); });
  const tools = new Map<string, any>();
  const pi = { registerTool(tool: any) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
  registerConfigTools(pi, integration.control); registerDiagnosticsTool(pi, integration.control);
  const ctx = { cwd, mode: "rpc", hasUI: true,
    sessionManager: { getSessionId: () => "repair" },
    ui: { select: async (_question: string, options: string[]) => { approvals++; assert.deepEqual(options, ["No", "Yes"]); return answer; } },
  } as unknown as ExtensionContext;
  const run = (name: string, input: unknown) => tools.get(name).execute(name, input, undefined, undefined, ctx);
  await integration.configureSession({ sessionId: "repair", cwd, projectTrusted: true });
  assert.equal(integration.control.getState().status, "unavailable");
  const diagnostic = await run("msb_diagnostics", {});
  assert.equal(diagnostic.details.readOnly, true);
  assert.equal(diagnostic.details.failure.phase, "configuration_not_ready");
  assert.equal(sdkLoads, 0); assert.deepEqual(calls, []); assert.equal(approvals, 0);
  const inspected = await run("msb_config_get", {});
  assert.equal(inspected.details.recovery.available, true);
  assert.equal(inspected.details.desired, undefined);
  const request = { scope: "global", path: "cpus", operation: "set", value: 3 };
  assert.equal((await run("msb_config_set", request)).details.outcome, "cancelled");
  assert.equal(await readFile(paths.global, "utf8"), original); assert.equal(sdkLoads, 0);
  answer = "Yes";
  const repaired = await run("msb_config_set", request);
  assert.equal(repaired.details.outcome, "applied", JSON.stringify(repaired.details));
  assert.equal(repaired.details.saved, true); assert.equal(approvals, 2);
  assert.equal(integration.control.getState().status, "active"); assert.equal(sdkLoads, 1);
  assert.equal(integration.control.getEffectiveConfig().config.cpus, 3);
  assert.equal(integration.control.getEffectiveConfig().config.fallbackMode, "block");
  assert.equal(integration.control.getEffectiveConfig().config.allowHostExecution, false);
  const before = [...calls];
  assert.equal((await run("msb_diagnostics", {})).details.failure.phase, "none");
  assert.deepEqual(calls, before); assert.equal(approvals, 2);
});

test("CPU-only recovery discloses newly activated HOST policy and exact commands before any save or reload", async (t) => {
  const root = await realpath(await mkdtemp("/tmp/pi-msb-recovery-approval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const input = { cwd, agentDir: join(root, "agent"), env: {}, projectTrusted: true, configDirName: ".pi" };
  const paths = await hostConfigPaths(input); await mkdir(dirname(paths.global), { recursive: true });
  const credential = "RECOVERY_PRIVATE_CREDENTIAL";
  const command = `printf '${credential}'\nprintf suffix`;
  const original = `cpus = 0\nfallback_mode = "host"\nsecrets = [{ env = "CMD", host_cmd = ${JSON.stringify(command)}, allow_hosts = ["api.example.com"] }, { env = "LITERAL", text_value = "${credential}", allow_hosts = ["api.example.com"] }]\n`;
  await writeFile(paths.global, original);
  const editor = new SettingsEditor(input, "approval");
  let answer = "No", approvals = 0, reloads = 0;
  const control = { settings: editor, getState: () => ({ status: "unavailable", info: null }),
    getEffectiveConfig: () => ({ config: structuredClone(DEFAULT_CONFIG), provenance: {}, warnings: [] }),
    reload: async () => { reloads++; },
  } as unknown as MsbControl;
  const tools = new Map<string, any>();
  registerConfigTools({ registerTool(tool: any) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI, control);
  const ctx = { cwd, mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "approval" },
    ui: { select: async (question: string, options: string[]) => {
      approvals++; assert.deepEqual(options, ["No", "Yes"]);
      assert.match(question, /Recovery activation:/);
      assert.match(question, /host fallback|fallback.*host/i);
      assert.ok(question.includes(JSON.stringify(command)), "exact executable code must appear in the private human appendix");
      assert.equal(reloads, 0); return answer;
    } },
  } as unknown as ExtensionContext;
  const propose = () => tools.get("msb_config_set").execute("repair", { scope: "global", path: "cpus", operation: "set", value: 2 }, undefined, undefined, ctx);
  assert.equal((await propose()).details.outcome, "cancelled");
  assert.equal(await readFile(paths.global, "utf8"), original); assert.equal(reloads, 0);
  answer = "Yes";
  const applied = await propose();
  assert.equal(applied.details.outcome, "applied", JSON.stringify(applied.details));
  assert.equal(approvals, 2); assert.equal(reloads, 1);
  assert.ok(!JSON.stringify(applied).includes(credential), "private human disclosure must never enter model results");
});
