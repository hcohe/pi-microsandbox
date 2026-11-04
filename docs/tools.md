# Configuration tools

[Back to README](../README.md)

The model can inspect settings with **`msb_config_get`** and propose one change
with **`msb_config_set`**. Neither tool grants general host execution. These two
exact names remain available under default third-party blocking only when public
registration provenance resolves to this extension's actual entry module. Missing,
mismatched or duplicate-winning foreign registration receives no exemption;
other `msb_*` names have no exemption.

## `msb_config_get`

Arguments: `{}`. Returns the same machine-readable JSON in text and structured
`details`:

- `supportedPaths`: every supported snake_case setting leaf.
- `desired`: all resolved settings, including defaults and automatic
  `sandbox_name: null`. This is **not proof of adopted VM state**.
- `layers.global`, `.project`, `.ephemeral`: complete supported sparse raw
  assignments and removal controls; absent means inherit. Unknown raw values
  are omitted, malformed shadowed shapes are marked `<invalid>`, and unknown
  key names can appear in warnings/provenance. This is scope intent, not an
  effective configuration to copy back into storage.
- `origins` and `provenance`: resolver origins, including `defaults`, `env`,
  legacy `global`/`cli`, `host-default` (public global), `host-project` (public
  project), and `temporary` (public ephemeral). Secret/mount identities have
  entry origins; scalar-list provenance is field-level, not item history.
- `warnings` and `runtime`: status and known adopted settings/provenance,
  verification and timestamp. Reconnected VMs have only partially verified
  fields. Inactive adoption is last-known; `adopted: null` means unknown or an
  adapter without an agent-safe adoption snapshot. Historical adopted metadata
  retains adoption-time masking even after current settings/credentials change.

Inspection works without UI and never creates/bootstrap-writes configuration,
changes overrides, starts a sandbox or reloads. Invalid/unavailable configuration
returns a sanitized `rejected` result, not arbitrary parser/filesystem errors.
Secrets **and ENV/FILE credential references** are masked in every output channel.
Credential bytes and host environment values are never resolved for inspection.
This does not make files inside the mounted workspace secret.

## `msb_config_set`

Required arguments: `scope`, `path`, `operation`. Exactly one operation and scope
per call; no bulk request, approval flag, reset, lifecycle action, file-path
argument or arbitrary TOML write is supported.

| Argument | Values |
| --- | --- |
| `scope` | `ephemeral`, `project`, `global` (always explicit) |
| `path` | One leaf from `msb_config_get.supportedPaths`, e.g. `cpus`, `network.mode`, `secrets` |
| `operation` | `set`, `inherit`, `upsert`, `remove` |
| `value` | Required only for `set`/`upsert`; native Config values, with **camelCase entry keys** |
| `identity` | Required only for `remove`: secret env, mount guest path, or exact list string |
| `previousIdentity` | Optional only for `upsert`, to rename an entry |

`set` assigns one scalar or **replaces an entire collection**; `[]` explicitly
clears it in that scope. `inherit` removes that scope's assignment, not higher
layers. Native `upsert`/`remove` edits one secret, mount or scalar-list entry
(`route_tools`, `pass_through_tools`, `host_env`, `network.allow_hosts`,
`network.publish_ports`), preserving unrelated target/lower-scope siblings.
Higher-scope siblings are never silently promoted. A specifically selected
higher-scope entry can be deliberately imported; review reports that promotion.

Examples:

```json
{"scope":"project","path":"cpus","operation":"set","value":4}
{"scope":"ephemeral","path":"network.allow_hosts","operation":"upsert","value":"api.example.com"}
{"scope":"project","path":"secrets","operation":"upsert","value":{"env":"SERVICE_TOKEN","allowHosts":["api.example.com"]}}
{"scope":"global","path":"mounts","operation":"remove","identity":"/mnt/cache"}
{"scope":"project","path":"cpus","operation":"inherit"}
```

For a secret upsert, omitting `value.value` retains the selected effective
entry's private credential/reference and origin. If that identity is hidden by
an authoritative higher layer, only the target-owned raw entry is a fallback.
A value explicitly removed/cleared/replaced away in the draft is not resurrected.
A new secret needs a literal/reference; `<redacted>`/`[REDACTED]` placeholders
cannot be saved as credentials. Mount entries use `type`, `hostPath`, `guestPath`,
`readonly`, `options` and the same native workspace/canonical/symlink/socket
protections. Persistent automatic sandbox naming uses `inherit`, not null.

Global/project scopes save sparse host-owned defaults at the existing
[configuration locations](configuration.md#host-owned-project-overrides).
Ephemeral is the existing temporary/session layer: memory-only, above host
policy, never restored from transcripts, cleared on session/workspace identity
change or shutdown. Unlike the panel's current-running-only action, this tool
can edit ephemeral memory while inactive. An approved reload may start an inactive
sandbox when desired `auto_start` is true; it never enables host execution as
error recovery. Other sessions adopt saved defaults on their next start/reload.

### Approval and results

**Every invocation**, even inherit/no-op, needs a fresh explicit approval inside
execution. `allow_host_execution` does not waive it. No UI, print/JSON mode, or a
competing panel/review rejects without mutation. Interactive RPC requires a client
that supports Pi's UI selector; there is no timeout/automatic approval.

Approval shows a compact diff, not a configuration dump: a short accented
heading, muted scope/setting/entry identity, and only added/removed/changed
values in your theme's diff colors. Native entry edits omit siblings and
unchanged fields. Credentials/references stay `<redacted>`; a real rotation
shows `(changed)` even when both safe values look identical. Retained credentials
are not marked changed.

Target-scope assignment and inherited-baseline context remain distinct from
desired settings. No-op, promotion and higher-scope shadowing are explicit, even
when the effective value does not change. Only relevant consequences accompany
the diff: restart/guest-state loss, inactive sandbox start, whole-list replacement
or clearing, removal/inherit, writable host mounts, and the proposal's HOST bypass
policy (including pass-through tools and `block_third_party = false`). Unrelated
HOST reminders and full raw/desired/adopted/provenance JSON are not displayed.

In TUI, Cancel is initially selected. Scroll with arrows/j/k, PageUp/PageDown,
or g/G; Tab/left/right chooses Cancel/Approve, Enter activates, Escape cancels.
Approve stays disabled until the review's end has been visible. Resize as needed;
viewports below 32×10 cannot approve. RPC sends the equivalent compact plain-text
diff, without ANSI, in a Cancel-first selector. Oversized diffs reject instead of
hiding changed values.
Abort, cancellation, session replacement or changed source/ephemeral/runtime
state invalidates approval; nothing is automatically rebased/retried.

Outcomes include `inspected`, `rejected`, `cancelled`, `conflict`, `no_op`,
`applied` (`saved: true`, `reloaded: true`, with runtime status), and
`saved_but_reload_failed` (`saved: true`, `reloaded: false`). A completed reload
while off adopts extension policy but does not claim a running VM. Environment-
disabled reloads report saved-but-reload-failed. `apply_failed` with
`saved: "unknown"` means an I/O error may have occurred after atomic replacement;
inspect storage before retrying. No success result means only persistence.

The setter's transcript row does not echo raw arguments. Results show a brief,
truthful save/reload outcome; expanding shows the same focused diff, never the
full review JSON. Model-facing text is compact too, while structured `details`
retain the complete sanitized review and machine-readable outcome. The read-only
`msb_config_get` JSON inventory is unchanged.
