import assert from "node:assert/strict";
import test from "node:test";
import { boundDiagnosticsReport, MAX_DIAGNOSTICS_BYTES, registerDiagnosticsTool } from "./diagnostics-tools.ts";
import { imagePreparationFailureSnapshot } from "./image-boot-notice.ts";
import { ImagePhaseError } from "./image-build.ts";
import { createSettingsSanitizer } from "./settings-redaction.ts";
import type { MsbControl } from "./types.ts";

function tool(control: Partial<MsbControl>) {
  let definition: any;
  registerDiagnosticsTool({ registerTool(value: unknown) { definition = value; } } as any, control as MsbControl);
  return definition;
}

test("strict minimal runtime input rejects unknown fields without touching adapter", async () => {
  let calls = 0;
  const d = tool({ async getDiagnostics() { calls++; return { outcome: "diagnosed" }; } });
  assert.equal(d.parameters.additionalProperties, false);
  for (const input of [null, [], "json", { path: "secret" }, { command: "whoami" }, { format: null }, { format: 1 }, { format: { toString: () => "json" } }, { [Symbol()]: 1 }]) {
    const output = await d.execute("id", input);
    assert.equal(output.details.outcome, "rejected");
    assert.ok(!JSON.stringify(output).includes("whoami"));
  }
  assert.equal(calls, 0);
  for (const input of [{}, { format: "json" }, { format: "text" }]) assert.equal((await d.execute("id", input)).details.outcome, "diagnosed");
  assert.equal(calls, 3);
});

test("optional adapter facade calls no fallback getters and suppresses exceptions", async () => {
  const unavailable = tool(new Proxy({}, { get(_t, key) { if (key === "getDiagnostics") return undefined; throw new Error("private adapter failure"); } }));
  assert.equal((await unavailable.execute("id", {})).details.outcome, "unavailable");
  const failing = tool({ async getDiagnostics() { throw new Error("private adapter failure\u001b[31m"); } });
  const output = await failing.execute("id", {});
  assert.equal(output.details.outcome, "unavailable");
  assert.ok(!JSON.stringify(output).includes("private adapter"));
});

test("oversized malicious metadata never reaches text, details or renderers", async () => {
  const secret = "PRIVATE_TOKEN\u001b[31m\u202e";
  const report: any = { outcome: "diagnosed", reason: secret, toJSON() { throw new Error(secret); },
    runtime: { status: secret, execution: secret, reason: secret },
    readiness: { configReady: false }, host: { platform: secret, arch: secret, node: secret },
    desired: { validForSession: true, settings: { hostCmd: secret, textValue: secret } },
    failure: { phase: secret, reason: secret }, adoption: { known: true, verification: secret },
    huge: secret.repeat(100_000), [secret]: secret };
  report.cycle = report;
  const d = tool({ async getDiagnostics() { return report; } });
  for (const format of ["text", "json"]) {
    const output = await d.execute("id", { format });
    const json = JSON.stringify(output.details);
    assert.ok(!json.includes("PRIVATE_TOKEN"));
    assert.ok(!/[\p{Cc}\p{Cf}]/u.test(json));
    assert.ok(Buffer.byteLength(json) <= MAX_DIAGNOSTICS_BYTES);
    assert.ok(Buffer.byteLength(output.content[0].text) <= MAX_DIAGNOSTICS_BYTES);
    assert.equal(output.details.desired.settings, undefined);
  }
  assert.deepEqual(boundDiagnosticsReport(report), boundDiagnosticsReport(report));
});

test("throwing metadata getters are contained without leaking raw error", async () => {
  const d = tool({ async getDiagnostics() { return { get runtime() { throw new Error("PRIVATE"); }, outcome: "diagnosed" }; } });
  const result = await d.execute("id", {});
  assert.equal(result.details.outcome, "unavailable");
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
});


test("only immutable failure-time sanitized snapshots survive double bounding; hostile adapter fields stay withheld", async () => {
  const secret = " whitespace-private-token\n";
  const hostile = `${secret}\x1b\u202e\u2066\u2028\u2029\ud800`;
  const error = new ImagePhaseError("build", hostile, [{
    phase: "build", command: "docker", args: [hostile], stdout: `${hostile} stdout-tail`,
    stderr: `${hostile} stderr-tail`, exitCode: 37, truncated: false,
  }]);
  const snapshot = imagePreparationFailureSnapshot(error, createSettingsSanitizer([{ textValue: secret }]), "build");
  assert.ok(Object.isFrozen(snapshot));
  // Mutation of the original errors/logs must not affect cached evidence.
  error.logs[0]!.stderr = "MUTATED_PRIVATE";
  for (const failure of [{ ...snapshot, sanitized: true, message: hostile }, { sanitized: true, stderrTail: hostile }]) {
    const output = await tool({ async getDiagnostics() { return { outcome: "diagnosed", imagePreparationFailure: failure }; } }).execute("diag", {});
    assert.equal(output.details.imagePreparationFailure, undefined);
    assert.doesNotMatch(JSON.stringify(output), /whitespace-private-token/);
  }
  const report = { outcome: "diagnosed", imagePreparationFailure: snapshot };
  assert.deepEqual(boundDiagnosticsReport(boundDiagnosticsReport(report)), boundDiagnosticsReport(report));
  for (const format of ["text", "json"]) {
    const output = await tool({ async getDiagnostics() { return boundDiagnosticsReport(report); } }).execute("diag", { format });
    assert.equal(output.details.imagePreparationFailure.exitCode, 37);
    assert.match(output.details.imagePreparationFailure.stderrTail, /<redacted>.*stderr-tail/);
    assert.match(output.details.imagePreparationFailure.stdoutTail, /<redacted>.*stdout-tail/);
    assert.doesNotMatch(JSON.stringify(output), /whitespace-private-token|MUTATED_PRIVATE/);
    assert.doesNotMatch(JSON.stringify(output.details), /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
  }
});

test("maximal Unicode and JSON-escaped cached failure remains bounded in both representations", async () => {
  for (const character of ["😀", '"', "\\", "\uFFFF"]) {
    const large = character.repeat(100_000);
    const error = new ImagePhaseError("export", large, [{
      phase: "export", command: large, args: [large], stdout: large, stderr: large, truncated: false, exitCode: 42,
    }]);
    const snapshot = imagePreparationFailureSnapshot(error, (text) => text);
    for (const format of ["text", "json"]) {
      const output = await tool({ async getDiagnostics() { return { outcome: "diagnosed", imagePreparationFailure: snapshot }; } }).execute("diag", { format });
      assert.equal(output.details.outcome, "diagnosed");
      assert.equal(output.details.imagePreparationFailure.phase, "export");
      assert.ok(Buffer.byteLength(output.content[0].text) <= MAX_DIAGNOSTICS_BYTES);
      assert.ok(Buffer.byteLength(JSON.stringify(output.details)) <= MAX_DIAGNOSTICS_BYTES);
    }
  }
});
