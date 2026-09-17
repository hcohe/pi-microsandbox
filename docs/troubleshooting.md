# Recovery and troubleshooting

[Back to README](../README.md)

1. Run `/msb status` and `/msb logs`.
2. If the state is `unavailable (blocked)`, fix the displayed configuration,
   image, virtualization, path, or missing-tool error and run `/msb reload`.
   Startup failures fail closed; routed tools do not silently run on the host.
3. If a process died, a later startup or `/msb prune` can remove its labelled
   sandbox after the owner lock is free.
4. If a same-name resource has different managed labels, pi-microsandbox
   refuses to attach or replace it. Verify the resource with Microsandbox's
   tooling before removing it.
5. On unsupported virtualization hosts, use `PI_MSB_DISABLE=1` or `/msb off`
   for explicit host mode, or configure `fallback_mode = "host"` knowingly.
   Automatic fallback remains visibly distinct from explicit off mode; both are
   unsandboxed.
6. For bootstrap failures, use an image that already contains the required
   command list or allow the configured network policy to reach the package
   repositories. Deny mode cannot bootstrap an image missing those commands.

There are no workspace modes. A cwd inside Git mounts the entire worktree root
read/write at the same guest path; any other cwd mounts itself. If startup fails
because the selected root or symlink layout cannot be represented safely, fix
the host path rather than expecting a narrower mount. Remember that writes are
immediate, `.git`, secrets, untracked files, and sibling directories are
visible, concurrent sessions share a checkout, and nested containers can reach
the mount.

## Legacy named volumes

Named Git volumes created by older releases are never migrated or deleted
automatically. Before upgrading, use the old `/msb volumes` and `/msb export`
commands to inventory and copy work while those commands are available. After
upgrading, use Microsandbox's volume tooling to inspect and recover each
`pi-msb-vol-*` volume, then remove it manually only after confirming that
nothing is needed. Current pi-microsandbox commands do not manage these volumes.

## Docker daemon problems

`/msb status` shows the configured Docker mode, readiness, server version, and
storage driver. Inside an active sandbox, start or recheck the daemon with:

```sh
pi-msb-docker-start 15000
docker info
```

Startup logs are guest-local at `/var/log/pi-msb-dockerd.log`. Check the network
prerequisites with `iptables --version` (it should report `nf_tables`), `nft
--version`, and `sysctl net.ipv4.ip_forward` (it should be `1`). The daemon uses
`vfs`; slower builds and higher disk use are expected compared with `overlay2`.
Increase `memory_mib` or `docker.startup_timeout_ms` if startup is killed or
large builds run out of memory. Small builds should have at least 1 GiB and
larger Compose stacks should have 2 GiB or more; the default is 8 GiB.

A published container port needs two mappings. Configure the outer
`network.publish_ports` mapping before sandbox creation, then use Docker `-p`
inside the guest. A Docker mapping by itself is not reachable from the host.
Pull and container-egress failures under `deny` or `allowlist` are expected; do
not bypass the outer policy or mount the host Docker socket as a workaround.

For installation prerequisites, see
[installation and requirements](getting-started.md). To test a live sandbox
from source, see the [live test matrix](development.md#live-test-matrix).
