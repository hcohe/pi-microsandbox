# Workspace storage

[Back to README](../README.md)

## One read/write workspace

There are no workspace modes. pi-microsandbox selects one workspace root when
it starts:

- If the current working directory is inside a Git worktree, it mounts the
  entire worktree root.
- Otherwise, it mounts the current working directory itself.

The selected root is bind-mounted read/write at the same lexical path inside
the guest. Commands still start in the original current working directory.
Writes are immediately visible in the host directory; there is no export or
synchronization step.

Starting Pi below a Git worktree root does not narrow the boundary. The sandbox
can see the whole worktree, including `.git`, untracked files, sibling
directories, and files such as `.env`. Separate Pi sessions that use the same
checkout also use the same files, so their edits can conflict. Use separate
host worktrees or checkouts when tasks need independent workspaces.

The extension creates one project bind mount. Linked-worktree or submodule Git
metadata stored outside the selected worktree root is not mounted separately.
An unsupported path or symlink layout fails startup instead of silently
mounting a narrower directory.

## Inner Docker state

Docker stores images, layers, containers, and build cache under
`/var/lib/docker` on the sandbox root filesystem. It uses the `vfs` storage
driver because nested overlay filesystems and project-backed mounts cannot be
assumed to support `overlay2`. This state disappears when the sandbox is
removed and is not written to the project mount. Separate sessions do not share
an inner Docker cache.

Containers started inside the microVM can reach the mounted workspace. Treat
Dockerfiles and Compose files as code with access to the entire selected root.

## Upgrading from named Git volumes

Older releases could keep Git workspaces in named `pi-msb-vol-*` volumes. The
new workspace behavior does not reconnect, migrate, or delete those volumes.
They may contain the only copy of unexported work.

Before upgrading, while the old `/msb volumes` and `/msb export` commands are
still available, inventory every retained volume and export or copy any work
you need. After upgrading, use Microsandbox itself:

```sh
msb volume ls
mkdir -p ./legacy-workspace-recovery
msb run --name pi-msb-recovery \
  --mount-named pi-msb-vol-REPLACE_ME:/legacy:ro \
  --mount-dir "$PWD/legacy-workspace-recovery:/recovery:rw" \
  alpine -- sh -c 'cp -a /legacy/. /recovery/'
msb rm pi-msb-recovery
```

Verify the copied files, then remove the old volume with:

```sh
msb volume rm pi-msb-vol-REPLACE_ME
```

Copy the exact name from `msb volume ls`: a mistyped named mount can create a
new empty volume. Choose an already-cached recovery image if `alpine` is
unavailable. pi-microsandbox no longer lists, removes, or exports volumes.
