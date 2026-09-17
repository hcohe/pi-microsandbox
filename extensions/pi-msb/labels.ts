/** Managed microsandbox labels and persisted session state. */
import {
  LABEL_KEYS,
  STATE_SCHEMA_VERSION,
  type ManagedSandboxRecord,
  type PersistedSandboxState,
  type SandboxLabelInput,
  type ValidatedManagedSandbox,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** SDK versions have returned labels both as maps and as entry/tuple arrays. */
function normalizeLabels(value: unknown): Record<string, string> | null {
  const labels: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key && (typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
        labels[key] = String(item);
      }
    }
    return labels;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const key = Array.isArray(entry) ? entry[0] : isRecord(entry) ? entry.key ?? entry.name : undefined;
      const item = Array.isArray(entry) ? entry[1] : isRecord(entry) ? entry.value : undefined;
      if (typeof key === "string" && key && (typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
        labels[key] = String(item);
      }
    }
    return labels;
  }
  return null;
}

function rawRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (Array.isArray(value) && value.length >= 2 && typeof value[0] === "string") {
    return { name: value[0], labels: value[1] };
  }
  return null;
}

function labelsFromRaw(raw: Record<string, unknown>): Record<string, string> | null {
  if (raw.labels !== undefined) return normalizeLabels(raw.labels);
  return isRecord(raw.metadata) ? normalizeLabels(raw.metadata.labels) : null;
}

export function buildSandboxLabels(input: SandboxLabelInput): Record<string, string> {
  return {
    [LABEL_KEYS.managed]: "true",
    [LABEL_KEYS.schema]: String(STATE_SCHEMA_VERSION),
    [LABEL_KEYS.session]: input.sessionId,
    [LABEL_KEYS.cwd]: input.cwd,
    [LABEL_KEYS.root]: input.root,
    [LABEL_KEYS.guestRoot]: input.guestRoot,
    [LABEL_KEYS.pid]: String(input.pid),
    [LABEL_KEYS.image]: input.image,
    [LABEL_KEYS.keep]: "true",
  };
}

export function normalizeSandboxRecord(value: unknown): ManagedSandboxRecord | null {
  const raw = rawRecord(value);
  if (!raw) return null;
  const labels = labelsFromRaw(raw);
  const name = raw.name ?? raw.id ?? raw.sandboxName;
  if (!labels || !nonEmptyString(name)) return null;
  const status = raw.status ?? raw.state;
  const createdAt = raw.createdAt ?? raw.created_at;
  return {
    name,
    labels,
    ...(typeof status === "string" ? { status } : {}),
    ...(finiteNumber(createdAt) ? { createdAt } : {}),
  };
}

export function parseCliSandboxList(json: string): ManagedSandboxRecord[] {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch (error) {
    throw new Error("invalid sandbox list JSON", { cause: error });
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.sandboxes)
      ? parsed.sandboxes
      : null;
  if (!rows) throw new Error("invalid sandbox list shape: expected an array or {sandboxes: []}");
  return rows.map(normalizeSandboxRecord).filter((row): row is ManagedSandboxRecord => row !== null);
}

export function validateManagedSandbox(record: ManagedSandboxRecord): ValidatedManagedSandbox | null {
  if (!isRecord(record) || !nonEmptyString(record.name)) return null;
  const labels = normalizeLabels(record.labels);
  if (!labels) return null;
  const sessionId = labels[LABEL_KEYS.session];
  const cwd = labels[LABEL_KEYS.cwd];
  const root = labels[LABEL_KEYS.root];
  const guestRoot = labels[LABEL_KEYS.guestRoot];
  const pid = labels[LABEL_KEYS.pid];
  if (
    labels[LABEL_KEYS.managed] !== "true" ||
    labels[LABEL_KEYS.schema] !== String(STATE_SCHEMA_VERSION) ||
    labels[LABEL_KEYS.keep] !== "true" ||
    !nonEmptyString(sessionId) || !nonEmptyString(cwd) || !nonEmptyString(root) ||
    !nonEmptyString(guestRoot) || !nonEmptyString(labels[LABEL_KEYS.image]) || !pid || !/^\d+$/.test(pid) ||
    !Number.isSafeInteger(Number(pid))
  ) return null;
  return { ...record, labels, sessionId, cwd, root, guestRoot };
}

function validPersistedState(value: Record<string, unknown>): boolean {
  return value.version === STATE_SCHEMA_VERSION &&
    nonEmptyString(value.sessionId) && nonEmptyString(value.sandboxName) &&
    nonEmptyString(value.cwd) && nonEmptyString(value.root) && nonEmptyString(value.guestRoot) &&
    nonEmptyString(value.image) && typeof value.enabled === "boolean" && finiteNumber(value.createdAt);
}

export function encodeSessionState(state: PersistedSandboxState): PersistedSandboxState {
  return { ...state, version: STATE_SCHEMA_VERSION };
}

export function decodeSessionState(value: unknown, currentSessionId: string): PersistedSandboxState | null {
  if (!isRecord(value) || value.sessionId !== currentSessionId || !validPersistedState(value)) return null;
  return { ...value, version: STATE_SCHEMA_VERSION } as PersistedSandboxState;
}
