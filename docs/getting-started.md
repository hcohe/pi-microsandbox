# Installation and requirements

[Back to README](../README.md)

## Requirements

Pi must be installed and running on Node.js 22.19.0 or newer. Live sandboxes
require one of these hosts:

| Host | Architecture | Virtualization requirement |
| --- | --- | --- |
| macOS | Apple Silicon (arm64) | Apple virtualization support available to the process |
| Linux | x86_64 or arm64 (GNU) | KVM enabled, with `/dev/kvm` accessible to the process |

Windows and Intel macOS are not supported by pi-microsandbox. The upstream
microsandbox runtime has preview Windows support, but this package deliberately
declares only macOS and Linux. A Linux container or virtual machine also needs
KVM passthrough or nested virtualization; many hosted environments do not
provide it. Package loading and non-live tests do not require virtualization.

Installation must run lifecycle scripts and include optional dependencies:

- `fs-ext@2.1.1` compiles a native node-gyp module. Install Python and a working
  C/C++ build toolchain (`xcode-select --install` on macOS, or a compiler,
  `make`, and Python 3 on Linux).
- `microsandbox@0.6.16` installs its matching native addon and runtime binaries
  through an optional platform package. Do not use `--ignore-scripts` or omit
  optional dependencies when installing pi-microsandbox.

If the platform package is missing, reinstall with optional dependencies
enabled, install the matching microsandbox platform package, or set `MSB_PATH`
to a working `msb` binary. These alternatives do not remove the host
virtualization requirement.

## Install

Install the package for the current user with Pi:

```sh
pi install npm:pi-microsandbox
```

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

The public package is named `pi-microsandbox`. Existing technical interfaces
retain the shorter `msb` name for compatibility, including `/msb`,
`PI_MSB_*`, `.pi-msb.toml`, configuration directories, and managed-resource
labels. Existing configuration and retained resources therefore keep working.
