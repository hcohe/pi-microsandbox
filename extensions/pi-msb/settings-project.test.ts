import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { hostConfigPaths, hostConfigTargets, readRawConfig, resolveConfig, type ResolveConfigInput } from "./config.ts";
import { SettingsEditor, SettingsConflictError } from "./settings.ts";
import { approveProjectSettings, prepareProjectSettings, projectSettingsLabels, discardProjectCandidates } from "./settings-project.ts";
import { registerConfigTools } from "./settings-tools.ts";
import { createMsbIntegration } from "./control.ts";
import { fakeSdk } from "../../test/fake-msb-sdk.ts";
import type { MsbControl } from "./types.ts";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-msb-project-save-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, "pi-microsandbox");
  const linked = join(root, "external", "remove-in-repo-config");
  await mkdir(join(main, ".git"), { recursive: true });
  const register = async (cwd: string, name: string) => {
    const registration = join(main, ".git", "worktrees", name);
    await mkdir(registration, { recursive: true }); await mkdir(cwd, { recursive: true });
    await writeFile(join(registration, "commondir"), "../..\n");
    await writeFile(join(registration, "gitdir"), `${join(cwd, ".git")}\n`);
    await writeFile(join(cwd, ".git"), `gitdir: ${registration}\n`);
    return registration;
  };
  const registration = await register(linked, "feature");
  const input: ResolveConfigInput = { cwd: linked, homedir: root, agentDir: join(root, "agent"), env: {}, projectTrusted: true, configDirName: ".pi" };
  const paths = await hostConfigPaths(input);
  const editor = new SettingsEditor(input, "one");
  const save = async (scope: "project" | "global", path: string, value: unknown) => {
    const draft = await editor.open(scope); draft.set(path, value);
    const preview = await draft.preview(); const review = await draft.reviewForApproval(preview.effect);
    const result = await draft.apply(); await result.assertUnchanged?.();
    return { result, review };
  };
  return { root, main, linked, registration, input, paths, editor, register, save };
}
const labels = ["No", "Apply shared Project (pi-microsandbox)"];

test("settings Project shared save atomically catalogs metadata, covers future external worktrees", async (t) => {
  const f = await fixture(t);
  await assert.rejects(readdir(f.input.agentDir!), { code: "ENOENT" });
  const initialTargets = await hostConfigTargets(f.input);
  assert.ok(initialTargets.repository);
  assert.equal((await hostConfigPaths({ ...f.input, cwd: f.main })).project, f.paths.project);
  const shared = await f.save("project", "cpus", 3);
  assert.equal(shared.result.saved, true);
  assert.deepEqual({ ...(readRawConfig(await readFile(f.paths.project, "utf8"))._repository as any) }, initialTargets.repository);
  assert.equal((await resolveConfig({ ...f.input, cwd: f.main })).config.cpus, 3);
  const future = join(f.root, "new", "ephemeral"); await f.register(future, "new-registration");
  assert.equal((await resolveConfig({ ...f.input, cwd: future })).config.cpus, 3);
  const shadowed = await f.save("project", "cpus", 6);
  assert.deepEqual(shadowed.result.shadowed, []);
  assert.equal((await resolveConfig(f.input)).config.cpus, 6);
  assert.equal((await resolveConfig({ ...f.input, cwd: future })).config.cpus, 6);
  await f.save("project", "memory_mib", 2048);
  const resolved = await resolveConfig(f.input);
  assert.equal(resolved.config.memoryMiB, 2048);
  assert.equal(resolved.provenance.cpus, "host-project");
  assert.equal(resolved.provenance.memoryMiB, "host-project");
  const inspected = await f.editor.inspect();
  assert.equal((inspected.layers as any).worktree, undefined);
  assert.equal(JSON.stringify(inspected).includes("_repository"), false);
  assert.deepEqual((await f.editor.open("project")).snapshot().raw, { cpus: 6, memory_mib: 2048 });
  const nested = join(f.linked, "nested"); await mkdir(nested);
  assert.equal((await hostConfigTargets({ ...f.input, cwd: nested })).paths.project, f.paths.project);
  assert.equal((await resolveConfig({ ...f.input, cwd: nested })).config.cpus, 6);
});

test("settings Project shared save from main uses the same catalog artifact", async (t) => {
  const f = await fixture(t);
  const input = { ...f.input, cwd: f.main };
  const paths = await hostConfigPaths(input);
  const editor = new SettingsEditor(input, "main"); const draft = await editor.open("project"); draft.set("cpus", 2);
  const options = await prepareProjectSettings(draft, (candidate) => candidate.preview());
  const candidates = options;
  assert.equal(candidates?.length, 1);
  assert.deepEqual(candidates![0]!.preview.shadowed, []);
  const applied = await candidates![0]!.draft.apply(); await applied.assertUnchanged?.();
  assert.equal(paths.project, f.paths.project);
  assert.equal((await resolveConfig(input)).config.cpus, 2);
  assert.equal((await resolveConfig(f.input)).config.cpus, 2);
  discardProjectCandidates(candidates);
});

test("repository catalog survives deleted checkout .git, rejects root conflicts, and respects nearer nested Git boundaries", async (t) => {
  const f = await fixture(t); await f.save("project", "cpus", 6);
  await rm(join(f.linked, ".git"));
  assert.equal((await resolveConfig(f.input)).config.cpus, 6);
  const fresh = new SettingsEditor(f.input, "new-process");
  assert.equal((await fresh.open("project")).path, f.paths.project);
  const next = join(f.root, "future-deleted-pointer"); await f.register(next, "future"); await rm(join(next, ".git"));
  assert.equal((await resolveConfig({ ...f.input, cwd: next })).config.cpus, 6);
  await writeFile(join(f.linked, ".git"), "gitdir: /nonexistent/conflicting\n");
  await assert.rejects(resolveConfig(f.input), /could not be safely verified/);
  await rm(join(f.linked, ".git"));
  const nested = join(f.linked, "nested"); await mkdir(join(nested, ".git"), { recursive: true });
  assert.notEqual((await resolveConfig({ ...f.input, cwd: nested })).config.cpus, 6);
  await rm(join(nested, ".git"), { recursive: true }); await mkdir(join(nested, "objects")); await mkdir(join(nested, "refs")); await writeFile(join(nested, "HEAD"), "ref: refs/heads/main\n");
  assert.notEqual((await resolveConfig({ ...f.input, cwd: nested })).config.cpus, 6);
  await mkdir(join(f.linked, ".git"));
  await assert.rejects(resolveConfig(f.input), /could not be safely verified/);
});

test("repository catalog refuses invalid metadata/path, symlinked catalog records, oversized config and nonreciprocal registered checkouts", async (t) => {
  const f = await fixture(t); await f.save("project", "cpus", 4);
  const original = await readFile(f.paths.project, "utf8");
  await writeFile(f.paths.project, original.replace("version = 1", "version = 2"));
  await assert.rejects(resolveConfig(f.input), /could not be safely verified/);
  await writeFile(f.paths.project, "x".repeat(1024 * 1024 + 1));
  await assert.rejects(resolveConfig(f.input), /could not be safely verified/);
  await writeFile(f.paths.project, original);
  const fake = join(dirname(dirname(f.paths.project)), "wrong-record"); await mkdir(fake); await writeFile(join(fake, "config.toml"), original);
  await assert.rejects(resolveConfig(f.input), /could not be safely verified/); await rm(fake, { recursive: true });
  const saved = join(f.root, "saved"); await rename(dirname(f.paths.project), saved); await symlink(saved, dirname(f.paths.project));
  await assert.rejects(resolveConfig(f.input), /could not be safely verified/);
  await rm(dirname(f.paths.project)); await rename(saved, dirname(f.paths.project));
  const forged = join(f.root, "forged"); await mkdir(forged); await writeFile(join(forged, ".git"), await readFile(join(f.linked, ".git")));
  await assert.rejects(resolveConfig({ ...f.input, cwd: forged }), /could not be safely verified/);
});

for (const scope of ["project", "temporary"] as const) test(`settings ${scope} approval pins absent Git metadata and cwd inode, not just policy file content`, async (t) => {
  const f = await fixture(t);
  const draft = await f.editor.open(scope); draft.set("show_footer", false);
  const preview = await draft.preview(); await draft.reviewForApproval(preview.effect);
  await writeFile(join(f.registration, "gitdir"), `${join(f.linked, ".git")}\n\n`);
  await assert.rejects(draft.apply(), SettingsConflictError);
  const fresh = await f.editor.open(scope); fresh.set("show_footer", false);
  await fresh.reviewForApproval((await fresh.preview()).effect);
  await rename(f.linked, `${f.linked}-old`); await mkdir(f.linked); await writeFile(join(f.linked, ".git"), `gitdir: ${f.registration}\n`);
  await assert.rejects(fresh.apply(), SettingsConflictError);
  await assert.rejects(readFile(f.paths.project), { code: "ENOENT" });
});

test("settings Project post-commit activation guard rejects catalog and registration retargets", async (t) => {
  const f = await fixture(t); const draft = await f.editor.open("project"); draft.set("cpus", 3);
  await draft.reviewForApproval((await draft.preview()).effect); const result = await draft.apply();
  await result.assertUnchanged?.();
  await writeFile(join(f.registration, "gitdir"), join(f.main, ".git"));
  await assert.rejects(result.assertUnchanged!());
});

test("retired persistent Worktree scope is rejected, never broadened into Project", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.editor.open("worktree" as any), /invalid settings scope/);
  await assert.rejects(readFile(f.paths.project), { code: "ENOENT" });
});

for (const mode of ["tui", "rpc"]) test(`settings Project ${mode} exact No-first native destination menu and selected prepared candidate only`, async (t) => {
  const f = await fixture(t);
  const tools = new Map<string, ToolDefinition>(); let reloads = 0;
  let resolved = await resolveConfig(f.input);
  const control = { settings: f.editor, getState: () => ({ status: "off", info: null }), getEffectiveConfig: () => resolved,
    previewSettings: (draft: any) => draft.preview(resolved.config), reload: async (options: any) => { await options?.guard?.(); reloads++; resolved = await resolveConfig(f.input); } } as unknown as MsbControl;
  registerConfigTools({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI, control);
  let answer: string | undefined; let calls = 0;
  const ctx = { hasUI: true, mode, cwd: f.linked, sessionManager: { getSessionId: () => "one" }, ui: {
    theme: { fg: (_role: string, text: string) => text, bold: (text: string) => text },
    select: async (question: string, choices: string[], options: any) => {
      calls++; assert.deepEqual(choices, labels); assert.ok(options.signal); assert.match(question, /Settings file:.*projects/); assert.doesNotMatch(question, /Only for .*worktree/); return answer;
    } } } as unknown as ExtensionToolContext;
  const call = () => tools.get("msb_config_set")!.execute("id", { scope: "project", path: "cpus", operation: "set", value: 4 }, undefined, undefined, ctx) as Promise<any>;
  for (answer of [undefined, "No", "Yes", "unexpected", "Yes (Only for remove-in-repo-config worktree)", "Yes (For pi-microsandbox and all its worktrees)"]) {
    assert.equal((await call()).details.outcome, "cancelled"); assert.equal(reloads, 0);
    await assert.rejects(readFile(f.paths.project), { code: "ENOENT" });
  }
  answer = labels[1]; const shared = await call(); assert.equal(shared.details.outcome, "applied"); assert.equal(shared.details.review.scope, "project"); assert.deepEqual(shared.details.review.shadowed, []);
  assert.equal(readRawConfig(await readFile(f.paths.project, "utf8")).cpus, 4);
  assert.equal(reloads, 1); assert.equal(calls, 7);
});

test("settings Project approval safe labels, private host command appendix, no UI/abort and oversized reviews", async (t) => {
  assert.deepEqual(projectSettingsLabels({ repositoryName: "repo\u202e\nname" }), ["Apply shared Project (repo  name)"]);
  const f = await fixture(t); const draft = await f.editor.open("project");
  draft.upsertSecret({ env: "LITERAL", textValue: "PRIVATE_COMMAND", allowHosts: ["api.example"] });
  draft.upsertSecret({ env: "TOKEN", hostCmd: "printf 'PRIVATE_COMMAND'", allowHosts: ["api.example"] });
  const candidates = (await prepareProjectSettings(draft, (candidate) => candidate.preview()))!;
  assert.doesNotMatch(JSON.stringify(candidates.map((candidate) => candidate.review)), /PRIVATE_COMMAND/);
  let calls = 0; const abort = new AbortController();
  const ctx = { hasUI: true, mode: "rpc", ui: { select: async (question: string, choices: string[]) => {
    calls++; assert.match(question, /PRIVATE_COMMAND/); assert.match(question, /HOST secret commands/); abort.abort(); return choices[1];
  } } } as unknown as ExtensionToolContext;
  assert.equal(await approveProjectSettings({ ...ctx, hasUI: false }, candidates, abort.signal), undefined);
  assert.equal(await approveProjectSettings({ ...ctx, mode: "json" as any }, candidates, abort.signal), undefined);
  assert.equal(await approveProjectSettings(ctx, candidates, abort.signal), undefined); assert.equal(calls, 1);
  assert.equal(await approveProjectSettings(ctx, candidates, abort.signal), undefined); assert.equal(calls, 1);
  candidates.forEach((candidate) => candidate.draft.discard());
  const huge = await f.editor.open("project"); huge.upsertSecret({ env: "HUGE", hostCmd: "x".repeat(49_000), allowHosts: ["api.example"] });
  await assert.rejects(prepareProjectSettings(huge, (candidate) => candidate.preview()), /too large/);
});


test("real Git in-repository .worktrees shared save, sibling discovery and fresh load after gitfile deletion", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-msb-real-inrepo-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, "repository"); await mkdir(main);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], { cwd: main, env, stdio: "pipe" });
  git("init", "--initial-branch=main"); git("commit", "--allow-empty", "-m", "initial");
  const linked = join(main, ".worktrees", "remove-in-repo-config"); git("worktree", "add", "-b", "feature", linked);
  const input: ResolveConfigInput = { cwd: linked, homedir: root, agentDir: join(root, "agent"), env: {}, projectTrusted: true, configDirName: ".pi" };
  const editor = new SettingsEditor(input, "inrepo"); const shared = await editor.open("project"); shared.set("cpus", 3);
  await shared.reviewForApproval((await shared.preview()).effect); const result = await shared.apply(); await result.assertUnchanged?.();
  assert.equal((await resolveConfig(input)).config.cpus, 3);
  const sibling = join(main, ".worktrees", "new-ephemeral"); git("worktree", "add", "-b", "future", sibling);
  assert.equal((await resolveConfig({ ...input, cwd: sibling })).config.cpus, 3);
  await rm(join(linked, ".git"));
  assert.equal((await resolveConfig(input)).config.cpus, 3);
  assert.equal((await new SettingsEditor(input, "fresh").open("project")).path, (await hostConfigPaths(input)).project);
  const nested = join(linked, "nested"); await mkdir(nested);
  assert.equal((await hostConfigTargets({ ...input, cwd: nested })).paths.project, (await hostConfigPaths(input)).project);
  const submodule = join(main, "submodule"); const submoduleGit = join(main, ".git", "modules", "submodule");
  await mkdir(submodule); await mkdir(submoduleGit, { recursive: true }); await writeFile(join(submodule, ".git"), `gitdir: ${submoduleGit}\n`);
  const submoduleInput = { ...input, cwd: submodule };
  assert.equal((await hostConfigTargets(submoduleInput)).repository, undefined);
  assert.notEqual((await resolveConfig(submoduleInput)).config.cpus, 3);
});


test("Project repair only changes shared Project", async (t) => {
  const f = await fixture(t); await f.save("project", "cpus", 2);
  await writeFile(f.paths.project, (await readFile(f.paths.project, "utf8")).replace("cpus = 2", "cpus = 0"));
  const draft = await f.editor.open("project"); draft.set("cpus", 3);
  await draft.reviewForApproval((await draft.preview()).effect); await draft.apply();
  assert.equal((await resolveConfig(f.input)).config.cpus, 3);
});

test("repository catalog reserves ALL proof trees against unrelated writable mounts, but main default cwd remains valid", async (t) => {
  const f = await fixture(t); await f.save("project", "allow_host_execution", true);
  const unrelated = join(f.root, "unrelated"); await mkdir(unrelated);
  const input = { ...f.input, cwd: unrelated };
  assert.equal((await hostConfigTargets(input)).repository, undefined);
  for (const hostPath of [f.main, join(f.main, ".git"), join(f.main, ".git", "worktrees"), f.registration]) {
    await assert.rejects(resolveConfig({ ...input, temporaryOverrides: { mounts: [{ type: "dir", hostPath, guestPath: "/mnt/foreign-proof", readonly: false, options: [] }] } }), /writable host mounts must not expose host configuration/);
  }
  await resolveConfig({ ...input, temporaryOverrides: { mounts: [{ type: "dir", hostPath: f.registration, guestPath: "/mnt/read-only-proof", readonly: true, options: [] }] } });
  await resolveConfig({ ...f.input, cwd: f.main });
});


for (const replacement of ["cwd", "catalog-proof", "none"] as const) test(`real control retains guard-only approval throughout paused SDK create: ${replacement}`, { timeout: 20_000 }, async (t) => {
  const f = await fixture(t); await f.save("project", "auto_start", false);
  const calls: string[] = [], entries: any[] = []; const sdk = fakeSdk(calls);
  let entered!: () => void; const creating = new Promise<void>((resolve) => { entered = resolve; });
  let resume!: () => void; const paused = new Promise<void>((resolve) => { resume = resolve; });
  const builder = sdk.Sandbox.builder.bind(sdk.Sandbox);
  sdk.Sandbox.builder = (name: string) => {
    const instance = builder(name); const create = instance.create.bind(instance);
    instance.create = async () => { const raw = await create(); entered(); await paused; return raw; };
    return instance;
  };
  const integration = createMsbIntegration({ sessionId: "activation", cwd: f.linked, agentDir: f.input.agentDir, env: { HOME: f.root }, configDirName: ".pi", sdkLoader: async () => sdk,
    entries: () => entries, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    acquireOwnerLock: async () => ({ path: join(f.root, "owner.lock"), release: async () => {} }) });
  t.after(() => integration.manager.shutdown());
  await integration.configureSession({ sessionId: "activation", cwd: f.linked, projectTrusted: true });
  const draft = await integration.control.settings!.open("project"); draft.set("auto_start", true);
  await draft.reviewForApproval((await draft.preview()).effect); const applied = await draft.apply();
  // Intentionally NO signal: guard-only approval must survive the manager queue and SDK awaits.
  const activating = integration.control.reload({ allowRestart: true, guard: applied.assertUnchanged });
  const settled = activating.then(() => ({ ok: true }), () => ({ ok: false }));
  await creating;
  if (replacement === "cwd") {
    await rename(f.linked, `${f.linked}-old`); await mkdir(f.linked); await writeFile(join(f.linked, ".git"), `gitdir: ${f.registration}\n`);
  } else if (replacement === "catalog-proof") await writeFile(join(f.registration, "gitdir"), join(f.main, ".git"));
  resume(); const outcome = await settled;
  if (replacement === "none") {
    assert.equal(outcome.ok, true); assert.equal(integration.control.getState().status, "active");
    assert.ok(integration.control.getRuntimePolicy?.());
  } else {
    assert.equal(outcome.ok, false); assert.notEqual(integration.control.getState().status, "active");
    assert.equal(integration.control.getRuntimePolicy?.(), undefined);
    assert.equal(entries.some((entry) => entry.data?.enabled === true), false);
    assert.equal(calls.some((call) => call.startsWith("exec:")), false, "stale created handle must not prepare or execute guest commands");
    assert.ok(calls.some((call) => call.startsWith("remove:")), "late handle is safely cleaned up");
  }
});

test("catalog-authoritative linked proof inside current cwd cannot promote a parent bind into privileged shared policy", async (t) => {
  const f = await fixture(t);
  const agentDir = await realpath(await mkdtemp(join(tmpdir(), "pi-msb-outside-agent-"))); t.after(() => rm(agentDir, { recursive: true, force: true }));
  const input = { ...f.input, agentDir };
  const editor = new SettingsEditor(input, "shared"); const draft = await editor.open("project"); draft.set("cpus", 2); await draft.apply();
  // A broader authorized cwd could edit the nested main metadata. Even with
  // that forged reciprocal registration, linked proof may not live in its bind.
  const forged = join(f.main, ".git", "worktrees", "forged-parent"); await mkdir(forged);
  await writeFile(join(forged, "commondir"), "../..\n"); await writeFile(join(forged, "gitdir"), join(f.root, ".git"));
  await assert.rejects(resolveConfig({ ...input, cwd: f.root }), /could not be safely verified/);
});


test("nested Project writes are shared across main and linked cwd while Session remains current-cwd-only", async (t) => {
  const f = await fixture(t);
  const nested = join(f.linked, "packages", "app"); const mainNested = join(f.main, "packages", "app");
  await mkdir(nested, { recursive: true }); await mkdir(mainNested, { recursive: true });
  const editor = new SettingsEditor({ ...f.input, cwd: nested }, "nested");
  const draft = await editor.open("project"); draft.set("cpus", 3);
  await draft.reviewForApproval((await draft.preview()).effect); const saved = await draft.apply(); await saved.assertUnchanged?.();
  for (const cwd of [f.main, mainNested, f.linked, nested]) {
    assert.equal((await hostConfigPaths({ ...f.input, cwd })).project, f.paths.project);
    assert.equal((await resolveConfig({ ...f.input, cwd })).config.cpus, 3);
  }
  const session = await editor.open("temporary"); session.set("cpus", 7); await session.apply();
  assert.equal(editor.temporary().cpus, 7);
  editor.configureSession({ ...f.input, cwd: f.main }, "nested");
  assert.deepEqual(editor.temporary(), {});
  assert.equal((await resolveConfig(f.input)).config.cpus, 3);
});

test("catalog descendant discovery cannot inherit across nested submodule, repository or bare boundaries", async (t) => {
  const f = await fixture(t); await f.save("project", "cpus", 3);
  await rm(join(f.linked, ".git"));
  const nested = join(f.linked, "nested"); const deeper = join(nested, "deeper"); await mkdir(deeper, { recursive: true });
  assert.equal((await resolveConfig({ ...f.input, cwd: deeper })).config.cpus, 3);
  const metadata = join(f.main, ".git", "modules", "nested"); await mkdir(metadata, { recursive: true });
  await writeFile(join(nested, ".git"), `gitdir: ${metadata}\n`);
  assert.equal((await hostConfigTargets({ ...f.input, cwd: deeper })).repository, undefined);
  assert.notEqual((await resolveConfig({ ...f.input, cwd: deeper })).config.cpus, 3);
  await rm(join(nested, ".git")); await mkdir(join(nested, ".git"));
  assert.notEqual((await hostConfigPaths({ ...f.input, cwd: deeper })).project, f.paths.project);
  await rm(join(nested, ".git"), { recursive: true });
  await writeFile(join(nested, "HEAD"), "ref: refs/heads/main\n"); await mkdir(join(nested, "objects")); await mkdir(join(nested, "refs"));
  assert.equal((await hostConfigTargets({ ...f.input, cwd: deeper })).repository, undefined);
});

test("forged catalog registrations cannot make a checkout consume proof inside its own root from nested cwd", async (t) => {
  const f = await fixture(t); await f.save("project", "cpus", 3);
  const nested = join(f.root, "forged-nested"); await mkdir(nested);
  // A registration claiming a parent of the proof tree must not turn that tree
  // into external host authority, even when the immediate cwd is deeper.
  const registration = join(f.main, ".git", "worktrees", "forged-nested"); await mkdir(registration);
  await writeFile(join(registration, "commondir"), "../..");
  await writeFile(join(registration, "gitdir"), join(f.root, ".git"));
  await assert.rejects(resolveConfig({ ...f.input, cwd: nested }), /could not be safely verified/);
});

test("shared Project cannot activate an unassociated readable config; approved save embeds the association atomically", async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.paths.project), { recursive: true });
  await writeFile(f.paths.project, "cpus = 2\n");
  await assert.rejects(resolveConfig(f.input), /requires immutable repository association metadata/);
  const draft = await f.editor.open("project"); draft.set("cpus", 3);
  await draft.reviewForApproval((await draft.preview()).effect);
  const result = await draft.apply(); await result.assertUnchanged?.();
  assert.deepEqual(JSON.parse(JSON.stringify(readRawConfig(await readFile(f.paths.project, "utf8"))._repository)), (await hostConfigTargets(f.input)).repository);
  await rm(join(f.linked, ".git"));
  assert.equal((await resolveConfig(f.input)).config.cpus, 3);
});
