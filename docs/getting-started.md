# Zero to little Linux VM

[Back to README](../README.md)

## Check your host

You'll need Pi running on **Node.js 22.19.0+** and a supported virtualization host:

| Host | Architecture | What must be available |
| --- | --- | --- |
| macOS | Apple Silicon (`darwin-arm64`) | Apple virtualization support for the Pi process |
| GNU Linux | x86_64 or arm64 (`linux-*-gnu`) | KVM, with `/dev/kvm` accessible to the Pi process |

Windows, Intel macOS, and musl Linux are not supported by this package. Running
inside a container or another VM also requires KVM passthrough/nested
virtualization; many hosted environments don't provide it. Loading the extension
and running non-live tests do not require virtualization.

The Microsandbox SDK/CLI/runtime and matching prebuilt file-lock addon are
bundled through package dependencies. No separate runtime installer, compiler,
Python installation, or npm lifecycle scripts are needed. **Keep optional
dependencies enabled**: Microsandbox supplies runtime binaries through an
optional platform package.

## Take it for a spin

From the directory you want the agent to work in:

```sh
cd /path/to/project
pi -e npm:pi-microsandbox
```

Or install once, then start Pi normally:

```sh
pi install npm:pi-microsandbox
cd /path/to/project
pi
```

The default image includes Node.js, Python, Rust, Go, and guest Docker. The first
start may need an image download. [Other images and custom images →](images.md)

**Choose cwd deliberately.** Only canonical `realpath(cwd)` is mounted
read/write, at the lexically resolved cwd path inside Linux. Files you edit are
your actual host files. Git ancestors/siblings outside cwd aren't automatically
included; `.git`, `.env`, ignored files, and untracked files inside cwd are.

## Meet your sandbox

Ask your agent:

> Inspect my sandbox with msb_config_get. Give me a quick tour of resources,
> mounts, network policy, and host bypasses. Separate desired settings from
> verified or last-known runtime state. Don't change anything.

Or open **`/msb`** to browse the panel. Arrows or `hjkl` navigate, Enter edits,
`a` adds a collection entry, `d` removes an entry or inherits a scalar, and `q`
closes. Settings trees start collapsed; **Status** is read-only runtime information.
[Full panel guide →](commands.md)

The footer shows the sandbox name, for example **`great-cullen ●`**, matching
`msb ls`: green for active, red for blocked, and a warning color for sleep,
uncertain state, or host execution. The selected name appears during boot,
including while waiting for ownership, VM creation, and readiness checks, and
stays the same when active. Only initial configuration discovery before name
selection shows **`MSB starting ●`**, never a session hash. The dot pulses while
booting or reloading; a displayed boot name is not proof that the VM is ready.
Docker capability warnings alone don't turn an active VM red.
Colors follow your theme; the indicator isn't proof of every policy rule.

## Make one change

> Give this Project 2 CPUs and 4096 MiB RAM. Explain the restart impact, then
> propose both in one msb_config_set batch. After I approve, tell me whether the
> settings were saved and the sandbox activated successfully.

Choose the scope to match your intent:

- **Session:** memory-only; resets on Pi `/reload`, session/workspace switch, or
  shutdown. A transcript resume doesn't restore it.
- **Project:** shared main/root Git policy from main, linked and nested cwd;
  non-Git/unsupported layouts remain canonical-cwd-local. Always host-owned.
- **Global:** your saved baseline for all projects.

Setup and inspection create no config files. Approved persistent saves do.
Ordinary **settings reload** keeps Session overrides; Pi's **extension `/reload`**
clears them. Use Project or Global for restrictions that must survive.
[More agent recipes →](agent-recipes.md) · [Where settings live →](configuration.md)

## If startup gets stuck

Don't turn off protection just to troubleshoot. Ask:

> Run msb_diagnostics and inspect recovery metadata with msb_config_get. Explain
> what failed and what remains unverified. Propose the smallest approved repair
> if supported. Don't enable host fallback or turn the sandbox off.

Default failures block routed tools rather than silently using the host.
Diagnostics and approved configuration tools remain available without a healthy
VM. [Troubleshooting →](troubleshooting.md)

If the optional runtime package is missing, reinstall with optional dependencies
enabled, install the matching Microsandbox platform package, or point `MSB_PATH`
at a working standalone `msb` binary. None removes the virtualization requirement.

## Inspecting without virtualization

`PI_MSB_DISABLE=1 pi` loads the extension without starting a VM or loading its
SDK. You can open `/msb` and save Project/Global settings, but **Pi's ordinary
tools run directly on the host**. This is explicit off mode, not a sandboxed demo.
Canonical cwd discovery is still required.

Remove the variable and restart Pi when ready; it remains authoritative even
when you save settings. Headless users can inspect with agent tools and provision
host-owned TOML or `PI_MSB_*` launch settings, but agent mutations require an
interactive approval UI. [Understand the boundary before real work →](safety.md)
