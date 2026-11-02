# Configuration

[Back to README](../README.md)

Configure host-owned defaults in `~/.pi/agent/pi-microsandbox/default.toml`,
created if missing as a fully commented reference on the first enabled session.
Use host-owned per-project files for project-specific overrides, `PI_MSB_*`
environment variables for launch settings, and the [`/msb` control panel](commands.md)
for ephemeral (`w`), project (`P`) or global (`G`) save + reload. Its Configuration
tree edits desired policy; Runtime shows only successfully adopted policy.

Settings take precedence in this order: built-ins < environment
< **host-owned defaults** < **host-owned project overrides** < **ephemeral settings**.
Ephemeral settings are memory-only and authoritative, including empty lists;
they are cleared when switching sessions or shutting down.
Keep configuration and credential files outside the mounted workspace and all
writable mounts.

TOML uses snake_case; environment variables use `PI_MSB_` with `__` for nesting.
The following is a small **host-owned** configuration example:

```toml
# ~/.pi/agent/pi-microsandbox/default.toml (or a host-owned project override)
image = "ghcr.io/hcohe/pi-microsandbox:1.1.0@sha256:ab4e99d4232f827b3f295ff3210437e01446dbb672ef0d0c78358566170ac86c"
pull_policy = "if-missing"
bootstrap_tools = "auto"
cpus = 4
memory_mib = 8192
idle_timeout_sec = 600
fallback_mode = "block"
show_footer = true # Default; set false to hide the MSB footer status.

[network]
mode = "default" # default | open | allowlist | deny
allow_dns = true

[docker]
mode = "auto" # auto | require | disabled
startup_timeout_ms = 15000

# Project secrets should use references, not literals.
[[secrets]]
env = "NPM_TOKEN"
value = "$ENV:NPM_TOKEN"
allow_hosts = ["registry.npmjs.org"]
```

## Host-owned project overrides

Keep settings the agent must not change outside the mounted worktree:

```text
<agent-dir>/pi-microsandbox/default.toml
<agent-dir>/pi-microsandbox/projects/<home-relative-project-path>/config.toml
```

`default.toml` supplies a host-owned baseline for **all projects**. A host-owned
per-project `config.toml` overrides that baseline. Both layers take precedence
over environment variables, but not deliberate ephemeral changes.
For example, pin `fallback_mode = "block"` in `default.toml` and set a project's
`memory_mib` in its host-owned override.

The agent directory comes from Pi's `getAgentDir()`: normally `~/.pi/agent`,
with `PI_CODING_AGENT_DIR` and Pi's distribution-specific default respected.
The default baseline location is `~/.pi/agent/pi-microsandbox/default.toml`.
For a project at `~/Code/pi-microsandbox`, the project override location is:

```text
~/.pi/agent/pi-microsandbox/projects/Code/pi-microsandbox/config.toml
```

The project identity is the canonical Git worktree root, or the canonical cwd
outside Git. Starting inside a Git subdirectory or through a symlink uses the
same host file. Linked worktrees have separate identities. Projects outside
home use `<agent-dir>/pi-microsandbox/projects-absolute/<absolute-project-path-without-leading-slash>/config.toml`
instead, so `/srv/app` cannot collide with `~/srv/app`. There is no parent-policy
search: each workspace has one exact host override location. A project whose
root is home itself uses `projects/config.toml`.

For `~/Code/app`, create the override from a **host shell** (not sandbox bash):

```sh
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p -m 700 "$agent_dir/pi-microsandbox/projects/Code/app"
# noclobber preserves an existing override; umask protects new files.
(umask 077; set -C; printf 'cpus = 2\nmemory_mib = 2048\n' > \
  "$agent_dir/pi-microsandbox/projects/Code/app/config.toml")
```

Open `/msb` → Configuration → Actions → Reload settings after external edits. Keep the agent directory outside the mounted
workspace. A symlinked host-selected Pi agent directory is supported: its canonical
location anchors the save targets. Policy files and directories below that anchor
must not be symlinks. Both the original and canonical locations remain subject to
workspace/writable-mount guards. Writable mounts also cannot expose physical
ancestor entries or intermediate alias hops that could replace the selected agent
link; read-only parents and unrelated sibling directories remain allowed.
Retargeting or replacing the agent directory while
a draft is open invalidates that draft; reopen the panel before saving.

Both host-owned files are loaded regardless of Pi's project trust state. They
are applied after launch settings, with the project-specific file after `default.toml`.
**`w` (ephemeral)** places memory-only changes above both files, never in the
transcript. They reset on session switch/end, including resuming the same session.
**`d` (inherit)** on a scalar/collection removes the eventual save scope's assignment;
Configuration → Actions → Reset ephemeral settings clears memory overrides.
**`P` / `G`** save only intentional project/global edits, preserving unedited
references without copying inherited credentials. See [save scopes](commands.md#save-scopes).
Origins remain labeled separately from unsaved draft intent. Runtime is read-only
and changes only after successful adoption, not merely after a disk save.
Only explicitly configured fields override lower layers; omitted fields inherit
from the preceding layers, including the host-owned default. Nested tables
override individual fields. **Lists in both host-owned layers replace the entire
lower-layer list**, including secrets, mounts,
network hosts, and tool lists; `[]` clears a list.

For example, a host-owned npm policy can pin the relevant execution, host-access,
and network settings as well as the secret:

```toml
# ~/.pi/agent/pi-microsandbox/projects/Code/app/config.toml
fallback_mode = "block"
auto_start = true
allow_host_execution = false
allow_skill_reads = false
block_third_party = true
route_tools = ["read", "write", "edit", "ls", "find", "grep", "bash"]
pass_through_tools = []
host_env = []
mounts = []

[network]
mode = "allowlist"
allow_hosts = ["registry.npmjs.org"]
allow_dns = true
publish_ports = []

[[secrets]]
env = "NPM_TOKEN"
value = "$ENV:MY_PROJECT_NPM_TOKEN"
allow_hosts = ["registry.npmjs.org"]
```

Make `MY_PROJECT_NPM_TOKEN` available to the host Pi process before launch.
Alternatively, `$FILE:token` reads a host file beside the file declaring it
(`default.toml` or the project override); absolute file references are also
supported. Relative references are normalized against the original **lexical**
policy path before resolving symlinks. A symlinked agent directory therefore does
not redirect upward references such as `$FILE:../../token` into the link target's
parent directories. Save targets remain canonical; unchanged raw reference
spelling is retained, and deliberate cross-scope transfers anchor the reference
to its original file without copying credential bytes. Neither the policy nor the secret
file needs to be mounted into the guest. `/msb` → Configuration → Actions shows effective redacted
configuration and re-reads policy with Reload settings.

On the first enabled session (and on reload), setup creates `default.toml`
**exclusively if missing**, with a comprehensive fully commented reference:
setting defaults, valid values/ranges, secret references, mount examples, merge
behavior, and per-project creation instructions. It does not activate any
settings. Existing files, including empty files, are never overwritten or
chmodded. Newly created directories use mode `0700` and the file uses `0600`
(subject to a more restrictive umask). No configuration is written by a bare
extension import, factory registration, or the model-list smoke command;
`PI_MSB_DISABLE=1` also skips setup. Creation failures block sandbox startup
rather than falling back to host execution. Per-project files are created by the
project save key (`P`) or manually from the host;
without one, host defaults still apply.
An unreadable or invalid host file fails closed rather than silently dropping
that layer. Both host files must remain outside the workspace, including through
symlinks. While a host policy is active, writable extra mounts may not overlap
the host policy directory, including paths for project overrides not yet created.
Keep the agent directory and secret files outside all writable mounts. Setting only `secrets` does **not** lock other
permissions: pin those fields explicitly, as above. This feature does not disable
explicit user controls such as Configuration → Actions → Turn off or `PI_MSB_DISABLE`, and is not isolation
from host code you independently choose to load or execute.

## Other configuration behavior

- Inside a Git worktree, the whole worktree root is mounted read/write at the
  same lexical guest path; elsewhere, the current directory is mounted. Commands retain the
  original cwd, and writes reach the host immediately.
- `show_footer = true` uses Pi's single custom-footer slot so the MSB status can
  appear in the upper-right corner. It replaces Pi's built-in footer (or another
  extension's custom footer), preserves the standard location, usage, model,
  and shared status fields, but cannot show Pi-only indicators such as the
  auto-compaction and experimental-feature markers.
- The default image is the complete Node.js, Python, Rust, and Go `1.1.0`
  variant, pinned to its immutable multi-platform digest. Image releases have
  an independent version stream from package releases. The default
  `pull_policy = "if-missing"` pulls only when that exact reference is
  absent from the Microsandbox cache. `"always"` and `"never"` are also
  supported.
  See [Images](images.md) for all published variants, exact tag patterns,
  contents, custom image workflows, and the required guest commands.
  `bootstrap_tools = "auto"` probes those commands and uses noninteractive
  `apt-get` under the configured network policy when a custom image is missing
  them. `false` blocks with the missing command list instead. New sandboxes use
  4 CPUs and 8192 MiB by default; set `cpus` and `memory_mib` lower if the host
  cannot support that allocation.
- `docker.mode = "auto"` starts the guest daemon when the image has Docker and
  reports `missing` for older or custom images without it. `"require"` blocks
  sandbox preparation if Docker is absent or cannot start. `"disabled"` leaves
  the installed daemon stopped. `startup_timeout_ms` must be an integer from 1
  through 300000. Readiness is pinned to the managed guest Unix socket and
  ignores inherited Docker client endpoint settings. Docker state stays on the
  disposable guest root filesystem. Small builds should have at least 1 GiB; larger Compose stacks usually need
  2 GiB or more.
- `network.mode = "default"` leaves the SDK's default policy in place. `open`
  allows all network traffic, including private/host access; `allowlist` is
  default-deny with configured host/DNS rules; `deny` disables networking.
  Published ports default to loopback unless a bind address is specified.
  Nested containers remain subject to this outer policy. A Docker `-p` mapping
  exposes a port only inside the microVM. Host access also needs a matching
  `network.publish_ports` entry created with the sandbox, for example
  `publish_ports = ["127.0.0.1:8080:8080"]` together with `docker run -p
  0.0.0.0:8080:8080 ...`. Docker's random host-port form cannot create that
  outer mapping.
- Secrets require a non-empty `allow_hosts` list. `$ENV:NAME` and `$FILE:path`
  references are resolved only while constructing the SDK builder. Effective
  config, warnings, errors, and the control panel redact literal values. Process
  control variables such as `DOCKER_HOST`, `DOCKER_CONTEXT`, `PATH`,
  `BASH_ENV`, and `LD_PRELOAD` cannot be forwarded with `host_env` or injected
  as secrets.
- Directory/file mounts use absolute host paths and guest paths (the guest path
  defaults to the host path). Mounts default to read-only; writable host mounts
  explicitly expose host data. `named` mounts use a volume name as `host_path`;
  `tmpfs` mounts need no host path. Options support only `noexec`, `nosuid`, and
  `nodev`; unsupported options block startup.
  Mounts may not overlap or shadow the project mount,
  reserved `/tmp`,
  protected guest system trees such as `/usr`, `/bin`, `/proc`, and `/sys`, or
  Docker runtime paths such as `/run`, `/var/run`, and `/var/lib/docker`.
  Host mount sources are canonicalized before use; socket targets, including
  Docker sockets reached through symlink aliases, are rejected.

Useful environment controls include:

```sh
PI_MSB_DISABLE=1                 # explicit host/off mode
PI_MSB_PULL_POLICY=always        # recheck mutable custom image tags on creation
PI_MSB_NETWORK__MODE=deny        # nested environment key
PI_MSB_DOCKER__MODE=require      # require a working guest Docker daemon
PI_MSB_DOCKER__STARTUP_TIMEOUT_MS=30000
PI_MSB_FALLBACK_MODE=host        # opt into automatic host fallback
PI_MSB_SHOW_FOOTER=false         # hide the MSB status from Pi's footer
PI_MSB_ROUTE_TOOLS='read,write'  # POSIX delimiter for simple arrays
```

Do not put resolved secret values in logs, issue reports, or
shell history.
