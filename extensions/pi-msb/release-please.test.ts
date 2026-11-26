import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");
const workflow = read(".github/workflows/release-please.yml");
const release = read(".github/workflows/release.yml");

test("release-please config tracks one stable root node package with explicit pre-1.0 bumps", () => {
  const config = JSON.parse(read("release-please-config.json"));
  assert.deepEqual(config, {
    $schema: "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
    packages: {
      ".": {
        "release-type": "node",
        "include-component-in-tag": false,
        "include-v-in-tag": true,
        prerelease: false,
        "bump-minor-pre-major": true,
        "bump-patch-for-minor-pre-major": false,
        "changelog-path": "CHANGELOG.md",
      },
    },
  });
  const manifest = JSON.parse(read(".release-please-manifest.json"));
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.deepEqual(manifest, { ".": pkg.version });
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
});

test("release-please workflow serializes main-only runs in the canonical repository", () => {
  assert.match(workflow, /^on:\n  push:\n    branches: \[main\]\n  workflow_dispatch:\n/m);
  assert.match(workflow, /^concurrency:\n  group: release-please-pi-microsandbox\n  cancel-in-progress: false$/m);
  assert.match(workflow, /^    if: >-\n      github.repository == 'hcohe\/pi-microsandbox' &&\n      github.ref == 'refs\/heads\/main'$/m);
  assert.match(workflow, /^    timeout-minutes: 10$/m);
  assert.match(workflow, /^          target-branch: main$/m);
  assert.doesNotMatch(workflow, /pull_request:|tags:|continue-on-error:|always\(\)/);
});

test("release-please uses only a narrowly scoped App token and immutable action pins", () => {
  const permissions = [...workflow.matchAll(/^\s*permissions:\n((?: +[^\n]+\n)+)/gm)];
  assert.equal(permissions.length, 1);
  assert.equal(permissions[0]![1]!.trim(), "contents: read");
  const actions = [...workflow.matchAll(/^        uses: (.+)$/gm)].map(match => match[1]);
  assert.equal(actions.length, 3);
  // Permit Dependabot upgrades while requiring full commit pins and version comments.
  assert.match(actions[0]!, /^actions\/create-github-app-token@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  assert.match(actions[1]!, /^googleapis\/release-please-action@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  assert.match(actions[2]!, /^actions\/checkout@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  assert.match(workflow, /^        id: app-token$/m);
  assert.match(workflow, /^          client-id: \$\{\{ vars.RELEASE_PLEASE_APP_CLIENT_ID \}\}$/m);
  assert.match(workflow, /^          private-key: \$\{\{ secrets.RELEASE_PLEASE_APP_PRIVATE_KEY \}\}$/m);
  assert.match(workflow, /^          repositories: \$\{\{ github.event.repository.name \}\}$/m);
  assert.deepEqual([...workflow.matchAll(/^          permission-(.+)$/gm)].map(match => match[1]), [
    "contents: write", "issues: write", "pull-requests: write",
  ]);
  assert.match(workflow, /^          token: \$\{\{ steps.app-token.outputs.token \}\}$/m);
  assert.match(workflow, /^          config-file: release-please-config.json$/m);
  assert.match(workflow, /^          manifest-file: .release-please-manifest.json$/m);
  assert.doesNotMatch(workflow, /github\.token|secrets\.GITHUB_TOKEN|\|\||owner:|skip-token-revoke:|skip-github-release:|skip-github-pull-request:/);
  assert.match(workflow, /^        id: release$/m);
  assert.match(workflow, /^          ref: \$\{\{ github.sha \}\}$/m);
  assert.match(workflow, /^          persist-credentials: false$/m);
  assert.match(workflow, /^          GH_TOKEN: \$\{\{ steps.app-token.outputs.token \}\}$/m);
  assert.match(workflow, /^          GH_REPO: hcohe\/pi-microsandbox$/m);
  assert.match(workflow, /^          RELEASE_PLEASE_PRS: \$\{\{ steps.release.outputs.prs \}\}$/m);
  assert.match(workflow, /^          RELEASE_PLEASE_APP_SLUG: \$\{\{ steps.app-token.outputs.app-slug \}\}$/m);
  assert.deepEqual([...workflow.matchAll(/^        run: (.+)$/gm)].map(match => match[1]), [
    "node scripts/release-please-auto-merge.mjs",
  ]);
  assert.doesNotMatch(workflow + read("scripts/release-please-auto-merge.mjs"), /--admin|--approve|gh pr list|sleep|setInterval|shell: true/);
});

test("App-published releases hand off to the existing exact-artifact OIDC publisher", () => {
  assert.match(release, /^on:\n  release:\n    types: \[published\]$/m);
  assert.match(release, /^  publish:\n    name: Publish exact artifact\n    needs: \[verify, artifact-smoke\][\s\S]*?    environment: npm\n    permissions:\n      contents: read\n      id-token: write$/m);
  assert.match(release, /ref: \$\{\{ github.sha \}\}/);
  assert.match(release, /Verify provenance for the immutable image/);
  assert.match(release, /Smoke-test the exact release artifact/);
  assert.match(release, /npm publish "\$TARBALL" --access public/);
  assert.doesNotMatch(release, /NODE_AUTH_TOKEN|NPM_TOKEN/);
  const publish = release.slice(release.indexOf("\n  publish:\n"));
  assert.doesNotMatch(publish, /npm pack|actions\/checkout@/);

  // Release Please creates the GitHub release, not a second npm publishing path.
  const publishers = readdirSync(new URL(".github/workflows/", root))
    .filter(file => /\.ya?ml$/.test(file))
    .filter(file => /\bnpm publish\b/.test(read(`.github/workflows/${file}`)));
  assert.deepEqual(publishers, ["release.yml"]);
});

test("release.yml verify installs once after identity validation and before importing config", () => {
  const verify = release.match(/^  verify:\n[\s\S]*?(?=^  \S)/m)?.[0];
  assert.ok(verify, "verify job must exist");
  const steps = verify.split(/^      - name: /m).slice(1);
  const names = steps.map(step => step.split("\n")[0]);
  const identity = names.indexOf("Verify repository, tag, and package identity");
  const install = names.indexOf("Install dependencies without lifecycle scripts");
  const config = names.indexOf("Resolve the configured default image release");
  assert.ok(identity >= 0 && identity < install && install < config);
  assert.equal(steps[install]!.trim(),
    "Install dependencies without lifecycle scripts\n        run: npm ci --ignore-scripts=true");
  assert.equal([...verify.matchAll(/\bnpm ci\b/g)].length, 1);
  assert.match(steps[config]!, /import \{ DEFAULT_CONFIG \} from "\.\/extensions\/pi-msb\/config\.ts";/);

  let previous = config;
  for (const name of [
    "Verify provenance for the immutable image",
    "Recheck public image tags are unchanged",
    "Run release checks",
    "Reject generated or dirty files",
    "Pack the release artifact once",
    "Smoke-test the exact release artifact",
  ]) {
    const index = names.indexOf(name);
    assert.ok(index > previous, `${name} must remain a downstream release gate`);
    previous = index;
  }
  assert.match(verify, /^        run: npm run release-check$/m);
  assert.doesNotMatch(verify, /id-token: write|continue-on-error:/);
});

test("release.yml identity Node check needs no dependencies; config import runs with installed dependencies", () => {
  const identity = release.match(/node <<'NODE'\n([\s\S]*?)^          NODE$/m)?.[1];
  const config = release.match(/image_reference="\$\(node --experimental-strip-types --input-type=module <<'NODE'\n([\s\S]*?)^          NODE$/m)?.[1];
  assert.ok(identity);
  assert.ok(config);
  const dir = mkdtempSync(join(tmpdir(), "release-identity-"));
  try {
    // Identity validation precedes npm ci, so it must work with only package.json.
    const pkg = read("package.json");
    writeFileSync(join(dir, "package.json"), pkg);
    const output = join(dir, "output");
    const result = spawnSync(process.execPath, ["--input-type=commonjs"], {
      input: identity, cwd: dir, encoding: "utf8",
      env: { ...process.env, RELEASE_TAG: `v${JSON.parse(pkg).version}`, GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, "utf8"), `name=pi-microsandbox\nversion=${JSON.parse(pkg).version}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Unlike identity validation, importing config loads runtime package imports.
  // Exercise the actual workflow heredoc after install, without any image lookup.
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module"], {
    input: config, cwd: root, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ghcr\.io\/hcohe\/pi-microsandbox:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
});

const repo = "hcohe/pi-microsandbox";
const appSlug = "pi-microsandbox-release";
const head = "release-please--branches--main";
const sha = "a".repeat(40);
// Exact PullRequest shape shared by createPullRequest and updatePullRequest in
// the action's locked release-please 17.3.0 (neither path returns a head SHA).
const returnedPR = { number: 42, headBranchName: head, baseBranchName: "main", title: "chore(main): release 0.4.0", body: "notes", labels: [], files: [] };
const apiPR = {
  number: 42, state: "open", draft: false,
  user: { login: `${appSlug}[bot]`, type: "Bot" },
  base: { ref: "main", repo: { full_name: repo } },
  head: { ref: head, sha, repo: { full_name: repo } },
};

function runAutoMerge(prs: string, api: unknown = apiPR, env: Record<string, string | undefined> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "release-please-auto-merge-"));
  try {
    const log = join(dir, "calls.jsonl");
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({args, token: process.env.GH_TOKEN, repo: process.env.GH_REPO}) + "\\n");
if (args[0] === "api") process.stdout.write(process.env.API_PR);
else if (process.env.MERGE_FAIL) { console.error("Head changed or merge rejected"); process.exit(1); }
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [new URL("scripts/release-please-auto-merge.mjs", root).pathname], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: "test-app-token", GH_REPO: repo,
        RELEASE_PLEASE_PRS: prs, RELEASE_PLEASE_APP_SLUG: appSlug,
        API_PR: JSON.stringify(api), CALL_LOG: log, ...env },
    });
    const calls = readdirSync(dir).includes("calls.jsonl")
      ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    return { ...result, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("release-please auto-merge authorizes only a returned new/updated PR with App token and matching API head", () => {
  const result = runAutoMerge(JSON.stringify([returnedPR]));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    { args: ["api", `repos/${repo}/pulls/42`], token: "test-app-token", repo },
    { args: ["pr", "merge", "42", "--repo", repo, "--auto", "--squash", "--match-head-commit", sha], token: "test-app-token", repo },
  ]);
});

for (const output of ["", "[]"]) {
  test(`release-please auto-merge does not discover candidates when output is ${JSON.stringify(output)}`, () => {
    const result = runAutoMerge(output);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, []);
    assert.match(result.stdout, /No release PR returned/);
  });
}

for (const [name, output] of Object.entries({
  malformed: "not JSON", object: "{}", null: "null", multiple: JSON.stringify([returnedPR, returnedPR]),
  negative: JSON.stringify([{ ...returnedPR, number: -1 }]),
  stringNumber: JSON.stringify([{ ...returnedPR, number: "42" }]),
  fractional: JSON.stringify([{ ...returnedPR, number: 1.5 }]),
  unsafeInteger: JSON.stringify([{ ...returnedPR, number: Number.MAX_SAFE_INTEGER + 1 }]),
  wrongBase: JSON.stringify([{ ...returnedPR, baseBranchName: "dev" }]),
  missingHead: JSON.stringify([{ number: 42, baseBranchName: "main" }]),
  mainHead: JSON.stringify([{ ...returnedPR, headBranchName: "main" }]),
})) {
  test(`release-please auto-merge rejects ${name} output before any API access`, () => {
    const result = runAutoMerge(output);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
  });
}

for (const [name, api] of Object.entries({
  missingAuthor: { ...apiPR, user: undefined }, deletedAuthor: { ...apiPR, user: null },
  otherAuthor: { ...apiPR, user: { login: "another-app[bot]", type: "Bot" } },
  humanAuthor: { ...apiPR, user: { login: `${appSlug}[bot]`, type: "User" } },
  otherNumber: { ...apiPR, number: 43 }, closed: { ...apiPR, state: "closed" },
  draft: { ...apiPR, draft: true }, missingDraft: { ...apiPR, draft: undefined },
  otherBase: { ...apiPR, base: { ...apiPR.base, ref: "dev" } },
  otherBaseRepo: { ...apiPR, base: { ...apiPR.base, repo: { full_name: "someone/else" } } },
  fork: { ...apiPR, head: { ...apiPR.head, repo: { full_name: "someone/else" } } },
  deletedHeadRepo: { ...apiPR, head: { ...apiPR.head, repo: null } },
  otherHead: { ...apiPR, head: { ...apiPR.head, ref: "feature" } },
  badSHA: { ...apiPR, head: { ...apiPR.head, sha: "--admin" } },
})) {
  test(`release-please auto-merge rejects ${name} API PR without requesting merge`, () => {
    const result = runAutoMerge(JSON.stringify([returnedPR]), api);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].args[0], "api");
  });
}

for (const [name, env] of Object.entries({
  missingToken: { GH_TOKEN: "" }, otherRepo: { GH_REPO: "someone/else" },
  missingAppSlug: { RELEASE_PLEASE_APP_SLUG: "" }, invalidAppSlug: { RELEASE_PLEASE_APP_SLUG: "../bad" },
})) {
  test(`release-please auto-merge rejects ${name}`, () => {
    const result = runAutoMerge(JSON.stringify([returnedPR]), apiPR, env);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
  });
}

test("release-please auto-merge propagates head-race/merge rejection without retry or bypass", () => {
  const result = runAutoMerge(JSON.stringify([returnedPR]), apiPR, { MERGE_FAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(result.calls.length, 2);
  assert.match(result.stderr, /Head changed or merge rejected/);
});
