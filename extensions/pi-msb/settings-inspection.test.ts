import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { inspectSettings, inspectionParameters, inspectionRequest, inspectionResult, inspectionText } from "./settings-inspection.ts";

const snapshot = {
  desired: { cpus: 4, network: { mode: "allowlist", allow_hosts: ["github.com"], allow_dns: true, publish_ports: [] } },
  layers: { global: {}, project: {}, session: { network: { mode: "allowlist" } } },
  runtime: { status: "active", adopted: null }, warnings: [],
};
test("inspection parameter schema matches execute-time filters, including absent/optional arguments", () => {
  for (const value of [{}, { sections: ["schema"], paths: ["network", "secrets"], format: "json", knownSchemaVersion: 2 }]) {
    assert.equal(Check(inspectionParameters, value), true); assert.doesNotThrow(() => inspectionRequest(value));
  }
  for (const value of [{ sections: [] }, { paths: ["network.mode[0]"] }, { format: "yaml" }, { knownSchemaVersion: -1 }, { all: true }]) {
    assert.equal(Check(inspectionParameters, value), false); assert.throws(() => inspectionRequest(value));
  }
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
test("readable values cannot forge headings with ANSI, controls or embedded newlines", () => {
  const report = inspectionText({ outcome: "inspected", desired: { image: "safe\u001b[31m\nforged\rtitle" } });
  assert.doesNotMatch(report, /\u001b|\nforged|\r/); assert.match(report, /image: safe forged title/);
});
