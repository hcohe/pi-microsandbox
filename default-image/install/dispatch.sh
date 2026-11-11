#!/usr/bin/env bash

set -euo pipefail

install_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${install_dir}/_common.sh"

if (( $# != 0 )); then
    printf 'The default image always installs Node.js, Python, Rust, and Go; no arguments are supported\n' >&2
    exit 1
fi

# Fail before downloading anything when the target platform is unsupported.
target_arch >/dev/null
for toolchain in node python rust go; do
    installer="${install_dir}/${toolchain}.sh"
    if [[ ! -f "${installer}" || ! -x "${installer}" || -L "${installer}" ]]; then
        printf 'No executable installer for toolchain: %s\n' "${toolchain}" >&2
        exit 1
    fi
done

for toolchain in node python rust go; do
    "${install_dir}/${toolchain}.sh"
done

# Keep curl, compilers, and headers available at runtime.
cleanup_apt
