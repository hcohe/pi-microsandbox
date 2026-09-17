# Command reference

[Back to README](../README.md)

The extension registers `/msb`:

```text
/msb status
/msb on | off | reload
/msb prune
/msb logs [tail-lines]
/msb config
/msb set <key> <value>
/msb unset <key>
/msb reset
/msb network allow <host...> | deny
/msb seal
/msb mount add <json|hostPath guestPath [--readonly]>
/msb mount rm <guest-path>
/msb help
```

`/msb status` reports the full sandbox name, mounted workspace root, image, PID,
age, and Docker mode, readiness, version, and storage driver. Six-character IDs
in UI text are display abbreviations only. There are no workspace modes.

`/msb prune` walks all SDK list pages and reports removed, kept, and error
entries. It can remove guarded stale sandboxes, including old-schema managed
sandboxes, but it never removes legacy named volumes.

`/msb off` explicitly switches to unsandboxed host execution. It is separate
from `fallback_mode = "host"`, which opts into automatic host execution after a
sandbox failure. With the default blocking fallback, startup failures fail
closed and routed tools do not silently run on the host.

The former `/msb volumes` and `/msb export` commands are not available. Files in
the current workspace already live on the host. Legacy named volumes from older
releases require manual inspection, recovery, and removal with Microsandbox's
own tooling; see [workspace storage](storage.md#upgrading-from-named-git-volumes).

For the narrow exceptions to sandboxed file reads, see
[host-read exceptions](safety.md#host-read-exceptions).
