import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSandboxLabels,
  buildVolumeLabels,
  decodeSessionState,
  encodeSessionState,
  normalizeSandboxRecord,
  normalizeVolumeRecord,
  parseCliSandboxList,
  validateManagedSandbox,
} from "./labels.ts";
import {
  LABEL_KEYS,
  STATE_SCHEMA_VERSION,
  type PersistedSandboxState,
} from "./types.ts";

test("builds golden full-session sandbox labels", () => {
  const labels = buildSandboxLabels({
    sessionId: "session-full-alpha",
    mode: "git",
    cwd: "/work/project",
    pid: 4321,
    image: "ubuntu:24.04",
    volumeName: "pi-msb-vol-full",
    seedBranch: "feature/labels",
    seedSha: "0123456789abcdef",
  });

  assert.deepEqual(labels, {
    [LABEL_KEYS.managed]: "true",
    [LABEL_KEYS.schema]: "1",
    [LABEL_KEYS.session]: "session-full-alpha",
    [LABEL_KEYS.mode]: "git",
    [LABEL_KEYS.cwd]: "/work/project",
    [LABEL_KEYS.pid]: "4321",
    [LABEL_KEYS.image]: "ubuntu:24.04",
    [LABEL_KEYS.keep]: "true",
    [LABEL_KEYS.volume]: "pi-msb-vol-full",
    [LABEL_KEYS.seedBranch]: "feature/labels",
    [LABEL_KEYS.seedSha]: "0123456789abcdef",
  });
});

test("fails closed when git labels have no volume", () => {
  assert.throws(
    () =>
      buildSandboxLabels({
        sessionId: "session-full-alpha",
        mode: "git",
        cwd: "/work/project",
        pid: 4321,
        image: "ubuntu:24.04",
      }),
    /git sandbox labels require a volume name/,
  );
  assert.throws(
    () =>
      buildSandboxLabels({
        sessionId: "session-full-alpha",
        mode: "git",
        cwd: "/work/project",
        pid: 4321,
        image: "ubuntu:24.04",
        volumeName: "",
      }),
    /git sandbox labels require a volume name/,
  );
});

test("builds volume labels and omits unavailable seed values", () => {
  assert.deepEqual(
    buildVolumeLabels({
      sessionId: "session-full-alpha",
      cwd: "/work/project",
      seedBranch: null,
      seedSha: null,
    }),
    {
      [LABEL_KEYS.managed]: "true",
      [LABEL_KEYS.schema]: "1",
      [LABEL_KEYS.session]: "session-full-alpha",
      [LABEL_KEYS.cwd]: "/work/project",
      [LABEL_KEYS.keep]: "true",
    },
  );
});

test("normalizes SDK maps and tuple-array label variants while preserving unknown data", () => {
  const fromMap = normalizeSandboxRecord({
    name: "sandbox-full-name",
    labels: {
      [LABEL_KEYS.managed]: "true",
      "custom.label": "kept",
    },
    status: "running",
    providerField: 42,
  });
  assert.equal(fromMap?.name, "sandbox-full-name");
  assert.equal(fromMap?.labels["custom.label"], "kept");
  assert.equal(Reflect.get(fromMap, "providerField"), 42);

  const fromTuples = normalizeSandboxRecord({
    id: "sandbox-tuple",
    metadata: {
      labels: [
        [LABEL_KEYS.managed, "true"],
        [LABEL_KEYS.schema, STATE_SCHEMA_VERSION],
        { key: "custom.label", value: "kept-too" },
        null,
      ],
    },
    state: "stopped",
    created_at: 123,
  });
  assert.deepEqual(fromTuples?.labels, {
    [LABEL_KEYS.managed]: "true",
    [LABEL_KEYS.schema]: "1",
    "custom.label": "kept-too",
  });
  assert.equal(fromTuples?.name, "sandbox-tuple");
  assert.equal(fromTuples?.status, "stopped");
  assert.equal(fromTuples?.createdAt, 123);
});

test("normalizes volume path variants and skips malformed rows", () => {
  const volume = normalizeVolumeRecord({
    name: "volume-full-name",
    path: "/var/lib/microsandbox/volume-full-name",
    labels: [[LABEL_KEYS.managed, "true"]],
    type: "directory",
    used_bytes: 99,
  });
  assert.equal(volume?.hostPath, "/var/lib/microsandbox/volume-full-name");
  assert.equal(volume?.kind, "directory");
  assert.equal(volume?.usedBytes, 99);
  assert.equal(normalizeVolumeRecord({ name: "missing-labels", path: "/tmp/x" }), null);
  assert.equal(normalizeSandboxRecord({ labels: {} }), null);
});

test("CLI fallback is strict about its top-level shape", () => {
  const rows = parseCliSandboxList(
    JSON.stringify({
      sandboxes: [
        { name: "valid", labels: { [LABEL_KEYS.managed]: "true" } },
        { labels: { [LABEL_KEYS.managed]: "true" } },
        null,
      ],
    }),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.name, "valid");
  assert.deepEqual(parseCliSandboxList("[]"), []);

  assert.throws(() => parseCliSandboxList("not json"), /invalid sandbox list JSON/);
  assert.throws(() => parseCliSandboxList("{}"), /invalid sandbox list shape/);
  assert.throws(() => parseCliSandboxList('{"sandboxes":{}}'), /invalid sandbox list shape/);
  assert.throws(() => parseCliSandboxList("null"), /invalid sandbox list shape/);
});

test("rejects volume labels for direct and none modes", () => {
  for (const mode of ["direct", "none"] as const) {
    const labels = buildSandboxLabels({
      sessionId: "session-full-alpha",
      mode,
      cwd: "/work/project",
      pid: 4321,
      image: "ubuntu:24.04",
    });
    const record = normalizeSandboxRecord({ name: `sandbox-${mode}`, labels });
    assert.ok(record);
    assert.ok(validateManagedSandbox(record));

    const conflicting = normalizeSandboxRecord({
      name: `sandbox-${mode}-conflict`,
      labels: { ...labels, [LABEL_KEYS.volume]: "unexpected-volume" },
    });
    assert.ok(conflicting);
    assert.equal(validateManagedSandbox(conflicting), null);
  }
});

test("validates managed labels with the full session and schema", () => {
  const record = normalizeSandboxRecord({
    name: "pi-msb-full-resource-name",
    labels: buildSandboxLabels({
      sessionId: "session-full-alpha",
      mode: "git",
      cwd: "/work/project",
      pid: 4321,
      image: "ubuntu:24.04",
      volumeName: "pi-msb-vol-full",
    }),
  });
  assert.ok(record);
  const validated = validateManagedSandbox(record);
  assert.equal(validated?.sessionId, "session-full-alpha");
  assert.equal(validated?.volumeName, "pi-msb-vol-full");

  const wrongSchema = { ...record, labels: { ...record.labels, [LABEL_KEYS.schema]: "0" } };
  assert.equal(validateManagedSandbox(wrongSchema), null);
  const missingGitVolume = {
    ...record,
    labels: { ...record.labels, [LABEL_KEYS.volume]: "" },
  };
  assert.equal(validateManagedSandbox(missingGitVolume), null);
});

test("encodes current state and rejects forked, old, or malformed state", () => {
  const state: PersistedSandboxState = {
    version: STATE_SCHEMA_VERSION,
    sessionId: "session-full-alpha",
    sandboxName: "pi-msb-full-resource-name",
    mode: "git",
    cwd: "/work/project",
    image: "ubuntu:24.04",
    volumeName: "pi-msb-vol-full",
    volumeHostPath: "/var/lib/microsandbox/volume-full",
    seedBranch: "main",
    seedSha: "0123456789abcdef",
    enabled: true,
    createdAt: 123,
  };
  const encoded = encodeSessionState(state);
  assert.deepEqual(encoded, state);
  assert.notEqual(encoded, state);

  assert.deepEqual(decodeSessionState(encoded, "session-full-alpha"), state);
  assert.equal(decodeSessionState({ ...encoded, version: 0 }, "session-full-alpha"), null);
  assert.equal(decodeSessionState({ ...encoded, sessionId: "parent-session" }, "session-full-alpha"), null);
  assert.equal(decodeSessionState({ ...encoded, sessionId: "99b1d2" }, "session-full-alpha"), null);
  assert.equal(decodeSessionState({ ...encoded, enabled: "true" }, "session-full-alpha"), null);
});
