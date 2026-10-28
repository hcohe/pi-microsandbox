import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const common = fileURLToPath(new URL("../../default-image/install/_common.sh", import.meta.url));

// Published rustup 1.29.1 checksums, not the mutable rustup/dist artifacts.
test("rustup uses an archived release matching both pinned platform checksums", () => {
  const installer = readFileSync(new URL("../../default-image/install/rust.sh", import.meta.url), "utf8");
  assert.match(installer, /^rustup_version="1\.29\.1"$/m);
  assert.ok(installer.includes("https://static.rust-lang.org/rustup/archive/${rustup_version}/${rust_arch}-unknown-linux-gnu/rustup-init"));
  assert.ok(!installer.includes("https://static.rust-lang.org/rustup/dist/"));
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
# macOS ships shasum, whereas the Ubuntu image ships sha256sum.
if ! command -v sha256sum >/dev/null 2>&1; then
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
