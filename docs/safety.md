# Safety model

[Back to README](../README.md)

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
  The small bundled POSIX addon is loaded lazily, has no install script, and
  never falls back to a racy PID check. Stale sandbox pruning never removes
  volumes.

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
protected guest executables or Docker runtime paths are rejected. The extension never mounts the host Docker
socket, starts a host daemon, or copies host Docker configuration and registry
credentials into the guest.

A container can still reach anything already mounted into the microVM. In
`direct` mode that includes the host project directory; in Git mode it includes
the retained workspace; explicitly configured mounts are visible too. Treat a
Dockerfile or Compose file as guest-root code and use read-only mounts where
possible. Container egress remains behind the Microsandbox network policy.

## Host-read exceptions

Pi-discovered `SKILL.md` reads are a narrow host-read exception. A standalone
skill grants only its exact file; a directory skill grants regular files
canonically below its directory. Symlink escapes, devices, sockets, and
unrelated host paths are denied. A successful sandbox Bash/grep result may
record one exact generated `details.fullOutputPath`; neighboring files do not
become readable.

## Reporting vulnerabilities

Report suspected vulnerabilities privately. See the [security policy](../SECURITY.md); do not open a public issue.
