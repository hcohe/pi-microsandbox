import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { LABEL_KEYS, STATE_SCHEMA_VERSION } from "./types.ts";
import { pruneStale } from "./prune.ts";
import type { PrunePort } from "./prune.ts";
import type { LocksPort, ManagedSandboxRecord, LockHandle } from "./types.ts";

const labels = (sessionId: string, mode: "git" | "direct" | "none" = "direct") => ({
  [LABEL_KEYS.managed]: "true",
  [LABEL_KEYS.schema]: String(STATE_SCHEMA_VERSION),
  [LABEL_KEYS.session]: sessionId,
  [LABEL_KEYS.mode]: mode,
  [LABEL_KEYS.cwd]: "/tmp/project",
  [LABEL_KEYS.pid]: "1234",
  [LABEL_KEYS.image]: "ubuntu:24.04",
  [LABEL_KEYS.keep]: "true",
  ...(mode === "git" ? { [LABEL_KEYS.volume]: "pi-msb-vol-test" } : {}),
});

function sandbox(name: string, sessionId: string, status = "stopped"): ManagedSandboxRecord {
  return { name, status, labels: labels(sessionId) };
}

function lockPort(
  live = new Set<string>(),
  events: string[] = [],
): LocksPort {
  return {
    async tryAcquire(sessionId) {
      events.push(`lock:${sessionId}`);
      if (live.has(sessionId)) return null;
      const handle: LockHandle = {
        path: `/tmp/${sessionId}.lock`,
        async release() {
          events.push(`release:${sessionId}`);
        },
      };
      return handle;
    },
  };
}

function portPages(
  pages: Array<{ sandboxes: ManagedSandboxRecord[]; nextCursor?: string }>,
  events: string[] = [],
): PrunePort {
  let index = 0;
  return {
    async listPage(input) {
      events.push(`list:${input.cursor ?? "first"}`);
      const page = pages[index];
      index += 1;
      if (!page) throw new Error("unexpected page");
      return page;
    },
    async stop(name, timeoutMs) {
      events.push(`stop:${name}:${timeoutMs}`);
    },
    async remove(name) {
      events.push(`remove:${name}`);
    },
  };
}

test("walks every page with the managed filter and prunes only dead owners", async () => {
  const events: string[] = [];
  const port = portPages([
    {
      sandboxes: [
        sandbox("current-box", "current", "running"),
        sandbox("live-box", "live", "running"),
        sandbox("dead-box", "dead", "running"),
        { name: "bad-box", labels: { [LABEL_KEYS.managed]: "true" } },
      ],
      nextCursor: "page-2",
    },
    { sandboxes: [sandbox("stopped-box", "stopped")] },
  ], events);
  const locks = lockPort(new Set(["live"]), events);

  const report = await pruneStale({
    port,
    locks,
    currentSessionId: "current",
    stopTimeoutMs: 250,
  });

  assert.deepEqual(report, {
    inspected: 5,
    removed: ["dead-box", "stopped-box"],
    kept: ["current-box", "live-box"],
    errors: ["skipped malformed managed sandbox record bad-box"],
  });
  assert.deepEqual(events, [
    "list:first",
    "lock:live",
    "lock:dead",
    "stop:dead-box:250",
    "remove:dead-box",
    "release:dead",
    "list:page-2",
    "lock:stopped",
    "remove:stopped-box",
    "release:stopped",
  ]);
});

test("keeps malformed/schema-invalid records out of mutation and never throws list errors", async () => {
  const events: string[] = [];
  const badSchema = sandbox("wrong-schema", "schema-owner");
  badSchema.labels[LABEL_KEYS.schema] = "999";
  const badKeep = sandbox("not-kept", "keep-owner");
  badKeep.labels[LABEL_KEYS.keep] = "false";

  const report = await pruneStale({
    port: portPages([{ sandboxes: [badSchema, badKeep] }], events),
    locks: lockPort(new Set(), events),
    stopTimeoutMs: 100,
  });

  assert.equal(report.inspected, 2);
  assert.deepEqual(report.removed, []);
  assert.deepEqual(report.kept, []);
  assert.equal(report.errors.length, 2);
  assert.match(report.errors[0], /wrong-schema/);
  assert.match(report.errors[1], /not-kept/);
  assert.deepEqual(events, ["list:first"]);

  const failed = await pruneStale({
    port: {
      ...portPages([], events),
      async listPage() {
        throw new Error("sdk unavailable");
      },
    },
    locks: lockPort(),
    stopTimeoutMs: 100,
  });
  assert.equal(failed.inspected, 0);
  assert.match(failed.errors[0], /sdk unavailable/);
});

test("rejects volume labels on direct and none sandboxes", async () => {
  const events: string[] = [];
  const direct = {
    ...sandbox("direct-volume", "direct-owner"),
    labels: { ...labels("direct-owner", "direct"), [LABEL_KEYS.volume]: "unexpected" },
  };
  const none = {
    ...sandbox("none-volume", "none-owner"),
    labels: { ...labels("none-owner", "none"), [LABEL_KEYS.volume]: "unexpected" },
  };

  const report = await pruneStale({
    port: portPages([{ sandboxes: [direct, none] }], events),
    locks: lockPort(new Set(), events),
    stopTimeoutMs: 100,
  });

  assert.equal(report.inspected, 2);
  assert.deepEqual(report.removed, []);
  assert.deepEqual(report.kept, []);
  assert.match(report.errors[0], /direct-volume/);
  assert.match(report.errors[1], /none-volume/);
  assert.deepEqual(events, ["list:first"]);
});

test("records stop/remove failures, releases orphan locks, and continues", async () => {
  const events: string[] = [];
  const dead = sandbox("stop-fails", "stop-owner", "running");
  const remove = sandbox("remove-fails", "remove-owner", "stopped");
  const success = sandbox("success", "success-owner", "running");
  const locks = lockPort(new Set(), events);
  const port: PrunePort = {
    async listPage(input) {
      events.push(`list:${input.cursor ?? "first"}`);
      return { sandboxes: [dead, remove, success] };
    },
    async stop(name) {
      events.push(`stop:${name}`);
      if (name === "stop-fails") throw new Error("stop timeout");
    },
    async remove(name) {
      events.push(`remove:${name}`);
      if (name === "remove-fails") throw new Error("remove denied");
    },
  };

  const report = await pruneStale({ port, locks, stopTimeoutMs: 80 });

  assert.deepEqual(report.removed, ["success"]);
  assert.deepEqual(report.kept, []);
  assert.deepEqual(report.errors, [
    "stop-fails: stop failed: stop timeout",
    "remove-fails: remove failed: remove denied",
  ]);
  assert.deepEqual(events, [
    "list:first",
    "lock:stop-owner",
    "stop:stop-fails",
    "release:stop-owner",
    "lock:remove-owner",
    "remove:remove-fails",
    "release:remove-owner",
    "lock:success-owner",
    "stop:success",
    "remove:success",
    "release:success-owner",
  ]);
});

test("guards against repeated cursors/pages", async () => {
  const events: string[] = [];
  const first = sandbox("one", "owner-one");
  const second = sandbox("two", "owner-two");
  let calls = 0;
  const port: PrunePort = {
    async listPage(input) {
      calls += 1;
      events.push(input.cursor ?? "first");
      if (calls === 1) return { sandboxes: [first], nextCursor: "again" };
      return { sandboxes: [second], nextCursor: "again" };
    },
    async stop() {},
    async remove() {},
  };

  const report = await pruneStale({ port, locks: lockPort(), stopTimeoutMs: 100 });

  assert.equal(calls, 2);
  assert.deepEqual(events, ["first", "again"]);
  assert.deepEqual(report.removed, ["one", "two"]);
  assert.deepEqual(report.errors, ["duplicate prune page cursor: again"]);
});

test("contains no volume deletion operation or port", async () => {
  const source = await readFile(new URL("./prune.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:Volume|volume)\.remove\s*\(/);
  assert.doesNotMatch(source, /volume[-_ ]remove/i);
});
