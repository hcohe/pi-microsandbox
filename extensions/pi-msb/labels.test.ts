import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSandboxLabels,
  decodeSessionState,
  encodeSessionState,
  normalizeSandboxRecord,
  parseCliSandboxList,
  validateManagedSandbox,
} from "./labels.ts";
import { LABEL_KEYS, STATE_SCHEMA_VERSION, type PersistedSandboxState } from "./types.ts";

const input = {
  sessionId: "session-full-alpha",
  cwd: "/work/project/packages/app",
  root: "/canonical/work/project",
  guestRoot: "/work/project",
  pid: 4321,
  image: "ubuntu:24.04",
};

test("builds the current root-based sandbox identity", () => {
  assert.deepEqual(buildSandboxLabels(input), {
    [LABEL_KEYS.managed]: "true",
    [LABEL_KEYS.schema]: String(STATE_SCHEMA_VERSION),
    [LABEL_KEYS.session]: input.sessionId,
    [LABEL_KEYS.cwd]: input.cwd,
    [LABEL_KEYS.root]: input.root,
    [LABEL_KEYS.guestRoot]: input.guestRoot,
    [LABEL_KEYS.pid]: "4321",
    [LABEL_KEYS.image]: input.image,
    [LABEL_KEYS.keep]: "true",
  });
});

test("normalizes SDK label variants and parses CLI lists strictly", () => {
  const tuples = normalizeSandboxRecord({
    id: "sandbox-tuple",
    metadata: { labels: [[LABEL_KEYS.managed, "true"], [LABEL_KEYS.schema, STATE_SCHEMA_VERSION], { key: "custom", value: true }] },
    state: "stopped",
    created_at: 123,
  });
  assert.deepEqual(tuples, {
    name: "sandbox-tuple",
    labels: { [LABEL_KEYS.managed]: "true", [LABEL_KEYS.schema]: String(STATE_SCHEMA_VERSION), custom: "true" },
    status: "stopped",
    createdAt: 123,
  });
  assert.equal(parseCliSandboxList(JSON.stringify({ sandboxes: [{ name: "valid", labels: {} }, { labels: {} }] })).length, 1);
  assert.throws(() => parseCliSandboxList("not json"), /invalid sandbox list JSON/);
  assert.throws(() => parseCliSandboxList("{}"), /invalid sandbox list shape/);
});

test("managed sandbox validation requires current schema, canonical root, cwd, image, and pid", () => {
  const record = normalizeSandboxRecord({ name: "pi-msb-full", labels: buildSandboxLabels(input) });
  assert.ok(record);
  assert.deepEqual(validateManagedSandbox(record), {
    ...record,
    sessionId: input.sessionId,
    cwd: input.cwd,
    root: input.root,
    guestRoot: input.guestRoot,
  });
  for (const key of [LABEL_KEYS.root, LABEL_KEYS.guestRoot, LABEL_KEYS.cwd, LABEL_KEYS.image, LABEL_KEYS.pid]) {
    assert.equal(validateManagedSandbox({ ...record, labels: { ...record.labels, [key]: "" } }), null);
  }
  assert.equal(validateManagedSandbox({ ...record, labels: { ...record.labels, [LABEL_KEYS.schema]: "1" } }), null);
});

test("current persisted state round trips while old and malformed schemas are not restored", () => {
  const state: PersistedSandboxState = {
    version: STATE_SCHEMA_VERSION,
    sessionId: input.sessionId,
    sandboxName: "pi-msb-full",
    cwd: input.cwd,
    root: input.root,
    guestRoot: input.guestRoot,
    image: input.image,
    enabled: true,
    createdAt: 123,
  };
  const encoded = encodeSessionState(state);
  assert.deepEqual(encoded, state);
  assert.notEqual(encoded, state);
  assert.deepEqual(decodeSessionState(encoded, input.sessionId), state);
  assert.equal(decodeSessionState({ ...encoded, version: 1, mode: "git", volumeName: "legacy" }, input.sessionId), null);
  assert.equal(decodeSessionState({ ...encoded, sessionId: "fork" }, input.sessionId), null);
  assert.equal(decodeSessionState({ ...encoded, root: "" }, input.sessionId), null);
});
