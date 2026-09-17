# pi-microsandbox

**Let your agents work. Stop babysitting every command.**

Give an agent a task and get on with your day. pi-microsandbox uses
[Microsandbox](https://microsandbox.dev/) to run
[Pi](https://github.com/earendil-works/pi)'s file and shell tools in lightweight
microVMs. Microsandbox is an open-source, local-first runtime for isolating
untrusted workloads, with a separate Linux kernel for each sandbox.

Each project can define its own environment and safety boundaries. Set them up
once, then let the agent get to work.

[Get started](#get-started) · [Documentation](#documentation) · [Releases](https://github.com/hcohe/pi-microsandbox/releases)

## Try it

Run Pi with pi-microsandbox for one session, without installing it:

```sh
pi -e npm:pi-microsandbox
```

## Less supervision. More work getting done.

- Let routine file and shell work happen inside the sandbox. Host execution
  stays an explicit escape, with approval required while the sandbox is active.
- Work at the same path inside and outside the VM. Sandboxed writes appear in
  the host checkout immediately, with no export step.
- If the sandbox cannot start, routed tools stop by default. They do not quietly
  run on your host instead.

You still review what the agent produces. The point is to spend your attention
on the results rather than supervise every step along the way.

## One workspace behavior

There are no workspace modes. If Pi starts inside a Git worktree,
pi-microsandbox mounts the whole worktree root read/write at the same lexical
path in the guest. If Pi starts outside Git, it mounts the current working
directory itself. Commands start in the original current working directory.

This is a VM boundary, not checkout isolation. The selected root is fully
visible, including `.git`, secrets such as `.env`, untracked files, and sibling
directories. Writes change the host immediately. Multiple sessions using the
same checkout share those files and can conflict; use separate host worktrees
or checkouts when you need independent changes. Containers started inside the
microVM can also reach the mounted workspace.

[Understand workspace storage and legacy-volume recovery →](docs/storage.md)

## Every project gets its own boundaries

Your frontend app and your internal service do not need the same sandbox.
Choose a [published variant or custom image](docs/images.md) with the tools a
project needs, allow only the network hosts it should reach, and configure its
extra file mounts and secrets. Another project can have a different setup,
including no network access.

Keep everyday defaults in global config and project-specific settings in
`.pi-msb.toml`. Trusted project config layers over those defaults; environment
variables and session overrides let you adjust a run without rewriting the
project setup.

The agent gets an environment built for the job. Image cohorts built from this
version include Docker Engine 29.8.0, Buildx 0.37.1, and Compose 5.5.1. The
daemon and its containers run inside the microVM; pi-microsandbox never connects
them to the host Docker socket. Nested containers can still access the mounted
workspace and remain subject to the outer network policy.

[Configure your project's sandbox →](docs/configuration.md)

## Get started

You'll need Pi, **Node.js 22.19.0+**, and one of the supported host targets:
Apple Silicon macOS (`darwin-arm64`), GNU Linux x86_64
(`linux-x64-gnu`), or GNU Linux arm64 (`linux-arm64-gnu`). Live sandboxes also
need host virtualization support. The POSIX lock addon is bundled and installs
without lifecycle scripts or a compiler.
[Full requirements and installation help →](docs/getting-started.md)

Install pi-microsandbox:

```sh
pi install npm:pi-microsandbox
```

That command also installs the pinned Microsandbox SDK, CLI, and matching
platform runtime. A separate Microsandbox installation is not required on a
supported host. Keep npm optional dependencies enabled so npm installs the
platform package.

If the platform package is unavailable, you can provide a standalone `msb`
binary with `MSB_PATH`. See the official
[Microsandbox documentation](https://docs.microsandbox.dev/) for standalone
installation and runtime troubleshooting. The documentation in this repository
covers the Pi integration.

Start Pi from the directory where you want to work:

```sh
cd /path/to/project
pi
```

Once you're in Pi, inspect the selected workspace root:

```text
/msb status
```

> **Host execution is separate.** `/msb off` explicitly hands tools to the
> host. `fallback_mode = "host"` opts into automatic host execution after a
> sandbox failure. Neither control changes the workspace mount, and neither is
> sandboxed. The default fallback blocks tools when startup fails.

Upgrading from a release that used named Git volumes requires a manual recovery
check. Before upgrading, use the old `/msb volumes` and `/msb export` commands
to inventory and copy retained work. After upgrading, use Microsandbox's own
tooling to recover or remove legacy volumes; they are never deleted
automatically. See [workspace storage](docs/storage.md).

## Documentation

| When you want to… | Read |
| --- | --- |
| Install or check host support | [Getting started](docs/getting-started.md) |
| Understand the workspace mount or recover legacy volumes | [Storage](docs/storage.md) |
| Choose an image variant or build a custom image | [Images](docs/images.md) |
| Set up networking, secrets, mounts, or other options | [Configuration](docs/configuration.md) |
| Look up an `/msb` command | [Command reference](docs/commands.md) |
| Understand the isolation boundary and host access | [Safety model](docs/safety.md) |
| Fix a sandbox that won't start | [Troubleshooting](docs/troubleshooting.md) |
| Run tests or work on the extension | [Development](docs/development.md) |

---

[MIT license](LICENSE) · [Report a bug](https://github.com/hcohe/pi-microsandbox/issues) · [Report a security issue privately](SECURITY.md)
