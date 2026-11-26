import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_CONFIG, hostConfigPaths, parseTomlConfig, readRawConfig, resolveConfig, resolveSecretValue, type ResolveConfigInput } from "./config.ts";
import type { Config, SecretConfig } from "./types.ts";

import { classifySettingsEffect, COLLECTION_REMOVALS, SETTINGS_PATHS, SettingsEditor } from "./settings.ts";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-msb-settings-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "home", "work");
  await mkdir(cwd, { recursive: true });
  const input: ResolveConfigInput = { cwd, homedir: join(root, "home"), agentDir: join(root, "agent"), env: {}, projectTrusted: true, configDirName: ".pi" };
  const paths = await hostConfigPaths(input);
  await mkdir(dirname(paths.project), { recursive: true });
  const editor = new SettingsEditor(input, "session-1");
  return { input, paths, editor, root };
}

test("settings schema leaf inventory covers every supported setting", () => {
  assert.equal(SETTINGS_PATHS.length, Object.keys(DEFAULT_CONFIG).length + 4);
  for (const path of ["network.mode", "network.allow_hosts", "network.allow_dns", "network.publish_ports", "docker.startup_timeout_ms", "secrets", "mounts", "lock_dir"]) assert.ok(SETTINGS_PATHS.includes(path));
});

test("settings sparse saves preserve unrelated raw data/references; no-op does not write", async (t) => {
  const { editor, input, paths } = await fixture(t);
  await writeFile(join(dirname(paths.global), "token"), "not-materialized");
  const raw = `# original\ncpus = 3\nunknown_setting = { originalKey = "keep" }\nsecrets = [{ env = "TOKEN", text_value = "$FILE:token", allow_hosts = ["example.com"] }]\nnetwork.allow_dns = false\n`;
  await writeFile(paths.global, raw);
  const noOp = await editor.open("global");
  noOp.set("cpus", 3);
  assert.deepEqual((await noOp.preview()).changes, []);
  assert.equal((await noOp.apply()).saved, false);
  assert.equal(await readFile(paths.global, "utf8"), raw);
  const draft = await editor.open("global");
  draft.set("show_footer", false);
  assert.deepEqual((await draft.preview()).changes.map((c) => c.path), ["show_footer"]);
  await draft.apply();
  const saved = await readFile(paths.global, "utf8");
  assert.ok(saved.includes("$FILE:token"));
  assert.ok(!saved.includes("not-materialized"));
  assert.ok(!saved.includes("memory_mib"));
  assert.ok(saved.includes("originalKey"));
  assert.equal(parseTomlConfig(saved, "global").value.cpus, 3);
  assert.equal((await resolveConfig(input)).config.network.allowDns, false);
  assert.equal((await stat(paths.global)).mode & 0o777, 0o600);
});

for (const scope of ["global", "project"] as const) test(`${scope} saves format TOML tables and collection entries without changing raw data`, async (t) => {
  const { editor, paths, root } = await fixture(t);
  const cache = join(root, "cache");
  await mkdir(cache);
  const raw = [
    'cpus = 3',
    'route_tools = ["read", "bash"]',
    'empty_list = []',
    'empty_table = {}',
    'empty_entries = [{}]',
    'mixed_list = [1, { originalKey = "keep" }]',
    'network = { mode = "deny", allow_hosts = ["a.example", "b.example"] }',
    'secrets = [{ env = "ONE", host_env = "ONE", allow_hosts = ["a.example"] }, { env = "TWO", host_cmd = "printf TWO", allow_hosts = ["b.example"] }]',
    `mounts = [{ type = "dir", host_path = ${JSON.stringify(cache)}, guest_path = "/cache", readonly = true, options = [] }]`,
    '"custom.section" = { "key with spaces" = "keep", nested = { originalKey = "keep", "literal.key" = "keep" }, entries = [{ name = "one" }, { name = "two" }], empty = {} }',
  ].join("\n") + "\n";
  await writeFile(paths[scope], raw);
  const draft = await editor.open(scope);
  draft.set("show_footer", false);
  await draft.apply();
  const saved = await readFile(paths[scope], "utf8");
  assert.match(saved, /^cpus = 3\nroute_tools = \["read", "bash"\]/);
  assert.match(saved, /\n\n\[network\]\nmode = "deny"\nallow_hosts = \["a.example", "b.example"\]/);
  assert.equal(saved.match(/^\[\[secrets\]\]$/gm)?.length, 2);
  assert.match(saved, /\[\[secrets\]\]\nenv = "ONE"\nhost_env = "ONE"/);
  assert.match(saved, /\n\n\[\[mounts\]\]\ntype = "dir"\nhost_path = /);
  assert.match(saved, /\["custom.section"\]\n"key with spaces" = "keep"/);
  assert.match(saved, /\["custom.section"\.nested\]\noriginalKey = "keep"\n"literal.key" = "keep"/);
  assert.ok(saved.endsWith("\n"));
  const expected = readRawConfig(raw); expected.show_footer = false;
  assert.deepEqual(readRawConfig(saved), expected);
  const noOp = await editor.open(scope);
  noOp.set("show_footer", false);
  assert.equal((await noOp.apply()).saved, false);
  assert.equal(await readFile(paths[scope], "utf8"), saved);
  for (const value of [true, false]) {
    const next = await editor.open(scope); next.set("show_footer", value); await next.apply();
  }
  assert.equal(await readFile(paths[scope], "utf8"), saved);
});

test("project save is sparse and reports global edits shadowed by project and temporary", async (t) => {
  const { editor, paths } = await fixture(t);
  await writeFile(paths.project, "cpus = 8\n");
  const draft = await editor.open("global"); draft.set("cpus", 2);
  const result = await draft.apply();
  assert.deepEqual(result.shadowed, ["cpus"]);
  assert.equal(result.provenance.cpus, "host-project");
  assert.equal(result.effect, "none");
  const project = await editor.open("project"); project.set("memory_mib", 1024); await project.apply();
  assert.deepEqual(parseTomlConfig(await readFile(paths.project, "utf8"), "project").value, { cpus: 8, memoryMiB: 1024 });
  const temp = await editor.open("temporary"); temp.set("cpus", 16); await temp.apply();
  const global = await editor.open("global"); global.set("cpus", 4);
  assert.deepEqual((await global.preview()).shadowed, ["cpus"]);
});

test("inherit differs from empty authoritative arrays, deletion preserves unrelated nested settings", async (t) => {
  const { editor, paths } = await fixture(t);
  await writeFile(paths.global, 'network.allow_hosts = ["global.example"]\n');
  await writeFile(paths.project, 'network.allow_hosts = ["project.example"]\nnetwork.allow_dns = false\n');
  const clear = await editor.open("project"); clear.set("network.allow_hosts", []); await clear.apply();
  const inherit = await editor.open("project"); inherit.inherit("network.allow_hosts");
  assert.match((await inherit.preview()).effectiveToml, /global.example/);
  await inherit.apply();
  const saved = parseTomlConfig(await readFile(paths.project, "utf8"), "project").value;
  assert.equal(saved.network?.allowHosts, undefined);
  assert.equal(saved.network?.allowDns, false);
});

test("native secret CRUD accepts literals, exposes host metadata and never executes hostCmd during inspection/validation", async (t) => {
  const { editor, paths, root } = await fixture(t);
  const marker = join(root, "command-executed");
  const secrets: SecretConfig[] = [
    { env: "LITERAL", textValue: "literal-credential-sentinel", allowHosts: ["a.example"] },
    { env: "ENV_LITERAL", textValue: "$ENV:literal-env-sentinel", allowHosts: ["a.example"] },
    { env: "FILE_LITERAL", textValue: "$FILE:literal-file-sentinel", allowHosts: ["a.example"] },
    { env: "ENV_TOKEN", hostEnv: "HOST_ENV_SENTINEL", allowHosts: ["a.example"] },
    { env: "CMD_TOKEN", hostCmd: `touch ${JSON.stringify(marker)}`, allowHosts: ["a.example"] },
  ];
  const draft = await editor.open("project");
  draft.set("secrets", secrets);
  for (const secret of secrets) draft.upsertSecret({ env: secret.env, allowHosts: ["b.example"] });
  const display = JSON.stringify([draft.snapshot(), await draft.preview(), await draft.reviewForApproval("restart")]);
  for (const secret of secrets) {
    if (secret.textValue) assert.equal(display.includes(secret.textValue), false);
    else assert.ok(display.includes(JSON.stringify(secret.hostEnv ?? secret.hostCmd).slice(1, -1)));
  }
  await draft.apply();
  await editor.inspect();
  assert.deepEqual(parseTomlConfig(await readFile(paths.project, "utf8"), "project").value.secrets,
    secrets.map((secret) => ({ ...secret, allowHosts: ["b.example"] })));
  await assert.rejects(stat(marker), { code: "ENOENT" });
  const remove = await editor.open("project"); remove.removeSecret("LITERAL"); await remove.apply();
  assert.ok(!(await readFile(paths.project, "utf8")).includes("literal-credential-sentinel"));
});

test("unchanged literal secrets are not copied into sparse files", async (t) => {
  const { editor, paths } = await fixture(t);
  await writeFile(paths.global, 'secrets = [{ env = "TOKEN", text_value = "literal-sentinel", allow_hosts = ["a.example"] }]\n');
  const draft = await editor.open("project"); draft.set("cpus", 2); await draft.apply();
  assert.ok(!(await readFile(paths.project, "utf8")).includes("literal-sentinel"));
});

test("cross-layer secret CRUD preserves literal prefixes without expansion or rebasing", async (t) => {
  for (const value of ["$FILE:token", "$ENV:TOKEN"]) {
    const { editor, paths, input } = await fixture(t);
    await writeFile(paths.global, `secrets = [{ env = "TOKEN", text_value = ${JSON.stringify(value)}, allow_hosts = ["a.example"] }]`);
    const draft = await editor.open("project"); draft.upsertSecret({ env: "TOKEN", allowHosts: ["b.example"] }); await draft.apply();
    const secret = (await resolveConfig(input)).config.secrets[0]!;
    assert.equal(secret.textValue, value);
    assert.equal(await resolveSecretValue(secret, { TOKEN: "must-not-expand" }), value);
    assert.equal(parseTomlConfig(await readFile(paths.project, "utf8"), "project").value.secrets![0]!.textValue, value);
  }
});

test("invalid/schema/null/mount candidates fail before disk or temporary changes", async (t) => {
  const { editor, paths, input } = await fixture(t);
  await writeFile(paths.project, "cpus = 2\n");
  for (const [key, value] of [["cpus", 0], ["lock_dir", 3], ["network.publish_ports", ["bad"]], ["sandbox_name", null], ["secrets", [{ env: "TOKEN", textValue: "secret", allowHosts: [] }]]] as const) {
    const draft = await editor.open("project"); draft.set(key, value);
    await assert.rejects(draft.apply());
    assert.equal(await readFile(paths.project, "utf8"), "cpus = 2\n");
  }
  const draft = await editor.open("temporary");
  draft.set("mounts", [{ type: "dir", hostPath: dirname(paths.global), guestPath: "/policy", readonly: false, options: [] }]);
  await assert.rejects(draft.apply(), /host configuration/);
  assert.deepEqual(editor.temporary(), {});
  const workspaceTarget = new SettingsEditor({ ...input, agentDir: join(input.cwd, "agent") }, "session");
  await assert.rejects(workspaceTarget.open("project"), /outside the mounted workspace/);
});

test("conflicts and symlink targets/ancestors fail closed", async (t) => {
  const { editor, paths, root } = await fixture(t);
  await writeFile(paths.project, "cpus = 2\n");
  const draft = await editor.open("project"); draft.set("cpus", 4);
  await writeFile(paths.project, "cpus = 3\n");
  await assert.rejects(draft.apply(), /externally/);
  assert.equal(await readFile(paths.project, "utf8"), "cpus = 3\n");
  await rm(paths.project); await symlink(join(root, "missing"), paths.project);
  await assert.rejects(editor.open("project"), /could not be safely verified/);
  await rm(paths.project); await writeFile(paths.project, "cpus = 2\n");
  const late = await editor.open("project"); late.set("cpus", 5);
  const moved = `${dirname(paths.project)}-moved`;
  const { rename } = await import("node:fs/promises");
  await rename(dirname(paths.project), moved); await symlink(moved, dirname(paths.project));
  await assert.rejects(late.apply(), /could not be safely verified/);
  assert.equal(await readFile(paths.project, "utf8"), "cpus = 2\n");
});

test("temporary is authoritative above host layers, diskless, transactional and session-limited", async (t) => {
  const { editor, paths, input } = await fixture(t);
  await writeFile(paths.project, 'cpus = 8\nnetwork.allow_hosts = ["policy.example"]\n');
  const raw = await readFile(paths.project, "utf8");
  const temp = await editor.open("temporary"); temp.set("cpus", 2); temp.set("network.allow_hosts", []);
  const preview = await temp.preview(); assert.equal(preview.provenance.cpus, "temporary");
  assert.equal(preview.effect, "restart"); await temp.apply();
  assert.equal(await readFile(paths.project, "utf8"), raw);
  assert.deepEqual((await editor.resolveCandidate(null, null, editor.temporary())).config.network.allowHosts, []);
  const invalid = await editor.open("temporary"); invalid.set("cpus", 0); await assert.rejects(invalid.apply());
  assert.equal(editor.temporary().cpus, 2);
  editor.configureSession(input, "session-1"); assert.equal(editor.temporary().cpus, 2);
  editor.configureSession(input, "session-2"); assert.deepEqual(editor.temporary(), {});
  const stale = await editor.open("temporary"); stale.set("cpus", 4); editor.endSession();
  await assert.rejects(stale.apply(), /stale/);
  editor.configureSession(input, "session-2"); assert.deepEqual(editor.temporary(), {});
});

test("effect classification is conservative about VM and environment changes", () => {
  const base = structuredClone(DEFAULT_CONFIG) as Config;
  assert.equal(classifySettingsEffect(base, base), "none");
  assert.equal(classifySettingsEffect(base, { ...base, showFooter: false }), "live");
  assert.equal(classifySettingsEffect(base, { ...base, cpus: 2 }), "restart");
});

test("drafts can retarget dirty edits to three scopes without copying effective defaults", async (t) => {
  const { editor, paths } = await fixture(t);
  await writeFile(paths.project, "cpus = 8\n");
  const draft = await editor.open("temporary"); draft.set("cpus", 2); draft.set("show_footer", false);
  const project = await draft.forScope("project");
  await project.apply();
  const saved = parseTomlConfig(await readFile(paths.project, "utf8"), "project").value;
  assert.deepEqual(saved, { cpus: 2, showFooter: false });
  assert.deepEqual(editor.temporary(), {});
});

test("retargeting literal prefix secrets never rewrites their spelling", async (t) => {
  for (const value of ["$FILE:../token", "$ENV:TOKEN"]) {
    const { editor, paths } = await fixture(t);
    await writeFile(paths.project, `secrets = [{ env = "TOKEN", text_value = ${JSON.stringify(value)}, allow_hosts = ["a.example"] }]`);
    const draft = await editor.open("project"); draft.upsertSecret({ env: "TOKEN", allowHosts: ["b.example"] });
    const global = await draft.forScope("global"); await global.apply();
    assert.deepEqual(parseTomlConfig(await readFile(paths.global, "utf8"), "global").value.secrets,
      [{ env: "TOKEN", textValue: value, allowHosts: ["b.example"] }]);
  }
});

test("new missing host policy directories can be safely created after validation", async (t) => {
  const { input, root } = await fixture(t);
  const nextInput = { ...input, agentDir: join(root, "new-agent") };
  const editor = new SettingsEditor(nextInput, "new-session");
  const paths = await hostConfigPaths(nextInput);
  const draft = await editor.open("project"); draft.set("cpus", 2); await draft.apply();
  assert.equal((await resolveConfig(nextInput)).config.cpus, 2);
  assert.equal((await stat(dirname(paths.project))).mode & 0o777, 0o700);
  assert.equal((await stat(paths.project)).mode & 0o777, 0o600);
});

test("mount CRUD preserves valid collection semantics and rejects masked secret placeholders", async (t) => {
  const { editor } = await fixture(t);
  const draft = await editor.open("temporary");
  draft.upsertMount({ type: "tmpfs", guestPath: "/scratch", readonly: false, options: ["noexec"] });
  assert.equal((await draft.preview()).effect, "restart");
  draft.upsertMount({ type: "tmpfs", guestPath: "/cache", readonly: true, options: [] }, "/scratch");
  draft.removeMount("/cache");
  assert.equal((await draft.preview()).effect, "none");
  assert.throws(() => draft.set("secrets", [{ env: "TOKEN", textValue: "<redacted>", allowHosts: ["a.example"] }]), /placeholders/);
  draft.discard();
  assert.throws(() => draft.set("cpus", 2), /closed/);
});

test("source switching replaces the old source and survives metadata edits, rename and refresh", async (t) => {
  const sources = [{ textValue: "$ENV:literal-private" }, { hostEnv: "PRIVATE_ENV" }, { hostCmd: "printf PRIVATE_CMD" }];
  for (const scope of ["global", "project", "temporary"] as const) for (const before of sources) for (const after of sources) {
    const { editor, paths } = await fixture(t);
    const initial = await editor.open(scope); initial.upsertSecret({ env: "TOKEN", ...before, allowHosts: ["old.example"] }); await initial.apply();
    const draft = await editor.open(scope);
    draft.upsertSecret({ env: "TOKEN", ...after, allowHosts: ["first.example"] });
    draft.upsertSecret({ env: "TOKEN", allowHosts: ["second.example"] });
    draft.upsertSecret({ env: "RENAMED", allowHosts: ["third.example"] }, "TOKEN");
    const refreshed = await draft.refresh();
    for (const source of [before, after]) if ("textValue" in source) {
      assert.equal(JSON.stringify(refreshed.snapshot()).includes(source.textValue!), false);
    }
    await refreshed.apply();
    const saved = scope === "temporary" ? editor.temporary().secrets : parseTomlConfig(await readFile(paths[scope], "utf8"), scope).value.secrets;
    assert.deepEqual(saved, [{ env: "RENAMED", ...after, allowHosts: ["third.example"] }]);
  }
});

test("secret edits require exactly one source and reject invalid source values atomically", async (t) => {
  const { editor, paths } = await fixture(t);
  await writeFile(paths.project, "cpus = 2\n");
  const invalid = [{}, { textValue: "private", hostEnv: "PRIVATE_ENV" }, { textValue: "private", hostCmd: "printf PRIVATE_CMD" },
    { hostEnv: "PRIVATE_ENV", hostCmd: "printf PRIVATE_CMD" }, { textValue: "private", hostEnv: "PRIVATE_ENV", hostCmd: "printf PRIVATE_CMD" },
    { textValue: null }, { hostEnv: 1 }, { hostCmd: [] }, { hostEnv: "" }, { hostCmd: "" }];
  for (const source of invalid) for (const operation of ["set", "upsert"] as const) {
    await assert.rejects(async () => {
      const draft = await editor.open("project");
      const secret = { env: "TOKEN", ...source, allowHosts: ["a.example"] };
      if (operation === "set") draft.set("secrets", [secret]); else draft.upsertSecret(secret as SecretConfig);
      await draft.apply();
    });
    assert.equal(await readFile(paths.project, "utf8"), "cpus = 2\n");
    assert.deepEqual(editor.temporary(), {});
  }
});

test("deprecated secret value sources are rejected without retaining or expanding credentials", async (t) => {
  for (const scope of ["global", "project", "temporary"] as const) {
    const { editor, paths } = await fixture(t);
    const initial = await editor.open(scope);
    initial.upsertSecret({ env: "TOKEN", textValue: "original-private", allowHosts: ["a.example"] });
    await initial.apply();
    const before = scope === "temporary" ? editor.temporary() : await readFile(paths[scope], "utf8");
    for (const source of [
      { value: "deprecated-private" },
      { value: "$ENV:TOKEN" },
      { value: "deprecated-private", textValue: "replacement-private" },
      { value: "deprecated-private", hostEnv: "TOKEN" },
      { value: "deprecated-private", hostCmd: "printf replacement-private" },
    ]) for (const operation of ["set", "upsert"] as const) {
      await assert.rejects(async () => {
        const draft = await editor.open(scope);
        const secret = { env: "TOKEN", ...source, allowHosts: ["b.example"] };
        if (operation === "set") draft.set("secrets", [secret]); else draft.upsertSecret(secret);
        await draft.apply();
      }, /secret value was removed/);
      assert.deepEqual(scope === "temporary" ? editor.temporary() : await readFile(paths[scope], "utf8"), before);
    }
  }
});

test("same-identity draft refresh preserves private edits but rejects switched, ended or changed cwd contexts", async (t) => {
  const { editor, input } = await fixture(t);
  const draft = await editor.open("temporary"); draft.set("cpus", 2); draft.upsertSecret({ env: "TOKEN", textValue: "PRIVATE_SENTINEL", allowHosts: ["a.example"] });
  editor.configureSession(input, "session-1"); await assert.rejects(draft.preview(), /stale/);
  const refreshed = await draft.refresh(); assert.doesNotMatch(JSON.stringify(refreshed.snapshot()), /PRIVATE_SENTINEL/);
  await refreshed.apply(); assert.equal(editor.temporary().cpus, 2); assert.equal(editor.temporary().secrets![0]!.textValue, "PRIVATE_SENTINEL");
  editor.configureSession(input, "session-2"); await assert.rejects(draft.refresh(), /context changed/);
  const ending = await editor.open("temporary"); editor.endSession(); await assert.rejects(ending.refresh(), /context changed/);
  const moving = await editor.open("temporary"); editor.configureSession({ ...input, cwd: join(input.cwd, "nested") }, "session-2"); await assert.rejects(moving.refresh(), /context changed/);
});

test("deliberate collection edits reconcile only conflicting same-scope removal identities", async (t) => {
  const { editor, paths, input } = await fixture(t);
  await writeFile(paths.project, `route_tools = ["read", "bash"]
remove_route_tools = ["bash", "write"]
remove_pass_through_tools = ["host-tool"]
remove_host_env = ["FORWARD_ME", "KEEP_REMOVED"]
remove_secrets = ["TOKEN", "OTHER"]
remove_mounts = [{ guest_path = "/scratch/" }, { guest_path = "/other" }]
network.remove_allow_hosts = ["add.example", "keep.example"]
network.remove_publish_ports = ["8080", "9090"]
`);
  const draft = await editor.open("project");
  draft.set("route_tools", ["read", "bash"]); draft.set("host_env", ["FORWARD_ME"]);
  draft.upsertSecret({ env: "TOKEN", hostEnv: "NEW", allowHosts: ["a.example"] });
  draft.upsertMount({ type: "tmpfs", guestPath: "/scratch", readonly: true, options: [] });
  draft.set("network.allow_hosts", ["add.example"]); draft.set("network.publish_ports", ["8080"]);
  const preview = await draft.preview();
  assert.ok(preview.changes.some((change) => change.path === "remove_route_tools"));
  await draft.apply();
  const raw = parseTomlConfig(await readFile(paths.project, "utf8"), "project").value as any;
  assert.deepEqual(raw.removeRouteTools, ["write"]); assert.deepEqual(raw.removePassThroughTools, ["host-tool"]);
  assert.deepEqual(raw.removeHostEnv, ["KEEP_REMOVED"]); assert.deepEqual(raw.removeSecrets, ["OTHER"]);
  assert.deepEqual(raw.removeMounts, [{ guestPath: "/other" }]);
  assert.deepEqual(raw.network.removeAllowHosts, ["keep.example"]); assert.deepEqual(raw.network.removePublishPorts, ["9090"]);
  const effective = await resolveConfig(input); assert.deepEqual(effective.config.routeTools, ["read", "bash"]); assert.equal(effective.config.secrets[0]!.env, "TOKEN"); assert.equal(effective.config.mounts[0]!.guestPath, "/scratch");
});

test("collection reconciliation never clears higher-scope removals and scalar saves preserve raw controls", async (t) => {
  const { editor, input, paths } = await fixture(t);
  await writeFile(paths.project, 'remove_route_tools = ["bash"]\nremove_secrets = ["HIDDEN"]\n');
  const global = await editor.open("global"); global.set("route_tools", ["read", "bash"]);
  assert.ok((await global.preview()).shadowed.includes("route_tools")); await global.apply();
  assert.deepEqual((await resolveConfig(input)).config.routeTools, ["read"]);
  const scalar = await editor.open("project"); scalar.set("cpus", 2); await scalar.apply();
  const raw = parseTomlConfig(await readFile(paths.project, "utf8"), "project").value as any;
  assert.deepEqual(raw.removeRouteTools, ["bash"]); assert.deepEqual(raw.removeSecrets, ["HIDDEN"]);
});

async function scopedSecrets(t: TestContext) {
  const f = await fixture(t);
  await writeFile(f.paths.global, 'secrets = [{ env = "GLOBAL_ONLY", host_env = "GLOBAL_REF", allow_hosts = ["global.example"] }, { env = "GLOBAL_CMD", host_cmd = "printf GLOBAL_CMD_BYTES", allow_hosts = ["global.example"] }]\n');
  await writeFile(f.paths.project, 'secrets = [{ env = "EDIT", host_env = "EDIT_REF", allow_hosts = ["edit.example"] }, { env = "PRIVATE_LITERAL", text_value = "PRIVATE_LITERAL_BYTES", allow_hosts = ["private.example"] }, { env = "PRIVATE_CMD", host_cmd = "printf PRIVATE_CMD_BYTES", allow_hosts = ["private.example"] }]\n');
  return f;
}

test("entry-level global secret edits never promote unrelated project credentials or lose target-only entries", async (t) => {
  for (const action of ["edit", "add", "repeat"] as const) {
    const { editor, paths, input, root } = await scopedSecrets(t);
    const draft = await editor.open("temporary");
    if (action === "add") draft.upsertSecret({ env: "ADDED", hostEnv: "NEW_REF", allowHosts: ["new.example"] });
    else {
      draft.upsertSecret({ env: "EDIT", allowHosts: ["edited.example"] });
      if (action === "repeat") {
        draft.upsertSecret({ env: "EDIT", hostEnv: "REPLACED_REF", allowHosts: ["second.example"] });
        draft.upsertSecret({ env: "EDIT", allowHosts: ["final.example"] });
      }
    }
    const target = await draft.forScope("global"); const preview = await target.preview();
    assert.ok(preview.collections.every((intent) => intent.identities.every((id) => !id.startsWith("PRIVATE"))));
    if (action !== "add") { assert.equal(preview.collections[0]!.promoted, true); assert.equal(preview.collections[0]!.source, "host-project"); assert.equal(preview.collections[0]!.sourcePath, paths.project); }
    await target.apply();
    const text = await readFile(paths.global, "utf8"); const secrets = parseTomlConfig(text, "global").value.secrets!;
    assert.deepEqual(secrets.map((entry) => entry.env), ["GLOBAL_ONLY", "GLOBAL_CMD", action === "add" ? "ADDED" : "EDIT"]);
    assert.equal(secrets[1]!.hostCmd, "printf GLOBAL_CMD_BYTES");
    assert.equal(secrets[2]!.hostEnv, action === "add" ? "NEW_REF" : action === "repeat" ? "REPLACED_REF" : "EDIT_REF");
    assert.doesNotMatch(text, /PRIVATE_/);
    const other = join(root, "home/other"); await mkdir(other);
    const elsewhere = await resolveConfig({ ...input, cwd: other, repoRoot: other });
    assert.ok(elsewhere.config.secrets.every((secret) => !secret.env.startsWith("PRIVATE")));
    assert.deepEqual(editor.temporary(), {});
  }
});

test("secret deletion acts on the chosen scope and honestly reports a surviving higher-scope entry", async (t) => {
  const { editor, paths } = await scopedSecrets(t);
  const before = await readFile(paths.global, "utf8");
  const absent = await editor.open("temporary"); absent.removeSecret("EDIT");
  const absentGlobal = await absent.forScope("global"); const noOp = await absentGlobal.apply();
  assert.equal(noOp.saved, false); assert.ok(noOp.shadowed.includes("secrets[EDIT]")); assert.equal(noOp.collections[0]!.operation, "remove"); assert.equal(noOp.collections[0]!.shadowed, true);
  assert.equal(await readFile(paths.global, "utf8"), before);
  const addTarget = await editor.open("global"); addTarget.upsertSecret({ env: "EDIT", hostEnv: "GLOBAL_EDIT", allowHosts: ["global.example"] }); await addTarget.apply();
  const deleting = await editor.open("temporary"); deleting.removeSecret("EDIT"); const global = await deleting.forScope("global");
  const result = await global.apply(); assert.equal(result.saved, true); assert.ok(result.shadowed.includes("secrets[EDIT]"));
  const saved = parseTomlConfig(await readFile(paths.global, "utf8"), "global").value.secrets!;
  assert.deepEqual(saved.map((entry) => entry.env), ["GLOBAL_ONLY", "GLOBAL_CMD"]);
  assert.match(await readFile(paths.project, "utf8"), /env = "EDIT"/);
});

test("a deliberately edited project hostCmd is preserved without execution or copying other entries", async (t) => {
  const { editor, paths, root } = await scopedSecrets(t);
  const marker = join(root, "must-not-execute");
  const command = `touch ${JSON.stringify(marker)}`;
  await writeFile(paths.project, `secrets = [{ env = "EDIT", host_cmd = ${JSON.stringify(command)}, allow_hosts = ["edit.example"] }, { env = "PRIVATE_LITERAL", text_value = "PRIVATE_BYTES", allow_hosts = ["private.example"] }]`);
  const draft = await editor.open("temporary"); draft.upsertSecret({ env: "EDIT", allowHosts: ["edited.example"] });
  const global = await draft.forScope("global"); await global.apply();
  const saved = await readFile(paths.global, "utf8");
  assert.equal(parseTomlConfig(saved, "global").value.secrets!.find((secret) => secret.env === "EDIT")!.hostCmd, command);
  assert.doesNotMatch(saved, /PRIVATE_/);
  await assert.rejects(stat(marker), { code: "ENOENT" });
});

test("temporary entries are excluded from project/global baselines unless that identity is deliberately edited", async (t) => {
  for (const scope of ["project", "global"] as const) {
    const { editor, paths } = await scopedSecrets(t);
    const temp = await editor.open("temporary"); temp.upsertSecret({ env: "TEMP_ONLY", textValue: "TEMP_PRIVATE_BYTES", allowHosts: ["temp.example"] }); await temp.apply();
    const draft = await editor.open("temporary"); draft.upsertSecret({ env: "NEW", hostEnv: "NEW", allowHosts: ["new.example"] });
    const target = await draft.forScope(scope); await target.apply();
    const saved = await readFile(paths[scope], "utf8"); assert.doesNotMatch(saved, /TEMP_ONLY|TEMP_PRIVATE_BYTES/);
    const names = parseTomlConfig(saved, "global").value.secrets!.map((entry) => entry.env);
    assert.deepEqual(names, scope === "global" ? ["GLOBAL_ONLY", "GLOBAL_CMD", "NEW"] : ["EDIT", "PRIVATE_LITERAL", "PRIVATE_CMD", "NEW"]);
  }
});

test("new literal FILE-looking replacements stay literal across metadata edits and scope conversion", async (t) => {
  const { editor, paths } = await scopedSecrets(t);
  const draft = await editor.open("temporary");
  draft.upsertSecret({ env: "EDIT", textValue: "$FILE:replacement", allowHosts: ["a.example"] });
  draft.upsertSecret({ env: "EDIT", allowHosts: ["b.example"] });
  const target = await draft.forScope("global"); await target.apply();
  const saved = await readFile(paths.global, "utf8");
  assert.deepEqual(parseTomlConfig(saved, "global").value.secrets!.find((secret) => secret.env === "EDIT"),
    { env: "EDIT", textValue: "$FILE:replacement", allowHosts: ["b.example"] });
  assert.doesNotMatch(saved, /PRIVATE_/);
});

test("mount entry conversion preserves global mounts and never exports unrelated project/temp mounts", async (t) => {
  const { editor, paths } = await fixture(t);
  await writeFile(paths.global, 'mounts = [{ type = "tmpfs", guest_path = "/global", readonly = true }]\n');
  await writeFile(paths.project, 'mounts = [{ type = "tmpfs", guest_path = "/edit", readonly = true }, { type = "tmpfs", guest_path = "/mnt/private-data", readonly = true }]\n');
  const draft = await editor.open("temporary"); draft.upsertMount({ type: "tmpfs", guestPath: "/edit", readonly: false, options: [] });
  const target = await draft.forScope("global"); assert.equal((await target.preview()).collections[0]!.promoted, true); await target.apply();
  const mounts = parseTomlConfig(await readFile(paths.global, "utf8"), "global").value.mounts!;
  assert.deepEqual(mounts.map((mount) => mount.guestPath), ["/global", "/edit"]); assert.equal(mounts[1]!.readonly, false);
  const temp = await editor.open("temporary"); temp.upsertMount({ type: "tmpfs", guestPath: "/temp-only", readonly: true, options: [] }); await temp.apply();
  const add = await editor.open("temporary"); add.upsertMount({ type: "tmpfs", guestPath: "/added", readonly: true, options: [] });
  const project = await add.forScope("project"); await project.apply();
  assert.doesNotMatch(await readFile(paths.project, "utf8"), /temp-only/);
});

test("scalar-list entry conversion isolates all security-sensitive lists while explicit replacement/clear stay distinct", async (t) => {
  const cases = [
    ["network.allow_hosts", ["global.example"], ["edit.example", "private.example"], "chosen.example"],
    ["network.publish_ports", ["8080"], ["8081", "8082"], "9090"],
    ["host_env", ["GLOBAL_VAR"], ["EDIT_VAR", "PRIVATE_VAR"], "CHOSEN_VAR"],
    ["route_tools", ["read"], ["write", "edit"], "bash"],
    ["pass_through_tools", ["global-tool"], ["edit-tool", "private-tool"], "chosen-tool"],
  ] as const;
  for (const [path, lower, higher, chosen] of cases) {
    const { editor, paths } = await fixture(t);
    await writeFile(paths.global, `${path} = ${JSON.stringify(lower)}\n`); await writeFile(paths.project, `${path} = ${JSON.stringify(higher)}\n`);
    const draft = await editor.open("temporary"); draft.upsertListEntry(path, chosen, higher[0]);
    const target = await draft.forScope("global"); assert.equal((await target.preview()).collections[0]!.operation, "upsert"); await target.apply();
    const raw = parseTomlConfig(await readFile(paths.global, "utf8"), "global").value;
    const value = (path: string) => path.split(".").reduce((obj: any, key) => obj[key.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())], raw);
    assert.deepEqual(value(path), [...lower, chosen]);
    const clear = await editor.open("temporary"); clear.set(path, []); const cleared = await clear.forScope("global"); assert.equal((await cleared.preview()).collections[0]!.operation, "clear"); await cleared.apply();
    assert.match(await readFile(paths.global, "utf8"), /\[\]/);
    const replace = await editor.open("temporary"); replace.set(path, [chosen]); const replacement = await replace.forScope("global"); assert.equal((await replacement.preview()).collections[0]!.operation, "replace"); await replacement.apply();
  }
});

test("explicit secret clear/replacement never masquerades as entry CRUD", async (t) => {
  const { editor, paths } = await scopedSecrets(t);
  const draft = await editor.open("temporary"); draft.set("secrets", []); const clear = await draft.forScope("global");
  assert.equal((await clear.preview()).collections[0]!.operation, "clear"); await clear.apply();
  assert.deepEqual(parseTomlConfig(await readFile(paths.global, "utf8"), "global").value.secrets, []);
  const explicit = await editor.open("temporary"); explicit.set("secrets", [{ env: "ONLY", hostEnv: "ONLY", allowHosts: ["a.example"] }]); const replace = await explicit.forScope("global");
  assert.deepEqual((await replace.preview()).collections[0]!.identities, ["ONLY"]); assert.equal((await replace.preview()).collections[0]!.operation, "replace"); await replace.apply();
  assert.deepEqual(parseTomlConfig(await readFile(paths.global, "utf8"), "global").value.secrets!.map((secret) => secret.env), ["ONLY"]);
});

test("scope-safe intent replay retains masked-placeholder guards and does not block unrelated scalar repairs", async (t) => {
  const { editor, paths } = await fixture(t);
  await writeFile(paths.global, "cpus = 0\n"); await writeFile(paths.project, "cpus = 2\n");
  const draft = await editor.open("temporary");
  assert.throws(() => draft.upsertSecret({ env: "TOKEN", textValue: "<redacted>", allowHosts: ["a.example"] }), /masked/);
  const repair = await editor.open("global"); repair.set("cpus", 3); await repair.apply();
  assert.equal(parseTomlConfig(await readFile(paths.global, "utf8"), "global").value.cpus, 3);
});

test("read-only mount entry conversion never imports higher-scope filesystem paths", async (t) => {
  const { editor, input, paths } = await fixture(t);
  const globalPath = "/mnt/global-data", projectPath = "/mnt/project-data", privatePath = "/mnt/private-data", chosenPath = "/mnt/chosen-data";
  const mountPaths = new Set([globalPath, projectPath, privatePath, chosenPath]);
  const mount = (path: string) => ({ type: "dir" as const, hostPath: path, guestPath: path, readonly: true, options: [] });
  const toml = (paths: string[]) => `mounts = [${paths.map((path) => `{ host_path = ${JSON.stringify(path)}, guest_path = ${JSON.stringify(path)}, readonly = true }`).join(", ")}]\n`;
  input.realpath = async (path) => mountPaths.has(path) ? path : realpath(path);
  input.stat = async (path) => mountPaths.has(path) ? { isSocket: () => false } : stat(path);
  await writeFile(paths.global, toml([globalPath]));
  await writeFile(paths.project, toml([projectPath, privatePath]));
  const draft = await editor.open("temporary"); draft.upsertMount(mount(chosenPath), projectPath);
  const global = await draft.forScope("global"); await global.apply();
  const raw = await readFile(paths.global, "utf8");
  assert.deepEqual(parseTomlConfig(raw, "global").value.mounts, [mount(globalPath), mount(chosenPath)]);
  assert.ok(!raw.includes(privatePath));
});

test("removed host read-only option is not editable and unrelated saves preserve only inert raw data", async (t) => {
  const { editor, input, paths } = await fixture(t);
  assert.equal(Object.hasOwn(DEFAULT_CONFIG, "hostRoAllowlist"), false);
  assert.equal(SETTINGS_PATHS.includes("host_ro_allowlist"), false);
  assert.equal(Object.hasOwn(COLLECTION_REMOVALS, "host_ro_allowlist"), false);
  await writeFile(paths.global, 'host_ro_allowlist = ["/private/old-host-data"]\nremove_host_ro_allowlist = ["/private/ignored"]\nunknown_setting = "keep"\n');
  const draft = await editor.open("global");
  for (const path of ["host_ro_allowlist", "hostRoAllowlist"]) {
    assert.throws(() => draft.set(path, []), /unknown editable setting/);
    assert.throws(() => draft.inherit(path), /unknown editable setting/);
    assert.throws(() => draft.upsertListEntry(path, "/private/new"), /not an editable scalar list/);
    assert.throws(() => draft.removeListEntry(path, "/private/old-host-data"), /not an editable scalar list/);
  }
  draft.set("show_footer", false); await draft.apply();
  const saved = await readFile(paths.global, "utf8");
  assert.ok(saved.includes("/private/old-host-data"));
  assert.ok(saved.includes("unknown_setting"));
  const resolved = await resolveConfig(input);
  assert.deepEqual(resolved.config.mounts, []);
  assert.match(resolved.warnings.join("\n"), /unknown config key hostRoAllowlist/);
});

test("at-or-below-scope materialization preserves inherited environment secret source spelling", async (t) => {
  const { editor, input, paths } = await fixture(t);
  const inherited = [
    { env: "ENV_LITERAL", textValue: "$FILE:../env-token", allowHosts: ["env.example"] },
    { env: "ENV_CMD", hostCmd: "printf ENV_CMD_PRIVATE", allowHosts: ["env.example"] },
  ];
  input.env = { PI_MSB_SECRETS: JSON.stringify(inherited) };
  editor.configureSession(input, "session-1");
  const draft = await editor.open("temporary"); draft.upsertSecret({ env: "NEW", hostEnv: "RAW_ENV_REF", allowHosts: ["new.example"] });
  const global = await draft.forScope("global"); await global.apply();
  assert.deepEqual(parseTomlConfig(await readFile(paths.global, "utf8"), "global").value.secrets,
    [...inherited, { env: "NEW", hostEnv: "RAW_ENV_REF", allowHosts: ["new.example"] }]);
});

test("a specifically edited temporary entry may be promoted with an explicit origin warning, never its siblings", async (t) => {
  const { editor, paths } = await scopedSecrets(t);
  const temp = await editor.open("temporary");
  temp.upsertSecret({ env: "TEMP_EDIT", hostEnv: "TEMP_REF", allowHosts: ["temp.example"] });
  temp.upsertSecret({ env: "TEMP_PRIVATE", textValue: "TEMP_PRIVATE_BYTES", allowHosts: ["private.example"] }); await temp.apply();
  const draft = await editor.open("temporary"); draft.upsertSecret({ env: "TEMP_EDIT", allowHosts: ["edited.example"] });
  const global = await draft.forScope("global");
  const intent = (await global.preview()).collections[0]!; assert.equal(intent.promoted, true); assert.equal(intent.source, "temporary"); assert.deepEqual(intent.identities, ["TEMP_EDIT"]);
  await global.apply(); const text = await readFile(paths.global, "utf8"); assert.match(text, /TEMP_EDIT|TEMP_REF/); assert.doesNotMatch(text, /TEMP_PRIVATE|PRIVATE_LITERAL|PRIVATE_CMD/);
});

test("mount/list per-entry deletions preserve target siblings and report higher-scope survivors", async (t) => {
  const { editor, paths } = await fixture(t);
  await writeFile(paths.global, 'mounts = [{ type = "tmpfs", guest_path = "/mnt/delete", readonly = true }, { type = "tmpfs", guest_path = "/mnt/keep", readonly = true }]\nnetwork.allow_hosts = ["delete.example", "keep.example"]\n');
  await writeFile(paths.project, 'mounts = [{ type = "tmpfs", guest_path = "/mnt/delete", readonly = true }]\nnetwork.allow_hosts = ["delete.example", "private.example"]\n');
  const draft = await editor.open("temporary"); draft.removeMount("/mnt/delete"); draft.removeListEntry("network.allow_hosts", "delete.example");
  const global = await draft.forScope("global"); const preview = await global.preview();
  assert.ok(preview.shadowed.includes("mounts[/mnt/delete]")); assert.ok(preview.shadowed.includes("network.allow_hosts[delete.example]"));
  await global.apply(); const raw = parseTomlConfig(await readFile(paths.global, "utf8"), "global").value;
  assert.deepEqual(raw.mounts!.map((mount) => mount.guestPath), ["/mnt/keep"]); assert.deepEqual(raw.network!.allowHosts, ["keep.example"]);
});

test("symlinked host-selected agent anchor supports sparse saves in every scope and missing descendants", async (t) => {
  const { input, root } = await fixture(t);
  const target = join(root, "canonical-agent"); await mkdir(target);
  const alias = join(root, "agent-alias"); await symlink(target, alias);
  const selected = { ...input, agentDir: alias };
  const paths = await hostConfigPaths(selected);
  assert.equal(paths.global, join(target, "pi-microsandbox/default.toml"));
  const editor = new SettingsEditor(selected, "anchored");
  for (const [scope, field] of [["temporary", "show_footer"], ["project", "cpus"], ["global", "memory_mib"]] as const) {
    const draft = await editor.open(scope);
    draft.set(field, scope === "temporary" ? false : scope === "project" ? 2 : 2048);
    assert.equal((await draft.apply()).saved, true);
  }
  assert.equal(editor.temporary().showFooter, false);
  assert.deepEqual(parseTomlConfig(await readFile(paths.project, "utf8"), "project").value, { cpus: 2 });
  assert.deepEqual(parseTomlConfig(await readFile(paths.global, "utf8"), "global").value, { memoryMiB: 2048 });
  assert.equal((await resolveConfig(selected)).config.cpus, 2);
});

test("agent anchor retarget/replacement invalidates draft apply and scope conversion, including memory-only drafts", async (t) => {
  const { input, root } = await fixture(t);
  const target = join(root, "anchor-one"); const other = join(root, "anchor-two");
  await mkdir(target); await mkdir(other);
  const alias = join(root, "agent-alias"); await symlink(target, alias);
  const selected = { ...input, agentDir: alias };
  for (const scope of ["temporary", "project", "global"] as const) {
    const editor = new SettingsEditor(selected, "anchor");
    const draft = await editor.open(scope); draft.set("cpus", 2);
    await rm(alias); await symlink(other, alias);
    await assert.rejects(draft.apply(), /agent directory changed/);
    await assert.rejects(draft.forScope("global"), /agent directory changed/);
    await assert.rejects(draft.refresh(), /agent directory changed/);
    assert.deepEqual(editor.temporary(), {});
    await assert.rejects(stat(join(other, "pi-microsandbox")), { code: "ENOENT" });
    await rm(alias); await symlink(target, alias);
  }
  const editor = new SettingsEditor(selected, "replaced-link");
  const draft = await editor.open("project"); draft.set("cpus", 3);
  // Replacement pointing to the same target must also invalidate the old draft.
  await rm(alias); await symlink(target, alias);
  await assert.rejects(draft.apply(), /agent directory changed/);
  const canonicalReplacement = await editor.open("temporary"); canonicalReplacement.set("cpus", 3);
  await rename(target, `${target}-moved`); await mkdir(target);
  await assert.rejects(canonicalReplacement.apply(), /agent directory changed/);
});

test("agent aliases never hide lexical or canonical workspace/writable-mount exposure", async (t) => {
  const { input, root } = await fixture(t);
  const safe = join(root, "outside-agent"); await mkdir(safe);
  const insideAlias = join(input.cwd, "agent-link"); await symlink(safe, insideAlias);
  const outsideAlias = join(root, "workspace-link"); await symlink(input.cwd, outsideAlias);
  for (const agentDir of [insideAlias, outsideAlias]) {
    const editor = new SettingsEditor({ ...input, agentDir }, "unsafe-anchor");
    await assert.rejects(editor.open("temporary"), /outside the mounted workspace/);
  }
  const aliasParent = join(root, "mounted"); await mkdir(aliasParent);
  const alias = join(aliasParent, "agent"); await symlink(safe, alias);
  const selected = { ...input, agentDir: alias };
  const editor = new SettingsEditor(selected, "mounted-anchor");
  for (const hostPath of [safe, aliasParent]) {
    const draft = await editor.open("temporary");
    draft.set("mounts", [{ type: "dir", hostPath, guestPath: "/mnt/exposed", readonly: false, options: [] }]);
    await assert.rejects(draft.apply(), /writable host mounts must not expose host configuration/);
    assert.deepEqual(editor.temporary(), {});
  }
});

test("canonical agent anchor does not allow descendant/file symlinks or dangling root links", async (t) => {
  const { input, root } = await fixture(t);
  const target = join(root, "anchor"); await mkdir(target);
  const alias = join(root, "agent-alias"); await symlink(target, alias);
  const selected = { ...input, agentDir: alias };
  const editor = new SettingsEditor(selected, "descendants");
  const outside = join(root, "policy-data"); await mkdir(outside);
  await symlink(outside, join(target, "pi-microsandbox"));
  await assert.rejects(editor.open("global"), /could not be safely verified/);
  await rm(join(target, "pi-microsandbox")); await mkdir(join(target, "pi-microsandbox"));
  await writeFile(join(outside, "default.toml"), "cpus = 3\n");
  await symlink(join(outside, "default.toml"), join(target, "pi-microsandbox/default.toml"));
  await assert.rejects(editor.open("global"), /non-symlink/);
  await rm(alias); await symlink(join(root, "missing-agent"), alias);
  await assert.rejects(editor.open("project"), /could not be canonicalized/);
});

test("symlinked agent sparse saves preserve literal prefix values without reading credential files", async (t) => {
  for (const scope of ["global", "project"] as const) for (const value of ["$FILE:../../token", "$ENV:PRIVATE_TOKEN"]) {
    const { input, root } = await fixture(t);
    const target = join(root, "canonical-agent"); await mkdir(target);
    const alias = join(root, "agent-alias"); await symlink(target, alias);
    const selected = { ...input, agentDir: alias };
    const paths = await hostConfigPaths(selected); await mkdir(dirname(paths.project), { recursive: true });
    await writeFile(paths[scope], `secrets = [{ env = "TOKEN", text_value = ${JSON.stringify(value)}, allow_hosts = ["a.example"] }]\n`);
    const editor = new SettingsEditor(selected, "literal-prefix");
    const draft = await editor.open(scope); draft.set("show_footer", false); await draft.apply();
    assert.equal(draft.path, paths[scope]);
    const secret = (await resolveConfig(selected)).config.secrets[0]!;
    assert.equal(secret.textValue, value);
    assert.equal(await resolveSecretValue(secret, { PRIVATE_TOKEN: "must-not-expand" }), value);
    assert.equal(parseTomlConfig(await readFile(paths[scope], "utf8"), scope).value.secrets![0]!.textValue, value);
  }
});

test("cross-scope metadata and whole-list transfers preserve all secret sources verbatim", async (t) => {
  const sources = [{ textValue: "$FILE:../token" }, { textValue: "$ENV:TOKEN" }, { hostEnv: "PRIVATE_ENV" }, { hostCmd: "printf PRIVATE_CMD" }];
  for (const source of ["global", "project", "temporary"] as const) for (const destination of ["global", "project", "temporary"] as const) {
    if (source === destination) continue;
    for (const mode of ["metadata", "replacement", "whole-list"] as const) for (const credential of sources) {
      const { editor, paths } = await fixture(t);
      const original = { env: "TOKEN", ...credential, allowHosts: ["original.example"] };
      const initial = await editor.open(source); initial.upsertSecret(original); await initial.apply();
      const draft = await editor.open(source);
      const expectedSource = mode === "replacement" ? { hostCmd: "printf REPLACEMENT_PRIVATE" } : credential;
      if (mode === "whole-list") draft.set("secrets", [{ env: "TOKEN", ...expectedSource, allowHosts: ["transferred.example"] }]);
      else draft.upsertSecret({ env: "TOKEN", ...(mode === "replacement" ? expectedSource : {}), allowHosts: ["transferred.example"] });
      const transferred = await draft.forScope(destination);
      const refreshed = await transferred.refresh(); await refreshed.apply();
      const saved = destination === "temporary" ? editor.temporary().secrets : parseTomlConfig(await readFile(paths[destination], "utf8"), destination).value.secrets;
      assert.deepEqual(saved, [{ env: "TOKEN", ...expectedSource, allowHosts: ["transferred.example"] }], `${source} -> ${destination}: ${mode}`);
      if (source !== "temporary") assert.deepEqual(parseTomlConfig(await readFile(paths[source], "utf8"), source).value.secrets, [original]);
    }
  }
});

test("mount sources remain absolute-only independently of literal secret values", async (t) => {
  const { editor, input, paths, root } = await fixture(t);
  const token = join(root, "token"); await writeFile(token, "MOUNT_BYTES");
  const mount = await editor.open("global");
  mount.set("mounts", [{ type: "file", hostPath: "../../token", guestPath: "/mnt/token", readonly: true, options: [] }]);
  await assert.rejects(mount.apply(), /hostPath must be absolute/);
  const validMount = await editor.open("global");
  validMount.upsertMount({ type: "file", hostPath: token, guestPath: "/mnt/token", readonly: true, options: [] }); await validMount.apply();
  assert.equal((await resolveConfig(input)).config.mounts[0]!.hostPath, token);
  await writeFile(paths.global, 'mounts = [{ type = "file", host_path = "../../token", guest_path = "/mnt/token", readonly = true }]\n');
  await assert.rejects(resolveConfig(input), /hostPath must be absolute/);
});

async function nestedAgentAliasFixture(t: TestContext, chain: false | "absolute" | "relative" = false, missingSuffix = false) {
  const { root } = await fixture(t);
  const base = join(root, "case"); const home = join(base, "home"); const physicalHome = join(base, "real-home");
  const storeAgent = join(base, "store/agent"); const hops = join(base, "hops"); const cwd = join(base, "workspace");
  await mkdir(join(physicalHome, ".pi"), { recursive: true }); await mkdir(storeAgent, { recursive: true }); await mkdir(hops); await mkdir(cwd);
  if (chain) {
    await symlink(chain === "relative" ? "hops/home" : join(hops, "home"), home);
    await symlink(chain === "relative" ? "../real-home" : physicalHome, join(hops, "home"));
    await symlink(chain === "relative" ? "../../hops/agent" : join(hops, "agent"), join(physicalHome, ".pi/agent"));
    await symlink(chain === "relative" ? "../store/agent" : storeAgent, join(hops, "agent"));
  } else {
    await symlink(physicalHome, home); await symlink(storeAgent, join(physicalHome, ".pi/agent"));
  }
  const input: ResolveConfigInput = { cwd, homedir: home, agentDir: join(home, ".pi/agent", ...(missingSuffix ? ["future-anchor"] : [])), env: {}, projectTrusted: true, configDirName: ".pi" };
  const paths = await hostConfigPaths(input);
  if (!missingSuffix) { await mkdir(dirname(paths.global)); await writeFile(paths.global, "cpus = 3\n"); }
  await symlink(join(physicalHome, ".pi"), join(base, "pi-parent-alias"));
  const unsafe = [join(physicalHome, ".pi"), join(home, ".pi"), join(base, "pi-parent-alias"), ...(chain ? [hops] : [])];
  const siblings = [join(physicalHome, ".pi/cache"), join(hops, "unrelated"), join(storeAgent, "data")];
  for (const sibling of siblings) await mkdir(sibling);
  const mount = (hostPath: string, readonly = false) => ({ type: "dir" as const, hostPath, guestPath: "/mnt/agent-parent", readonly, options: [] });
  return { input, paths, unsafe, siblings, mount, hops };
}

test("nested agent aliases reject writable physical parents during resolution, including missing policy targets", async (t) => {
  for (const missingSuffix of [false, true]) {
    const f = await nestedAgentAliasFixture(t, false, missingSuffix);
    for (const hostPath of f.unsafe) await assert.rejects(resolveConfig({ ...f.input, temporaryOverrides: { mounts: [f.mount(hostPath)] } }), /writable host mounts must not expose host configuration/);
  }
});

test("nested agent aliases reject editor preview/save in every scope without writes", async (t) => {
  const f = await nestedAgentAliasFixture(t);
  const editor = new SettingsEditor(f.input, "nested-alias");
  for (const scope of ["temporary", "project", "global"] as const) for (const hostPath of f.unsafe) {
    const draft = await editor.open(scope); draft.set("mounts", [f.mount(hostPath)]);
    await assert.rejects(draft.preview(), /writable host mounts must not expose host configuration/);
    await assert.rejects(draft.apply(), /writable host mounts must not expose host configuration/);
    assert.deepEqual(editor.temporary(), {});
    assert.equal(await readFile(f.paths.global, "utf8"), "cpus = 3\n");
    await assert.rejects(stat(f.paths.project), { code: "ENOENT" });
  }
});

test("nested agent alias chains protect absolute/relative link hops while readonly parents and unrelated siblings stay mountable", async (t) => {
  for (const chain of ["absolute", "relative"] as const) for (const missingSuffix of [false, true]) {
    const f = await nestedAgentAliasFixture(t, chain, missingSuffix);
    const editor = new SettingsEditor(f.input, "alias-chain");
    for (const hostPath of f.unsafe) {
      await assert.rejects(resolveConfig({ ...f.input, temporaryOverrides: { mounts: [f.mount(hostPath)] } }), /writable host mounts must not expose host configuration/);
      const draft = await editor.open("temporary"); draft.set("mounts", [f.mount(hostPath)]);
      await assert.rejects(draft.preview(), /writable host mounts must not expose host configuration/);
      await assert.rejects(draft.apply(), /writable host mounts must not expose host configuration/);
      const readonly = await resolveConfig({ ...f.input, temporaryOverrides: { mounts: [f.mount(hostPath, true)] } });
      assert.equal(readonly.config.mounts[0]!.readonly, true);
    }
    for (const hostPath of f.siblings) {
      assert.equal((await resolveConfig({ ...f.input, temporaryOverrides: { mounts: [f.mount(hostPath)] } })).config.mounts[0]!.readonly, false);
      const draft = await editor.open("temporary"); draft.set("mounts", [f.mount(hostPath)]); await draft.preview(); await draft.apply();
      assert.equal(editor.temporary().mounts![0]!.hostPath, hostPath);
    }
  }
});

test("nested agent alias inspection fails closed on unexpected I/O, cycles and excessive dependencies", async (t) => {
  const f = await nestedAgentAliasFixture(t, "relative");
  const { promises: filesystem } = await import("node:fs");
  const readlink = filesystem.readlink.bind(filesystem);
  const inspection = t.mock.method(filesystem, "readlink", async (path: Parameters<typeof filesystem.readlink>[0]) => {
    if (String(path) === join(f.hops, "agent")) throw Object.assign(new Error("PRIVATE_IO_SENTINEL"), { code: "EACCES" });
    return readlink(path);
  });
  await assert.rejects(resolveConfig(f.input), /host configuration ancestors could not be inspected/);
  inspection.mock.restore();
  await rm(join(f.hops, "agent")); await symlink("agent", join(f.hops, "agent"));
  await assert.rejects(resolveConfig(f.input), /could not be canonicalized/);
  await assert.rejects(resolveConfig({ ...f.input, readFile: async () => null, realpath: async (path) => path }), /ancestor traversal cycle detected/);
  // Synthetic canonicalization keeps this bound test independent of OS path/symlink limits.
  await assert.rejects(resolveConfig({ ...f.input, agentDir: join(f.hops, ...Array<string>(260).fill("x")), realpath: async (path) => path }), /ancestor traversal limit exceeded/);
});

async function componentAgentAliasFixture(t: TestContext, absolute = true, missingSuffix = false) {
  const { root } = await fixture(t);
  const base = join(root, "component-case"); const home = join(base, "home");
  const physicalHome = join(base, "physical/real-home"); const storeAgent = join(base, "store/agent");
  const hops = join(base, "hops"); const routes = join(base, "routes"); const cwd = join(base, "workspace");
  for (const directory of [join(physicalHome, ".pi"), join(base, "physical/deep"), storeAgent, hops, routes, cwd]) await mkdir(directory, { recursive: true });
  // Keep raw target components: path.join/resolve would erase the critical jump/.. pair.
  await symlink(absolute ? `${base}/routes/jump/../real-home` : "./routes/./jump/../real-home", home);
  await symlink(absolute ? `${hops}/jump` : "../hops/./jump", join(routes, "jump"));
  await symlink(absolute ? `${base}/physical/deep` : "../physical/./deep", join(hops, "jump"));
  await symlink(absolute ? storeAgent : "../../../store/agent", join(physicalHome, ".pi/agent"));
  assert.equal(await realpath(home), physicalHome);
  const input: ResolveConfigInput = { cwd, homedir: home, agentDir: join(home, ".pi/agent", ...(missingSuffix ? ["future-anchor"] : [])), env: {}, projectTrusted: true, configDirName: ".pi" };
  const paths = await hostConfigPaths(input);
  if (!missingSuffix) { await mkdir(dirname(paths.global)); await writeFile(paths.global, "cpus = 3\n"); }
  const sibling = join(hops, "unrelated"); await mkdir(sibling);
  const mount = (hostPath = hops, readonly = false) => ({ type: "dir" as const, hostPath, guestPath: "/mnt/agent-parent", readonly, options: [] });
  return { input, paths, hops, routes, sibling, mount };
}

test("agent alias jump/.. traversal protects intermediate links before processing parent components", async (t) => {
  const f = await componentAgentAliasFixture(t);
  await assert.rejects(resolveConfig({ ...f.input, temporaryOverrides: { mounts: [f.mount()] } }), /writable host mounts must not expose host configuration/);
  const editor = new SettingsEditor(f.input, "component-alias");
  for (const scope of ["temporary", "project", "global"] as const) {
    const draft = await editor.open(scope); draft.set("mounts", [f.mount()]);
    await assert.rejects(draft.preview(), /writable host mounts must not expose host configuration/);
    await assert.rejects(draft.apply(), /writable host mounts must not expose host configuration/);
    assert.deepEqual(editor.temporary(), {});
    assert.equal(await readFile(f.paths.global, "utf8"), "cpus = 3\n");
    await assert.rejects(stat(f.paths.project), { code: "ENOENT" });
  }
});

test("agent alias raw components support dots, leading parents, absolute/relative targets and missing suffixes", async (t) => {
  for (const absolute of [true, false]) for (const missingSuffix of [false, true]) {
    const f = await componentAgentAliasFixture(t, absolute, missingSuffix);
    for (const hostPath of [f.hops, f.routes]) {
      await assert.rejects(resolveConfig({ ...f.input, temporaryOverrides: { mounts: [f.mount(hostPath)] } }), /writable host mounts must not expose host configuration/);
      assert.equal((await resolveConfig({ ...f.input, temporaryOverrides: { mounts: [f.mount(hostPath, true)] } })).config.mounts[0]!.readonly, true);
    }
    const editor = new SettingsEditor(f.input, "raw-component-alias");
    const draft = await editor.open("temporary"); draft.set("mounts", [f.mount(f.sibling)]); await draft.preview(); await draft.apply();
    assert.equal(editor.temporary().mounts![0]!.hostPath, f.sibling);
  }
});

for (const scope of ["global", "project"] as const) {
  test(`hidden ${scope} secret metadata retains only target-owned literal/hostEnv/hostCmd sources`, async (t) => {
    const { editor, paths } = await fixture(t);
    const raw = 'secrets = [{ env="LITERAL",text_value="HIDDEN_LITERAL_SENTINEL",allow_hosts=["a.example"] }, { env="ENV_TOKEN",host_env="PRIVATE_ENV",allow_hosts=["a.example"] }, { env="CMD_TOKEN",host_cmd="printf PRIVATE_CMD",allow_hosts=["a.example"] }]\n';
    await writeFile(paths[scope], raw);
    if (scope === "global") await writeFile(paths.project, 'secrets = []\n');
    const temp = await editor.open("temporary"); temp.set("secrets", []); await temp.apply();
    for (const env of ["LITERAL", "ENV_TOKEN", "CMD_TOKEN"]) {
      const draft = await editor.open(scope); draft.upsertSecret({ env, allowHosts: ["b.example"] });
      const preview = await draft.preview();
      assert.equal(preview.collections[0]!.source, scope === "global" ? "host-default" : "host-project");
      assert.equal(preview.collections[0]!.sourcePath, paths[scope]);
      assert.equal(preview.collections[0]!.promoted, false); assert.equal(preview.collections[0]!.shadowed, true);
      const review = await draft.reviewForApproval(preview.effect);
      assert.doesNotMatch(JSON.stringify(review), /HIDDEN_LITERAL_SENTINEL/);
      const storage = review.storage as { before: { secrets: Record<string, unknown>[] } };
      assert.equal(storage.before.secrets[1]!.host_env, "PRIVATE_ENV");
      assert.equal(storage.before.secrets[2]!.host_cmd, "printf PRIVATE_CMD");
      await draft.apply();
    }
    const saved = parseTomlConfig(await readFile(paths[scope], "utf8"), "global").value;
    assert.deepEqual(saved.secrets, [
      { env: "LITERAL", textValue: "HIDDEN_LITERAL_SENTINEL", allowHosts: ["b.example"] },
      { env: "ENV_TOKEN", hostEnv: "PRIVATE_ENV", allowHosts: ["b.example"] },
      { env: "CMD_TOKEN", hostCmd: "printf PRIVATE_CMD", allowHosts: ["b.example"] },
    ]);
    for (const action of ["remove", "clear", "replace", "inherit"] as const) {
      const draft = await editor.open(scope);
      if (action === "remove") draft.removeSecret("CMD_TOKEN");
      else if (action === "inherit") draft.inherit("secrets");
      else draft.set("secrets", action === "clear" ? [] : [{ env: "OTHER", textValue: "new", allowHosts: ["a.example"] }]);
      assert.throws(() => draft.upsertSecret({ env: "CMD_TOKEN", allowHosts: ["b.example"] }), /new secrets require/);
      draft.discard();
    }
  });
}

test("same-name visible higher-scope secret still takes precedence over hidden target-owned fallback", async (t) => {
  const { editor, paths } = await fixture(t);
  await writeFile(paths.global, 'secrets = [{env="TOKEN",text_value="target-private",allow_hosts=["a.example"]}]\n');
  await writeFile(paths.project, 'secrets = [{env="TOKEN",host_env="VISIBLE_PRIVATE",allow_hosts=["a.example"]}]\n');
  const draft = await editor.open("global"); draft.upsertSecret({ env: "TOKEN", allowHosts: ["b.example"] });
  const preview = await draft.preview(); assert.equal(preview.collections[0]!.promoted, true); assert.equal(preview.collections[0]!.source, "host-project");
  await draft.apply(); assert.equal(parseTomlConfig(await readFile(paths.global, "utf8"), "global").value.secrets![0]!.hostEnv, "VISIBLE_PRIVATE");
});
