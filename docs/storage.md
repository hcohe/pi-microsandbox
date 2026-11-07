# Workspace storage

[Back to README](../README.md)

## One read/write workspace

There are no workspace modes. pi-microsandbox bind-mounts only the current
working directory: the host source is canonical `realpath(cwd)`, and both the
guest root and command cwd use the lexically resolved cwd path. The bind is
read/write. Writes are immediately visible in the host directory; there is no
export or synchronization step.

Git root discovery is not used. Starting Pi in a Git subdirectory exposes that
directory, not its Git ancestors or siblings outside cwd. Files within cwd,
including `.git`, untracked files, and secrets such as `.env`, remain exposed.
Sessions with overlapping cwd binds can read or overwrite the same host files.
Use separate host worktrees or checkouts when tasks need independent files.

Canonical cwd also determines the Project configuration identity and shared
session boundary. A nested cwd has its own identity and may need new explicit
Project overrides; parent overrides are not inherited. Symlink aliases of the
same canonical cwd share that identity. Global settings are unchanged. See
[project overrides](configuration.md#host-owned-project-overrides).

Local-file security is up to you: pi-microsandbox does not hide `.env` files or
other sensitive information in that read/write mount. We recommend
[Worktrunk](https://worktrunk.dev/) for managing worktrees and setup hooks, such as
preparing a dedicated `.env` per project or worktree. Include only credentials
the agent may access; neither worktree separation nor Git ignore rules protect
secrets placed inside the mounted tree. See the [safety model](safety.md#local-files-and-secrets-are-your-responsibility).

Git metadata inside cwd remains exposed, but never selects the bind root.
Linked-worktree or submodule metadata outside cwd is not mounted separately;
Git commands in the guest may require explicit setup or mounts. Extra mounts
and user-approved host controls are separate from the cwd bind and can widen
access. An unsupported path or symlink layout fails startup instead of silently
selecting a different root or host execution.

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
