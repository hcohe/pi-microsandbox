#!/usr/bin/env bash

set -euo pipefail

install_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${install_dir}/_common.sh"

readonly aws_version=2.39.6

# SHA-256 pins of the official archives, verified against their detached
# signatures with AWS CLI Team key FB5DB77FD5C118B80511ADA8A6310ACC4672475C.
# Key and verification instructions:
# https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
arch="$(target_arch)"
case "${arch}" in
    amd64)
        aws_arch=x86_64
        aws_sha256=7a121264f2637a3b90767aaf5bdd43ee88b8c925a931d0479fa2ce22b1a2fa76
        ;;
    arm64)
        aws_arch=aarch64
        aws_sha256=5763332bdcb432c19ee122545856fd350c3bb306753212deedcfccc76f4d20c3
        ;;
esac

apt_install unzip

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "${tmp_dir}"' EXIT
archive="${tmp_dir}/aws.zip"
fetch_verified \
    "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}-${aws_version}.zip" \
    "${aws_sha256}" \
    "${archive}"
unzip -q "${archive}" -d "${tmp_dir}"
"${tmp_dir}/aws/install" --install-dir /usr/local/aws-cli --bin-dir /usr/local/bin
DEBIAN_FRONTEND=noninteractive apt-get purge -y unzip
DEBIAN_FRONTEND=noninteractive apt-get autoremove -y
cleanup_apt
