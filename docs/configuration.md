# Make the sandbox yours

[Back to README](../README.md) · [Agent recipes](agent-recipes.md) · [Tool reference](tools.md)

Three ways to turn the knobs:

- **Ask your agent.** It inspects with `msb_config_get` and proposes approved
  changes with `msb_config_set`. [Try these prompts →](agent-recipes.md)
- **Open `/msb`.** Browse settings and apply an edit yourself.
  [Panel guide →](commands.md)
- **Edit host-owned TOML.** Useful for provisioning and headless workflows.
  Keep policy outside the workspace; sandbox Bash is not your policy editor.

## Choose a scope

| Scope | Storage | Lifetime |
| --- | --- | --- |
| **Session** | Memory only | Until Pi `/reload`, session/workspace switch, or shutdown. Never restored from transcripts. |
| **Project** | Host-owned `config.toml` for one canonical cwd | Until you change or remove it. |
| **Global** | Host-owned `default.toml` | Baseline for all projects, until changed. |

Normal precedence, lowest to highest:

**built-ins → environment → Global → Project → Session**

An omitted field inherits. Nested tables override individual fields.
**Lists in host-owned files replace lower-layer lists**; `[]` explicitly clears
one. For agent edits, use `upsert`/`remove` to adjust an entry without replacing
unrelated siblings. Don't copy the entire resolved configuration back into a file:
that would turn inherited settings and credentials into new scope-owned defaults.

Applying an edit reloads this sandbox automatically. Other sessions pick up
saved defaults on their next start/reload; there is no broadcast. A higher scope
can shadow your edit without being cleared automatically.

**Settings reload is not Pi `/reload`.** Actions → Reload settings keeps Session
overrides. Pi's extension `/reload` clears them, so inherited policy may become
more permissive. Persist lasting restrictions explicitly in Project or Global.
The panel requires a running VM for Session edits; the agent setter can propose
Session settings while inactive and may start a VM if `auto_start` is true.

## Host-owned project overrides

By default, policy lives here:

```text
~/.pi/agent/pi-microsandbox/default.toml
~/.pi/agent/pi-microsandbox/projects/<home-relative-cwd>/config.toml
```

For example:

| Start Pi in… | Project override under `~/.pi/agent/pi-microsandbox/` |
| --- | --- |
| `~/Code/app` | `projects/Code/app/config.toml` |
| `~/Code/app/server` | `projects/Code/app/server/config.toml` |
| Your home directory | `projects/config.toml` |
| `/srv/app` outside home | `projects-absolute/srv/app/config.toml` |

Identity comes from **canonical `realpath(cwd)`**, not Git. Symlink aliases of
the same directory share Project settings and the shared session boundary.
Nested directories have separate identities: **no parent-policy inheritance**.
Global remains unchanged. The agent can inspect origins and source locations so
you don't need to guess the right file.

Pi's `getAgentDir()` selects the agent directory, including `PI_CODING_AGENT_DIR`
and distribution-specific defaults. A host-selected symlink for that directory
is supported; its canonical location anchors saves. Policy files and directories
below it must not be symlinks. The lexical and canonical locations must stay
outside the workspace and all writable mounts, including alias/ancestor paths
that could replace the selected link. Retargeting the directory invalidates an
open proposal; cancel and reopen it.

Both host-owned layers load regardless of Pi's project trust state. They do not
sandbox project-local extensions or other code you choose to load on the host.

### Host-owned Dockerfile sources

You may put `Dockerfile` beside `default.toml` (Global) or the exact canonical
cwd's `config.toml` (Project), with an optional dedicated `build-context/` beside
it. No repository context or parent Project source is inherited. At each scope,
an explicit `image` wins over its colocated Dockerfile; otherwise the Dockerfile
supplies that scope's image. Project overrides Global; Session `image` overrides
both. Runtime settings show the content-addressed local image, source scope/path
in warnings and effective `pull_policy="never"`; raw scope files remain sparse.
Do not save a generated image reference as policy unless you intend to disable
discovery. Unrelated edits preserve source discovery.

Builds run inside an isolated disposable rootful VM using the bundled digest pin
and guest Docker/Buildx, then import a validated single-image tar via the host SDK.
No host Docker or CLI is needed. Build networking is public-download access plus
DNS, independently of runtime restrictions; no runtime secrets/env/mounts are
inherited. Source/content changes rebuild on the next settings reload/activation;
unchanged sources use a validated local cache. Build and built-image runtime
failures always block, even with host fallback configured. Inspection never builds
or creates cache directories. Input bounds, trust rules, disk requirements,
refresh behavior and the opt-in roundtrip are documented in
[Host-owned Dockerfile](images.md#host-owned-dockerfile-no-host-docker).

### When files appear

Setup, inspection, and reload create **no policy files or directories**. Saving
Global settings creates only the saved assignments in `default.toml`, not a
commented template. A Project save creates its override; Session creates nothing.
Existing files—even empty ones—are left alone until explicitly saved. Dockerfile
activation may separately create build cache records and SDK images; it does not
create or modify policy/source files.

New saved files use mode `0600`, new directories `0700` (subject to a stricter
umask). Saves revalidate targets, reject stale proposals, and replace files
atomically. Changed saves preserve unknown keys but not original comments/layout;
no-ops leave the file untouched. Portable filesystem checks cannot eliminate all
host-process races: keep policy host-owned and inaccessible to guest writes.
Unreadable or invalid configuration fails closed by default, not silently
ignored. [Backend guarantees →](settings-backend.md#file-safety-and-bounded-guarantees)

## Sandbox names

Automatic names are two random Docker-style words, such as `goofy-panini`,
from `@criblinc/docker-names`, without a prefix or numeric suffix. The selected
name is saved with the session and reused on reload/resume; previously saved
names are retained. Explicit `sandbox_name` settings are unchanged. Names are
not ownership credentials: session locks and verified labels still protect
resources. A name collision with another session fails closed, without
replacing its sandbox.

## A small TOML starter

Create this from a **host editor**, outside the mounted workspace. Omit `image`
to discover a host-owned Dockerfile, or use the bundled digest-pinned default
image when none is selected.

```toml
# ~/.pi/agent/pi-microsandbox/default.toml
cpus = 2
memory_mib = 4096
fallback_mode = "block"
show_footer = true

[network]
mode = "default"

[docker]
mode = "auto"
```

After external edits, use `/msb` → Actions → **Reload settings**. Normal panel
and agent-tool edits already reload automatically. A save can succeed while
activation fails; inspect the result rather than assuming the VM adopted it.

TOML uses snake_case; camelCase aliases also work. Agent-tool paths use
snake_case, but structured entry keys use camelCase (`hostEnv`, `allowHosts`,
`hostPath`, `guestPath`). Environment keys use `PI_MSB_` and `__` for nesting.
The getter's schema is the complete, discoverable setting reference.

## Networking

| `network.mode` | Meaning |
| --- | --- |
| `default` | Leave the Microsandbox SDK's default policy in place. Not an explicit allowlist. |
| `allowlist` | Default-deny, with configured destination and optional DNS rules. |
| `deny` | Disable VM networking. |
| `open` | Allow all traffic, including private/host access. A deliberate boundary expansion. |

```toml
[network]
mode = "allowlist"
allow_hosts = ["registry.npmjs.org", "api.example.com"]
allow_dns = true
publish_ports = []
```

Network hosts accept **exact ASCII DNS names**, IP addresses, or CIDRs. No URLs,
ports, wildcards, trailing dots, whitespace, or implicit subdomains. Use punycode
for international domains. Add `api.github.com` separately from `github.com`.

This is **DNS/IP matching, not per-request URL or TLS-hostname authorization**.
Shared IPs and cached hostname state matter; destination rules are not HTTPS-only.
With allowlist mode, `allow_dns = true` adds a separate TCP/UDP port 53 exception
to the SDK Host destination. It does not filter DNS queries by service domain or
promise protection against DNS exfiltration. Host/pass-through tools remain
outside VM network policy.

### Local servers and Docker ports

Published ports default to loopback unless you specify another bind address:

```toml
[network]
publish_ports = ["127.0.0.1:8080:8080"]
```

Create the outer mapping with the VM, and have the guest app listen on
`0.0.0.0:8080`. For Docker, also use an inner mapping such as
`docker run -p 0.0.0.0:8080:8080 …`. Docker `-p` alone exposes a port inside the
microVM, not on your host; random Docker port mappings cannot create outer
mappings. Nested-container egress stays behind the outer network policy.

## Secrets: bring the source, not the value

Prefer a host environment source:

```toml
[[secrets]]
env = "NPM_TOKEN"
host_env = "PROJECT_NPM_TOKEN"
allow_hosts = ["registry.npmjs.org"]
```

Each secret requires exactly one source:

| TOML source | What happens |
| --- | --- |
| `host_env` | Read the named variable from the host Pi process's environment. |
| `host_cmd` | Run a trusted host shell command; use stdout with trailing newlines removed. |
| `text_value` | Use literal text exactly as written. Human panel or host-file entry only. |

Secret `allow_hosts` must be nonempty. It accepts exact DNS names or one leading
wildcard such as `*.example.com` (add the apex separately), not IP/CIDR rules.
These scopes constrain TLS-verified credential substitution—**not network
access**. Add network grants separately if needed. Restricting networking does
not require deleting unrelated secrets.

Agent inspection exposes host variable names and host command text, **never
resolved credentials or literal values**. The setter can configure `hostEnv` or
`hostCmd`; it rejects `textValue`. Metadata-only upserts can retain an existing
private source without revealing it. The human panel masks all source fields
and never prefills them. Don't put credential bytes in command text or chat.

Host commands execute with **Pi's host privileges and environment**, not inside
the VM. Review their exact text before approval. They must print only the
credential on stdout and finish within 10 seconds and 64 KiB combined output.
Missing variables, nonzero exits, empty command output, timeouts, and excessive
output block creation without echoing the credential. Don't rely on the policy
file's directory as the command cwd.

Sources resolve at VM creation/recreation, **not inspection or saving**. An
approved edit may immediately recreate the VM and therefore resolve them during
activation. Tokens do not refresh automatically in a running VM.
Process-control variables such as `PATH`, `BASH_ENV`, `LD_PRELOAD`, `DOCKER_HOST`,
and `DOCKER_CONTEXT` cannot be forwarded or injected.

## Extra mounts and environment

Directory/file mounts require absolute host paths; guest paths default to the
host path. Mounts default to read-only. For example:

```toml
[[mounts]]
type = "dir"
host_path = "/Users/me/Datasets/sample"
guest_path = "/mnt/sample"
readonly = true
```

Use your own path. `named` mounts take a volume name as `host_path`; `tmpfs`
needs no host source. Supported options are `noexec`, `nosuid`, and `nodev`.
Mounts cannot overlap the cwd bind or shadow reserved `/tmp`, protected system
trees such as `/usr`, `/bin`, `/proc`, `/sys`, or Docker runtime paths such as
`/run`, `/var/run`, `/var/lib/docker`. Host sources are canonicalized and sockets
are rejected, including symlink aliases to host Docker sockets.

Writable mounts expose real host data and may not expose the host policy
directory—even before policy files exist, including future other-project files.
Keep credential files outside writable mounts too. `host_env` forwards explicitly
selected ordinary host environment variables; don't use it as a substitute for
destination-scoped secrets.

## Resources, tools, and other useful knobs

- **Resources:** defaults are 4 CPUs and 8192 MiB. Reduce them if your host is
  smaller. Resource changes may recreate the guest.
- **Images:** the default includes Node.js, Python, Rust, and Go and is pinned to
  an immutable image digest. Image versions are independent of package versions.
  `pull_policy` is `if-missing` by default; `always` and `never` are supported.
  [Choose or build an image →](images.md)
- **Bootstrap:** `bootstrap_tools = "auto"` probes required commands and may
  install missing ones using noninteractive `apt-get` under VM network policy.
  `false` blocks with the missing command list. Prepare images ahead of time for
  offline work. Docker is not installed by bootstrap.
- **Docker:** `docker.mode` is `auto`, `require`, or `disabled`. Auto tolerates
  images without Docker; require blocks if it is missing or cannot start.
  `docker.startup_timeout_ms` is an integer from 1 to 300000 (default 15000).
  Guest Docker state is disposable. [Storage →](storage.md)
- **Tools:** routed defaults are `read`, `write`, `edit`, `ls`, `find`, `grep`,
  and `bash`. Third-party tools are blocked by default except `web_search`,
  `source_check`, and `fetch_content` pass-throughs. `todo` and
  `ask_user_question` are not default exceptions. Permitted third-party tools
  run outside the VM, without per-call host approval. [Safety →](safety.md)
- **Footer:** `show_footer = true` uses Pi's single custom-footer slot. It keeps
  common location/usage/model/shared status fields, but replaces other custom
  footers and cannot reproduce every Pi-only indicator. Set false to hide it.
  The dot is green for an active sandbox, red when sandbox execution is blocked,
  and orange for other states, including sleep and explicit host execution.
  Flashing orange means booting or reloading configuration. Docker capability
  warnings alone do not turn an active sandbox red. While visible, the indicator
  periodically checks VM state without waking the guest; it is not a continuous
  health guarantee.
- **Lifecycle:** `auto_start = false` doesn't stop a running VM or hand tools to
  the host. Explicit off mode does. Keep `fallback_mode = "block"` for fail-closed
  operation; `"host"` opts into automatic unsandboxed execution after failure.

## Environment controls

Set these in your **host shell before launching Pi**. Host Global/Project and
Session settings take precedence, except `PI_MSB_DISABLE` remains authoritative.

```sh
PI_MSB_NETWORK__MODE=deny pi
PI_MSB_DOCKER__MODE=require pi
PI_MSB_SHOW_FOOTER=false pi
```

`PI_MSB_DISABLE=1 pi` deliberately runs in **unsandboxed host mode**. It is not a
safe way to work around an error. Remove the variable and restart to enable the
sandbox; saving settings cannot override it.

## Coming from an older setup?

- **In-repo `.pi-msb.toml` is ignored**, trusted project or not. Review and move
  intended policy into the host-owned Project location; don't copy secrets or
  broad permissions blindly.
- **Older host Project files named `.pi-msb.toml` are not auto-migrated.** The
  current exact target is `config.toml`. Inspect Sources and move intended
  assignments from a host editor. Cwd identity may also have changed.
- **Secret `value`, `$ENV:`, and `$FILE:` references are no longer supported.**
  Use `host_env`, `host_cmd`, or `text_value`. Reference-looking text inside
  `text_value` stays literal; it performs no lookup.
- **Legacy host inputs still work:** `$XDG_CONFIG_HOME/pi-msb/config.toml`
  (normally `~/.config/pi-msb/config.toml`) and `PI_MSB_CONFIG_FILE`. Relative
  explicit paths resolve from cwd; the file must still be outside the workspace.
  Their order is built-ins → legacy XDG → explicit file → environment → internal
  CLI overrides → host Global → host Project → Session. New approved saves target
  host Global/Project files, not these compatibility inputs.
- **No Git-root search or workspace modes.** Only cwd is mounted. Nested cwd
  doesn't inherit parent Project policy, and external worktree metadata isn't
  separately mounted. [Storage and legacy-volume recovery →](storage.md)
- **`/msb` is now the panel, not a subcommand family.** Use its Actions tree for
  lifecycle controls and agent tools for approved settings edits.
