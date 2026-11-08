# Where your files actually live

[Back to README](../README.md)

## One read/write workspace

No syncing. No export button. **Edits are already on your host.**

pi-microsandbox mounts only canonical `realpath(cwd)` read/write. Its lexically
resolved cwd path is both the guest root and command cwd. There are no workspace
modes or Git-root discovery: starting in `app/server` exposes that directory,
not its Git ancestors or sibling directories outside cwd.

| Data | Where it lives | Survives VM removal? |
| --- | --- | --- |
| Files in cwd | Host read/write bind | **Yes**, including edits/deletions |
| Extra host mounts | Host paths you explicitly expose | **Yes**, including permitted writes |
| Ordinary guest-local files | VM root filesystem | No |
| Inner Docker images, containers, cache | Guest `/var/lib/docker` | No |
| Session setting overrides | Extension memory | Yes within the same Pi session; cleared by reset, Pi `/reload`, session/workspace switch, or shutdown |
| Project/Global settings | Host-owned agent directory | Yes |

Everything inside cwd stays visible: `.git`, `.env`, ignored files, and
untracked files. Git ignore rules do not protect secrets. Sessions with
overlapping binds can overwrite each other's files. Separate host worktrees or
checkouts are your friend when tasks need independent changes.

[Worktrunk](https://worktrunk.dev/) can help manage worktrees and setup hooks,
such as preparing a dedicated `.env` with only agent-appropriate credentials.
It isn't secret filtering; sensitive files placed in the mount remain accessible.
[Safety guide →](safety.md#local-files-and-secrets-are-your-responsibility)

## Cwd, Git, and Project identity

Canonical cwd determines the Project settings identity and shared session
boundary. Symlink aliases share that identity; nested cwd does not inherit its
parent's Project overrides. Global remains unchanged.
[Project paths →](configuration.md#host-owned-project-overrides)

Git metadata inside cwd is exposed but never chooses the bind. Linked-worktree
or submodule metadata outside cwd is **not mounted separately**, so Git in the
guest may need explicit setup or reviewed mounts. Extra mounts and approved host
controls widen access separately. An unsafe cwd/symlink layout fails startup;
it doesn't silently select another root or run on the host.

## Docker's cupboard is disposable

Inner Docker uses the guest `/var/lib/docker` and the `vfs` storage driver;
nested overlay filesystems aren't assumed to support `overlay2`. Removing or
recreating the VM discards images, layers, containers, and build cache. Sessions
don't share this cache. Guest-root state isn't stored in your project bind.

Containers can still reach host-backed mounts, including the workspace. Treat
Dockerfiles and Compose files as code with access to those files. VM recreation
is not a way to undo host writes.

## Upgrading from named Git volumes

Older releases could keep workspaces in `pi-msb-vol-*` named volumes. Current
versions do not reconnect, migrate, export, or delete them. They may hold the
**only copy of unexported work**.

Before upgrading, use the old version's `/msb volumes` and `/msb export` to
inventory and rescue needed work. If you've already upgraded, use the
Microsandbox CLI from a trusted **host shell**:

```sh
msb volume ls
mkdir -p ./legacy-workspace-recovery
msb run --name pi-msb-recovery \
  --mount-named pi-msb-vol-REPLACE_ME:/legacy:ro \
  --mount-dir "$PWD/legacy-workspace-recovery:/recovery:rw" \
  alpine -- sh -c 'cp -a /legacy/. /recovery/'
msb rm pi-msb-recovery
```

Copy the exact volume name from `msb volume ls`; a mistyped named mount can
create a new empty volume. Use an empty recovery directory and an already-cached
recovery image if `alpine` is unavailable. This is a manual runtime operation,
not something current `/msb` manages.

**Verify the recovered files before deleting the original volume.** Only then:

```sh
msb volume rm pi-msb-vol-REPLACE_ME
```
