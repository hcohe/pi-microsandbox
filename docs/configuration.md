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
| **Project** | Host-owned `config.toml`: shared main/root Git project from main, linked and nested cwd; otherwise canonical cwd | Until you change or remove it. |
| **Global** | Host-owned `default.toml` | Baseline for all projects, until changed. |

Normal precedence, lowest to highest:

**built-ins → environment → Global → Project → Session**

Public agent requests use only `session`, `project`, or `global`. Project always
selects one authoritative record; there is no persistent checkout-only override.

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

The table above describes **non-Git and unsupported-layout** cwd-local storage.
Supported Git main, linked and nested cwd all use the SAME main/root Project:
`<Pi agent dir>/pi-microsandbox/projects/<home-relative-canonical-main-checkout>/config.toml`
(or `projects-absolute/<absolute-main-path-without-root>/config.toml` outside home).
For example, `~/Code/app`, its `server/` subdirectory and linked worktrees all use
`projects/Code/app/config.toml`. Dockerfile and build-context/ are siblings.
Canonical aliases share policy; Session ownership and replacement checks remain
per current cwd, not repository-wide. There is no persistent Worktree scope.

Git Project confirmation is **No** (default) / **Apply shared Project (<name>)**.
The name is safely rendered. One freshly prepared diff/path/command review binds
approval to the shared target. Old checkout-only labels or destinations are rejected,
never reinterpreted as shared authorization. A broken Project requires repair of
that Project, not a lower-priority Worktree fallback.

Shared saves atomically include immutable reserved `[_repository]` metadata
(version, canonical common Git directory and main root) in the SAME config file.
It is private association metadata, not an editable setting; retain it during host
edits. An existing Git Project config without this association cannot activate; an
approved Project settings save can register it. Storage keys are readable canonical
paths, never hashes or GUIDs.
There is no separate registry transaction, per-worktree record, symlink or read-side
setup. New **registered** external or in-repository worktrees (`.worktrees/...`
included) automatically find the same Project. Read-only discovery checks reciprocal
Git registration without executing Git, shell, hooks, repository config or ambient
Git environment. The bounded host-owned catalog survives checkout gitfile deletion,
including nested cwd in a fresh process. Conflicting pointers fail closed. A nearer
nested repository/submodule/bare boundary cannot inherit an outer catalog entry.

This is a clean-start layout: there are no old hashed-path reads, aliases, copies,
checkout overlays or automatic migrations. No external host data is changed.

Readable Project keys cannot contain components named `build-context`, `config.toml`
or `Dockerfile` (ASCII-case-insensitive). These names are reserved for owned artifacts;
choose a different checkout path if a key conflicts. The restriction applies before
use or save, regardless of creation order. Ordinary nested Project directories work.
Catalog discovery never enters build-context, even for context-only saves, and never
interprets a source `config.toml` as association metadata.

Non-Git cwd, submodules, bare and unsupported separate-Git-directory layouts remain
cwd-local, without parent-policy inheritance. `core.worktree` cannot redirect policy.
Global is unchanged. **Policy identity never changes mounts or execution cwd**:
only canonical current cwd is automatically bound read/write at lexical current cwd.
Git ancestors, the main root and other worktrees are NEVER implicit mounts.

Catalog bounds are 256 config files, 4096 traversal entries (including directories),
256 directory levels, 4096 registrations per repository and 1 MiB
per config artifact; proof pointer files are limited to 16 KiB. Invalid,
unreadable, symlinked, conflicting or stale catalog metadata fails closed,
including an unrelated catalog entry whose main/common directory was removed.
Restore that host-owned repository location or have a human review/remove its
obsolete catalog policy; do not automatically discard policy to unblock loading.
The agent can inspect origins and source locations rather than guessing paths.

Pi's `getAgentDir()` selects the agent directory, including `PI_CODING_AGENT_DIR`
and distribution-specific defaults. A host-selected symlink for that directory
is supported; its canonical location anchors saves. Policy files and directories
below it must not be symlinks. The lexical and canonical locations must stay
outside the workspace and all writable mounts, including alias/ancestor paths
that could replace the selected link. Retargeting the directory invalidates an
open proposal; cancel and reopen it.

All host-owned layers load regardless of Pi's project trust state. They do not
sandbox project-local extensions or other code you choose to load on the host.

### Host-owned Dockerfile sources

You may put `Dockerfile` beside the selected host-owned policy (Global or Project), with an optional dedicated
`build-context/` beside it. No repository tree or parent cwd context is inherited.
An explicit scope `image` wins over its colocated Dockerfile; otherwise that
Dockerfile supplies its image. Project overrides Global; Session `image` overrides
all. A Project Dockerfile starting `FROM GLOBAL` explicitly extends the current
Global Dockerfile, regardless of Global `image` intent; each uses its own context.
Missing/unsafe Global sources or recursive Global inheritance fail closed.
This does not change scope selection. Current inputs are prepared at actual
runtime boot, not source save or passive inspection. See
[Global inheritance](images.md#extend-the-global-dockerfile).
Dockerfile/context Project saves use the same shared main-root record as config
from main, linked and nested cwd, with one exact-target source review.
A first shared source save explicitly registers the same immutable `_repository`
metadata in shared config; it preserves user/unknown keys and image intent (TOML
formatting/comments may change only when adding metadata). Existing valid config
metadata is never rewritten. This covers current/future registered worktrees,
including after gitfile deletion. Getter and write expose only Project or Global,
with no Repository/Worktree destination argument. Non-Git/unsupported layouts stay
local. Neither config nor source saves copy existing Dockerfiles/contexts. Source tools support bounded relative UTF-8 context PATCH
(create/update/delete/executable), preserving unspecified and binary files.
Multi-artifact saves are individually, not jointly/crash atomic; partial/unknown
persistence never reloads. Runtime settings show the content-addressed local image, source scope/path
in warnings and effective `pull_policy="never"`; raw scope files remain sparse.
Do not save a generated image reference as policy unless you intend to disable
discovery. Unrelated edits preserve source discovery.

Builds run inside an isolated disposable rootful VM using the bundled digest pin
and guest Docker/Buildx, exporting a validated single-image tar. Explicit load
imports that artifact via the host SDK.
No host Docker or CLI is needed. Build networking is public-download access plus
DNS, independently of runtime restrictions; no runtime secrets/env/mounts are
inherited. `msb_dockerfile_write` persists sources only; explicit
`msb_dockerfile_build` autonomously exports a reusable verified artifact without an
approval dialog or UI (including headless/print). Write and load retain separate
default-No approval; explicit `msb_dockerfile_load` imports/selects the chosen
artifact and requests guarded reload. Actual startup/restart automatically checks
the current Dockerfile, context and `FROM GLOBAL` identity against native MSB
build/selected references. Matching native digests reuse the image with no build
or import; changed/missing selections are built and imported before boot without
separate load approval. Source saves and no-op/live-settings reloads remain
nonbuilding. Deleted Dockerfiles may retain their native selection, but unsafe
sources or missing required dependencies fail closed. Failed build leaves sources
and the previous image intact; failed explicit load retains the artifact for retry.
Fresh integrations conservatively recreate persisted VMs whose actual image digest
cannot be proved, even when the native image is reused. Built-image preparation and
runtime failures block stale-image boot and host fallback. Inspection never builds
or creates cache directories. Input bounds, trust rules, disk requirements,
refresh behavior and the opt-in roundtrip are documented in
[Host-owned Dockerfile](images.md#host-owned-dockerfile-no-host-docker).

### When files appear

Setup, inspection, and reload create **no policy files or directories**. Saving
Global settings creates only the saved assignments in `default.toml`, not a
commented template. A Project save creates only its selected override (including association metadata
for a shared save); Session creates nothing.
Existing files—even empty ones—are left alone until explicitly saved. Dockerfile
activation may separately create build cache records and SDK images; it does not
create or modify policy/source files.

New saved files use mode `0600`, new directories `0700` (subject to a stricter
umask). Saves revalidate targets, reject stale proposals, and replace files
atomically. Changed saves preserve unknown keys but not original comments/layout;
no-ops leave the file untouched. Portable filesystem checks cannot eliminate all
host-process races: keep policy host-owned and inaccessible to guest writes.
The catalog and every catalogued repository's reciprocal proof tree are reserved
against explicit writable mounts, even from unrelated projects. The default main
checkout bind still exposes its `.git` read/write: it is a cross-worktree trust
boundary, as are overlapping/broader cwd binds able to edit that metadata. This
is not protection from an authorized main-checkout write or host control.
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
- **No Git-root-selected mounts or workspace modes.** Only cwd is mounted. Nested
  Git cwd shares main-root Project policy but never an ancestor bind. External
  worktree metadata isn't separately mounted. [Storage and legacy-volume recovery →](storage.md)
- **`/msb` is now the panel, not a subcommand family.** Use its Actions tree for
  lifecycle controls and agent tools for approved settings edits.
