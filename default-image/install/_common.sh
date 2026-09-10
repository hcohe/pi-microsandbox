#!/usr/bin/env bash

set -euo pipefail

apt_install() {
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

cleanup_apt() {
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
}

install_downloader() {
    if ! command -v curl >/dev/null 2>&1; then
        apt_install curl
    fi
}

target_arch() {
    local arch="${TARGETARCH:-}"

    if [[ -z "${arch}" ]]; then
        arch="$(dpkg --print-architecture)"
    fi

    case "${arch}" in
        amd64|arm64)
            printf '%s\n' "${arch}"
            ;;
        *)
            printf 'Unsupported architecture: %s\n' "${arch}" >&2
            return 1
            ;;
    esac
}

fetch_verified() {
    local url="$1"
    local sha256="$2"
    local destination="$3"

    install_downloader
    curl --fail --location --proto '=https' --show-error --silent \
        "${url}" --output "${destination}"
    printf '%s  %s\n' "${sha256}" "${destination}" | sha256sum --check --status
}
