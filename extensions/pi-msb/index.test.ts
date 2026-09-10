import assert from "node:assert/strict";
import { test } from "node:test";
import { footerStatus } from "./index.ts";
import type { RuntimeState } from "./types.ts";

const active: RuntimeState = {
  status: "active",
  info: {
    name: "pi-msb-example",
    displayId: "bf9379",
    mode: "direct",
    image: "ubuntu:24.04",
    pid: 123,
    cwd: "/repo",
    createdAt: 0,
  },
};

test("footer status follows the visibility setting", () => {
  assert.equal(footerStatus(active, false), undefined);
  assert.equal(footerStatus(active, true), "msb-bf9379");
});
