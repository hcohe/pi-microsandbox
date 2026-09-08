# pi-microsandbox

**Let your agents work. Stop babysitting every command.**

Give an agent a task and get on with your day. Give a few agents different tasks
and let them work in parallel. Come back to review the results.

pi-microsandbox uses [Microsandbox](https://microsandbox.dev/) to run
[Pi](https://github.com/badlogic/pi-mono)'s file and shell tools in lightweight
microVMs. Microsandbox is an open-source, local-first runtime for isolating
untrusted workloads, with a separate Linux kernel for each sandbox.

In Git mode, each separate Pi session gets its own workspace instead of editing
your host checkout. Each project can define its own environment and safety
boundaries. Set them up once, then let the agents get to work.

[Get started](#get-started) · [Documentation](#documentation) · [Releases](https://github.com/hcohe/pi-microsandbox/releases)

## Less supervision. More work getting done.

- Run multiple agents in separate Pi sessions. Git mode keeps their workspaces apart, so ordinary sandboxed edits don't collide in your host checkout.
- Let routine file and shell work happen inside the sandbox. Host execution stays an explicit escape, with approval required while the sandbox is active.
- Step away without throwing away the work. Git-mode files survive sandbox shutdown, ready when you resume the matching session.
- If the sandbox can't start, routed tools stop by default. They don't quietly run on your host instead.

You still review what the agents produce. The point is to spend your attention
on the results, rather than supervise every step along the way.

## Every project gets its own boundaries

Your frontend app and your internal service don't need the same sandbox.
Choose a custom image with the tools a project needs, allow only the network
hosts it should reach, and configure its file mounts and secrets. Another
project can have a completely different setup, including no network access.

Keep your everyday defaults in global config and project-specific settings in
`.pi-msb.toml`. Trusted project config layers over those defaults; environment
variables and session overrides let you adjust a particular run without
rewriting the project's setup.

The agent gets an environment built for the job. You don't have to make the
same decisions every time you start it.

[Configure your project's sandbox →](docs/configuration.md)

## Get started

You'll need Pi, **Node.js 22.19.0+**, and either an Apple Silicon Mac or Linux
with accessible KVM. Installation also needs Python and a C/C++ build toolchain;
keep lifecycle scripts and optional dependencies enabled.
[Full requirements and installation help →](docs/getting-started.md)

Install the Microsandbox CLI first:

```sh
curl -fsSL https://install.microsandbox.dev | sh
```

For alternate installation methods and any Microsandbox-specific setup,
runtime, or troubleshooting details, use the official
[Microsandbox documentation](https://docs.microsandbox.dev/). The documentation
in this repository covers the Pi integration.

Then install pi-microsandbox:

```sh
pi install npm:pi-microsandbox
```

From a Git repository, start Pi with its own isolated workspace:

```sh
PI_MSB_MODE=git pi
```

Git mode starts from committed `HEAD`. Commit any changes you want the agent to
see first; untracked files such as `.env` and uncommitted edits stay out of the
initial copy. An existing retained workspace is reused for a matching session.

Once you're in Pi:

```text
/msb status
```

Give Pi a task. To work on another task in parallel, start a separate Pi session
with the same command in another terminal. Each session gets its own Git-mode
workspace.

When you're ready to review an agent's work, export a file to a new destination:

```text
/msb export src/example.ts --to ../sandbox-review
```

Exports ask for confirmation and won't overwrite existing destinations.
See [storage and retained work](docs/storage.md) for the details.

> **Choose your boundary.** The default storage mode is `direct`, which writes
> to your host directory. The command above explicitly selects `git` isolation.
> `/msb off` turns sandboxing off; `fallback_mode = "host"` opts into automatic
> host execution after a failure. Neither is sandboxed.

## Documentation

| When you want to… | Read |
| --- | --- |
| Install or check host support | [Getting started](docs/getting-started.md) |
| Choose a workspace mode or recover retained work | [Storage](docs/storage.md) |
| Set up images, networking, secrets, or mounts | [Configuration](docs/configuration.md) |
| Look up an `/msb` command | [Command reference](docs/commands.md) |
| Understand the isolation boundary and host access | [Safety model](docs/safety.md) |
| Fix a sandbox that won't start | [Troubleshooting](docs/troubleshooting.md) |
| Run tests or work on the extension | [Development](docs/development.md) |

---

[MIT license](LICENSE) · [Report a bug](https://github.com/hcohe/pi-microsandbox/issues) · [Report a security issue privately](SECURITY.md)
