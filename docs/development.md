# Development and releases

[Back to README](../README.md)

This release requires Node.js 22.19.0 or newer. The development toolchain pins Pi 0.84.4, and the runtime dependency is pinned exactly to `microsandbox` 0.6.16.

## Local development

To test from source without installing the npm package globally:

```sh
git clone https://github.com/hcohe/pi-microsandbox.git
cd pi-microsandbox

npm ci --ignore-scripts=true
npm run typecheck
npm test
npm run smoke       # extension-load smoke; no sandbox starts
npm run check       # all three commands above
npm audit --omit=dev
```

The smoke and unit tests do not require KVM, image pulls, or a live sandbox.
The boot-speed check and live matrix below are explicit VM tests.

To test the current extension and default image together, run:

```sh
just dev
```

`dev-flock` builds and smoke-tests the native owner-lock addon for the current
host. `dev-image` builds the current `default` variant as
`pi-microsandbox-dev:local` and imports it into Microsandbox's separate image
cache. `dev` runs both prerequisites, then starts Pi with this checkout's
extension explicitly loaded alongside your normal discovered extensions. `pi` is
resolved from `PATH` (not necessarily the devDependency version). `--extension .`
uses this package's `pi.extensions` manifest, and Pi's loader supplies its own
framework/TUI imports rather than this checkout's devDependency copies. It
forces the local image with `pull_policy = "never"`, requires Docker, and uses
4 CPUs and 8192 MiB. Docker caching keeps repeat builds short
when image inputs have not changed. Pass Pi arguments directly, for example:

```sh
just dev --continue
just dev "Run docker info and report the storage driver"
```

Run `just dev-image` by itself when you only need to refresh the local image.

### Control-panel integration and testing

`/msb` is the only command surface. `control-panel.ts` owns draft navigation/forms,
`settings-fields.ts` is the complete searchable inventory, `settings-input.ts`
retains native Kitty/key handling and sanitizes chunked paste, and `masked-input.ts`
never renders plaintext or uses an Input undo/kill ring. The settings backend
keeps raw credentials/references private; do not stringify effective Config.
Native `ctx.ui.custom` with a 100%-width/height overlay covers and pads the whole
terminal viewport, including regular and alternate-screen renderers. This uses
public Pi 0.84.4 APIs, not a second TUI, private layoutRoot access, render patches,
or manually emitted screen-switch escapes. Pi owns overlay focus/restoration.
Opening is exclusive; cancel, errors and shutdown dispose drafts and entry buffers.

`control-panel.test.ts` exercises keyboard-only CRUD/apply/cancel, exact widths
24/32/40/80/120 and heights 1/3/6/10/24/40, and actual native renderer composition
with terminal doubles (including an installed viewport layout root). Runtime tests
use an injected SDK to verify live adoption versus guarded resource recreation.
Regressions also drive the panel through the native integration with the shared
`test/fake-msb-sdk.ts` fixture: startup-preference safety, draft refresh/recovery,
short-height feedback, repeated secret editing and removal reconciliation.
`control-panel-runtime.test.ts` additionally launches a process fixture with the
actual Pi extension loader, command context, `ui.custom`, theme and both native
renderers. It covers a symlinked agent root, all save scopes, masked input,
responsive overlay composition, close/reopen and focus restoration without a VM.
It always tests the declared local runtime; include another installed runtime with:

```sh
PI_MSB_TEST_PI_PACKAGE=/path/to/pi-coding-agent \
  node --experimental-strip-types --import ./test/setup.ts --test extensions/pi-msb/control-panel-runtime.test.ts
```

The fixture overrides `PI_PACKAGE_DIR` to match the selected runtime: an inherited
override for a different version can otherwise load incompatible theme assets.
These are not live-VM or human-terminal tests. Before release, manually verify
both native modes, themes, IME, bracketed paste, rapid resizing, and session
switch/shutdown. Do not enable terminal input recording when entering secrets.

Changed saves preserve sparse parsed raw data, not TOML comments/layout. Ordinary
external edits and unsafe paths fail validation; portable Node APIs cannot provide
an atomic compare-and-swap rename against a malicious host process. Keep policy
outside every writable workspace/mount. See [backend contract](settings-backend.md).

### Bundled flock addon

Consumers receive prebuilt lock addons and do not need native build tools. Only
contributors building or changing the addon need Python, a C compiler, and the
platform build tools used by node-gyp (`make` on GNU Linux or Xcode command-line
tools on macOS). On one of the three supported targets, run:

```sh
npm ci --ignore-scripts=true
npm run build:flock
npm run smoke:flock
npm run check
```

The build writes
`native/flock/prebuilds/<target>/flock.node` for the current target. These
outputs are ignored by Git and must not be committed. CI builds
`darwin-arm64`, `linux-x64-gnu`, and `linux-arm64-gnu` separately on native
runners, then loads the same binary under Node 22.19.0 and Node 24.

### Assemble a package from CI artifacts

A complete package needs all three `flock-<target>` artifacts from one CI run.
Download each artifact into one empty artifact root, create a staging checkout
from the same commit's Git archive, then give both paths to the assembler:

```sh
run_id=GITHUB_ACTIONS_RUN_ID
mkdir -p .tmp
artifact_root="$(mktemp -d "$PWD/.tmp/flock-artifacts.XXXXXX")"
staging="$(mktemp -d "$PWD/.tmp/package-staging.XXXXXX")"
pack_dir="$(mktemp -d "$PWD/.tmp/package-pack.XXXXXX")"

for target in darwin-arm64 linux-x64-gnu linux-arm64-gnu; do
  gh run download "$run_id" --name "flock-$target" --dir "$artifact_root"
done

git archive HEAD | tar -x -C "$staging"
npm run assemble:package -- "$artifact_root" "$staging"
pack_json="$(npm pack "$staging" --json --pack-destination "$pack_dir")"
tarball="$(node -e 'const value=JSON.parse(process.argv[1]); const results=Array.isArray(value)?value:Object.values(value); if(results.length!==1) throw new Error(`expected one pack result, got ${results.length}`); process.stdout.write(results[0].filename)' "$pack_json")"
npm run package-smoke -- "$pack_dir/$tarball"
```

Use artifacts built from the same commit as `HEAD`. The assembler rejects
missing, extra, or symlinked artifacts and keeps generated binaries out of the
source checkout.

## Boot speed regression test

With [`just`](https://just.systems/) installed, measure the awaited sandbox boot
path against its regression limit:

```sh
just test-boot-speed
```

The tool performs one unmeasured warm-up, then three fresh boots using the
default prepared image. It disables guest networking and stale-resource
pruning, and sets `bootstrap_tools = false` so the result measures repeat boot
and readiness rather than an image pull or package install.
The p95 must be at most 2,000 ms. Every sandbox is shut down and removed. If
lifecycle cleanup fails, the test fails and retains its reported `.tmp` directory
for recovery instead of claiming success.

Run the tool directly to change the image, sample count, warm-ups, or limit:

```sh
node --experimental-strip-types scripts/test-boot-speed.mjs \
  --image ghcr.io/hcohe/pi-microsandbox:latest \
  --warmups 1 \
  --runs 5 \
  --max-ms 2000
```

Use `--json` for machine-readable output and `--help` for the complete option
list. This is a real VM test and requires the same host virtualization support
as the live matrix.

## Live test matrix

From a source checkout, the live matrix is opt-in because it can pull an image,
start VMs, write through the host workspace mount, and use network and disk
capacity. Run it only from a trusted checkout on a disposable test host after
reviewing the script:

```sh
PI_MSB_LIVE_TEST=1 ./scripts/e2e-smoke.sh
```

Without that variable the script prints a `SKIP` line for every scenario and
exits successfully; this skip path does not validate virtualization. If
virtualization is unavailable, it prints the reason and skips the matrix rather
than reporting false failures. Set `PI_MSB_LIVE_IMAGE` to select the main live
test image; the default is `ghcr.io/hcohe/pi-microsandbox:latest`. The main
scenarios use `pull_policy = "always"` by default. To test an image already
imported with `msb load`, set `PI_MSB_LIVE_PULL_POLICY=never`; do not use that
override as evidence for a published image.
The prepared-image scenario boots all six latest variant tags under
`network.mode = "deny"` with bootstrap disabled. Set
`PI_MSB_LIVE_PREPARED_IMAGES` to a comma-separated image cohort, or use the
legacy singular `PI_MSB_LIVE_PREPARED_IMAGE` to test one image. The live matrix
uses `pull_policy = "always"` intentionally so mutable development tags cannot
remain stale on the self-hosted runner. Review the output to confirm that every scenario reports `PASS`, not `SKIP`.
The workspace scenarios must show that a Git subdirectory mounts the whole
worktree, a non-Git cwd mounts itself, and routed writes appear immediately on
the host. They also cover off/on and reload, stale-sandbox pruning, fail-closed
boot errors, and approved host execution. Docker release validation must cover
daemon readiness, bridge DNS and HTTPS, user-defined networking, Buildx,
Compose, idle wake, double port publishing, nested-container access to the
workspace, and network enforcement for deny and allowlist policies. A skipped
scenario is not release evidence.

## Image development

The image workflow derives the `base`, `node`, `python`, `rust`, `go`, and
`default` build matrix from `default-image/variants.json`. Pull requests build
and verify all six variants for AMD64 and ARM64. Main-branch builds publish each
variant's mutable latest tag and a commit-specific tag. Release builds pin the
Ubuntu image digest and one dated apt snapshot for all variants, while published
images restore normal apt sources for project use. See [Images](images.md#add-a-language-variant)
for the modular installer and verifier architecture, contribution rules, and
local validation commands. Docker changes must also pass:

```sh
node scripts/image-variants.mjs matrix
shellcheck -e SC1091 default-image/install/*.sh default-image/verify/*.sh
```

The common image verifier checks Docker Engine 29.8.0, containerd 2.3.4, runc
1.5.1, Buildx 0.37.1, Compose 5.5.1, and Ubuntu's iptables-nft/nftables tools.
Docker daemon and nested-container behavior require the live microVM matrix;
they cannot be validated during a Dockerfile build.

## Releases

[GitHub Releases](https://github.com/hcohe/pi-microsandbox/releases) remain the
canonical changelog; Release Please also maintains a generated `CHANGELOG.md`.
Package releases use `vX.Y.Z` tags without a component prefix.

### One-time Release Please setup

The following documents the required setup and recovery paths. Repository
auto-merge, main protection, App credentials, and the creation-only App tag
exception are configured. Verify existing settings rather than recreating them.
Feature PRs remain a human merge gate; release PRs merge unattended once required
CI passes. Do not weaken protections to test a release.

#### Create and install the release App

1. Open your GitHub avatar menu → **Settings** → **Developer settings** →
   **GitHub Apps** → **New GitHub App**:
   <https://github.com/settings/apps/new>.
2. Choose a unique App name and set **Homepage URL** to
   `https://github.com/hcohe/pi-microsandbox`. Under **Webhook**, clear **Active**;
   this workflow needs no webhook or webhook secret. No callback URL or user
   authorization is needed. Under **Repository permissions**, set **Contents**,
   **Issues**, and **Pull requests** to **Read and write**; leave other optional
   permissions unset. Choose **Only on this account** for installation scope,
   then **Create GitHub App**.
3. On the App's **General** page, record both **App ID** (numeric) and **Client
   ID** (a different value, commonly beginning `Iv`). Under **Private keys**,
   click **Generate a private key** and securely save the downloaded PEM. Never
   commit it. The workflow variable takes the **Client ID**, not the numeric
   App ID. Ruleset integration selection uses the installed App's name; its
   underlying integration/actor ID is the numeric **App ID**, not Client ID or
   installation ID. Find these again at
   <https://github.com/settings/apps> → your App → **General**.
4. In the App sidebar, click **Install App** → **Install** for `hcohe` →
   **Only select repositories** → select **pi-microsandbox** → **Install**.
   Do not install it on all repositories. Manage the installation later at
   <https://github.com/settings/installations>.
5. In the repository, **Settings** → **Secrets and variables** → **Actions**
   (<https://github.com/hcohe/pi-microsandbox/settings/secrets/actions>):
   - **Variables** → **New repository variable**: name
     `RELEASE_PLEASE_APP_CLIENT_ID`, value the App's **Client ID**
     (<https://github.com/hcohe/pi-microsandbox/settings/variables/actions>).
   - **Secrets** → **New repository secret**: name
     `RELEASE_PLEASE_APP_PRIVATE_KEY`, value the entire PEM, including the
     `BEGIN`/`END` lines and line breaks.

The workflow requests a short-lived App token restricted to this repository and
those three permissions. Missing credentials fail closed; there is no
`GITHUB_TOKEN` fallback. App-authored PRs run CI and App-published releases
trigger the npm workflow. The Actions setting **Allow GitHub Actions to create
and approve pull requests** governs `GITHUB_TOKEN`, not this App; it is not a
substitute for installation, and self-approval is neither needed nor used.

#### Repository merging and main protection

The repository settings below are already applied; use these paths to verify
or restore the intended policy, not to relax it.

**Settings** → **Actions** → **General** uses a selected-actions allowlist.
Keep GitHub-owned actions allowed and `googleapis/release-please-action@*` in the
allowed patterns alongside the existing Docker actions. This entry has already
been added; do not switch to allowing all actions. Workflow references remain
pinned to full commit SHAs.

1. **Settings** → **General** → **Pull Requests**
   (<https://github.com/hcohe/pi-microsandbox/settings>): enable **Allow squash
   merging** and **Allow auto-merge**. Auto-merge availability is repository-wide,
   but this workflow enables it only for Release Please's explicitly returned
   release PR. Maintainers continue to decide when feature PRs merge.
2. **Settings** → **Branches** → the `main` protection rule → **Edit**
   (<https://github.com/hcohe/pi-microsandbox/settings/branches>): keep **Require
   a pull request before merging** enabled. For the solo-maintainer setup, clear
   **Require approvals** (zero approvals); leave code-owner approval and approval
   of the last push disabled. CODEOWNERS still records ownership.
3. Keep **Require status checks to pass before merging** and **Require branches
   to be up to date before merging** enabled. Preserve the GitHub Actions-sourced
   required checks below; do not configure auto-merge with zero required checks:
   - `Check (ubuntu-latest, Node 22.19.0)`
   - `Check (ubuntu-latest, Node 24.x)`
   - `Check (macos-latest, Node 22.19.0)`
   - `Check (macos-latest, Node 24.x)`
   - `Native flock (darwin-arm64)`
   - `Native flock (linux-x64-gnu)`
   - `Native flock (linux-arm64-gnu)`
   - `Assemble and smoke-test package`
   - `CodeQL (JavaScript/TypeScript)`
   - `CodeQL (C flock addon)`
   - `Dependency Review`
4. Keep **Require linear history**, **Require conversation resolution before
   merging**, and **Do not allow bypassing the above settings** enabled. Leave
   force pushes and branch deletion disabled; do not add the App (or an admin)
   to any branch bypass list or **Allow specified actors to bypass required pull
   requests**. Save changes. The App must satisfy the same main protection as
   the maintainer; it cannot push a release commit directly to `main`.

#### Package-tag creation versus immutability

Do this only after the App exists and is installed; never guess its numeric ID.
Under **Settings** → **Rules** → **Rulesets**
(<https://github.com/hcohe/pi-microsandbox/settings/rules>), keep two active tag
rulesets targeting `v*` (API pattern `refs/tags/v*`, no exclusions):

- **Package release tag creation**: only **Restrict creations**; bypass actors
  are the existing human release owner plus the installed release App.
- **Package release tags** (existing ID `23345899`): only **Restrict updates**
  and **Restrict deletions**; preserve the existing human exception, with **no
  App bypass**. This is immutability against automation, not against the human
  release owner.

The administrator has already split the original combined ruleset, preserving
its exact human bypass (`hcohe`, not all admins). **Package release tag creation**
is active, creation-only, ID `26100334`; **Package release tags** ID `23345899`
is active, update/delete-only. The release App has an exception only in the
creation ruleset. Do not recreate or split these again. The original combined
rule blocked App creation;
adding the App to that combined rule would also have allowed tag mutation.

For future recreation only: create the active creation-only rule with the same
exact human exception before removing creation from the old rule. Preserve
update/delete protection continuously. If the UI cannot preserve the existing
individual-user exception, an administrator must preserve it through the rulesets
API rather than broadening it to an admin role. Never disable the immutability
rule or grant the App its bypass.

Once the human-preserving split is present, the App setup is entirely in the UI:

1. Open **Package release tag creation**
   (<https://github.com/hcohe/pi-microsandbox/rules/26100334>) → **Edit**
   (or select it under **Settings** → **Rules** → **Rulesets**). Confirm
   **Active**, target `v*`, and **Restrict creations** only.
2. **Bypass list** → **Add bypass** → search for the installed App's name →
   select the App → **Add Selected**. Keep **Always allow** (tag creation is not
   a PR operation). Verify the selected integration is the release App recorded
   above, not an admin role, and **Save changes**.
3. Open **Package release tags**
   (<https://github.com/hcohe/pi-microsandbox/settings/rules/23345899>).
   Confirm **Restrict updates** and **Restrict deletions** remain enabled,
   **Restrict creations** is off, and its bypass list still contains only the
   existing human exception. Do not add the App here or to `main` protections.
4. Leave **Sandbox image release tags** and all `image-v*` protection unchanged.
   The package App does not need image-tag bypass.

See GitHub's [ruleset UI guide](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository).
Do not publish a real release merely to test these settings.

#### npm trusted publishing and environment

1. Open <https://www.npmjs.com/package/pi-microsandbox/access> (package
   **Settings**) → **Trusted Publisher** → **GitHub Actions**. Keep the existing
   publisher (edit rather than adding a different publishing path):
   - **Organization or user**: `hcohe`
   - **Repository**: `pi-microsandbox`
   - **Workflow filename**: `release.yml` — filename only, **not**
     `.github/workflows/release.yml`
   - **Environment name**: `npm`
   - If **Allowed actions** is shown, permit direct **npm publish**, as used by
     this workflow (not only staged publishing).
   Save/confirm the settings. See the
   [npm trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/).
2. GitHub repository **Settings** → **Environments** → **npm**
   (<https://github.com/hcohe/pi-microsandbox/settings/environments>): under
   **Deployment protection rules**, leave **Required reviewers** unset. Under
   **Deployment branches and tags**, select **Selected branches and tags**;
   keep a **Tag** rule `v*` only, with no branch rules or other tag patterns.
   Keep the environment itself; do not change it to all branches/tags.

The npm environment's reviewer gate has been removed for unattended publishing;
verify the tag-only restriction remains. No npm token or `NODE_AUTH_TOKEN` is
needed: the existing publisher uses OIDC from `release.yml`'s `npm` job.

### Release flow and recovery

Squash-merge PRs with accurate Conventional Commit titles: `fix: ...` bumps
patch, `feat: ...` bumps minor, and `feat!: ...` (or a `BREAKING CHANGE:` footer)
bumps minor before 1.0, major thereafter. Nonreleasable commits such as `chore:`
and `test:` alone do not generate a release. On pushes to `main`, Release Please
opens or updates a release PR containing `package.json`, `package-lock.json`,
`.release-please-manifest.json`, and `CHANGELOG.md` updates. Review its version
and notes before enabling this setup. Thereafter the workflow automatically
enables squash auto-merge only for the new/updated PR returned by Release
Please, after verifying its number, head branch, same-repository base/head,
`main` base, open/non-draft state, the configured App's bot authorship, and current
head SHA. GitHub waits for the
required checks and up-to-date policy (or merges immediately if already
satisfied); there is no polling, self-approval, or admin bypass. The merge is
guarded by that observed head SHA when requested. Later authorized branch
updates still require checks on the new head; auto-merge is not a permanent
commit pin. The resulting push to `main` runs Release Please again; the App tags and publishes the GitHub Release, whose
`release.published` event starts `release.yml`.
After artifact and image verification passes, the `npm` environment allows OIDC
publication automatically; no separate environment approval is required.
The human gate is merging releasable feature/fix PRs, not manually merging each
release PR. `docs:`, `chore:`, and `test:` changes alone do not publish; not every
merge produces a package. Enabling release auto-merge authorizes real releases,
so do not use a release PR to test the setup.

Adoption starts from the existing `v0.3.0` release. Some unreleased commits have
non-conventional messages and may be omitted. Review actual changes since that
tag before enabling unattended release-PR merging; do not invent release notes.
For an existing squash-merged PR, Release Please supports an accurate conventional
message between `BEGIN_COMMIT_OVERRIDE` and `END_COMMIT_OVERRIDE` in its edited
PR body; plain merge commits do not support this override. Review any remaining
omissions explicitly in the generated release PR.

For recovery, manually dispatch **Release Please** on `main` only; other branches
and forks are guarded out. The pinned action emits `prs` for newly created or
updated PRs, but emits no candidate for an unchanged existing PR. A dispatch
therefore cannot re-enable auto-merge on an unchanged PR if the prior merge step
failed or auto-merge was disabled. Inspect that exact release PR in the UI,
verify its branches/version/notes and checks, then choose **Enable auto-merge**
with **Squash and merge** as a human recovery action. Never scan all open PRs
and auto-merge by title/label, weaken required checks, or use an admin bypass.
A head change between verification and the merge request fails the workflow;
inspect/recover rather than removing the head-SHA guard. If GitHub disables
auto-merge after a later push, verify the new head and enable it again. If no
release-published workflow appears, check the merged release PR and Release
Please run on `main` first, then dispatch there to recover tagging/publication;
never create a replacement tag/event with `GITHUB_TOKEN`. If npm publication
fails for a transient reason, rerun the existing failed npm workflow/jobs when
safe, preserving the verified artifact. Do not repack, move tags, or create a
replacement release merely to retry; npm versions are immutable.
If a workflow or code defect caused the failure, land a reviewed fix and let
Release Please create a fresh patch release instead of rerunning the unchanged
bad tag. Keep the failed tag and GitHub Release immutable; do not retag or repack.
A GitHub Release is not proof of npm publication: `v0.4.0` failed verification
before packing, and npm `0.4.0` was not published.
Release CI builds every flock artifact from the release commit, assembles a
temporary staging tree, records each binary's SHA-256, smoke-tests the exact
tarball on every supported target, and packs only once. The publish job downloads
and publishes those verified bytes without repacking.

The sandbox image workflow publishes all six AMD64 and ARM64 variants to
`ghcr.io/hcohe/pi-microsandbox`. An `image-vX.Y.Z` Git tag publishes the
write-once image cohort: `base-X.Y.Z`, `node-X.Y.Z`, `python-X.Y.Z`,
`rust-X.Y.Z`, `go-X.Y.Z`, and `X.Y.Z` for the default variant. Package tags
remain `vX.Y.Z` and never start image builds. Manual image workflow runs validate
only. The workflow refuses to overwrite an existing version tag.

Image and package releases are independent. Publish and verify an image cohort
before changing the extension default to its `VERSION@sha256:DIGEST` reference.
The npm workflow requires that digest-qualified reference, checks it against the
public default tag, checks every variant and both platforms against the image
tag commit, and verifies image provenance before publishing. A package
administrator must make the GHCR package public before the package release so
both release verification and Microsandbox can pull it without registry
credentials.
