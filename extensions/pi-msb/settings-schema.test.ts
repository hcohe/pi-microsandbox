import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { applyOverride, DEFAULT_CONFIG, validateConfig } from "./config.ts";
import { valueAt } from "./settings-fields.ts";
import { effectiveNetworkPolicy, settingsSchema } from "./settings-schema.ts";
import { SETTINGS_PATHS } from "./settings.ts";

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
test("native secret schemas distinguish required replacement credentials from retained upserts", () => {
  const metadata = { env: "TOKEN", allowHosts: ["api.example.com"] };
  assert.equal(Check(schema.secrets.upsertSchema, metadata), true);
  assert.equal(Check(schema.secrets.valueSchema, [metadata]), false);
  assert.equal(Check(schema.secrets.valueSchema, [{ ...metadata, value: "synthetic" }]), true);
  assert.equal(Check(schema.secrets.upsertSchema, { ...metadata, allowHosts: ["*.googleapis.com"] }), true);
  for (const host of ["api*.example.com", "*.*.example.com", "*", "*.example.com:443", "https://*.example.com"]) {
    assert.equal(Check(schema.secrets.upsertSchema, { ...metadata, allowHosts: [host] }), false);
  }
});
test("effective policy refuses incomplete/redacted/unrecognized network state rather than inventing adoption", () => {
  for (const value of [null, {}, { network: { mode: "deny" } }, { network: { mode: "<redacted>", allow_hosts: [], allow_dns: true, publish_ports: [] } }]) {
    assert.equal(effectiveNetworkPolicy(value), null);
  }
});
