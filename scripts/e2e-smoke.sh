#!/usr/bin/env bash
# Opt-in live matrix for pi-microsandbox. It deliberately creates real VMs and named
# volumes; do not run it from an untrusted checkout.
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

SCENARIOS=(
  "Git bundle excludes untracked files"
  "Git volume is clean and host-readable"
  "Shutdown removes sandbox and retains volume"
  "Reload and off/on reuse the volume"
  "Forked session gets a new identity"
  "Duplicate owner is blocked before mutation"
  "SIGKILL owner is pruned, volume retained"
  "Idle timeout wakes before execution"
  "Boot failure blocks and host modes differ"
  "Host target requires exact approval"
  "Skill reads enforce canonical containment"
  "Generated output grants one exact path"
  "Direct and none preserve their documented paths"
  "Bootstrap and deny-network behavior"
  "Concurrent exec, abort, timeout, grep, and find"
  "Export and managed-volume removal are guarded"
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
  report_all_skip "PI_MSB_LIVE_TEST is not 1"
  exit 0
fi

missing=()
for command in node git; do
  if ! command -v "$command" >/dev/null 2>&1; then missing+=("$command"); fi
done
if [ "${#missing[@]}" -ne 0 ]; then
  report_all_skip "missing prerequisite: ${missing[*]}"
  exit 0
fi

# msb --version checks that the platform package is installed, but not that a
# hypervisor is usable. The probe below is the authoritative virtualization
# check and is intentionally the only pre-matrix VM.
if ! command -v msb >/dev/null 2>&1 && [ -z "${MSB_PATH:-}" ]; then
  report_all_skip "microsandbox/msb is not installed"
  exit 0
fi

# Keep the generated ESM runner under the package root so bare imports resolve
# through this checkout's node_modules on every supported Node release. A
# temporary directory avoids BSD mktemp's requirement that Xs end the template.
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
import { createCommandHandler } from "__ROOT__/extensions/pi-msb/command.ts";
import { createSandboxGrepExecute } from "__ROOT__/extensions/pi-msb/operations-exec.ts";
import { acquireOwnerLock } from "__ROOT__/extensions/pi-msb/locks.ts";
import { createHostReadAccess } from "__ROOT__/extensions/pi-msb/skill-access.ts";
import { registerSandboxTools } from "__ROOT__/extensions/pi-msb/tools.ts";
import { sandboxNameFor, volumeNameFor } from "__ROOT__/extensions/pi-msb/types.ts";
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
  "Git bundle excludes untracked files",
  "Git volume is clean and host-readable",
  "Shutdown removes sandbox and retains volume",
  "Reload and off/on reuse the volume",
  "Forked session gets a new identity",
  "Duplicate owner is blocked before mutation",
  "SIGKILL owner is pruned, volume retained",
  "Idle timeout wakes before execution",
  "Boot failure blocks and host modes differ",
  "Host target requires exact approval",
  "Skill reads enforce canonical containment",
  "Generated output grants one exact path",
  "Direct and none preserve their documented paths",
  "Bootstrap and deny-network behavior",
  "Concurrent exec, abort, timeout, grep, and find",
  "Export and managed-volume removal are guarded",
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
    await writeFile(join(root, "tracked.txt"), "committed\n");
    check(await sh("git", ["add", "tracked.txt"], root), "git add");
    check(await sh("git", ["-c", "commit.gpgSign=false", "commit", "-q", "-m", "seed"], root), "git commit");
    await writeFile(join(root, ".env"), "LIVE_SECRET=must-not-be-bundled\n");
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
function config(root, mode = "git", extra = {}) {
  return {
    ...DEFAULT_CONFIG,
    secrets: [], mounts: [],
    lockDir: join(root, ".locks"),
    image: IMAGE,
    mode,
    pullPolicy: extra.pullPolicy ?? LIVE_PULL_POLICY,
    bootstrapTools: extra.bootstrapTools ?? "auto",
    idleTimeoutSec: extra.idleTimeoutSec ?? 600,
    ...extra,
    network: { ...DEFAULT_CONFIG.network, ...(extra.network || {}) },
  };
}
function integration(root, sessionId, mode = "git", extra = {}, entries = []) {
  return createMsbIntegration({
    sessionId, cwd: root, configDirName: ".pi", env,
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    entries: () => entries,
    sdkLoader: async () => await import("microsandbox"),
  });
}
async function boot(root, mode = "git", extra = {}, entries = [], suppliedSessionId) {
  const sessionId = suppliedSessionId || `pi-msb-live-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const value = integration(root, sessionId, mode, extra, entries);
  const state = await value.configureSession({
    sessionId, cwd: root, projectTrusted: true,
    config: { config: config(root, mode, extra), provenance: {}, warnings: [] },
  });
  if (state.status !== "active") {
    const cleanupErrors = [];
    try { await value.manager.shutdown(); } catch (error) { cleanupErrors.push(`sandbox cleanup: ${error.message}`); }
    if (mode === "git") {
      try { await removeVolumeIfPresent(value, volumeNameFor(sessionId)); }
      catch (error) { cleanupErrors.push(`volume cleanup: ${error.message}`); }
    }
    const cleanupDetail = cleanupErrors.length ? `; ${cleanupErrors.join("; ")}` : "";
    throw new Error(`expected active sandbox, got ${state.status}: ${state.reason || "no reason"}${cleanupDetail}`);
  }
  return { ...value, sessionId, state, entries };
}
async function runtimeCall(value, callback) {
  return value.manager.withRuntime(callback);
}
async function guest(value, command, args, options = {}) {
  return runtimeCall(value, (runtime) => runtime.transport.exec(command, args, options));
}
async function removeVolume(value, volumeName) {
  const targetName = volumeName || value.control.getState().info?.volumeName;
  if (!targetName) return;
  try { await value.control.removeVolume(targetName); } catch (error) {
    // A failed cleanup is reported by the scenario that owns the resource.
    throw new Error(`volume cleanup failed for ${targetName}: ${error.message}`);
  }
}
async function removeVolumeIfPresent(value, volumeName) {
  try { await (await import("microsandbox")).Volume.get(volumeName); }
  catch (error) { if (error?.constructor?.name?.includes("NotFound")) return; throw error; }
  await removeVolume(value, volumeName);
}
async function close(value, volumeName, remove = true) {
  const targetName = volumeName || value.control.getState().info?.volumeName;
  try { await value.manager.shutdown(); } finally {
    if (remove) await removeVolume(value, targetName);
  }
}
async function activeVolume(value) {
  const name = value.state.info?.volumeName;
  assert.ok(name, "expected a retained volume name");
  const path = value.state.info?.volumeHostPath;
  assert.ok(path, "SDK did not return a host path for the newly-created volume");
  return { name, path };
}
async function sandboxAbsent(name) {
  try { await Sandbox.get(name); return false; } catch { return true; }
}

async function scenario1() {
  const root = await repo(); let value; let volume;
  try {
    value = await boot(root);
    volume = await activeVolume(value);
    const status = await guest(value, "git", ["status", "--porcelain"], root);
    assert.equal(status.stdout.toString(), "", "seed must be clean");
    const hidden = await guest(value, "test", ["!", "-e", join(root, ".env")], root);
    assert.equal(hidden.exitCode, 0, ".env must not be in the seeded guest checkout");
    const tracked = await guest(value, "cat", [join(root, "tracked.txt")], root);
    assert.equal(tracked.stdout.toString(), "committed\n");
    const committed = await guest(value, "sh", ["-lc", "printf 'volume-only\\n' > volume-only.txt && git add volume-only.txt && git -c user.name='pi-msb live' -c user.email=pi-msb-live@example.invalid -c commit.gpgSign=false commit -qm volume-only"], root);
    assert.equal(committed.exitCode, 0, committed.stderr.toString());
    assert.equal((await sh("test", ["!", "-e", join(root, "volume-only.txt")])).code, 0, "host checkout changed");
    assert.notEqual(volume.path, root, "Git mode must not bind the checkout");
  } finally { if (value) await close(value, volume?.name); await rm(root, { recursive: true, force: true }); }
}
async function scenario2() {
  const root = await repo(); let value; let volume;
  try {
    value = await boot(root); volume = await activeVolume(value);
    const status = check(await sh("git", ["-C", volume.path, "status", "--porcelain"]), "host volume status");
    assert.equal(status.stdout, "", "volume must be clean after seed");
    const stat = await fs.stat(join(volume.path, "tracked.txt"));
    assert.ok((stat.mode & 0o777) > 0, "host must be able to inspect file mode");
    assert.equal(check(await sh("git", ["-C", volume.path, "rev-parse", "HEAD"]), "volume HEAD").stdout.trim(), check(await sh("git", ["-C", root, "rev-parse", "HEAD"]), "host HEAD").stdout.trim());
  } finally { if (value) await close(value, volume?.name); await rm(root, { recursive: true, force: true }); }
}
async function scenario3() {
  const root = await repo(); let value; let volume;
  try {
    value = await boot(root); volume = await activeVolume(value); const name = value.state.info.name;
    await value.manager.shutdown();
    assert.equal(await sandboxAbsent(name), true, "shutdown must remove the sandbox");
    const retained = await (await import("microsandbox")).Volume.get(volume.name);
    assert.equal(retained.name, volume.name, "shutdown must retain the volume");
    check(await sh("git", ["-C", volume.path, "remote", "add", "host", root]), "manual host remote");
    check(await sh("git", ["-C", volume.path, "fetch", "--no-tags", "host", "main"]), "manual host fetch");
  } finally { if (value) await removeVolume(value, volume?.name); await rm(root, { recursive: true, force: true }); }
}
async function scenario4() {
  const root = await repo(); const entries = []; let value; let volume;
  try {
    await writeFile(join(root, ".pi-msb.toml"), 'mode = "git"\n');
    value = await boot(root, "git", {}, entries); volume = await activeVolume(value);
    await guest(value, "sh", ["-lc", "printf 'kept\\n' > retained.txt"], root);
    await value.control.reload();
    assert.equal(value.control.getState().info?.volumeName, volume.name, "reload changed volume");
    await value.control.setEnabled(false); assert.equal(value.control.getState().status, "off");
    await value.control.setEnabled(true); assert.equal(value.control.getState().status, "active");
    assert.equal((await guest(value, "cat", [join(root, "retained.txt")], root)).stdout.toString(), "kept\n");
    assert.equal(value.control.getState().info?.volumeName, volume.name, "off/on changed volume");
  } finally { if (value) await close(value, volume?.name); await rm(root, { recursive: true, force: true }); }
}
async function scenario5() {
  const root = await repo(); const parentSession = `parent-${Date.now()}`; const entries = []; let first; let second; let firstVolume; let secondVolume;
  try {
    first = await boot(root, "git", {}, entries, parentSession); firstVolume = await activeVolume(first); await first.manager.shutdown();
    const copiedState = entries.map((entry) => structuredClone(entry));
    assert.ok(copiedState.some((entry) => entry.customType === "pi-msb.state" && entry.data?.sessionId === parentSession), "parent state was not persisted");
    const forkSession = `fork-${Date.now()}`;
    second = await boot(root, "git", {}, copiedState, forkSession); secondVolume = await activeVolume(second);
    assert.equal(second.sessionId, forkSession);
    assert.notEqual(secondVolume.name, firstVolume.name, "copied parent state reused its volume");
    assert.equal(second.state.info?.seedSha, first.state.info?.seedSha, "fork did not seed the same committed source");
  } finally {
    if (second) await close(second, secondVolume?.name);
    if (first) await removeVolume(first, firstVolume?.name);
    await rm(root, { recursive: true, force: true });
  }
}
async function scenario6() {
  const root = await repo(); const lockDir = join(root, ".locks");
  const info = { version: 1, sessionId: "same-live-session", sandboxName: sandboxNameFor("same-live-session"), mode: "git", cwd: root, pid: process.pid, createdAt: Date.now() };
  const owner = await acquireOwnerLock({ lockDir }, info); assert.ok(owner);
  let sdkLoads = 0;
  try {
    const value = createMsbIntegration({ sessionId: info.sessionId, cwd: root, configDirName: ".pi", env, sdkLoader: async () => { sdkLoads++; return await import("microsandbox"); } });
    const state = await value.configureSession({ sessionId: info.sessionId, cwd: root, projectTrusted: true, config: { config: config(root), provenance: {}, warnings: [] } });
    assert.equal(state.status, "unavailable"); assert.match(state.reason || "", /another process owns/); assert.equal(sdkLoads, 0, "lock must precede SDK mutation");
  } finally { await owner.release(); await rm(root, { recursive: true, force: true }); }
}
async function scenario7() {
  const root = await repo(); const session = `prune-${Date.now()}`; const ready = join(root, "ready");
  const child = spawn(process.execPath, [process.argv[1], "--hold", root, session, ready], { env: { ...process.env, PI_MSB_LIVE_IMAGE: IMAGE, PI_MSB_DISABLE: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let childValue;
  try {
    for (let i = 0; i < 180 && !(await fs.access(ready).then(() => true, () => false)); i++) await sleep(1000);
    assert.equal(await fs.access(ready).then(() => true, () => false), true, "owner did not reach active state");
    const ownerRecord = JSON.parse(await readFile(ready, "utf8"));
    assert.equal(ownerRecord.sessionId, session, "hold owner booted a different session");
    assert.equal(ownerRecord.info?.volumeName, volumeNameFor(session), "hold owner did not own the intended volume");
    child.kill("SIGKILL"); await sleep(1500);
    childValue = integration(root, session, "git", {}, []);
    const state = await childValue.configureSession({ sessionId: session, cwd: root, projectTrusted: true, config: { config: config(root), provenance: {}, warnings: [] } });
    assert.equal(state.status, "active", state.reason || "prune/restart failed");
    assert.equal(state.info?.volumeName, volumeNameFor(session));
    await childValue.manager.shutdown(); await removeVolume(childValue, state.info?.volumeName);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    if (childValue) { try { await childValue.manager.shutdown(); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
}
async function holdOwner(root, session, ready) {
  const value = await boot(root, "git", {}, [], session);
  await writeFile(ready, JSON.stringify({ sessionId: value.sessionId, info: value.state.info }));
  setInterval(() => {}, 1000);
}
async function scenario8() {
  const root = await repo(); let value; let volume;
  try {
    value = await boot(root, "git", { idleTimeoutSec: 2, docker: { mode: "require", startupTimeoutMs: 30000 } }); volume = await activeVolume(value);
    const firstDocker = await guest(value, "docker", ["run", "--rm", "alpine:3.22", "printf", "first"] , { timeoutMs: 120_000 });
    assert.equal(firstDocker.exitCode, 0, firstDocker.stderr.toString());
    const firstBootId = (await guest(value, "cat", ["/proc/sys/kernel/random/boot_id"])).stdout.toString().trim();
    await sleep(5000);
    const status = await Sandbox.get(value.state.info.name); const rawStatus = String(status.status || status.state || "").toLowerCase();
    assert.ok(["stopped", "idle", "exited", "dead", "created"].includes(rawStatus), `expected idle stop, got ${rawStatus}`);
    assert.equal((await guest(value, "printf", ["woke"])).stdout.toString(), "woke");
    const secondBootId = (await guest(value, "cat", ["/proc/sys/kernel/random/boot_id"])).stdout.toString().trim();
    assert.notEqual(secondBootId, firstBootId, "idle wake did not cross a guest boot boundary");
    const launchOwner = (await guest(value, "cat", ["/run/pi-msb-docker-launch.owner"])).stdout.toString().trim().split(" ");
    assert.equal(launchOwner.length, 4, "Docker launch provenance did not include the boot ID");
    assert.equal(launchOwner[3], secondBootId, "Docker launch provenance retained the prior boot ID");
    const secondDocker = await guest(value, "docker", ["run", "--rm", "alpine:3.22", "printf", "second"], { timeoutMs: 60_000 });
    assert.equal(secondDocker.stdout.toString(), "second", secondDocker.stderr.toString());
  } finally { if (value) await close(value, volume?.name); await rm(root, { recursive: true, force: true }); }
}
async function scenario9() {
  const root = await repo(); const bad = { image: `pi-msb/no-such-live-image-${Date.now()}`, bootstrapTools: false }; let value; let fallback; let badSession; let fallbackSession;
  try {
    badSession = `bad-${Date.now()}`;
    value = integration(root, badSession, "git", bad, []);
    const blocked = await value.configureSession({ sessionId: badSession, cwd: root, projectTrusted: true, config: { config: config(root, "git", bad), provenance: {}, warnings: [] } });
    assert.equal(blocked.status, "unavailable");
    const blockedTools = toolHarness(root, { state: blocked, config: config(root, "git", bad) });
    const blockedEvent = await blockedTools.handlers.get("tool_call")({ toolName: "read", toolCallId: "blocked", input: { path: join(root, "tracked.txt") } }, blockedTools.ctx);
    assert.match(blockedEvent.reason, /blocked|unavailable/i);
    await assert.rejects(() => blockedTools.read.execute("blocked", { path: join(root, "tracked.txt") }, undefined, undefined, blockedTools.ctx), /blocked|unavailable/i);

    fallbackSession = `fallback-${Date.now()}`;
    fallback = integration(root, fallbackSession, "git", { ...bad, fallbackMode: "host" }, []);
    const fallbackState = await fallback.configureSession({ sessionId: fallbackSession, cwd: root, projectTrusted: true, config: { config: config(root, "git", { ...bad, fallbackMode: "host" }), provenance: {}, warnings: [] } });
    assert.equal(fallbackState.status, "host-fallback");
    const fallbackTools = toolHarness(root, { state: fallbackState, config: config(root, "git", { ...bad, fallbackMode: "host" }) });
    const fallbackRead = await fallbackTools.read.execute("fallback", { path: join(root, "tracked.txt") }, undefined, undefined, fallbackTools.ctx);
    assert.match(JSON.stringify(fallbackRead), /committed/, "host fallback did not preserve host reads");

    const off = createMsbIntegration({ sessionId: "off-live", cwd: root, configDirName: ".pi", env: { ...env, PI_MSB_DISABLE: "1" } });
    const offState = await off.configureSession({ sessionId: "off-live", cwd: root, projectTrusted: true, config: { config: config(root, "git", bad), provenance: {}, warnings: [] } });
    assert.equal(offState.status, "off");
    const offTools = toolHarness(root, { state: offState, config: config(root, "git", bad) });
    const offRead = await offTools.read.execute("off", { path: join(root, "tracked.txt") }, undefined, undefined, offTools.ctx);
    assert.match(JSON.stringify(offRead), /committed/, "explicit off did not preserve host reads");
  } finally {
    if (value) { try { await value.manager.shutdown(); } finally { if (badSession) await removeVolumeIfPresent(value, volumeNameFor(badSession)); } }
    if (fallback) { try { await fallback.manager.shutdown(); } finally { if (fallbackSession) await removeVolumeIfPresent(fallback, volumeNameFor(fallbackSession)); } }
    await rm(root, { recursive: true, force: true });
  }
}
function toolHarness(root, options = {}) {
  const handlers = new Map(); const tools = [];
  const pi = { registerTool(tool) { tools.push(tool); }, on(name, handler) { handlers.set(name, handler); }, getAllTools() { return tools.map((tool) => ({ name: tool.name, sourceInfo: { source: "builtin" } })); } };
  const state = options.state || { status: "active", info: { name: "live", displayId: "live", mode: "git", image: IMAGE, pid: process.pid, cwd: root, createdAt: Date.now() } };
  const provider = options.provider || { isActive: () => state.status === "active", getState: () => state, withRuntime: async () => { throw new Error("host call unexpectedly entered sandbox"); } };
  const hostReads = options.hostReads || createHostReadAccess();
  const configValue = options.config || config(root);
  registerSandboxTools(pi, { provider, config: configValue, cwd: root, hostReads, createGrepExecute: () => async () => ({}), grepHelpers: { DEFAULT_MAX_BYTES: 1000, DEFAULT_MAX_LINES: 100, truncateHead: (x) => x, truncateLine: (x) => ({ text: x, wasTruncated: false }), formatSize: (x) => String(x) }, systemPromptNote: () => "" });
  const confirmations = [];
  const ctx = { hasUI: true, cwd: root, ui: { confirm: async () => confirmations.shift() ?? false, notify() {} } };
  return { handlers, tools, ctx, confirmations, hostReads, read: tools.find((tool) => tool.name === "read"), bash: tools.find((tool) => tool.name === "bash"), grep: tools.find((tool) => tool.name === "grep"), ls: tools.find((tool) => tool.name === "ls") };
}
async function scenario10() {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-live-tools-")); const file = join(root, "approved.txt"); await writeFile(file, "approved\n"); const h = toolHarness(root);
  try {
    h.confirmations.push(true); const event = { toolName: "read", toolCallId: "approved", input: { path: file, execution_target: "host" } };
    assert.equal(await h.handlers.get("tool_call")(event, h.ctx), undefined);
    const result = await h.read.execute("approved", event.input, undefined, undefined, h.ctx); assert.match(JSON.stringify(result), /approved/);
    h.confirmations.push(true); await h.handlers.get("tool_call")(event, h.ctx); await assert.rejects(() => h.read.execute("approved", { path: root, execution_target: "host" }, undefined, undefined, h.ctx), /exact tool call/);
    h.confirmations.push(false); const denied = await h.handlers.get("tool_call")({ ...event, toolCallId: "denied" }, h.ctx); assert.match(denied.reason, /denied/);
    const noUi = await h.handlers.get("tool_call")({ ...event, toolCallId: "headless" }, { ...h.ctx, hasUI: false }); assert.match(noUi.reason, /no interactive UI/);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function scenario11() {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-live-skill-")); const skills = join(root, "skills"); const outside = join(root, "outside.md"); await fs.mkdir(skills); await writeFile(join(skills, "SKILL.md"), "skill\n"); await writeFile(join(skills, "support.md"), "support\n"); await writeFile(outside, "outside\n"); const escape = join(skills, "escape.md");
  try { await symlink(outside, escape); } catch { /* symlink tests are skipped by the assertion below */ }
  const access = createHostReadAccess(); access.updateSkills([{ filePath: join(skills, "SKILL.md"), baseDir: skills }]);
  try { assert.equal(await access.resolve(join(skills, "support.md"), root), await fs.realpath(join(skills, "support.md"))); if (await fs.lstat(escape).then(() => true, () => false)) await assert.rejects(() => access.resolve(escape, root), /outside/); } finally { access.clear(); await rm(root, { recursive: true, force: true }); }
}
async function scenario12() {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-live-output-")); let value; let harness; let fullOutputPath;
  try {
    value = await boot(root, "direct");
    harness = toolHarness(root, { provider: value.provider, state: value.provider.getState(), config: config(root, "direct") });
    const result = await harness.bash.execute("tracked-bash", { command: "i=0; while [ $i -lt 5000 ]; do printf 'tracked Bash output %05d\\n' $i; i=$((i + 1)); done" }, undefined, undefined, harness.ctx);
    fullOutputPath = result.details?.fullOutputPath;
    assert.ok(fullOutputPath, "long routed Bash output did not record fullOutputPath");
    const fullRead = await harness.read.execute("read-full-output", { path: fullOutputPath }, undefined, undefined, harness.ctx);
    assert.match(JSON.stringify(fullRead), /tracked Bash output/, "tracked Bash output was not host-readable");
    const neighborPath = join(dirname(fullOutputPath), `${basename(fullOutputPath)}-neighbor`);
    await writeFile(neighborPath, "not granted\\n");
    await assert.rejects(() => harness.read.execute("read-neighbor", { path: neighborPath }, undefined, undefined, harness.ctx), /sandbox|outside|not found/i);
  } finally { if (harness) harness.hostReads.clear(); if (value) await close(value); await rm(root, { recursive: true, force: true }); }
}
async function scenario13() {
  const directRoot = await mkdtemp(join(tmpdir(), "pi-msb-live-direct-")); const noneRoot = await mkdtemp(join(tmpdir(), "pi-msb-live-none-")); let direct; let none;
  try { direct = await boot(directRoot, "direct"); await guest(direct, "sh", ["-lc", "printf host > live-direct.txt"], directRoot); assert.equal((await readFile(join(directRoot, "live-direct.txt"), "utf8")), "host"); none = await boot(noneRoot, "none"); await guest(none, "sh", ["-lc", "printf guest > live-none.txt"], noneRoot); assert.equal(await fs.access(join(noneRoot, "live-none.txt")).then(() => false, () => true), true); } finally { if (direct) await close(direct); if (none) await close(none); await rm(directRoot, { recursive: true, force: true }); await rm(noneRoot, { recursive: true, force: true }); }
}
async function scenario14() {
  const root = await repo(); let value; const denySession = `deny-${Date.now()}`;
  try {
    const unprepared = { image: "ubuntu:24.04", network: { mode: "deny", allowDns: false }, bootstrapTools: "auto" };
    value = integration(root, denySession, "git", unprepared, []);
    const state = await value.configureSession({ sessionId: denySession, cwd: root, projectTrusted: true, config: { config: config(root, "git", unprepared), provenance: {}, warnings: [] } });
    assert.equal(state.status, "unavailable", "deny mode should not silently widen networking to bootstrap");

    for (const image of PREPARED_IMAGES) {
      const preparedSession = `prepared-${Date.now()}`;
      const preparedConfig = { image, pullPolicy: "always", bootstrapTools: false, network: { mode: "deny", allowDns: false } };
      const prepared = await boot(root, "git", preparedConfig, [], preparedSession);
      try {
        const command = await guest(prepared, "sh", ["-lc", "printf pi-msb-prepared"], { timeoutMs: 30_000 });
        assert.equal(command.exitCode, 0, `${image} command probe failed: ${command.stderr.toString()}`);
        assert.equal(command.stdout.toString(), "pi-msb-prepared", `${image} command probe returned unexpected output`);
        assert.equal(prepared.state.info?.docker.readiness, "ready", `${image} Docker was not ready before activation`);
        assert.equal(prepared.state.info?.docker.storageDriver, "vfs", `${image} did not use the vfs driver`);
        assert.match((await guest(prepared, "docker", ["buildx", "version"])).stdout.toString(), /v0\.37\.1/, `${image} Buildx version mismatch`);
        assert.match((await guest(prepared, "docker", ["compose", "version"])).stdout.toString(), /v5\.5\.1/, `${image} Compose version mismatch`);
      } finally {
        await close(prepared, volumeNameFor(preparedSession));
      }
    }
  } finally {
    if (value) { try { await value.manager.shutdown(); } finally { await removeVolumeIfPresent(value, volumeNameFor(denySession)); } }
    await rm(root, { recursive: true, force: true });
  }
}
async function scenario15() {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-live-concurrent-")); let value;
  try {
    await writeFile(join(root, "grep.txt"), "needle one\\nsecond line\\n");
    await writeFile(join(root, ".hidden.txt"), "hidden\\n");
    await fs.mkdir(join(root, "subdir")); await writeFile(join(root, "subdir", "listed.txt"), "listed\\n");
    value = await boot(root, "direct");
    const outputs = await runtimeCall(value, async (runtime) => Promise.all([runtime.transport.exec("printf", ["one"]), runtime.transport.exec("printf", ["two"])]));
    assert.deepEqual(outputs.map((x) => x.stdout.toString()).sort(), ["one", "two"]);
    const quoted = await guest(value, "sh", ["-lc", "printf '%s\\n' \"$1\"", "sh", "first second"]);
    assert.equal(quoted.stdout.toString(), "first second\n");
    const controller = new AbortController();
    const aborted = runtimeCall(value, (runtime) => runtime.transport.execStream("sleep", ["30"], { signal: controller.signal }));
    await sleep(200); controller.abort(); await assert.rejects(aborted, /abort/i);
    await assert.rejects(() => guest(value, "sleep", ["30"], { timeoutMs: 1 }), (error) => error?.code === "TIMEOUT");
    const found = await runtimeCall(value, (runtime) => runtime.operations.find.glob("*.txt", root, { ignore: [], limit: 10 }));
    assert.ok(found.some((path) => path.endsWith("grep.txt")), "find did not return the matching file");
    const listed = await runtimeCall(value, (runtime) => runtime.operations.ls.readdir(root));
    assert.ok(listed.includes(".hidden.txt"), "ls did not include dotfiles");
    assert.ok(listed.includes("subdir"), "ls did not return the directory");
    assert.equal((await runtimeCall(value, (runtime) => runtime.operations.ls.stat(join(root, "subdir")))).isDirectory(), true, "ls directory stat mismatch");
    const grep = createSandboxGrepExecute({ provider: value.provider, cwd: root, helpers: { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, truncateLine, formatSize } });
    const grepResult = await grep("live-grep", { pattern: "needle", path: root, limit: 10 });
    assert.match(JSON.stringify(grepResult), /grep\.txt.*needle/s, "grep did not return Pi-compatible match output");
  } finally { if (value) await close(value); await rm(root, { recursive: true, force: true }); }
}
async function scenario16() {
  const root = await repo(); const destination = await mkdtemp(join(tmpdir(), "pi-msb-live-export-")); let value; let volume; let command; let commandControl; let removed = false;
  try {
    value = await boot(root); volume = await activeVolume(value);
    const committed = await guest(value, "sh", ["-lc", "printf export > export.txt && git add export.txt && git -c user.name='pi-msb live' -c user.email=pi-msb-live@example.invalid -c commit.gpgSign=false commit -qm export && printf dirty > dirty.txt"], root);
    assert.equal(committed.exitCode, 0, committed.stderr.toString());
    const result = await value.control.exportPaths(["export.txt"], destination);
    assert.equal(result.length, 1); assert.equal(await readFile(join(destination, "export.txt"), "utf8"), "export");
    await assert.rejects(() => value.control.exportPaths(["../outside"], destination), /outside/);
    await value.manager.shutdown();
    const sdkVolume = await (await import("microsandbox")).Volume.get(volume.name);
    const labels = Object.fromEntries(sdkVolume.labels);
    const described = { volume: { name: volume.name, hostPath: volume.path, labels }, branch: check(await sh("git", ["-C", volume.path, "branch", "--show-current"]), "volume branch").stdout.trim(), lastCommit: check(await sh("git", ["-C", volume.path, "rev-parse", "HEAD"]), "volume commit").stdout.trim(), dirtyCount: check(await sh("git", ["-C", volume.path, "status", "--porcelain"]), "volume dirty status").stdout.trim().split("\n").filter(Boolean).length, mounted: false };
    assert.ok(described.dirtyCount > 0, "volume removal confirmation needs dirty metadata");
    commandControl = { ...value.control, describeVolume: async (name) => { assert.equal(name, volume.name); return described; } };
    command = createCommandHandler(commandControl);
    const notifications = [];
    const ctx = { hasUI: true, waitForIdle: async () => {}, ui: { confirm: async (title, message) => { assert.equal(title, "Remove retained volume?"); assert.match(message, new RegExp(volume.name)); assert.match(message, /dirty=1/); return true; }, notify: (message, type) => notifications.push({ message, type }) } };
    await command(`volumes rm ${volume.name}`, ctx);
    assert.ok(notifications.some((entry) => entry.message.includes(`Removed volume ${volume.name}`)), "command did not report removal");
    assert.equal(await (await import("microsandbox")).Volume.get(volume.name).then(() => true, () => false), false, "confirmed command did not remove volume");
    removed = true;
  } finally {
    if (value) { try { await value.manager.shutdown(); } catch {} }
    if (value && !removed && command) { try { await command(`volumes rm ${volume?.name} --yes`, { hasUI: false, waitForIdle: async () => {}, ui: { notify() {} } }); } catch {} }
    await rm(root, { recursive: true, force: true }); await rm(destination, { recursive: true, force: true });
  }
}

async function scenario17() {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-live-docker-")); let value;
  const port = 30000 + (process.pid % 10000);
  try {
    await writeFile(join(root, "Dockerfile"), "FROM alpine:3.22\nRUN wget -qO /network-ok https://example.com\n");
    await writeFile(join(root, "compose.yml"), 'services:\n  smoke:\n    image: alpine:3.22\n    command: ["wget", "-qO-", "https://example.com"]\n');
    value = await boot(root, "direct", {
      docker: { mode: "require", startupTimeoutMs: 30000 },
      network: { mode: "default", allowDns: true, publishPorts: [`127.0.0.1:${port}:${port}`] },
    });
    assert.equal(value.state.info?.docker.readiness, "ready");
    assert.equal(value.state.info?.docker.storageDriver, "vfs");
    const daemonPid = (await guest(value, "cat", ["/run/docker.pid"])).stdout.toString().trim();
    assert.equal((await guest(value, "rm", ["-f", "/run/pi-msb-docker-socket.owner"])).exitCode, 0);
    const hostileEndpoint = await guest(value, "env", ["DOCKER_HOST=tcp://127.0.0.1:9", "DOCKER_CONTEXT=hostile-context", "pi-msb-docker-start", "30000"], { timeoutMs: 32_000 });
    assert.equal(hostileEndpoint.exitCode, 0, "Docker startup honored a hostile client endpoint");
    assert.equal((await guest(value, "cat", ["/run/docker.pid"])).stdout.toString().trim(), daemonPid, "Docker startup did not adopt its exact managed daemon");
    assert.equal((await guest(value, "test", ["-s", "/run/pi-msb-docker-socket.owner"])).exitCode, 0, "Docker startup did not republish socket ownership");
    assert.equal((await guest(value, "docker", ["run", "--rm", "alpine:3.22", "uname", "-s"], { timeoutMs: 120_000 })).stdout.toString().trim(), "Linux");
    const https = await guest(value, "docker", ["run", "--rm", "alpine:3.22", "wget", "-qO-", "https://example.com"], { timeoutMs: 60_000 });
    assert.equal(https.exitCode, 0, https.stderr.toString());
    assert.equal((await guest(value, "docker", ["network", "create", "pi-msb-live-net"])).exitCode, 0);
    assert.equal((await guest(value, "docker", ["run", "-d", "--name", "pi-msb-peer", "--network", "pi-msb-live-net", "alpine:3.22", "sleep", "120"])).exitCode, 0);
    const dns = await guest(value, "docker", ["run", "--rm", "--network", "pi-msb-live-net", "alpine:3.22", "getent", "hosts", "pi-msb-peer"]);
    assert.equal(dns.exitCode, 0, dns.stderr.toString());
    const build = await guest(value, "docker", ["buildx", "build", "--load", "-t", "pi-msb-live-build", "."], { cwd: root, timeoutMs: 180_000 });
    assert.equal(build.exitCode, 0, build.stderr.toString());
    assert.equal((await guest(value, "docker", ["run", "--rm", "pi-msb-live-build", "test", "-s", "/network-ok"])).exitCode, 0);
    const compose = await guest(value, "docker", ["compose", "-f", join(root, "compose.yml"), "up", "--abort-on-container-exit", "--exit-code-from", "smoke"], { cwd: root, timeoutMs: 120_000 });
    assert.equal(compose.exitCode, 0, compose.stderr.toString());
    const ported = await guest(value, "docker", ["run", "-d", "--name", "pi-msb-ported", "-p", `0.0.0.0:${port}:8080`, "-p", `0.0.0.0:${port + 1}:8080`, "alpine:3.22", "sh", "-c", "while true; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 6\\r\\n\\r\\nnested' | nc -l -p 8080; done"]);
    assert.equal(ported.exitCode, 0, ported.stderr.toString());
    assert.equal((await guest(value, "docker", ["inspect", "-f", "{{.State.Running}}", "pi-msb-ported"])).stdout.toString().trim(), "true", "published-port container exited");
    let body = "";
    for (let attempt = 0; attempt < 30 && body !== "nested"; attempt++) {
      try { body = await (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) })).text(); } catch {}
      if (body !== "nested") await sleep(200);
    }
    assert.equal(body, "nested", "double-published Docker port was not reachable from the host");
    await assert.rejects(
      fetch(`http://127.0.0.1:${port + 1}`, { signal: AbortSignal.timeout(1000) }),
      undefined,
      "a Docker-only port mapping unexpectedly reached the host",
    );
    assert.equal((await guest(value, "test", ["!", "-e", join(root, "var", "lib", "docker")])).exitCode, 0, "Docker data leaked into the project mount");
    assert.equal((await guest(value, "test", ["!", "-e", "/root/.docker/config.json"])).exitCode, 0, "host Docker credentials appeared in the guest");
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
async function scenario18() {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-live-docker-policy-")); let enabled; let denied; let allowed;
  try {
    const docker = { mode: "require", startupTimeoutMs: 30000 };
    enabled = await boot(root, "direct", { docker });
    assert.equal((await guest(enabled, "docker", ["pull", "alpine:3.22"], { timeoutMs: 120_000 })).exitCode, 0);
    assert.equal((await guest(enabled, "docker", ["save", "-o", join(root, "alpine.tar"), "alpine:3.22"], { timeoutMs: 120_000 })).exitCode, 0);
    await close(enabled); enabled = undefined;

    denied = await boot(root, "direct", { docker, network: { mode: "deny", allowDns: false, publishPorts: [] } });
    assert.equal((await guest(denied, "docker", ["load", "-i", join(root, "alpine.tar")], { timeoutMs: 120_000 })).exitCode, 0);
    const deniedEgress = await guest(denied, "docker", ["run", "--rm", "alpine:3.22", "wget", "-T", "5", "-qO-", "https://example.com"], { timeoutMs: 30_000 });
    assert.notEqual(deniedEgress.exitCode, 0, "nested container bypassed deny mode");
    const oldPid = (await guest(denied, "cat", ["/run/docker.pid"])).stdout.toString().trim();
    assert.match(oldPid, /^[0-9]+$/);
    const stopped = await guest(denied, "sh", ["-c", 'kill "$1"; for i in $(seq 1 100); do if ! kill -0 "$1" 2>/dev/null && test ! -S /var/run/docker.sock; then exit 0; fi; sleep .1; done; exit 1', "sh", oldPid]);
    assert.equal(stopped.exitCode, 0, "the original Docker daemon did not stop");
    const concurrentStarts = await Promise.all(Array.from({ length: 4 }, () => guest(denied, "pi-msb-docker-start", ["30000"], { timeoutMs: 32_000 })));
    assert.ok(concurrentStarts.every((result) => result.exitCode === 0), "concurrent Docker startup was not serialized");
    const newPid = (await guest(denied, "cat", ["/run/docker.pid"])).stdout.toString().trim();
    assert.match(newPid, /^[0-9]+$/);
    assert.notEqual(newPid, oldPid, "Docker startup reused the old daemon process");
    assert.equal((await guest(denied, "kill", ["-0", newPid])).exitCode, 0, "replacement Docker daemon is not live");
    const deniedAfterRestart = await guest(denied, "docker", ["run", "--rm", "alpine:3.22", "wget", "-T", "5", "-qO-", "https://example.com"], { timeoutMs: 30_000 });
    assert.notEqual(deniedAfterRestart.exitCode, 0, "Docker restart widened deny mode");

    const pendingStopped = await guest(denied, "sh", ["-c", 'kill "$1"; for i in $(seq 1 100); do if ! kill -0 "$1" 2>/dev/null && test ! -S /var/run/docker.sock; then exit 0; fi; sleep .1; done; exit 1', "sh", newPid]);
    assert.equal(pendingStopped.exitCode, 0, "the replacement Docker daemon did not stop");
    assert.equal((await guest(denied, "rm", ["-f", "/run/pi-msb-docker-socket.owner"])).exitCode, 0);
    assert.equal((await guest(denied, "test", ["-d", "/run/docker"])).exitCode, 0, "expected stale Docker exec-root state");
    const pendingRecovery = await guest(denied, "pi-msb-docker-start", ["30000"], { timeoutMs: 32_000 });
    assert.equal(pendingRecovery.exitCode, 0, "a failed same-boot pending launch poisoned Docker startup");
    const recoveredPid = (await guest(denied, "cat", ["/run/docker.pid"])).stdout.toString().trim();
    assert.match(recoveredPid, /^[0-9]+$/);
    assert.notEqual(recoveredPid, newPid, "pending launch recovery reused the exited daemon process");
    const deniedAfterPendingRecovery = await guest(denied, "docker", ["run", "--rm", "alpine:3.22", "wget", "-T", "5", "-qO-", "https://example.com"], { timeoutMs: 30_000 });
    assert.notEqual(deniedAfterPendingRecovery.exitCode, 0, "pending launch recovery widened deny mode");
    await close(denied); denied = undefined;

    allowed = await boot(root, "direct", { docker, network: { mode: "allowlist", allowHosts: ["example.com"], allowDns: true, publishPorts: [] } });
    assert.equal((await guest(allowed, "docker", ["load", "-i", join(root, "alpine.tar")], { timeoutMs: 120_000 })).exitCode, 0);
    const allowedEgress = await guest(allowed, "docker", ["run", "--rm", "alpine:3.22", "wget", "-T", "10", "-qO-", "https://example.com"], { timeoutMs: 30_000 });
    assert.equal(allowedEgress.exitCode, 0, allowedEgress.stderr.toString());
    const blockedEgress = await guest(allowed, "docker", ["run", "--rm", "alpine:3.22", "wget", "-T", "5", "-qO-", "https://example.org"], { timeoutMs: 30_000 });
    assert.notEqual(blockedEgress.exitCode, 0, "nested container bypassed the allowlist");
  } finally {
    if (enabled) await close(enabled);
    if (denied) await close(denied);
    if (allowed) await close(allowed);
    await rm(root, { recursive: true, force: true });
  }
}

const scenarios = [scenario1, scenario2, scenario3, scenario4, scenario5, scenario6, scenario7, scenario8, scenario9, scenario10, scenario11, scenario12, scenario13, scenario14, scenario15, scenario16, scenario17, scenario18];
async function probe() {
  const name = `pi-msb-live-probe-${process.pid}-${Date.now()}`; let sandbox;
  try { sandbox = await Sandbox.builder(name).image(IMAGE).cpus(1).memory(512).idleTimeout(30).create(); const result = await sandbox.exec("true", []); if (result.code !== 0) throw new Error(`probe command exited ${result.code}`); console.log("PROBE|PASS|virtualization and image are available"); }
  catch (error) { const text = error instanceof Error ? error.message : String(error); if (/kvm|hypervisor|virtualiz|libkrun|whp|wsl|permission.*device|unsupported platform/i.test(text)) { console.log(`PROBE|SKIP|virtualization unavailable: ${text}`); process.exitCode = 2; } else { console.log(`PROBE|FAIL|${text}`); process.exitCode = 1; } }
  finally { if (sandbox) { try { await sandbox.stopWithTimeout(10000); } catch {} try { await (await Sandbox.get(name)).remove(); } catch {} } }
}

if (process.argv[2] === "--probe") await probe();
else if (process.argv[2] === "--hold") await holdOwner(process.argv[3], process.argv[4], process.argv[5]);
else {
  for (let i = 0; i < scenarios.length; i++) {
    try { await scenarios[i](); console.log(`RESULT|${i}|PASS|live assertion completed`); }
    catch (error) { const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim(); console.log(`RESULT|${i}|FAIL|${reason}`); }
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
  report_all_skip "${reason:-virtualization unavailable}"
  exit 0
elif [ "$probe_code" -ne 0 ]; then
  reason=$(printf '%s\n' "$probe_output" | awk -F'|' '/^PROBE\|FAIL\|/ {print $3; exit}')
  printf 'FAIL  09  %s (%s)\n' "${SCENARIOS[8]}" "${reason:-live probe failed}"
  for i in "${!SCENARIOS[@]}"; do
    [ "$i" -eq 8 ] && continue
    printf 'SKIP  %02d  %s (live probe failed before this scenario)\n' "$((i + 1))" "${SCENARIOS[$i]}"
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
