import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, hostConfigPaths, parseTomlConfig, resolveConfig, type ResolveConfigInput } from "./config.ts";
import { openControlPanel } from "./control-panel.ts";
import { createMsbIntegration } from "./control.ts";
import { fakeSdk } from "../../test/fake-msb-sdk.ts";
import { registerConfigTools } from "./settings-tools.ts";
import { formatSettingsDiff, settingsDiff } from "./settings-diff.ts";
import type { SettingsSanitizer } from "./settings-redaction.ts";
import { SettingsEditor, SETTINGS_PATHS } from "./settings.ts";
import type { MsbControl, ResolvedConfig, RuntimePolicySnapshot } from "./types.ts";

async function fixture(t: TestContext, missing = false) {
  const root = await realpath(await mkdtemp("/tmp/msb-config-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const input: ResolveConfigInput = { cwd, agentDir: join(root, "agent"), homedir: join(root, "home"), env: {}, projectTrusted: true, configDirName: ".pi" };
  await mkdir(input.homedir!);
  const paths = await hostConfigPaths(input);
  if (!missing) { await mkdir(dirname(paths.project), { recursive: true }); await writeFile(paths.global, "auto_start = false\n"); }
  const editor = new SettingsEditor(input, "one");
  const tools = new Map<string, ToolDefinition>();
  let reloads = 0; let failReload = false; let adopted: RuntimePolicySnapshot | undefined;
  let resolved: ResolvedConfig = await resolveConfig(input);
  const control: MsbControl = {
    settings: editor, getState: () => ({ status: "off", info: null }), getRuntimePolicy: () => adopted,
    getEffectiveConfig: () => resolved, getEffectiveConfigToml: () => "",
    previewSettings: (draft) => draft.preview(resolved.config),
    reload: async (options) => { reloads++; await options?.guard?.(); if (failReload) throw new Error("FAILURE_PRIVATE_SENTINEL $ENV:HIDDEN $FILE:/private/reference"); resolved = await resolveConfig({ ...input, temporaryOverrides: editor.temporary() }); },
    setEnabled: async () => {}, pruneNow: async () => ({ inspected: 0, removed: [], kept: [], errors: [] }), getLogs: async () => "",
    setOverride: async () => {}, unsetOverride: async () => {}, resetOverrides: async () => {},
  };
  registerConfigTools({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI, control);
  let id = "one";
  const reviews: string[] = [];
  let select: (title: string, options: string[], signal?: AbortSignal) => Promise<string | undefined> = async () => "Yes";
  const ctx = { hasUI: true, mode: "rpc", cwd, sessionManager: { getSessionId: () => id }, ui: { select: async (title: string, options: string[], opts: { signal?: AbortSignal }) => {
    reviews.push(title); assert.deepEqual(options, ["No", "Yes"]); return select(title, options, opts.signal);
  } } } as unknown as ExtensionContext;
  const call = async (params: unknown, signal?: AbortSignal) => tools.get("msb_config_set")!.execute("id", params as any, signal, undefined, ctx) as Promise<{ details: any; content: any[] }>;
  const get = async () => tools.get("msb_config_get")!.execute("get", {}, undefined, undefined, ctx) as Promise<{ details: any; content: any[] }>;
  return { root, cwd, input, paths, editor, control, tools, ctx, reviews, call, get, reloads: () => reloads, failReload: () => { failReload = true; },
    choose: (callback: typeof select) => { select = callback; }, switchContext: () => { id = "two"; }, adopt: (policy: RuntimePolicySnapshot) => { adopted = policy; } };
}
const set = (scope = "session", path = "show_footer", value: unknown = false) => ({ scope, path, operation: "set", value });
const noPrivate = (value: unknown) => assert.doesNotMatch(JSON.stringify(value), /PRIVATE_SENTINEL|\$ENV:|\$FILE:|\/private\/reference|UNRECOGNIZED_RAW_VALUE/);

test("msb_config_get: complete JSON inventory, raw layers, origins and headless read without bootstrap", async (t) => {
  const f = await fixture(t, true); f.ctx.hasUI = false;
  const got = await f.get();
  assert.equal(got.details.outcome, "inspected");
  assert.deepEqual(got.details.supportedPaths, SETTINGS_PATHS);
  for (const path of SETTINGS_PATHS) {
    const leaf = path.split(".").reduce((value, key) => value?.[key], got.details.desired);
    assert.notEqual(leaf, undefined, path);
    assert.ok(got.details.origins[path]);
  }
  assert.deepEqual(got.details.layers, { global: {}, project: {}, session: {} });
  assert.equal(got.details.desired.sandbox_name, null);
  assert.equal(got.details.runtime.adopted, null);
  assert.equal(f.reloads(), 0); assert.equal(f.reviews.length, 0); assert.deepEqual(f.editor.temporary(), {});
  await assert.rejects(stat(f.input.agentDir!), { code: "ENOENT" });
});

test("msb_config_get: all layers and default/environment/legacy provenance remain distinct from adoption", async (t) => {
  const f = await fixture(t);
  f.input.env!.PI_MSB_MEMORY_MIB = "2048";
  const legacy = join(f.input.homedir!, ".config/pi-msb/config.toml"); await mkdir(dirname(legacy), { recursive: true }); await writeFile(legacy, "cpus = 3\n");
  await writeFile(f.paths.project, "cpus = 4\n");
  const temp = await f.editor.open("temporary"); temp.set("show_footer", false); await temp.apply();
  f.adopt({ effectiveToml: "cpus = 1\n", knownFields: ["cpus"], verification: "reconnected", provenance: { cpus: "defaults" }, automaticSandboxName: false, adoptedAt: 1 });
  f.control.getAgentRuntimePolicy = () => ({ settings: { cpus: 1 }, knownFields: ["cpus"], provenance: { cpus: "defaults" }, verification: "reconnected", adoptedAt: 1 });
  const { details } = await f.get();
  assert.equal(details.desired.cpus, 4); assert.equal(details.origins.cpus, "host-project");
  assert.equal(details.origins.memory_mib, "env"); assert.equal(details.origins.image, "defaults");
  assert.equal(details.layers.project.cpus, 4); assert.equal(details.layers.session.show_footer, false);
  assert.deepEqual(details.runtime.adopted.settings, { cpus: 1 });
});

test("msb_config_get and reviews: mask literals/ENV/FILE, unknown raw data, errors and every serialized channel", async (t) => {
  const f = await fixture(t);
  await writeFile(join(dirname(f.paths.global), "credential"), "RESOLVED_PRIVATE_SENTINEL");
  await writeFile(f.paths.global, `auto_start = false
unknown_field = { body = "UNRECOGNIZED_RAW_VALUE", value = "UNKNOWN_PRIVATE_SENTINEL" }
secrets = [{ env = "A", value = "LITERAL_PRIVATE_SENTINEL", allow_hosts = ["a.example"], unknown = "UNRECOGNIZED_RAW_VALUE" }, { env = "B", value = "$ENV:ENV_PRIVATE_SENTINEL", allow_hosts = ["b.example"] }, { env = "C", value = "$FILE:credential", allow_hosts = ["c.example"] }]
`);
  f.input.env!.ENV_PRIVATE_SENTINEL = "RESOLVED_PRIVATE_SENTINEL";
  const got = await f.get(); noPrivate(got); assert.ok(got.details.warnings.length);
  assert.equal(got.details.layers.global.secrets[0].value, "<redacted>");
  assert.equal("unknown_field" in got.details.layers.global, false);
  const changed = await f.call({ scope: "project", path: "secrets", operation: "upsert", value: { env: "A", allowHosts: ["new.example"] } });
  assert.equal(changed.details.outcome, "applied"); noPrivate(changed); noPrivate(f.reviews);
  f.failReload(); const failed = await f.call(set("session", "allow_host_execution", true));
  assert.equal(failed.details.outcome, "saved_but_reload_failed"); noPrivate(failed);
  await writeFile(f.paths.project, 'cpus = "INVALID_PRIVATE_SENTINEL"\n');
  noPrivate(await f.get()); assert.equal((await f.get()).details.outcome, "rejected");
});

test("msb_config_set: exact one scope/operation schema; invalid, removed and unsafe proposals cannot review or mutate", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((f.tools.get("msb_config_set")!.parameters as any).properties.scope.anyOf.map((item: any) => item.const), ["session", "project", "global"]);
  const invalid = [set("ephemeral"), set("temporary"), set("Session"), set("workspace"), set("session", "host_ro_allowlist", []), set("session", "cpus.foo", 1), set("session", "network", {}), set("project", "sandbox_name", null), set("session", "cpus", 0), set("session", "cpus", {}),
    { ...set(), auto_approve: true }, { ...set(), file: "/tmp/forbidden" }, { ...set(), identity: "unexpected" }, { ...set(), previousIdentity: "unexpected" }, { ...set(), operations: [] },
    { scope: "session", path: "cpus", operation: "remove", identity: "a" },
    { scope: "project", path: "secrets", operation: "upsert", value: { env: "A", allowHosts: ["a.example"], value: "<redacted>" } },
    { scope: "project", path: "secrets", operation: "upsert", value: { env: "A", allowHosts: ["a.example"], value: "$ENV:[REDACTED]" } },
    set("global", "secrets", [{ env: "A", allowHosts: ["a.example"], value: "LITERAL_PRIVATE_SENTINEL", unknown: true }]),
  ];
  for (const proposal of invalid) assert.equal((await f.call(proposal)).details.outcome, "rejected", JSON.stringify(proposal));
  assert.equal(f.reviews.length, 0); assert.equal(f.reloads(), 0); assert.deepEqual(f.editor.temporary(), {});
  assert.equal(await readFile(f.paths.global, "utf8"), "auto_start = false\n");
});

test("msb_config_set: distinct No-first approval for every invocation, including no-op and inherit", async (t) => {
  const f = await fixture(t);
  f.choose(async () => undefined); assert.equal((await f.call(set())).details.outcome, "cancelled");
  f.choose(async () => "No"); assert.equal((await f.call(set())).details.outcome, "cancelled");
  assert.deepEqual(f.editor.temporary(), {}); assert.equal(f.reloads(), 0);
  f.choose(async () => "Yes"); assert.equal((await f.call(set())).details.outcome, "applied");
  assert.equal((await f.call(set())).details.outcome, "no_op");
  assert.equal((await f.call({ scope: "project", path: "cpus", operation: "inherit" })).details.outcome, "no_op");
  assert.equal(f.reviews.length, 5); assert.equal(f.reloads(), 1);
});

test("msb_config_set: no UI and abort before/during/after review never mutate", async (t) => {
  const f = await fixture(t); f.ctx.hasUI = false;
  assert.equal((await f.call(set())).details.outcome, "rejected"); f.ctx.hasUI = true;
  const prior = AbortSignal.abort(); assert.equal((await f.call(set(), prior)).details.outcome, "cancelled");
  const controller = new AbortController();
  f.choose(async (_title, _options, signal) => { assert.equal(signal?.aborted, false); controller.abort(); return "Yes"; });
  assert.equal((await f.call(set(), controller.signal)).details.outcome, "cancelled");
  f.choose(async () => { throw new Error("PRIVATE_SENTINEL"); }); noPrivate(await f.call(set()));
  assert.deepEqual(f.editor.temporary(), {}); assert.equal(f.reloads(), 0);
});

for (const race of ["target", "other-file", "same-content-file", "Session settings", "session", "context", "environment"] as const) {
  test(`msb_config_set: approval-bound ${race} race conflicts/cancels without retry`, async (t) => {
    const f = await fixture(t);
    f.choose(async (_title, _options, signal) => {
      if (race === "target") await writeFile(f.paths.project, "memory_mib = 4096\n");
      if (race === "other-file") await writeFile(f.paths.global, "auto_start = false\nblock_third_party = false\n");
      if (race === "same-content-file") await writeFile(f.paths.global, await readFile(f.paths.global, "utf8"));
      if (race === "Session settings") { const d = await f.editor.open("temporary"); d.set("cpus", 2); await d.apply(); }
      if (race === "session") { f.editor.endSession(); assert.equal(signal?.aborted, true); }
      if (race === "context") f.switchContext();
      if (race === "environment") f.input.env!.PI_MSB_CPUS = "2";
      return "Yes";
    });
    const got = await f.call(set("project"));
    assert.ok(["conflict", "cancelled"].includes(got.details.outcome), JSON.stringify(got.details));
    assert.equal(f.reviews.length, 1); assert.equal(f.reloads(), 0);
    const text = await readFile(f.paths.project, "utf8").catch(() => ""); assert.doesNotMatch(text, /show_footer/);
  });
}

test("msb_config_set: shared modal lease rejects concurrent tools/panel without replacing the pending proposal", async (t) => {
  const f = await fixture(t);
  let started!: () => void; let approve!: (value: string) => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  f.choose(async () => { started(); return new Promise((resolve) => { approve = resolve; }); });
  const first = f.call(set()); await ready;
  assert.equal((await f.call(set("global"))).details.outcome, "rejected");
  await assert.rejects(openControlPanel({ ui: { custom: async () => { throw new Error("must not open"); } }, waitForIdle: async () => {} } as any, f.control));
  approve("Yes"); assert.equal((await first).details.outcome, "applied"); assert.equal(f.reviews.length, 1);
  const lease = f.editor.acquireInteraction()!;
  assert.equal((await f.call(set("global"))).details.outcome, "rejected"); lease.release();
});

for (const scope of ["global", "project", "session"]) {
  test(`msb_config_set: ${scope} sparse scalar/entry/inherit isolation and credential retention`, async (t) => {
    const f = await fixture(t);
    await writeFile(f.paths.global, 'auto_start = false\ncpus = 3\nunknown = "UNRECOGNIZED_RAW_VALUE"\nsecrets = [{env="GLOBAL",value="$ENV:G",allow_hosts=["g.example"]}]\n');
    await writeFile(f.paths.project, 'memory_mib = 4096\nsecrets = [{env="PROJECT",value="$ENV:P",allow_hosts=["p.example"]}]\n');
    const temp = await f.editor.open("temporary"); temp.upsertSecret({ env: "TEMP", value: "$ENV:T", allowHosts: ["t.example"] }); await temp.apply();
    const globalBefore = await readFile(f.paths.global, "utf8"); const projectBefore = await readFile(f.paths.project, "utf8");
    const own = scope === "global" ? "GLOBAL" : scope === "project" ? "PROJECT" : "TEMP";
    const got = await f.call({ scope, path: "secrets", operation: "upsert", value: { env: own, allowHosts: ["new.example"] } });
    assert.equal(got.details.outcome, "applied", JSON.stringify(got.details)); noPrivate(got);
    assert.equal(got.details.review.scope, scope);
    const label = scope[0]!.toUpperCase() + scope.slice(1);
    assert.ok(f.reviews.at(-1)!.split("\n").includes(`Scope: ${label}`));
    assert.ok(got.content[0].text.split("\n").includes(`Scope: ${label}`));
    const layer = scope === "session" ? f.editor.temporary() : parseTomlConfig(await readFile(f.paths[scope as "global" | "project"], "utf8"), "global").value;
    const names = layer.secrets!.map((secret) => secret.env);
    assert.equal(names.includes("TEMP"), scope === "session");
    if (scope === "global") { assert.deepEqual(names, ["GLOBAL"]); assert.match(await readFile(f.paths.global, "utf8"), /UNRECOGNIZED_RAW_VALUE/); }
    if (scope === "project") assert.deepEqual(names, ["PROJECT"]);
    assert.equal(layer.secrets!.find((secret) => secret.env === own)!.value, `$ENV:${own[0]}`);
    if (scope !== "global") assert.equal(await readFile(f.paths.global, "utf8"), globalBefore);
    if (scope !== "project") assert.equal(await readFile(f.paths.project, "utf8"), projectBefore);
    assert.equal((await f.call({ scope, path: "secrets", operation: "remove", identity: own })).details.outcome, "applied");
    assert.equal((await f.call(set(scope, "show_footer", false))).details.outcome, "applied");
    assert.equal((await f.call({ scope, path: "show_footer", operation: "inherit" })).details.outcome, "applied");
  });
}

test("msb_config_set: native scalar lists, rename, whole-list replacement/clear and HOST boundary warnings", async (t) => {
  const f = await fixture(t);
  for (const proposal of [
    { scope: "project", path: "pass_through_tools", operation: "upsert", value: "trusted" },
    { scope: "project", path: "pass_through_tools", operation: "upsert", value: "renamed", previousIdentity: "trusted" },
    { scope: "project", path: "pass_through_tools", operation: "remove", identity: "renamed" },
    set("project", "pass_through_tools", ["replace"]), set("project", "pass_through_tools", []), set("session", "block_third_party", false),
  ]) assert.equal((await f.call(proposal)).details.outcome, "applied");
  for (const title of f.reviews) {
    assert.match(title, /HOST/); assert.match(title, /without per-call host approval/);
    assert.equal(title.includes("These tools run"), !title.includes("Unrecognized tools"));
  }
  assert.match(f.reviews[3]!, /Replaces this scope’s entire list/);
  assert.match(f.reviews[4]!, /Clears this scope’s entire list/);
});

for (const [path, before, after, condition] of [
  ["allow_host_execution", true, false, /When enabled:.*HOST execution/],
  ["block_third_party", false, true, /When disabled:.*HOST without per-call host approval/],
] as const) test(`compact review: tightening ${path} qualifies its HOST warning`, async (t) => {
  const f = await fixture(t);
  await writeFile(f.paths.project, `${path} = ${JSON.stringify(before)}\n`);
  const got = await f.call(set("project", path, after));
  assert.equal(got.details.outcome, "applied");
  assert.match(f.reviews.at(-1)!, condition);
});

test("msb_config_set: mount native CRUD retains canonical workspace/symlink/protected-guest safety", async (t) => {
  const f = await fixture(t);
  const data = join(f.root, "data"); await mkdir(data);
  const mount = { type: "dir", hostPath: data, guestPath: "/mnt/data", readonly: true, options: [] };
  assert.equal((await f.call({ scope: "project", path: "mounts", operation: "upsert", value: mount })).details.outcome, "applied");
  assert.equal((await f.call({ scope: "project", path: "mounts", operation: "remove", identity: "/mnt/data/" })).details.outcome, "applied");
  for (const hostPath of [f.input.agentDir!]) {
    const proposal = { scope: "project", path: "mounts", operation: "upsert", value: { ...mount, hostPath, readonly: false } };
    assert.equal((await f.call(proposal)).details.outcome, "rejected");
  }
  assert.equal((await f.call({ scope: "project", path: "mounts", operation: "upsert", value: { ...mount, guestPath: f.cwd } })).details.outcome, "rejected");
  const linked = join(f.root, "linked"); await symlink(f.input.agentDir!, linked);
  assert.equal((await f.call({ scope: "project", path: "mounts", operation: "upsert", value: { ...mount, hostPath: linked, readonly: false } })).details.outcome, "rejected");
  assert.equal((await f.call({ scope: "project", path: "mounts", operation: "upsert", value: { ...mount, guestPath: "/tmp" } })).details.outcome, "rejected");
});

test("msb_config_set: reload failure is saved, never success; post-commit external change prevents activation", async (t) => {
  const f = await fixture(t); f.failReload();
  const got = await f.call(set("project"));
  assert.equal(got.details.outcome, "saved_but_reload_failed"); assert.equal(got.details.saved, true); assert.equal(got.details.reloaded, false); noPrivate(got);
  assert.equal(parseTomlConfig(await readFile(f.paths.project, "utf8"), "global").value.showFooter, false);
  let activated = false;
  f.control.reload = async (options) => { await writeFile(f.paths.global, "block_third_party = false\n"); await options?.guard?.(); activated = true; };
  assert.equal((await f.call(set("project", "show_footer", true))).details.outcome, "saved_but_reload_failed"); assert.equal(activated, false);
});

test("msb_config_set: real controller reconciliation, no bootstrap outside selected scope, disabled-runtime outcome", async (t) => {
  const f = await fixture(t); execFileSync("git", ["init", "-q", f.cwd]);
  let boots = 0;
  const env: NodeJS.ProcessEnv = { PI_MSB_AUTO_START: "false" };
  const integration = createMsbIntegration({ sessionId: "one", cwd: f.cwd, agentDir: f.input.agentDir, configDirName: ".pi", env,
    sdkLoader: async () => { boots++; throw new Error("no VM"); } });
  await integration.configureSession({ sessionId: "one", cwd: f.cwd, projectTrusted: true });
  await rm(f.paths.global);
  const tools = new Map<string, ToolDefinition>();
  registerConfigTools({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI, integration.control);
  const call = (params: any) => tools.get("msb_config_set")!.execute("real", params, undefined, undefined, f.ctx) as Promise<{ details: any }>;
  assert.equal((await call(set())).details.outcome, "applied");
  await assert.rejects(stat(f.paths.global), { code: "ENOENT" }); assert.equal(boots, 0);
  env.PI_MSB_DISABLE = "1";
  assert.equal((await call(set("project"))).details.outcome, "saved_but_reload_failed"); assert.equal(boots, 0);
});

test("msb_config_set: proposed mount/FILE canonical identities are bound to the approved candidate too", async (t) => {
  for (const kind of ["mount", "secret"] as const) {
    const f = await fixture(t);
    const first = join(f.root, "first"); const second = join(f.root, "second"); const alias = join(f.root, "alias");
    if (kind === "mount") { await mkdir(first); await mkdir(second); }
    else { await writeFile(first, "FIRST_PRIVATE_SENTINEL"); await writeFile(second, "SECOND_PRIVATE_SENTINEL"); }
    await symlink(first, alias);
    f.choose(async () => { await rm(alias); await symlink(second, alias); return "Yes"; });
    const proposal = kind === "mount"
      ? { scope: "project", path: "mounts", operation: "upsert", value: { type: "dir", hostPath: alias, guestPath: "/mnt/data", readonly: true, options: [] } }
      : { scope: "project", path: "secrets", operation: "upsert", value: { env: "TOKEN", value: `$FILE:${alias}`, allowHosts: ["a.example"] } };
    const got = await f.call(proposal);
    assert.equal(got.details.outcome, "conflict"); noPrivate(got); noPrivate(f.reviews);
    assert.equal(f.reloads(), 0); await assert.rejects(stat(f.paths.project), { code: "ENOENT" });
  }
});


function assertPrivateChannels(value: { content: unknown; details: unknown }, forbidden: string[]): void {
  for (const channel of [value.content, value.details]) for (const secret of forbidden) {
    assert.equal(JSON.stringify(channel).includes(secret), false, `credential exposed in serialized channel: ${secret}`);
  }
}

for (const valueKey of ["value", "VALUE"] as const) for (const source of ["global", "project", "legacy", "environment", "cli"] as const) {
  for (const kind of ["literal", "ENV", "FILE"] as const) {
    test(`privacy: hidden ${source} ${kind} ${valueKey} credentials mask approval, applied/no-op results and readonly inspection`, async (t) => {
      const f = await fixture(t);
      const identifier = kind === "literal" ? "AbcPrivateCredential123" : kind === "ENV" ? "PrivateEnvReference123" : "PrivateFileReference123";
      const credential = kind === "literal" ? identifier : `$${kind}:${identifier}`;
      const raw = `secrets = [{ env = "TOKEN", ${valueKey} = ${JSON.stringify(credential)}, allow_hosts = ["api.example"] }]\n${JSON.stringify(identifier)} = true\n`;
      const legacy = join(f.input.homedir!, ".config/pi-msb/config.toml");
      let target: "global" | "project" = "project";
      if (source === "environment") {
        f.input.env!.PI_MSB_SECRETS = JSON.stringify([{ env: "TOKEN", [valueKey]: credential, allowHosts: ["api.example"] }]);
        f.input.env![`PI_MSB_${identifier}`] = "true";
      } else if (source === "cli") f.input.cliOverridesToml = raw;
      else {
        const path = source === "legacy" ? legacy : f.paths[source];
        await mkdir(dirname(path), { recursive: true });
        if (kind === "FILE") await writeFile(join(dirname(path), identifier), "RESOLVED_FILE_BYTES_PRIVATE");
        await writeFile(path, raw);
      }
      if (source === "project") {
        target = "global";
        const temporary = await f.editor.open("temporary"); temporary.set("secrets", []); await temporary.apply();
      } else await writeFile(f.paths.project, "secrets = []\n");
      const forbidden = [identifier, credential, "RESOLVED_FILE_BYTES_PRIVATE"];
      const initial = await f.get(); assert.equal(initial.details.outcome, "inspected"); assertPrivateChannels(initial, forbidden);
      const applied = await f.call(set(target)); assert.equal(applied.details.outcome, "applied"); assertPrivateChannels(applied, forbidden);
      const noOp = await f.call(set(target)); assert.equal(noOp.details.outcome, "no_op"); assertPrivateChannels(noOp, forbidden);
      for (const title of f.reviews) for (const secret of forbidden) assert.equal(title.includes(secret), false);
      const after = await f.get(); assert.equal(after.details.outcome, "inspected"); assertPrivateChannels(after, forbidden);
      assert.ok(applied.details.review.warnings.some((warning: string) => warning.includes("<redacted>")));
      assert.ok(Object.keys(applied.details.review.provenance).some((key) => key.includes("<redacted>")));
    });
  }
}

for (const valueKey of ["value", "VALUE"] as const) test(`privacy: historical real masked adoption keeps literal and bare ENV/FILE identifiers private after desired ${valueKey} sources disappear`, async (t) => {
  const f = await fixture(t);
  const literal = "AbcPrivateCredential123"; const envReference = "PrivateAdoptedEnv123"; const fileReference = "PrivateAdoptedFile123";
  const hidden = "PrivateShadowedAdoption123";
  const env: NodeJS.ProcessEnv = { HOME: f.input.homedir, [envReference]: "RESOLVED_ENV_BYTES_PRIVATE" };
  const legacy = join(f.input.homedir!, ".config/pi-msb/config.toml");
  await mkdir(dirname(legacy), { recursive: true });
  await writeFile(legacy, `secrets = [{env="HIDDEN",${valueKey}="${hidden}",allow_hosts=["api.example"]}]\n`);
  await writeFile(join(dirname(f.paths.global), fileReference), "RESOLVED_FILE_BYTES_PRIVATE");
  await writeFile(f.paths.global, `auto_start = true\nprune_on_start = false\nbootstrap_tools = false\nimage = "${hidden}-image"\n[docker]\nmode = "disabled"\n` +
    `[[secrets]]\nenv = "LITERAL_TOKEN"\n${valueKey} = "${literal}"\nallow_hosts = ["${literal}.example"]\n` +
    `[[secrets]]\nenv = "ENV_TOKEN"\n${valueKey} = "$ENV:${envReference}"\nallow_hosts = ["${envReference}.example"]\n` +
    `[[secrets]]\nenv = "FILE_TOKEN"\n${valueKey} = "$FILE:${fileReference}"\nallow_hosts = ["${fileReference}.example"]\n`);
  const sdk = fakeSdk([]);
  const integration = createMsbIntegration({ sessionId: "one", cwd: f.cwd, agentDir: f.input.agentDir, configDirName: ".pi", env,
    sdkLoader: async () => sdk, acquireOwnerLock: async () => ({ path: join(f.root, "owner.lock"), release: async () => {} }) });
  t.after(async () => { integration.endSession(); await integration.manager.shutdown(); });
  assert.equal((await integration.configureSession({ sessionId: "one", cwd: f.cwd, projectTrusted: true })).status, "active");
  const maskedPanelSnapshot = integration.control.getRuntimePolicy!()!;
  const maskedPanelConfig = parseTomlConfig(maskedPanelSnapshot.effectiveToml, "global").value;
  // Native panel snapshots deliberately mask only value; regression must not supply an unmasked mock.
  assert.ok(maskedPanelConfig.secrets!.every((secret) => secret.value === "<redacted>"));
  assert.ok(maskedPanelSnapshot.effectiveToml.includes(literal));
  assert.ok(maskedPanelSnapshot.effectiveToml.includes(envReference));
  assert.ok(maskedPanelSnapshot.effectiveToml.includes(fileReference));
  const safeAdoption = integration.control.getAgentRuntimePolicy!()!;
  const forbidden = [literal, envReference, fileReference, hidden, `$ENV:${envReference}`, `$FILE:${fileReference}`, "RESOLVED_ENV_BYTES_PRIVATE", "RESOLVED_FILE_BYTES_PRIVATE"];
  for (const secret of forbidden) assert.equal(JSON.stringify(safeAdoption).includes(secret), false);
  assert.deepEqual(safeAdoption.knownFields, maskedPanelSnapshot.knownFields);
  assert.deepEqual(safeAdoption.provenance, maskedPanelSnapshot.provenance);
  assert.equal(safeAdoption.verification, maskedPanelSnapshot.verification);
  assert.equal(safeAdoption.adoptedAt, maskedPanelSnapshot.adoptedAt);
  assert.equal(safeAdoption.settings.sandbox_name, null);
  // A valid new resolution followed by failed activation must not replace successful adoption privacy state.
  await writeFile(legacy, "cpus = 4\n");
  await writeFile(f.paths.global, 'auto_start = false\nimage = "new-clean-image"\n');
  delete env[envReference];
  const builder = sdk.Sandbox.builder;
  sdk.Sandbox.builder = () => { throw new Error("synthetic activation failure"); };
  await assert.rejects(integration.control.reload());
  sdk.Sandbox.builder = builder;
  assert.deepEqual(integration.control.getAgentRuntimePolicy!(), safeAdoption);
  assert.deepEqual(integration.control.getRuntimePolicy!(), maskedPanelSnapshot);
  await integration.control.setEnabled(false); await integration.control.reload();
  assert.deepEqual(integration.control.getEffectiveConfig().config.secrets, []);
  for (const secret of forbidden) assert.equal(JSON.stringify(integration.control.getEffectiveConfig()).includes(secret), false);
  assert.deepEqual(integration.control.getAgentRuntimePolicy!(), safeAdoption);
  const tools = new Map<string, ToolDefinition>();
  registerConfigTools({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI, integration.control);
  const get = () => tools.get("msb_config_get")!.execute("get", {}, undefined, undefined, f.ctx) as Promise<{ content: any; details: any }>;
  const call = () => tools.get("msb_config_set")!.execute("set", set("project"), undefined, undefined, f.ctx) as Promise<{ content: any; details: any }>;
  const inspected = await get(); assert.equal(inspected.details.outcome, "inspected"); assertPrivateChannels(inspected, forbidden);
  const applied = await call(); assert.equal(applied.details.outcome, "applied"); assertPrivateChannels(applied, forbidden);
  const noOp = await call(); assert.equal(noOp.details.outcome, "no_op"); assertPrivateChannels(noOp, forbidden);
  assert.ok(applied.details.review.adoptedRuntime.adopted);
  for (const title of f.reviews) for (const secret of forbidden) assert.equal(title.includes(secret), false);
});

test("privacy: legacy masked runtime adapters without a safe adoption accessor expose no unprovable values", async (t) => {
  const f = await fixture(t);
  f.adopt({ effectiveToml: 'secrets = [{ env="TOKEN", value="<redacted>", allow_hosts=["AbcPrivateCredential123.example"] }]\n',
    knownFields: ["secrets"], provenance: { secrets: "host-default" }, verification: "created", automaticSandboxName: true, adoptedAt: 1 });
  assert.equal(f.control.getAgentRuntimePolicy, undefined);
  const inspected = await f.get(); assert.equal(inspected.details.runtime.adopted, null);
  const applied = await f.call(set("project")); const noOp = await f.call(set("project"));
  assert.equal(applied.details.outcome, "applied"); assert.equal(noOp.details.outcome, "no_op");
  for (const result of [inspected, applied, noOp]) assertPrivateChannels(result, ["AbcPrivateCredential123"]);
  for (const title of f.reviews) assert.equal(title.includes("AbcPrivateCredential123"), false);
});


test("privacy: resolver sanitizer capture changes no reads/output and runs only after successful resolution", async (t) => {
  const f = await fixture(t);
  const reference = "PrivateResolverFile123";
  const bytes = "UNREAD_FILE_CREDENTIAL_BYTES";
  const secretFile = join(dirname(f.paths.global), reference);
  await writeFile(secretFile, bytes);
  await writeFile(f.paths.global, `secrets = [{env="TOKEN",value="$FILE:${reference}",allow_hosts=["api.example"]}]\n`);
  const reads: string[] = [];
  const read = async (path: string) => {
    reads.push(path);
    assert.notEqual(path, secretFile, "redactor capture must never read credential bytes");
    return readFile(path, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  };
  const normal = await resolveConfig({ ...f.input, readFile: read }); const normalReads = [...reads]; reads.length = 0;
  let sanitize: SettingsSanitizer | undefined;
  const captured = await resolveConfig({ ...f.input, readFile: read }, (value) => { sanitize = value; });
  assert.deepEqual(captured, normal); assert.deepEqual(reads, normalReads);
  assert.deepEqual(Object.keys(captured), ["config", "provenance", "warnings"]);
  assert.equal(typeof sanitize, "function");
  assert.deepEqual(sanitize!({ value: "PRIVATE_LOWERCASE", VALUE: "PRIVATE_UPPERCASE" }), { value: "<redacted>", VALUE: "<redacted>" });
  assert.equal(sanitize!({ note: `${reference}.example`, descriptor: `$FILE:${reference}` }).note, "<redacted>.example");
  await writeFile(f.paths.global, 'cpus = "invalid"\n');
  let callbacks = 0;
  await assert.rejects(resolveConfig(f.input, () => { callbacks++; })); assert.equal(callbacks, 0);
});

test("compact review: secret host edit includes only selected entry and changed hosts; rotation stays visibly masked", async (t) => {
  const f = await fixture(t);
  await writeFile(f.paths.global, 'auto_start = false\nsecrets = [{env="TOKEN",value="$ENV:PRIVATE_SENTINEL",allow_hosts=["keep.example","old.example"]}, {env="UNRELATED",value="OTHER_PRIVATE_SENTINEL",allow_hosts=["unrelated.example"]}]\n');
  const edit = { scope: "global", path: "secrets", operation: "upsert", value: { env: "TOKEN", allowHosts: ["keep.example", "new.example"] } };
  const changed = await f.call(edit);
  const text = f.reviews.at(-1)!;
  assert.match(text, /Scope: Global\nSecret TOKEN/);
  assert.equal(text.split("\n").filter((line) => line.includes("TOKEN")).length, 1);
  assert.doesNotMatch(text, /Target:|upsert|Entry source|explicit/);
  assert.match(text, /- Hosts: old.example\n\+ Hosts: new.example/);
  assert.doesNotMatch(text, /keep.example|UNRELATED|unrelated.example|Credential|HOST|block_third_party|desired|provenance|adoptedRuntime|"before"|"after"/);
  assert.doesNotMatch(changed.content[0].text, /UNRELATED|keep.example|provenance|adoptedRuntime/);
  assert.doesNotMatch(text, /\x1b/); noPrivate(changed); noPrivate(text);
  assert.equal((await f.call(edit)).details.outcome, "no_op");
  assert.match(f.reviews.at(-1)!, /No change/); assert.doesNotMatch(f.reviews.at(-1)!, /Credential|changed\)/);
  const reference = `$FILE:${join(f.root, "ROTATED_PRIVATE_SENTINEL")}`;
  await writeFile(reference.slice(6), "ROTATED_BYTES_PRIVATE_SENTINEL");
  const rotated = await f.call({ ...edit, value: { ...edit.value, value: reference } });
  assert.equal(rotated.details.outcome, "applied"); noPrivate(rotated);
  assert.match(f.reviews.at(-1)!, /- Credential: <redacted>\n\+ Credential: <redacted> \(changed\)/);
  assert.doesNotMatch(f.reviews.at(-1)!, /Hosts|keep.example|old.example|new.example|UNRELATED/);
  assert.equal((await f.call({ ...edit, value: { ...edit.value, value: reference } })).details.outcome, "no_op");
  assert.doesNotMatch(f.reviews.at(-1)!, /Credential/);
});

test("compact review: shadowed target baseline and retained higher-scope credential promotion are truthful", async (t) => {
  const f = await fixture(t);
  await writeFile(f.paths.global, 'auto_start = false\nsecrets = [{env="TOKEN",value="OLD_PRIVATE_SENTINEL",allow_hosts=["target.example"]}]\n');
  await writeFile(f.paths.project, 'secrets = [{env="TOKEN",value="HIGH_PRIVATE_SENTINEL",allow_hosts=["higher.example"]}]\n');
  const got = await f.call({ scope: "global", path: "secrets", operation: "upsert", value: { env: "TOKEN", allowHosts: ["changed.example"] } });
  assert.equal(got.details.outcome, "applied");
  const text = f.reviews.at(-1)!; noPrivate(text);
  assert.match(text, /- Hosts: target.example/); assert.match(text, /\+ Hosts: changed.example/);
  assert.match(text, /Credential: <redacted> \(changed\)/);
  assert.match(text, /Copies this entry from Project into Global/); assert.match(text, /Higher-priority/); assert.match(text, /Higher-priority settings still apply/);
  assert.doesNotMatch(text, /higher.example/);
});

test("compact review: inherit/no-op and shadowed bypass intent keep only relevant warnings", async (t) => {
  const f = await fixture(t);
  await writeFile(f.paths.global, 'auto_start = false\ncpus = 3\nblock_third_party = false\n');
  await writeFile(f.paths.project, 'cpus = 4\nblock_third_party = true\n');
  await f.call(set("global", "cpus", 5));
  assert.match(f.reviews.at(-1)!, /- CPUs: 3\n\+ CPUs: 5/); assert.match(f.reviews.at(-1)!, /Higher-priority/); assert.doesNotMatch(f.reviews.at(-1)!, /HOST|block_third_party/);
  await f.call(set("global", "block_third_party", false));
  assert.match(f.reviews.at(-1)!, /No change/); assert.match(f.reviews.at(-1)!, /Unrecognized tools can run on the HOST/); assert.match(f.reviews.at(-1)!, /Higher-priority/);
  await f.call({ scope: "project", path: "block_third_party", operation: "inherit" });
  assert.match(f.reviews.at(-1)!, /Removes this override/); assert.match(f.reviews.at(-1)!, /Inherited changes/);
  assert.match(f.reviews.at(-1)!, /\+ Block third-party tools: false/); assert.match(f.reviews.at(-1)!, /Unrecognized tools can run on the HOST/);
  await f.call({ scope: "project", path: "block_third_party", operation: "inherit" });
  assert.match(f.reviews.at(-1)!, /No change/); assert.match(f.reviews.at(-1)!, /HOST/);
  assert.doesNotMatch(f.reviews.at(-1)!, /pass_through_tools|allow_skill_reads|fallback_mode|Restart/);
});

test("compact review: native secret rename/remove and whole-list set/clear show changed fields without siblings", async (t) => {
  const f = await fixture(t);
  const a = { env: "A", value: "A_PRIVATE_SENTINEL", allowHosts: ["a.example"] };
  const b = { env: "B", value: "B_PRIVATE_SENTINEL", allowHosts: ["b.example"] };
  await f.call(set("global", "secrets", [a, b]));
  await f.call({ scope: "global", path: "secrets", operation: "upsert", previousIdentity: "A", value: { env: "RENAMED", allowHosts: ["a.example"] } });
  assert.match(f.reviews.at(-1)!, /A → RENAMED/); assert.match(f.reviews.at(-1)!, /- Name: A\n\+ Name: RENAMED/);
  assert.doesNotMatch(f.reviews.at(-1)!, /Credential|Hosts|b.example/);
  await f.call({ scope: "global", path: "secrets", operation: "remove", identity: "RENAMED" });
  assert.match(f.reviews.at(-1)!, /- Name: RENAMED/); assert.match(f.reviews.at(-1)!, /Removes this entry/); assert.doesNotMatch(f.reviews.at(-1)!, /b.example/);
  await f.call(set("global", "secrets", [{ ...b, allowHosts: ["new.example"] }]));
  assert.match(f.reviews.at(-1)!, /Replaces this scope’s entire list/); assert.match(f.reviews.at(-1)!, /- Hosts: b.example\n\+ Hosts: new.example/); assert.doesNotMatch(f.reviews.at(-1)!, /Credential|Name:/);
  await f.call(set("global", "secrets", []));
  assert.match(f.reviews.at(-1)!, /Clears this scope’s entire list/); assert.match(f.reviews.at(-1)!, /- Credential: <redacted>/);
});

test("compact review: mount edits/rename and scalar-list edits omit unchanged fields", async (t) => {
  const f = await fixture(t);
  const data = join(f.root, "data"); await mkdir(data);
  const mount = { type: "dir", hostPath: data, guestPath: "/mnt/data", readonly: true, options: [] };
  await f.call({ scope: "global", path: "mounts", operation: "upsert", value: mount });
  await f.call({ scope: "global", path: "mounts", operation: "upsert", value: { ...mount, readonly: false } });
  assert.match(f.reviews.at(-1)!, /- Read only: true\n\+ Read only: false/); assert.doesNotMatch(f.reviews.at(-1)!, /Host path|Options|Type:/);
  await f.call({ scope: "global", path: "mounts", operation: "upsert", previousIdentity: "/mnt/data", value: { ...mount, readonly: false, guestPath: "/mnt/renamed" } });
  assert.match(f.reviews.at(-1)!, /- Guest path: \/mnt\/data\n\+ Guest path: \/mnt\/renamed/); assert.doesNotMatch(f.reviews.at(-1)!, /Read only:|Host path/);
  await f.call(set("global", "host_env", ["KEEP", "OLD"]));
  await f.call({ scope: "global", path: "host_env", operation: "upsert", value: "NEW", previousIdentity: "OLD" });
  assert.match(f.reviews.at(-1)!, /- Host variables: OLD\n\+ Host variables: NEW/); assert.doesNotMatch(f.reviews.at(-1)!, /KEEP|HOST/);
});

test("compact review: collection reorder, inherited assignment and removal reconciliation remain visible", async (t) => {
  const f = await fixture(t);
  const a = { env: "A", value: "A_PRIVATE_SENTINEL", allowHosts: ["a.example"] };
  const b = { env: "B", value: "B_PRIVATE_SENTINEL", allowHosts: ["b.example"] };
  await f.call(set("global", "secrets", [a, b]));
  await f.call(set("global", "secrets", [b, a]));
  assert.match(f.reviews.at(-1)!, /Entry order: \["A","B"\]/); assert.match(f.reviews.at(-1)!, /Entry order: \["B","A"\]/);
  assert.doesNotMatch(f.reviews.at(-1)!, /Credential|Hosts/);
  await f.call({ scope: "project", path: "secrets", operation: "upsert", value: { env: "A", allowHosts: ["changed.example"] } });
  assert.match(f.reviews.at(-1)!, /Scope: Project/);
  assert.match(f.reviews.at(-1)!, /Overrides inherited values/);
  assert.match(f.reviews.at(-1)!, /- Hosts: a.example\n\+ Hosts: changed.example/); assert.doesNotMatch(f.reviews.at(-1)!, /Credential|b.example/);
  await writeFile(f.paths.project, 'remove_secrets = ["A"]\n');
  await f.call(set("project", "secrets", [a]));
  assert.match(f.reviews.at(-1)!, /Updates exclusions/); assert.match(f.reviews.at(-1)!, /Secret exclusions: A/);
});

test("compact setter renderers: never echo raw arguments or full review JSON, preserve useful outcomes and failures", async (t) => {
  const f = await fixture(t); const tool = f.tools.get("msb_config_set")!;
  const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text } as any;
  const raw = { ...set(), identity: "RAW_PRIVATE_SENTINEL", value: "RAW_PRIVATE_SENTINEL" };
  assert.equal(tool.renderCall!(raw as any, theme, {} as any).render(100).join("\n").trim(), "Microsandbox setting");
  const got = await f.call(set());
  for (const expanded of [false, true]) {
    const frame = tool.renderResult!(got, { expanded, isPartial: false } as any, theme, {} as any).render(100).join("\n");
    assert.match(frame, /Saved · reloaded · runtime off/); assert.match(frame, /Scope: Session/); assert.match(frame, /Show footer/); assert.doesNotMatch(frame, /adoptedRuntime|provenance|effectiveToml|supportedPaths/);
    if (expanded) assert.match(frame, /\+ Show footer: false/);
  }
  for (const scope of ["ephemeral", "temporary"]) {
    const historical = { ...got, details: { ...got.details, review: { ...got.details.review, scope } } };
    for (const expanded of [false, true]) {
      const frame = tool.renderResult!(historical, { expanded, isPartial: false } as any, theme, {} as any).render(100).join("\n");
      assert.match(frame, /Scope: Session/); assert.doesNotMatch(frame, /ephemeral|temporary|RAW_PRIVATE_SENTINEL/);
    }
  }
  f.failReload(); const failed = await f.call(set("global"));
  const frame = tool.renderResult!(failed, { expanded: false } as any, theme, {} as any).render(100).join("\n");
  assert.match(frame, /saved_but_reload_failed.*saved but not fully activated/); assert.doesNotMatch(frame, /Saved · reloaded/);
  const external = tool.renderResult!({ content: [{ type: "text", text: "RAW_PRIVATE_SENTINEL" }], details: undefined }, {} as any, theme, { isError: true } as any).render(100).join("\n");
  assert.match(external, /failed.*no confirmed activation/); noPrivate(external);
});

test("compact review: actual restart/start and explicit host intents retain relevant consequences", async (t) => {
  const f = await fixture(t);
  await f.call(set("session", "memory_mib", 4096));
  assert.match(f.reviews.at(-1)!, /Restart: temporary guest data and nested containers may be lost/);
  assert.doesNotMatch(f.reviews.at(-1)!, /HOST/);
  await writeFile(f.paths.global, "auto_start = true\n");
  await f.call(set("session", "show_footer", false));
  assert.match(f.reviews.at(-1)!, /May start the sandbox/);
  for (const [path, value, pattern] of [["allow_host_execution", true, /individual tool-call approval/], ["fallback_mode", "host", /Sandbox failure/], ["allow_skill_reads", true, /read from the HOST/]] as const) {
    await f.call(set("global", path, value)); assert.match(f.reviews.at(-1)!, pattern);
    assert.doesNotMatch(f.reviews.at(-1)!, /pass_through_tools|block_third_party = false/);
  }
});

test("compact review: malformed shadowed raw scalar is projected, never an unknown-data read channel", async (t) => {
  const f = await fixture(t);
  await writeFile(f.paths.global, 'auto_start = false\ncpus = { body = "UNRECOGNIZED_RAW_VALUE", VALUE = "UNKNOWN_PRIVATE_SENTINEL" }\n');
  await writeFile(f.paths.project, "cpus = 4\n");
  const got = await f.call(set("global", "cpus", 3));
  assert.equal(got.details.outcome, "applied"); noPrivate(got); noPrivate(f.reviews);
  assert.match(f.reviews.at(-1)!, /- CPUs: <invalid>\n\+ CPUs: 3/);
});

test("compact review: whole-list clear without an own assignment shows affected inherited entries", async (t) => {
  const f = await fixture(t);
  await writeFile(f.paths.global, 'auto_start = false\nsecrets = [{env="LOWER",value="LOWER_PRIVATE_SENTINEL",allow_hosts=["lower.example"]}]\n');
  await f.call(set("project", "secrets", []));
  assert.match(f.reviews.at(-1)!, /Scope: Project/);
  assert.match(f.reviews.at(-1)!, /- Name: LOWER/); assert.match(f.reviews.at(-1)!, /- Hosts: \["lower.example"\]/);
  assert.match(f.reviews.at(-1)!, /- Credential: <redacted>/); noPrivate(f.reviews);
});

test("compact review: oversized diffs reject without opening UI or mutating, then release the shared lease", async (t) => {
  const f = await fixture(t);
  const got = await f.call(set("global", "network.allow_hosts", Array.from({ length: 5000 }, (_, n) => `long-host-${n}.example`)));
  assert.equal(got.details.outcome, "rejected"); assert.match(got.details.reason, /Review too large/);
  assert.equal(f.reviews.length, 0); assert.equal(f.reloads(), 0);
  assert.equal((await f.call(set())).details.outcome, "applied");
});

test("compact review: changing adopted runtime while reviewing still conflicts without activation", async (t) => {
  const f = await fixture(t);
  f.control.getAgentRuntimePolicy = () => undefined;
  f.choose(async () => {
    f.control.getAgentRuntimePolicy = () => ({ settings: { cpus: 2 }, knownFields: ["cpus"], provenance: {}, verification: "created", adoptedAt: 1 });
    return "Yes";
  });
  assert.equal((await f.call(set())).details.outcome, "conflict");
  assert.equal(f.reloads(), 0); assert.deepEqual(f.editor.temporary(), {});
});

test("compact setter renderer: historical full-review results cannot fall back to a JSON wall", async (t) => {
  const f = await fixture(t);
  const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text } as any;
  const historical = { content: [{ type: "text" as const, text: "HISTORICAL_JSON_WALL" }], details: { outcome: "applied", saved: true, reloaded: true, runtimeStatus: "off", review: { desired: { old: "HISTORICAL_JSON_WALL" }, provenance: {} } } };
  for (const expanded of [false, true]) {
    const frame = f.tools.get("msb_config_set")!.renderResult!(historical, { expanded } as any, theme, {} as any).render(100).join("\n");
    assert.match(frame, /Saved · reloaded · runtime off/); assert.doesNotMatch(frame, /Scope:|HISTORICAL_JSON_WALL|provenance/);
  }
});

test("compact review: renaming onto an inherited entry discloses the overwritten entry safely", async (t) => {
  const f = await fixture(t);
  await writeFile(f.paths.global, 'auto_start = false\nsecrets = [{env="A",value="A_PRIVATE_SENTINEL",allow_hosts=["a.example"]},{env="B",value="B_PRIVATE_SENTINEL",allow_hosts=["b.example"]}]\n');
  const got = await f.call({ scope: "project", path: "secrets", operation: "upsert", previousIdentity: "A", value: { env: "B", allowHosts: ["a.example"] } });
  assert.equal(got.details.outcome, "applied");
  assert.match(f.reviews.at(-1)!, /- Hosts: \["b.example"\]/);
  assert.match(f.reviews.at(-1)!, /Replaces the entry with this name/); noPrivate(got); noPrivate(f.reviews);
});

test("compact review: malformed shadowed native entry fields retain the strict JSON whitelist", async (t) => {
  const f = await fixture(t);
  await writeFile(f.paths.global, 'auto_start = false\nsecrets = [{env="TOKEN",VALUE="UNKNOWN_PRIVATE_SENTINEL",allow_hosts={body="UNRECOGNIZED_RAW_VALUE"}}]\n');
  await writeFile(f.paths.project, "secrets = []\n");
  const got = await f.call(set("global", "secrets", [{ env: "TOKEN", value: "NEW_PRIVATE_SENTINEL", allowHosts: ["new.example"] }]));
  assert.equal(got.details.outcome, "applied"); noPrivate(got); noPrivate(f.reviews);
  assert.match(f.reviews.at(-1)!, /- Hosts: <invalid>/); assert.match(f.reviews.at(-1)!, /Credential: <redacted> \(changed\)/);
});


const consequenceTheme = { fg: (role: string, text: string) => `<${role}>${text}</${role}>`, bold: (text: string) => text };
const hostWriteWarning = "! This mount allows changes to HOST files.";

for (const type of ["dir", "file"] as const) for (const readonly of [false, true]) {
  test(`inherited consequences: ${type} mount readonly=${readonly} reaches plain and themed backend review`, async (t) => {
    const f = await fixture(t);
    const hostPath = join(f.root, "data");
    if (type === "dir") await mkdir(hostPath); else await writeFile(hostPath, "fixture");
    const mount = { type, hostPath, guestPath: "/mnt/data", readonly, options: [] };
    const policy = (value: typeof mount) => `mounts = [{type=${JSON.stringify(value.type)},host_path=${JSON.stringify(value.hostPath)},guest_path="/mnt/data",readonly=${value.readonly}}]\n`;
    await writeFile(f.paths.global, "auto_start = false\n" + policy(mount));
    await writeFile(f.paths.project, policy({ ...mount, readonly: true }));
    const got = await f.call({ scope: "project", path: "mounts", operation: "inherit" });
    assert.equal(got.details.outcome, "applied");
    const lines = settingsDiff(got.details.review);
    const plain = formatSettingsDiff(lines).join("\n");
    const themed = formatSettingsDiff(lines, consequenceTheme).join("\n");
    assert.equal(got.details.review.focus[0].writableMount, !readonly);
    assert.equal(plain.includes(hostWriteWarning), !readonly);
    assert.equal(f.reviews.at(-1)!.includes(hostWriteWarning), !readonly);
    assert.equal(themed.includes(`<warning>${hostWriteWarning}</warning>`), !readonly);
    if (!readonly) { assert.match(plain, /\+ Read only: false/); assert.match(themed, /<toolDiffAdded>false<\/toolDiffAdded>/); }
    else assert.doesNotMatch(plain, /HOST/);
    noPrivate(got);
  });
}

for (const scope of ["global", "project"] as const) {
  test(`inherited consequences: shadowed ${scope} target retains lower-scope writable HOST intent`, async (t) => {
    const f = await fixture(t);
    const hostPath = join(f.root, "data"); await mkdir(hostPath);
    const writable = { type: "dir", hostPath, guestPath: "/mnt/data", readonly: false, options: [] };
    const policy = `mounts = [{type="dir",host_path=${JSON.stringify(hostPath)},guest_path="/mnt/data",readonly=true}]\n`;
    if (scope === "global") {
      f.input.env!.PI_MSB_MOUNTS = JSON.stringify([writable]);
      await writeFile(f.paths.global, "auto_start = false\n" + policy);
      await writeFile(f.paths.project, policy);
    } else {
      await writeFile(f.paths.global, `auto_start = false\nmounts = [{type="dir",host_path=${JSON.stringify(hostPath)},guest_path="/mnt/data",readonly=false}]\n`);
      await writeFile(f.paths.project, policy);
      const temp = await f.editor.open("temporary"); temp.set("mounts", [{ ...writable, readonly: true }]); await temp.apply();
    }
    const got = await f.call({ scope, path: "mounts", operation: "inherit" });
    assert.equal(got.details.outcome, "applied");
    assert.equal(got.details.review.desired.before.mounts[0].readonly, true);
    assert.equal(got.details.review.desired.after.mounts[0].readonly, true);
    assert.equal(got.details.review.focus[0].writableMount, true);
    assert.match(f.reviews.at(-1)!, /Higher-priority settings still apply/);
    assert.match(f.reviews.at(-1)!, /Higher-priority/);
    assert.ok(f.reviews.at(-1)!.includes(hostWriteWarning));
    assert.ok(formatSettingsDiff(settingsDiff(got.details.review), consequenceTheme).join("\n").includes(`<warning>${hostWriteWarning}</warning>`));
    noPrivate(got);
  });
}

test("inherited consequences: native mount warnings remain isolated to the selected entry", async (t) => {
  const f = await fixture(t);
  const hostPath = join(f.root, "data"); await mkdir(hostPath);
  const selected = { type: "dir", hostPath, guestPath: "/mnt/selected", readonly: true, options: [] };
  const sibling = { ...selected, guestPath: "/mnt/unrelated", readonly: false };
  const draft = await f.editor.open("global"); draft.set("mounts", [selected, sibling]); await draft.apply();
  const edit = { scope: "global", path: "mounts", operation: "upsert", value: { ...selected, options: ["nodev"] } };
  const safe = await f.call(edit); assert.equal(safe.details.outcome, "applied");
  assert.equal(safe.details.review.focus[0].writableMount, false);
  for (const theme of [undefined, consequenceTheme]) {
    const text = formatSettingsDiff(settingsDiff(safe.details.review), theme).join("\n");
    assert.doesNotMatch(text, /HOST|unrelated/);
  }
  const writable = await f.call({ ...edit, value: { ...edit.value, readonly: false } });
  assert.equal(writable.details.outcome, "applied");
  assert.equal(writable.details.review.focus[0].writableMount, true);
  assert.ok(f.reviews.at(-1)!.includes(hostWriteWarning));
  assert.doesNotMatch(f.reviews.at(-1)!, /unrelated/);
});

for (const [path, inherited, override, consequence] of [
  ["block_third_party", false, true, /Unrecognized tools.*HOST without per-call host approval/],
  ["pass_through_tools", ["trusted"], [], /These tools run.*HOST without per-call host approval/],
  ["allow_host_execution", true, false, /HOST execution after individual tool-call approval/],
  ["allow_skill_reads", true, false, /Skills and generated prompts may be read from the HOST/],
  ["fallback_mode", "host", "block", /Sandbox failure may run tools on the HOST/],
] as const) {
  test(`inherited consequences: shadowed ${path} inherit and no-op retain their specific HOST warning`, async (t) => {
    const f = await fixture(t);
    await writeFile(f.paths.global, `auto_start = false\n${path} = ${JSON.stringify(inherited)}\n`);
    await writeFile(f.paths.project, `${path} = ${JSON.stringify(override)}\n`);
    const temp = await f.editor.open("temporary"); temp.set(path, override); await temp.apply();
    for (const outcome of ["applied", "no_op"]) {
      const got = await f.call({ scope: "project", path, operation: "inherit" });
      assert.equal(got.details.outcome, outcome);
      assert.deepEqual(got.details.review.focus[0].hostBypass, [path]);
      const lines = settingsDiff(got.details.review);
      const hostWarnings = lines.filter((line) => line.kind === "warning" && line.text.includes("HOST"));
      assert.equal(hostWarnings.length, 1); assert.match(hostWarnings[0]!.text, consequence);
      assert.match(f.reviews.at(-1)!, /HOST/); assert.match(f.reviews.at(-1)!, /Higher-priority/);
      assert.match(formatSettingsDiff(lines, consequenceTheme).join("\n"), /<warning>! .*HOST/);
      noPrivate(got);
    }
  });
}
