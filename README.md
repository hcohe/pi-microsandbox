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

Inside Pi, **`/msb`** opens full-screen with collapsed **Resources**, **Network**,
**Secrets**, **Variables**, **Mounts**, **Tools**, **Image**, **Sources**, **Actions**,
**Status**, **General** and **Advanced** trees directly below **MICROSANDBOX**,
initially focused on Resources.
**Status** contains read-only **[runtime]** metadata, not duplicate settings.
Expand with `l`/right, fold or go to parent with `h`/left, move with `j`/`k` or up/down. Enter/`e` edits, `a` adds, `d` deletes/inherits,
and `q` closes. One contextual hint line stays pinned at the bottom, with accented
keys and muted actions; narrow screens use grouped keys. Menus offer short hints;
value editors explain the format with examples. [All keys →](docs/commands.md)

When the sandbox is blocked, the agent can use **`msb_diagnostics`** for passive,
secret-redacted diagnostics without starting a VM or executing host commands.
Configuration tools remain available for explicitly approved repairs.

The agent can also inspect all settings with `msb_config_get` or propose a
scoped change or atomic same-scope batch with `msb_config_set`. The getter includes
value schemas, constraints and desired/adopted network policy summaries, so the
model need not read extension source to configure it. Filter by section/setting
and get readable text or indented JSON; structured results remain available. Every request needs your explicit approval;
a HOST-style No/Yes question shows `Scope: Session`, `Scope: Project`, or
`Scope: Global` and the focused color-coded diff, with literal secret data masked. Host source names and commands are readable;
proposed host commands are shown for authorization.
Relevant safety/impact warnings are returned as text to the agent after the change
tool completes so it can advise you, not shown in the confirmation dialog.
Headless inspection is read-only.
[Configuration tools →](docs/tools.md)

The Pi footer shows **`msb-ID ●`**: a green circle when live, or a yellow/grey
pulse while booting. Sandbox failures, host fallback, and unavailable Docker show
red. Colors follow your theme; only the booting circle flashes.

## Your project, your sandbox

Setup and reload do not create configuration files.
Saving a **Global** setting creates `~/.pi/agent/pi-microsandbox/default.toml`
with the settings you save, not a commented template. Existing files are left
alone until you explicitly save changes.

Each edit offers **Session**, **Project**, **Global**, or **Cancel**. Apply reloads
this sandbox automatically; others pick up persisted defaults on next start/reload.
Restarting settings ask before losing guest ephemeral state. Session changes
are memory-only and reset on **Pi `/reload`**, session/workspace switch or shutdown.
Inherited defaults then return and may allow broader access. Ordinary settings
reload preserves Session overrides; choose Project/Global explicitly to persist restrictions. The panel
requires a running sandbox for Session. Project settings for `~/Code/app`
live outside the worktree:

```text
~/.pi/agent/pi-microsandbox/projects/Code/app/config.toml
```

`PI_MSB_*` environment variables work too. Settings take precedence in this order:
built-ins < environment < Global < Project < Session.
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

Sandbox failures stop routed tools by default. `/msb` → Actions → **Turn off**
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
| Inspect/propose settings through the model | [Configuration tools](docs/tools.md) |
| Use the `/msb` control panel | [Commands](docs/commands.md) |
| Understand host access | [Safety model](docs/safety.md) |
| Unstick a sandbox | [Troubleshooting](docs/troubleshooting.md) |
| Hack on the extension | [Development](docs/development.md) |

---

[MIT license](LICENSE) · [Report a bug](https://github.com/hcohe/pi-microsandbox/issues) · [Report a security issue privately](SECURITY.md)
