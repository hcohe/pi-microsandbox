#!/usr/bin/env bash

set -euo pipefail

install_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${install_dir}/_common.sh"

uv_version="0.12.12"

if command -v python >/dev/null 2>&1 \
    && command -v python3-config >/dev/null 2>&1 \
    && command -v pip >/dev/null 2>&1 \
    && command -v uv >/dev/null 2>&1 \
    && [[ "$(uv --version)" == "uv ${uv_version}" ]] \
    && command -v uvx >/dev/null 2>&1 \
    && command -v cc >/dev/null 2>&1; then
    exit 0
fi

arch="$(target_arch)"
case "${arch}" in
    amd64)
        uv_arch="x86_64"
        uv_sha256="ab9b309d4586403f024e100abaceb396616e178a553e2500c36087d180f09509"
        ;;
    arm64)
        uv_arch="aarch64"
        uv_sha256="fe08db50cc1b56cd1da7801065ed1103d27ed3f9571cd122386cfc7faf1b8df5"
        ;;
esac

apt_install \
    build-essential \
    pkg-config \
    python-is-python3 \
    python3-dev \
    python3-pip \
    python3-venv

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT
archive="${tmp_dir}/uv.tar.gz"
fetch_verified \
    "https://github.com/astral-sh/uv/releases/download/${uv_version}/uv-${uv_arch}-unknown-linux-gnu.tar.gz" \
    "${uv_sha256}" \
    "${archive}"

tar -xzf "${archive}" -C "${tmp_dir}"
install -m 0755 "${tmp_dir}/uv-${uv_arch}-unknown-linux-gnu/uv" /usr/local/bin/uv
install -m 0755 "${tmp_dir}/uv-${uv_arch}-unknown-linux-gnu/uvx" /usr/local/bin/uvx
ln -sfn /usr/bin/pip3 /usr/local/bin/pip
cleanup_apt
