# Images

[Back to README](../README.md)

pi-microsandbox publishes six Ubuntu 26.04 image variants at
`ghcr.io/hcohe/pi-microsandbox`. Every tag is a Linux multi-platform image for
AMD64 and ARM64.

## Published variants

`VERSION` below is the independent image version, such as `1.0.0`. Release
tags are write-once. Latest tags are mutable development tags built from `main`.
Push an exact `image-vVERSION` Git tag to publish a release cohort. Package
`vX.Y.Z` tags do not invoke image builds, and manual workflow runs validate only.

| Variant | Contents | Release tag | Latest tag |
| --- | --- | --- | --- |
| `base` | Required guest commands and CA certificates, without a language toolchain | `base-VERSION` | `base-latest` |
| `node` | Base plus Node.js 24.21.0, npm, pnpm 12.3.4, Yarn 1.22.22, and native addon build support | `node-VERSION` | `node-latest` |
| `python` | Base plus Ubuntu Python 3, pip, uv/uvx 0.12.12, and native extension build support | `python-VERSION` | `python-latest` |
| `rust` | Base plus Rust 1.98.0, Cargo, rustup, and native dependency build support | `rust-VERSION` | `rust-latest` |
| `go` | Base plus Go 1.26.8 and cgo build support | `go-VERSION` | `go-latest` |
| `default` | Base plus the Node.js, Python, Rust, and Go modules above | `VERSION` | `latest` |

The base contract includes `bash`, `sh`, `git`, `rg`, `file`, `cat`, `mkdir`,
`rm`, and the other core commands used by the image verification scripts. CA
certificates support HTTPS Git operations.

Select a variant in trusted project configuration:

```toml
# .pi-msb.toml
image = "ghcr.io/hcohe/pi-microsandbox:python-1.0.0"
pull_policy = "if-missing"
```

If `image` is omitted, pi-microsandbox uses the configured `default` variant
release, qualified by both its `VERSION` tag and immutable index digest. Image
versions are independent of the installed package version. If `pull_policy` is
omitted, `"if-missing"` is used: Microsandbox pulls the image only when that
exact reference is absent from its cache. Use `"always"` to check a registry for
an updated mutable tag, or `"never"` to require a cached local image.

## How the images are assembled

[`default-image/variants.json`](../default-image/variants.json) is the single
source of variant composition and tag names. The workflow passes each entry's
toolchain list to one generic
[`default-image/Dockerfile`](../default-image/Dockerfile). Modular
`default-image/install/<language>.sh` and
`default-image/verify/<language>.sh` scripts install and exercise each selected
language.

The `default` variant runs the same Node.js, Python, Rust, and Go modules as the
individual variants. It does not have a duplicate package list. This keeps an
installer, its functional checks, and every image that uses it aligned.

Release builds pin the Ubuntu multi-platform image digest and a dated Ubuntu apt
snapshot shared by every variant. The snapshot pin applies only while the image
is assembled. Published images restore Ubuntu's normal apt sources so projects
can install current packages at runtime.

## Build a custom image

A custom image must provide `bash`, `sh`, `git`, `rg`, `file`, `cat`, `mkdir`,
and `rm`. Install CA certificates if the guest will use Git over HTTPS. With
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
FROM ghcr.io/hcohe/pi-microsandbox:base-1.0.0

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

Then select it in `.pi-msb.toml`:

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

Pin downloaded tool versions. Record and verify SHA-256 checksums for both AMD64
and ARM64 artifacts, using the helpers in `install/_common.sh`. Do not pipe
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
