/** Managed microsandbox labels and persisted session state. */
import {
  LABEL_KEYS,
  STATE_SCHEMA_VERSION,
  type ManagedSandboxRecord,
  type PersistedSandboxState,
  type SandboxLabelInput,
  type StorageMode,
  type ValidatedManagedSandbox,
  type VolumeLabelInput,
  type VolumeRecord,
} from "./types.ts";

const STORAGE_MODES: readonly StorageMode[] = ["git", "direct", "none"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStorageMode(value: unknown): value is StorageMode {
  return typeof value === "string" && STORAGE_MODES.includes(value as StorageMode);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * SDK versions have returned labels both as maps and as entry/tuple arrays.
 * Keep that tolerance in this module so callers never need to know the SDK shape.
 */
function normalizeLabels(value: unknown): Record<string, string> | null {
  const labels: Record<string, string> = {};

  if (isRecord(value)) {
    for (const [key, labelValue] of Object.entries(value)) {
      if (!key || labelValue === null || labelValue === undefined) continue;
      if (
        typeof labelValue === "string" ||
        typeof labelValue === "number" ||
        typeof labelValue === "boolean"
      ) {
        labels[key] = String(labelValue);
      }
    }
    return labels;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      let key: unknown;
      let labelValue: unknown;

      if (Array.isArray(entry)) {
        [key, labelValue] = entry;
      } else if (isRecord(entry)) {
        key = entry.key ?? entry.name;
        labelValue = entry.value;
      }

      if (
        typeof key !== "string" ||
        key.length === 0 ||
        (typeof labelValue !== "string" &&
          typeof labelValue !== "number" &&
          typeof labelValue !== "boolean")
      ) {
        // A bad label entry must not make otherwise useful SDK output unusable.
        continue;
      }
      labels[key] = String(labelValue);
    }
    return labels;
  }

  return null;
}

function rawRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;

  // Some CLI/SDK adapters expose a record as [name, labels]. Accept this only
  // at the normalization boundary; all public functions return object records.
  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "string"
  ) {
    return { name: value[0], labels: value[1] };
  }

  return null;
}

function labelsFromRaw(raw: Record<string, unknown>): Record<string, string> | null {
  const direct = raw.labels;
  if (direct !== undefined) return normalizeLabels(direct);

  const metadata = raw.metadata;
  if (isRecord(metadata) && metadata.labels !== undefined) {
    return normalizeLabels(metadata.labels);
  }

  return null;
}

function optionalString(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "string") target[key] = value;
  else delete target[key];
}

function optionalNumber(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (finiteNumber(value)) target[key] = value;
  else delete target[key];
}

export function buildSandboxLabels(input: SandboxLabelInput): Record<string, string> {
  const labels: Record<string, string> = {
    [LABEL_KEYS.managed]: "true",
    [LABEL_KEYS.schema]: String(STATE_SCHEMA_VERSION),
    [LABEL_KEYS.session]: input.sessionId,
    [LABEL_KEYS.mode]: input.mode,
    [LABEL_KEYS.cwd]: input.cwd,
    [LABEL_KEYS.pid]: String(input.pid),
    [LABEL_KEYS.image]: input.image,
    [LABEL_KEYS.keep]: "true",
  };

  if (input.mode === "git") {
    if (!nonEmptyString(input.volumeName)) {
      throw new Error("git sandbox labels require a volume name");
    }
    labels[LABEL_KEYS.volume] = input.volumeName;
    if (input.seedBranch !== undefined && input.seedBranch !== null) {
      labels[LABEL_KEYS.seedBranch] = input.seedBranch;
    }
    if (input.seedSha !== undefined && input.seedSha !== null) {
      labels[LABEL_KEYS.seedSha] = input.seedSha;
    }
  }

  return labels;
}

export function buildVolumeLabels(input: VolumeLabelInput): Record<string, string> {
  const labels: Record<string, string> = {
    [LABEL_KEYS.managed]: "true",
    [LABEL_KEYS.schema]: String(STATE_SCHEMA_VERSION),
    [LABEL_KEYS.session]: input.sessionId,
    [LABEL_KEYS.cwd]: input.cwd,
    [LABEL_KEYS.keep]: "true",
  };

  if (input.seedBranch !== undefined && input.seedBranch !== null) {
    labels[LABEL_KEYS.seedBranch] = input.seedBranch;
  }
  if (input.seedSha !== undefined && input.seedSha !== null) {
    labels[LABEL_KEYS.seedSha] = input.seedSha;
  }

  return labels;
}

export function normalizeSandboxRecord(value: unknown): ManagedSandboxRecord | null {
  const raw = rawRecord(value);
  if (!raw) return null;

  const labels = labelsFromRaw(raw);
  const name = raw.name ?? raw.id ?? raw.sandboxName;
  if (!labels || !nonEmptyString(name)) return null;

  const normalized: Record<string, unknown> = { ...raw, name, labels };
  optionalString(normalized, "status", raw.status ?? raw.state);
  optionalNumber(normalized, "createdAt", raw.createdAt ?? raw.created_at);
  return normalized as unknown as ManagedSandboxRecord;
}

export function normalizeVolumeRecord(value: unknown): VolumeRecord | null {
  const raw = rawRecord(value);
  if (!raw) return null;

  const labels = labelsFromRaw(raw);
  const name = raw.name ?? raw.id ?? raw.volumeName;
  const hostPath = raw.hostPath ?? raw.path ?? raw.host_path;
  if (!labels || !nonEmptyString(name) || !nonEmptyString(hostPath)) return null;

  const normalized: Record<string, unknown> = { ...raw, name, hostPath, labels };
  optionalString(normalized, "kind", raw.kind ?? raw.type);
  optionalNumber(normalized, "usedBytes", raw.usedBytes ?? raw.used_bytes);
  optionalNumber(normalized, "createdAt", raw.createdAt ?? raw.created_at);
  return normalized as unknown as VolumeRecord;
}

export function parseCliSandboxList(json: string): ManagedSandboxRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error("invalid sandbox list JSON", { cause: error });
  }

  let rows: unknown[];
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (isRecord(parsed) && Array.isArray(parsed.sandboxes)) {
    rows = parsed.sandboxes;
  } else {
    throw new Error("invalid sandbox list shape: expected an array or {sandboxes: []}");
  }

  return rows
    .map((row) => normalizeSandboxRecord(row))
    .filter((row): row is ManagedSandboxRecord => row !== null);
}

export function validateManagedSandbox(
  record: ManagedSandboxRecord,
): ValidatedManagedSandbox | null {
  if (!isRecord(record) || !nonEmptyString(record.name)) return null;

  const labels = normalizeLabels(record.labels);
  if (!labels) return null;

  const sessionId = labels[LABEL_KEYS.session];
  const mode = labels[LABEL_KEYS.mode];
  const cwd = labels[LABEL_KEYS.cwd];
  const image = labels[LABEL_KEYS.image];
  const pidText = labels[LABEL_KEYS.pid];
  const volumeName = labels[LABEL_KEYS.volume];

  if (
    labels[LABEL_KEYS.managed] !== "true" ||
    labels[LABEL_KEYS.schema] !== String(STATE_SCHEMA_VERSION) ||
    labels[LABEL_KEYS.keep] !== "true" ||
    !nonEmptyString(sessionId) ||
    !isStorageMode(mode) ||
    !nonEmptyString(cwd) ||
    !nonEmptyString(image) ||
    !pidText ||
    !/^\d+$/.test(pidText) ||
    !Number.isSafeInteger(Number(pidText))
  ) {
    return null;
  }

  if (mode === "git" && !nonEmptyString(volumeName)) return null;
  if (mode !== "git" && volumeName !== undefined) return null;

  const normalized: Record<string, unknown> = {
    ...record,
    labels,
    name: record.name,
    sessionId,
    mode,
    cwd,
  };
  if (volumeName !== undefined && volumeName.length > 0) {
    normalized.volumeName = volumeName;
  } else {
    delete normalized.volumeName;
  }
  return normalized as unknown as ValidatedManagedSandbox;
}

function validOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function validOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function validPersistedState(value: Record<string, unknown>): boolean {
  return (
    value.version === STATE_SCHEMA_VERSION &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.sandboxName) &&
    isStorageMode(value.mode) &&
    nonEmptyString(value.cwd) &&
    nonEmptyString(value.image) &&
    typeof value.enabled === "boolean" &&
    finiteNumber(value.createdAt) &&
    validOptionalString(value.volumeName) &&
    validOptionalString(value.volumeHostPath) &&
    validOptionalNullableString(value.seedBranch) &&
    validOptionalNullableString(value.seedSha)
  );
}

export function encodeSessionState(
  state: PersistedSandboxState,
): PersistedSandboxState {
  // Do not mutate a caller-owned object. Encoding always stamps the current
  // schema so a state written by this module can never be mistaken for an old
  // version after a future schema change.
  return { ...state, version: STATE_SCHEMA_VERSION };
}

export function decodeSessionState(
  value: unknown,
  currentSessionId: string,
): PersistedSandboxState | null {
  if (!isRecord(value) || value.sessionId !== currentSessionId) return null;
  if (!validPersistedState(value)) return null;

  // Preserve forward-compatible, unknown JSON fields while replacing the
  // validated known fields with their exact runtime values.
  return { ...value, version: STATE_SCHEMA_VERSION } as PersistedSandboxState;
}
