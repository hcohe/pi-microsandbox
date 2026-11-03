# Safety model

[Back to README](../README.md)

The default is fail-closed:

- Configuration, including host-owned defaults and project overrides, is
  resolved before a sandbox starts. A boot, image,
  configuration, or tool failure blocks the seven routed tools
  (`read`, `write`, `edit`, `ls`, `find`, `grep`, and `bash`). Failure never
  silently falls back to host execution.
- `execution_target = "host"` is an opt-in escape for routed tool calls. While
  a sandbox is active it requires interactive approval for the exact tool,
  working directory, and recursively sorted arguments. It is unavailable in
  headless operation and is never silently selected.
- `/msb` → Actions → Turn off is an explicit host-mode handoff and asks for
  confirmation before stopping/removing the guest. This is
  different from `fallback_mode = "host"`, which automatically uses host tools
  after a sandbox failure and is shown as `MSB host fallback`. Both are
  unsandboxed controls, not workspace settings.
- A project cannot replace another process's sandbox: ownership is a
  non-blocking kernel `flock` acquired before sandbox mutation. The small
  bundled POSIX addon is loaded lazily, has no install script, and never falls
  back to a racy PID check.

Inside a Git worktree, pi-microsandbox bind-mounts the entire worktree root
read/write at the same lexical guest path.
Outside Git, it bind-mounts the current directory. Commands start in the
original current directory, but their path boundary is the selected root.

This mount deliberately exposes host files. A Git worktree mount includes
`.git`, untracked files, secrets such as `.env`, and sibling directories even
when Pi starts in a subdirectory. Writes are immediately visible on the host,
and separate sessions using the same checkout can read or overwrite one
another's work. Use separate host worktrees or checkouts for isolation between
sessions. Unsafe root mappings fail startup rather than falling back to a
narrower mount.

### Local files and secrets are your responsibility

pi-microsandbox does not manage local-file security: it does not hide, filter,
or restrict access to `.env` files or other sensitive information inside the
mounted workspace. Git ignore rules do not prevent the sandbox from reading
those files.

We recommend [Worktrunk](https://worktrunk.dev/) for managing separate worktrees
and automating per-project or per-worktree setup with hooks. Use that workflow
to prepare a dedicated `.env` containing only credentials the agent may access,
and review it before starting Pi. Avoid copying production secrets into agent
worktrees. Worktrunk is workflow tooling, not a secret-filtering security boundary;
any sensitive file placed in the mounted workspace remains accessible.

The extension entry point does not import the native SDK or load the flock
addon. Unsupported hosts can still load Pi and remain blocked or explicitly
off. pi-microsandbox supports Apple Silicon macOS and GNU Linux x86_64 or arm64
with KVM; Windows, Intel macOS, and musl Linux are not supported.

## Host-owned configuration

Use [host-owned defaults and project overrides](configuration.md#host-owned-project-overrides)
under Pi's agent directory to pin security-sensitive fields. Keep configuration
outside the mounted worktree and all writable mounts.
The first enabled session creates a missing `default.toml` as a fully commented
reference, not an active policy; existing files (even empty ones) are preserved.
New files use mode `0600`, new directories `0700`, and setup errors block startup.
`pi-microsandbox/default.toml` applies to all projects; a host-owned per-project
file overrides it. Both take precedence over launch environment/CLI settings;
deliberate ephemeral panel changes sit above both files, last only for the current
session and are not written to its transcript. Host lists replace rather than
extend lower-layer lists. `PI_MSB_*`
environment variables and session `/msb` controls are also supported.
Panel saves revalidate canonical host targets and workspace/mount guards, reject
symlink targets/ancestors and external changes, and replace files atomically with
mode 0600 (new directories 0700). Portable filesystem checks cannot prevent every
host-process race; the policy directory must remain host-owned and inaccessible
to guest writes. Save confirmation is a security decision: open networking,
pass-through tools, host fallback and writable mounts widen the boundary.
Secrets use masked entry and are never prefilled; unchanged raw references stay
private. Configured secret bytes are redacted from recent log display, but guest
application logs may contain other sensitive data. Do not share logs blindly.

Unspecified settings are **not** locked. Missing overrides preserve the usual
configuration behavior; unreadable or invalid overrides fail closed.

Keep policy files and their symlink targets outside the mounted workspace. While a
host policy is active, extra writable mounts may not overlap its directory,
including locations for project overrides not yet created. Keep policy and
credential files outside writable mounts. A project override applies to one
canonical workspace identity, not to arbitrary other workspaces or host
processes. Explicit user host-mode controls remain available. Project trust also permits Pi to load project-local extensions;
this configuration layer does not sandbox such host-side code.

## Docker inside the guest

The Docker daemon runs inside the microVM and listens only on the guest Unix
socket. Access to that socket is root-equivalent inside the guest, not on the
host. Readiness probes explicitly select that socket and reject unverified
socket ownership. Docker and process-control environment variables are cleared
for preparation, and configuration cannot forward them. Mounts that shadow
protected guest executables or Docker runtime paths are rejected. The extension
never mounts the host Docker socket, starts a host daemon, or copies host Docker
configuration and registry credentials into the guest.

A nested container can still reach anything mounted into the microVM, including
the entire selected workspace and explicitly configured mounts. Treat a
Dockerfile or Compose file as guest-root code and use read-only extra mounts
where possible. Container egress remains behind the Microsandbox network
policy.

## Host-read exceptions

Pi-discovered `SKILL.md` reads are a narrow host-read exception. A standalone
skill grants only its exact file; a directory skill grants regular files
canonically below its directory. Symlink escapes, devices, sockets, and
unrelated host paths are denied. A successful sandbox Bash/grep result may
record one exact generated `details.fullOutputPath`; neighboring files do not
become readable.

## Reporting vulnerabilities

Report suspected vulnerabilities privately. See the
[security policy](../SECURITY.md); do not open a public issue.
