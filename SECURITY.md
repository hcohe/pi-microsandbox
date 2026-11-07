# Security policy

## Supported versions

Before the first npm publication, security fixes are made only on the `main`
branch. After publication, only the latest version of `pi-microsandbox`
published on npm is supported. Older releases and unreleased forks are not
supported; users should upgrade before reporting a problem that may already be
fixed.

## Report a vulnerability privately

Do not open a public issue, discussion, or pull request for a suspected
vulnerability. Use GitHub's private vulnerability reporting for this repository:

<https://github.com/hcohe/pi-microsandbox/security/advisories/new>

In the repository UI, this is **Security → Advisories → Report a
vulnerability**. This route is available to outside reporters after the
repository is public and private vulnerability reporting has been enabled. While
the repository remains private, only people who already have appropriate
repository access can use its private security-advisory workflow. If the link is
not available, do not substitute a public report or disclose the issue in a
public channel.

A useful report includes the affected pi-microsandbox version or commit, Pi and
Node.js versions, host operating system and architecture, virtualization setup,
impact, and minimal reproduction steps. State whether the behavior requires a
particular workspace layout, network policy, fallback setting, or host-execution
approval.

## Keep sensitive data out of reports

Provide only the minimum redacted evidence needed to reproduce the issue. Do
not include:

- passwords, API keys, npm tokens, cloud credentials, signing material, or
  unredacted environment variables;
- secret values from `textValue`, host environment variables (`host_env`), or host
  command output (`host_cmd`);
- complete sandbox logs, configuration dumps, session files, or command output
  that may contain secrets;
- workspace or legacy-volume contents, source code, `.env` files, or other
  private user data that is not essential to the report.

If a real secret may have been exposed, revoke or rotate it first. The selected
workspace is only canonical `realpath(cwd)`, mounted read/write at the lexically
resolved cwd as both guest root and command cwd. Git discovery never selects
the bind or automatically exposes Git ancestors/siblings outside cwd. Within
cwd, `.git`, secrets, and untracked files remain exposed. External linked-worktree
or submodule metadata is not separately mounted; guest Git may need explicit
setup or mounts. Writes reach the host immediately, overlapping sessions share
host files, and nested containers can access the mount. Explicit mounts and
user-approved host controls can widen access separately; this is not a guarantee
against every sandbox escape. Use
synthetic values in the reproduction and describe omitted material rather than
attaching it. Remember that GitHub advisory participants can read uploaded
artifacts, so a private report is not a reason to include unnecessary secrets.

## Diagnostic and recovery tools

`msb_diagnostics` is passive and host-side, so it remains available while sandbox
execution is blocked. It does not execute host or secret commands, load the native
SDK, fetch logs, read configuration files or environment values, start a VM, or
change policy. Reports redact literal credentials, bound output, and identify
unknown checks instead of exposing raw exceptions. Host variable names and host
command source text are intentionally readable metadata; do not embed credentials
in command text.

Diagnostic access does not grant general host execution. Only exact tool names
registered by this extension receive the management-tool exemption. Settings
repairs use the existing explicit user approval, full candidate validation, and
source/session guards. Invalid-baseline recovery also requires informed approval
of the newly activated safety policy and every retained host command, not just
the repaired field. A broken sandbox does not authorize a host fallback,
a malformed-file overwrite, or bypassing a failed workspace identity check.

## What happens next

Maintainers will review the private report, ask for redacted clarification when
needed, validate the impact, and coordinate a fix and disclosure through the
GitHub advisory. A confirmed issue may result in a patched npm release, a GitHub
security advisory, and release notes. GitHub Releases are the canonical
changelog. Response and remediation times depend on severity, reproducibility,
and maintainer availability; this policy does not promise a fixed response
time.
