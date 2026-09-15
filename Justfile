set positional-arguments

# List available development recipes without starting virtualization.
default:
    @just --list

# Build the current default image and load it into Microsandbox's local cache.
dev-image:
    #!/usr/bin/env bash
    set -euo pipefail
    image="pi-microsandbox-dev:local"
    docker build \
      --tag "${image}" \
      --build-arg IMAGE_VARIANT=default \
      --build-arg "TOOLCHAINS=node python rust go" \
      --build-arg IMAGE_VERSION=dev \
      --file default-image/Dockerfile \
      default-image
    docker save "${image}" | msb load --tag "${image}"

# Build and smoke-test the native owner-lock addon for this host.
dev-flock:
    @npm run build:flock
    @npm run smoke:flock

# Build local prerequisites, then start Pi with this checkout's extension.
dev *args: dev-flock dev-image
    #!/usr/bin/env bash
    set -euo pipefail
    export PI_MSB_IMAGE="pi-microsandbox-dev:local"
    export PI_MSB_PULL_POLICY=never
    export PI_MSB_BOOTSTRAP_TOOLS=false
    export PI_MSB_DOCKER__MODE=require
    export PI_MSB_DOCKER__STARTUP_TIMEOUT_MS=30000
    export PI_MSB_CPUS=4
    export PI_MSB_MEMORY_MIB=8192
    exec pi --extension . "$@"

# Measure repeated sandbox startup and enforce the boot-time regression limit.
test-boot-speed:
    @node --experimental-strip-types scripts/test-boot-speed.mjs
