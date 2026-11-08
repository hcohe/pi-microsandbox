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

If `image` is omitted, pi-microsandbox uses the configured `default` variant
release, qualified by both its `VERSION` tag and immutable index digest. Image
versions are independent of the installed package version. If `pull_policy` is
omitted, `"if-missing"` is used: Microsandbox pulls the image only when that
exact reference is absent from its cache. Use `"always"` to check a registry for
an updated mutable tag, or `"never"` to require a cached local image.

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
