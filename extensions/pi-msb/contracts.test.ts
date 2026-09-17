import assert from "node:assert/strict";
import test from "node:test";

import { displayId, LOCKFILE_VERSION, resourceId, sandboxNameFor, STATE_SCHEMA_VERSION } from "./types.ts";

test("resource identity is stable and sandbox names use the full hash", () => {
  const sessionId = "session-alpha";
  const resource = resourceId(sessionId);
  assert.equal(resource, "99b1d23983d285eb64aa");
  assert.equal(displayId(sessionId), "99b1d2");
  assert.equal(sandboxNameFor(sessionId), "pi-msb-99b1d23983d285eb64aa");
  assert.equal(STATE_SCHEMA_VERSION, 2);
  assert.equal(LOCKFILE_VERSION, 2);
});

test("fixture session IDs do not collide and display IDs are never identities", () => {
  const sessions = Array.from({ length: 100 }, (_, index) => `fixture-session-${index}`);
  const resources = sessions.map(resourceId);
  assert.equal(new Set(resources).size, sessions.length);
  for (const [index, resource] of resources.entries()) {
    assert.match(resource, /^[0-9a-f]{20}$/);
    assert.equal(sandboxNameFor(sessions[index]!), `pi-msb-${resource}`);
    assert.notEqual(displayId(sessions[index]!), resource);
  }
});
