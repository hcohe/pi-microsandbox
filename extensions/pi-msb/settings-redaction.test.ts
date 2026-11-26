import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostConfigPaths } from "./config.ts";
import { SettingsEditor } from "./settings.ts";
import { createSettingsSanitizer } from "./settings-redaction.ts";
import { projectSettingsJson } from "./settings-json.ts";

test("literal and deprecated source spellings are masked, including repeated private strings", () => {
  for (const source of ["textValue", "text_value", "TEXT_VALUE", "value", "VALUE"]) {
    const credential = "PrivateSourceSentinel123";
    const raw = { secrets: [{ env: "TOKEN", [source]: credential, allow_hosts: ["api.example"] }] };
    const sanitize = createSettingsSanitizer([raw]);
    const projected = projectSettingsJson(raw);
    assert.equal(JSON.stringify(sanitize({ raw, projected, note: `prefix-${credential}-suffix` })).includes(credential), false, source);
    assert.equal(Object.values((projected.secrets as Record<string, unknown>[])[0]!).includes("<redacted>"), true, source);
  }
});

test("host source spellings and repeated metadata stay public while literal collisions remain private", () => {
  for (const source of ["hostEnv", "host_env", "HOST_ENV", "hostCmd", "host_cmd", "HOST_CMD"]) {
    const metadata = source.toLowerCase().includes("cmd") ? "printf PUBLIC_SOURCE" : "PUBLIC_SOURCE";
    const raw = { secrets: [{ env: "TOKEN", [source]: metadata, allow_hosts: ["api.example"] }] };
    const sanitize = createSettingsSanitizer([raw]);
    const projected = projectSettingsJson(raw);
    const key = source.toLowerCase().includes("cmd") ? "host_cmd" : "host_env";
    assert.equal((projected.secrets as Record<string, unknown>[])[0]![key], metadata);
    assert.deepEqual(sanitize({ raw, projected, note: `${metadata} / ${metadata}`, [metadata]: metadata }), {
      raw, projected, note: `${metadata} / ${metadata}`, [metadata]: metadata,
    });
    const withLiteral = createSettingsSanitizer([raw, { secrets: [{ textValue: metadata }] }]);
    assert.equal(JSON.stringify(withLiteral({ raw, projected, note: `${metadata} / ${metadata}` })).includes(metadata), false);
  }
});

test("secret source redaction preserves ordinary host environment forwarding names", () => {
  const raw = { host_env: ["LANG", "TZ"], secrets: [{ env: "TOKEN", host_env: "PRIVATE_HOST_VARIABLE", allow_hosts: ["api.example"] }] };
  const sanitize = createSettingsSanitizer([raw]);
  const projected = projectSettingsJson(raw);
  const safe = sanitize(projected);
  assert.deepEqual(safe.host_env, ["LANG", "TZ"]);
  assert.deepEqual(sanitize({ provenance: { hostEnv: "host-default", host_env: "host-project" } }), {
    provenance: { hostEnv: "host-default", host_env: "host-project" },
  });
  assert.equal((safe.secrets as Record<string, unknown>[])[0]!.host_env, "PRIVATE_HOST_VARIABLE");
});

test("snapshots, previews and apply results mask literal repetitions but expose host command metadata", async (t) => {
  const root = await realpath(await mkdtemp("/tmp/pi-msb-settings-redaction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const input = { cwd, homedir: join(root, "home"), agentDir: join(root, "agent"), env: {}, projectTrusted: true, configDirName: ".pi" };
  await mkdir(input.homedir);
  const paths = await hostConfigPaths(input);
  await mkdir(dirname(paths.global), { recursive: true });
  const oldLiteral = "LITERAL_PRIVATE_SENTINEL";
  const oldCommand = "printf PRIVATECOMMANDTOKEN";
  const newCommand = "printf PROPOSEDCOMMANDTOKEN";
  await writeFile(paths.global, `secrets = [{ env="TOKEN", text_value=${JSON.stringify(oldLiteral)}, allow_hosts=["api.example"] }]\n${JSON.stringify(oldLiteral)} = true\n${JSON.stringify(oldCommand)} = true\n${JSON.stringify(newCommand)} = true\n`);
  const editor = new SettingsEditor(input, "redaction");
  const draft = await editor.open("global");
  assert.equal(JSON.stringify(draft.snapshot()).includes(oldLiteral), false);
  for (const source of [{ value: "REJECTED_PRIVATE" }, { value: undefined }, { value: "REJECTED_PRIVATE", textValue: "NEW_PRIVATE" }]) {
    assert.throws(() => draft.upsertSecret({ env: "TOKEN", allowHosts: ["api.example"], ...source }), /value was removed.*textValue/);
  }
  draft.upsertSecret({ env: "TOKEN", hostCmd: newCommand, allowHosts: ["api.example"] });
  const review = await draft.reviewForApproval("restart");
  assert.equal((review.focus as { hostCommand?: boolean }[])[0]!.hostCommand, true);
  for (const presentation of [draft.snapshot(), await draft.preview(), review, await draft.apply()]) {
    assert.equal(JSON.stringify(presentation).includes(oldLiteral), false);
    assert.equal(JSON.stringify(presentation).includes(newCommand), true);
  }
});

test("literal prefix text has no reference redaction semantics", () => {
  const sanitize = createSettingsSanitizer([{ secrets: [{ env: "TOKEN", textValue: "$ENV:literal-prefix", allow_hosts: ["api.example"] }] }]);
  assert.deepEqual(sanitize({ literal: "$ENV:literal-prefix", suffix: "literal-prefix", unrelated: "$FILE:ordinary-text" }), {
    literal: "<redacted>", suffix: "literal-prefix", unrelated: "$FILE:ordinary-text",
  });
});

test("sanitizer exposes only immutable originating private-literal presence metadata", () => {
  const clear = createSettingsSanitizer([{ hostEnv: "PUBLIC_NAME", hostCmd: "printf PUBLIC_COMMAND" }]);
  const privateSources = [{ secrets: [{ textValue: "PRIVATE_METADATA_TOKEN" }] }];
  const privateSanitizer = createSettingsSanitizer(privateSources);
  assert.equal(clear.hasPrivateLiterals, false);
  assert.equal(privateSanitizer.hasPrivateLiterals, true);
  privateSources.length = 0;
  assert.equal(privateSanitizer.hasPrivateLiterals, true, "proof describes captured origin, not mutated sources");
  assert.throws(() => { (privateSanitizer as any).hasPrivateLiterals = false; }, TypeError);
  assert.deepEqual(Object.getOwnPropertyDescriptor(privateSanitizer, "hasPrivateLiterals"), { value: true, writable: false, enumerable: false, configurable: false });
  assert.doesNotMatch(JSON.stringify(Object.getOwnPropertyDescriptors(privateSanitizer)), /PRIVATE_METADATA_TOKEN/);
});
