# Installation and requirements

[Back to README](../README.md)

## Requirements

Pi must be installed and running on Node.js 22.19.0 or newer. Live sandboxes
require one of these hosts:

| Host | Architecture | Virtualization requirement |
| --- | --- | --- |
| macOS | Apple Silicon (`darwin-arm64`) | Apple virtualization support available to the process |
| GNU Linux | x86_64 (`linux-x64-gnu`) or arm64 (`linux-arm64-gnu`) | KVM enabled, with `/dev/kvm` accessible to the process |

Windows, Intel macOS, and musl Linux are not supported by pi-microsandbox. The
upstream microsandbox runtime has preview Windows support, but this package
deliberately supports only the three targets above. A Linux container or
virtual machine also needs KVM passthrough or nested virtualization; many hosted
environments do not provide it. Package loading and non-live tests do not
require virtualization.

pi-microsandbox includes a prebuilt POSIX lock addon for each supported target.
It is loaded lazily when an owner lock is first needed. Consumer installation
does not compile native code or require Python, a C/C++ toolchain, or npm
lifecycle scripts; installation with scripts disabled is supported.

Keep optional dependencies enabled. `microsandbox@0.6.16` supplies its CLI,
native addon, and runtime binaries through an optional platform package. If that
platform package is missing, reinstall with optional dependencies enabled,
install the matching Microsandbox platform package, or set `MSB_PATH` to a
working standalone `msb` binary. These alternatives do not remove the host
virtualization requirement.

## Install

Install the package for the current user with Pi:

```sh
pi install npm:pi-microsandbox
```

This is the only package installation step on a supported host. The dependency
includes the Microsandbox SDK and CLI; its matching optional platform package
includes the host runtime. You do not need to run the standalone Microsandbox
installer first.

Before starting a sandbox, review [configuration](configuration.md) and choose a
[published variant or custom image](images.md) if the versioned default image
does not fit the project.

For a first load, explicit off mode lets you inspect the installation without
starting virtualization:

```sh
PI_MSB_DISABLE=1 pi
# In Pi:
/msb status
```

Off mode is **not sandboxed**: Pi's tools run directly on the host. Remove
`PI_MSB_DISABLE` only after reviewing the configuration and host prerequisites.
For an unavailable or failed sandbox, the default `fallback_mode = "block"`
blocks routed tools rather than silently running them on the host. Keep that
default for a fail-closed setup. `fallback_mode = "host"` is an explicit,
visibly labelled opt-in to automatic unsandboxed execution.

The public package is named `pi-microsandbox`. Current technical interfaces
retain the shorter `msb` name, including `/msb`, `PI_MSB_*`, `.pi-msb.toml`,
configuration directories, and managed-resource labels.

There are no workspace modes. Starting inside Git mounts the entire worktree
root read/write; starting elsewhere mounts the cwd. The mount uses the same
lexical guest path, commands retain their original cwd, and writes reach the
host immediately. This exposes `.git`, secrets, untracked files, and sibling
directories. Concurrent sessions share a checkout, and nested containers can
reach the mount.

Before upgrading from a release with named Git workspaces, use its `/msb
volumes` and `/msb export` commands to inventory and copy retained work. The new
release neither reconnects nor deletes legacy volumes. Recover or remove them
manually with Microsandbox tooling after confirming their contents. Removed
settings such as `mode` and `PI_MSB_MODE` are errors, not compatibility aliases.
