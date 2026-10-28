# Configuration

[Back to README](../README.md)

The precedence is defaults < global < trusted project < environment < session
CLI overrides < **host-owned defaults** < **host-owned project overrides**.
Global configuration is `$XDG_CONFIG_HOME/pi-msb/config.toml`
(or `~/.config/pi-msb/config.toml`) plus the optional `PI_MSB_CONFIG_FILE` in
the same layer. A trusted project may use the nearest `.pi-msb.toml` or
`<Pi CONFIG_DIR_NAME>/msb.toml`, stopping at the Git root. Untrusted project
configuration is ignored with a warning, except that removed workspace settings
still stop startup before any direct host write can occur.

TOML uses snake_case; environment variables use `PI_MSB_` with `__` for nesting.
The following is a small project example:

```toml
# .pi-msb.toml
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
<agent-dir>/pi-microsandbox/projects/<home-relative-project-path>/.pi-msb.toml
```

`default.toml` supplies a host-owned baseline for **all projects**. A host-owned
per-project `.pi-msb.toml` overrides that baseline. Both layers take precedence
over local worktree configuration, environment variables, and session settings.
For example, pin `fallback_mode = "block"` in `default.toml` and set a project's
`memory_mib` in its host-owned override.

The agent directory comes from Pi's `getAgentDir()`: normally `~/.pi/agent`,
with `PI_CODING_AGENT_DIR` and Pi's distribution-specific default respected.
The default baseline location is `~/.pi/agent/pi-microsandbox/default.toml`.
For a project at `~/Code/pi-microsandbox`, the project override location is:

```text
~/.pi/agent/pi-microsandbox/projects/Code/pi-microsandbox/.pi-msb.toml
```

The project identity is the canonical Git worktree root, or the canonical cwd
outside Git. Starting inside a Git subdirectory or through a symlink uses the
same host file. Linked worktrees have separate identities. Projects outside
home use `<agent-dir>/pi-microsandbox/projects-absolute/<absolute-project-path-without-leading-slash>/.pi-msb.toml`
instead, so `/srv/app` cannot collide with `~/srv/app`. There is no parent-policy
search: each workspace has one exact host override location.

Both host-owned files are loaded even when local project configuration is
untrusted. They are applied last, including after `/msb set` and restored session
overrides, with the project-specific file after `default.toml`.
Only explicitly configured fields override lower layers; omitted fields inherit
from the preceding layers, including the host-owned default. Nested tables
override individual fields. **Lists in both host-owned layers replace the entire
lower-layer list**, including secrets, mounts,
network hosts, and tool lists; `[]` clears a list. This differs from the
additive/identity-based merging used by ordinary layers.

For example, a host-owned npm policy can pin the relevant execution, host-access,
and network settings as well as the secret:

```toml
# Host-side .pi-msb.toml, NOT the file inside the worktree.
fallback_mode = "block"
auto_start = true
allow_host_execution = false
allow_skill_reads = false
block_third_party = true
route_tools = ["read", "write", "edit", "ls", "find", "grep", "bash"]
pass_through_tools = []
host_env = []
host_ro_allowlist = []
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
supported. Neither the policy nor the secret
file needs to be mounted into the guest. `/msb config` shows effective redacted
settings; `/msb reload` re-reads the policy.

Host files are optional: without either file, existing configuration
behavior is unchanged; without a project override, host defaults still apply.
An unreadable or invalid host file fails closed rather than silently dropping
that layer. Both host files must remain outside the workspace, including through
symlinks. While a host policy is active, writable extra mounts may not overlap
the host policy directory, including paths for project overrides not yet created.
Keep the agent directory and secret files outside all writable mounts. Setting only `secrets` does **not** lock other
permissions: pin those fields explicitly, as above. This feature does not disable
explicit user controls such as `/msb off` or `PI_MSB_DISABLE`, and is not isolation
from host code you independently choose to load or execute.

## Other configuration behavior

- There are no workspace modes or storage selection settings. Inside a Git
  worktree, the whole worktree root is mounted read/write at the same lexical
  guest path; elsewhere, the current directory is mounted. Commands retain the
  original cwd, and writes reach the host immediately. The removed `mode`,
  `clone_branch`, `clone_depth`, `shallow_archive`, and `volume_quota_mib`
  settings, including `PI_MSB_MODE`, are startup errors rather than ignored
  compatibility options.
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
  config, warnings, errors, and `/msb config` redact literal values. Process
  control variables such as `DOCKER_HOST`, `DOCKER_CONTEXT`, `PATH`,
  `BASH_ENV`, and `LD_PRELOAD` cannot be forwarded with `host_env` or injected
  as secrets.
- Directory/file mounts have absolute guest paths. Project mounts outside the
  selected workspace root must be read-only unless a global/session policy
  authorizes the write (a host-owned layer may also authorize it).
  Mounts may not overlap or shadow the project mount,
  reserved `/tmp`,
  protected guest system trees such as `/usr`, `/bin`, `/proc`, and `/sys`, or
  Docker runtime paths such as `/run`, `/var/run`, and `/var/lib/docker`.
  Host mount sources are canonicalized before use; socket targets, including
  Docker sockets reached through symlink aliases, are rejected.
- The legacy `host_ro_allowlist` is converted to canonical read-only mounts and
  emits a deprecation warning.

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

Do not put resolved secret values in session overrides, logs, issue reports, or
shell history.
