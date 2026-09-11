#!/usr/bin/env bash

set -euo pipefail

verify_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
variant="${1-}"
toolchains="${2-}"
# shellcheck source=_common.sh
source "${verify_dir}/_common.sh"

if [[ "${variant}" == *"/"* \
    || "${variant}" == *"\\"* \
    || "${variant}" == *".."* \
    || "${toolchains}" == *"/"* \
    || "${toolchains}" == *"\\"* \
    || "${toolchains}" == *".."* ]]; then
    printf 'Path syntax is not allowed in variant or toolchain names\n' >&2
    exit 1
fi
case "${variant}" in
    dispatch|_*)
        printf 'Reserved variant name: %s\n' "${variant}" >&2
        exit 1
        ;;
esac
if [[ ! "${variant}" =~ ^[a-z][a-z0-9-]*$ ]]; then
    printf 'Invalid variant name: %s\n' "${variant}" >&2
    exit 1
fi
if [[ "${toolchains}" =~ [^[:space:]a-z0-9_-] ]]; then
    printf 'Invalid toolchain list: %s\n' "${toolchains}" >&2
    exit 1
fi

declare -A requested=()
for toolchain in ${toolchains}; do
    case "${toolchain}" in
        dispatch|_*|base|default)
            printf 'Reserved toolchain name: %s\n' "${toolchain}" >&2
            exit 1
            ;;
    esac
    if [[ ! "${toolchain}" =~ ^[a-z][a-z0-9-]*$ ]]; then
        printf 'Invalid toolchain name: %s\n' "${toolchain}" >&2
        exit 1
    fi
    if [[ -n "${requested[${toolchain}]:-}" ]]; then
        printf 'Duplicate toolchain: %s\n' "${toolchain}" >&2
        exit 1
    fi

    verifier="${verify_dir}/${toolchain}.sh"
    if [[ ! -f "${verifier}" || ! -x "${verifier}" || -L "${verifier}" ]]; then
        printf 'No executable verifier for toolchain: %s\n' "${toolchain}" >&2
        exit 1
    fi
    requested["${toolchain}"]=1
done

if [[ "${variant}" == "base" && ${#requested[@]} -ne 0 ]]; then
    printf 'The base variant cannot include toolchains\n' >&2
    exit 1
fi
if [[ "${variant}" != "base" && ${#requested[@]} -eq 0 ]]; then
    printf 'Variant %s must include at least one toolchain\n' "${variant}" >&2
    exit 1
fi

export IMAGE_VARIANT="${variant}"
export TOOLCHAINS="${toolchains}"

if (( ${#requested[@]} == 0 )); then
    "${verify_dir}/base.sh"
    exit 0
fi

# The dispatcher owns the inherited base contract; community verifier scripts
# only need to test their language-specific commands and functionality.
verify_base_contract
for toolchain in ${toolchains}; do
    "${verify_dir}/${toolchain}.sh"
done
