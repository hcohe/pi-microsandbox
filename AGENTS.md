# Contributor guide

## Project

`pi-microsandbox` is a TypeScript Pi extension that routes file and shell tools through Microsandbox microVMs. It bind-mounts the enclosing Git worktree (or a non-Git cwd) read/write, supports configurable safety boundaries, and includes prebuilt native file-locking addons for supported macOS and Linux targets.

## Development workflow

- Follow GitHub Flow: branch from `main`, keep changes focused, and open a pull request back to `main`. Do not push directly to `main`.
- Use Node.js 22.19.0 or newer and the npm version pinned by `packageManager`.
- Install dependencies with `npm ci --ignore-scripts=true`; do not change dependencies without updating `package-lock.json`.
- Before requesting review, run `npm run check` and `npm audit --omit=dev`. Add or update tests for behavior changes.
- Keep generated native binaries out of Git. Changes to the flock addon should also pass `npm run build:flock` and `npm run smoke:flock` on a supported host.
- Live VM tests are opt-in and require virtualization: `PI_MSB_LIVE_TEST=1 ./scripts/e2e-smoke.sh`. Never treat a skipped run as validation.
- Update user-facing documentation with behavior or configuration changes. Preserve secure defaults: sandbox failures must not silently fall back to host execution.
- There are no workspace modes. A Git cwd exposes the whole worktree at the
  same lexical guest path; a non-Git cwd exposes itself. Treat this read/write
  host mount, shared sessions, and nested-container access as part of the
  security boundary.

## Pull requests and releases

- CI must pass on the supported Node.js and OS matrix. Address review feedback in the feature branch, then merge through the pull request.
- GitHub Releases are the canonical changelog. Keep package versions and release notes aligned.
- Never run `npm publish`, push a release tag, or publish a GitHub Release unless explicitly acting as the human release owner.
- Package releases use tags named `vX.Y.Z`. Publishing the matching GitHub Release triggers `.github/workflows/release.yml`, which verifies one assembled tarball and publishes it to npm through OIDC after approval of the protected `npm` environment.
- Do not add npm tokens or repack a release artifact. Retry the existing workflow when safe; npm versions are immutable.
- Container images are released independently with `image-vX.Y.Z` tags. Publish and verify an image cohort before updating the package's digest-pinned default image.

See `docs/development.md` for detailed development, packaging, test, and release procedures.
