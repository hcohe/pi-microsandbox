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
The live matrix described below is the only opt-in VM test.

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
than reporting false failures. Set `PI_MSB_LIVE_IMAGE` to select the live test
image; the default is `ubuntu:24.04`. Set `PI_MSB_LIVE_PREPARED_IMAGE` to
additionally exercise a prepared image under `network.mode = "deny"` without
bootstrap. Review the output to confirm that all 16 scenarios report `PASS`,
not `SKIP`.

## Releases

[GitHub Releases](https://github.com/hcohe/pi-microsandbox/releases) are the
canonical changelog. The first npm publication is a human-run local publish of
the reviewed tarball with interactive npm 2FA. Subsequent releases publish
directly to npm with OIDC only after a maintainer publishes the matching GitHub
Release and approves the protected `npm` GitHub Environment. Release automation
must not use a long-lived npm token.
