# Command reference

[Back to README](../README.md)

The extension registers `/msb`:

```text
/msb status
/msb on | off | reload
/msb prune
/msb volumes ls
/msb volumes rm <managed-name> [--yes]
/msb export <paths...> [--to dir] [--yes]
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

`/msb status` reports the full sandbox name, mode, image, PID, age, branch/SHA,
and retained volume metadata when available. Six-character IDs in UI text are
display abbreviations only. `/msb prune` walks all SDK list pages and reports
removed, kept, and error entries; **volumes are never pruned**.

Volume removal is the sole destructive volume path. It requires a managed,
unmounted volume and an owner lock. Confirmation displays path, branch, last
commit, and dirty-count metadata; use `--yes` only when the command is running
without UI and the target has already been verified. Export rejects paths outside
the project and existing destinations; it also requires confirmation or
`--yes`.

For the narrow exceptions to sandboxed file reads, see [host-read exceptions](safety.md#host-read-exceptions).
