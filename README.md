# pi-microsandbox

**A little Linux VM for your agent's big ideas.**

Run [Pi](https://github.com/earendil-works/pi)'s file and shell tools inside a
[Microsandbox](https://microsandbox.dev/) microVM. Your agent gets a Linux
playground. You get to choose its tools, network access, mounts, and secrets.

- **Real Linux. Your actual files.** Edits land directly in your working directory.
- **Bring your stack.** The default image includes Node.js, Python, Rust, Go,
  and Docker. Use this complete [image](docs/images.md), or place a
  [host-owned Dockerfile](docs/images.md#host-owned-dockerfile-no-host-docker)
  to build inside a disposable VM—no host Docker needed.
- **Ask, review, approve.** Let the agent propose sandbox settings instead of
  playing configuration-file hide-and-seek.
- **No sneaky host fallback.** If sandbox startup fails, routed tools stay
  blocked by default. Failure is not permission to run on your host.

[Get started](#get-started) · [Agent recipes](docs/agent-recipes.md) · [Documentation](#documentation)

## Get started

You'll need **Pi**, **Node.js 22.19.0+**, and either **Apple Silicon macOS** or
**GNU Linux x86_64/arm64 with accessible KVM**. The matching Microsandbox runtime
and native lock addon are bundled—keep npm optional dependencies enabled.
[Full requirements →](docs/getting-started.md)

Try it for one session:

```sh
cd /path/to/project
pi -e npm:pi-microsandbox
```

Like it? Install it for future sessions:

```sh
pi install npm:pi-microsandbox
pi
```

Then ask your agent:

> Inspect my sandbox with msb_config_get. Explain what's mounted, which network
> policy is desired versus actually adopted, and whether anything can run on the
> host. Don't change anything yet.

Prefer knobs and buttons? **`/msb`** opens the control panel. Use arrows or
`hjkl` to explore, Enter to edit, and `q` to close.
[Panel guide →](docs/commands.md)

## Let your agent tune its own playground

No need to teach it our TOML dialect. `msb_config_get` exposes settings, schemas,
origins, and safety context. `msb_config_set` proposes a scoped edit or a batch
of related edits. **You approve every request** in a No-first dialog showing the
scope and diff. Project is shared by the main/root Git checkout, linked worktrees
and nested Git cwd. Without an interactive approval UI, changes are rejected.

Try a few prompts:

> Give this project 2 CPUs and 4096 MiB of RAM. Use Project scope, propose both
> changes together, and tell me whether the VM restarted successfully.

> For this Session, deny network access. Keep host fallback blocked and don't
> add any host-tool bypasses. Explain when this restriction expires.

> Add an NPM_TOKEN secret sourced from my host variable PROJECT_NPM_TOKEN,
> scoped to registry.npmjs.org. Use Project scope. Check network policy separately;
> don't read or print the token.

The agent proposes; you decide. Review the diff, then ask it to explain the
returned impact warnings and confirm whether the change was **saved and activated**.
Resource, image, network, mount, and secret changes may recreate the VM and lose
its disposable state. Host-file edits are already real and are not rolled back.

[More recipes: offline work, read-only mounts, local servers, recovery →](docs/agent-recipes.md)

Already a Google Cloud admin on your host? [Give the agent a separate read-only
identity](docs/google-cloud.md)—keyless impersonation, no copied admin profile,
and a write-denied test to check the boundary.

## Pick how long a setting sticks

| Scope | What it means |
| --- | --- |
| **Session** | Memory-only. Resets on Pi `/reload`, session/workspace switch, or shutdown; not restored from the transcript. |
| **Project** | The main/root Git project, shared from linked worktrees and nested cwd; otherwise canonical cwd. Always host-owned. |
| **Global** | Saved as your baseline for all projects. |

Precedence is **built-ins < environment < Global < Project < Session**.
Ordinary **settings reload** preserves Session overrides; Pi's extension
**`/reload` does not**. When a Session restriction disappears, inherited settings
may allow broader access. Use Project or Global for restrictions you want to keep.

Setup and inspection create no config files. Saving Global settings creates
`~/.pi/agent/pi-microsandbox/default.toml`. Non-Git cwd-local policy for `~/Code/app` goes in
`~/.pi/agent/pi-microsandbox/projects/Code/app/config.toml`. Supported Git
main, linked and nested cwd use `projects/<home-relative-canonical-main-checkout>/config.toml`;
roots outside home use `projects-absolute/<absolute-path-without-root>/config.toml`.
Dockerfile and build-context are siblings. New registered worktrees automatically share
this readable main-root record, without hashes or an in-repository policy file.
Non-Git and unsupported Git layouts stay cwd-local. No migration or old hashed-path
lookup occurs. [Configuration →](docs/configuration.md)


## A sandbox, not a spare checkout

**Your cwd is mounted read/write.** The host source is canonical `realpath(cwd)`;
its lexically resolved path is the guest root and command cwd. Git metadata is
used only for policy association, never to mount ancestors or siblings outside cwd.

That means `.env`, `.git`, ignored files, and untracked files **inside cwd are
accessible**, and writes reach the host immediately. Overlapping sessions share
those files. Use separate worktrees or checkouts for independent changes—not as
secret filtering. External worktree/submodule Git metadata is not separately
mounted, so guest Git may need explicit setup. A main checkout's writable `.git`
contains authoritative cross-worktree registration: sharing policy trusts that
metadata and any overlapping sessions able to modify it.

Docker runs **inside the VM**, never through your host Docker socket. Containers
can still access the workspace and extra mounts. Explicit mounts and approved
host controls can widen the boundary.

Turning the sandbox off explicitly hands tools to the host. So does automatic
`fallback_mode = "host"` after failure. Keep the default `"block"` for untrusted
work. [Know the boundary →](docs/safety.md)

## Documentation

| I want to… | Start here |
| --- | --- |
| Install and run my first sandbox | [Getting started](docs/getting-started.md) |
| Ask my agent to configure it | [Agent recipes](docs/agent-recipes.md) |
| Understand scopes, files, and settings | [Configuration](docs/configuration.md) |
| Use `/msb` myself | [Control panel](docs/commands.md) |
| Look up tool arguments and approval behavior | [Tool reference](docs/tools.md) |
| Understand what the agent can access | [Safety](docs/safety.md) · [Storage](docs/storage.md) |
| Choose or build a Linux image | [Images](docs/images.md) |
| Unstick a sandbox | [Troubleshooting](docs/troubleshooting.md) |
| Work on the extension | [Development](docs/development.md) · [Settings internals](docs/settings-backend.md) |

---

[MIT license](LICENSE) · [Releases](https://github.com/hcohe/pi-microsandbox/releases) · [Report a bug](https://github.com/hcohe/pi-microsandbox/issues) · [Report a security issue privately](SECURITY.md)
