#!/usr/bin/env bash

set -euo pipefail

verify_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${verify_dir}/_common.sh"

require_commands cc go

[[ "$(go version)" == "go version go1.26."* ]]

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT
cat > "${tmp_dir}/go.mod" <<'MOD'
module verify.invalid/native

go 1.26
MOD
cat > "${tmp_dir}/main.go" <<'GO'
package main

/*
int answer(void) { return 42; }
*/
import "C"

import "fmt"

func main() {
	fmt.Println(C.answer())
}
GO
(
    cd "${tmp_dir}"
    CGO_ENABLED=1 go build -o probe .
)
[[ "$("${tmp_dir}/probe")" == "42" ]]
