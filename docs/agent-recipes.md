# Ask your agent. Keep the keys.

[Back to README](../README.md) · [Configuration](configuration.md) · [Tool reference](tools.md)

Your agent can configure its sandbox without editing policy files through a
shell. Describe what you want, let it inspect the available settings, then
approve—or decline—the proposal. Tiny robot interior designer, human landlord.

## The three-step dance

1. **Inspect.** `msb_config_get` reads settings, their origins, supported value
   schemas, and desired versus last-known adopted policy. It does not start a VM
   or resolve credentials.
2. **Propose.** `msb_config_set` prepares one change or an atomic batch in one
   explicit scope: **Session**, **Project**, or **Global**.
3. **Review and verify.** You get a No-first approval dialog with the scope and
   focused diff. Afterwards, the agent should explain the returned warnings and
   distinguish **saved** from **successfully activated**.

Every setter call needs fresh approval—even a no-op. Chat instructions are not
an approval bypass. Headless inspection works; headless mutation does not. An
interactive RPC client must support Pi's approval selector.

The tool's confirmation shows the diff, not all impact warnings; those are
returned to the agent after completion. Ask it to explain expected impact
**before** proposing a change too. VM recreation loses guest-local state and
containers, but never undoes writes already made to your host files.

## First, a guided tour

> Use msb_config_get to give me a plain-English sandbox tour. Cover resources,
> mounted paths, network policy, credential destinations, and any host execution
> or pass-through tools. Separate desired settings from known adopted state.
> Don't change anything or print credentials.

This is a good first prompt after installation—or after inheriting somebody
else's setup. Unknown runtime policy should stay **unknown**, not become
“probably safe.” Inspection is not a connectivity or live-enforcement test.

## Add a package to my image

> Make cowsay available for this project. Call msb_dockerfile_get with scope
> project first. Make the smallest Dockerfile edit needed, using minimal
> instructions; do not add comments or explanatory boilerplate. Preserve unrelated
> existing content and functional parser directives. For a new file start FROM
> the bundled digest pin and add only the requested package instructions, without
> unrelated packages. Explain the change and recommended Project or Global scope in
> your normal response, not the file. Propose the complete resulting content via
> msb_dockerfile_set; let me review the scope and added/removed code, with
> No / Yes below it in one approval. Don't use host
> commands, grant blanket host access or embed secrets.
> Explain any image/higher-scope blocker and propose image inheritance separately
> with msb_config_set approval. After saving, distinguish whether the new image is
> active, shadowed, deferred or failed to activate.

Git Project setter uses one default-No review: **Scope: Project**, then **No / Yes**.
Main, linked and nested Git cwd use the same config/Dockerfile/context record.
The TUI stays inline with changed code above colored choices, Ctrl+N/P scrolling,
a blank line after Scope and no dialog footer or expandable view. Enter on Yes
approves that shared target without another question. RPC/select-only adapters
show the same shared diff. Global/non-Git also uses No / Yes. Escape/abort saves
nothing. There is no Repository/Worktree destination option. Legacy cwd-keyed Git
sources are ignored and preserved, never copied or promoted; manually review
migration into shared Project with fresh approval. First shared saves register
immutable config metadata, never image intent. Non-Git/unsupported layouts remain
cwd-local; Global and per-current-cwd execution/session safety are unchanged.

> Read context inventory with msb_dockerfile_get, requesting contextPaths only for
> the UTF-8 files I want to inspect. Propose a context-only PATCH with scope project
> and context [{path:"scripts/setup.sh",content:"#!/bin/sh\necho ready\n",executable:true}].
> Preserve every unspecified file; content:null deletes just one reviewed file.
> Show full content/mode changes and build/public-egress/restart consequences.

Getter is passive Off/blocked when canonical cwd is known. Changed proposals need
interactive approval; each file is atomic but the bundle is not jointly/crash
atomic. Partial/unknown persistence never activates. Context-only saves rebuild
and replace the running VM when selected. See [host-owned Dockerfiles](images.md#host-owned-dockerfile-no-host-docker)
for isolated COPY contexts, cache/rebuild behavior and the build network boundary.

## Less RAM, same ambition

> Set this Project to 2 CPUs and 4096 MiB RAM. Inspect the schema first, explain
> the restart impact, then propose both edits in one msb_config_set batch. Don't
> change other settings. After approval, report whether both save and reload worked.

Project shares the main/root record from Git main, linked and nested cwd, with
**No** selected first. All registered worktrees, including future ones, can adopt
it on reload/start. Non-Git/unsupported layouts remember canonical cwd. Session
is the only temporary current-cwd scope; there is no persistent Worktree choice. For example:

```json
{"scope":"project","operations":[
  {"path":"cpus","operation":"set","value":2},
  {"path":"memory_mib","operation":"set","value":4096}
]}
```

One batch means one review, one atomic settings commit, and at most one reload.
A reload failure can still leave the whole batch saved; it is not a rollback.

## Pull up the network drawbridge

> For this Session, set network.mode to deny. Keep fallback_mode at block,
> allow_host_execution false, block_third_party true, and pass_through_tools
> empty. Inspect existing policy and explain what will restart before proposing
> one batch. Tell me when these restrictions reset. Don't disable the sandbox.

`deny` disables VM networking, including nested-container egress. Tools running
on the host are outside that policy; this is why the prompt also checks bypasses.
The image must already contain required commands: an offline VM cannot download
missing bootstrap packages. The host may still need to pull an uncached image
before the guest can start.

**Session is not forever.** Pi `/reload`, session/workspace switch, and shutdown
clear its overrides; resuming a transcript does not restore them. Ordinary
Actions → Reload settings preserves them. To keep a restriction, explicitly ask
for **Project** or **Global** scope instead.

## Let npm in, not the whole internet

> Configure this Project for npm registry access using network.mode = allowlist
> and the exact domain registry.npmjs.org. Keep host fallback blocked. Inspect
> existing hosts first and explain whether replacing or preserving them fits this
> request. Propose the network changes together. Don't switch to open if a
> dependency fetch fails; report the additional destination it needs.

Network hosts use exact ASCII DNS names or IP/CIDR rules, **not** URLs or
wildcards. `github.com` does not implicitly include `api.github.com` or
`codeload.github.com`. Packages that download binaries from other services need
those destinations reviewed separately.

Important fine print: domain rules use DNS/IP matching, not per-request URL or
TLS-hostname authorization, and are not HTTPS-only. `allow_dns = true` is a
separate runtime-host port 53 exception, not a DNS-exfiltration defense.
[Network details →](configuration.md#networking)

## Give it a token without pasting the token

First, make `PROJECT_NPM_TOKEN` available to the **host Pi process** using your
usual trusted host-side credential workflow. Don't paste its value into chat.
Then ask:

> Add or update NPM_TOKEN in Project scope, sourcing it from the host environment
> variable PROJECT_NPM_TOKEN and limiting secret destinations to
> registry.npmjs.org. Use an entry upsert so unrelated secrets stay intact.
> Check network access separately. Never read, echo, or ask me to paste the token.

The agent can propose this without learning the credential:

```json
{"scope":"project","path":"secrets","operation":"upsert","value":{
  "env":"NPM_TOKEN",
  "hostEnv":"PROJECT_NPM_TOKEN",
  "allowHosts":["registry.npmjs.org"]
}}
```

Secret destinations control credential substitution; **they do not grant network
access**. A deny policy still denies traffic. Sources resolve when the VM is
created/recreated, not during inspection or saving, and running VMs do not
automatically refresh tokens.

The agent can configure a trusted `hostCmd` credential helper too, but its
command text is visible and it executes with **Pi's host privileges** during VM
creation. Never embed a credential in that command. Literal `textValue` secrets
must be entered through the human panel or a host-owned file, not agent tools.

## Google Cloud: keep admin at home

> Help me create a dedicated read-only Google Cloud service account from my
> trusted host login, with approval for every IAM change. Then configure a
> Project-scoped hostCmd to mint its impersonated token for sandbox gcloud.
> Don't copy my admin credentials or create keys. Show a successful read, then
> ask before a harmless write test that should fail with an IAM permission denial.

The [full Google Cloud walkthrough](google-cloud.md) covers the host commands,
secret configuration, required image, token expiry, and an approved disposable-VM
probe. You keep admin access; your agent gets a short-lived Compute Viewer badge.

## Borrow a directory, read-only please

> I want this Project to read /Users/me/Datasets/sample at /mnt/sample. Inspect
> the mount schema and existing mounts, then propose a read-only directory mount
> using an entry upsert. Don't replace other mounts or expose my home directory.
> Explain the restart and check that the source path is allowed.

Replace the host path with your own **absolute** path. Extra mounts default to
read-only, but being explicit makes reviews easier. A writable mount makes host
writes real; it is not disposable scratch space. Policy directories, sockets,
the cwd bind, and protected guest paths cannot be used as mount workarounds.

## Visit a dev server from your host

> Inspect published-port syntax. For this Project, add a loopback-only outer
> mapping 127.0.0.1:8080:8080 without replacing other mappings. Explain the VM
> restart first. Once active, help me run my app listening on 0.0.0.0:8080 inside
> the guest. Don't expose it on all host interfaces.

For an app inside Docker, you also need the inner Docker mapping, for example
`docker run -p 0.0.0.0:8080:8080 …`. The outer `network.publish_ports` mapping
must exist when the VM is created. Docker `-p` alone does not publish a port to
your physical host. Check that the chosen network mode supports your setup.

## Make a preference stick—or give it back

> Set show_footer to false in Global scope. Check for Project or Session
> overrides and tell me if they would hide the effect. Don't clear them for me.

> Remove this Project's cpus assignment with inherit. Tell me which value will
> win afterwards. Leave Global and Session alone.

**Inherit** removes one scope's assignment; it doesn't mean “factory reset.”
Higher scopes can still win. Whole-list `set` replaces a collection; prefer
`upsert` or `remove` when changing one host, mount, secret, or tool entry.

## When the sandbox won't boot

> Run msb_diagnostics, then inspect configuration and recovery metadata with
> msb_config_get. Explain what's known versus unverified. If a scoped settings
> repair is supported, propose the smallest fix for my approval. Keep protection
> enabled: don't use host fallback, turn off the sandbox, or broaden mounts/tools
> to work around the error. Verify activation after the repair.

Diagnostics work even while routed file and shell tools are blocked. They are
passive: no commands, SDK loading, VM startup, log fetching, or credential
resolution. Malformed TOML or unresolved workspace identity may still require
human repair from a host shell.

If the result is `saved_but_reload_failed`, the honest summary is **“saved, not
fully activated.”** Inspect again before retrying. [Recovery guide →](troubleshooting.md)

## A few excellent ground rules

- **Name the scope.** “For this Session,” “for this Project,” or “as my Global default.”
- **Ask for the smallest change.** Entry edits beat replacing a whole list by accident.
- **Keep policy outside the workspace.** Use the management tools, not sandbox Bash
  to edit host policy files. `.pi` files in your checkout are not a policy layer.
- **Keep credentials out of chat and logs.** Host source names are metadata, not
  secret values. Files such as `.env` inside cwd remain readable by the agent.
- **Ask what really happened.** Desired policy, persisted policy, and running VM
  policy can differ. A green-looking plan is not proof of enforcement.
