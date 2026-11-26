import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { hostConfigPaths, resolveConfig } from "./config.ts";
import { SettingsEditor } from "./settings.ts";
import { formatSettingsDiff, settingsDiff } from "./settings-diff.ts";

async function fixture(t: TestContext, global: string, project = "", env: NodeJS.ProcessEnv = {}, cliOverridesToml?: string) {
  const root = await realpath(await mkdtemp("/tmp/pi-msb-recovery-security-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "home", "workspace");
  const hostData = join(root, "host-data");
  await mkdir(hostData, { recursive: true });
  global = global.replaceAll("/host-data", hostData);
  await mkdir(cwd, { recursive: true });
  const input = { cwd, homedir: join(root, "home"), agentDir: join(root, "agent"), env, projectTrusted: true, configDirName: ".pi", cliOverridesToml };
  const paths = await hostConfigPaths(input);
  for (const [scope, text] of [["global", global], ["project", project]] as const) {
    await mkdir(dirname(paths[scope]), { recursive: true });
    await writeFile(paths[scope], text);
  }
  return { input, paths, editor: new SettingsEditor(input, "security") };
}

test("CPU-only recovery authorizes the complete final activation policy and exact private multiline command", async (t) => {
  const command = "printf 'first\\n'\n# second line\nprintf secret";
  const f = await fixture(t, `cpus=0\nauto_start=false\nhost_env=["AWS_CREDENTIALS_FILE"]\nnetwork.mode="open"\nfallback_mode="host"\npass_through_tools=["host-only"]\nblock_third_party=false\nallow_host_execution=true\nallow_skill_reads=true\nsecrets=[{env="TOKEN",host_cmd=${JSON.stringify(command)},allow_hosts=["example.com"]},{env="REF",host_env="PUBLIC_SECRET_REF",allow_hosts=["secret.example"]}]\nmounts=[{type="dir",host_path="/host-data",guest_path="/data",readonly=false},{type="dir",host_path="/host-data",guest_path="/readonly",readonly=true}]\n`);
  const draft = await f.editor.open("global");
  draft.set("cpus", 2);
  await assert.rejects(draft.hostCommandsForApproval(), /fresh review/);
  const review = await draft.reviewForApproval("restart");
  const body = formatSettingsDiff(settingsDiff(review)).join("\n");
  assert.match(body, /Recovery activation/);
  assert.match(body, /COMPLETE final safety policy/);
  assert.match(body, /Fallback mode: host/);
  assert.match(body, /Auto start: false/);
  assert.match(body, /next session.*HOST mode/);
  assert.match(body, /AWS_CREDENTIALS_FILE/);
  assert.match(body, /Network:.*"mode":"open"/);
  assert.match(body, /All additional mounts/);
  assert.match(body, /"readonly":true/);
  assert.match(body, /PUBLIC_SECRET_REF/);
  assert.match(body, /secret\.example/);
  assert.match(body, /host-only/);
  assert.match(body, /Block third-party tools: false/);
  assert.match(body, /Allow host execution: true/);
  assert.match(body, /Allow skill reads: true/);
  assert.match(body, /\/host-data/);
  assert.match(body, /Final host commands: 1/);
  assert.match(body, /Sandbox failure may run tools on the HOST/);
  assert.doesNotMatch(body, /Replaces this scope/);
  assert.deepEqual((review.storage as any).changes.map((change: any) => change.path), ["cpus"]);
  assert.deepEqual(await draft.hostCommandsForApproval(), [command]);
  const result = await draft.apply();
  assert.equal(result.saved, true);
  await result.assertUnchanged!();
  const resolved = await resolveConfig(f.input);
  assert.equal(resolved.config.fallbackMode, "host");
  assert.equal(resolved.config.secrets[0]!.hostCmd, command);
});

test("private recovery appendix covers all retained final commands, not only edited entries", async (t) => {
  const first = "printf 'private\\n'\n# exact source";
  const second = "printf second";
  const f = await fixture(t, `cpus=0\nsecrets=[{env="A",host_cmd=${JSON.stringify(first)},allow_hosts=["example.com"]},{env="B",host_cmd=${JSON.stringify(second)},allow_hosts=["example.com"]}]`);
  const draft = await f.editor.open("global");
  draft.set("cpus", 2);
  await draft.reviewForApproval("restart");
  assert.deepEqual(await draft.hostCommandsForApproval(), [first, second]);
  assert.match(await readFile(f.paths.global, "utf8"), /cpus=0/);
});

test("recovery refuses activation when redaction would hide actual safety policy", async (t) => {
  const f = await fixture(t, 'cpus=0\nfallback_mode="host"\nsecrets=[{env="TOKEN",text_value="host",allow_hosts=["example.com"]}]');
  const draft = await f.editor.open("global");
  draft.set("cpus", 2);
  await assert.rejects(draft.reviewForApproval("restart"), /cannot be fully disclosed safely/);
  await assert.rejects(draft.hostCommandsForApproval(), /fresh review/);
  assert.match(await readFile(f.paths.global, "utf8"), /cpus=0/);
});

test("normal valid baseline has no recovery command appendix", async (t) => {
  const f = await fixture(t, 'cpus=1\nsecrets=[{env="TOKEN",host_cmd="echo old",allow_hosts=["example.com"]}]');
  const draft = await f.editor.open("global");
  draft.set("cpus", 2);
  const review = await draft.reviewForApproval("restart");
  assert.equal(review.recovery, undefined);
  assert.deepEqual(await draft.hostCommandsForApproval(), []);
});

for (const mutation of ["patch", "target", "other-source", "session"] as const) test(`recovery appendix and apply reject ${mutation} changed after approval`, async (t) => {
  const f = await fixture(t, 'cpus=0\nsecrets=[{env="TOKEN",host_cmd="echo approved",allow_hosts=["example.com"]}]');
  const draft = await f.editor.open("global");
  draft.set("cpus", 2);
  await draft.reviewForApproval("restart");
  assert.deepEqual(await draft.hostCommandsForApproval(), ["echo approved"]);
  if (mutation === "patch") draft.set("cpus", 3);
  if (mutation === "target") await writeFile(f.paths.global, 'cpus=0\nsecrets=[{env="TOKEN",host_cmd="echo changed",allow_hosts=["example.com"]}]');
  if (mutation === "other-source") await writeFile(f.paths.project, "memory_mib=2048\n");
  if (mutation === "session") f.editor.endSession();
  await assert.rejects(draft.hostCommandsForApproval(), /fresh review|stale/);
  await assert.rejects(draft.apply(), /fresh review|stale/);
  assert.match(await readFile(f.paths.global, "utf8"), /cpus=0/);
});

test("original overwritten CLI literal is private in snapshots, inspection, preview, review and errors", async (t) => {
  const credential = "OVERWRITTEN_CLI_PRIVATE_981";
  const cli = `image="${credential}"\nsecrets=[{env="TOKEN",text_value="${credential}",text_value="current",allow_hosts=["example.com"]}]`;
  const f = await fixture(t, "cpus=0", "", {}, cli);
  const inspection = await f.editor.inspect();
  const draft = await f.editor.open("global");
  draft.set("cpus", 2);
  const values = [inspection, draft.snapshot(), await draft.preview()];
  // An image containing a literal cannot be blindly authorized for activation.
  await assert.rejects(draft.reviewForApproval("restart"), /cannot be fully disclosed safely/);
  draft.set("image", "public-image:latest");
  values.push(await draft.reviewForApproval("restart"));
  assert.doesNotMatch(JSON.stringify(values), new RegExp(credential));
  draft.set("cpus", 0);
  await assert.rejects(draft.preview(), (error: Error) => !error.message.includes(credential));
});

for (const malformed of ['cpus="UNCLOSED', 'cpus=']) test(`shadowed malformed source requires manual repair without writes: ${JSON.stringify(malformed)}`, async (t) => {
  const f = await fixture(t, malformed, "cpus=2");
  // The permissive runtime parser accepts the shadowing project value.
  assert.equal((await resolveConfig(f.input)).config.cpus, 2);
  const inspection = await f.editor.inspect();
  assert.equal((inspection.recovery as any).manualRepairRequired, true);
  assert.equal((inspection.recovery as any).available, false);
  assert.doesNotMatch(JSON.stringify(inspection), /UNCLOSED/);
  await assert.rejects(f.editor.open("global"), /manual|host|repair|invalid|reconstruct/i);
  assert.equal(await readFile(f.paths.global, "utf8"), malformed);
  assert.equal(await readFile(f.paths.project, "utf8"), "cpus=2");
});

for (const token of ["123456789012", "123456789012345678901234567890", ".123456789012345", "-.123456789012345", "1.23456789012345e-12", "true"]) test(`invalid primitive credential ${token} is private including exact unrounded raw token`, async (t) => {
  const f = await fixture(t, `image="${token}"\nsecrets=[{env="TOKEN",text_value=${token},allow_hosts=["example.com"]}]`);
  const inspection = await f.editor.inspect();
  const text = JSON.stringify(inspection);
  if (token !== "true") assert.ok(!text.includes(token), text);
  assert.equal((inspection.layers as any).global.image, "<redacted>");
  assert.equal((inspection.layers as any).global.secrets[0].text_value, "<redacted>");
  assert.ok(!JSON.stringify((inspection.recovery as any).issues).includes(token));
});

for (const token of [".123456789012345", "-.123456789012345", "+inf", "nan", "1.23456789012345e-12"]) test(`overwritten bare CLI credential ${token} cannot escape privacy or activation guards`, async (t) => {
  const cli = `image="${token}"\nsecrets=[{env="TOKEN",text_value=${token},text_value="CURRENT_SAFE",allow_hosts=["example.com"]}]`;
  const f = await fixture(t, "cpus=0", "", {}, cli);
  const draft = await f.editor.open("global");
  draft.set("cpus", 2);
  const values = [await f.editor.inspect(), draft.snapshot(), await draft.preview()];
  assert.ok(!JSON.stringify(values).includes(token));
  await assert.rejects(draft.reviewForApproval("restart"), /cannot be fully disclosed safely/);
  draft.set("image", "public-image:latest");
  assert.ok(!JSON.stringify(await draft.reviewForApproval("restart")).includes(token));
});

test("recovery respects fully resolved cross-layer network policy instead of sparse defaults", async (t) => {
  const global = '[network]\nmode="allowlist"\nallow_dns=false\n';
  const f = await fixture(t, global, "cpus=0", { PI_MSB_NETWORK__ALLOW_HOSTS: "example.com" });
  const inspection = await f.editor.inspect();
  assert.equal((inspection.recovery as any).available, true);
  const draft = await f.editor.open("project");
  draft.set("cpus", 2);
  await draft.preview();
  await draft.reviewForApproval("restart");
  await draft.hostCommandsForApproval();
  const result = await draft.apply();
  assert.equal(result.saved, true);
  await result.assertUnchanged!();
  const resolved = await resolveConfig(f.input);
  assert.equal(resolved.config.network.mode, "allowlist");
  assert.equal(resolved.config.network.allowDns, false);
  assert.deepEqual(resolved.config.network.allowHosts, ["example.com"]);
  assert.equal(await readFile(f.paths.global, "utf8"), global);
});

test("candidate cannot omit a still-invalid final network policy", async (t) => {
  const f = await fixture(t, "cpus=0\n[network]\nmode=\"allowlist\"\nallow_dns=false\n");
  // Omitting this target allows a draft; reintroducing its unchanged invalid network must fail full resolution.
  const draft = await f.editor.open("global");
  draft.set("cpus", 2);
  await assert.rejects(draft.preview(), /allowlist/);
  assert.match(await readFile(f.paths.global, "utf8"), /cpus=0/);
});
