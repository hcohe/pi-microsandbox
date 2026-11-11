#!/usr/bin/env bash

set -euo pipefail

verify_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${verify_dir}/_common.sh"

if (( $# != 0 )); then
    printf 'The default image always verifies Node.js, Python, Rust, and Go; no arguments are supported\n' >&2
    exit 1
fi

for toolchain in node python rust go; do
    verifier="${verify_dir}/${toolchain}.sh"
    if [[ ! -f "${verifier}" || ! -x "${verifier}" || -L "${verifier}" ]]; then
        printf 'No executable verifier for toolchain: %s\n' "${toolchain}" >&2
        exit 1
    fi
done

verify_base_contract
for toolchain in node python rust go; do
    "${verify_dir}/${toolchain}.sh"
done
