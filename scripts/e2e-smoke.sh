#!/usr/bin/env bash
# Opt-in live matrix for pi-microsandbox. It deliberately creates real VMs;
# do not run it from an untrusted checkout.
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

SCENARIOS=(
  "Git subdirectory mounts the whole host repository"
  "Non-Git cwd is mounted read/write"
  "Reload and off/on reconnect safely"
  "Duplicate owner is blocked before mutation"
  "Orphaned sandbox is pruned"
  "Idle timeout wakes before execution"
  "Boot failure fails closed while explicit host policies differ"
  "Host target requires exact approval"
  "Skill reads enforce canonical containment"
  "Generated output grants one exact path"
  "Bootstrap and deny-network behavior"
  "Concurrent exec, abort, timeout, grep, and find"
  "Docker bridge, Buildx, Compose, and double port publishing"
  "Nested Docker traffic obeys deny and allowlist policies"
)

report_all_skip() {
  reason=$1
  for i in "${!SCENARIOS[@]}"; do
    printf 'SKIP  %02d  %s (%s)\n' "$((i + 1))" "${SCENARIOS[$i]}" "$reason"
  done
}

if [ "${PI_MSB_LIVE_TEST:-0}" != "1" ]; then
  echo "pi-microsandbox live E2E is opt-in; set PI_MSB_LIVE_TEST=1 to start virtualization."
  report_all_skip "PI_MSB_LIVE_TEST is not 1; no live validation was performed"
  exit 0
fi

missing=()
for command in node git; do
  if ! command -v "$command" >/dev/null 2>&1; then missing+=("$command"); fi
done
if [ "${#missing[@]}" -ne 0 ]; then
  report_all_skip "missing prerequisite: ${missing[*]}; no live validation was performed"
  exit 0
fi

# msb --version checks that the platform package is installed, but not that a
# hypervisor is usable. The probe below is the authoritative virtualization
# check and is intentionally the only pre-matrix VM.
if ! command -v msb >/dev/null 2>&1 && [ -z "${MSB_PATH:-}" ]; then
  report_all_skip "microsandbox/msb is not installed; no live validation was performed"
  exit 0
fi

# Keep the generated ESM runner under the package root so bare imports resolve
# through this checkout's node_modules on every supported Node release.
RUN_DIR=$(mktemp -d "$ROOT/.pi-msb-e2e.XXXXXX")
RUNNER="$RUN_DIR/runner.mjs"
OUTPUT=$(mktemp "${TMPDIR:-/tmp}/pi-msb-e2e-output.XXXXXX")
# shellcheck disable=SC2329  # Invoked indirectly by trap.
cleanup() { rm -rf "$RUN_DIR"; rm -f "$OUTPUT"; }
trap cleanup EXIT INT TERM

cat >"$RUNNER" <<'NODE'
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { Sandbox } from "microsandbox";
import { DEFAULT_CONFIG } from "__ROOT__/extensions/pi-msb/config.ts";
import { createMsbIntegration } from "__ROOT__/extensions/pi-msb/control.ts";
import { createSandboxGrepExecute } from "__ROOT__/extensions/pi-msb/operations-exec.ts";
import { acquireOwnerLock } from "__ROOT__/extensions/pi-msb/locks.ts";
import { createHostReadAccess } from "__ROOT__/extensions/pi-msb/skill-access.ts";
import { registerSandboxTools } from "__ROOT__/extensions/pi-msb/tools.ts";
import { LOCKFILE_VERSION, sandboxNameFor } from "__ROOT__/extensions/pi-msb/types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, truncateLine, formatSize } from "@earendil-works/pi-coding-agent";

const execFile = promisify(execFileCallback);
const DEFAULT_IMAGE = "ghcr.io/hcohe/pi-microsandbox:latest";
const IMAGE = process.env.PI_MSB_LIVE_IMAGE || DEFAULT_IMAGE;
const LIVE_PULL_POLICY = process.env.PI_MSB_LIVE_PULL_POLICY || "always";
assert.ok(["always", "if-missing", "never"].includes(LIVE_PULL_POLICY), "PI_MSB_LIVE_PULL_POLICY is invalid");
const ROOT = "__ROOT__";
const variantDocument = JSON.parse(await readFile(join(ROOT, "default-image", "variants.json"), "utf8"));
const declaredPreparedImages = variantDocument.variants.map(
  (variant) => `ghcr.io/hcohe/pi-microsandbox:${variant.tags.latest}`,
);
const PREPARED_IMAGES = process.env.PI_MSB_LIVE_PREPARED_IMAGES
  ? process.env.PI_MSB_LIVE_PREPARED_IMAGES.split(",").map((item) => item.trim()).filter(Boolean)
  : process.env.PI_MSB_LIVE_PREPARED_IMAGE
    ? [process.env.PI_MSB_LIVE_PREPARED_IMAGE]
    : declaredPreparedImages;
const names = [
  "Git subdirectory mounts the whole host repository",
  "Non-Git cwd is mounted read/write",
  "Reload and off/on reconnect safely",
  "Duplicate owner is blocked before mutation",
  "Orphaned sandbox is pruned",
  "Idle timeout wakes before execution",
  "Boot failure fails closed while explicit host policies differ",
  "Host target requires exact approval",
  "Skill reads enforce canonical containment",
  "Generated output grants one exact path",
  "Bootstrap and deny-network behavior",
  "Concurrent exec, abort, timeout, grep, and find",
  "Docker bridge, Buildx, Compose, and double port publishing",
  "Nested Docker traffic obeys deny and allowlist policies",
];

const env = { ...process.env, PI_MSB_DISABLE: "" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function sh(command, args, cwd) {
  try {
    const result = await execFile(command, args, { cwd, env });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    return { stdout: error.stdout || "", stderr: error.stderr || String(error), code: error.code ?? 1 };
  }
}
function check(result, message) {
  if (result.code !== 0) throw new Error(`${message}: ${String(result.stderr).trim()}`);
  return result;
}
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-live-repo-"));
  try {
    check(await sh("git", ["init", "-q", "-b", "main"], root), "git init");
    check(await sh("git", ["config", "user.email", "pi-msb-live@example.invalid"], root), "git email");
    check(await sh("git", ["config", "user.name", "pi-msb live"], root), "git name");
    await fs.mkdir(join(root, "nested", "cwd"), { recursive: true });
    await fs.mkdir(join(root, "sibling"));
    await writeFile(join(root, "tracked.txt"), "committed\n");
    await writeFile(join(root, "sibling", "visible.txt"), "sibling\n");
    check(await sh("git", ["add", "tracked.txt", "sibling/visible.txt"], root), "git add");
    check(await sh("git", ["-c", "commit.gpgSign=false", "commit", "-q", "-m", "initial"], root), "git commit");
    await writeFile(join(root, ".env"), "LIVE_SECRET=host-visible-by-contract\n");
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
function config(lockRoot, extra = {}) {
  const { network, docker, ...rest } = extra;
  return {
    ...DEFAULT_CONFIG,
    secrets: [],
    mounts: [],
    lockDir: join(lockRoot, ".locks"),
    image: IMAGE,
    pullPolicy: rest.pullPolicy ?? LIVE_PULL_POLICY,
    bootstrapTools: rest.bootstrapTools ?? "auto",
    idleTimeoutSec: rest.idleTimeoutSec ?? 600,
    ...rest,
    network: { ...DEFAULT_CONFIG.network, ...(network || {}) },
    docker: { ...DEFAULT_CONFIG.docker, ...(docker || {}) },
  };
}
function integration(cwd, sessionId, entries = [], sessionEnv = env) {
  return createMsbIntegration({
    sessionId,
    cwd,
    configDirName: ".pi",
    env: sessionEnv,
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    entries: () => entries,
    sdkLoader: async () => await import("microsandbox"),
  });
}
async function boot(cwd, extra = {}, entries = [], suppliedSessionId, sessionEnv = env) {
  const sessionId = suppliedSessionId || `pi-msb-live-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const value = integration(cwd, sessionId, entries, sessionEnv);
  const state = await value.configureSession({
    sessionId,
    cwd,
    projectTrusted: true,
    config: { config: config(cwd, extra), provenance: {}, warnings: [] },
  });
  if (state.status !== "active") {
    try { await value.manager.shutdown(); } catch {}
    throw new Error(`expected active sandbox, got ${state.status}: ${state.reason || "no reason"}`);
  }
  return { ...value, sessionId, state, entries };
}
async function runtimeCall(value, callback) {
  return value.manager.withRuntime(callback);
}
async function guest(value, command, args, options = {}) {
  return runtimeCall(value, (runtime) => runtime.transport.exec(command, args, options));
}
async function close(value) {
  await value.manager.shutdown();
}
async function sandboxAbsent(name) {
  try { await Sandbox.get(name); return false; } catch { return true; }
}
async function removeSandboxIfPresent(name) {
  try {
    const sandbox = await Sandbox.get(name);
    try { await sandbox.stopWithTimeout(10_000); } catch {}
    await (await Sandbox.get(name)).remove();
  } catch {}
}

async function scenario1() {
  const root = await repo();
  const cwd = join(root, "nested", "cwd");
  let value;
  try {
    value = await boot(cwd);
    assert.equal(value.state.info?.root, root, "sandbox identity did not use the repository root");
    assert.equal((await guest(value, "pwd", [])).stdout.toString().trim(), cwd, "sandbox workdir changed from the original cwd");
    assert.equal((await guest(value, "cat", [join(root, "tracked.txt")])).stdout.toString(), "committed\n");
    assert.equal((await guest(value, "cat", [join(root, "sibling", "visible.txt")])).stdout.toString(), "sibling\n");
    assert.equal((await guest(value, "test", ["-d", join(root, ".git")])).exitCode, 0, ".git was not mounted");
    assert.match((await guest(value, "cat", [join(root, ".env")])).stdout.toString(), /host-visible-by-contract/);
    const write = await guest(value, "sh", ["-lc", "printf 'from guest\\n' > ../../guest-root-write.txt"]);
    assert.equal(write.exitCode, 0, write.stderr.toString());
    await runtimeCall(value, (runtime) => runtime.operations.write.writeFile(join(cwd, "routed-write.txt"), "routed\n"));
    assert.equal(await readFile(join(root, "guest-root-write.txt"), "utf8"), "from guest\n");
    assert.equal(await readFile(join(cwd, "routed-write.txt"), "utf8"), "routed\n");
  } finally {
    if (value) await close(value);
    await rm(root, { recursive: true, force: true });
  }
}

async function scenario2() {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-live-nongit-"));
  let value;
  try {
    await writeFile(join(root, "host.txt"), "host\n");
    value = await boot(root);
    assert.equal(value.state.info?.root, root, "non-Git cwd was not selected as the workspace root");
    assert.equal((await guest(value, "pwd", [])).stdout.toString().trim(), root);
    assert.equal((await guest(value, "cat", [join(root, "host.txt")])).stdout.toString(), "host\n");
    assert.equal((await guest(value, "sh", ["-lc", "printf guest > guest.txt"])).exitCode, 0);
    assert.equal(await readFile(join(root, "guest.txt"), "utf8"), "guest");
  } finally {
    if (value) await close(value);
    await rm(root, { recursive: true, force: true });
  }
}

async function scenario3() {
  const root = await repo();
  const cwd = join(root, "nested", "cwd");
  const cleanEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("PI_MSB_")));
  const reloadEnv = {
    ...cleanEnv,
    XDG_CONFIG_HOME: join(import.meta.dirname, "empty-config-home"),
    PI_MSB_DISABLE: "",
    PI_MSB_IMAGE: IMAGE,
    PI_MSB_PULL_POLICY: LIVE_PULL_POLICY,
    PI_MSB_IDLE_TIMEOUT_SEC: "600",
    PI_MSB_LOCK_DIR: join(cwd, ".locks"),
  };
  let value;
  try {
    value = await boot(cwd, {}, [], undefined, reloadEnv);
    const name = value.state.info?.name;
    const createdAt = value.state.info?.createdAt;
    await guest(value, "sh", ["-lc", "printf kept > reconnect.txt; printf same-runtime > /tmp/pi-msb-reload-marker"]);
    await value.control.reload();
    assert.equal(value.control.getState().status, "active");
    assert.equal(value.control.getState().info?.name, name, "reload changed the session sandbox identity");
    assert.equal(value.control.getState().info?.createdAt, createdAt, "reload replaced the running sandbox");
    assert.equal(value.control.getState().info?.image, IMAGE, "reload did not preserve the configured live image");
    assert.equal((await guest(value, "cat", ["/tmp/pi-msb-reload-marker"])).stdout.toString(), "same-runtime");
    assert.equal((await guest(value, "cat", [join(cwd, "reconnect.txt")])).stdout.toString(), "kept");
    await value.control.setEnabled(false);
    assert.equal(value.control.getState().status, "off");
    await value.control.setEnabled(true);
    assert.equal(value.control.getState().status, "active");
    assert.equal(value.control.getState().info?.name, name, "off/on changed the session sandbox identity");
    assert.equal((await guest(value, "cat", [join(cwd, "reconnect.txt")])).stdout.toString(), "kept");
  } finally {
    if (value) await close(value);
    await rm(root, { recursive: true, force: true });
  }
}

async function scenario4() {
  const root = await repo();
  const cwd = join(root, "nested", "cwd");
  const lockDir = join(root, ".locks");
  const sessionId = "same-live-session";
  const info = {
    version: LOCKFILE_VERSION,
    sessionId,
    sandboxName: sandboxNameFor(sessionId),
    cwd,
    root,
    pid: process.pid,
    createdAt: Date.now(),
  };
  const owner = await acquireOwnerLock({ lockDir }, info);
  assert.ok(owner);
  let sdkLoads = 0;
  try {
    const value = createMsbIntegration({
      sessionId,
      cwd,
      configDirName: ".pi",
      env,
      sdkLoader: async () => { sdkLoads++; return await import("microsandbox"); },
    });
    const state = await value.configureSession({ sessionId, cwd, projectTrusted: true, config: { config: config(root), provenance: {}, warnings: [] } });
    assert.equal(state.status, "unavailable");
    assert.match(state.reason || "", /another process owns/);
    assert.equal(sdkLoads, 0, "owner lock must precede SDK mutation");
  } finally {
    await owner.release();
    await rm(root, { recursive: true, force: true });
  }
}

async function scenario5() {
  const root = await repo();
  const cwd = join(root, "nested", "cwd");
  const staleSession = `stale-${Date.now()}`;
  const ready = join(root, "ready");
  const child = spawn(process.execPath, [process.argv[1], "--hold", cwd, staleSession, ready], {
    env: { ...process.env, PI_MSB_LIVE_IMAGE: IMAGE, PI_MSB_DISABLE: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let replacement;
  try {
    for (let i = 0; i < 180 && !(await fs.access(ready).then(() => true, () => false)); i++) await sleep(1000);
    assert.equal(await fs.access(ready).then(() => true, () => false), true, "owner did not reach active state");
    const ownerRecord = JSON.parse(await readFile(ready, "utf8"));
    assert.equal(ownerRecord.sessionId, staleSession);
    assert.equal(await sandboxAbsent(ownerRecord.name), false, "owner sandbox was not created");
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    replacement = await boot(cwd, {}, [], `pruner-${Date.now()}`);
    assert.equal(await sandboxAbsent(ownerRecord.name), true, "orphaned managed sandbox was not pruned");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    if (replacement) await close(replacement);
    await removeSandboxIfPresent(sandboxNameFor(staleSession));
    await rm(root, { recursive: true, force: true });
  }
}
async function holdOwner(cwd, sessionId, ready) {
  const value = await boot(cwd, {}, [], sessionId);
  await writeFile(ready, JSON.stringify({ sessionId: value.sessionId, name: value.state.info?.name }));
  setInterval(() => {}, 1000);
}

async function scenario6() {
  const root = await repo();
  let value;
  try {
    value = await boot(root, { idleTimeoutSec: 2, docker: { mode: "require", startupTimeoutMs: 30000 } });
    const firstDocker = await guest(value, "docker", ["run", "--rm", "alpine:3.22", "printf", "first"], { timeoutMs: 120_000 });
    assert.equal(firstDocker.exitCode, 0, firstDocker.stderr.toString());
    const firstBootId = (await guest(value, "cat", ["/proc/sys/kernel/random/boot_id"])).stdout.toString().trim();
    await sleep(5000);
    const status = await Sandbox.get(value.state.info.name);
    const rawStatus = String(status.status || status.state || "").toLowerCase();
    assert.ok(["stopped", "idle", "exited", "dead", "created"].includes(rawStatus), `expected idle stop, got ${rawStatus}`);
    assert.equal((await guest(value, "printf", ["woke"])).stdout.toString(), "woke");
    const secondBootId = (await guest(value, "cat", ["/proc/sys/kernel/random/boot_id"])).stdout.toString().trim();
    assert.notEqual(secondBootId, firstBootId, "idle wake did not cross a guest boot boundary");
    const secondDocker = await guest(value, "docker", ["run", "--rm", "alpine:3.22", "printf", "second"], { timeoutMs: 60_000 });
    assert.equal(secondDocker.stdout.toString(), "second", secondDocker.stderr.toString());
  } finally {
    if (value) await close(value);
    await rm(root, { recursive: true, force: true });
  }
}

function toolHarness(root, options = {}) {
  const handlers = new Map();
  const tools = [];
  const pi = {
    registerTool(tool) { tools.push(tool); },
    on(name, handler) { handlers.set(name, handler); },
    getAllTools() { return tools.map((tool) => ({ name: tool.name, sourceInfo: { source: "builtin" } })); },
  };
  const state = options.state || {
    status: "active",
    info: {
      name: "live",
      displayId: "live",
      image: IMAGE,
      pid: process.pid,
      cwd: root,
      root,
      createdAt: Date.now(),
      docker: { mode: "disabled", readiness: "disabled" },
    },
  };
  const provider = options.provider || {
    isActive: () => state.status === "active",
    getState: () => state,
    withRuntime: async () => { throw new Error("host call unexpectedly entered sandbox"); },
  };
  const hostReads = options.hostReads || createHostReadAccess();
  registerSandboxTools(pi, {
    provider,
    config: options.config || config(root),
    cwd: root,
    hostReads,
    createGrepExecute: () => async () => ({}),
    grepHelpers: {
      DEFAULT_MAX_BYTES: 1000,
      DEFAULT_MAX_LINES: 100,
      truncateHead: (x) => x,
      truncateLine: (x) => ({ text: x, wasTruncated: false }),
      formatSize: (x) => String(x),
    },
    systemPromptNote: () => "",
  });
  const confirmations = [];
  const prompts = [];
  const ctx = {
    hasUI: true,
    cwd: root,
    ui: {
      confirm: async (title, message) => {
        prompts.push({ title, message });
        return confirmations.shift() ?? false;
      },
      notify() {},
    },
  };
  return {
    handlers,
    tools,
    ctx,
    confirmations,
    prompts,
    hostReads,
    read: tools.find((tool) => tool.name === "read"),
    bash: tools.find((tool) => tool.name === "bash"),
  };
}

async function scenario7() {
  const root = await repo();
  const bad = { image: `pi-msb/no-such-live-image-${Date.now()}`, bootstrapTools: false };
  let blockedValue;
  let fallbackValue;
  try {
    const blockedSession = `bad-${Date.now()}`;
    blockedValue = integration(root, blockedSession, []);
    const blocked = await blockedValue.configureSession({
      sessionId: blockedSession,
      cwd: root,
      projectTrusted: true,
      config: { config: config(root, bad), provenance: {}, warnings: [] },
    });
    assert.equal(blocked.status, "unavailable");
    const blockedTools = toolHarness(root, { state: blocked, config: config(root, bad) });
    const blockedEvent = await blockedTools.handlers.get("tool_call")(
      { toolName: "read", toolCallId: "blocked", input: { path: join(root, "tracked.txt") } },
      blockedTools.ctx,
    );
    assert.match(blockedEvent.reason, /blocked|unavailable/i);
    await assert.rejects(
      () => blockedTools.read.execute("blocked", { path: join(root, "tracked.txt") }, undefined, undefined, blockedTools.ctx),
      /blocked|unavailable/i,
    );

    const fallbackSession = `fallback-${Date.now()}`;
    const fallbackConfig = { ...bad, fallbackMode: "host" };
    fallbackValue = integration(root, fallbackSession, []);
    const fallbackState = await fallbackValue.configureSession({
      sessionId: fallbackSession,
      cwd: root,
      projectTrusted: true,
      config: { config: config(root, fallbackConfig), provenance: {}, warnings: [] },
    });
    assert.equal(fallbackState.status, "host-fallback");
    const fallbackTools = toolHarness(root, { state: fallbackState, config: config(root, fallbackConfig) });
    const fallbackRead = await fallbackTools.read.execute("fallback", { path: join(root, "tracked.txt") }, undefined, undefined, fallbackTools.ctx);
    assert.match(JSON.stringify(fallbackRead), /committed/);

    const off = createMsbIntegration({ sessionId: "off-live", cwd: root, configDirName: ".pi", env: { ...env, PI_MSB_DISABLE: "1" } });
    const offState = await off.configureSession({
      sessionId: "off-live",
      cwd: root,
      projectTrusted: true,
      config: { config: config(root, bad), provenance: {}, warnings: [] },
    });
    assert.equal(offState.status, "off");
    const offTools = toolHarness(root, { state: offState, config: config(root, bad) });
    const offRead = await offTools.read.execute("off", { path: join(root, "tracked.txt") }, undefined, undefined, offTools.ctx);
    assert.match(JSON.stringify(offRead), /committed/);
  } finally {
    if (blockedValue) await blockedValue.manager.shutdown();
    if (fallbackValue) await fallbackValue.manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}

async function scenario8() {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-live-tools-"));
  const file = join(root, "approved.txt");
  await writeFile(file, "approved\n");
  const h = toolHarness(root);
  try {
    h.confirmations.push(true);
    const event = { toolName: "read", toolCallId: "approved", input: { path: file, execution_target: "host" } };
    assert.equal(await h.handlers.get("tool_call")(event, h.ctx), undefined);
    assert.match(h.prompts[0]?.message || "", /bypasses?.*VM.*process.*network isolation/is);
    assert.match(JSON.stringify(await h.read.execute("approved", event.input, undefined, undefined, h.ctx)), /approved/);
    h.confirmations.push(true);
    await h.handlers.get("tool_call")(event, h.ctx);
    await assert.rejects(
      () => h.read.execute("approved", { path: root, execution_target: "host" }, undefined, undefined, h.ctx),
      /exact tool call/,
    );
    h.confirmations.push(false);
    const denied = await h.handlers.get("tool_call")({ ...event, toolCallId: "denied" }, h.ctx);
    assert.match(denied.reason, /denied/);
    const noUi = await h.handlers.get("tool_call")({ ...event, toolCallId: "headless" }, { ...h.ctx, hasUI: false });
    assert.match(noUi.reason, /no interactive UI/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function scenario9() {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-live-skill-"));
  const skills = join(root, "skills");
  const outside = join(root, "outside.md");
  await fs.mkdir(skills);
  await writeFile(join(skills, "SKILL.md"), "skill\n");
  await writeFile(join(skills, "support.md"), "support\n");
  await writeFile(outside, "outside\n");
  const escape = join(skills, "escape.md");
  try { await symlink(outside, escape); } catch {}
  const access = createHostReadAccess();
  access.updateSkills([{ filePath: join(skills, "SKILL.md"), baseDir: skills }]);
  try {
    assert.equal(await access.resolve(join(skills, "support.md"), root), await fs.realpath(join(skills, "support.md")));
    if (await fs.lstat(escape).then(() => true, () => false)) await assert.rejects(() => access.resolve(escape, root), /outside/);
  } finally {
    access.clear();
    await rm(root, { recursive: true, force: true });
  }
}

async function scenario10() {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-live-output-"));
  let value;
  let harness;
  try {
    value = await boot(root);
    harness = toolHarness(root, { provider: value.provider, state: value.provider.getState(), config: config(root) });
    const result = await harness.bash.execute(
      "tracked-bash",
      { command: "i=0; while [ $i -lt 5000 ]; do printf 'tracked Bash output %05d\\n' $i; i=$((i + 1)); done" },
      undefined,
      undefined,
      harness.ctx,
    );
    const fullOutputPath = result.details?.fullOutputPath;
    assert.ok(fullOutputPath, "long routed Bash output did not record fullOutputPath");
    assert.match(JSON.stringify(await harness.read.execute("read-full-output", { path: fullOutputPath }, undefined, undefined, harness.ctx)), /tracked Bash output/);
    const neighborPath = join(dirname(fullOutputPath), `${basename(fullOutputPath)}-neighbor`);
    await writeFile(neighborPath, "not granted\n");
    await assert.rejects(
      () => harness.read.execute("read-neighbor", { path: neighborPath }, undefined, undefined, harness.ctx),
      /sandbox|outside|not found/i,
    );
  } finally {
    if (harness) harness.hostReads.clear();
    if (value) await close(value);
    await rm(root, { recursive: true, force: true });
  }
}

async function scenario11() {
  const root = await repo();
  const denySession = `deny-${Date.now()}`;
  let denied;
  try {
    const unprepared = { image: "ubuntu:24.04", network: { mode: "deny", allowDns: false }, bootstrapTools: "auto" };
    denied = integration(root, denySession, []);
    const state = await denied.configureSession({
      sessionId: denySession,
      cwd: root,
      projectTrusted: true,
      config: { config: config(root, unprepared), provenance: {}, warnings: [] },
    });
    assert.equal(state.status, "unavailable", "deny policy silently widened networking to bootstrap tools");

    for (const image of PREPARED_IMAGES) {
      const preparedConfig = {
        image,
        pullPolicy: "always",
        bootstrapTools: false,
        network: { mode: "deny", allowDns: false },
      };
      const prepared = await boot(root, preparedConfig, [], `prepared-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      try {
        const command = await guest(prepared, "sh", ["-lc", "printf pi-msb-prepared"], { timeoutMs: 30_000 });
        assert.equal(command.stdout.toString(), "pi-msb-prepared", `${image}: ${command.stderr.toString()}`);
        assert.equal(prepared.state.info?.docker.readiness, "ready", `${image} Docker was not ready before activation`);
        assert.equal(prepared.state.info?.docker.storageDriver, "vfs", `${image} did not use vfs`);
        assert.match((await guest(prepared, "docker", ["buildx", "version"])).stdout.toString(), /v0\.37\.1/);
        assert.match((await guest(prepared, "docker", ["compose", "version"])).stdout.toString(), /v5\.5\.1/);
      } finally {
        await close(prepared);
      }
    }
  } finally {
    if (denied) await denied.manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}

async function scenario12() {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-live-concurrent-"));
  let value;
  try {
    await writeFile(join(root, "grep.txt"), "needle one\nsecond line\n");
    await writeFile(join(root, ".hidden.txt"), "hidden\n");
    await fs.mkdir(join(root, "subdir"));
    await writeFile(join(root, "subdir", "listed.txt"), "listed\n");
    value = await boot(root);
    const outputs = await runtimeCall(value, async (runtime) => Promise.all([
      runtime.transport.exec("printf", ["one"]),
      runtime.transport.exec("printf", ["two"]),
    ]));
    assert.deepEqual(outputs.map((x) => x.stdout.toString()).sort(), ["one", "two"]);
    const controller = new AbortController();
    const aborted = runtimeCall(value, (runtime) => runtime.transport.execStream("sleep", ["30"], { signal: controller.signal }));
    await sleep(200);
    controller.abort();
    await assert.rejects(aborted, /abort/i);
    await assert.rejects(() => guest(value, "sleep", ["30"], { timeoutMs: 1 }), (error) => error?.code === "TIMEOUT");
    const found = await runtimeCall(value, (runtime) => runtime.operations.find.glob("*.txt", root, { ignore: [], limit: 10 }));
    assert.ok(found.some((path) => path.endsWith("grep.txt")));
    const listed = await runtimeCall(value, (runtime) => runtime.operations.ls.readdir(root));
    assert.ok(listed.includes(".hidden.txt"));
    assert.ok(listed.includes("subdir"));
    const grep = createSandboxGrepExecute({
      provider: value.provider,
      cwd: root,
      helpers: { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, truncateLine, formatSize },
    });
    const grepResult = await grep("live-grep", { pattern: "needle", path: root, limit: 10 });
    assert.match(JSON.stringify(grepResult), /grep\.txt.*needle/s);
  } finally {
    if (value) await close(value);
    await rm(root, { recursive: true, force: true });
  }
}

async function scenario13() {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-live-docker-"));
  let value;
  const port = 30000 + (process.pid % 10000);
  try {
    await writeFile(join(root, "Dockerfile"), "FROM alpine:3.22\nRUN wget -qO /network-ok https://example.com\n");
    await writeFile(join(root, "compose.yml"), 'services:\n  smoke:\n    image: alpine:3.22\n    command: ["wget", "-qO-", "https://example.com"]\n');
    value = await boot(root, {
      docker: { mode: "require", startupTimeoutMs: 30000 },
      network: { mode: "default", allowDns: true, publishPorts: [`127.0.0.1:${port}:${port}`] },
    });
    assert.equal(value.state.info?.docker.readiness, "ready");
    assert.equal(value.state.info?.docker.storageDriver, "vfs");
    assert.equal((await guest(value, "docker", ["run", "--rm", "alpine:3.22", "uname", "-s"], { timeoutMs: 120_000 })).stdout.toString().trim(), "Linux");
    assert.equal((await guest(value, "docker", ["network", "create", "pi-msb-live-net"])).exitCode, 0);
    assert.equal((await guest(value, "docker", ["run", "-d", "--name", "pi-msb-peer", "--network", "pi-msb-live-net", "alpine:3.22", "sleep", "120"])).exitCode, 0);
    assert.equal((await guest(value, "docker", ["run", "--rm", "--network", "pi-msb-live-net", "alpine:3.22", "getent", "hosts", "pi-msb-peer"])).exitCode, 0);
    const build = await guest(value, "docker", ["buildx", "build", "--load", "-t", "pi-msb-live-build", "."], { cwd: root, timeoutMs: 180_000 });
    assert.equal(build.exitCode, 0, build.stderr.toString());
    const compose = await guest(value, "docker", ["compose", "-f", join(root, "compose.yml"), "up", "--abort-on-container-exit", "--exit-code-from", "smoke"], { cwd: root, timeoutMs: 120_000 });
    assert.equal(compose.exitCode, 0, compose.stderr.toString());
    const ported = await guest(value, "docker", [
      "run", "-d", "--name", "pi-msb-ported",
      "-p", `0.0.0.0:${port}:8080`,
      "-p", `0.0.0.0:${port + 1}:8080`,
      "alpine:3.22", "sh", "-c",
      "while true; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 6\\r\\n\\r\\nnested' | nc -l -p 8080; done",
    ]);
    assert.equal(ported.exitCode, 0, ported.stderr.toString());
    let body = "";
    for (let attempt = 0; attempt < 30 && body !== "nested"; attempt++) {
      try { body = await (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) })).text(); } catch {}
      if (body !== "nested") await sleep(200);
    }
    assert.equal(body, "nested", "published Docker port was not reachable from the host");
    await assert.rejects(fetch(`http://127.0.0.1:${port + 1}`, { signal: AbortSignal.timeout(1000) }));
    assert.equal((await guest(value, "test", ["!", "-e", join(root, "var", "lib", "docker")])).exitCode, 0);
    assert.equal((await guest(value, "test", ["!", "-e", "/root/.docker/config.json"])).exitCode, 0);
  } finally {
    if (value) {
      try { await guest(value, "docker", ["rm", "-f", "pi-msb-peer", "pi-msb-ported"]); } catch {}
      try { await guest(value, "docker", ["network", "rm", "pi-msb-live-net"]); } catch {}
      try { await guest(value, "docker", ["compose", "-f", join(root, "compose.yml"), "down", "--remove-orphans"], { cwd: root }); } catch {}
      await close(value);
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function scenario14() {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-live-docker-policy-"));
  let enabled;
  let denied;
  let allowed;
  try {
    const docker = { mode: "require", startupTimeoutMs: 30000 };
    enabled = await boot(root, { docker });
    assert.equal((await guest(enabled, "docker", ["pull", "alpine:3.22"], { timeoutMs: 120_000 })).exitCode, 0);
    assert.equal((await guest(enabled, "docker", ["save", "-o", join(root, "alpine.tar"), "alpine:3.22"], { timeoutMs: 120_000 })).exitCode, 0);
    await close(enabled);
    enabled = undefined;

    denied = await boot(root, { docker, network: { mode: "deny", allowDns: false, publishPorts: [] } });
    assert.equal((await guest(denied, "docker", ["load", "-i", join(root, "alpine.tar")], { timeoutMs: 120_000 })).exitCode, 0);
    const deniedEgress = await guest(denied, "docker", ["run", "--rm", "alpine:3.22", "wget", "-T", "5", "-qO-", "https://example.com"], { timeoutMs: 30_000 });
    assert.notEqual(deniedEgress.exitCode, 0, "nested container bypassed deny policy");
    const oldPid = (await guest(denied, "cat", ["/run/docker.pid"])).stdout.toString().trim();
    const stopped = await guest(denied, "sh", ["-c", 'kill "$1"; for i in $(seq 1 100); do if ! kill -0 "$1" 2>/dev/null && test ! -S /var/run/docker.sock; then exit 0; fi; sleep .1; done; exit 1', "sh", oldPid]);
    assert.equal(stopped.exitCode, 0);
    const starts = await Promise.all(Array.from({ length: 4 }, () => guest(denied, "pi-msb-docker-start", ["30000"], { timeoutMs: 32_000 })));
    assert.ok(starts.every((result) => result.exitCode === 0), "concurrent Docker startup was not serialized");
    const deniedAfterRestart = await guest(denied, "docker", ["run", "--rm", "alpine:3.22", "wget", "-T", "5", "-qO-", "https://example.com"], { timeoutMs: 30_000 });
    assert.notEqual(deniedAfterRestart.exitCode, 0, "Docker restart widened deny policy");
    await close(denied);
    denied = undefined;

    allowed = await boot(root, { docker, network: { mode: "allowlist", allowHosts: ["example.com"], allowDns: true, publishPorts: [] } });
    assert.equal((await guest(allowed, "docker", ["load", "-i", join(root, "alpine.tar")], { timeoutMs: 120_000 })).exitCode, 0);
    const allowedEgress = await guest(allowed, "docker", ["run", "--rm", "alpine:3.22", "wget", "-T", "10", "-qO-", "https://example.com"], { timeoutMs: 30_000 });
    assert.equal(allowedEgress.exitCode, 0, allowedEgress.stderr.toString());
    const blockedEgress = await guest(allowed, "docker", ["run", "--rm", "alpine:3.22", "wget", "-T", "5", "-qO-", "https://example.org"], { timeoutMs: 30_000 });
    assert.notEqual(blockedEgress.exitCode, 0, "nested container bypassed allowlist policy");
  } finally {
    if (enabled) await close(enabled);
    if (denied) await close(denied);
    if (allowed) await close(allowed);
    await rm(root, { recursive: true, force: true });
  }
}

const scenarios = [
  scenario1, scenario2, scenario3, scenario4, scenario5, scenario6, scenario7,
  scenario8, scenario9, scenario10, scenario11, scenario12, scenario13, scenario14,
];
async function probe() {
  const name = `pi-msb-live-probe-${process.pid}-${Date.now()}`;
  let sandbox;
  try {
    sandbox = await Sandbox.builder(name).image(IMAGE).cpus(1).memory(512).idleTimeout(30).create();
    const result = await sandbox.exec("true", []);
    if (result.code !== 0) throw new Error(`probe command exited ${result.code}`);
    console.log("PROBE|PASS|virtualization and image are available");
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/kvm|hypervisor|virtualiz|libkrun|whp|wsl|permission.*device|unsupported platform/i.test(text)) {
      console.log(`PROBE|SKIP|virtualization unavailable: ${text}`);
      process.exitCode = 2;
    } else {
      console.log(`PROBE|FAIL|${text}`);
      process.exitCode = 1;
    }
  } finally {
    if (sandbox) {
      try { await sandbox.stopWithTimeout(10000); } catch {}
      try { await (await Sandbox.get(name)).remove(); } catch {}
    }
  }
}

if (process.argv[2] === "--probe") await probe();
else if (process.argv[2] === "--hold") await holdOwner(process.argv[3], process.argv[4], process.argv[5]);
else if (process.argv[2] === "--load") console.log(`LOAD|PASS|${names.length} scenarios loaded`);
else {
  for (let i = 0; i < scenarios.length; i++) {
    try {
      await scenarios[i]();
      console.log(`RESULT|${i}|PASS|live assertion completed`);
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
      console.log(`RESULT|${i}|FAIL|${reason}`);
    }
  }
}
NODE

# Replace the absolute repository placeholder without adding a Python runtime
# dependency to the release smoke harness.
node --input-type=module - "$RUNNER" "$ROOT" <<'JS'
import { readFile, writeFile } from "node:fs/promises";
const [path, root] = process.argv.slice(2);
const text = await readFile(path, "utf8");
await writeFile(path, text.replaceAll("__ROOT__", root));
JS

probe_output=$(node --experimental-strip-types "$RUNNER" --probe 2>&1)
probe_code=$?
printf '%s\n' "$probe_output"
if [ "$probe_code" -eq 2 ]; then
  reason=$(printf '%s\n' "$probe_output" | awk -F'|' '/^PROBE\|SKIP\|/ {print $3; exit}')
  report_all_skip "${reason:-virtualization unavailable}; no live validation was performed"
  exit 0
elif [ "$probe_code" -ne 0 ]; then
  reason=$(printf '%s\n' "$probe_output" | awk -F'|' '/^PROBE\|FAIL\|/ {print $3; exit}')
  printf 'FAIL  07  %s (%s)\n' "${SCENARIOS[6]}" "${reason:-live probe failed}"
  for i in "${!SCENARIOS[@]}"; do
    [ "$i" -eq 6 ] && continue
    printf 'SKIP  %02d  %s (live probe failed before this scenario; no live validation was performed)\n' "$((i + 1))" "${SCENARIOS[$i]}"
  done
  exit 1
fi

node --experimental-strip-types "$RUNNER" --matrix >"$OUTPUT" 2>&1 || true
failures=0
seen_indices=""
while IFS='|' read -r marker index status reason; do
  [ "$marker" = "RESULT" ] || continue
  seen_indices="$seen_indices $index"
  if [ "$status" = "FAIL" ]; then failures=$((failures + 1)); fi
  printf '%-5s %02d  %s (%s)\n' "$status" "$((index + 1))" "${SCENARIOS[$index]}" "$reason"
done <"$OUTPUT"
for i in "${!SCENARIOS[@]}"; do
  case " $seen_indices " in
    *" $i "*) ;;
    *)
      printf 'FAIL  %02d  %s (live runner produced no result)\n' "$((i + 1))" "${SCENARIOS[$i]}"
      failures=$((failures + 1))
      ;;
  esac
done
if [ "$failures" -ne 0 ]; then
  echo "Live E2E matrix: $failures failure(s)."
  exit 1
fi
echo "Live E2E matrix: all scenarios passed."
exit 0
