# Contributor guide

## Project

`pi-microsandbox` is a TypeScript Pi extension that routes file and shell tools through Microsandbox microVMs. It bind-mounts only canonical `realpath(cwd)` read/write at the lexically resolved cwd guest path, supports configurable safety boundaries, and includes prebuilt native file-locking addons for supported macOS and Linux targets.

## Development workflow

- Follow GitHub Flow: branch from `main`, keep changes focused, and open a pull request back to `main`. Do not push directly to `main`.
- Use Node.js 22.19.0 or newer and the npm version pinned by `packageManager`.
- Install dependencies with `npm ci --ignore-scripts=true`; do not change dependencies without updating `package-lock.json`.
- Before requesting review, run `npm run check` and `npm audit --omit=dev`. Add or update tests for behavior changes.
- Keep generated native binaries out of Git. Changes to the flock addon should also pass `npm run build:flock` and `npm run smoke:flock` on a supported host.
- Live VM tests are opt-in and require virtualization: `PI_MSB_LIVE_TEST=1 ./scripts/e2e-smoke.sh`. Never treat a skipped run as validation.
- Update user-facing documentation with behavior or configuration changes. Preserve secure defaults: sandbox failures must not silently fall back to host execution.
- There are no workspace modes or Git-root-selected binds. Guest root and command
  cwd are the lexically resolved cwd; Git ancestors/siblings outside cwd are
  never automatically exposed. Canonical cwd remains the session boundary. At
  supported checkout roots, Project save chooses shared repository policy or a
  higher-priority cwd-local Worktree override. Shared config atomically embeds
  immutable host-owned repository metadata; bounded read-only catalog discovery
  survives checkout gitfile deletion and covers future registered worktrees.
  Nested cwd and unsupported Git layouts stay cwd-local, Global unchanged,
  with no parent-policy inheritance. Dockerfile/context Project saves use the same
  named Repository/Worktree choice and host-owned immutable association mechanism;
  neither config nor source destination selection copies Dockerfiles/build contexts.
  Owned source tools support bounded relative UTF-8 context patches, not arbitrary
  host paths; multi-artifact saves are individually atomic, never jointly/crash
  atomic, and partial/unknown persistence never authorizes activation.
- Git metadata inside cwd is exposed but never selects the bind. External
  linked-worktree/submodule metadata is not separately mounted; guest Git may
  need explicit setup or mounts. Treat the read/write cwd bind (including secrets
  and `.git` within it), overlapping sessions, and nested-container access as
  part of the security boundary. The main checkout's writable `.git` is an
  authoritative cross-worktree trust boundary, not isolated by shared policy.
  Reserve every catalogued proof tree against explicit writable mounts, including
  unrelated sessions; stale/invalid catalog associations fail closed for host
  repair. Explicit mounts and user-approved host controls
  are separate; cwd replacement must invalidate prior approvals.

## Pull requests and releases

- CI must pass on the supported Node.js and OS matrix. Address review feedback in the feature branch, then merge through the pull request.
- Use Conventional Commit squash-merge PR titles: `fix:` bumps patch, `feat:` bumps minor, and `feat!:` bumps minor before 1.0 (major thereafter). Nonreleasable commits alone do not create releases.
- GitHub Releases remain the canonical changelog; Release Please generates `CHANGELOG.md` as well. Review existing non-conventional unreleased commits during adoption; do not invent notes (see `docs/development.md` for commit overrides).
- Release Please on `main` updates a release PR with package, lockfile, manifest, and changelog versions and enables squash auto-merge only for its App-authored returned PR, with a head-SHA guard on the merge request. Required CI and up-to-date main protection apply to the App without bypass; release PRs merge unattended. Feature PR merges remain the human gate; releasable conventional titles authorize real releases, while docs/chores alone do not publish. Do not use release PRs to test automation, or manually publish/tag unless acting as the human release owner.
- One-time App setup: GitHub user Settings → Developer settings → GitHub Apps → New App, disable webhooks, grant Contents/Issues/Pull requests read-write, install only on this repository, and generate a PEM. Set Actions variable `RELEASE_PLEASE_APP_CLIENT_ID` to its Client ID (not numeric App ID) and secret `RELEASE_PLEASE_APP_PRIVATE_KEY` to the entire PEM. Use the App token, never a `GITHUB_TOKEN` fallback. The Actions PR-creation setting for `GITHUB_TOKEN` does not replace App permissions. Follow the exact UI guide in `docs/development.md`.
- Repository auto-merge and strict main CI are enabled with zero required reviews and admin/bot bypass disabled. Package tag creation ruleset `26100334` and update/delete ruleset `23345899` preserve the existing human exception; add the installed App only to creation (Always allow), never immutability or main. Leave image-tag rules unchanged.
- The App-published release triggers `.github/workflows/release.yml`; preserve its safeguards that verify one assembled tarball and publish those exact bytes through OIDC automatically. Keep npm trusted publisher fields owner `hcohe`, repository `pi-microsandbox`, workflow filename `release.yml` (no path), environment `npm`. The environment permits only `v*` tags without required reviewers.
- Manual Release Please dispatch is recovery-only on `main`. Unchanged existing PRs are not returned by the pinned action; if auto-merge was not enabled, verify that exact release PR and enable squash auto-merge in the UI without bypass. Do not add npm tokens, repack artifacts, or move tags. Rerun the existing failed npm workflow/jobs when safe; npm versions are immutable.
- Container images are released independently with `image-vX.Y.Z` tags. Publish and verify an image cohort before updating the package's digest-pinned default image.

See `docs/development.md` for detailed development, packaging, test, and release procedures.
