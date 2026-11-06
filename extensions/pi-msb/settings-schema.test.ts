import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { applyOverride, ConfigError, DEFAULT_CONFIG, validateConfig } from "./config.ts";
import { valueAt } from "./settings-fields.ts";
import { effectiveNetworkPolicy, settingsSchema } from "./settings-schema.ts";
import { SETTINGS_PATHS } from "./settings.ts";
import { diagnoseConfigError, operationProblem, validationMessage } from "./settings-validation.ts";

const schema = settingsSchema() as Record<string, any>;
test("discovery value schemas describe every actual default", () => {
  for (const path of SETTINGS_PATHS) assert.equal(Check(schema[path].valueSchema, valueAt(DEFAULT_CONFIG, path)), true, path);
});
for (const [path, valid, invalid] of [
  ["cpus", [1, 64, 1.5], [0, 65, "2"]],
  ["memory_mib", [128, 2048], [0, 127, false]],
  ["idle_timeout_sec", [0, 1], [-1, "0"]],
  ["stop_timeout_ms", [1, 10000], [0, -1]],
  ["replace_timeout_ms", [1], [0]],
  ["docker.startup_timeout_ms", [1, 300000], [0, 300001, 1.5]],
  ["network.mode", ["default", "open", "allowlist", "deny"], ["sealed", 1]],
  ["docker.mode", ["auto", "require", "disabled"], ["default", false]],
  ["pull_policy", ["always", "if-missing", "never"], ["auto"]],
  ["bootstrap_tools", ["auto", true, false], ["true", null]],
] as const) test(`discovery ${path} constraints agree with backend validation`, () => {
  for (const value of valid) {
    assert.equal(Check(schema[path].valueSchema, value), true, JSON.stringify(value));
    assert.doesNotThrow(() => validateConfig(applyOverride({}, path, value)));
  }
  for (const value of invalid) {
    assert.equal(Check(schema[path].valueSchema, value), false, JSON.stringify(value));
    assert.throws(() => validateConfig(applyOverride({}, path, value)));
  }
});
test("agent secret schemas allow only host replacement sources and metadata-only retained upserts", () => {
  const metadata = { env: "TOKEN", allowHosts: ["api.example.com"] };
  const sources = { textValue: "synthetic", hostEnv: "HOST_TOKEN", hostCmd: "credential-helper get token" };
  const entries = Object.entries(sources);
  for (let mask = 0; mask < 8; mask++) {
    const selected = entries.filter((_, index) => mask & (1 << index));
    const entry = { ...metadata, ...Object.fromEntries(selected) };
    assert.equal(Check(schema.secrets.valueSchema, [entry]), !(mask & 1) && selected.length === 1, `set: ${mask}`);
    assert.equal(Check(schema.secrets.upsertSchema, entry), !(mask & 1) && selected.length <= 1, `upsert: ${mask}`);
  }
  assert.match(schema.secrets.upsertSchema.description, /retains the selected existing source/);
  assert.equal(Check(schema.secrets.upsertSchema, { ...metadata, allowHosts: ["*.googleapis.com"] }), true);
  for (const host of ["api*.example.com", "*.*.example.com", "*", "*.example.com:443", "https://*.example.com"]) {
    assert.equal(Check(schema.secrets.upsertSchema, { ...metadata, allowHosts: [host] }), false);
  }
});
test("agent secret schemas reject literal strings while manual config accepts them and constrain camelCase host sources", () => {
  const metadata = { env: "TOKEN", allowHosts: ["api.example.com"] };
  for (const value of ["", "$ENV:DO_NOT_EXPAND", "$FILE:/do/not/read", "$(do-not-execute)"]) {
    assert.equal(Check(schema.secrets.valueSchema, [{ ...metadata, textValue: value }]), false);
    assert.equal(Check(schema.secrets.upsertSchema, { ...metadata, textValue: value }), false);
    assert.doesNotThrow(() => validateConfig(applyOverride({}, "secrets", [{ ...metadata, textValue: value }])));
  }
  for (const source of [
    { hostEnv: "HOST_TOKEN" }, { hostCmd: "credential-helper get token" },
  ]) assert.equal(Check(schema.secrets.valueSchema, [{ ...metadata, ...source }]), true);
  for (const source of [
    { hostEnv: "" }, { hostEnv: "1TOKEN" }, { hostEnv: "TOKEN=private" }, { hostEnv: 123 },
    { hostCmd: "" }, { hostCmd: " \n\t" }, { hostCmd: [] },
    { host_env: "TOKEN" }, { host_cmd: "helper" }, { HOST_CMD: "helper" },
    { textValue: null }, { textValue: "literal", hostEnv: undefined },
    { value: "literal" }, { value: "literal", hostEnv: "TOKEN" }, { text_value: "literal" },
  ]) {
    assert.equal(Check(schema.secrets.valueSchema, [{ ...metadata, ...source }]), false, JSON.stringify(source));
    assert.equal(Check(schema.secrets.upsertSchema, { ...metadata, ...source }), false, JSON.stringify(source));
  }
  assert.equal(schema.secrets.valueSchema.items.properties.textValue, undefined);
  assert.equal(schema.secrets.upsertSchema.properties.textValue, undefined);
});
test("secret validation diagnostics advertise source rules without echoing private source strings", () => {
  const source = "PRIVATE_SOURCE_SENTINEL";
  const set = operationProblem(0, { path: "secrets", operation: "set", value: [{ hostCmd: source }] });
  const upsert = operationProblem(1, { path: "secrets", operation: "upsert", value: { hostEnv: source } });
  assert.deepEqual(set.expectedSchema, schema.secrets.valueSchema);
  assert.deepEqual(upsert.expectedSchema, schema.secrets.upsertSchema);
  assert.match(set.expected, /hostEnv.*hostCmd/);
  assert.match(upsert.expected, /retain/);
  const problems = diagnoseConfigError(new ConfigError([
    `secrets[0].hostCmd: ${source}`, `secrets[1].host_env: ${source}`, `unknown: ${source}`,
  ]), [{ path: "secrets" }])!;
  assert.equal(problems[0]!.path, "secrets");
  assert.equal(problems[0]!.operationIndex, 0);
  assert.match(validationMessage([set, upsert]), /never resolve sources or execute commands/);
  assert.doesNotMatch(JSON.stringify([set, upsert, problems, validationMessage(problems)]), /PRIVATE_SOURCE_SENTINEL|ENV\/FILE|mounts\/references/);
});
test("effective policy refuses incomplete/redacted/unrecognized network state rather than inventing adoption", () => {
  for (const value of [null, {}, { network: { mode: "deny" } }, { network: { mode: "<redacted>", allow_hosts: [], allow_dns: true, publish_ports: [] } }]) {
    assert.equal(effectiveNetworkPolicy(value), null);
  }
});
