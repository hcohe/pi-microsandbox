import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflow = readFileSync(join(root, ".github/workflows/live-e2e.yml"), "utf8");
const guardSource = workflow.split('cat > "$LIVE_PRIVATE_DIR/resource-guard.mjs" <<\'NODE\'\n')[1]!
  .split("          NODE")[0]!.replace(/^ {10}/gm, "");

interface SandboxRecord {
  name: string;
  labels: Record<string, string>;
}
const managed = (name = "clever-panini", sessionId = "pi-msb-live-123-abc"): SandboxRecord => ({
  name, labels: { "pi-msb.managed": "true", "pi-msb.session": sessionId },
});

const cases: Array<{
  name: string;
  candidate: SandboxRecord;
  baseline?: SandboxRecord[];
  replies?: SandboxRecord[];
  calls: string[];
  status: number;
}> = [
  { name: "random two-word names are removed", candidate: managed(), calls: ["stop:clever-panini", "remove:clever-panini"], status: 0 },
  { name: "baseline resources remain untouched", candidate: managed(), baseline: [managed()], calls: [], status: 0 },
  { name: "unmanaged names remain untouched", candidate: { name: "clever-panini", labels: {} }, calls: [], status: 0 },
  { name: "unrelated sessions remain untouched", candidate: managed("clever-panini", "another-user-session"), calls: [], status: 0 },
  { name: "session changes before stop are rejected", candidate: managed(), replies: [managed("clever-panini", "stale-456")], calls: [], status: 1 },
  { name: "managed label changes before stop are rejected", candidate: managed(), replies: [{ name: "clever-panini", labels: {} }], calls: [], status: 1 },
  { name: "name changes before stop are rejected", candidate: managed(), replies: [managed("another-name")], calls: [], status: 1 },
  { name: "session changes after stop are rejected", candidate: managed(), replies: [managed(), managed("clever-panini", "stale-456")], calls: ["stop:clever-panini"], status: 1 },
  { name: "managed label changes after stop are rejected", candidate: managed(), replies: [managed(), { name: "clever-panini", labels: {} }], calls: ["stop:clever-panini"], status: 1 },
  { name: "labeled probes are removed", candidate: managed("pi-msb-live-probe-123-456", "pi-msb-live-probe-123-456"), calls: ["stop:pi-msb-live-probe-123-456", "remove:pi-msb-live-probe-123-456"], status: 0 },
  { name: "probe names alone never authorize removal", candidate: { name: "pi-msb-live-probe-123-456", labels: {} }, calls: [], status: 0 },
];

for (const scenario of cases) test(`live-e2e cleanup: ${scenario.name}`, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-msb-live-guard-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sdkDirectory = join(directory, "node_modules", "microsandbox");
  mkdirSync(sdkDirectory, { recursive: true });
  writeFileSync(join(directory, "package.json"), "{}");
  writeFileSync(join(sdkDirectory, "package.json"), JSON.stringify({ name: "microsandbox", type: "module", main: "index.mjs" }));
  writeFileSync(join(sdkDirectory, "index.mjs"), `
import { appendFileSync, readFileSync } from "node:fs";
const fixture = JSON.parse(readFileSync(process.env.GUARD_FIXTURE, "utf8"));
let reads = 0;
const handle = (record) => ({
  name: record.name,
  config: () => ({ labels: record.labels }),
  stopWithTimeout: async () => appendFileSync(process.env.GUARD_CALLS, "stop:" + record.name + "\\n"),
  remove: async () => appendFileSync(process.env.GUARD_CALLS, "remove:" + record.name + "\\n"),
});
export const Sandbox = {
  list: async () => ({ sandboxes: fixture.sandboxes.map(handle) }),
  get: async (name) => handle(fixture.replies?.[reads++] ?? fixture.sandboxes.find((record) => record.name === name)),
};
`);
  const script = join(directory, "resource-guard.mjs");
  const fixturePath = join(directory, "fixture.json");
  const callsPath = join(directory, "calls.log");
  writeFileSync(script, guardSource);
  writeFileSync(callsPath, "");
  const env = {
    ...process.env, LIVE_PRIVATE_DIR: directory, SANITIZED_LOG: join(directory, "sanitized.log"),
    GITHUB_WORKSPACE: directory, GUARD_FIXTURE: fixturePath, GUARD_CALLS: callsPath,
  };
  writeFileSync(fixturePath, JSON.stringify({ sandboxes: scenario.baseline ?? [] }));
  const snapshot = spawnSync(process.execPath, [script, "snapshot"], { env, encoding: "utf8" });
  assert.equal(snapshot.status, 0, snapshot.stderr);
  writeFileSync(fixturePath, JSON.stringify({ sandboxes: [scenario.candidate], replies: scenario.replies }));
  const cleanup = spawnSync(process.execPath, [script, "cleanup"], { env, encoding: "utf8" });
  assert.equal(cleanup.status, scenario.status, cleanup.stderr);
  assert.deepEqual(readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean), scenario.calls);
});

test("e2e-smoke generated runner loads all scenarios without starting virtualization", (t) => {
  const directory = mkdtempSync(join(root, ".pi-msb-e2e-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const shell = readFileSync(join(root, "scripts/e2e-smoke.sh"), "utf8");
  const runner = shell.split('cat >"$RUNNER" <<\'NODE\'\n')[1]!.split("\nNODE\n")[0]!;
  const script = join(directory, "runner.mjs");
  writeFileSync(script, runner.replaceAll("__ROOT__", root.replace(/\/$/, "")));
  const loaded = spawnSync(process.execPath, ["--experimental-strip-types", script, "--load"], { encoding: "utf8" });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.match(loaded.stdout, /LOAD\|PASS\|14 scenarios loaded/);
});
