#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p -- "$ROOT/.tmp"
TMP_ROOT=$(mktemp -d "$ROOT/.tmp/pi-msb-package-smoke.XXXXXX")
# Keep Node/Pi helper caches (including jiti output) inside the directory owned
# by this script so the EXIT trap removes every temporary artifact.
export TMPDIR="$TMP_ROOT"
export NODE_DISABLE_COMPILE_CACHE=1
cleanup() {
  rm -rf -- "$TMP_ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

PACK_DIR="$TMP_ROOT/pack"
PACK_JSON="$TMP_ROOT/pack.json"
NPM_CACHE="$TMP_ROOT/npm-cache"
NPM_USERCONFIG="$TMP_ROOT/npmrc"
CONSUMER_DIR="$TMP_ROOT/consumer"
MANIFEST="$TMP_ROOT/manifest"
APPROVED_FILES="$TMP_ROOT/approved-files"
EXPECTED_FILES="$TMP_ROOT/expected-files"
ACTUAL_FILES="$TMP_ROOT/actual-files"
UNAPPROVED_FILES="$TMP_ROOT/unapproved-files"
MISSING_FILES="$TMP_ROOT/missing-files"
mkdir -p -- "$PACK_DIR" "$NPM_CACHE" "$CONSUMER_DIR"
(umask 077; : > "$NPM_USERCONFIG")
export NPM_CONFIG_USERCONFIG="$NPM_USERCONFIG"

for command_name in npm node tar comm sort; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'package smoke: missing required command: %s\n' "$command_name" >&2
    exit 1
  fi
done

# This is the sole package-content manifest. Every listed path is required;
# every tarball path not listed here is rejected.
cat >"$MANIFEST" <<'EOF'
LICENSE required
README.md required
SECURITY.md required
docs/commands.md required
docs/configuration.md required
docs/development.md required
docs/getting-started.md required
docs/safety.md required
docs/storage.md required
docs/troubleshooting.md required
extensions/pi-msb/command.ts required
extensions/pi-msb/config.ts required
extensions/pi-msb/control.ts required
extensions/pi-msb/footer.ts required
extensions/pi-msb/git.ts required
extensions/pi-msb/index.ts required
extensions/pi-msb/labels.ts required
extensions/pi-msb/locks.ts required
extensions/pi-msb/operations-exec.ts required
extensions/pi-msb/operations.ts required
extensions/pi-msb/prune.ts required
extensions/pi-msb/sandbox-manager.ts required
extensions/pi-msb/skill-access.ts required
extensions/pi-msb/storage.ts required
extensions/pi-msb/tools.ts required
extensions/pi-msb/transport.ts required
extensions/pi-msb/types.ts required
package.json required
EOF

while read -r relative_path policy; do
  printf 'package/%s\n' "$relative_path" >>"$APPROVED_FILES"
  if [[ "$policy" == "required" || -e "$ROOT/$relative_path" ]]; then
    printf 'package/%s\n' "$relative_path" >>"$EXPECTED_FILES"
  fi
done <"$MANIFEST"
LC_ALL=C sort -o "$APPROVED_FILES" "$APPROVED_FILES"
LC_ALL=C sort -o "$EXPECTED_FILES" "$EXPECTED_FILES"

if [[ $# -gt 1 ]]; then
  printf 'usage: %s [existing-package.tgz]\n' "$0" >&2
  exit 2
fi

if [[ $# -eq 1 ]]; then
  case $1 in
    /*) TARBALL=$1 ;;
    *) TARBALL="$(pwd)/$1" ;;
  esac
  PACK_FILENAME=${TARBALL##*/}
  if [[ ! -f "$TARBALL" || -L "$TARBALL" || "$PACK_FILENAME" != *.tgz ]]; then
    printf 'package smoke: existing artifact must be a regular .tgz file: %s\n' "$TARBALL" >&2
    exit 1
  fi
  printf 'package smoke: testing existing npm artifact (%s)\n' "$PACK_FILENAME"
else
  printf 'package smoke: packing npm artifact\n'
  (
    cd -- "$ROOT"
    npm pack --json --dry-run=false --pack-destination "$PACK_DIR" --cache "$NPM_CACHE"
  ) >"$PACK_JSON"

  PACK_FILENAME=$(node --input-type=module - "$PACK_JSON" <<'NODE'
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const result = JSON.parse(readFileSync(process.argv[2], "utf8"));
const data = Array.isArray(result) ? result : Object.values(result);
if (data.length !== 1) {
  throw new Error(`expected one npm pack result, received ${data.length}`);
}
const filename = data[0]?.filename;
if (typeof filename !== "string" || filename.length === 0 || basename(filename) !== filename || !filename.endsWith(".tgz")) {
  throw new Error("npm pack returned an invalid filename");
}
process.stdout.write(filename);
NODE
  )
  TARBALL="$PACK_DIR/$PACK_FILENAME"
  if [[ ! -f "$TARBALL" ]]; then
    printf 'package smoke: npm pack did not create %s\n' "$TARBALL" >&2
    exit 1
  fi
fi

tar -tzf "$TARBALL" | LC_ALL=C sort >"$ACTUAL_FILES"
LC_ALL=C comm -13 "$APPROVED_FILES" "$ACTUAL_FILES" >"$UNAPPROVED_FILES"
LC_ALL=C comm -23 "$EXPECTED_FILES" "$ACTUAL_FILES" >"$MISSING_FILES"
if [[ -s "$UNAPPROVED_FILES" || -s "$MISSING_FILES" ]]; then
  printf '%s\n' \
    'package smoke: tarball manifest mismatch' \
    'Only manifest-approved release files are allowed; tests, secrets, local state, and .DS_Store are prohibited.' >&2
  if [[ -s "$UNAPPROVED_FILES" ]]; then
    printf 'Unapproved files:\n' >&2
    cat "$UNAPPROVED_FILES" >&2
  fi
  if [[ -s "$MISSING_FILES" ]]; then
    printf 'Missing required files:\n' >&2
    cat "$MISSING_FILES" >&2
  fi
  exit 1
fi
printf 'package smoke: tarball manifest approved (%s)\n' "$PACK_FILENAME"

cat >"$CONSUMER_DIR/package.json" <<'EOF'
{
  "name": "pi-microsandbox-package-smoke-consumer",
  "private": true,
  "version": "0.0.0",
  "allowScripts": {
    "fs-ext@2.1.1": true,
    "@google/genai": false,
    "protobufjs": false
  }
}
EOF

PI_PEER_VERSION=$(tar -xOzf "$TARBALL" package/package.json | node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => process.stdout.write(JSON.parse(s).devDependencies["@earendil-works/pi-coding-agent"] ?? ""))')
PI_TUI_PEER_VERSION=$(tar -xOzf "$TARBALL" package/package.json | node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => process.stdout.write(JSON.parse(s).devDependencies["@earendil-works/pi-tui"] ?? ""))')
TYPEBOX_PEER_VERSION=$(tar -xOzf "$TARBALL" package/package.json | node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => process.stdout.write(JSON.parse(s).devDependencies.typebox ?? ""))')
if [[ -z "$PI_PEER_VERSION" || -z "$PI_TUI_PEER_VERSION" || -z "$TYPEBOX_PEER_VERSION" ]]; then
  printf 'package smoke: package.json must pin development fixtures for all peer dependencies\n' >&2
  exit 1
fi

printf 'package smoke: installing in isolated consumer (lifecycle scripts enabled)\n'
npm install \
  --prefix "$CONSUMER_DIR" \
  --cache "$NPM_CACHE" \
  --dry-run=false \
  --ignore-scripts=false \
  --json=false \
  --package-lock=false \
  --no-audit \
  --no-fund \
  --prefer-offline \
  --registry=https://registry.npmjs.org/ \
  "$TARBALL" \
  "@earendil-works/pi-coding-agent@$PI_PEER_VERSION" \
  "@earendil-works/pi-tui@$PI_TUI_PEER_VERSION" \
  "typebox@$TYPEBOX_PEER_VERSION"

INSTALLED_PACKAGE="$CONSUMER_DIR/node_modules/pi-microsandbox"
if [[ ! -d "$INSTALLED_PACKAGE" || -L "$INSTALLED_PACKAGE" ]]; then
  printf 'package smoke: tarball was not installed as an isolated package directory\n' >&2
  exit 1
fi

node --input-type=module - "$INSTALLED_PACKAGE" <<'NODE'
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.argv[2];
const manifestPath = join(packageRoot, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const requireFromPackage = createRequire(manifestPath);
const runtimeDependencies = ["fs-ext", "microsandbox"];

for (const dependency of runtimeDependencies) {
  if (typeof manifest.dependencies?.[dependency] !== "string") {
    throw new Error(`packaged manifest does not declare runtime dependency ${dependency}`);
  }
  const entry = requireFromPackage.resolve(dependency);
  if (dependency === "fs-ext") requireFromPackage(dependency);
  else await import(pathToFileURL(entry).href);
}
NODE
printf 'package smoke: runtime dependencies present (fs-ext, microsandbox)\n'

PI_BIN="$CONSUMER_DIR/node_modules/.bin/pi"
if [[ ! -x "$PI_BIN" ]]; then
  printf 'package smoke: isolated install did not provide the Pi executable\n' >&2
  exit 1
fi
mkdir -p -- "$CONSUMER_DIR/pi-agent"
printf 'package smoke: loading installed extension through Pi with sandbox disabled\n'
if ! PI_CODING_AGENT_DIR="$CONSUMER_DIR/pi-agent" \
  PI_MSB_DISABLE=1 \
  PI_MSB_LIVE_TEST=0 \
  PI_OFFLINE=1 \
  "$PI_BIN" \
    --no-extensions \
    --no-skills \
    --no-prompts \
    --no-themes \
    --no-context-files \
    --offline \
    --extension "$INSTALLED_PACKAGE" \
    --list-models __pi_msb_package_smoke__ \
    >"$TMP_ROOT/pi.out" 2>"$TMP_ROOT/pi.err"; then
  printf 'package smoke: Pi failed to load the installed extension\n' >&2
  cat "$TMP_ROOT/pi.out" "$TMP_ROOT/pi.err" >&2
  exit 1
fi

printf 'package smoke: PASS\n'
