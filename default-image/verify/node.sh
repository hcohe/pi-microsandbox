#!/usr/bin/env bash

set -euo pipefail

verify_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${verify_dir}/_common.sh"

require_commands c++ corepack make node npm npx pnpm python3 yarn

[[ "$(node --version)" == v24.* ]]
[[ "$(pnpm --version)" == "12.3.4" ]]
[[ "$(yarn --version)" == "1.22.22" ]]
[[ "$(node -e 'process.stdout.write(String(6 * 7))')" == "42" ]]

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT
cat > "${tmp_dir}/addon.cc" <<'CPP'
#include <node_api.h>

napi_value Init(napi_env env, napi_value exports) {
    napi_value answer;
    napi_create_int32(env, 42, &answer);
    napi_set_named_property(env, exports, "answer", answer);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
CPP
c++ -shared -fPIC -std=c++17 -I/usr/local/include/node \
    "${tmp_dir}/addon.cc" -o "${tmp_dir}/addon.node"
node -e "if (require('${tmp_dir}/addon.node').answer !== 42) process.exit(1)"
