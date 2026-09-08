# Storage modes and retained work

[Back to README](../README.md)

## Storage modes

| Mode | Guest view | Host effect of routed writes |
| --- | --- | --- |
| `git` | A named volume at the repository root, with the same absolute path | Volume only |
| `direct` | The current directory bind-mounted at the same absolute path | Host directory |
| `none` | An empty tmpfs at the same absolute path | No host files; changes disappear with the sandbox |
| `auto` | Same as `direct` | Host directory |

`direct` is intentionally a warning-level escape from the Git isolation model:
routed edits modify the live host directory. `none` is useful for testing path
behavior and starts empty; it is not a retained workspace.

## Git and retained volumes

Git mode never bind-mounts the host checkout. On boot, pi-microsandbox captures the
committed `HEAD` (and selected branch) into a temporary verified Git bundle,
copies it into the guest, and seeds a named volume mounted at the repository's
absolute root. Untracked files, including `.env`, and working-tree edits are
not in that bundle. The temporary host and guest bundle files are removed after
seeding, including failure paths.

Edits and commits made in Git mode land in the retained volume. The host
checkout is not changed by ordinary routed tools. A normal Pi session shutdown
removes the sandbox but keeps the managed volume; the next boot reuses it only
when the complete session/schema/mode/cwd identity matches. A copied or forked
session state is rejected by the full session ID and gets a different resource
identity.

The SDK's `VolumeHandle` returned by `Volume.get()` does not expose a host
path. pi-microsandbox therefore refuses to fabricate one: a newly created volume
may show its path, while a later retained-volume lookup may not support
`/msb volumes ls` or volume enrichment. The volume remains mountable by name
and is never automatically deleted. Use the path recorded at creation time or
the microsandbox volume tooling when host-side inspection is required.

To manually synchronize a retained checkout, use a host-side fetch deliberately
(the command is not performed automatically by pi-microsandbox):

```sh
REPO=/absolute/path/to/checkout
VOLUME_PATH=/path/returned-for-the-managed-volume
BRANCH=$(git -C "$REPO" branch --show-current)

git -C "$VOLUME_PATH" remote remove host 2>/dev/null || true
git -C "$VOLUME_PATH" remote add host "$REPO"
git -C "$VOLUME_PATH" fetch --no-tags host "$BRANCH"
# Review before changing the retained checkout:
git -C "$VOLUME_PATH" log --oneline --decorate --all -10
```

The host repository is an input to this explicit sync operation. Do not add a
host checkout bind mount to Git mode.
