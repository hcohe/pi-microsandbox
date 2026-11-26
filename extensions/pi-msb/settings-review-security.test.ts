import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hostConfigPaths, overridesToToml, parseTomlConfig } from "./config.ts";
import { approveSettings } from "./settings-approval.ts";
import { formatSettingsDiff, settingsDiff } from "./settings-diff.ts";
import { createSettingsSanitizer } from "./settings-redaction.ts";
import { SettingsEditor, type SettingsCollectionIntent, type SettingsReviewFocus } from "./settings.ts";
import type { DeepPartial, Config } from "./types.ts";

async function fixture(t: TestContext, config: DeepPartial<Config>) {
  const root = await realpath(await mkdtemp("/tmp/pi-msb-settings-review-security-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "home", "workspace");
  await mkdir(cwd, { recursive: true });
  const input = { cwd, homedir: join(root, "home"), agentDir: join(root, "agent"), env: {}, projectTrusted: true, configDirName: ".pi" };
  const paths = await hostConfigPaths(input);
  await mkdir(dirname(paths.global), { recursive: true });
  await writeFile(paths.global, overridesToToml(config));
  const editor = new SettingsEditor(input, "review-security");
  return { editor, paths, root };
}
const text = (review: Record<string, unknown>) => formatSettingsDiff(settingsDiff(review)).join("\n");
const focuses = (review: Record<string, unknown>) => review.focus as SettingsReviewFocus[];
const intents = (review: Record<string, unknown>) => review.collections as SettingsCollectionIntent[];

// Ordered native CRUD is also the implementation used for agent batches.
test("review covers every final secret edit, including an earlier retained HOST command, in one approval", async (t) => {
  const f = await fixture(t, { secrets: [
    { env: "A", hostCmd: "printf PUBLIC_COMMAND_A", allowHosts: ["old-a.example"] },
    { env: "SIBLING", hostEnv: "UNRELATED_SOURCE", allowHosts: ["unrelated.example"] },
  ] });
  const draft = await f.editor.open("global");
  draft.upsertSecret({ env: "A", allowHosts: ["new-a.example"] });
  draft.upsertSecret({ env: "B", hostEnv: "PUBLIC_SOURCE_B", allowHosts: ["b.example"] });
  const review = await draft.reviewForApproval("restart");
  const displayed = text(review);
  assert.match(displayed, /A\n- Hosts: old-a\.example\n\+ Hosts: new-a\.example/);
  assert.match(displayed, /B\n\+ Name: B/);
  assert.match(displayed, /PUBLIC_SOURCE_B/);
  assert.match(displayed, /executes a shell command on the HOST/);
  assert.doesNotMatch(displayed, /SIBLING|unrelated\.example|UNRELATED_SOURCE|entire list/);
  assert.deepEqual(intents(review).map((intent) => intent.operation), ["upsert", "upsert"]);
  let approvals = 0;
  const ctx = { hasUI: true, mode: "rpc", ui: { select: async (question: string) => {
    approvals++;
    assert.match(question, /new-a\.example/);
    assert.match(question, /PUBLIC_SOURCE_B/);
    assert.match(question, /executes a shell command on the HOST/);
    return "Yes";
  } } } as unknown as ExtensionContext;
  assert.equal(await approveSettings(ctx, settingsDiff(review), new AbortController().signal), true);
  assert.equal((await draft.apply()).saved, true);
  assert.equal(approvals, 1);
  const saved = parseTomlConfig(await readFile(f.paths.global, "utf8"), "global").value;
  assert.equal(saved.secrets?.find((secret) => secret.env === "A")?.hostCmd, "printf PUBLIC_COMMAND_A");
  assert.deepEqual(saved.secrets?.find((secret) => secret.env === "A")?.allowHosts, ["new-a.example"]);
  assert.equal(saved.secrets?.find((secret) => secret.env === "B")?.hostEnv, "PUBLIC_SOURCE_B");
});

test("review collapses repeat edits, canceled additions and rename chains to final collection differences", async (t) => {
  const f = await fixture(t, { secrets: [
    { env: "A", hostEnv: "SOURCE_A", allowHosts: ["old-a.example"] },
    { env: "B", hostEnv: "SOURCE_B", allowHosts: ["b.example"] },
    { env: "C", hostEnv: "SOURCE_C", allowHosts: ["c.example"] },
    { env: "UNRELATED", hostCmd: "printf UNRELATED_COMMAND", allowHosts: ["unrelated.example"] },
  ] });
  const draft = await f.editor.open("global");
  draft.upsertSecret({ env: "A", allowHosts: ["transient-host.example"] });
  draft.upsertSecret({ env: "CANCELED", hostCmd: "printf TRANSIENT_COMMAND", allowHosts: ["canceled.example"] });
  draft.upsertSecret({ env: "TRANSIENT_NAME", allowHosts: ["b.example"] }, "B");
  draft.upsertSecret({ env: "FINAL_NAME", allowHosts: ["b.example"] }, "TRANSIENT_NAME");
  draft.upsertSecret({ env: "A", allowHosts: ["final-a.example"] });
  draft.removeSecret("C");
  draft.removeSecret("CANCELED");
  const review = await draft.reviewForApproval("restart");
  const displayed = text(review);
  assert.match(displayed, /old-a\.example/);
  assert.match(displayed, /final-a\.example/);
  assert.match(displayed, /- Name: B\n\+ Name: FINAL_NAME/);
  assert.match(displayed, /- Name: C/);
  assert.doesNotMatch(displayed, /TRANSIENT|transient-host|CANCELED|canceled\.example|UNRELATED|unrelated\.example|executes a shell command|entire list|Removes this entry/);
  assert.doesNotMatch(JSON.stringify(intents(review)), /TRANSIENT|CANCELED/);
  assert.equal(intents(review).some((intent) => intent.operation === "remove" && intent.identities.includes("C")), true);
  assert.equal(focuses(review)[0]!.operation, "set"); // Mixed CRUD, not a last-operation removal or whole-list replacement.
});

test("one surviving entry stays compact after other entries are reverted or canceled", async (t) => {
  const f = await fixture(t, { secrets: [
    { env: "A", hostEnv: "SOURCE_A", allowHosts: ["old-a.example"] },
    { env: "B", hostCmd: "printf UNRELATED_COMMAND", allowHosts: ["b.example"] },
  ] });
  const draft = await f.editor.open("global");
  draft.upsertSecret({ env: "A", allowHosts: ["final-a.example"] });
  draft.upsertSecret({ env: "B", allowHosts: ["transient-b.example"] });
  draft.upsertSecret({ env: "B", allowHosts: ["b.example"] });
  draft.upsertSecret({ env: "CANCELED", hostEnv: "TRANSIENT_SOURCE", allowHosts: ["canceled.example"] });
  draft.removeSecret("CANCELED");
  const review = await draft.reviewForApproval("restart");
  assert.equal(focuses(review)[0]!.identity, "A");
  assert.equal(focuses(review)[0]!.operation, "upsert");
  assert.match(text(review), /Secret A\n- Hosts: old-a\.example\n\+ Hosts: final-a\.example/);
  assert.doesNotMatch(text(review), /SOURCE_A|B|b\.example|TRANSIENT|CANCELED|executes a shell command|Removes this entry/);
  assert.deepEqual(intents(review).map((intent) => intent.identities), [["A"]]);
});

test("rename then remove reviews removal of the original, and rename collisions remain disclosed", async (t) => {
  const f = await fixture(t, { secrets: [
    { env: "A", hostEnv: "SOURCE_A", allowHosts: ["a.example"] },
    { env: "B", hostEnv: "SOURCE_B", allowHosts: ["b.example"] },
  ] });
  const removal = await f.editor.open("global");
  removal.upsertSecret({ env: "TRANSIENT", allowHosts: ["a.example"] }, "A");
  removal.removeSecret("TRANSIENT");
  const removed = await removal.reviewForApproval("restart");
  assert.equal(focuses(removed)[0]!.operation, "remove");
  assert.equal(focuses(removed)[0]!.identity, "A");
  assert.match(text(removed), /Removes this entry/);
  assert.doesNotMatch(text(removed), /TRANSIENT|b\.example/);
  removal.discard();
  const rename = await f.editor.open("global");
  rename.upsertSecret({ env: "TRANSIENT", allowHosts: ["a.example"] }, "A");
  rename.upsertSecret({ env: "B", allowHosts: ["a.example"] }, "TRANSIENT");
  const renamed = await rename.reviewForApproval("restart");
  assert.match(text(renamed), /Secret A → B/);
  assert.match(text(renamed), /Replaces the entry with this name/);
  assert.doesNotMatch(text(renamed), /TRANSIENT|entire list/);
});

for (const writable of [true, false]) test(`multi-mount review reports only final affected writable consequences (${writable})`, async (t) => {
  const f = await fixture(t, {});
  for (const name of ["a", "b", "unrelated", "final-a", "final-b"]) await mkdir(join(f.root, name));
  await writeFile(f.paths.global, overridesToToml({ mounts: [
    { type: "dir", hostPath: join(f.root, "a"), guestPath: "/mnt/a", readonly: true },
    { type: "dir", hostPath: join(f.root, "b"), guestPath: "/mnt/b", readonly: true },
    { type: "dir", hostPath: join(f.root, "unrelated"), guestPath: "/mnt/unrelated", readonly: false },
  ] }));
  const draft = await f.editor.open("global");
  draft.upsertMount({ type: "dir", hostPath: join(f.root, "final-a"), guestPath: "/mnt/a", readonly: !writable, options: [] });
  draft.upsertMount({ type: "dir", hostPath: join(f.root, "final-b"), guestPath: "/mnt/b", readonly: true, options: [] });
  const review = await draft.reviewForApproval("restart");
  assert.match(text(review), /\/final-a/);
  assert.match(text(review), /\/final-b/);
  assert.doesNotMatch(text(review), /unrelated|entire list/);
  assert.equal(focuses(review)[0]!.writableMount, writable);
});

test("scalar-list CRUD reviews all final changes without transient entries or replacement claims", async (t) => {
  const f = await fixture(t, { hostEnv: ["OLD", "REMOVE_ME", "UNRELATED"] });
  const draft = await f.editor.open("global");
  draft.upsertListEntry("host_env", "TRANSIENT", "OLD");
  draft.upsertListEntry("host_env", "FINAL", "TRANSIENT");
  draft.removeListEntry("host_env", "REMOVE_ME");
  const review = await draft.reviewForApproval("restart");
  assert.match(text(review), /- Host variables: OLD/);
  assert.match(text(review), /- Host variables: REMOVE_ME/);
  assert.match(text(review), /\+ Host variables: FINAL/);
  assert.doesNotMatch(text(review), /TRANSIENT|UNRELATED|entire list/);
});

test("multi-entry approval still binds the complete final candidate and rejects subsequent edits", async (t) => {
  const f = await fixture(t, { secrets: [{ env: "A", hostEnv: "SOURCE_A", allowHosts: ["old.example"] }] });
  const original = await readFile(f.paths.global, "utf8");
  const draft = await f.editor.open("global");
  draft.upsertSecret({ env: "A", allowHosts: ["new.example"] });
  draft.upsertSecret({ env: "B", hostEnv: "SOURCE_B", allowHosts: ["b.example"] });
  await draft.reviewForApproval("restart");
  draft.removeSecret("A");
  await assert.rejects(draft.apply(), /Configuration changed; request a fresh review/);
  assert.equal(await readFile(f.paths.global, "utf8"), original);
});

for (const credential of ["PRIVATE_LITERAL_123", 'PRIVATE_QUOTED_"slash\\line\nnext\tend']) {
  test(`native TOML masks repeated literal credentials, preserving quoted values and structural newlines (${JSON.stringify(credential)})`, async (t) => {
    const command = "printf NEVER_EXECUTE > ";
    const f = await fixture(t, {
      sandboxName: `prefix-${credential}-suffix`,
      secrets: [
        { env: "LITERAL", textValue: credential, allowHosts: ["api.example"] },
        { env: "ENV_TOKEN", hostEnv: "MISSING_HOST_VARIABLE", allowHosts: ["api.example"] },
        { env: "COMMAND", hostCmd: `${command}/missing/must-not-run`, allowHosts: ["api.example"] },
      ],
    });
    const draft = await f.editor.open("global");
    draft.set("show_footer", false);
    const presentations = [draft.snapshot(), await draft.preview(), await draft.apply()];
    for (const presentation of presentations) {
      assert.doesNotMatch(JSON.stringify(presentation), /PRIVATE_LITERAL_123|PRIVATE_QUOTED_/);
      assert.match(presentation.effectiveToml, /\nsandbox_name = /);
      assert.match(presentation.effectiveToml, /\[\[secrets\]\]/);
      const parsed = parseTomlConfig(presentation.effectiveToml, "global").value;
      assert.equal(parsed.sandboxName, "prefix-<redacted>-suffix");
      assert.deepEqual(parsed.secrets?.map((secret) => secret.textValue ?? secret.hostEnv ?? secret.hostCmd), ["<redacted>", "<redacted>", "<redacted>"]);
    }
    // Presentation redaction must not modify the persisted private candidate or resolve sources.
    const saved = parseTomlConfig(await readFile(f.paths.global, "utf8"), "global").value;
    assert.equal(saved.sandboxName, `prefix-${credential}-suffix`);
    assert.equal(saved.secrets?.[0]?.textValue, credential);
    assert.equal(saved.secrets?.[2]?.hostCmd, `${command}/missing/must-not-run`);
  });
}

test("TOML literal mode masks decoded escaped credentials without corrupting string escapes or structural whitespace", () => {
  const credential = '"\\\n';
  const sanitize = createSettingsSanitizer([{ secrets: [{ textValue: credential }] }]);
  const toml = `sandbox_name = ${JSON.stringify(`before${credential}after`)}\nimage = ${JSON.stringify("unrelated\nline\tvalue")}\n`;
  const safe = sanitize(toml, [], "toml");
  assert.equal(safe, `sandbox_name = "before<redacted>after"\nimage = "unrelated\\nline\\tvalue"\n`);
  const parsed = parseTomlConfig(safe, "global").value;
  assert.equal(parsed.image, "unrelated\nline\tvalue");
  // Public source descriptors are not credential sources, including exact multiline command text.
  const metadata = { secrets: [{ hostEnv: "PUBLIC_VAR", hostCmd: "printf PUBLIC_COMMAND\n# next line" }] };
  assert.deepEqual(sanitize(metadata), metadata);
});
