# pi-microsandbox

**A little Linux VM for your agent's big ideas.**

Run [Pi](https://github.com/earendil-works/pi)'s file and shell tools inside
[Microsandbox](https://microsandbox.dev/) microVMs. Give each project the tools,
network access, mounts, and secrets it needs—then let the agent cook.

- **Real Linux, local files.** Work at the same path inside and outside the VM;
  edits land straight in your checkout.
- **Bring your stack.** Choose a [ready-made image](docs/images.md) or build your
  own. Docker runs inside the VM, not through your host's Docker socket.
- **No sneaky host fallback.** Sandbox failures block routed tools by default.

[Get started](#get-started) · [Documentation](#documentation) · [Releases](https://github.com/hcohe/pi-microsandbox/releases)

## Get started

You'll need **Pi**, **Node.js 22.19.0+**, and host virtualization support on
Apple Silicon macOS or GNU Linux x86_64/arm64. The matching Microsandbox runtime
and native lock addon are bundled; no separate installation or compiler needed.
Keep npm optional dependencies enabled.
[Full prerequisites →](docs/getting-started.md)

Try it for one session:

```sh
pi -e npm:pi-microsandbox
```

Or install it and start Pi in your project:

```sh
pi install npm:pi-microsandbox
cd /path/to/project
pi
```

Inside Pi, **`/msb`** opens one full-screen tree: **Configuration** for desired
settings and **Runtime** for the read-only actually adopted policy. Expand with
`l`/right, fold or go to parent with `h`/left, move with `j`/`k` or up/down.
`e` edits, `a` adds, `d` deletes/inherits, and `q` closes. [All keys →](docs/commands.md)

## Your project, your sandbox

The first enabled session creates
`~/.pi/agent/pi-microsandbox/default.toml`: a fully commented template of defaults,
examples, and safety guidance. Uncomment what you need; existing files are left
alone.

Use **`w` (ephemeral)**, **`P` (project)**, or **`G` (global)** to save and reload
only your intended edits. Restarting settings ask before losing guest ephemeral
state; ephemeral changes reset on session switch/end. Project
settings for `~/Code/app` live outside the worktree:

```text
~/.pi/agent/pi-microsandbox/projects/Code/app/config.toml
```

`PI_MSB_*` environment variables work too. Settings take precedence in this order:
built-ins < environment < host defaults < project overrides < ephemeral changes.
Lists in host-owned files replace lower-layer lists.

Keep configuration and credentials outside the workspace and all writable mounts.
[Configuration](docs/configuration.md) covers project paths, Pi's custom agent
directory, networking, secrets, and read-only mounts.

## A sandbox, not a spare checkout

The **whole Git worktree** is mounted read/write; outside Git, the cwd is mounted.
That includes `.git`, `.env`, untracked files, and sibling directories within the
worktree—even when Pi starts in a subdirectory. Writes reach the host immediately.
Sessions sharing a checkout share its files, and nested containers can reach the
mount too. Use separate host worktrees when you need independent changes.

**Local secrets are your responsibility.** The extension does not hide or protect
`.env` files or other sensitive information in the mounted directory. We recommend
[Worktrunk](https://worktrunk.dev/) for managing separate worktrees and setup hooks,
including preparing a dedicated `.env` per project or worktree. Only put credentials
the agent is allowed to access there; worktree management is not secret isolation.

Sandbox failures stop routed tools by default. `/msb` → Configuration → Actions → **Turn off**
explicitly switches to unsandboxed host tools after confirmation; `fallback_mode = "host"` opts into automatic host execution
after failure. Keep the default `"block"` for untrusted work.
[Know the boundary →](docs/safety.md)

## Documentation

| Need a hand? | Read |
| --- | --- |
| Install or check host support | [Getting started](docs/getting-started.md) |
| Understand the workspace mount | [Storage](docs/storage.md) |
| Pick or build an image | [Images](docs/images.md) |
| Tune networking, secrets, and mounts | [Configuration](docs/configuration.md) |
| Use the `/msb` control panel | [Commands](docs/commands.md) |
| Understand host access | [Safety model](docs/safety.md) |
| Unstick a sandbox | [Troubleshooting](docs/troubleshooting.md) |
| Hack on the extension | [Development](docs/development.md) |

---

[MIT license](LICENSE) · [Report a bug](https://github.com/hcohe/pi-microsandbox/issues) · [Report a security issue privately](SECURITY.md)
