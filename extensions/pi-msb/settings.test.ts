import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_CONFIG, hostConfigPaths, parseTomlConfig, readRawConfig, resolveConfig, type ResolveConfigInput } from "./config.ts";
import type { Config } from "./types.ts";

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
  const raw = `# original\ncpus = 3\nunknown_setting = { originalKey = "keep" }\nsecrets = [{ env = "TOKEN", value = "$FILE:token", allow_hosts = ["example.com"] }]\nnetwork.allow_dns = false\n`;
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
    'secrets = [{ env = "ONE", value = "$ENV:ONE", allow_hosts = ["a.example"] }, { env = "TWO", value = "$ENV:TWO", allow_hosts = ["b.example"] }]',
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
  assert.match(saved, /\[\[secrets\]\]\nenv = "ONE"\nvalue = "\$ENV:ONE"/);
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

test("secret CRUD is masked, keeps own relative references, and never materializes ENV or FILE", async (t) => {
  const { editor, paths } = await fixture(t);
  await writeFile(join(dirname(paths.project), "token"), "file-credential-sentinel");
  await writeFile(paths.project, `secrets = [{ env = "LITERAL", value = "literal-credential-sentinel", allow_hosts = ["a.example"] }, { env = "FILE", value = "$FILE:token", allow_hosts = ["a.example"] }]\n`);
  const draft = await editor.open("project");
  draft.upsertSecret({ env: "LITERAL", allowHosts: ["b.example"] });
  draft.upsertSecret({ env: "ENV_TOKEN", value: "$ENV:NOT_LOADED", allowHosts: ["c.example"] });
  const display = JSON.stringify([draft.snapshot(), await draft.preview()]);
  assert.ok(!display.includes("literal-credential-sentinel"));
  assert.ok(!display.includes("file-credential-sentinel"));
  await draft.apply();
  const saved = await readFile(paths.project, "utf8");
  assert.ok(saved.includes('"$FILE:token"'));
  assert.ok(saved.includes("literal-credential-sentinel"));
  assert.ok(saved.includes("$ENV:NOT_LOADED"));
  const remove = await editor.open("project"); remove.removeSecret("LITERAL"); await remove.apply();
  assert.ok(!(await readFile(paths.project, "utf8")).includes("literal-credential-sentinel"));
});

test("unchanged literal secrets are not copied into sparse files", async (t) => {
  const { editor, paths } = await fixture(t);
  await writeFile(paths.global, 'secrets = [{ env = "TOKEN", value = "literal-sentinel", allow_hosts = ["a.example"] }]\n');
  const draft = await editor.open("project"); draft.set("cpus", 2); await draft.apply();
  assert.ok(!(await readFile(paths.project, "utf8")).includes("literal-sentinel"));
});

test("cross-layer secret CRUD preserves FILE origin instead of rebasing to target", async (t) => {
  const { editor, paths } = await fixture(t);
  const token = join(dirname(paths.global), "token"); await writeFile(token, "secret");
  await writeFile(paths.global, 'secrets = [{ env = "TOKEN", value = "$FILE:token", allow_hosts = ["a.example"] }]');
  const draft = await editor.open("project"); draft.upsertSecret({ env: "TOKEN", allowHosts: ["b.example"] }); await draft.apply();
  assert.ok((await readFile(paths.project, "utf8")).includes(`$FILE:${token}`));
});

test("invalid/schema/null/mount candidates fail before disk or temporary changes", async (t) => {
  const { editor, paths, input } = await fixture(t);
  await writeFile(paths.project, "cpus = 2\n");
  for (const [key, value] of [["cpus", 0], ["lock_dir", 3], ["network.publish_ports", ["bad"]], ["sandbox_name", null], ["secrets", [{ env: "TOKEN", value: "secret", allowHosts: [] }]]] as const) {
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
  await assert.rejects(editor.open("project"), /non-symlink/);
  await rm(paths.project); await writeFile(paths.project, "cpus = 2\n");
  const late = await editor.open("project"); late.set("cpus", 5);
  const moved = `${dirname(paths.project)}-moved`;
  const { rename } = await import("node:fs/promises");
  await rename(dirname(paths.project), moved); await symlink(moved, dirname(paths.project));
  await assert.rejects(late.apply(), /non-symlink/);
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

test("retargeting relative secret references preserves their source origin", async (t) => {
  const { editor, paths } = await fixture(t);
  const token = join(dirname(paths.project), "token"); await writeFile(token, "secret");
  await writeFile(paths.project, 'secrets = [{ env = "TOKEN", value = "$FILE:token", allow_hosts = ["a.example"] }]');
  const draft = await editor.open("project"); draft.upsertSecret({ env: "TOKEN", allowHosts: ["b.example"] });
  const global = await draft.forScope("global"); await global.apply();
  assert.ok((await readFile(paths.global, "utf8")).includes(`$FILE:${token}`));
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
  assert.throws(() => draft.set("secrets", [{ env: "TOKEN", value: "<redacted>", allowHosts: ["a.example"] }]), /placeholders/);
  draft.discard();
  assert.throws(() => draft.set("cpus", 2), /closed/);
});

test("secret replacement survives repeated metadata-only edits in persistent and temporary drafts", async (t) => {
  for (const scope of ["project", "temporary"] as const) {
    const { editor, paths } = await fixture(t);
    if (scope === "project") await writeFile(paths.project, 'secrets = [{ env = "TOKEN", value = "$ENV:OLD", allow_hosts = ["old.example"] }]');
    else { const initial = await editor.open(scope); initial.upsertSecret({ env: "TOKEN", value: "$ENV:OLD", allowHosts: ["old.example"] }); await initial.apply(); }
    const draft = await editor.open(scope);
    draft.upsertSecret({ env: "TOKEN", value: "$ENV:NEW", allowHosts: ["first.example"] });
    draft.upsertSecret({ env: "TOKEN", allowHosts: ["second.example"] });
    draft.upsertSecret({ env: "RENAMED", allowHosts: ["third.example"] }, "TOKEN");
    assert.doesNotMatch(JSON.stringify(draft.snapshot().raw), /\$ENV:OLD|\$ENV:NEW/);
    await draft.apply();
    const saved = scope === "project" ? parseTomlConfig(await readFile(paths.project, "utf8"), "project").value.secrets : editor.temporary().secrets;
    assert.deepEqual(saved, [{ env: "RENAMED", value: "$ENV:NEW", allowHosts: ["third.example"] }]);
  }
});

test("same-identity draft refresh preserves private edits but rejects switched, ended or changed cwd contexts", async (t) => {
  const { editor, input } = await fixture(t);
  const draft = await editor.open("temporary"); draft.set("cpus", 2); draft.upsertSecret({ env: "TOKEN", value: "PRIVATE_SENTINEL", allowHosts: ["a.example"] });
  editor.configureSession(input, "session-1"); await assert.rejects(draft.preview(), /stale/);
  const refreshed = await draft.refresh(); assert.doesNotMatch(JSON.stringify(refreshed.snapshot()), /PRIVATE_SENTINEL/);
  await refreshed.apply(); assert.equal(editor.temporary().cpus, 2); assert.equal(editor.temporary().secrets![0]!.value, "PRIVATE_SENTINEL");
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
  draft.upsertSecret({ env: "TOKEN", value: "$ENV:NEW", allowHosts: ["a.example"] });
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
  await writeFile(join(dirname(f.paths.global), "global-token"), "GLOBAL_FILE_BYTES");
  await writeFile(join(dirname(f.paths.project), "private-token"), "PRIVATE_FILE_BYTES");
  await writeFile(join(dirname(f.paths.project), "edit-token"), "EDIT_FILE_BYTES");
  await writeFile(f.paths.global, 'secrets = [{ env = "GLOBAL_ONLY", value = "$ENV:GLOBAL_REF", allow_hosts = ["global.example"] }, { env = "GLOBAL_FILE", value = "$FILE:global-token", allow_hosts = ["global.example"] }]\n');
  await writeFile(f.paths.project, 'secrets = [{ env = "EDIT", value = "$ENV:EDIT_REF", allow_hosts = ["edit.example"] }, { env = "PRIVATE_LITERAL", value = "PRIVATE_LITERAL_BYTES", allow_hosts = ["private.example"] }, { env = "PRIVATE_FILE", value = "$FILE:private-token", allow_hosts = ["private.example"] }]\n');
  return f;
}

test("entry-level global secret edits never promote unrelated project credentials or lose target-only entries", async (t) => {
  for (const action of ["edit", "add", "repeat"] as const) {
    const { editor, paths, input, root } = await scopedSecrets(t);
    const draft = await editor.open("temporary");
    if (action === "add") draft.upsertSecret({ env: "ADDED", value: "$ENV:NEW_REF", allowHosts: ["new.example"] });
    else {
      draft.upsertSecret({ env: "EDIT", allowHosts: ["edited.example"] });
      if (action === "repeat") {
        draft.upsertSecret({ env: "EDIT", value: "$ENV:REPLACED_REF", allowHosts: ["second.example"] });
        draft.upsertSecret({ env: "EDIT", allowHosts: ["final.example"] });
      }
    }
    const target = await draft.forScope("global"); const preview = await target.preview();
    assert.ok(preview.collections.every((intent) => intent.identities.every((id) => !id.startsWith("PRIVATE"))));
    if (action !== "add") { assert.equal(preview.collections[0]!.promoted, true); assert.equal(preview.collections[0]!.source, "host-project"); assert.equal(preview.collections[0]!.sourcePath, paths.project); }
    await target.apply();
    const text = await readFile(paths.global, "utf8"); const secrets = parseTomlConfig(text, "global").value.secrets!;
    assert.deepEqual(secrets.map((entry) => entry.env), ["GLOBAL_ONLY", "GLOBAL_FILE", action === "add" ? "ADDED" : "EDIT"]);
    assert.equal(secrets[1]!.value, "$FILE:global-token");
    assert.equal(secrets[2]!.value, action === "add" ? "$ENV:NEW_REF" : action === "repeat" ? "$ENV:REPLACED_REF" : "$ENV:EDIT_REF");
    assert.doesNotMatch(text, /PRIVATE_|private-token|EDIT_FILE_BYTES|GLOBAL_FILE_BYTES/);
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
  const addTarget = await editor.open("global"); addTarget.upsertSecret({ env: "EDIT", value: "$ENV:GLOBAL_EDIT", allowHosts: ["global.example"] }); await addTarget.apply();
  const deleting = await editor.open("temporary"); deleting.removeSecret("EDIT"); const global = await deleting.forScope("global");
  const result = await global.apply(); assert.equal(result.saved, true); assert.ok(result.shadowed.includes("secrets[EDIT]"));
  const saved = parseTomlConfig(await readFile(paths.global, "utf8"), "global").value.secrets!;
  assert.deepEqual(saved.map((entry) => entry.env), ["GLOBAL_ONLY", "GLOBAL_FILE"]);
  assert.match(await readFile(paths.project, "utf8"), /env = "EDIT"/);
});

test("a deliberately edited project FILE reference retains origin without resolving bytes or copying other entries", async (t) => {
  const { editor, paths } = await scopedSecrets(t);
  const projectText = (await readFile(paths.project, "utf8")).replace("$ENV:EDIT_REF", "$FILE:edit-token"); await writeFile(paths.project, projectText);
  const draft = await editor.open("temporary"); draft.upsertSecret({ env: "EDIT", allowHosts: ["edited.example"] });
  const global = await draft.forScope("global"); await global.apply();
  const saved = await readFile(paths.global, "utf8");
  assert.ok(saved.includes(`$FILE:${join(dirname(paths.project), "edit-token")}`));
  assert.doesNotMatch(saved, /EDIT_FILE_BYTES|PRIVATE_|private-token/);
});

test("temporary entries are excluded from project/global baselines unless that identity is deliberately edited", async (t) => {
  for (const scope of ["project", "global"] as const) {
    const { editor, paths } = await scopedSecrets(t);
    const temp = await editor.open("temporary"); temp.upsertSecret({ env: "TEMP_ONLY", value: "TEMP_PRIVATE_BYTES", allowHosts: ["temp.example"] }); await temp.apply();
    const draft = await editor.open("temporary"); draft.upsertSecret({ env: "NEW", value: "$ENV:NEW", allowHosts: ["new.example"] });
    const target = await draft.forScope(scope); await target.apply();
    const saved = await readFile(paths[scope], "utf8"); assert.doesNotMatch(saved, /TEMP_ONLY|TEMP_PRIVATE_BYTES/);
    const names = parseTomlConfig(saved, "global").value.secrets!.map((entry) => entry.env);
    assert.deepEqual(names, scope === "global" ? ["GLOBAL_ONLY", "GLOBAL_FILE", "NEW"] : ["EDIT", "PRIVATE_LITERAL", "PRIVATE_FILE", "NEW"]);
  }
});

test("new relative FILE replacements retain session origin across repeated metadata edits and scope conversion", async (t) => {
  const { editor, input, paths } = await scopedSecrets(t); await writeFile(join(input.cwd, "replacement"), "NEVER_PERSIST_BYTES");
  const draft = await editor.open("temporary");
  draft.upsertSecret({ env: "EDIT", value: "$FILE:replacement", allowHosts: ["a.example"] });
  draft.upsertSecret({ env: "EDIT", allowHosts: ["b.example"] });
  const target = await draft.forScope("global"); await target.apply();
  const saved = await readFile(paths.global, "utf8"); assert.ok(saved.includes(`$FILE:${join(input.cwd, "replacement")}`)); assert.doesNotMatch(saved, /NEVER_PERSIST_BYTES|PRIVATE_/);
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
  const explicit = await editor.open("temporary"); explicit.set("secrets", [{ env: "ONLY", value: "$ENV:ONLY", allowHosts: ["a.example"] }]); const replace = await explicit.forScope("global");
  assert.deepEqual((await replace.preview()).collections[0]!.identities, ["ONLY"]); assert.equal((await replace.preview()).collections[0]!.operation, "replace"); await replace.apply();
  assert.deepEqual(parseTomlConfig(await readFile(paths.global, "utf8"), "global").value.secrets!.map((secret) => secret.env), ["ONLY"]);
});

test("scope-safe intent replay retains masked-placeholder guards and does not block unrelated scalar repairs", async (t) => {
  const { editor, paths } = await fixture(t);
  await writeFile(paths.global, "cpus = 0\n"); await writeFile(paths.project, "cpus = 2\n");
  const draft = await editor.open("temporary");
  assert.throws(() => draft.upsertSecret({ env: "TOKEN", value: "<redacted>", allowHosts: ["a.example"] }), /masked/);
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

test("allowed at-or-below-scope materialization anchors inherited environment FILE references to their actual origin", async (t) => {
  const { editor, input, paths, root } = await fixture(t);
  const token = join(root, "env-token"); await writeFile(token, "ENV_FILE_BYTES");
  input.env = { PI_MSB_SECRETS: JSON.stringify([{ env: "ENV_FILE", value: `$FILE:${relative(process.cwd(), token)}`, allowHosts: ["env.example"] }]) };
  editor.configureSession(input, "session-1");
  const draft = await editor.open("temporary"); draft.upsertSecret({ env: "NEW", value: "$ENV:RAW_ENV_REF", allowHosts: ["new.example"] });
  const global = await draft.forScope("global"); await global.apply();
  const saved = await readFile(paths.global, "utf8"); assert.ok(saved.includes(`$FILE:${token}`)); assert.ok(saved.includes("$ENV:RAW_ENV_REF")); assert.doesNotMatch(saved, /ENV_FILE_BYTES/);
});

test("a specifically edited temporary entry may be promoted with an explicit origin warning, never its siblings", async (t) => {
  const { editor, paths } = await scopedSecrets(t);
  const temp = await editor.open("temporary");
  temp.upsertSecret({ env: "TEMP_EDIT", value: "$ENV:TEMP_REF", allowHosts: ["temp.example"] });
  temp.upsertSecret({ env: "TEMP_PRIVATE", value: "TEMP_PRIVATE_BYTES", allowHosts: ["private.example"] }); await temp.apply();
  const draft = await editor.open("temporary"); draft.upsertSecret({ env: "TEMP_EDIT", allowHosts: ["edited.example"] });
  const global = await draft.forScope("global");
  const intent = (await global.preview()).collections[0]!; assert.equal(intent.promoted, true); assert.equal(intent.source, "temporary"); assert.deepEqual(intent.identities, ["TEMP_EDIT"]);
  await global.apply(); const text = await readFile(paths.global, "utf8"); assert.match(text, /TEMP_EDIT|\$ENV:TEMP_REF/); assert.doesNotMatch(text, /TEMP_PRIVATE|PRIVATE_LITERAL|PRIVATE_FILE/);
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
  await assert.rejects(editor.open("global"), /non-symlink/);
  await rm(join(target, "pi-microsandbox")); await mkdir(join(target, "pi-microsandbox"));
  await writeFile(join(outside, "default.toml"), "cpus = 3\n");
  await symlink(join(outside, "default.toml"), join(target, "pi-microsandbox/default.toml"));
  await assert.rejects(editor.open("global"), /non-symlink/);
  await rm(alias); await symlink(join(root, "missing-agent"), alias);
  await assert.rejects(editor.open("project"), /could not be canonicalized/);
});

async function upwardReferenceFixture(t: TestContext, scope: "global" | "project" | "temporary") {
  const { input, root } = await fixture(t);
  const lexicalAgent = join(root, "home/.pi/agent");
  const canonicalAgent = join(root, "srv/pi/agent");
  await mkdir(dirname(lexicalAgent), { recursive: true }); await mkdir(canonicalAgent, { recursive: true });
  await symlink(canonicalAgent, lexicalAgent);
  const selected = { ...input, agentDir: lexicalAgent };
  const paths = await hostConfigPaths(selected);
  const lexicalPaths = {
    global: join(lexicalAgent, "pi-microsandbox/default.toml"),
    project: join(lexicalAgent, "pi-microsandbox/projects/work/config.toml"),
  };
  const token = join(root, "home/.pi/token"); const replacement = join(root, "home/.pi/replacement");
  for (const [path, marker] of [[token, "ORIGINAL_TOKEN_MARKER"], [replacement, "ORIGINAL_REPLACEMENT_MARKER"], [join(root, "srv/pi/token"), "WRONG_TOKEN_MARKER"], [join(root, "srv/pi/replacement"), "WRONG_REPLACEMENT_MARKER"]]) await writeFile(path, marker);
  const origin = scope === "temporary" ? input.cwd : dirname(lexicalPaths[scope]);
  const reference = `$FILE:${relative(origin, token)}`;
  const replacementReference = `$FILE:${relative(origin, replacement)}`;
  const editor = new SettingsEditor(selected, "upward-reference");
  if (scope === "temporary") {
    const draft = await editor.open(scope); draft.upsertSecret({ env: "TOKEN", value: reference, allowHosts: ["original.example"] }); await draft.apply();
  } else {
    await mkdir(dirname(paths[scope]), { recursive: true });
    await writeFile(paths[scope], `secrets = [{ env = "TOKEN", value = ${JSON.stringify(reference)}, allow_hosts = ["original.example"] }]\n`);
  }
  const resolved = () => resolveConfig({ ...selected, temporaryOverrides: editor.temporary() });
  const rawSecrets = async (scope: "global" | "project" | "temporary") => scope === "temporary" ? editor.temporary().secrets! : parseTomlConfig(await readFile(paths[scope], "utf8"), "global").value.secrets!;
  return { input: selected, root, editor, paths, lexicalPaths, token, replacement, reference, replacementReference, resolved, rawSecrets };
}

test("symlinked agent startup and sparse saves preserve lexical upward FILE origins and raw spelling", async (t) => {
  const { resolveSecretValue } = await import("./config.ts");
  for (const scope of ["global", "project"] as const) {
    const f = await upwardReferenceFixture(t, scope);
    assert.equal((await f.resolved()).config.secrets[0]!.value, `$FILE:${f.token}`);
    assert.equal(await resolveSecretValue((await f.resolved()).config.secrets[0]!.value, {}), "ORIGINAL_TOKEN_MARKER");
    const draft = await f.editor.open(scope); draft.set("show_footer", false); await draft.apply();
    assert.equal((await f.rawSecrets(scope))[0]!.value, f.reference);
    assert.equal((await f.resolved()).config.secrets[0]!.value, `$FILE:${f.token}`);
    assert.equal(draft.path, f.paths[scope]); // I/O remains canonical, not the reference origin.
    await rm(join(f.root, "srv/pi/token"));
    assert.equal((await f.resolved()).config.secrets[0]!.value, `$FILE:${f.token}`);
  }
});

test("symlinked agent secret metadata/replacement edits and refresh retain lexical raw reference origins", async (t) => {
  for (const scope of ["global", "project", "temporary"] as const) {
    const f = await upwardReferenceFixture(t, scope);
    const draft = await f.editor.open(scope);
    draft.upsertSecret({ env: "TOKEN", allowHosts: ["metadata.example"] });
    const refreshed = await draft.refresh(); await refreshed.apply();
    assert.equal((await f.rawSecrets(scope))[0]!.value, f.reference);
    assert.equal((await f.resolved()).config.secrets[0]!.value, `$FILE:${f.token}`);
    const replacement = await f.editor.open(scope);
    replacement.upsertSecret({ env: "TOKEN", value: f.replacementReference, allowHosts: ["replacement.example"] });
    replacement.upsertSecret({ env: "TOKEN", allowHosts: ["retained.example"] });
    await replacement.apply();
    assert.equal((await f.rawSecrets(scope))[0]!.value, f.replacementReference);
    assert.equal((await f.resolved()).config.secrets[0]!.value, `$FILE:${f.replacement}`);
  }
});

test("symlinked agent cross-scope entry and whole-list transfers anchor FILE origins without copying bytes", async (t) => {
  for (const source of ["global", "project", "temporary"] as const) for (const destination of ["global", "project", "temporary"] as const) {
    if (source === destination) continue;
    for (const mode of ["metadata", "replacement", "whole-list"] as const) {
      const f = await upwardReferenceFixture(t, source);
      const draft = await f.editor.open(source);
      if (mode === "whole-list") draft.set("secrets", [{ env: "TOKEN", value: f.reference, allowHosts: ["whole.example"] }]);
      else draft.upsertSecret({ env: "TOKEN", ...(mode === "replacement" ? { value: f.replacementReference } : {}), allowHosts: ["transferred.example"] });
      const transferred = await draft.forScope(destination);
      if (mode !== "whole-list" && source !== "temporary") assert.equal((await transferred.preview()).collections[0]!.sourcePath, f.lexicalPaths[source]);
      await transferred.apply();
      const expected = mode === "replacement" ? f.replacement : f.token;
      assert.equal((await f.rawSecrets(destination))[0]!.value, `$FILE:${expected}`, `${source} -> ${destination}: ${mode}`);
      if (source !== "temporary") assert.equal((await f.rawSecrets(source))[0]!.value, f.reference);
      assert.doesNotMatch(JSON.stringify(await f.rawSecrets(destination)), /ORIGINAL_.*MARKER|WRONG_.*MARKER/);
      // A promoted global entry may be shadowed here; inspect that target without the higher project layer.
      const elsewhere = join(f.root, "home/elsewhere"); await mkdir(elsewhere);
      const targetResolved = destination === "global" ? await resolveConfig({ ...f.input, cwd: elsewhere, repoRoot: elsewhere }) : destination === "project" ? await resolveConfig(f.input) : await f.resolved();
      assert.equal(targetResolved.config.secrets[0]!.value, `$FILE:${expected}`, `${source} -> ${destination}: ${mode}`);
    }
  }
});

test("symlinked agent inherited secret materialization keeps lexical FILE identity and absolute-only mount sources", async (t) => {
  const f = await upwardReferenceFixture(t, "global");
  const draft = await f.editor.open("temporary"); draft.upsertSecret({ env: "NEW", value: "$ENV:NEW_TOKEN", allowHosts: ["new.example"] });
  const global = await draft.forScope("global"); await global.apply();
  assert.equal((await f.rawSecrets("global"))[0]!.value, f.reference);
  assert.equal((await f.resolved()).config.secrets[0]!.value, `$FILE:${f.token}`);
  const inherited = await f.editor.open("project"); inherited.upsertSecret({ env: "TOKEN", allowHosts: ["project.example"] }); await inherited.apply();
  assert.equal((await f.rawSecrets("project"))[0]!.value, `$FILE:${f.token}`);
  const mount = await f.editor.open("global");
  mount.set("mounts", [{ type: "file", hostPath: "../../token", guestPath: "/mnt/token", readonly: true, options: [] }]);
  await assert.rejects(mount.apply(), /hostPath must be absolute/);
  const validMount = await f.editor.open("global");
  validMount.upsertMount({ type: "file", hostPath: f.token, guestPath: "/mnt/token", readonly: true, options: [] }); await validMount.apply();
  assert.equal((await f.resolved()).config.mounts[0]!.hostPath, f.token);
  await writeFile(f.paths.global, 'mounts = [{ type = "file", host_path = "../../token", guest_path = "/mnt/token", readonly = true }]\n');
  await assert.rejects(resolveConfig(f.input), /hostPath must be absolute/);
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
  test(`hidden ${scope} secret metadata retains only target-owned literal/ENV/relative FILE credentials and origins`, async (t) => {
    const { editor, paths } = await fixture(t);
    await writeFile(join(dirname(paths[scope]), "private-token"), "HIDDEN_BYTES_SENTINEL");
    const raw = 'secrets = [{ env="LITERAL",value="HIDDEN_LITERAL_SENTINEL",allow_hosts=["a.example"] }, { env="ENV_TOKEN",value="$ENV:PRIVATE_ENV",allow_hosts=["a.example"] }, { env="FILE",value="$FILE:private-token",allow_hosts=["a.example"] }]\n';
    await writeFile(paths[scope], raw);
    if (scope === "global") await writeFile(paths.project, 'secrets = []\n');
    const temp = await editor.open("temporary"); temp.set("secrets", []); await temp.apply();
    for (const env of ["LITERAL", "ENV_TOKEN", "FILE"]) {
      const draft = await editor.open(scope); draft.upsertSecret({ env, allowHosts: ["b.example"] });
      const preview = await draft.preview();
      assert.equal(preview.collections[0]!.source, scope === "global" ? "host-default" : "host-project");
      assert.equal(preview.collections[0]!.sourcePath, paths[scope]);
      assert.equal(preview.collections[0]!.promoted, false); assert.equal(preview.collections[0]!.shadowed, true);
      const review = await draft.reviewForApproval(preview.effect);
      assert.doesNotMatch(JSON.stringify(review), /HIDDEN_LITERAL_SENTINEL|HIDDEN_BYTES_SENTINEL|\$FILE:|\$ENV:/);
      await draft.apply();
    }
    const saved = parseTomlConfig(await readFile(paths[scope], "utf8"), "global").value;
    assert.deepEqual(saved.secrets!.map((secret) => secret.value), ["HIDDEN_LITERAL_SENTINEL", "$ENV:PRIVATE_ENV", "$FILE:private-token"]);
    assert.deepEqual(saved.secrets!.map((secret) => secret.env), ["LITERAL", "ENV_TOKEN", "FILE"]);
    for (const action of ["remove", "clear", "replace", "inherit"] as const) {
      const draft = await editor.open(scope);
      if (action === "remove") draft.removeSecret("FILE");
      else if (action === "inherit") draft.inherit("secrets");
      else draft.set("secrets", action === "clear" ? [] : [{ env: "OTHER", value: "new", allowHosts: ["a.example"] }]);
      assert.throws(() => draft.upsertSecret({ env: "FILE", allowHosts: ["b.example"] }), /new secrets require/);
      draft.discard();
    }
  });
}

test("same-name visible higher-scope secret still takes precedence over hidden target-owned fallback", async (t) => {
  const { editor, paths } = await fixture(t);
  await writeFile(paths.global, 'secrets = [{env="TOKEN",value="target-private",allow_hosts=["a.example"]}]\n');
  await writeFile(paths.project, 'secrets = [{env="TOKEN",value="$ENV:VISIBLE_PRIVATE",allow_hosts=["a.example"]}]\n');
  const draft = await editor.open("global"); draft.upsertSecret({ env: "TOKEN", allowHosts: ["b.example"] });
  const preview = await draft.preview(); assert.equal(preview.collections[0]!.promoted, true); assert.equal(preview.collections[0]!.source, "host-project");
  await draft.apply(); assert.equal(parseTomlConfig(await readFile(paths.global, "utf8"), "global").value.secrets![0]!.value, "$ENV:VISIBLE_PRIVATE");
});
