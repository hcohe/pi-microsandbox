#!/usr/bin/env bash

set -euo pipefail

install_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${install_dir}/_common.sh"

go_version="1.26.8"
export PATH="/usr/local/go/bin:${PATH}"

if command -v go >/dev/null 2>&1 \
    && [[ "$(go version)" == "go version go${go_version} "* ]] \
    && command -v cc >/dev/null 2>&1; then
    exit 0
fi

arch="$(target_arch)"
case "${arch}" in
    amd64)
        go_sha256="d0f743b33e8d8945e6b1f432edd15785c70507121d6e2a723b21285eddf8b57b"
        ;;
    arm64)
        go_sha256="211ffced9dcb9633a55eac6364816ec0ddd951389a740e88fa8b3337971bdda0"
        ;;
esac

apt_install build-essential

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT
archive="${tmp_dir}/go.tar.gz"
fetch_verified \
    "https://go.dev/dl/go${go_version}.linux-${arch}.tar.gz" \
    "${go_sha256}" \
    "${archive}"

rm -rf /usr/local/go
tar -xzf "${archive}" -C /usr/local
install -d -m 1777 /go /go/bin /go/pkg
cleanup_apt
