#!/usr/bin/env bash

set -euo pipefail

install_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${install_dir}/_common.sh"

rust_version="1.98.0"
export CARGO_HOME=/usr/local/cargo
export RUSTUP_HOME=/usr/local/rustup
export PATH="${CARGO_HOME}/bin:${PATH}"

if command -v rustc >/dev/null 2>&1 \
    && [[ "$(rustc --version)" == "rustc ${rust_version} "* ]] \
    && command -v cargo >/dev/null 2>&1 \
    && command -v cc >/dev/null 2>&1 \
    && command -v pkg-config >/dev/null 2>&1; then
    exit 0
fi

arch="$(target_arch)"
case "${arch}" in
    amd64)
        rust_arch="x86_64"
        rustup_sha256="dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71"
        ;;
    arm64)
        rust_arch="aarch64"
        rustup_sha256="15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433"
        ;;
esac

apt_install build-essential libssl-dev pkg-config

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT
rustup_init="${tmp_dir}/rustup-init"
fetch_verified \
    "https://static.rust-lang.org/rustup/dist/${rust_arch}-unknown-linux-gnu/rustup-init" \
    "${rustup_sha256}" \
    "${rustup_init}"
chmod 0755 "${rustup_init}"
"${rustup_init}" \
    --default-toolchain "${rust_version}" \
    --no-modify-path \
    --profile minimal \
    --yes
chmod -R a+rX "${CARGO_HOME}" "${RUSTUP_HOME}"
rm -rf "${CARGO_HOME}/registry" /root/.rustup
cleanup_apt
