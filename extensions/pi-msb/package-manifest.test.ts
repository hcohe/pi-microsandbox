import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

test("strict assembled-package allowlist includes every shipped settings/UI module and document", () => {
  const root = new URL("../../", import.meta.url);
  const smoke = readFileSync(new URL("scripts/package-smoke.sh", root), "utf8");
  const manifest = smoke.split('cat >"$MANIFEST" <<\'EOF\'\n')[1]!.split("\nEOF")[0]!;
  const required = manifest.split("\n").map((line) => line.split(" ")[0]);
  for (const directory of ["extensions/pi-msb", "docs"]) {
    for (const name of readdirSync(new URL(`${directory}/`, root))) {
      if ((directory === "docs" && name.endsWith(".md")) || (name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
        assert.ok(required.includes(`${directory}/${name}`), `missing from strict manifest: ${directory}/${name}`);
      }
    }
  }
  assert.ok(!required.some((path) => path?.endsWith(".test.ts")));
});
