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
  Stale sandbox pruning never removes volumes.

The extension entry point does not import the native SDK. Unsupported hosts can
still load Pi and remain blocked or explicitly off. pi-microsandbox currently supports
macOS Apple Silicon and Linux with KVM; Windows is not supported.

## Host-read exceptions

Pi-discovered `SKILL.md` reads are a narrow host-read exception. A standalone
skill grants only its exact file; a directory skill grants regular files
canonically below its directory. Symlink escapes, devices, sockets, and
unrelated host paths are denied. A successful sandbox Bash/grep result may
record one exact generated `details.fullOutputPath`; neighboring files do not
become readable.

## Reporting vulnerabilities

Report suspected vulnerabilities privately. See the [security policy](../SECURITY.md); do not open a public issue.
