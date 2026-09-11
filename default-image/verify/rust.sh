#!/usr/bin/env bash

set -euo pipefail

verify_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${verify_dir}/_common.sh"

require_commands cargo cc pkg-config rustc rustup

[[ "$(rustc --version)" == "rustc 1.98.0 "* ]]

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT
cat > "${tmp_dir}/main.rs" <<'RS'
fn main() {
    println!("{}", 6 * 7);
}
RS
rustc "${tmp_dir}/main.rs" -o "${tmp_dir}/probe"
[[ "$("${tmp_dir}/probe")" == "42" ]]
