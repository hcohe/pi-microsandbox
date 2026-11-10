# Small VM. Real boundaries.

[Back to README](../README.md)

A sandbox is useful when you know what stays inside—and what doesn't. Here's
our deal, without the force-field marketing.

## Fail closed by default

With the default `fallback_mode = "block"`, failed configuration, startup,
images, or tool execution block ordinary routed tools: `read`, `write`, `edit`, `ls`,
`find`, `grep`, and `bash`. A broken VM is **not** permission to retry on your
host. Malformed/truncated command completion is an error even if some output
arrived; cleanup is best-effort and never becomes a host retry.

There are explicit ways to leave that boundary:

| Control | What you authorize |
| --- | --- |
| Routed call with `execution_target = "host"` | One exact tool/cwd/argument set, with interactive No-first approval when active; unavailable/disabled recovery permits only Bash with ready identity/configuration and an explicit finite positive timeout ≤120 seconds. Headless use is unavailable. |
| `/msb` → Actions → Turn off | An explicit handoff to unsandboxed host tools after confirmation. |
| `PI_MSB_DISABLE=1` | Launch in explicit unsandboxed off mode. |
| `fallback_mode = "host"` | Automatic unsandboxed tool execution after sandbox failure, visibly marked as host fallback. |
| Pass-through tools / permitted third-party tools | Execution outside the VM, without per-call host approval. |

Host recovery first uses passive `msb_diagnostics` and `msb_config_get`. The agent
must explain the narrow live diagnostic need before requesting approval of the
exact command and execution cwd (the fixed session cwd by default). The Bash timeout remains part of the
authorized request and is enforced, but has no separate approval-dialog row.
The dialog warning is exactly:
`Warning: this operation runs on the host and bypasses any isolation.`
Existing host permission is required;
unresolved configuration/identity and booting/stopping remain blocked. Every call
needs fresh approval; no grant or automatic host retry is created. Recovery binds
to the canonical cwd and physical directory identity captured during workspace
discovery, rechecked before the prompt, after approval, and before host handoff.
Changed aliases, replaced directories, and missing/unprovable roots fail closed;
restoring a path never restores a failed approval. Public filesystem path checks
and process spawning are not jointly atomic against host filesystem races.
Shell commands
have real host-user privileges, are not guaranteed read-only, and timeout does not
guarantee descendant confinement.

Agent-requested host Bash must be **one simple, clear, human-readable command per
call and per approval**: a normal executable with literal arguments and only
necessary quoting. Run every step separately with fresh approval, and explain
its purpose, narrow need for host execution and relevant effects in one short
sentence. Do not repeat the literal command in the agent description or narration;
the approval dialog already shows the exact command. Do not narrate timeout choices or routine execution settings unless
asked or diagnosing a timeout failure; timeouts remain enforced. Mention the
execution directory in request prose only when it differs from the default session
cwd; otherwise omit directory narration. Avoid repetitive operational narration.
The approval dialog still shows the actual working directory.
No chaining (`&&`, `||`, semicolons), pipelines, multiline command sequences,
shell substitutions (`$()` or backticks), loops, `eval`, encoded payloads,
`sh -c`, code-oneliners or script wrappers hiding multiple operations. Do not
characterize arbitrary shell as harmless or read-only. These are strict agent
instructions, not a shell parser or a change to execution permissions.

Host Bash accepts an optional `cwd` for an existing directory (at most 4096 UTF-8
bytes, without control/bidi/newline characters). Omitted means the fixed session
cwd; relative paths resolve against that same session cwd, never the previous
command or Pi process cwd. Use this parameter instead of `cd` or chaining.
The dialog shows the normalized directory and, for symlink aliases, the canonical
execution target. Directories outside the canonical **current session/VM workspace**
use the theme's error/red color, including sibling-prefix paths and symlink escapes.
This boundary is not the main checkout's shared Project policy/storage root.
RPC/select-only prompts show the same paths without color. The TUI command uses
real Bash syntax highlighting over the theme's green success-color base after
terminal controls are escaped; wrapping keeps
the complete visible command intact. RPC/select-only command text remains plain.

Each one-shot approval binds the requested cwd, normalized/canonical paths and
physical directory identity. Requested-directory and original session-root proofs
are rechecked before approval, after Yes and before host handoff; failed validation
consumes/invalidates that approval even if paths are restored. Changing the cwd
requires fresh approval. The native host Bash tool runs directly in the approved
canonical directory; this does not change VM mounts or shared Project identity.
`cwd` is rejected for sandbox Bash, non-Bash tools and explicit off/host-fallback
mode (whose existing behavior without `cwd` is unchanged). Filesystem validation
and process spawn still cannot be made jointly atomic with public path APIs.

Keep block mode for untrusted work. The default pass-throughs are `web_search`,
`source_check`, and `fetch_content`; other third-party tools are blocked unless
you explicitly allow them. Host/pass-through tools are outside VM network rules.
Project-local extensions and other code you choose to load on the host aren't
sandboxed by this configuration layer.

Session/cwd replacement immediately invalidates host approvals and host-read
grants. New routed calls stay blocked during setup; admitted old sandbox calls
may finish before their transport is retired. An approval for yesterday's cwd
is not permission for a replacement directory.

## Your cwd is a live read/write bind

The host source is **canonical `realpath(cwd)`**. The lexically resolved cwd
path is both the guest root and command cwd. No Git-root discovery, no automatic
Git ancestors/siblings, no export/sync phase. Writes reach host files immediately.
Unsafe path layouts fail startup instead of silently selecting another root.

Everything inside cwd is exposed: `.git`, ignored files, untracked files,
configuration, and secrets. Overlapping sessions share those host files. Separate
worktrees/checkouts give you independent changes, not automatic secret isolation.

External linked-worktree/submodule metadata is not separately mounted. Guest Git
may need explicit setup or mounts. Metadata inside cwd stays accessible but never
selects the bind. Extra mounts and approved host controls can widen access.

### Local files and secrets are your responsibility

**A `.gitignore` is not a secret filter.** Neither is the VM boundary for a file
you deliberately mount inside it. pi-microsandbox doesn't hide `.env` files or
scrub your checkout. Put only credentials the agent may access in that tree.

[Worktrunk](https://worktrunk.dev/) can help manage worktrees and setup hooks,
including a dedicated `.env` per worktree. It is workflow tooling, not secret
isolation. Avoid copying production credentials into agent worktrees.

## Keep policy on the host

**Global** and **Project** files live under Pi's host-owned agent directory,
outside the workspace and writable mounts. **Session** overrides are memory-only
and higher priority. Lists in host-owned files replace lower lists. Unspecified
fields aren't locked: configuring a secret doesn't also pin host fallback,
networking, or tool permissions. [Configuration →](configuration.md)

No files are created by setup, reload, or inspection. Approved persistent saves
use atomic replacement, mode `0600` files and `0700` new directories, rechecking
identity, target safety, and external changes. A selected-agent-directory symlink
is supported; policy descendants cannot be symlinks. Writable mounts cannot
expose policy roots or paths that let the guest replace their aliases, even if
files haven't been created yet. Host-process filesystem races aren't completely
preventable; the directory must remain host-controlled.

Session restrictions reset on Pi `/reload`, session/workspace switch, or
shutdown; transcript resume doesn't restore them. Ordinary settings reload keeps
them. Persist lasting restrictions in Project or Global. Git main, linked and
nested cwd share main-root Project policy, never a broader mount or Session grant.
Session ownership and replacement safety remain per canonical current cwd.
Non-Git/unsupported layouts remain cwd-local; Global stays unchanged. Readable
host-owned Project storage never changes the cwd boundary or imports old grants.

## Approved configuration tools

`msb_config_get` is read-only, including headless use. `msb_config_set` requires
fresh explicit No-first approval for every scoped operation or batch. Existing
host-execution permission doesn't waive approval. No interactive UI means no
mutation. Changed files, session identity, overrides, or runtime invalidate the
proposal; it isn't silently rebased or retried.

The tool dialog shows the scope, masked diff, and executable host commands for
authorization. Relevant impact warnings are returned to the agent after
completion, not included as warning lines in that dialog; ask it to explain them.
A save and runtime adoption are separate outcomes. Failed activation does not
undo an already saved setting and never authorizes host fallback.

`msb_diagnostics` provides passive, cached recovery information without commands,
SDK loading, file/environment reads, logs, credentials, or VM startup. These three
exact management-tool names receive an exemption only when registration
provenance resolves to this extension's actual entry module. An arbitrary
`msb_*` tool or foreign registration doesn't inherit it. [Tool contract →](tools.md)

## Credentials: know which parts are private

Literal credential values and resolved bytes are hidden from agent configuration
outputs. **Host variable names and host command text are visible metadata.**
The agent can configure those sources but cannot submit literal `textValue`
credentials. Use the human panel or a host-owned file for literals.

A `hostCmd` runs with Pi's **host privileges**, not inside the guest. Review only
trusted commands and never embed credentials in their text. Inspection and saving
don't execute them; VM creation/recreation resolves sources, including during
activation after an approved save. Tokens aren't automatically refreshed in a
running VM. Secret destination scopes limit credential substitution, not network
access, and do not protect secret files in the mounted cwd.

Configured credential bytes are redacted from recent-log display, but arbitrary
application logs can contain other sensitive data. Share minimal, reviewed,
redacted evidence—not a complete log dump.

## Network policy is not a URL firewall

Network rules match exact DNS names via remote-IP hostname/cache state, or
explicit IP/CIDR destinations. They are not per-request URL/TLS-hostname
authorization and don't restrict traffic to HTTPS. Shared IPs/cache state matter.
Enabled DNS adds a separate runtime-host TCP/UDP port 53 exception, not a
service-domain query filter or a DNS-exfiltration guarantee.

Desired policy is not proof of active enforcement. Adopted policy is last-known;
reconnected VMs may have unverified network state. No-op/live-only edits don't
verify it. Connectivity tests prove only the destinations tested.
[Network configuration →](configuration.md#networking)

## Docker lives inside the guest

The daemon uses the guest Unix socket. It's root-equivalent **inside the VM**,
not on your host. The extension never mounts the host Docker socket, starts a
host daemon, or copies host Docker configuration/registry credentials into the
guest. Preparation clears Docker/process-control environment variables; config
cannot forward them or shadow protected runtime paths with mounts.

Nested containers can still reach the workspace and extra mounts. Treat Docker
and Compose files as guest-root code with access to that data. Use read-only
extra mounts where possible. Container egress remains behind outer VM policy.

## Narrow host reads and ownership

When allowed, Pi-discovered skills are a narrow host-read exception: a standalone
skill grants its exact `SKILL.md`; a directory skill grants regular files
canonically below that directory. Symlink escapes, sockets, devices, and unrelated
paths are denied. A successful sandbox Bash/grep result can grant its exact
`details.fullOutputPath`, never neighboring files.

Sandbox mutations require a nonblocking kernel `flock` and verified managed
labels. One process cannot replace another live owner's VM, and locking never
falls back to a racy PID check. Failed retirement relinquishes cleanup authority;
recovery/pruning must reacquire and verify ownership. Legacy named volumes are
not automatically deleted.

This is not a guarantee against every sandbox escape. Report suspected
vulnerabilities [privately](../SECURITY.md), not in a public issue.
