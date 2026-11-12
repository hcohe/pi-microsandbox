# When the sandbox gets sand in its gears

[Back to README](../README.md)

## Start here: diagnose without opening the gates

Ask your agent:

> Run msb_diagnostics, then inspect configuration and recovery metadata with
> msb_config_get. Explain what failed and what's unverified. Propose the smallest
> supported settings repair for approval. Don't turn off the sandbox, enable host
> fallback, or broaden host tools/mounts as a workaround. Verify activation.

`msb_diagnostics` works while routed tools are blocked. It uses cached,
secret-redacted state—no commands, SDK loading, file/environment reads, live log fetching,
credential resolution, or VM startup. It may include the latest cached safe image
build/load failure with phase, command/status, bounded output tails and recovery
hints. These were sanitized at failure time, not fetched by diagnostics. A new
automatic preparation/recreation, explicit build/load attempt or session clears
the cache; unchanged/live-only reloads retain completed failures. Upstream-truncated
output is withheld when full credential redaction cannot be established. It isn't a
live health check.

If passive inspection is insufficient, ask the agent to explain the narrow live
diagnostic need and expected host effects, then request one simple, clear,
human-readable command in one `bash` call with `execution_target: "host"` and
an explicit finite positive `timeout` ≤120 seconds. Each step needs its own call
and fresh approval; never chain commands or hide multiple operations in shell
syntax or wrappers. Follow the
[host command instructions](safety.md#fail-closed-by-default).
With ready current workspace identity/configuration and existing host permission,
unavailable/disabled recovery shows the exact command and execution directory for fresh No-first approval.
Use optional host Bash `cwd` for a different existing directory instead of `cd` or
chaining; relative paths resolve against the fixed session cwd. The approval shows
any different canonical target and colors outside-workspace directories red in the
TUI, including symlink escapes. Each directory change needs fresh approval and
identity validation; the original session-root proof remains required even for
outside directories. The required timeout remains authorized and enforced, without a separate dialog row.
The inline TUI approval has no navigation footer; RPC/select-only UI chrome is
controlled by its adapter.
No interactive UI means no execution. Other routed tools and booting/stopping
remain blocked; unresolved identity/configuration requires manual host repair.
Recovery also rejects changed canonical cwd or physical directory identity, even
when the lexical path is unchanged. Restart the session to rediscover a replaced
workspace; restoring its path does not revive a failed approval.
This is real host-user execution outside VM/network isolation, not guaranteed
read-only; timeout does not guarantee descendant confinement. Never enable host
fallback or broaden permissions just to diagnose a failure.

Configuration tools also work without a healthy VM. A supported semantic repair
validates the entire final configuration before saving and requires fresh human
approval. Recovering an invalid baseline additionally reviews the safety policy
being activated, including retained host commands, not just the field repaired.
Malformed TOML and unresolved workspace identity need human host-side repair.

Prefer doing it yourself? Open `/msb`, inspect **Status**, then **Actions →
Recent logs**. Fix the cause and choose **Reload settings** after external edits.
Normal approved settings edits reload automatically.

## “Saved” isn't always “running”

| Result | Meaning / next step |
| --- | --- |
| `applied` | Save and reload completed. Check runtime status: off mode is still not a running VM. |
| `saved_but_reload_failed` | The setting was saved, but not fully activated. Inspect again, fix the cause, and reload; don't assume rollback. |
| `conflict` | Source/session/runtime changed during review. Cancel and make a fresh proposal. |
| `rejected` | Nothing was authorized/applied; inspect safe validation or recovery guidance. |
| `apply_failed` with `saved: "unknown"` | I/O may have failed after replacement. Inspect host storage before retrying. |

With default `fallback_mode = "block"`, failure does not silently run tools on
the host. Explicit off mode and `fallback_mode = "host"` are **unsandboxed**,
not recovery magic. Don't disable protection just to get diagnostic tools back.

## Common snags

### Missing runtime or virtualization

- Keep npm optional dependencies enabled; Microsandbox uses a platform package
  for its native runtime. Reinstall appropriately, install that platform package,
  or set `MSB_PATH` to a working standalone `msb` binary.
- Linux needs accessible `/dev/kvm`; a container/VM needs passthrough or nested
  virtualization. Installing another package won't add missing host support.
- Supported hosts are Apple Silicon macOS and GNU Linux x86_64/arm64—not Intel
  macOS, Windows, or musl Linux. [Requirements →](getting-started.md#check-your-host)

### Policy won't load or save

Check the named host target's permissions and path layout from a **host shell**.
The selected Pi agent directory may be a symlink; files/directories below its
canonical anchor must not be. Policy cannot live in cwd or writable mounts.
The panel reports a safe stage/error class rather than raw credential-bearing
exceptions. Never paste raw credentials into an issue report.

Malformed TOML requires a host editor; the agent setter won't blindly overwrite
an unreadable file. Inspection, reload, and setup don't create missing files;
that is expected, not an installation failure.

### “Where did my Project settings go?”

Supported Git main, linked and nested cwd use the same **main/root Project**.
Non-Git/unsupported layouts remain canonical-cwd-local; Global is unchanged.
Inspect Sources or `msb_config_get` for the exact readable main-root location under
`projects/` (home-relative) or `projects-absolute/` (outside home). No hashed-path
lookup or migration occurs. Keys containing reserved artifact components
`build-context`, `config.toml` or `Dockerfile` fail closed; choose a different checkout
path. Execution mounts and Session safety remain current-cwd-only.

In-repo `.pi-msb.toml` is ignored. Older host Project `.pi-msb.toml` files aren't
auto-migrated to `config.toml`. [Migration guide →](configuration.md#coming-from-an-older-setup)

### “My Session restriction disappeared”

Pi `/reload`, session/workspace switch, and shutdown clear Session overrides;
resuming the transcript doesn't restore them. Ordinary **settings reload**
preserves them. Inherited policy can be broader after reset. Ask for Project or
Global scope if the restriction must last.

### Missing files or Git errors

Only cwd is mounted read/write; Git ancestors and siblings outside it aren't
automatically exposed. Start Pi at the intended directory instead of expecting
Git-root discovery. External linked-worktree/submodule metadata isn't separately
mounted, so guest Git may need explicit setup or reviewed mounts.

Unsupported cwd/symlink layouts fail rather than choosing a different root.
Replacing cwd invalidates prior host approvals and host-read grants. Remember:
`.git`, `.env`, and untracked files inside cwd are exposed, host writes are
immediate, and overlapping sessions share files. [Storage →](storage.md)

### Missing commands or blocked downloads

Use an image with the required commands, or allow the needed package repositories
under the intended network policy. `deny` cannot bootstrap missing guest tools.
Allowlist domains are exact: a package may fetch binaries from destinations other
than its registry. Review those destinations rather than switching to `open`.
[Images →](images.md) · [Network rules →](configuration.md#networking)

### Stale or conflicting sandboxes

After a dead owner releases its lock, startup or **Actions → Prune stale
sandboxes** can clean eligible labelled resources. Live owners/current sessions
are preserved. If a same-name resource has different managed labels, the
extension refuses to attach or replace it. Verify with Microsandbox tooling
before any manual removal. Host files and legacy named volumes are not pruned.

## Docker feeling grumpy?

`/msb` → **Status** shows readiness, version, and storage driver when known.
Inside an active guest, recheck with:

```sh
pi-msb-docker-start 15000
docker info
```

Guest startup logs are at `/var/log/pi-msb-dockerd.log`. Useful checks:
`iptables --version` should report `nf_tables`, `nft --version` should work,
and `sysctl net.ipv4.ip_forward` should be `1`.

The daemon uses `vfs`: slower builds and higher disk use than `overlay2` are
expected. Increase `memory_mib` or `docker.startup_timeout_ms` for heavy startup
or builds. Small builds should have at least 1 GiB; larger Compose stacks often
need 2 GiB or more. Default VM memory is 8 GiB.

For host access to a container port, you need **two mappings**: outer
`network.publish_ports` set before VM creation, then Docker `-p` inside the VM.
A Docker mapping alone isn't host-reachable. Network pull/egress failures under
`deny` or `allowlist` may be expected. Never mount the host Docker socket or
bypass outer policy to make them disappear.

## Old named workspace volumes

Older `pi-msb-vol-*` volumes aren't migrated or deleted automatically and may
contain unexported work. Current `/msb` doesn't list/export/manage them. Recover
and verify the data with Microsandbox tooling before deleting anything.
[Recovery instructions →](storage.md#upgrading-from-named-git-volumes)

For source-level validation, see the [live test matrix](development.md#live-test-matrix).
A skipped live test is not proof that virtualization works.
