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
  assert.deepEqual(lines, [
    { kind: "context", text: "Scope: Project" }, { kind: "context", text: "Secret TOKEN" },
    { kind: "removed", label: "Hosts", text: "old.example" }, { kind: "added", label: "Hosts", text: "new.example" },
  ]);
  assert.doesNotMatch(formatSettingsDiff(lines).join("\n"), /NOT_FOR_DISPLAY|keep.example|\x1b/);
  const calls: string[] = [];
  const theme = { fg: (role: string, text: string) => { calls.push(role); return `<${role}>${text}</${role}>`; }, bold: (text: string) => text };
  const styled = formatSettingsDiff([...lines, { kind: "context", text: "+ not a diff" }], theme).join("\n");
  assert.match(styled, /<toolDiffRemoved>old.example/); assert.match(styled, /<toolDiffAdded>new.example/);
  assert.match(styled, /<muted>Hosts: /); assert.match(styled, /<muted>\+ not a diff/);
  assert.ok(calls.includes("toolDiffAdded") && calls.includes("toolDiffRemoved"));
});

test("settings diff: equal redacted values remain a visible private change, without claiming retained credentials changed", () => {
  const changed = formatSettingsDiff(settingsDiff(review({ deltas: [{ entry: "TOKEN", field: "credential", before: "<redacted>", after: "<redacted>" }] }))).join("\n");
  assert.match(changed, /- Credential: <redacted>\n\+ Credential: <redacted> \(changed\)/);
  const noOp = formatSettingsDiff(settingsDiff(review({ deltas: [], changed: false, effectiveChanged: false }))).join("\n");
  assert.match(noOp, /No change/); assert.doesNotMatch(noOp, /Credential|Restarts/);
});

test("settings diff: array ordering is visible, and terminal controls cannot create a forged styled line", () => {
  const lines = settingsDiff(review({ deltas: [{ field: "order", before: ["A", "B"], after: ["B", "A"] }, { field: "path", before: undefined, after: "safe\x1b[31m\n- forged" }] }));
  const plain = formatSettingsDiff(lines).join("\n");
  assert.match(plain, /- Order: \["A","B"\]\n\+ Order: \["B","A"\]/);
  assert.doesNotMatch(plain, /\x1b|\n- forged/);
});


test("settings diff: inherited comparisons get one short caption, not new entries or no-ops", () => {
  const inherited = review({ baseline: "inherited", targetBefore: "inherit" });
  assert.match(formatSettingsDiff(settingsDiff(inherited)).join("\n"), /Overrides inherited values/);
  const added = review({ baseline: "inherited", targetBefore: "inherit", deltas: [{ entry: "NEW", field: "credential", before: undefined, after: "<redacted>" }] });
  assert.doesNotMatch(formatSettingsDiff(settingsDiff(added)).join("\n"), /Overrides inherited/);
  const noOp = review({ baseline: "inherited", changed: false, deltas: [] });
  assert.doesNotMatch(formatSettingsDiff(settingsDiff(noOp)).join("\n"), /Overrides inherited/);
});

test("settings diff: routine same-scope edits omit repeated identity, source, operation and target jargon", () => {
  const data = { ...review(), collections: [{ path: "secrets", operation: "upsert", identities: ["TOKEN"], source: "host-project", promoted: false, shadowed: false }] };
  const text = formatSettingsDiff(settingsDiff(data)).join("\n");
  assert.equal(text, "Scope: Project\nSecret TOKEN\n- Hosts: old.example\n+ Hosts: new.example");
  assert.doesNotMatch(text, /upsert|Target:|Entry source|explicit/);
});

for (const [scope, label] of [["session", "Session"], ["project", "Project"], ["global", "Global"], ["ephemeral", "Session"], ["temporary", "Session"]]) {
  test(`settings diff: canonical scope line for ${scope}, including historical display aliases`, () => {
    const text = formatSettingsDiff(settingsDiff({ ...review(), scope })).join("\n");
    assert.equal(text, `Scope: ${label}\nSecret TOKEN\n- Hosts: old.example\n+ Hosts: new.example`);
    const promoted = { ...review(), scope: "global", collections: [{ path: "secrets", promoted: true, source: scope }] };
    assert.match(formatSettingsDiff(settingsDiff(promoted)).join("\n"), new RegExp(`Copies this entry from ${label} into Global;`));
  });
}

test("settings diff: historical reviews without focused safe data do not fall back to raw JSON", () => {
  assert.deepEqual(settingsDiff({ scope: "ephemeral", desired: { value: "PRIVATE_SENTINEL" } }), []);
});
