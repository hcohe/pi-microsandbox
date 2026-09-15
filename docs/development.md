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
extension explicitly loaded alongside your normal discovered extensions. It
forces the local image with `pull_policy = "never"`, requires Docker, and uses
4 CPUs and 8192 MiB. Docker caching keeps repeat builds short
when image inputs have not changed. Pass Pi arguments directly, for example:

```sh
just dev --continue
just dev "Run docker info and report the storage driver"
```

Run `just dev-image` by itself when you only need to refresh the local image.

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
default prepared image. It forces direct mode, disables guest networking and
stale-resource pruning, and sets `bootstrap_tools = false` so the result
measures repeat boot and readiness rather than an image pull or package install.
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
start VMs, create retained resources, and use network and disk capacity. Run it
only from a trusted checkout on a disposable test host after reviewing the
script:

```sh
PI_MSB_LIVE_TEST=1 ./scripts/e2e-smoke.sh
```

Without that variable the script prints a `SKIP` line for every scenario and
exits successfully; this skip path does not validate virtualization. If
virtualization is unavailable, it prints the reason and skips the matrix rather
than reporting false failures. Set `PI_MSB_LIVE_IMAGE` to select the main live
test image; the default is `ghcr.io/hcohe/pi-microsandbox:latest`.
The prepared-image scenario boots all six latest variant tags under
`network.mode = "deny"` with bootstrap disabled. Set
`PI_MSB_LIVE_PREPARED_IMAGES` to a comma-separated image cohort, or use the
legacy singular `PI_MSB_LIVE_PREPARED_IMAGE` to test one image. The live matrix
uses `pull_policy = "always"` intentionally so mutable development tags cannot
remain stale on the self-hosted runner. Review the output to confirm that every scenario reports `PASS`, not `SKIP`.
Docker release validation must cover daemon readiness, bridge DNS and HTTPS,
user-defined networking, Buildx, Compose, idle wake, double port publishing,
and nested-container enforcement for deny and allowlist policies. A skipped
Docker scenario is not release evidence.

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

[GitHub Releases](https://github.com/hcohe/pi-microsandbox/releases) are the
canonical changelog. The first npm publication is a human-run local publish of
the reviewed tarball with interactive npm 2FA. Subsequent releases publish
directly to npm with OIDC only after a maintainer publishes the matching GitHub
Release and approves the protected `npm` GitHub Environment. Release automation
must not use a long-lived npm token. Release CI builds every flock artifact from
the release commit, assembles a temporary staging tree, records each binary's
SHA-256, smoke-tests the exact tarball on every supported target, and packs only
once. The publish job downloads and publishes those verified bytes without
repacking.

The sandbox image workflow publishes all six AMD64 and ARM64 variants to
`ghcr.io/hcohe/pi-microsandbox`. An `image-vX.Y.Z` Git tag publishes the
write-once image cohort: `base-X.Y.Z`, `node-X.Y.Z`, `python-X.Y.Z`,
`rust-X.Y.Z`, `go-X.Y.Z`, and `X.Y.Z` for the default variant. Package tags
remain `vX.Y.Z` and never start image builds. Manual image workflow runs validate
only. The workflow refuses to overwrite an existing version tag.

Image and package releases are independent. Publish and verify an image cohort
before changing the extension default to its `VERSION@sha256:DIGEST` reference.
For the initial release, publish `image-v1.0.0`, pin its default-image digest,
then release package `v0.1.0`. The npm workflow requires that digest-qualified
reference, checks it against the public default tag, checks every variant and
both platforms against the image tag commit, and verifies image provenance
before publishing. A package
administrator must make the GHCR package public before the package release so
both release verification and Microsandbox can pull it without registry
credentials.
