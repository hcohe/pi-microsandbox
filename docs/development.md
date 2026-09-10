# Development and releases

[Back to README](../README.md)

This release requires Node.js 22.19.0 or newer. The development toolchain pins Pi 0.84.4, and the runtime dependency is pinned exactly to `microsandbox` 0.6.16.

## Local development

To test from source without installing the npm package globally:

```sh
git clone https://github.com/hcohe/pi-microsandbox.git
cd pi-microsandbox

# fs-ext must compile during installation; do not use --ignore-scripts.
npm ci
npm run typecheck
npm test
npm run smoke       # extension-load smoke; no sandbox starts
npm run check       # all three commands above
npm audit --omit=dev
npm pack --dry-run --json
```

The smoke and unit tests do not require KVM, image pulls, or a live sandbox.
The boot-speed check and live matrix below are explicit VM tests.

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
remain stale on the self-hosted runner. Review the output to confirm that all 16 scenarios report
`PASS`, not `SKIP`.

## Image development

The image workflow derives the `base`, `node`, `python`, `rust`, `go`, and
`default` build matrix from `default-image/variants.json`. Pull requests build
and verify all six variants for AMD64 and ARM64. Main-branch builds publish each
variant's mutable latest tag and a commit-specific tag. Release builds pin the
Ubuntu image digest and one dated apt snapshot for all variants, while published
images restore normal apt sources for project use. See [Images](images.md#add-a-language-variant)
for the modular installer and verifier architecture, contribution rules, and
local validation commands.

## Releases

[GitHub Releases](https://github.com/hcohe/pi-microsandbox/releases) are the
canonical changelog. The first npm publication is a human-run local publish of
the reviewed tarball with interactive npm 2FA. Subsequent releases publish
directly to npm with OIDC only after a maintainer publishes the matching GitHub
Release and approves the protected `npm` GitHub Environment. Release automation
must not use a long-lived npm token.

The sandbox image workflow publishes all six AMD64 and ARM64 variants to
`ghcr.io/hcohe/pi-microsandbox`. A `vX.Y.Z` Git tag publishes the write-once
versioned cohort: `base-X.Y.Z`, `node-X.Y.Z`, `python-X.Y.Z`, `rust-X.Y.Z`,
`go-X.Y.Z`, and `X.Y.Z` for the default variant. The workflow refuses to
overwrite an existing version tag.

Release in this order: push the reviewed `vX.Y.Z` tag; wait for the image
workflow to publish and verify the complete six-variant cohort; then publish the
GitHub Release that starts npm publication. The npm workflow checks every
variant and both platforms for the release commit and package version labels
before publishing. After the first publication, a package administrator must
make the GHCR package public so Microsandbox can pull images without registry
credentials.
