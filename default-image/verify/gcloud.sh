#!/usr/bin/env bash

set -euo pipefail

verify_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${verify_dir}/_common.sh"

require_commands gcloud
test "$(cat /opt/google-cloud-sdk/VERSION)" = '592.0.0'
test "$(readlink -f "$(command -v gcloud)")" = '/opt/google-cloud-sdk/bin/gcloud'
test -x /opt/google-cloud-sdk/platform/bundledpythonunix/bin/python3
test "${CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE:-}" = '/etc/ssl/certs/ca-certificates.crt'
test -s "${CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE}"

# Local-only probes: no authentication, update checks, or persisted user config.
tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "${tmp_dir}"' EXIT
export CLOUDSDK_CONFIG="${tmp_dir}/gcloud"
export CLOUDSDK_CORE_DISABLE_USAGE_REPORTING=true
export CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK=true
export CLOUDSDK_AUTH_DISABLE_CREDENTIALS=true
export CLOUDSDK_CORE_DISABLE_PROMPTS=true
gcloud version --quiet
gcloud config list --format=json --quiet

# The bundled Requests stack otherwise uses certifi rather than the runtime
# system bundle. Check its actual selection without making a network request.
PYTHONPATH=/opt/google-cloud-sdk/lib:/opt/google-cloud-sdk/lib/third_party \
    /opt/google-cloud-sdk/platform/bundledpythonunix/bin/python3 - <<'PY'
from googlecloudsdk.core import properties, requests

bundle = "/etc/ssl/certs/ca-certificates.crt"
assert properties.VALUES.core.custom_ca_certs_file.Get() == bundle
assert requests._CreateRawSession().verify == bundle
PY

test ! -e /root/.config/gcloud
test ! -e /root/.gsutil
test ! -e /root/.boto
