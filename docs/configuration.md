# Configuration

[Back to README](../README.md)

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

Important configuration behavior:

- `show_footer = true` uses Pi's single custom-footer slot so the MSB status can
  appear in the upper-right corner. It replaces Pi's built-in footer (or another
  extension's custom footer), preserves the standard location, usage, model,
  and shared status fields, but cannot show Pi-only indicators such as the
  auto-compaction and experimental-feature markers.
- The default image is the complete Node.js, Python, Rust, and Go `1.0.0`
  variant, pinned to its immutable multi-platform digest. Image releases have
  an independent version stream; the initial package remains `0.1.0`. The
  default `pull_policy = "if-missing"` pulls only when that exact reference is
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
  repository must be read-only unless a global/session policy authorizes the
  write. Mounts may not overlap or shadow the project mount, reserved `/tmp`,
  protected guest system trees such as `/usr`, `/bin`, `/proc`, and `/sys`, or
  Docker runtime paths such as `/run`, `/var/run`, and `/var/lib/docker`.
  Host mount sources are canonicalized before use; socket targets, including
  Docker sockets reached through symlink aliases, are rejected.
- The legacy `host_ro_allowlist` is converted to canonical read-only mounts and
  emits a deprecation warning.

Useful environment controls include:

```sh
PI_MSB_DISABLE=1                 # explicit host/off mode
PI_MSB_MODE=none                 # nested scalar example
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
