import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const check = workflow.split("  check:\n")[1]!.split("\n  native-flock:\n")[0]!;

test("CI Check matrix builds and smoke-tests the host addon before real integration checks", () => {
  assert.match(check, /os:\n          - ubuntu-latest\n          - macos-latest/);
  assert.match(check, /node-version:\n          - "22\.19\.0"\n          - "24\.x"/);
  assert.match(check, /run: npm ci --ignore-scripts=true\n      - name: Build and smoke-test native addon for integration tests\n        run: \|\n          npm run build:flock\n          npm run smoke:flock\n      - name: Run checks\n        run: npm run check/);
  assert.doesNotMatch(check, /continue-on-error:|needs:|--test-skip-pattern/);
});
