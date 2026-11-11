#!/usr/bin/env bash

set -euo pipefail

verify_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "${verify_dir}/dispatch.sh" "$@"
