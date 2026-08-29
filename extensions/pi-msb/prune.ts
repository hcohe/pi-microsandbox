import {
  LABEL_KEYS,
  STATE_SCHEMA_VERSION,
} from "./types.ts";
import type {
  LocksPort,
  ManagedSandboxRecord,
  PruneReport,
} from "./types.ts";

/**
 * The prune adapter deliberately exposes only sandbox operations. Keeping the
 * port this narrow makes retention structural: prune has no volume mutation
 * capability to accidentally call.
 */
export interface PrunePort {
  listPage(input: { labels: Record<string, string>; cursor?: string }): Promise<{
    sandboxes: ManagedSandboxRecord[];
    nextCursor?: string;
  }>;
  stop(name: string, timeoutMs: number): Promise<void>;
  remove(name: string): Promise<void>;
}

const MANAGED_LABELS: Readonly<Record<string, string>> = Object.freeze({
  [LABEL_KEYS.managed]: "true",
});

const REQUIRED_LABELS = [
  LABEL_KEYS.managed,
  LABEL_KEYS.schema,
  LABEL_KEYS.session,
  LABEL_KEYS.mode,
  LABEL_KEYS.cwd,
  LABEL_KEYS.pid,
  LABEL_KEYS.image,
  LABEL_KEYS.keep,
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function recordName(value: unknown): string | undefined {
  if (!isObject(value) || typeof value.name !== "string" || value.name.length === 0) {
    return undefined;
  }
  return value.name;
}

function validateRecord(value: unknown): ManagedSandboxRecord | null {
  if (!isObject(value) || typeof value.name !== "string" || value.name.length === 0) {
    return null;
  }
  if (!isObject(value.labels)) return null;
  if (value.status !== undefined && typeof value.status !== "string") return null;
  if (value.createdAt !== undefined && typeof value.createdAt !== "number") return null;

  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value.labels)) {
    if (typeof label !== "string") return null;
    labels[key] = label;
  }

  for (const key of REQUIRED_LABELS) {
    if (typeof labels[key] !== "string" || labels[key].length === 0) return null;
  }
  if (labels[LABEL_KEYS.managed] !== "true") return null;
  if (labels[LABEL_KEYS.schema] !== String(STATE_SCHEMA_VERSION)) return null;
  if (!/^\d+$/.test(labels[LABEL_KEYS.pid])) return null;
  if (!Number.isSafeInteger(Number(labels[LABEL_KEYS.pid]))) return null;
  if (labels[LABEL_KEYS.keep] !== "true") return null;
  if (!["git", "direct", "none"].includes(labels[LABEL_KEYS.mode])) return null;
  if (labels[LABEL_KEYS.mode] === "git" && !labels[LABEL_KEYS.volume]) return null;
  if (labels[LABEL_KEYS.mode] !== "git" && labels[LABEL_KEYS.volume] !== undefined) return null;

  return {
    name: value.name,
    ...(value.status === undefined ? {} : { status: value.status }),
    labels,
    ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }),
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function isRunning(record: ManagedSandboxRecord): boolean {
  const status = record.status?.trim().toLowerCase();
  return status === "running" || status === "started" || status === "up" || status === "active";
}

function pageFingerprint(records: ManagedSandboxRecord[]): string | undefined {
  if (records.length === 0) return undefined;
  return records.map((record) => record.name).sort().join("\u0000");
}

/**
 * Remove only managed sandboxes whose owner lock can be acquired. This is
 * intentionally best-effort: an individual SDK failure must not prevent the
 * next session from pruning other orphaned sandboxes.
 */
export async function pruneStale(input: {
  port: PrunePort;
  locks: LocksPort;
  currentSessionId?: string;
  stopTimeoutMs: number;
}): Promise<PruneReport> {
  const report: PruneReport = {
    inspected: 0,
    removed: [],
    kept: [],
    errors: [],
  };

  let cursor: string | undefined;
  let pageNumber = 0;
  const requestedCursors = new Set<string>();
  const pageFingerprints = new Set<string>();
  const seenNames = new Set<string>();

  while (true) {
    const requestKey = cursor ?? "<first>";
    if (requestedCursors.has(requestKey)) {
      report.errors.push(`duplicate prune page cursor: ${requestKey}`);
      break;
    }
    requestedCursors.add(requestKey);

    let page: { sandboxes: ManagedSandboxRecord[]; nextCursor?: string };
    try {
      page = await input.port.listPage(
        cursor === undefined
          ? { labels: MANAGED_LABELS }
          : { labels: MANAGED_LABELS, cursor },
      );
    } catch (error) {
      report.errors.push(`list page ${pageNumber + 1} failed: ${errorText(error)}`);
      break;
    }
    pageNumber += 1;

    if (!isObject(page) || !Array.isArray(page.sandboxes)) {
      report.errors.push(`list page ${pageNumber} returned malformed data`);
      break;
    }
    if (page.nextCursor !== undefined && typeof page.nextCursor !== "string") {
      report.errors.push(`list page ${pageNumber} returned an invalid cursor`);
      break;
    }

    const validPage = page.sandboxes
      .map((value) => validateRecord(value))
      .filter((value): value is ManagedSandboxRecord => value !== null);
    const fingerprint = pageFingerprint(validPage);
    if (fingerprint !== undefined) {
      if (pageFingerprints.has(fingerprint)) {
        report.errors.push(`duplicate prune page ${pageNumber}`);
        break;
      }
      pageFingerprints.add(fingerprint);
    }

    for (let index = 0; index < page.sandboxes.length; index += 1) {
      const rawRecord = page.sandboxes[index];
      report.inspected += 1;
      const record = validateRecord(rawRecord);
      if (record === null) {
        const name = recordName(rawRecord);
        report.errors.push(
          `skipped malformed managed sandbox record${name === undefined ? "" : ` ${name}`}`,
        );
        continue;
      }
      if (seenNames.has(record.name)) continue;
      seenNames.add(record.name);

      const sessionId = record.labels[LABEL_KEYS.session];
      if (sessionId === input.currentSessionId) {
        report.kept.push(record.name);
        continue;
      }

      let orphanLock;
      try {
        orphanLock = await input.locks.tryAcquire(sessionId);
      } catch (error) {
        report.errors.push(`${record.name}: lock check failed: ${errorText(error)}`);
        continue;
      }
      if (orphanLock === null) {
        report.kept.push(record.name);
        continue;
      }

      try {
        if (isRunning(record)) {
          try {
            await input.port.stop(record.name, input.stopTimeoutMs);
          } catch (error) {
            report.errors.push(`${record.name}: stop failed: ${errorText(error)}`);
            continue;
          }
        }

        try {
          await input.port.remove(record.name);
          report.removed.push(record.name);
        } catch (error) {
          report.errors.push(`${record.name}: remove failed: ${errorText(error)}`);
        }
      } finally {
        try {
          await orphanLock.release();
        } catch (error) {
          report.errors.push(`${record.name}: lock release failed: ${errorText(error)}`);
        }
      }
    }

    if (page.nextCursor === undefined) break;
    if (page.nextCursor.length === 0) {
      report.errors.push(`list page ${pageNumber} returned an empty cursor`);
      break;
    }
    cursor = page.nextCursor;
  }

  return report;
}
