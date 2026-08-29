import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  LABEL_KEYS,
  STATE_SCHEMA_VERSION,
  volumeNameFor,
} from "./types.ts";
import type {
  Config,
  GitRepoInfo,
  GitSeedBundle,
  GitVolumePlan,
  PersistedSandboxState,
  SandboxTransport,
  StoragePlan,
  VolumeRecord,
} from "./types.ts";

const BUNDLE_SEED_REF = "refs/pi-msb/seed";

/**
 * Build the path-preserving storage description used by the sandbox builder.
 * The guest path is deliberately the same absolute path as the host path; in
 * in particular, a git volume is mounted at the repository root rather than at
 * a synthetic guest-only source path.
 */
export function buildStoragePlan(input: {
  cwd: string;
  sessionId: string;
  config: Config;
  git: GitRepoInfo;
  restored?: PersistedSandboxState | null;
}): StoragePlan {
  assertAbsolute(input.cwd, "cwd");

  const selectedMode = selectMode(input.config.mode);
  if (selectedMode === "direct") {
    return {
      kind: "direct-mount",
      hostPath: input.git.hostCwd ?? input.cwd,
      guestPath: input.cwd,
      workdir: input.cwd,
    };
  }

  if (selectedMode === "none") {
    return {
      kind: "none",
      guestPath: input.cwd,
      workdir: input.cwd,
    };
  }

  if (!input.git.isGitRepo || !input.git.repoRoot) {
    throw new Error("git storage requires a Git repository");
  }
  assertAbsolute(input.git.repoRoot, "git repository root");
  if (input.git.guestRepoRoot === null) {
    throw new Error("git storage cannot preserve the requested cwd namespace for this symlink topology");
  }
  const mountGuestPath = input.git.guestRepoRoot ?? input.git.repoRoot;
  assertAbsolute(mountGuestPath, "git guest repository root");

  const volumeName = volumeNameFor(input.sessionId);
  const restoredForThisPlan = isRestoredGitState(input.restored, {
    sessionId: input.sessionId,
    cwd: input.cwd,
    volumeName,
  });

  return {
    kind: "git-volume",
    sessionId: input.sessionId,
    volumeName,
    volumeQuotaMiB: input.config.volumeQuotaMiB,
    repoRoot: input.git.repoRoot,
    mountGuestPath,
    workdir: input.cwd,
    branch: input.git.branch,
    headSha: input.git.headSha,
    unborn: input.git.unborn,
    depth: input.config.cloneDepth,
    // A matching persisted entry means the manager is recovering a retained
    // volume. It must still validate the volume's labels before mounting it.
    seedRequired: !restoredForThisPlan,
  };
}

/**
 * Validate the identity labels before a named volume is mounted. A name alone
 * is not an ownership proof: names can collide after a copied/forked state
 * file or an operator-created resource.
 */
export function validateReusableVolume(plan: GitVolumePlan, volume: VolumeRecord): boolean {
  if (plan.kind !== "git-volume" || volume.name !== plan.volumeName) return false;

  const labels = volume.labels;
  if (!labels || typeof labels !== "object") return false;
  if (labels[LABEL_KEYS.managed] !== "true") return false;
  if (labels[LABEL_KEYS.schema] !== String(STATE_SCHEMA_VERSION)) return false;
  if (labels[LABEL_KEYS.session] !== plan.sessionId) return false;
  if (labels[LABEL_KEYS.cwd] !== plan.workdir) return false;
  if (labels[LABEL_KEYS.mode] !== "git") return false;
  if (labels[LABEL_KEYS.keep] !== "true") return false;

  // A retained volume is trusted only after its complete managed identity
  // matches the current git plan. The mode label is required even though the
  // shared VolumeLabelInput contract predates that label.
  return true;
}

/**
 * Seed a newly-created git volume. This function owns cleanup of both the
 * temporary guest copy and the host bundle. Callers must only invoke it for a
 * plan with seedRequired=true.
 */
export async function seedGitVolume(
  transport: SandboxTransport,
  plan: GitVolumePlan,
  bundle: GitSeedBundle | null,
): Promise<{ headSha: string | null }> {
  if (plan.kind !== "git-volume") {
    throw new Error("cannot seed non-git storage");
  }
  const guestBundlePath = `/tmp/pi-msb-seed-${randomUUID()}.bundle`;
  let operationError: unknown;
  let cleanupError: unknown;
  let headSha: string | null = null;

  try {
    if (!plan.unborn && (!bundle || !plan.headSha)) {
      throw new Error("a committed Git volume requires a seed bundle and HEAD SHA");
    }
    if (plan.unborn && bundle) {
      // An unborn repository has no committed object to bundle. Treating a
      // supplied bundle as authoritative would make the source state ambiguous.
      throw new Error("an unborn Git repository cannot be seeded from a bundle");
    }
    if (bundle && plan.headSha && bundle.headSha !== plan.headSha) {
      throw new Error(`seed bundle SHA mismatch: expected ${plan.headSha}, got ${bundle.headSha}`);
    }
    if (bundle && bundle.branch !== plan.branch) {
      throw new Error(
        `seed bundle branch mismatch: expected ${plan.branch ?? "detached"}, got ${bundle.branch ?? "detached"}`,
      );
    }

    if (bundle) {
      await copyBundle(transport, bundle.hostPath, guestBundlePath);

      // `git clone` only imports the bundle's branch refs. The seed is kept in
      // a private namespace, so initialize first and fetch that ref explicitly.
      // This also avoids configuring the temporary bundle as a remote.
      await runChecked(
        transport,
        "git",
        ["init", plan.mountGuestPath],
        plan.mountGuestPath,
      );
      await runChecked(
        transport,
        "git",
        ["fetch", "--no-tags", guestBundlePath, BUNDLE_SEED_REF],
        plan.mountGuestPath,
      );

      // Keep an immutable local ref for later diff/reference operations after
      // the temporary guest bundle is removed.
      await runChecked(
        transport,
        "git",
        ["update-ref", `refs/pi-msb/seed/${plan.headSha}`, plan.headSha!],
        plan.mountGuestPath,
      );

      if (plan.branch !== null) {
        await runChecked(
          transport,
          "git",
          ["checkout", "-B", plan.branch ?? "", plan.headSha!],
          plan.mountGuestPath,
        );
      } else {
        await runChecked(
          transport,
          "git",
          ["checkout", "--detach", plan.headSha!],
          plan.mountGuestPath,
        );
      }

      await verifySeed(transport, plan);
      headSha = plan.headSha;
    } else {
      const initArgs = plan.branch
        ? ["init", "-b", plan.branch, plan.mountGuestPath]
        : ["init", plan.mountGuestPath];
      await runChecked(transport, "git", initArgs, plan.mountGuestPath);
      await verifySeed(transport, plan);
      headSha = null;
    }
  } catch (error) {
    operationError = error;
  } finally {
    // Both bundle copies must be deleted. These cleanup operations are best
    // effort after an operation failure, but are still attempted independently
    // so a failed guest command cannot leak the host temporary bundle.
    try {
      await removeGuestBundle(transport, guestBundlePath);
    } catch (error) {
      cleanupError ??= error;
    }
    if (bundle) {
      try {
        await bundle.cleanup();
      } catch (error) {
        cleanupError ??= error;
      }
    }
  }

  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return { headSha };
}

function selectMode(mode: Config["mode"]): "git" | "direct" | "none" {
  // Keep `auto` as a compatibility alias for the direct default. It must not
  // implicitly switch to Git isolation based on the current directory.
  if (mode === "auto") return "direct";
  return mode;
}

function assertAbsolute(value: string, label: string): void {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
}

function isRestoredGitState(
  restored: PersistedSandboxState | null | undefined,
  expected: { sessionId: string; cwd: string; volumeName: string },
): boolean {
  return Boolean(
    restored &&
      restored.version === STATE_SCHEMA_VERSION &&
      restored.sessionId === expected.sessionId &&
      restored.mode === "git" &&
      restored.cwd === expected.cwd &&
      restored.volumeName === expected.volumeName,
  );
}

async function copyBundle(
  transport: SandboxTransport,
  hostPath: string,
  guestPath: string,
): Promise<void> {
  try {
    await transport.copyFromHost(hostPath, guestPath);
  } catch (error) {
    throw new Error(`copying Git seed bundle failed: ${errorMessage(error)}`, { cause: error });
  }
}

async function runChecked(
  transport: SandboxTransport,
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const result = await transport.exec(command, args, { cwd });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString("utf8").trim();
    const suffix = stderr ? `: ${stderr}` : "";
    throw new Error(`${command} ${args[0] ?? "command"} failed (exit ${result.exitCode})${suffix}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

async function verifySeed(transport: SandboxTransport, plan: GitVolumePlan): Promise<void> {
  const head = await transport.exec("git", ["rev-parse", "HEAD"], { cwd: plan.mountGuestPath });
  const actualHead = head.stdout.toString("utf8").trim();
  if (plan.unborn) {
    // An unborn repository has no object named HEAD yet. Git reports that
    // normal state with a nonzero rev-parse status.
    if (head.exitCode === 0) {
      throw new Error(`unborn Git seed unexpectedly has HEAD ${actualHead || "<empty>"}`);
    }
  } else {
    if (head.exitCode !== 0) {
      const stderr = head.stderr.toString("utf8").trim();
      throw new Error(`unable to read seed HEAD${stderr ? `: ${stderr}` : ""}`);
    }
    if (actualHead !== plan.headSha) {
      throw new Error(`seed HEAD mismatch: expected ${plan.headSha}, got ${actualHead || "<empty>"}`);
    }
  }

  const branch = await transport.exec(
    "git",
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { cwd: plan.mountGuestPath },
  );
  const actualBranch = branch.stdout.toString("utf8").trim();
  if (plan.branch !== null) {
    if (branch.exitCode !== 0 || actualBranch !== plan.branch) {
      const stderr = branch.stderr.toString("utf8").trim();
      throw new Error(
        `seed branch mismatch: expected ${plan.branch}, got ${actualBranch || "detached"}${stderr ? `: ${stderr}` : ""}`,
      );
    }
  } else if (branch.exitCode === 0) {
    throw new Error(`seed branch mismatch: expected detached HEAD, got ${actualBranch}`);
  }

  const status = await runChecked(transport, "git", ["status", "--porcelain"], plan.mountGuestPath);
  if (status.stdout.toString("utf8") !== "") {
    throw new Error(`seed repository is not clean: ${status.stdout.toString("utf8").trim()}`);
  }
}

async function removeGuestBundle(transport: SandboxTransport, guestPath: string): Promise<void> {
  const result = await transport.exec("rm", ["-f", "--", guestPath]);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString("utf8").trim();
    throw new Error(`removing Git seed bundle failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
