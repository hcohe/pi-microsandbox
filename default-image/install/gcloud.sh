#!/usr/bin/env bash

set -euo pipefail

install_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${install_dir}/_common.sh"

readonly gcloud_version=592.0.0

# Official versioned archives: https://cloud.google.com/sdk/docs/downloads-versioned-archives
# These archives have identical member contents, modes, and symlinks to the
# 592.0.0 unversioned archives whose SHA-256 Google publishes on that page
# (amd64: 16fda6058d66e4ec29e8575e2b6e19b0d03cea7b091e6730f7e8361209e6955f;
# arm64: cc584dabf7b1f7ba79354744027b6de654ff6876c03dffb2174c1b1e3c0c6956).
arch="$(target_arch)"
case "${arch}" in
    amd64)
        gcloud_arch=x86_64
        gcloud_sha256=2d841a23a681ab94486af6841e5f1cd123cd300fb8c4be6ba5b51350fca3d50b
        ;;
    arm64)
        gcloud_arch=arm
        gcloud_sha256=ba588759c4c42122a8c14536009738c0f0030989ca75788235f9956555e44f4d
        ;;
esac

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "${tmp_dir}"' EXIT
archive="${tmp_dir}/gcloud.tar.gz"
fetch_verified \
    "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-${gcloud_version}-linux-${gcloud_arch}.tar.gz" \
    "${gcloud_sha256}" \
    "${archive}"

# The self-contained archive includes its own Python on both architectures.
# Expose only gcloud, not the private interpreter or unrelated SDK commands.
install -d -o root -g root -m 0755 /opt
tar -xzf "${archive}" -C /opt --no-same-owner
test "$(cat /opt/google-cloud-sdk/VERSION)" = "${gcloud_version}"
ln -s /opt/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud
cleanup_apt
