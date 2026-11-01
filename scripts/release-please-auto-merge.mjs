import { execFileSync } from "node:child_process";

const { GH_REPO, GH_TOKEN, RELEASE_PLEASE_PRS, RELEASE_PLEASE_APP_SLUG } = process.env;
if (GH_REPO !== "hcohe/pi-microsandbox" || !GH_TOKEN ||
    !/^[a-z0-9][a-z0-9-]*$/.test(RELEASE_PLEASE_APP_SLUG ?? "")) {
  throw new Error("Release auto-merge requires the canonical repository and an explicit App token and slug");
}

// v4.4.1 outputPRs emits `prs` for new AND updated PRs. Unchanged PRs are
// omitted by release-please 17.3.0; never discover substitute candidates.
const candidates = JSON.parse(RELEASE_PLEASE_PRS || "[]");
if (!Array.isArray(candidates) || candidates.length > 1) {
  throw new Error("Expected at most one release PR for the configured root package");
}
for (const candidate of candidates) {
  if (!candidate || !Number.isSafeInteger(candidate.number) || candidate.number <= 0 ||
      candidate.baseBranchName !== "main" ||
      typeof candidate.headBranchName !== "string" || !candidate.headBranchName ||
      candidate.headBranchName === "main") {
    throw new Error("Invalid Release Please PR number or branches");
  }
  const gh = args => execFileSync("gh", args, { encoding: "utf8", timeout: 30_000 });
  const pr = JSON.parse(gh(["api", `repos/${GH_REPO}/pulls/${candidate.number}`]));
  if (pr.number !== candidate.number || pr.state !== "open" || pr.draft !== false ||
      pr.user?.type !== "Bot" || pr.user?.login !== `${RELEASE_PLEASE_APP_SLUG}[bot]` ||
      pr.base?.repo?.full_name !== GH_REPO || pr.head?.repo?.full_name !== GH_REPO ||
      pr.base?.ref !== "main" || pr.head?.ref !== candidate.headBranchName ||
      !/^[0-9a-f]{40}$/.test(pr.head?.sha ?? "")) {
    throw new Error(`Release PR #${candidate.number} changed identity, is not open/ready, or has an invalid head SHA`);
  }
  // --auto obeys required checks and up-to-date policy; no admin bypass.
  // Fail rather than authorize a different head if it moves after the API read.
  process.stdout.write(gh([
    "pr", "merge", String(candidate.number), "--repo", GH_REPO,
    "--auto", "--squash", "--match-head-commit", pr.head.sha,
  ]));
}
if (!candidates.length) console.log("No release PR returned; no auto-merge candidates.");
