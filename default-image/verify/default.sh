#!/usr/bin/env bash

set -euo pipefail

verify_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
toolchains="${1-${TOOLCHAINS-}}"

# Keep the convenience entry point, but derive composition from the same
# TOOLCHAINS value supplied to the generic build and verifier.
exec "${verify_dir}/dispatch.sh" default "${toolchains}"
