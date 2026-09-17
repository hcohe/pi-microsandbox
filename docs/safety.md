# Safety model

[Back to README](../README.md)

The default is fail-closed:

- A valid, trusted project configuration is resolved before a sandbox starts. A
  boot, image, configuration, or tool failure blocks the seven routed tools
  (`read`, `write`, `edit`, `ls`, `find`, `grep`, and `bash`). Failure never
  silently falls back to host execution.
- `execution_target = "host"` is an opt-in escape for routed tool calls. While
  a sandbox is active it requires interactive approval for the exact tool,
  working directory, and recursively sorted arguments. It is unavailable in
  headless operation and is never silently selected.
- `/msb off` is an explicit host-mode handoff and does not prompt. This is
  different from `fallback_mode = "host"`, which automatically uses host tools
  after a sandbox failure and is shown as `MSB host fallback`. Both are
  unsandboxed controls, not workspace settings.
- A project cannot replace another process's sandbox: ownership is a
  non-blocking kernel `flock` acquired before sandbox mutation. The small
  bundled POSIX addon is loaded lazily, has no install script, and never falls
  back to a racy PID check.

There are no workspace modes. Inside a Git worktree, pi-microsandbox
bind-mounts the entire worktree root read/write at the same lexical guest path.
Outside Git, it bind-mounts the current directory. Commands start in the
original current directory, but their path boundary is the selected root.

This mount deliberately exposes host files. A Git worktree mount includes
`.git`, untracked files, secrets such as `.env`, and sibling directories even
when Pi starts in a subdirectory. Writes are immediately visible on the host,
and separate sessions using the same checkout can read or overwrite one
another's work. Use separate host worktrees or checkouts for isolation between
sessions. Unsafe root mappings fail startup rather than falling back to a
narrower mount.

The extension entry point does not import the native SDK or load the flock
addon. Unsupported hosts can still load Pi and remain blocked or explicitly
off. pi-microsandbox supports Apple Silicon macOS and GNU Linux x86_64 or arm64
with KVM; Windows, Intel macOS, and musl Linux are not supported.

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
