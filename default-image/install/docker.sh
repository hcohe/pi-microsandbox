#!/usr/bin/env bash

set -euo pipefail

install_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${install_dir}/_common.sh"

readonly docker_version=29.8.0
readonly buildx_version=0.37.1
readonly compose_version=5.5.1

arch="$(target_arch)"
case "${arch}" in
    amd64)
        docker_arch=x86_64
        docker_sha256=cc21815cf1e2efed867dc9c8b96b46ffed8ea176ffab32b0aacb54726ded8f25
        buildx_arch=amd64
        buildx_sha256=9447199cdb435f25880548343c128a4b6650e8891ee598905d8d29d39a8e359b
        compose_arch=x86_64
        compose_sha256=db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576
        ;;
    arm64)
        docker_arch=aarch64
        docker_sha256=1462a696be6029bd478d7d60d7f3c31cdd15affd1178a4a278aaf4a1d1b7f8b5
        buildx_arch=arm64
        buildx_sha256=e5cc9fe3bbff5cbc91230981f7860e06076110730a2db997082652199042a1f2
        compose_arch=aarch64
        compose_sha256=732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7
        ;;
esac

apt_install iptables nftables procps util-linux

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "${tmp_dir}"' EXIT
archive="${tmp_dir}/docker.tgz"
fetch_verified \
    "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${docker_version}.tgz" \
    "${docker_sha256}" \
    "${archive}"
tar -xzf "${archive}" -C "${tmp_dir}"
for binary in containerd containerd-shim-runc-v2 ctr docker docker-init docker-proxy dockerd runc; do
    install -o root -g root -m 0755 "${tmp_dir}/docker/${binary}" "/usr/local/bin/${binary}"
done

plugin_dir=/usr/local/libexec/docker/cli-plugins
install -d -o root -g root -m 0755 "${plugin_dir}"
fetch_verified \
    "https://github.com/docker/buildx/releases/download/v${buildx_version}/buildx-v${buildx_version}.linux-${buildx_arch}" \
    "${buildx_sha256}" \
    "${tmp_dir}/docker-buildx"
install -o root -g root -m 0755 "${tmp_dir}/docker-buildx" "${plugin_dir}/docker-buildx"
fetch_verified \
    "https://github.com/docker/compose/releases/download/v${compose_version}/docker-compose-linux-${compose_arch}" \
    "${compose_sha256}" \
    "${tmp_dir}/docker-compose"
install -o root -g root -m 0755 "${tmp_dir}/docker-compose" "${plugin_dir}/docker-compose"

install -o root -g root -m 0755 "${install_dir}/docker-start.sh" /usr/local/sbin/pi-msb-docker-start
cleanup_apt
