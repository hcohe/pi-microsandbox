# pi-microsandbox

**Give Pi a Linux VM, not your host shell.**

`pi-microsandbox` runs the [Pi coding agent](https://github.com/earendil-works/pi)'s
file and shell tools inside a [Microsandbox](https://microsandbox.dev/) Linux
microVM. Your agent can build and test in Linux without a separate copy of your
project: edits show up in your working directory as they happen.

- **Linux, ready to work.** The default image ships with Node.js, Python, Rust,
  Go, and Docker. Docker runs inside the VM, not through your host socket.
- **Your files stay put.** The VM mounts the directory you start Pi in. No sync
  step, and no automatic mounts for Git parents or sibling directories.
- **You approve changes.** Let Pi propose network rules, mounts, or resources,
  then review the settings diff before anything is saved.
- **No silent host fallback.** If the VM can't start, routed tools stay blocked
  by default instead of running on your host.

```text
Pi's sandboxed Bash: uname -s && echo hello > sandbox-demo.txt
Linux

Your host shell: cat sandbox-demo.txt
hello
```

[Get started](#get-started) · [Try an agent recipe](#let-your-agent-propose-the-settings) · [Know the boundary](#a-sandbox-not-a-spare-checkout) · [Documentation](#documentation)

---

## Get started

You'll need **Pi**, **Node.js 22.19.0+**, and either **Apple Silicon macOS** or
**GNU Linux (x86_64 or arm64) with accessible KVM**. The runtime is bundled;
keep npm optional dependencies enabled. [Full requirements →](docs/getting-started.md)

Try it in an empty directory. The first start may need to download the image.

```sh
demo=$(mktemp -d)
cd "$demo"
pi -e npm:pi-microsandbox
```

In Pi, open **`/msb` → Status** and check that the sandbox is active before
running commands. Close the panel with `q`, then enter this in Pi (not your host
shell):

```text
!uname -s && echo hello > sandbox-demo.txt
```

You should see `Linux`. Quit Pi and run `cat sandbox-demo.txt` in the same
terminal. You'll see `hello`: the command ran in the guest, and the file showed
up on your host. On a Linux host, `uname` alone doesn't tell you which shell ran.
If `/msb` is missing or the sandbox is blocked, see [Troubleshooting](docs/troubleshooting.md).

When you're ready to use it in a project, run `pi -e npm:pi-microsandbox` from
that directory. To keep the extension enabled for future sessions, run
`pi install npm:pi-microsandbox`, then start `pi` as usual.

## Let your agent propose the settings

Ask Pi to inspect the sandbox with `msb_config_get`, or open **`/msb`** to check
it yourself. Then try a change:

> For this session, propose denying network access. Keep host fallback blocked
> and don't add any host-tool bypasses. After I approve, tell me whether the
> policy took effect and when it expires.

`msb_config_set` shows what would change and where, with **No selected by default**.
Choose **Session** for this session only, **Project** for settings shared across
supported Git worktrees, or **Global** for defaults across projects. Session
overrides reset on Pi `/reload`, a session/workspace switch, or shutdown.
Persistent settings live outside the mounted project. A save is not proof the
VM adopted the change.
[More recipes →](docs/agent-recipes.md) · [Settings and precedence →](docs/configuration.md)

Need a different stack? [Choose a Linux image](docs/images.md) or
[build from a host-owned Dockerfile](docs/images.md#host-owned-dockerfile-no-host-docker),
without installing Docker on your host.

## A sandbox, not a spare checkout

**Your working directory is mounted read/write.** That includes `.env`, `.git`,
and ignored or untracked files inside it. Edits reach the host immediately and
aren't rolled back when the VM restarts. Use a separate checkout to keep edits
apart, and keep sensitive files out of the directory you mount.

**The VM boundary applies to routed tools, not everything Pi can do.** Extra
mounts, host execution, and pass-through tools can widen access. Guest network
rules don't apply to host/pass-through tools. Leave the default fallback set to
`block` if you don't want a failed VM to hand routed tools back to the host.
[Know what the agent can access →](docs/safety.md)

## Documentation

| I want to… | Start here |
| --- | --- |
| Install, check requirements, or recover from a startup failure | [Getting started](docs/getting-started.md) · [Troubleshooting](docs/troubleshooting.md) |
| Lock down network access, share a read-only mount, or scope a secret | [Agent recipes](docs/agent-recipes.md) · [Google Cloud read-only access](docs/google-cloud.md) |
| Configure Pi or review what it can access | [Control panel](docs/commands.md) · [Configuration](docs/configuration.md) · [Safety](docs/safety.md) · [Storage](docs/storage.md) |
| Choose or build a Linux image | [Images](docs/images.md) |
| Look up tool arguments and approval behavior | [Tool reference](docs/tools.md) |
| Work on the extension | [Development](docs/development.md) · [Settings internals](docs/settings-backend.md) |

<details>
<summary>Terminal agent status (OSC 7501)</summary>

Pi reports working, blocked, done, error, and idle through native **OSC 7501**
program status on supported terminals. Host execution and Dockerfile review/load
prompts report blocked permission status while awaiting approval, with fixed
messages that contain no commands or paths. Pi owns status restoration when the
prompt closes; no separate extension status emitter is needed.

Reporting normally waits for the terminal to confirm support. Launch with
`PI_PROGRAM_STATUS=1 pi` to force reporting, or `PI_PROGRAM_STATUS=0 pi` to disable
it. Use a recent Pi with custom-UI blocked-status support (tested with 1.5.2);
tmux and screen do not forward these reports.

</details>

---

[MIT license](LICENSE) · [Releases](https://github.com/hcohe/pi-microsandbox/releases) · [Report a bug](https://github.com/hcohe/pi-microsandbox/issues) · [Report a security issue privately](SECURITY.md)
