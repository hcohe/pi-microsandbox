#!/usr/bin/env bash

set -euo pipefail

install_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
toolchains="${1-}"
# shellcheck source=_common.sh
source "${install_dir}/_common.sh"

# Names become filenames, so reject path syntax before parsing the list.
if [[ "${toolchains}" == *"/"* \
    || "${toolchains}" == *"\\"* \
    || "${toolchains}" == *".."* ]]; then
    printf 'Path syntax is not allowed in toolchain names: %s\n' "${toolchains}" >&2
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

    installer="${install_dir}/${toolchain}.sh"
    if [[ ! -f "${installer}" || ! -x "${installer}" || -L "${installer}" ]]; then
        printf 'No executable installer for toolchain: %s\n' "${toolchain}" >&2
        exit 1
    fi
    requested["${toolchain}"]=1
done

if (( ${#requested[@]} > 0 )); then
    # Fail before downloading anything when the target platform is unsupported.
    target_arch >/dev/null
fi

for toolchain in ${toolchains}; do
    "${install_dir}/${toolchain}.sh"
done

# curl is part of the shared base contract and remains available at runtime.
# All compilers and headers installed by selected toolchains remain available.
cleanup_apt
