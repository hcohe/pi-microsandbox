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
image = "ghcr.io/hcohe/pi-microsandbox:latest"
bootstrap_tools = "auto"
idle_timeout_sec = 600
fallback_mode = "block"
show_footer = false # Set true to show the MSB status in Pi's footer.

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

- The default image is `ghcr.io/hcohe/pi-microsandbox:latest`. It is built from
  [`default-image/Dockerfile`](../default-image/Dockerfile) for AMD64 and ARM64.
  It adds the `git`, `ripgrep` (`rg`), and `file` packages to Ubuntu 24.04; the
  base image supplies `bash`, `cat`, `mkdir`, and `rm`. `bootstrap_tools =
  "auto"` still probes those commands and uses noninteractive
  `apt-get` under the configured network policy if a custom image is missing
  them. `false` blocks with the missing command list instead.
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
PI_MSB_SHOW_FOOTER=true          # show the MSB status in Pi's footer
PI_MSB_ROUTE_TOOLS='read,write'  # POSIX delimiter for simple arrays
```

Do not put resolved secret values in session overrides, logs, issue reports, or
shell history.
