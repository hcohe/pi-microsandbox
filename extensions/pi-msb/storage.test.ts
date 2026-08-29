import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createSeedBundle, detectGitRepo } from "./git.ts";
import { buildStoragePlan, seedGitVolume, validateReusableVolume } from "./storage.ts";
import { LABEL_KEYS, STATE_SCHEMA_VERSION } from "./types.ts";
import type {
  Config,
  GitRepoInfo,
  GitSeedBundle,
  GitVolumePlan,
  SandboxTransport,
  StatResult,
  TransportExecResult,
  VolumeRecord,
} from "./types.ts";

const repo = (overrides: Partial<GitRepoInfo> = {}): GitRepoInfo => ({
  isGitRepo: true,
  repoRoot: "/work/project",
  branch: "main",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  unborn: false,
  isLinkedWorktree: false,
  ...overrides,
});

const config = (mode: Config["mode"]): Config => ({
  image: "ubuntu:24.04",
  bootstrapTools: "auto",
  cpus: 1,
  memoryMiB: 512,
  idleTimeoutSec: 600,
  stopTimeoutMs: 10_000,
  detached: true,
  replace: false,
  replaceTimeoutMs: 10_000,
  sandboxName: null,
  mode,
  cloneBranch: "current",
  cloneDepth: "unlimited",
  shallowArchive: false,
  volumeQuotaMiB: 1024,
  network: { mode: "default", allowHosts: [], allowDns: true, publishPorts: [] },
  secrets: [],
  mounts: [],
  blockThirdParty: true,
  routeTools: [],
  passThroughTools: [],
  allowHostExecution: false,
  allowSkillReads: true,
  fallbackMode: "block",
  exposeSessionEnvironment: false,
  hostEnv: [],
  autoStart: true,
  pruneOnStart: true,
  lockDir: "/tmp/pi-msb-locks",
  hostRoAllowlist: [],
});

function makeVolume(plan: GitVolumePlan, labels: Partial<Record<string, string>> = {}): VolumeRecord {
  return {
    name: plan.volumeName,
    hostPath: "/var/lib/pi-msb/volume",
    labels: {
      [LABEL_KEYS.managed]: "true",
      [LABEL_KEYS.schema]: String(STATE_SCHEMA_VERSION),
      [LABEL_KEYS.session]: plan.sessionId,
      [LABEL_KEYS.mode]: "git",
      [LABEL_KEYS.cwd]: plan.workdir,
      [LABEL_KEYS.keep]: "true",
      ...labels,
    },
  };
}

test("storage modes preserve absolute paths and treat auto as direct", () => {
  const direct = buildStoragePlan({
    cwd: "/work/plain",
    sessionId: "session-direct",
    config: config("direct"),
    git: repo({ isGitRepo: false, repoRoot: null, branch: null, headSha: null, unborn: false }),
  });
  assert.deepEqual(direct, {
    kind: "direct-mount",
    hostPath: "/work/plain",
    guestPath: "/work/plain",
    workdir: "/work/plain",
  });

  const none = buildStoragePlan({
    cwd: "/work/empty",
    sessionId: "session-none",
    config: config("none"),
    git: repo({ isGitRepo: false, repoRoot: null, branch: null, headSha: null, unborn: false }),
  });
  assert.deepEqual(none, { kind: "none", guestPath: "/work/empty", workdir: "/work/empty" });

  const automatic = buildStoragePlan({
    cwd: "/work/project/packages/app",
    sessionId: "session-auto",
    config: config("auto"),
    git: repo(),
  });
  assert.deepEqual(automatic, {
    kind: "direct-mount",
    hostPath: "/work/project/packages/app",
    guestPath: "/work/project/packages/app",
    workdir: "/work/project/packages/app",
  });

  assert.throws(
    () =>
      buildStoragePlan({
        cwd: "/work/plain",
        sessionId: "session-git",
        config: config("git"),
        git: repo({ isGitRepo: false, repoRoot: null }),
      }),
    /requires a Git repository/,
  );
});

test("host sources are canonical while guest storage stays in the lexical namespace", () => {
  const direct = buildStoragePlan({
    cwd: "/var/work/plain",
    sessionId: "session-lexical-direct",
    config: config("direct"),
    git: repo({ isGitRepo: false, hostCwd: "/private/var/work/plain", repoRoot: null }),
  });
  assert.deepEqual(direct, {
    kind: "direct-mount",
    hostPath: "/private/var/work/plain",
    guestPath: "/var/work/plain",
    workdir: "/var/work/plain",
  });

  const plan = buildStoragePlan({
    cwd: "/var/work/project/packages/app",
    sessionId: "session-lexical-git",
    config: config("git"),
    git: repo({ repoRoot: "/private/var/work/project", guestRepoRoot: "/var/work/project" }),
  });
  assert.equal(plan.kind, "git-volume");
  if (plan.kind !== "git-volume") return;
  assert.equal(plan.repoRoot, "/private/var/work/project");
  assert.equal(plan.mountGuestPath, "/var/work/project");
  assert.equal(plan.workdir, "/var/work/project/packages/app");

  assert.throws(
    () => buildStoragePlan({
      cwd: "/alias-into-subdirectory",
      sessionId: "session-unrepresentable-git",
      config: config("git"),
      git: repo({ guestRepoRoot: null }),
    }),
    /cannot preserve the requested cwd namespace/,
  );
});

test("a matching persisted state marks a git volume as retained", () => {
  const input = {
    cwd: "/work/project/subdir",
    sessionId: "session-retained",
    config: config("git"),
    git: repo(),
  };
  const first = buildStoragePlan(input);
  assert.equal(first.kind, "git-volume");
  if (first.kind !== "git-volume") return;

  const restored = buildStoragePlan({
    ...input,
    restored: {
      version: STATE_SCHEMA_VERSION,
      sessionId: input.sessionId,
      sandboxName: "pi-msb-sandbox",
      mode: "git",
      cwd: input.cwd,
      image: input.config.image,
      volumeName: first.volumeName,
      enabled: false,
      createdAt: Date.now(),
    },
  });
  assert.equal(restored.kind, "git-volume");
  if (restored.kind === "git-volume") assert.equal(restored.seedRequired, false);

  const forked = buildStoragePlan({
    ...input,
    restored: {
      version: STATE_SCHEMA_VERSION,
      sessionId: "another-session",
      sandboxName: "pi-msb-sandbox",
      mode: "git",
      cwd: input.cwd,
      image: input.config.image,
      volumeName: first.volumeName,
      enabled: true,
      createdAt: Date.now(),
    },
  });
  assert.equal(forked.kind, "git-volume");
  if (forked.kind === "git-volume") assert.equal(forked.seedRequired, true);
});

test("volume reuse requires the complete managed identity", () => {
  const plan = buildStoragePlan({
    cwd: "/work/project",
    sessionId: "session-volume",
    config: config("git"),
    git: repo(),
  });
  assert.equal(plan.kind, "git-volume");
  if (plan.kind !== "git-volume") return;

  assert.equal(validateReusableVolume(plan, makeVolume(plan)), true);
  const missingMode = makeVolume(plan);
  delete missingMode.labels[LABEL_KEYS.mode];
  assert.equal(validateReusableVolume(plan, missingMode), false, "missing mode label");
  for (const [label, value] of [
    [LABEL_KEYS.managed, "false"],
    [LABEL_KEYS.schema, "999"],
    [LABEL_KEYS.session, "wrong-session"],
    [LABEL_KEYS.cwd, "/work/other"],
    [LABEL_KEYS.keep, "false"],
    [LABEL_KEYS.mode, "direct"],
  ] as const) {
    assert.equal(validateReusableVolume(plan, makeVolume(plan, { [label]: value })), false, label);
  }
  assert.equal(
    validateReusableVolume(plan, { ...makeVolume(plan), name: "pi-msb-vol-unrelated" }),
    false,
  );
});

type ExecCall = { command: string; args: string[]; cwd?: string };

class FakeTransport implements SandboxTransport {
  readonly copied: Array<{ hostPath: string; guestPath: string }> = [];
  readonly calls: ExecCall[] = [];
  removedGuestBundle = false;
  failFetch = false;
  detached = false;
  unborn = false;
  branch = "main";
  reportedHeadSha = "0123456789abcdef0123456789abcdef01234567";

  async readFile(_path: string): Promise<Buffer> { return Buffer.alloc(0); }
  async writeFile(_path: string, _data: string | Buffer): Promise<void> {}
  async exists(_path: string): Promise<boolean> { return true; }
  async stat(_path: string): Promise<StatResult> {
    return { kind: "directory", size: 0, mode: 0o755, readonly: false, modifiedAt: null };
  }
  async list(_path: string): Promise<never[]> { return []; }
  async copyFromHost(hostPath: string, guestPath: string): Promise<void> {
    this.copied.push({ hostPath, guestPath });
  }
  async copyToHost(_guestPath: string, _hostPath: string): Promise<void> {}
  async exec(command: string, args: string[], options?: { cwd?: string }): Promise<TransportExecResult> {
    this.calls.push({ command, args, cwd: options?.cwd });
    if (command === "git" && args[0] === "fetch" && this.failFetch) {
      return { stdout: Buffer.alloc(0), stderr: Buffer.from("fetch failed"), exitCode: 128 };
    }
    if (command === "git" && args[0] === "rev-parse") {
      return {
        stdout: Buffer.from(this.unborn ? "" : `${this.reportedHeadSha}\n`),
        stderr: Buffer.from(this.unborn ? "unknown revision HEAD" : ""),
        exitCode: this.unborn ? 128 : 0,
      };
    }
    if (command === "git" && args[0] === "symbolic-ref") {
      if (this.detached) {
        return { stdout: Buffer.alloc(0), stderr: Buffer.from("not on a branch"), exitCode: 1 };
      }
      return { stdout: Buffer.from(`${this.branch}\n`), stderr: Buffer.alloc(0), exitCode: 0 };
    }
    if (command === "rm") this.removedGuestBundle = true;
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
  }
  async execStream(): Promise<{ exitCode: number }> { return { exitCode: 0 }; }
  async dispose(): Promise<void> {}
}

function seedPlan(overrides: Partial<GitVolumePlan> = {}): GitVolumePlan {
  return {
    kind: "git-volume",
    sessionId: "session-seed",
    volumeName: "pi-msb-vol-seed",
    volumeQuotaMiB: 1024,
    repoRoot: "/work/project",
    mountGuestPath: "/work/project",
    workdir: "/work/project/subdir",
    branch: "main",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    unborn: false,
    depth: "unlimited",
    seedRequired: true,
    ...overrides,
  };
}

function bundle(
  overrides: Partial<Omit<GitSeedBundle, "cleanup">> = {},
): GitSeedBundle & { cleaned: boolean } {
  const value = {
    hostPath: "/tmp/seed.bundle",
    branch: "main",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    cleaned: false,
    async cleanup() { value.cleaned = true; },
    ...overrides,
  };
  return value;
}

test("seed copies an unpredictable bundle, verifies exact branch/HEAD, and cleans up", async () => {
  const transport = new FakeTransport();
  const source = bundle();
  const result = await seedGitVolume(transport, seedPlan(), source);

  assert.equal(result.headSha, "0123456789abcdef0123456789abcdef01234567");
  assert.deepEqual(transport.copied[0], { hostPath: source.hostPath, guestPath: transport.copied[0].guestPath });
  assert.match(transport.copied[0].guestPath, /^\/tmp\/pi-msb-seed-[0-9a-f-]+\.bundle$/);
  assert.ok(transport.calls.some((call) => call.args.join(" ") === "init /work/project"));
  assert.ok(
    transport.calls.some(
      (call) =>
        call.args[0] === "fetch" &&
        call.args[1] === "--no-tags" &&
        call.args[2] === transport.copied[0].guestPath &&
        call.args[3] === "refs/pi-msb/seed",
    ),
  );
  assert.ok(transport.calls.some((call) => call.args[0] === "checkout" && call.args.includes("-B")));
  assert.equal(transport.calls.some((call) => call.args[0] === "remote"), false);
  assert.equal(transport.removedGuestBundle, true);
  assert.equal(source.cleaned, true);
});

test("detached and unborn seeds use their respective git initialization paths", async () => {
  const detachedTransport = new FakeTransport();
  detachedTransport.detached = true;
  const detachedSource = bundle({ branch: null });
  const detached = await seedGitVolume(
    detachedTransport,
    seedPlan({ branch: null }),
    detachedSource,
  );
  assert.equal(detached.headSha, "0123456789abcdef0123456789abcdef01234567");
  assert.ok(detachedTransport.calls.some((call) => call.args.join(" ") === "checkout --detach 0123456789abcdef0123456789abcdef01234567"));

  const unbornTransport = new FakeTransport();
  unbornTransport.unborn = true;
  unbornTransport.branch = "feature/new";
  const unborn = await seedGitVolume(
    unbornTransport,
    seedPlan({ branch: "feature/new", headSha: null, unborn: true }),
    null,
  );
  assert.equal(unborn.headSha, null);
  assert.ok(unbornTransport.calls.some((call) => call.args.join(" ") === "init -b feature/new /work/project"));
});

test("rejects an exact guest HEAD mismatch and still cleans up", async () => {
  const transport = new FakeTransport();
  transport.reportedHeadSha = "fedcba9876543210fedcba9876543210fedcba98";
  const source = bundle();
  await assert.rejects(seedGitVolume(transport, seedPlan(), source), /seed HEAD mismatch/);
  assert.equal(transport.removedGuestBundle, true);
  assert.equal(source.cleaned, true);
});

test("failed seeding still removes the guest bundle and cleans the host bundle", async () => {
  const transport = new FakeTransport();
  transport.failFetch = true;
  const source = bundle();
  await assert.rejects(seedGitVolume(transport, seedPlan(), source), /fetch failed/);
  assert.equal(transport.removedGuestBundle, true);
  assert.equal(source.cleaned, true);
});

const execFileAsync = promisify(execFile);

async function localGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return String(result.stdout);
}

class LocalGitTransport implements SandboxTransport {
  async readFile(path: string): Promise<Buffer> { return readFile(path); }
  async writeFile(path: string, data: string | Buffer): Promise<void> { await writeFile(path, data); }
  async exists(path: string): Promise<boolean> {
    try {
      await readFile(path);
      return true;
    } catch {
      return false;
    }
  }
  async stat(_path: string): Promise<StatResult> {
    return { kind: "directory", size: 0, mode: 0o755, readonly: false, modifiedAt: null };
  }
  async list(_path: string): Promise<never[]> { return []; }
  async copyFromHost(hostPath: string, guestPath: string): Promise<void> {
    await copyFile(hostPath, guestPath);
  }
  async copyToHost(guestPath: string, hostPath: string): Promise<void> {
    await copyFile(guestPath, hostPath);
  }
  async exec(command: string, args: string[], options?: { cwd?: string }): Promise<TransportExecResult> {
    try {
      const result = await execFileAsync(command, args, { cwd: options?.cwd });
      return {
        stdout: Buffer.from(result.stdout),
        stderr: Buffer.from(result.stderr),
        exitCode: 0,
      };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string | Buffer; stderr?: string | Buffer };
      return {
        stdout: Buffer.from(failure.stdout ?? ""),
        stderr: Buffer.from(failure.stderr ?? ""),
        exitCode: typeof failure.code === "number" ? failure.code : 127,
      };
    }
  }
  async execStream(): Promise<{ exitCode: number }> { return { exitCode: 0 }; }
  async dispose(): Promise<void> {}
}

test("seeds a local-only repository from the bundle's custom ref", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-storage-git-"));
  const sourceRepo = join(root, "source");
  const sandboxRepo = join(root, "sandbox");
  let sourceBundle: GitSeedBundle | null = null;

  try {
    await mkdir(sourceRepo);
    await mkdir(sandboxRepo);
    await localGit(sourceRepo, ["init", "-q", "-b", "main"]);
    await localGit(sourceRepo, ["config", "user.email", "pi-msb@example.invalid"]);
    await localGit(sourceRepo, ["config", "user.name", "pi-msb test"]);
    await localGit(sourceRepo, ["config", "commit.gpgSign", "false"]);
    await writeFile(join(sourceRepo, "committed.txt"), "local-only\n");
    await localGit(sourceRepo, ["add", "--", "committed.txt"]);
    await localGit(sourceRepo, ["commit", "-q", "-m", "local seed"]);
    assert.equal((await localGit(sourceRepo, ["remote"])).trim(), "");

    const info = await detectGitRepo(sourceRepo);
    sourceBundle = await createSeedBundle(info, { branch: "current", depth: "unlimited" });
    assert.ok(sourceBundle);

    const result = await seedGitVolume(
      new LocalGitTransport(),
      seedPlan({
        repoRoot: sourceRepo,
        mountGuestPath: sandboxRepo,
        workdir: sandboxRepo,
        branch: info.branch,
        headSha: info.headSha,
      }),
      sourceBundle,
    );

    assert.equal(result.headSha, info.headSha);
    assert.equal((await localGit(sandboxRepo, ["rev-parse", "HEAD"])).trim(), info.headSha);
    assert.equal(await readFile(join(sandboxRepo, "committed.txt"), "utf8"), "local-only\n");
    assert.equal((await localGit(sandboxRepo, ["remote"])).trim(), "");
  } finally {
    await sourceBundle?.cleanup().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
