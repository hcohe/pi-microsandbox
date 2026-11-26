#!/usr/bin/env bash

set -euo pipefail

verify_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${verify_dir}/_common.sh"

require_commands aws aws_completer
test "${AWS_CA_BUNDLE:-}" = '/etc/ssl/certs/ca-certificates.crt'
test -s "${AWS_CA_BUNDLE}"
# --version does not load credentials or contact AWS services.
aws --version | grep -Eq '^aws-cli/2\.39\.6 '
test "$(readlink -f "$(command -v aws)")" = '/usr/local/aws-cli/v2/2.39.6/dist/aws'
test ! -e /root/.aws
