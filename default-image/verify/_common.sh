#!/usr/bin/env bash

set -euo pipefail

require_commands() {
    local command_name
    for command_name in "$@"; do
        if ! command -v "${command_name}" >/dev/null 2>&1; then
            printf 'Required command is missing: %s\n' "${command_name}" >&2
            return 1
        fi
    done
}

verify_base_contract() {
    require_commands \
        bash basename cat chmod cp cut date dirname env file git head id ln ls \
        mkdir mktemp mv pwd readlink rg rm rmdir sh sleep sort tail tee test \
        touch tr uname update-ca-certificates wc

    dpkg-query --status ca-certificates file git ripgrep >/dev/null
    test ! -e /opt/pi-image-install

    local tmp_dir
    tmp_dir="$(mktemp -d)"
    printf 'pi-microsandbox\n' > "${tmp_dir}/contract.txt"
    rg -q 'pi-microsandbox' "${tmp_dir}/contract.txt"
    rg -q 'microsandbox' "${tmp_dir}/contract.txt"
    file "${tmp_dir}/contract.txt" | rg -q 'text'
    rm -rf "${tmp_dir}"
}

verify_no_language_toolchains() {
    local command_name
    for command_name in \
        cargo corepack go node npm npx pip pip3 pnpm python python3 rustc rustup \
        uv uvx yarn; do
        if command -v "${command_name}" >/dev/null 2>&1; then
            printf 'Base image unexpectedly contains language command: %s\n' \
                "${command_name}" >&2
            return 1
        fi
    done
}
