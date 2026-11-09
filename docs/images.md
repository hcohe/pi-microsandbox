# Pick your Linux lunchbox

[Back to README](../README.md) · [Agent recipes](agent-recipes.md)

The default image comes with Node.js, Python, Rust, Go, and Docker. If that's
more lunch than you need, choose a language-specific variant—or pack your own.
Image changes may recreate the VM and discard guest-local state.

**New in source builds:** every variant now includes **gcloud 592.0.0**, **AWS
CLI v2 2.39.6**, and **curl** in its shared base. Existing published tags and the
package's digest-pinned default are unchanged; use a new source build until a
new image cohort is published and the package pin updated.
[Build one now →](#cloud-clis-from-this-branch)

You can ask your agent to make the change:

> Inspect my current image and the image-setting schema. Propose this Project's
> image as ghcr.io/hcohe/pi-microsandbox:python-1.1.0 with pull_policy if-missing,
> in one approved batch. Explain the restart impact and verify activation.

For reproducible custom setups, use an immutable digest rather than a mutable
latest tag. The bundled default is already digest-pinned.

pi-microsandbox publishes six Ubuntu 26.04 image variants at
`ghcr.io/hcohe/pi-microsandbox`. Every tag is a Linux multi-platform image for
AMD64 and ARM64.

## Published variants

`VERSION` below is the independent image version, such as `1.0.0`. Release
tags are write-once. Latest tags are mutable development tags built from `main`.
Package versions and image versions are separate. Maintainers publish image
cohorts through the [image release workflow](development.md#image-development);
selecting an image here doesn't build or publish one.

| Variant | Contents | Release tag | Latest tag |
| --- | --- | --- | --- |
| `base` | Required guest commands, CA certificates, Docker 29.8.0, Buildx 0.37.1, and Compose 5.5.1; no language toolchain | `base-VERSION` | `base-latest` |
| `node` | Base plus Node.js 24.21.0, npm, pnpm 12.3.4, Yarn 1.22.22, and native addon build support | `node-VERSION` | `node-latest` |
| `python` | Base plus Ubuntu Python 3, pip, uv/uvx 0.12.12, and native extension build support | `python-VERSION` | `python-latest` |
| `rust` | Base plus Rust 1.98.0, Cargo, rustup, and native dependency build support | `rust-VERSION` | `rust-latest` |
| `go` | Base plus Go 1.26.8 and cgo build support | `go-VERSION` | `go-latest` |
| `default` | Base plus the Node.js, Python, Rust, and Go modules above | `VERSION` | `latest` |

The published base contract includes `bash`, `sh`, `git`, `rg`, `file`, `cat`, `mkdir`,
`rm`, Docker Engine and CLI 29.8.0, containerd 2.3.4, runc 1.5.1, Buildx
0.37.1, Compose 5.5.1, and the Ubuntu iptables-nft and nftables tools. CA
certificates support HTTPS Git operations. Docker is part of the common base
rather than a language toolchain, so all six variants built from this version
contain it. The extension's digest-pinned default changes only after that cohort
has been published and verified.

Select a variant in host-owned configuration outside the mounted cwd:

```toml
# ~/.pi/agent/pi-microsandbox/default.toml (or a host-owned project override)
image = "ghcr.io/hcohe/pi-microsandbox:python-1.1.0"
pull_policy = "if-missing"
```

If `image` is omitted and no host-owned Dockerfile is selected, pi-microsandbox uses the configured `default` variant
release, qualified by both its `VERSION` tag and immutable index digest. Image
versions are independent of the installed package version. If `pull_policy` is
omitted, `"if-missing"` is used: Microsandbox pulls the image only when that
exact reference is absent from its cache. Use `"always"` to check a registry for
an updated mutable tag, or `"never"` to require a cached local image.

## Host-owned Dockerfile (no host Docker)

**Call `msb_dockerfile_get` with `{"scope":"project"}` (or `"global"`) first.**
It reads the actual scoped Dockerfile, returns authoritative host paths, and gives
a directly usable bundled digest-pinned `FROM` starter. Propose a complete
replacement with `msb_dockerfile_set` using the same scope and `content`, and/or
a relative `context` patch. Getter `contextPaths` requests bounded context text. Its
No-first per-proposal review includes the exact path, full escaped replacement
diff and build/public-egress/restart consequences. Approved changes publish each file atomically (not jointly/crash atomic)
and reload settings only after the whole approved bundle is confirmed, building/importing and restarting with the new image when
selected. This requires no blanket host execution permission or host-shell recipe.
No UI/denial/stale approval means no write/reload; unchanged is a no-op.
Report saved versus active: explicit images/higher scopes may shadow the file,
Off/autoStart can defer activation, and build failures leave saved content without
confirmed activation. Use a separately approved `msb_config_set` image inheritance
change if needed; never edit other scopes silently or weaken protection.
[Tool contract](tools.md#msb_dockerfile_get--msb_dockerfile_set).

Tool Dockerfiles are bounded to 32 KiB valid UTF-8 (no unsupported controls),
never silently truncated. Content and full diffs are intentionally exposed to the
model/transcript: **do not embed credentials or secrets**. Context PATCH supports
UTF-8 text, `.dockerignore`, nested files, executable scripts and single-file
deletion (`content:null`), preserving unspecified/binary files. Limits are 16 files,
32 KiB/file and 64 KiB aggregate text per read/proposal/original review. Getter
inventories metadata without reading unrequested file contents. No arbitrary
host paths or binary/base64 payloads; use a human editor for unsupported inputs.

Place a Dockerfile beside your host-owned policy, outside the mounted cwd:

```text
<Pi agent dir>/pi-microsandbox/Dockerfile                         # Global
<Pi agent dir>/pi-microsandbox/build-context/                     # optional Global context
<Pi agent dir>/pi-microsandbox/projects/Code/app/Dockerfile       # Project for ~/Code/app
<Pi agent dir>/pi-microsandbox/projects/Code/app/build-context/    # optional Project context
```

The default Pi agent directory is `~/.pi/agent`; Pi's `getAgentDir()` (including
`PI_CODING_AGENT_DIR`) is authoritative. Use the getter's exact Project path, derived from the same current authoritative
identity as [Project configuration](configuration.md#host-owned-project-overrides),
not a guessed cwd-to-directory mapping. Project setter uses the same named human
Repository/Worktree choice as config at supported checkout roots, before opening
the proposal baseline. Shared saves explicitly review registration of immutable
`_repository` in shared `repositories/<hash>/config.toml` when needed, preserving
user configuration/image intent. This enables source discovery for current/future
registered worktrees, including after checkout gitfile deletion. Getter Project
defaults to repository; `destination:"worktree"` explicitly inspects the override.
Nested/nonGit/unsupported cwd stays local; Global is unchanged. No source files
are copied or migrated by config or source destination selection. A standalone
shared Dockerfile without catalog metadata is not discovery authority. No policy
identity changes the mounted cwd boundary. A
host-selected agent-directory symlink is supported, but descendants must not be
symlinks. Keep these paths outside the workspace and writable mounts;
a cwd encompassing the policy location (often home itself) is rejected, not
silently granted access. Build sources cannot be exposed through explicit mounts,
even read-only ones.

**Source precedence is atomic.** At each host scope, an explicit TOML `image`
wins over its colocated Dockerfile. Otherwise the Dockerfile supplies that scope's
image. Project overrides Global; a higher Worktree source can override Project where
applicable, and a Session `image` disables inherited
Dockerfile discovery. With neither image nor Dockerfile, the bundled digest pin
is used. Remove a scope's explicit `image` to enable its Dockerfile; changing
`pull_policy` alone does not disable discovery. Discovered images always use
`pull_policy = "never"`. Settings show the generated local reference, source scope
and a Dockerfile-path warning; unrelated settings saves do **not** persist the
generated reference. Do not copy effective settings into a policy file.

A minimal Dockerfile can derive from the bundled image (use the exact digest pin
returned by `msb_dockerfile_get`, not effective `msb_config_get` image, which may
be a generated local reference or custom image):

```dockerfile
FROM ghcr.io/hcohe/pi-microsandbox:1.1.0
RUN apt-get update && apt-get install -y --no-install-recommends jq \
    && rm -rf /var/lib/apt/lists/*
# COPY helper.sh /usr/local/bin/helper  # only from this scope's build-context/
```

Use a verified `@sha256:...` suffix for reproducibility; the tag above is only a
readable example. Custom images still need the required guest tools and Docker
components if runtime Docker is required.

### Build boundary and lifecycle

On activation (startup, enable or settings reload), the extension snapshots only
`Dockerfile` and the **contents of its dedicated `build-context/`**. That directory
becomes the context root for `COPY`; Dockerfile is staged at its root. No implicit
repository, TOML files, other projects, policy tree, host credentials, host Docker
socket, or runtime mounts/environment/secrets are supplied. Do not place secrets
in the dedicated context or Dockerfile: those bytes are deliberately build inputs.
`build-context/Dockerfile` is rejected to prevent overwriting the selected source.
All symlinks, multiply-linked regular files (hardlinks), special files and changing
inputs are rejected. Limits: 32 MiB total source bytes, 2,048 entries (including
Dockerfile/directories), 16 context nesting levels. A context is optional.

A separate disposable **rootful** Microsandbox VM runs the existing digest-pinned
bundled image with guest Docker/Buildx (2 CPUs, 4,096 MiB, 20-minute build cap).
Its independent explicit SDK Public network profile allows public downloads plus
gateway DNS, denies unmatched egress, and denies ingress. It does **not** inherit
runtime network restrictions: even a runtime configured `deny` needs public
registry/package downloads on an uncached build. No host/private allow profile,
published ports, registry credentials, pushes, host Docker, host build command,
`msb` CLI, cross-architecture emulation or cloud backend is used. Public egress is
not a guarantee against arbitrary exfiltration of the supplied build inputs.

Guest `docker buildx build --load` and `docker save` produce an archive. After
ownership-checked builder destruction, bounded streaming preflight accepts one
exact generated image reference and the native Linux architecture, and creates a
Docker-save-only archive without extra index/repository aliases. The host SDK's
`Image.load` imports that **tar file**, not a directory. The real runtime starts
from the generated local reference with **pull policy never**. SDK image digest,
OS and architecture must validate before a successful cache record is written.

Build cache records/locks live under `<Pi agent dir>/pi-microsandbox/build-cache/`;
finished images live in the local Microsandbox SDK cache, separate from guest
Docker. Inspection/config resolution creates neither cache nor builder. Cache
keys include exact source bytes, executable bits, native platform, builder image
pin and build implementation/options. Concurrent builds deduplicate with flock.
Unchanged inputs reuse a digest/platform-validated finished image. **Changing
Dockerfile/context content and reloading settings rebuilds**, and the image
identity invalidates VM reuse. Import completes before an existing runtime is
destroyed when possible; replacement loses guest-local state. Build failures and
built-image runtime validation/start failures **block routed execution even with
`fallback_mode = "host"`**; there is no automatic host build/execution fallback.
Errors intentionally omit build output to avoid leaking context data.

Mutable `FROM` tags and external package downloads are **not** refreshed while the
finished-image cache is reused. Prefer pinned dependencies. To explicitly refresh,
change a Dockerfile comment (not just its mtime) and reload settings. There is no
manual rebuild button or persistent guest layer cache in this MVP. Old generated
images are subject to ordinary Microsandbox image-cache management.

Export archives are limited to 16 GiB, 16,384 tar entries, and 1 MiB per metadata
file; links, special entries and unsupported tar extensions fail closed. Reserve
space for guest Docker storage **plus both original and sanitized host archives**
(up to 32 GiB of host archive bytes). The cap is an accepted-archive limit, not a
proactive disk quota. Disk exhaustion fails closed. Normal completion/failure and
cancellation clean temporary `/tmp/pi-msb-build-*` directories and owned builders;
if SDK destruction cannot be verified, output is retained rather than deleting
files a possibly running builder can access. A process crash can also leave
artifacts; builder lifetime is bounded, but host cleanup may be necessary. Guest
streams are aborted on timeout/session supersession/Off. The pinned SDK has no
cancellation API for create/import: late results are awaited before cleanup and
cannot activate a superseded runtime; those SDK calls may outlast the build cap.

An opt-in build/export/import/runtime roundtrip test is available on a supported
virtualization host (downloads/builds images; ordinary test skips are not proof):

```sh
PI_MSB_LIVE_BUILD_TEST=1 node --experimental-strip-types --import ./test/setup.ts \
  --test extensions/pi-msb/image-build-live.test.ts
```

The roundtrip has not been live-validated as part of this change; fake-SDK tests
cannot prove guest Docker, archive compatibility, network or SDK import behavior.

## Cloud CLIs from this branch

Want the new tools before the next published image cohort? From a **repository
checkout**, build a local base image on a supported host. This has the shared
runtime/cloud tools without Node.js, Python, Rust, or Go developer toolchains:

```sh
docker build \
  --file default-image/Dockerfile \
  --build-arg IMAGE_VARIANT=base \
  --build-arg TOOLCHAINS= \
  --tag pi-cloud-tools:dev \
  default-image
```

The build verifies tools without cloud credentials. Check the finished image
with networking disabled:

```sh
docker run --rm --network none pi-cloud-tools:dev gcloud version --quiet
docker run --rm --network none pi-cloud-tools:dev aws --version
docker run --rm --network none pi-cloud-tools:dev curl --version
```

Use the host Microsandbox CLI to load it into **Microsandbox's** image cache,
which is separate from Docker's:

```sh
docker save pi-cloud-tools:dev | msb load --tag pi-cloud-tools:local
```

Ask your agent:

> Propose this Project's image as pi-cloud-tools:local with pull_policy never,
> in one approved batch. Explain the VM restart and verify activation. Don't
> import my host cloud profiles or credentials.

Or save the equivalent host-owned TOML:

```toml
image = "pi-cloud-tools:local"
pull_policy = "never"
```

For language toolchains too, build the `default` variant instead, with
`IMAGE_VARIANT=default` and `TOOLCHAINS="node python rust go"`. CLI installation
is **not authentication**: configure credentials deliberately. Start with the
[keyless, read-only Google Cloud recipe](google-cloud.md). AWS credentials and
permissions likewise remain your responsibility; no host `.aws` directory is
copied or mounted automatically.

## How the images are assembled

[`default-image/variants.json`](../default-image/variants.json) is the single
source of variant composition and tag names. The workflow passes each entry's
toolchain list to one generic
[`default-image/Dockerfile`](../default-image/Dockerfile). The common Docker,
Google Cloud CLI, and AWS CLI installers run before the modular `default-image/install/<language>.sh` scripts. curl is retained as a
runtime tool, not removed after downloads. The common verifier checks Docker,
its plugins, cloud CLI versions/offline configuration, and a local curl transfer
in every variant; language verifiers then exercise each selected toolchain.
Cloud CLIs include no credentials or profiles. Their private bundled Python
runtimes do not add `python`/`python3` to the language-free base's PATH.
The final image sets `CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE` and `AWS_CA_BUNDLE` to
`/etc/ssl/certs/ca-certificates.crt`: both clients follow the system trust store
when Microsandbox adds its runtime CA, without disabling TLS verification.

The `default` variant runs the same Node.js, Python, Rust, and Go modules as the
individual variants. It does not have a duplicate package list. This keeps an
installer, its functional checks, and every image that uses it aligned.

Release builds pin the Ubuntu multi-platform image digest and a dated Ubuntu apt
snapshot shared by every variant. The snapshot pin applies only while the image
is assembled. Published images restore Ubuntu's normal apt sources so projects
can install current packages at runtime.

## Build a custom image

A custom image must provide `bash`, `sh`, `rg`, `file`, `cat`, `mkdir`, and
`rm`. Git is a useful developer tool and remains in the published images, but
workspace setup no longer requires it inside the guest. Docker is optional for
custom images. The default `docker.mode = "auto"` records it as missing and
continues; use `docker.mode = "require"` when the image contract must include a
working daemon. pi-microsandbox does not install Docker during sandbox startup.
Install Git and CA certificates if guest commands need Git over HTTPS. With
`bootstrap_tools = "auto"`, pi-microsandbox can install missing required
commands through `apt-get` when the network policy permits it. A prepared image
is required when bootstrap is disabled or package repositories are unavailable.

Microsandbox supports registry images and images loaded into its own local
cache. Images in the Docker daemon are not automatically visible to
Microsandbox.

### Publish to an OCI registry

Start from a versioned base tag so the guest contract does not change when
`main` is rebuilt:

```dockerfile
FROM ghcr.io/hcohe/pi-microsandbox:base-1.1.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends jq \
    && rm -rf /var/lib/apt/lists/*
```

Build and push for the current host architecture with Docker:

```sh
docker build -t registry.example.com/team/pi-image:1.0.0 .
docker push registry.example.com/team/pi-image:1.0.0
```

Or publish both supported architectures with Buildx:

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag registry.example.com/team/pi-image:1.0.0 \
  --push .
```

Then select it in `~/.pi/agent/pi-microsandbox/default.toml` or a
[host-owned project override](configuration.md#host-owned-project-overrides):

```toml
image = "registry.example.com/team/pi-image:1.0.0"
pull_policy = "if-missing"
```

For a private registry, configure authentication on the host with Microsandbox,
for example with `msb registry login`, or in
`~/.microsandbox/config.json`. Registry pull credentials belong in
Microsandbox configuration, not in pi-microsandbox guest `secrets`. See the
Microsandbox [image guide](https://docs.microsandbox.dev/images/overview) and
[configuration reference](https://docs.microsandbox.dev/configuration).

### Load a local Docker image

Build the image, then transfer a Docker archive into the Microsandbox cache and
assign a local tag:

```sh
docker build -t pi-image:dev .
docker save pi-image:dev | msb load --tag pi-image:local
```

The file form is useful when a pipeline cannot be used:

```sh
docker save -o pi-image.tar pi-image:dev
msb load --input pi-image.tar --tag pi-image:local
```

Use the local reference without contacting a registry:

```toml
image = "pi-image:local"
pull_policy = "never"
```

`pull_policy = "if-missing"` also uses the loaded image while it remains in the
cache, but may try a registry if it is removed. The Microsandbox
[local image guide](https://docs.microsandbox.dev/examples/docker/local-images)
documents the same transfer requirement and `msb load` forms.

## Add a language variant

A new language needs all three of these changes:

1. Add an executable `default-image/install/<language>.sh`.
2. Add an executable `default-image/verify/<language>.sh`.
3. Add the variant and its toolchain composition to
   `default-image/variants.json`.

Names become filenames and image tags. Use at most 48 characters: start with a
lowercase letter, then use only lowercase letters, digits, and hyphens. Do not
use path syntax, underscores, or the reserved names `base`, `default`,
`dispatch`, or a name beginning with `_`.

Pin downloaded tool versions, including bootstrap installers such as rustup
(currently 1.29.1). Use versioned archive URLs rather than mutable latest-download
URLs so the artifact continues to match its pinned checksum. Checksum failures
report the download URL and expected SHA-256 and stop the build; do not bypass
verification to fix a failed download. Record and verify SHA-256 checksums for
both AMD64 and ARM64 artifacts, using the helpers in `install/_common.sh`. Do not pipe
network downloads into a shell. The verifier must test native functionality,
not only version output. For example, compile and run a native extension or a
small program. Add the language to the `default` variant's `toolchains` only if
it should become part of the complete image; do not copy its packages into a
second default-only installer.

Validate metadata and shell scripts locally:

```sh
node scripts/image-variants.mjs matrix
shellcheck -e SC1091 default-image/install/*.sh default-image/verify/*.sh
```

Build a representative variant with the same context and build arguments as CI.
The Dockerfile runs its functional verifier during the build:

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg IMAGE_VARIANT=node \
  --build-arg "TOOLCHAINS=node" \
  --build-arg IMAGE_VERSION=dev \
  --file default-image/Dockerfile \
  default-image
```

Repeat with the new variant and its exact space-separated toolchain composition.
Build the `default` variant too if its composition changed.
