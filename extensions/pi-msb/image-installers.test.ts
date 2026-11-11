import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const common = fileURLToPath(new URL("../../default-image/install/_common.sh", import.meta.url));

for (const entry of ["bootstrap", "installer"] as const) {
  for (const [updateStatus, installStatus] of [[0, 0], [100, 0], [0, 100]]) {
    test(`image apt ${entry} retries downloads and fails closed (update=${updateStatus}, install=${installStatus})`, () => {
      const dockerfile = readFileSync(new URL("../../default-image/Dockerfile", import.meta.url), "utf8");
      const bootstrap = dockerfile.match(/^RUN (apt-get update [\s\S]*?)\n\nCOPY install\//m)?.[1];
      assert.ok(bootstrap, "Dockerfile bootstrap apt block must be exercised");
      const result = spawnSync("bash", ["-c", `
set -euo pipefail
source "$1"
# Offline apt transport; execute the actual bootstrap/helper control flow.
apt-get() {
    printf '%s\\n' "$*"
    case "$1" in
        update) return "$TEST_UPDATE_STATUS" ;;
        install) return "$TEST_INSTALL_STATUS" ;;
        *) return 99 ;;
    esac
}
# Never let the Dockerfile cleanup touch the host.
rm() { :; }
if [[ "$3" == bootstrap ]]; then
    eval "$2"
else
    apt_install ca-certificates curl file git ripgrep
fi
printf 'installation completed\\n'
`, "image-apt-test", common, bootstrap, entry], {
        encoding: "utf8",
        env: { ...process.env, TEST_UPDATE_STATUS: String(updateStatus), TEST_INSTALL_STATUS: String(installStatus) },
      });
      assert.ifError(result.error);
      assert.equal(result.status, updateStatus || installStatus, result.stderr);
      const expected = ["update --error-on=any -o Acquire::Retries=3"];
      if (updateStatus === 0) {
        expected.push("install -y --no-install-recommends -o Acquire::Retries=3 ca-certificates curl file git ripgrep");
        if (installStatus === 0) expected.push("installation completed");
      }
      assert.deepEqual(result.stdout.trim().split("\n"), expected);
    });
  }
}

// Published rustup 1.29.1 checksums, not the mutable rustup/dist artifacts.
test("rustup uses an archived release matching both pinned platform checksums", () => {
  const installer = readFileSync(new URL("../../default-image/install/rust.sh", import.meta.url), "utf8");
  assert.match(installer, /^rustup_version="1\.29\.1"$/m);
  assert.match(installer, /^    "https:\/\/static\.rust-lang\.org\/rustup\/archive\/\$\{rustup_version\}\/\$\{rust_arch\}-unknown-linux-gnu\/rustup-init" \\$/m);
  assert.match(installer, /amd64\)[\s\S]*?rustup_sha256="dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71"/);
  assert.match(installer, /arm64\)[\s\S]*?rustup_sha256="15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433"/);
});

for (const valid of [true, false]) {
  test(`image download verification ${valid ? "accepts matching bytes" : "rejects mismatched bytes with diagnostics"}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-msb-image-download-"));
    const payload = "offline download fixture\n";
    const checksum = createHash("sha256").update(valid ? payload : "different bytes").digest("hex");
    const url = "https://example.invalid/archive/1.0/tool";
    try {
      const result = spawnSync("bash", ["-c", `
source "$1"
# Offline transport; the real SHA-256 utility still verifies the fixture.
curl() {
    while (( $# > 0 )); do
        if [[ "$1" == --output ]]; then
            printf '%s' "$TEST_PAYLOAD" > "$2"
            return
        fi
        shift
    done
    return 1
}
# The image uses GNU sha256sum. macOS's BSD command has a different
# checksum-file CLI, so use the real shasum verifier there even if it exists.
if [[ "$OSTYPE" == darwin* ]] || ! command -v sha256sum >/dev/null 2>&1; then
    sha256sum() { shasum -a 256 "$@"; }
fi
fetch_verified "$2" "$3" "$4"
printf 'verification completed\\n'
`, "image-download-test", common, url, checksum, join(directory, "artifact")], {
        encoding: "utf8",
        env: { ...process.env, TEST_PAYLOAD: payload },
      });
      assert.ifError(result.error);
      if (valid) {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /verification completed/);
        assert.equal(readFileSync(join(directory, "artifact"), "utf8"), payload);
      } else {
        assert.notEqual(result.status, 0);
        assert.ok(result.stderr.includes(`SHA-256 verification failed for ${url} (expected ${checksum})`), result.stderr);
        assert.ok(!result.stdout.includes("verification completed"));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("default image uses normal Ubuntu repositories without bootstrap trust overrides", () => {
  const dockerfile = readFileSync(new URL("../../default-image/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /FROM docker\.io\/library\/ubuntu:26\.04@sha256:513c074113a871b51a8d16ab445c88779d6452d937a164fb5cc479f32668a41d AS assembled/);
  assert.doesNotMatch(dockerfile, /snapshot|CaInfo|pi-image-bootstrap|sources\.list|ubuntu\.sources|AllowUnauthenticated|AllowInsecure|Verify-Peer/i);
  assert.equal(existsSync(new URL("../../default-image/install/ubuntu-snapshot-ca.pem", import.meta.url)), false);
  assert.match(dockerfile, /ca-certificates/);
  assert.match(dockerfile, /AWS_CA_BUNDLE=\/etc\/ssl\/certs\/ca-certificates\.crt/);
  assert.match(dockerfile, /CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=\/etc\/ssl\/certs\/ca-certificates\.crt/);
});

test("default image build has no runtime-selection knobs and retains common CLI installation", () => {
  const dockerfile = readFileSync(new URL("../../default-image/Dockerfile", import.meta.url), "utf8");
  assert.doesNotMatch(dockerfile, /IMAGE_VARIANT|TOOLCHAINS/);
  for (const cli of ["docker", "gcloud", "aws"]) {
    assert.ok(dockerfile.includes(`/opt/pi-image-install/${cli}.sh;`));
  }
  assert.match(dockerfile, /\/opt\/pi-image-install\/dispatch\.sh;/);
  assert.match(dockerfile, /\/opt\/pi-image-verify\/dispatch\.sh;/);
  assert.match(dockerfile, /org\.opencontainers\.image\.variant="default"/);
  for (const path of ["../../.github/workflows/default-image.yml", "../../Justfile"]) {
    assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), "utf8"), /IMAGE_VARIANT=|TOOLCHAINS=/);
  }
});

test("image-variants CLI emits only the all-runtime default matrix and references", () => {
  const script = fileURLToPath(new URL("../../scripts/image-variants.mjs", import.meta.url));
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.deepEqual(JSON.parse(run("matrix")), { include: [{
    variant: "default", toolchains: "node python rust go", latestTag: "latest",
    releaseTemplate: "{version}", shaPrefix: "sha-",
  }] });
  assert.equal(run("refs", "latest", "example.invalid/image"), "default\texample.invalid/image:latest\n");
  assert.equal(run("refs", "release", "example.invalid/image", "2.3.4"), "default\texample.invalid/image:2.3.4\n");
  assert.equal(run("self-test"), "image-variants self-test: PASS\n");
});

for (const kind of ["install", "verify"] as const) {
  test(`image ${kind} dispatcher always runs all four runtimes and fails closed`, () => {
    const directory = mkdtempSync(join(tmpdir(), `pi-msb-image-${kind}-`));
    const runtimes = ["node", "python", "rust", "go"];
    const writeScript = (name: string, content: string) => {
      const path = join(directory, name);
      writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${content}\n`);
      chmodSync(path, 0o755);
    };
    try {
      copyFileSync(new URL(`../../default-image/${kind}/dispatch.sh`, import.meta.url), join(directory, "dispatch.sh"));
      if (kind === "verify") {
        copyFileSync(new URL("../../default-image/verify/default.sh", import.meta.url), join(directory, "default.sh"));
      }
      // Only the orchestration runs for real; no host installs, downloads, or probes.
      writeScript("_common.sh", `
        target_arch() { printf 'architecture\\n'; }
        cleanup_apt() { printf 'cleanup\\n'; }
        verify_base_contract() { printf 'base\\n'; }
      `);
      for (const runtime of runtimes) writeScript(`${runtime}.sh`, `printf '${runtime}\\n'`);
      const run = (...args: string[]) => {
        const entrypoint = kind === "verify" ? "default.sh" : "dispatch.sh";
        const result = spawnSync("bash", [join(directory, entrypoint), ...args], {
          encoding: "utf8",
          env: { ...process.env, IMAGE_VARIANT: "base", TOOLCHAINS: "" },
        });
        assert.ifError(result.error);
        return result;
      };
      const expected = kind === "install" ? [...runtimes, "cleanup"] : ["base", ...runtimes];
      const success = run();
      assert.equal(success.status, 0, success.stderr);
      assert.deepEqual(success.stdout.trim().split("\n"), expected);
      for (const args of [[""], ["node"], ["default", "node python rust go"], ["../node"]]) {
        const rejected = run(...args);
        assert.equal(rejected.status, 1);
        assert.equal(rejected.stdout, "");
        assert.match(rejected.stderr, /no arguments are supported/);
      }
      // A missing module must fail before any runtime work.
      rmSync(join(directory, "go.sh"));
      const missing = run();
      assert.equal(missing.status, 1);
      assert.equal(missing.stdout, "");
      assert.match(missing.stderr, /No executable .* for toolchain: go/);
      writeScript("go.sh", "exit 0");
      // Any installer or functional verifier failure must stop later modules.
      writeScript("python.sh", "exit 42");
      const failed = run();
      assert.equal(failed.status, 42);
      assert.deepEqual(failed.stdout.trim().split("\n"), kind === "install" ? ["node"] : ["base", "node"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
