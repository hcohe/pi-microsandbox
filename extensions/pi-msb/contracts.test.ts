import assert from "node:assert/strict";
import test from "node:test";

import {
  displayId,
  resourceId,
  sandboxNameFor,
  volumeNameFor,
} from "./types.ts";

test("resource identity is stable and names use the full hash", () => {
  const sessionId = "session-alpha";
  const resource = resourceId(sessionId);

  assert.equal(resource, "99b1d23983d285eb64aa");
  assert.equal(resource.length, 20);
  assert.match(resource, /^[0-9a-f]{20}$/);
  assert.equal(displayId(sessionId), "99b1d2");
  assert.equal(sandboxNameFor(sessionId), "pi-msb-99b1d23983d285eb64aa");
  assert.equal(volumeNameFor(sessionId), "pi-msb-vol-99b1d23983d285eb64aa");
});

test("fixture session IDs do not collide in resource names", () => {
  const sessionIds = [
    "session-alpha",
    "session-beta",
    "session-gamma",
    ...Array.from({ length: 97 }, (_, index) => `fixture-session-${index}`),
  ];
  const resources = sessionIds.map(resourceId);
  const sandboxNames = sessionIds.map(sandboxNameFor);
  const volumeNames = sessionIds.map(volumeNameFor);

  assert.equal(new Set(resources).size, sessionIds.length);
  assert.equal(new Set(sandboxNames).size, sessionIds.length);
  assert.equal(new Set(volumeNames).size, sessionIds.length);
  for (const resource of resources) {
    assert.equal(resource.length, 20);
    assert.match(resource, /^[0-9a-f]{20}$/);
  }
});

test("display IDs are six-character views, never resource identities", () => {
  const sessionId = "session-beta";
  const resource = resourceId(sessionId);
  const display = displayId(sessionId);

  assert.equal(display, resource.slice(0, 6));
  assert.equal(display.length, 6);
  assert.notEqual(display, resource);
  assert.match(sandboxNameFor(sessionId), new RegExp(resource));
  assert.match(volumeNameFor(sessionId), new RegExp(resource));
  assert.doesNotMatch(sandboxNameFor(sessionId), new RegExp(`pi-msb-${display}$`));
  assert.doesNotMatch(volumeNameFor(sessionId), new RegExp(`pi-msb-vol-${display}$`));
});
