# pi-microsandbox

`pi-microsandbox` runs Pi's file and shell tools in a microsandbox while keeping the
host escape explicit. This release requires Node.js 22.19.0 or newer. The
development toolchain pins Pi 0.83.0, and the runtime dependency is pinned
exactly to `microsandbox` 0.6.8.

Security reports belong in [GitHub private vulnerability reporting](https://github.com/hcohe/pi-microsandbox/blob/main/SECURITY.md),
not in public issues.

## Safety model

The default is fail-closed:

- A valid, trusted project configuration is resolved before a sandbox is
  started. A boot or image/tool failure blocks the seven routed tools (`read`,
  `write`, `edit`, `ls`, `find`, `grep`, and `bash`).
- `mode = "auto"` is retained as an alias for `"direct"`; both use a
  same-absolute-path read/write bind. `mode = "git"`, `"direct"`, and
  `"none"` select those behaviors explicitly.
- `execution_target = "host"` is an opt-in escape for routed tool calls. While
  a sandbox is active it requires an interactive approval for the exact tool,
  working directory, and recursively sorted arguments. It is not available in
  headless operation and is never silently selected.
- `/msb off` is an explicit host-mode handoff and does not prompt. This is
  different from `fallback_mode = "host"`, which automatically uses host tools
  after a sandbox failure and is shown as `MSB host fallback`.
- A project cannot replace another process's sandbox: ownership is a
  non-blocking kernel `flock` acquired before any sandbox or volume mutation.
  Stale sandbox pruning never removes volumes.

The extension entry point does not import the native SDK. Unsupported hosts can
still load Pi and remain blocked or explicitly off. pi-microsandbox currently supports
macOS Apple Silicon and Linux with KVM; Windows is not supported.

## Requirements

Pi must be installed and running on Node.js 22.19.0 or newer. Live sandboxes
require one of these hosts:

| Host | Architecture | Virtualization requirement |
| --- | --- | --- |
| macOS | Apple Silicon (arm64) | Apple virtualization support available to the process |
| Linux | x86_64 or arm64 (GNU) | KVM enabled, with `/dev/kvm` accessible to the process |

Windows and Intel macOS are not supported by pi-microsandbox. The upstream
microsandbox runtime has preview Windows support, but this package deliberately
declares only macOS and Linux. A Linux container or virtual machine also needs
KVM passthrough or nested virtualization; many hosted environments do not
provide it. Package loading and non-live tests do not require virtualization.

Installation must run lifecycle scripts and include optional dependencies:

- `fs-ext@2.1.1` compiles a native node-gyp module. Install Python and a working
  C/C++ build toolchain (`xcode-select --install` on macOS, or a compiler,
  `make`, and Python 3 on Linux).
- `microsandbox@0.6.8` installs its matching native addon and runtime binaries
  through an optional platform package. Do not use `--ignore-scripts` or omit
  optional dependencies when installing pi-microsandbox.

If the platform package is missing, reinstall with optional dependencies
enabled, install the matching microsandbox platform package, or set `MSB_PATH`
to a working `msb` binary. These alternatives do not remove the host
virtualization requirement.

## Install

Install the package for the current user with Pi:

```sh
pi install npm:pi-microsandbox
```

For a first load, explicit off mode lets you inspect the installation without
starting virtualization:

```sh
PI_MSB_DISABLE=1 pi
# In Pi:
/msb status
```

Off mode is **not sandboxed**: Pi's tools run directly on the host. Remove
`PI_MSB_DISABLE` only after reviewing the configuration and host prerequisites.
For an unavailable or failed sandbox, the default `fallback_mode = "block"`
blocks routed tools rather than silently running them on the host. Keep that
default for a fail-closed setup. `fallback_mode = "host"` is an explicit,
visibly labelled opt-in to automatic unsandboxed execution.

The public package is named `pi-microsandbox`. Existing technical interfaces
retain the shorter `msb` name for compatibility, including `/msb`,
`PI_MSB_*`, `.pi-msb.toml`, configuration directories, and managed-resource
labels. Existing configuration and retained resources therefore keep working.

## Git and retained volumes

Git mode never bind-mounts the host checkout. On boot, pi-microsandbox captures the
committed `HEAD` (and selected branch) into a temporary verified Git bundle,
copies it into the guest, and seeds a named volume mounted at the repository's
absolute root. Untracked files, including `.env`, and working-tree edits are
not in that bundle. The temporary host and guest bundle files are removed after
seeding, including failure paths.

Edits and commits made in Git mode land in the retained volume. The host
checkout is not changed by ordinary routed tools. A normal Pi session shutdown
removes the sandbox but keeps the managed volume; the next boot reuses it only
when the complete session/schema/mode/cwd identity matches. A copied or forked
session state is rejected by the full session ID and gets a different resource
identity.

The SDK's `VolumeHandle` returned by `Volume.get()` in 0.6.8 does not expose a
host path. pi-microsandbox therefore refuses to fabricate one: a newly created volume
may show its path, while a later retained-volume lookup may not support
`/msb volumes ls` or volume enrichment. The volume remains mountable by name
and is never automatically deleted. Use the path recorded at creation time or
the microsandbox volume tooling when host-side inspection is required.

To manually synchronize a retained checkout, use a host-side fetch deliberately
(the command is not performed automatically by pi-microsandbox):

```sh
REPO=/absolute/path/to/checkout
VOLUME_PATH=/path/returned-for-the-managed-volume
BRANCH=$(git -C "$REPO" branch --show-current)

git -C "$VOLUME_PATH" remote remove host 2>/dev/null || true
git -C "$VOLUME_PATH" remote add host "$REPO"
git -C "$VOLUME_PATH" fetch --no-tags host "$BRANCH"
# Review before changing the retained checkout:
git -C "$VOLUME_PATH" log --oneline --decorate --all -10
```

The host repository is an input to this explicit sync operation. Do not add a
host checkout bind mount to Git mode.

## Storage modes

| Mode | Guest view | Host effect of routed writes |
| --- | --- | --- |
| `git` | A named volume at the repository root, with the same absolute path | Volume only |
| `direct` | The current directory bind-mounted at the same absolute path | Host directory |
| `none` | An empty tmpfs at the same absolute path | No host files; changes disappear with the sandbox |
| `auto` | Same as `direct` | Host directory |

`direct` is intentionally a warning-level escape from the Git isolation model:
routed edits modify the live host directory. `none` is useful for testing path
behavior and starts empty; it is not a retained workspace.

## Configuration

The precedence is defaults < global < trusted project < environment < session
CLI overrides. Global configuration is `$XDG_CONFIG_HOME/pi-msb/config.toml`
(or `~/.config/pi-msb/config.toml`) plus the optional `PI_MSB_CONFIG_FILE` in
the same layer. A trusted project may use the nearest `.pi-msb.toml` or
`<Pi CONFIG_DIR_NAME>/msb.toml`, stopping at the Git root. Untrusted project
configuration is ignored with a warning.

TOML uses snake_case; environment variables use `PI_MSB_` with `__` for nesting.
The following is a small project example:

```toml
# .pi-msb.toml
mode = "git"
image = "ubuntu:24.04"
bootstrap_tools = "auto"
idle_timeout_sec = 600
fallback_mode = "block"

[network]
mode = "default" # default | open | allowlist | deny
allow_dns = true

# Project secrets should use references, not literals.
[[secrets]]
env = "NPM_TOKEN"
value = "$ENV:NPM_TOKEN"
allow_hosts = ["registry.npmjs.org"]
```

Important configuration behavior:

- The default image is `ubuntu:24.04`; `bootstrap_tools = "auto"` probes for
  `bash`, `git`, `rg`, `file`, `cat`, `mkdir`, and `rm`, then uses noninteractive
  `apt-get` under the configured network policy. `false` blocks with the missing
  command list. A custom image with those tools can use `bootstrap_tools = false`.
- `network.mode = "default"` leaves the SDK's default policy in place. `open`
  allows all network traffic, including private/host access; `allowlist` is
  default-deny with configured host/DNS rules; `deny` disables networking.
  Published ports default to loopback unless a bind address is specified.
- Secrets require a non-empty `allow_hosts` list. `$ENV:NAME` and `$FILE:path`
  references are resolved only while constructing the SDK builder. Effective
  config, warnings, errors, and `/msb config` redact literal values.
- Directory/file mounts have absolute guest paths. Project mounts outside the
  repository must be read-only unless a global/session policy authorizes the
  write. Mounts may not overlap or shadow the project mount or reserved `/tmp`.
- The legacy `host_ro_allowlist` is converted to canonical read-only mounts and
  emits a deprecation warning.

Useful environment controls include:

```sh
PI_MSB_DISABLE=1                 # explicit host/off mode
PI_MSB_MODE=none                 # nested scalar example
PI_MSB_NETWORK__MODE=deny        # nested environment key
PI_MSB_FALLBACK_MODE=host        # opt into automatic host fallback
PI_MSB_ROUTE_TOOLS='read,write'  # POSIX delimiter for simple arrays
```

Do not put resolved secret values in session overrides, logs, issue reports, or
shell history.

## Commands

The extension registers `/msb`:

```text
/msb status
/msb on | off | reload
/msb prune
/msb volumes ls
/msb volumes rm <managed-name> [--yes]
/msb export <paths...> [--to dir] [--yes]
/msb logs [tail-lines]
/msb config
/msb set <key> <value>
/msb unset <key>
/msb reset
/msb network allow <host...> | deny
/msb seal
/msb mount add <json|hostPath guestPath [--readonly]>
/msb mount rm <guest-path>
/msb help
```

`/msb status` reports the full sandbox name, mode, image, PID, age, branch/SHA,
and retained volume metadata when available. Six-character IDs in UI text are
display abbreviations only. `/msb prune` walks all SDK list pages and reports
removed, kept, and error entries; **volumes are never pruned**.

Volume removal is the sole destructive volume path. It requires a managed,
unmounted volume and an owner lock. Confirmation displays path, branch, last
commit, and dirty-count metadata; use `--yes` only when the command is running
without UI and the target has already been verified. Export rejects paths outside
the project and existing destinations; it also requires confirmation or
`--yes`.

Pi-discovered `SKILL.md` reads are a narrow host-read exception. A standalone
skill grants only its exact file; a directory skill grants regular files
canonically below its directory. Symlink escapes, devices, sockets, and
unrelated host paths are denied. A successful sandbox Bash/grep result may
record one exact generated `details.fullOutputPath`; neighboring files do not
become readable.

## Recovery and troubleshooting

1. Run `/msb status` and `/msb logs`.
2. If the state is `unavailable (blocked)`, fix the displayed configuration,
   image, virtualization, or missing-tool error and run `/msb reload`.
3. If a process died, a later startup or `/msb prune` can remove its labelled
   sandbox after the owner lock is free. The named volume is retained.
4. If a same-name resource has different managed labels, pi-microsandbox refuses to
   attach or replace it. Remove only a verified managed, unmounted volume with
   `/msb volumes rm NAME --yes`.
5. On unsupported virtualization hosts, use `PI_MSB_DISABLE=1` for explicit host
   mode or configure `fallback_mode = "host"` knowingly. The latter remains
   visibly distinct from `/msb off`.
6. For bootstrap failures, use an image that already contains the required
   command list or allow the configured network policy to reach the package
   repositories. Deny mode cannot bootstrap an image missing those commands.

From a source checkout, the live matrix is opt-in because it can pull an image,
start VMs, create retained resources, and use network and disk capacity. Run it
only from a trusted checkout on a disposable test host after reviewing the
script:

```sh
PI_MSB_LIVE_TEST=1 ./scripts/e2e-smoke.sh
```

Without that variable the script prints a `SKIP` line for every scenario and
exits successfully; this skip path does not validate virtualization. If
virtualization is unavailable, it prints the reason and skips the matrix rather
than reporting false failures. Set `PI_MSB_LIVE_IMAGE` to select the live test
image; the default is `ubuntu:24.04`. Set `PI_MSB_LIVE_PREPARED_IMAGE` to
additionally exercise a prepared image under `network.mode = "deny"` without
bootstrap. Review the output to confirm that all 16 scenarios report `PASS`,
not `SKIP`.

## Development

To test from source without installing the npm package globally:

```sh
git clone https://github.com/hcohe/pi-microsandbox.git
cd pi-microsandbox

# fs-ext must compile during installation; do not use --ignore-scripts.
npm ci
npm run typecheck
npm test
npm run smoke       # extension-load smoke; no sandbox starts
npm run check       # all three commands above
npm audit --omit=dev
npm pack --dry-run --json
```

The smoke and unit tests do not require KVM, image pulls, or a live sandbox.
The live matrix described above is the only opt-in VM test.

## Releases

[GitHub Releases](https://github.com/hcohe/pi-microsandbox/releases) are the
canonical changelog. The first npm publication is a human-run local publish of
the reviewed tarball with interactive npm 2FA. Subsequent releases publish
directly to npm with OIDC only after a maintainer publishes the matching GitHub
Release and approves the protected `npm` GitHub Environment. Release automation
must not use a long-lived npm token.
