#!/usr/bin/env bash

set -euo pipefail

install_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${install_dir}/_common.sh"

node_version="24.21.0"
pnpm_version="12.3.4"
yarn_version="1.22.22"

if command -v node >/dev/null 2>&1 \
    && [[ "$(node --version)" == "v${node_version}" ]] \
    && command -v pnpm >/dev/null 2>&1 \
    && [[ "$(pnpm --version)" == "${pnpm_version}" ]] \
    && command -v yarn >/dev/null 2>&1 \
    && [[ "$(yarn --version)" == "${yarn_version}" ]] \
    && command -v c++ >/dev/null 2>&1 \
    && command -v make >/dev/null 2>&1 \
    && command -v python3 >/dev/null 2>&1; then
    exit 0
fi

arch="$(target_arch)"
case "${arch}" in
    amd64)
        node_arch="x64"
        node_sha256="6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff"
        ;;
    arm64)
        node_arch="arm64"
        node_sha256="724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5"
        ;;
esac

apt_install build-essential python3 pkg-config

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT
archive="${tmp_dir}/node.tar.gz"
fetch_verified \
    "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-${node_arch}.tar.gz" \
    "${node_sha256}" \
    "${archive}"

tar -xzf "${archive}" -C /usr/local --strip-components=1
npm install --global --force "pnpm@${pnpm_version}" "yarn@${yarn_version}"
npm cache clean --force
rm -rf /root/.npm
cleanup_apt
