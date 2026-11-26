import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hostConfigPaths, resolveConfig } from "./config.ts";
import { SettingsEditor, type SettingsReviewFocus } from "./settings.ts";
import { approveSettings } from "./settings-approval.ts";
import { settingsDiff, formatSettingsDiff } from "./settings-diff.ts";

async function fixture(t: TestContext, text = "cpus = 0\n", scope: "global" | "project" = "global") {
  const root = await realpath(await mkdtemp("/tmp/pi-msb-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "home", "workspace");
  await mkdir(cwd, { recursive: true });
  const input = { cwd, homedir: join(root, "home"), agentDir: join(root, "agent"), env: {}, projectTrusted: true, configDirName: ".pi" };
  const paths = await hostConfigPaths(input);
  await mkdir(dirname(paths[scope]), { recursive: true });
  await writeFile(paths[scope], text);
  return { root, input, paths, editor: new SettingsEditor(input, "recovery"), path: paths[scope] };
}

for (const scope of ["global", "project"] as const) test(`invalid startup ${scope} has truthful inspection and approval-bound native repair`, async (t) => {
  const f = await fixture(t, "cpus = 0\n", scope);
  await assert.rejects(resolveConfig(f.input), /cpus/);
  const inspection = await f.editor.inspect();
  const recovery = inspection.recovery as any;
  assert.equal(recovery.available, true);
  assert.equal(recovery.configurationValid, false);
  assert.equal(recovery.manualRepairRequired, false);
  assert.ok(recovery.scopes.includes(scope));
  assert.match(JSON.stringify(recovery.issues), /cpus/);
  assert.equal(inspection.desired, undefined);
  assert.equal(inspection.provenance, undefined);
  const draft = await f.editor.open(scope);
  assert.equal(draft.path, f.path);
  assert.equal(draft.snapshot().effectiveToml, "");
  draft.set("cpus", 3);
  const preview = await draft.preview();
  const review = await draft.reviewForApproval(preview.effect);
  assert.equal((review.desired as any).before, null);
  const focus = review.focus as SettingsReviewFocus[];
  assert.deepEqual(focus[0]!.deltas, [{ field: "cpus", before: 0, after: 3 }]);
  let calls = 0;
  const ctx = { hasUI: true, mode: "rpc", ui: { select: async (_question: string, options: string[]) => {
    calls++;
    assert.equal(options[0], "No");
    return "Yes";
  } } } as unknown as ExtensionContext;
  assert.equal(await approveSettings(ctx, settingsDiff(review), new AbortController().signal), true);
  assert.equal(calls, 1);
  const result = await draft.apply();
  assert.equal(result.saved, true);
  assert.equal(result.runtimeApplied, false);
  await result.assertUnchanged!();
  assert.equal((await resolveConfig(f.input)).config.cpus, 3);
  assert.equal((await f.editor.inspect()).recovery, undefined);
});

test("final invalid candidate never reaches approval or persistence; multiple scalar repairs validate as one batch", async (t) => {
  const original = "cpus = 0\nmemory_mib = 1\n";
  const f = await fixture(t, original);
  const draft = await f.editor.open("global");
  draft.set("cpus", 2);
  await assert.rejects(draft.preview(), /memoryMiB/);
  await assert.rejects(draft.reviewForApproval("restart"), /memoryMiB/);
  await assert.rejects(draft.apply(), /memoryMiB/);
  assert.equal(await readFile(f.path, "utf8"), original);
  draft.set("memory_mib", 1024);
  const review = await draft.reviewForApproval("restart");
  assert.deepEqual((review.focus as SettingsReviewFocus[]).flatMap((focus) => focus.deltas.map((d) => [d.before, d.after])), [[0, 2], [1, 1024]]);
  assert.equal((await draft.apply()).saved, true);
});

test("invalid original collections retain native multi-entry intent and exact before values", async (t) => {
  const f = await fixture(t, 'secrets = [{ env = "A", host_env = "SOURCE_A", allow_hosts = [] }, { env = "B", host_cmd = "printf PUBLIC_COMMAND", allow_hosts = [] }]\n');
  const draft = await f.editor.open("global");
  draft.upsertSecret({ env: "A", allowHosts: ["a.example"] });
  draft.upsertSecret({ env: "B", allowHosts: ["b.example"] });
  const review = await draft.reviewForApproval("restart");
  const focus = (review.focus as SettingsReviewFocus[])[0]!;
  assert.equal(focus.baseline, "target");
  assert.ok(focus.deltas.some((d) => d.entry === "A" && JSON.stringify(d.before) === "[]" && JSON.stringify(d.after) === '["a.example"]'));
  assert.ok(focus.deltas.some((d) => d.entry === "B" && JSON.stringify(d.before) === "[]"));
  assert.equal((review.collections as unknown[]).length, 2);
  assert.ok((review.collections as Array<{ source: string }>).every((entry) => entry.source === "host-default"));
  assert.equal((await draft.apply()).saved, true);
});

for (const broken of ['this is not TOML: PRIVATE_PARSER_SNIPPET\n', 'cpus = "PRIVATE_UNCLOSED\n', '[network\nmode = "deny"\n', 'cpus = 0 PRIVATE_TRAILING\n', 'cpus = 0\nroute_tools = ["read",, "bash"]\n']) test("malformed syntax remains generic manual-only", async (t) => {
  const f = await fixture(t, broken);
  const inspection = await f.editor.inspect();
  const recovery = inspection.recovery as any;
  assert.equal(recovery.available, false);
  assert.equal(recovery.manualRepairRequired, true);
  assert.doesNotMatch(JSON.stringify(inspection), /PRIVATE_|this is not TOML/);
  await assert.rejects(f.editor.open("global"), /manual|invalid raw configuration/i);
  assert.equal(await readFile(f.path, "utf8"), broken);
});

test("approval cannot survive changed broken source, session or final valid source", async (t) => {
  const f = await fixture(t);
  const draft = await f.editor.open("global");
  draft.set("cpus", 2);
  await draft.reviewForApproval("restart");
  await writeFile(f.path, "cpus = -1\n");
  await assert.rejects(draft.apply(), /changed|fresh review/i);
  assert.equal(await readFile(f.path, "utf8"), "cpus = -1\n");
  const next = await f.editor.open("global");
  next.set("cpus", 3);
  await next.reviewForApproval("restart");
  f.editor.configureSession(f.input, "other-session");
  await assert.rejects(next.apply(), /changed|fresh review/i);
  const last = await f.editor.open("global");
  last.set("cpus", 3);
  await last.reviewForApproval("restart");
  await writeFile(f.path, "cpus = 4\n");
  await assert.rejects(last.apply(), /changed|fresh review/i);
});

test("another invalid layer cannot be silently ignored even when shadowed", async (t) => {
  const f = await fixture(t, "cpus = 0\nmemory_mib = 1\n");
  await mkdir(dirname(f.paths.project), { recursive: true });
  await writeFile(f.paths.project, "cpus = 0\n");
  const draft = await f.editor.open("project").catch(() => undefined);
  assert.equal(draft, undefined);
  // A valid higher override hides a semantic error in another layer, not permission to persist it.
  await writeFile(f.paths.project, "cpus = 2\n");
  const editor = new SettingsEditor({ ...f.input, env: { PI_MSB_CPUS: "0" } }, "shadowed-invalid");
  const repair = await editor.open("global");
  repair.set("cpus", 2);
  repair.set("memory_mib", 1024);
  await assert.rejects(repair.apply(), /cpus/);
  assert.equal(await readFile(f.paths.global, "utf8"), "cpus = 0\nmemory_mib = 1\n");
});

test("recovery masks repeated, shadowed and escaped literals; public source descriptors remain public without execution", async (t) => {
  const f = await fixture(t);
  const marker = join(f.root, "executed");
  const original = `cpus = 0\nimage = "EARLY_PRIVATE"\n[[secrets]]\nenv = "A"\ntext_value = "EARLY_PRIVATE"\ntext_value = "ESCAPED\\u005fPRIVATE"\nallow_hosts = ["a.example"]\n[[secrets]]\nenv = "B"\nhost_env = "PUBLIC_ENV_SOURCE"\nallow_hosts = ["b.example"]\n[[secrets]]\nenv = "C"\nhost_cmd = "touch ${marker}"\nallow_hosts = ["c.example"]\n`;
  await writeFile(f.path, original);
  let stats = 0;
  const editor = new SettingsEditor({ ...f.input, stat: async () => { stats++; throw new Error("must not resolve unrelated resources"); } }, "private");
  const inspection = await editor.inspect();
  const draft = await editor.open("global");
  draft.set("cpus", 2);
  const privatePreview = await draft.preview();
  await assert.rejects(draft.reviewForApproval(privatePreview.effect), /cannot be fully disclosed safely/);
  draft.set("image", "public-image:latest");
  const preview = await draft.preview();
  const review = await draft.reviewForApproval(preview.effect);
  const output = JSON.stringify([inspection, draft.snapshot(), privatePreview, preview, review, formatSettingsDiff(settingsDiff(review))]);
  assert.doesNotMatch(output, /EARLY_PRIVATE|ESCAPED_PRIVATE|ESCAPED\\u005fPRIVATE/);
  assert.match(output, /PUBLIC_ENV_SOURCE/);
  assert.match(output, /touch/);
  assert.equal(stats, 0);
  await assert.rejects(access(marker));
  assert.equal(await readFile(f.path, "utf8"), original); // Review is never approval or persistence.
});

test("No-first recovery approval declines without persisting or starting anything", async (t) => {
  const f = await fixture(t);
  const draft = await f.editor.open("global");
  draft.set("cpus", 2);
  const review = await draft.reviewForApproval("restart");
  const ctx = { hasUI: true, mode: "rpc", ui: { select: async (_question: string, options: string[]) => {
    assert.equal(options[0], "No");
    return "No";
  } } } as unknown as ExtensionContext;
  assert.equal(await approveSettings(ctx, settingsDiff(review), new AbortController().signal), false);
  draft.discard();
  assert.equal(await readFile(f.path, "utf8"), "cpus = 0\n");
});

test("inline repeated literals and invalid environment/CLI secret sources stay private in degraded inspection", async (t) => {
  const f = await fixture(t, 'cpus = 0\nimage = "INLINE_PRIVATE"\nsecrets = [{ env = "A", text_value = "INLINE_PRIVATE", text_value = "FINAL_PRIVATE", allow_hosts = ["a.example"] }]\n');
  const inspected = await f.editor.inspect({ message: "INLINE_PRIVATE FINAL_PRIVATE" });
  assert.doesNotMatch(JSON.stringify(inspected), /INLINE_PRIVATE|FINAL_PRIVATE/);
  for (const location of ["env", "cli"] as const) {
    const input = { ...f.input,
      ...(location === "env" ? { env: { PI_MSB_SECRETS: JSON.stringify([{ env: "OLD", value: "INVALID_SOURCE_PRIVATE", allowHosts: ["old.example"] }]) } }
        : { cliOverridesToml: 'secrets = [{ env = "OLD", value = "INVALID_SOURCE_PRIVATE", allow_hosts = ["old.example"] }]' }),
    };
    const editor = new SettingsEditor(input, location);
    const inspection = await editor.inspect({ message: "INVALID_SOURCE_PRIVATE" });
    assert.doesNotMatch(JSON.stringify(inspection), /INVALID_SOURCE_PRIVATE/);
    assert.equal((inspection.recovery as any).available, false);
    await assert.rejects(editor.open("global"), /manual|unavailable/i);
  }
});

test("discovery identity changes keep inspection and structured editing blocked", async (t) => {
  const f = await fixture(t);
  const cwd = join(f.root, "different");
  await mkdir(cwd);
  f.editor.beginSession({ ...f.input, cwd }, "new");
  await assert.rejects(f.editor.inspect(), /changed|fresh review/i);
  await assert.rejects(f.editor.open("global"), /changed|fresh review/i);
});
