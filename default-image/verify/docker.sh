#!/usr/bin/env bash

set -euo pipefail

verify_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${verify_dir}/_common.sh"

verify_docker_contract() {
    require_commands containerd containerd-shim-runc-v2 ctr docker docker-init \
        docker-proxy dockerd flock iptables nft pi-msb-docker-start runc sysctl

    docker --version | grep -Fq 'Docker version 29.8.0'
    dockerd --version | grep -Fq 'Docker version 29.8.0'
    containerd --version | grep -Fq 'v2.3.4'
    runc --version | grep -Fq '1.5.1'
    iptables --version | grep -Fq 'v1.8.11 (nf_tables)'
    nft --version | grep -Fq 'v1.1.6'
    docker buildx version | grep -Fq 'v0.37.1'
    docker compose version | grep -Fq 'v5.5.1'

    dpkg-query --status iptables nftables procps util-linux >/dev/null
    local executable
    for executable in \
        /usr/local/bin/containerd \
        /usr/local/bin/containerd-shim-runc-v2 \
        /usr/local/bin/ctr \
        /usr/local/bin/docker \
        /usr/local/bin/docker-init \
        /usr/local/bin/docker-proxy \
        /usr/local/bin/dockerd \
        /usr/local/bin/runc \
        /usr/local/libexec/docker/cli-plugins/docker-buildx \
        /usr/local/libexec/docker/cli-plugins/docker-compose \
        /usr/local/sbin/pi-msb-docker-start; do
        test "$(stat -c '%U:%G:%a' "${executable}")" = 'root:root:755'
    done

    if pgrep -x dockerd >/dev/null; then
        printf 'Docker daemon must not run during image assembly\n' >&2
        return 1
    fi
    test ! -e /var/run/docker.sock
    test ! -e /run/docker.pid
    test ! -e /var/lib/docker
    test -z "$(find /tmp /root -maxdepth 3 -type f \
        \( -name 'docker*.tgz' -o -name 'docker-buildx' -o -name 'docker-compose' \) -print -quit)"
    test -z "$(find /var/lib/apt/lists /var/cache/apt/archives -mindepth 1 -print -quit 2>/dev/null)"
}

verify_docker_contract
