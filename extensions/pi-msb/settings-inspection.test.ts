import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSettings, inspectionParameters, inspectionRequest, inspectionResult, inspectionText, SETTINGS_SCHEMA_VERSION } from "./settings-inspection.ts";
import { projectSettingsJson } from "./settings-json.ts";
import { createSettingsSanitizer } from "./settings-redaction.ts";
import { settingsCapabilities, settingsSchema } from "./settings-schema.ts";
import { operationProblem } from "./settings-validation.ts";
import { applyOverride, validateConfig } from "./config.ts";

const snapshot = {
  desired: { cpus: 4, network: { mode: "allowlist", allow_hosts: ["github.com"], allow_dns: true, publish_ports: [] } },
  layers: { global: {}, project: {}, session: { network: { mode: "allowlist" } } },
  runtime: { status: "active", adopted: null }, warnings: [],
};
test("inspection parameter schema matches execute-time filters, including absent/optional arguments", () => {
  for (const value of [{}, { sections: ["schema"], paths: ["network", "secrets"], format: "json", knownSchemaVersion: SETTINGS_SCHEMA_VERSION }]) {
    assert.equal(Check(inspectionParameters, value), true); assert.doesNotThrow(() => inspectionRequest(value));
  }
  for (const value of [{ sections: [] }, { paths: ["network.mode[0]"] }, { format: "yaml" }, { knownSchemaVersion: -1 }, { all: true }]) {
    assert.equal(Check(inspectionParameters, value), false); assert.throws(() => inspectionRequest(value));
  }
});
test("invalid configuration recovery remains visible even with schema-only filters", () => {
  const recovery = { available: true, configurationValid: false, manualRepairRequired: false,
    reason: "Repair the selected scope; only a fully valid final candidate may be saved." };
  const details = inspectSettings({ recovery, runtime: { status: "unavailable" } }, inspectionRequest({ sections: ["schema"], paths: ["cpus"] }));
  assert.deepEqual(details.recovery, recovery);
  assert.equal(details.desired, undefined);
  assert.ok(details.settingsSchema.cpus.valueSchema);
  assert.match(inspectionText(details), /Configuration recovery/);
  assert.deepEqual(JSON.parse(inspectionResult(details, "json").content[0]!.text).recovery, recovery);
  const summary = inspectSettings({ recovery, runtime: { status: "unavailable" } }, inspectionRequest({ sections: ["summary"] })).summary;
  assert.equal(summary.configurationValid, false);
  assert.equal(summary.recoveryAvailable, true);
});
test("default content is a readable overview, explicit sections can render full detail, JSON stays machine-readable", () => {
  const details = inspectSettings(snapshot, inspectionRequest({}));
  const overview = inspectionResult(details, "text", true);
  assert.match(overview.content[0]!.text, /Runtime: active/); assert.match(overview.content[0]!.text, /mode: allowlist/);
  assert.match(overview.content[0]!.text, /Other selected sections remain/);
  assert.doesNotMatch(overview.content[0]!.text, /Setting schemas|Native.*schema/);
  assert.ok(overview.details.settingsSchema);
  const report = inspectionResult(details).content[0]!.text;
  assert.match(report, /Setting schemas/); assert.match(report, /Network policy/);
  assert.deepEqual(JSON.parse(inspectionResult(details, "json").content[0]!.text), details);
});
test("large text is bounded and oversized JSON displays a valid truncation envelope without removing structured fields", () => {
  const details = { outcome: "inspected", desired: { image: "x".repeat(60000) } };
  const report = inspectionResult(details);
  assert.ok(report.content[0]!.text.length < 48000); assert.match(report.content[0]!.text, /Display truncated/);
  assert.equal(report.details.desired.image.length, 60000);
  const json = JSON.parse(inspectionText(details, "json"));
  assert.equal(json.outputTruncated, true); assert.match(json.reason, /sections\/paths/);
  const unicode = inspectionText({ outcome: "inspected", desired: { image: "測".repeat(20000) } });
  assert.ok(Buffer.byteLength(unicode) < 48000); assert.match(unicode, /Display truncated/);
});
test("new secret source discovery invalidates old schema caches", () => {
  assert.ok(SETTINGS_SCHEMA_VERSION > 3);
  assert.equal(settingsCapabilities.version, SETTINGS_SCHEMA_VERSION);
  const old = inspectSettings(snapshot, inspectionRequest({ sections: ["schema", "capabilities"], paths: ["secrets"], knownSchemaVersion: 3 }));
  assert.equal(old.settingsSchema.secrets.valueSchema.items.properties.textValue, undefined);
  assert.equal(old.settingsSchema.secrets.valueSchema.items.properties.value, undefined);
  assert.ok(old.settingsSchema.secrets.valueSchema.items.properties.hostEnv);
  assert.ok(old.settingsSchema.secrets.valueSchema.items.properties.hostCmd);
  assert.equal(old.capabilities.version, SETTINGS_SCHEMA_VERSION);
  const current = inspectSettings(snapshot, inspectionRequest({ sections: ["schema", "capabilities"], knownSchemaVersion: SETTINGS_SCHEMA_VERSION }));
  assert.equal(current.schemaUnchanged, true);
  assert.equal(current.settingsSchema, undefined);
  assert.equal(current.capabilities, undefined);
});
test("JSON projection masks literal credentials but exposes camelCase, snake_case and uppercase host source metadata", () => {
  for (const [textValue, hostEnv, hostCmd] of [["textValue", "hostEnv", "hostCmd"], ["text_value", "host_env", "host_cmd"], ["TEXT_VALUE", "HOST_ENV", "HOST_CMD"]]) {
    const raw = { hostEnv: ["PUBLIC_FORWARDING"], secrets: [{
      env: "TOKEN", allowHosts: ["api.example.com"], [textValue!]: "LITERAL_PRIVATE", [hostEnv!]: "ENV_PRIVATE", [hostCmd!]: "COMMAND_PRIVATE", unknown: "UNKNOWN_PRIVATE",
    }] };
    const projected = projectSettingsJson(raw);
    assert.deepEqual(projected, { host_env: ["PUBLIC_FORWARDING"], secrets: [{ env: "TOKEN", allow_hosts: ["api.example.com"], text_value: "<redacted>", host_env: "ENV_PRIVATE", host_cmd: "COMMAND_PRIVATE" }] });
    assert.doesNotMatch(JSON.stringify(projected), /LITERAL_PRIVATE|UNKNOWN_PRIVATE/);
  }
  assert.deepEqual(projectSettingsJson({ secrets: [{ env: "TOKEN", hostCmd: { invalid: "PRIVATE" }, hostEnv: ["PRIVATE"], textValue: null }] }), {
    secrets: [{ env: "TOKEN", host_cmd: "<invalid>", host_env: "<invalid>", text_value: "<redacted>" }],
  });
});
test("sanitizer captures every raw source spelling and repetitions, including hidden and additional sources", () => {
  const keys = ["textValue", "text_value", "TEXT_VALUE", "value", "VALUE"];
  const raw = { host_env: ["PUBLIC_FORWARDING"], secrets: keys.map((key, index) => ({ env: `TOKEN_${index}`, [key]: `PRIVATE_SOURCE_${index}_END` })) };
  const sources = raw.secrets.map((entry, index) => entry[keys[index]!]);
  const sanitize = createSettingsSanitizer([raw]);
  const repetitions = sources.join(" / ");
  const result = sanitize({ ...raw, warning: `${repetitions} ${repetitions}`, [repetitions]: repetitions, path: `/private/${sources[0]}`, extra: "ADDITIONAL_PRIVATE" }, [{ secrets: [{ TEXT_VALUE: "ADDITIONAL_PRIVATE" }] }]);
  assert.deepEqual(result.host_env, ["PUBLIC_FORWARDING"]);
  for (const [index, entry] of result.secrets.entries()) assert.equal(entry[keys[index]!], "<redacted>");
  const maskedSources = sources.map(() => "<redacted>").join(" / ");
  assert.equal(result.warning, `${maskedSources} ${maskedSources}`);
  assert.equal(result.path, "/private/<redacted>");
  assert.equal(result.extra, "<redacted>");
  for (const source of sources) assert.ok(!JSON.stringify(result).includes(source));
  assert.ok(Object.hasOwn(result, maskedSources));
  // Per-call private sources must not contaminate later independent calls.
  assert.equal(sanitize({ note: "ADDITIONAL_PRIVATE" }).note, "ADDITIONAL_PRIVATE");
});
test("sanitizer treats ENV/FILE-looking values literally, not as references", () => {
  const sanitize = createSettingsSanitizer([{ secrets: [{ textValue: "$ENV:PRIVATE_ENV" }, { textValue: "$FILE:/private/literal" }] }]);
  assert.deepEqual(sanitize({ note: "$ENV:PRIVATE_ENV $FILE:/private/literal", suffixes: "PRIVATE_ENV /private/literal", unrelated: "$ENV:PUBLIC $FILE:/public" }), {
    note: "<redacted> <redacted>", suffixes: "PRIVATE_ENV /private/literal", unrelated: "$ENV:PUBLIC $FILE:/public",
  });
  const publicSources = createSettingsSanitizer([{ secrets: [{ HOST_ENV: "PUBLIC_HOST_ENV", HOST_CMD: "printf PUBLIC_COMMAND" }] }]);
  assert.deepEqual(publicSources({ note: "PUBLIC_HOST_ENV printf PUBLIC_COMMAND" }), { note: "PUBLIC_HOST_ENV printf PUBLIC_COMMAND" });
});
test("inspection and validation do not execute host commands or resolve literal strings", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-msb-secret-inspection-"));
  try {
    const marker = join(root, "must-not-exist");
    const command = `touch '${marker}'`;
    const secrets = [
      { env: "COMMAND", allowHosts: ["api.example.com"], hostCmd: command },
      { env: "ENVIRONMENT", allowHosts: ["api.example.com"], hostEnv: "MISSING_PRIVATE_HOST_ENV" },
      { env: "LITERAL", allowHosts: ["api.example.com"], textValue: `$FILE:${marker}` },
      { env: "LITERAL_ENV", allowHosts: ["api.example.com"], textValue: "$ENV:MISSING_PRIVATE_HOST_ENV" },
    ];
    assert.equal(Check((settingsSchema().secrets as any).valueSchema, secrets.slice(0, 2)), true);
    assert.equal(Check((settingsSchema().secrets as any).valueSchema, secrets), false);
    assert.doesNotThrow(() => validateConfig(applyOverride({}, "secrets", secrets)));
    assert.equal(secrets[2]!.textValue, `$FILE:${marker}`);
    assert.equal(secrets[3]!.textValue, "$ENV:MISSING_PRIVATE_HOST_ENV");
    const safe = createSettingsSanitizer([{ secrets }])({ ...snapshot, desired: { ...snapshot.desired, ...projectSettingsJson({ secrets }) }, warnings: [command] });
    const details = inspectSettings(safe, inspectionRequest({ paths: ["secrets"], format: "json" }));
    const rendered = inspectionText(details, "json");
    assert.doesNotMatch(rendered, /\$FILE:|\$ENV:/);
    assert.equal((details.desired as any).secrets[0].host_cmd, command);
    assert.equal((details.desired as any).secrets[1].host_env, "MISSING_PRIVATE_HOST_ENV");
    assert.equal(operationProblem(0, { path: "secrets", operation: "set", value: secrets }).path, "secrets");
    assert.equal(existsSync(marker), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("readable values cannot forge headings with ANSI, controls or embedded newlines", () => {
  const report = inspectionText({ outcome: "inspected", desired: { image: "safe\u001b[31m\nforged\rtitle" } });
  assert.doesNotMatch(report, /\u001b|\nforged|\r/); assert.match(report, /image: safe forged title/);
});
