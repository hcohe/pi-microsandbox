import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError } from "./config.ts";
import { configurationFailureSnapshot, formatConfigurationFailure } from "./configuration-failure.ts";
import { boundDiagnosticsReport, MAX_DIAGNOSTICS_BYTES, registerDiagnosticsTool } from "./diagnostics-tools.ts";

const privateText = "REJECTED_SECRET\x1b[31m\u202e/host/private/path";

test("configuration failure snapshots retain only immutable static constraints and survive both diagnostics bounds", async () => {
  const error = new ConfigError([`cpus: ${privateText}`, `secrets[123].allowHosts: ${privateText}`, `${privateText}: bad`]);
  const snapshot = configurationFailureSnapshot(error);
  assert.equal(snapshot.kind, "validation");
  assert.equal(snapshot.problems[0]?.path, "cpus");
  assert.deepEqual(snapshot.problems[0]?.expectedSchema, { type: "number", minimum: 1, maximum: 64 });
  assert.equal(snapshot.problems[1]?.path, "secrets");
  assert.equal(snapshot.problems[2]?.path, undefined);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.problems));
  assert.ok(Object.isFrozen(snapshot.problems[0]?.expectedSchema));
  (error.issues as string[])[0] = "MUTATED_SECRET";
  const report = { outcome: "diagnosed", configurationFailure: snapshot };
  assert.deepEqual(boundDiagnosticsReport(boundDiagnosticsReport(report)), boundDiagnosticsReport(report));
  let tool: any;
  registerDiagnosticsTool({ registerTool(value: unknown) { tool = value; } } as any, { getDiagnostics: async () => boundDiagnosticsReport(report) } as any);
  for (const format of ["text", "json"]) {
    const output = await tool.execute("diag", { format });
    assert.equal(output.details.configurationFailure, snapshot);
    assert.doesNotMatch(JSON.stringify(output), /REJECTED_SECRET|MUTATED_SECRET|private\/path/);
    assert.doesNotMatch(JSON.stringify(snapshot), /[\p{Cc}\p{Cf}]/u);
    assert.ok(Buffer.byteLength(JSON.stringify(output.details)) < MAX_DIAGNOSTICS_BYTES);
  }
  assert.doesNotMatch(formatConfigurationFailure(snapshot), /REJECTED_SECRET/);
  for (const hostile of [{ ...snapshot, summary: privateText }, { kind: "syntax", problems: [{ expected: privateText }], sanitized: true }]) {
    const bounded = boundDiagnosticsReport({ outcome: "diagnosed", configurationFailure: hostile });
    assert.equal(bounded.configurationFailure, undefined);
    assert.doesNotMatch(JSON.stringify(bounded), /REJECTED_SECRET/);
  }
});

for (const [issue, kind] of [
  [`invalid TOML in ${privateText}`, "syntax"],
  ["host configuration could not be read", "read"],
  ["host configuration path could not be canonicalized", "read"],
  ["host configuration must be outside the mounted workspace", "policy"],
  ["writable host mounts must not expose host configuration", "policy"],
] as const) test(`configuration failure classifies ${kind} without source/error text: ${issue.split(" ")[0]}`, () => {
  const snapshot = configurationFailureSnapshot(new ConfigError([issue]));
  assert.equal(snapshot.kind, kind);
  assert.equal(snapshot.problems.length, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /REJECTED_SECRET/);
  if (kind === "syntax") assert.match(snapshot.summary, /TOML syntax/);
});

test("unknown exceptions and oversized configuration issues are withheld and bounded", () => {
  const unknown = configurationFailureSnapshot(new Error(privateText));
  assert.equal(unknown.kind, "unknown");
  assert.doesNotMatch(JSON.stringify(unknown), /REJECTED_SECRET/);
  const many = configurationFailureSnapshot(new ConfigError(Array.from({ length: 10000 }, () => `mounts[123].hostPath: ${privateText}`)));
  assert.ok(many.problems.length <= 32);
  assert.equal(many.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(many)) < 18 * 1024);
  assert.doesNotMatch(JSON.stringify(many), /REJECTED_SECRET/);
});
