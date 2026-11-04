import assert from "node:assert/strict";
import test from "node:test";
import { formatSettingsDiff, settingsDiff } from "./settings-diff.ts";
import type { SettingsReviewFocus } from "./settings.ts";

function review(overrides: Partial<SettingsReviewFocus> = {}) {
  const focus: SettingsReviewFocus = {
    path: "secrets", operation: "upsert", identity: "TOKEN", targetBefore: "explicit", targetAfter: "explicit", baseline: "target",
    changed: true, effectiveChanged: true, shadowed: false, writableMount: false, replacesEntry: false, hostBypass: [], inheritedDeltas: [], reconciledDeltas: [],
    deltas: [{ entry: "TOKEN", field: "allow_hosts", before: ["keep.example", "old.example"], after: ["keep.example", "new.example"] }], ...overrides,
  };
  return { scope: "project", focus: [focus], collections: [], shadowed: [], effect: "live", desired: { unrelated: "NOT_FOR_DISPLAY" }, warnings: ["NOT_FOR_DISPLAY"] };
}

test("settings diff: focused semantic lines share plain RPC and themed output without guessing prefixes", () => {
  const lines = settingsDiff(review());
  assert.deepEqual(lines.filter((line) => ["added", "removed"].includes(line.kind)), [
    { kind: "removed", label: "allow_hosts", text: "old.example" }, { kind: "added", label: "allow_hosts", text: "new.example" },
  ]);
  assert.doesNotMatch(formatSettingsDiff(lines).join("\n"), /NOT_FOR_DISPLAY|keep.example|\x1b/);
  const calls: string[] = [];
  const theme = { fg: (role: string, text: string) => { calls.push(role); return `<${role}>${text}</${role}>`; }, bold: (text: string) => text };
  const styled = formatSettingsDiff([...lines, { kind: "context", text: "+ not a diff" }], theme).join("\n");
  assert.match(styled, /<toolDiffRemoved>old.example/); assert.match(styled, /<toolDiffAdded>new.example/);
  assert.match(styled, /<muted>allow_hosts: /); assert.match(styled, /<muted>\+ not a diff/);
  assert.ok(calls.includes("toolDiffAdded") && calls.includes("toolDiffRemoved"));
});

test("settings diff: equal redacted values remain a visible private change, without claiming retained credentials changed", () => {
  const changed = formatSettingsDiff(settingsDiff(review({ deltas: [{ entry: "TOKEN", field: "credential", before: "<redacted>", after: "<redacted>" }] }))).join("\n");
  assert.match(changed, /- credential: <redacted>\n\+ credential: <redacted> \(changed\)/);
  const noOp = formatSettingsDiff(settingsDiff(review({ deltas: [], changed: false, effectiveChanged: false }))).join("\n");
  assert.match(noOp, /No stored change/); assert.doesNotMatch(noOp, /credential|Restart/);
});

test("settings diff: array ordering is visible, and terminal controls cannot create a forged styled line", () => {
  const lines = settingsDiff(review({ deltas: [{ field: "order", before: ["A", "B"], after: ["B", "A"] }, { field: "path", before: undefined, after: "safe\x1b[31m\n- forged" }] }));
  const plain = formatSettingsDiff(lines).join("\n");
  assert.match(plain, /- order: \["A","B"\]\n\+ order: \["B","A"\]/);
  assert.doesNotMatch(plain, /\x1b|\n- forged/);
});
