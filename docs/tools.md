# Configuration tools

[Back to README](../README.md)

The model can discover and inspect settings with **`msb_config_get`** and propose
one operation or an atomic same-scope batch with **`msb_config_set`**. Neither tool grants general host execution. These two
exact names remain available under default third-party blocking only when public
registration provenance resolves to this extension's actual entry module. Missing,
mismatched or duplicate-winning foreign registration receives no exemption;
other `msb_*` names have no exemption.

## `msb_config_get`

All arguments are optional. `{}` keeps the full machine-readable inventory in
structured `details`, but displays a readable overview and desired settings rather
than a minimized JSON wall. Expand the TUI tool row for the full readable report.
Explicit sections produce their full report; `format: "json"` returns indented
JSON. Both text and JSON display are bounded to 48,000 UTF-8 bytes; use filters for
large inventories. Oversized JSON display returns a valid truncation envelope,
not broken JSON; selected structured `details` stay complete.

| Argument | Values |
| --- | --- |
| `sections` | Non-empty list: `summary`, `desired`, `layers`, `origins`, `runtime`, `schema`, `capabilities`, `policy`, `warnings`. Omit for all. `origins` includes provenance; `schema` includes supported paths. |
| `paths` | Non-empty list of supported snake_case leaves or `network`/`docker` groups. Filters desired/layers/origins/runtime settings/schema; no indexed or file paths. Layer filters retain matching removal controls. |
| `format` | `text` (default) or indented `json`. |
| `knownSchemaVersion` | Positive integer. When it matches `schemaVersion`, unchanged schema/capabilities are omitted and `schemaUnchanged: true` is returned. Cache only schemas actually requested; no server-side conversation cache. |

Safety context in `summary` and `policy` is deliberately **not path-filtered**.
Filtering is applied only after the complete redaction boundary, never to raw
configuration. Filter errors are rejected inside execute without echoing input
or reading settings. Filters affect output, not source-resolution semantics.

Examples:

```json
{"sections":["summary","desired","policy"],"paths":["network"]}
{"sections":["schema"],"paths":["network.mode","secrets"],"format":"json"}
{"sections":["desired","runtime"],"paths":["cpus"],"knownSchemaVersion":2}
```

The selected inventory contains:

- `schemaVersion`: discovery contract version, returned even for filtered or
  invalid/unavailable configuration results. Send it as `knownSchemaVersion`
  after caching discovery; a changed version returns discovery again.
- `summary`: runtime status, desired/adopted network modes, verification guidance,
  Session lifetime/reset warning and prominent network-policy limitations.
- `supportedPaths`: supported snake_case setting leaves (filtered when requested).
- `settingsSchema`: a descriptor for every leaf, including set-value JSON schema,
  description, choices, constraints, supported operations/scopes, conservative
  live/restart impact and native upsert entry schema. Entry keys are camelCase.
- `capabilities`: approval and batch limits/semantics, plus network modes, exact
  domain matching, IP/CIDR rules, protocols/ports, DNS exceptions, published ports
  and secret injection semantics. No source-code/documentation reads are needed
  to discover how to configure the sandbox.
- `effectivePolicy.desired` and `.adopted`: separate network summaries showing
  destination rules, DNS exceptions, published ports and secret injection scopes
  (never credential values). Secret scopes **do not add network grants**. Adopted
  is last-known, not a connectivity probe; null means unknown, including partially
  verified reconnections. Runtime status remains explicit; an off VM is not proof
  of active enforcement. HOST/pass-through tools are outside the VM boundary.
- `desired`: all resolved settings, including defaults and automatic
  `sandbox_name: null`. This is **not proof of adopted VM state**.
- `layers.global`, `.project`, `.session`: complete supported sparse raw
  assignments and removal controls; absent means inherit. Unknown raw values
  are omitted, malformed shadowed shapes are marked `<invalid>`, and unknown
  key names can appear in warnings/provenance. This is scope intent, not an
  effective configuration to copy back into storage.
- `origins` and `provenance`: resolver origins, including `defaults`, `env`,
  legacy `global`/`cli`, `host-default` (Global), `host-project` (Project), and
  `temporary` (Session). Secret/mount identities have
  entry origins; scalar-list provenance is field-level, not item history.
- `warnings` and `runtime`: status and known adopted settings/provenance,
  verification and timestamp. Reconnected VMs have only partially verified
  fields. Inactive adoption is last-known; `adopted: null` means unknown or an
  adapter without an agent-safe adoption snapshot. Historical adopted metadata
  retains adoption-time masking even after current settings/credentials change.
  `runtime.networkVerification` explains unknown adoption. Reconnection did not
  read back VM network settings; inspection never recreates the VM. Connectivity
  probes verify only tested destinations, not the entire policy. An explicitly
  approved network-setting change that recreates the guest yields a known adoption
  snapshot; no-op/live-only edits cannot verify its network.

Inspection works without UI and never creates/bootstrap-writes configuration,
changes overrides, starts a sandbox or reloads. Invalid/unavailable configuration
returns a sanitized `rejected` result, not arbitrary parser/filesystem errors.
Secrets **and ENV/FILE credential references** are masked in every output channel.
Credential bytes and host environment values are never resolved for inspection.
This does not make files inside the mounted workspace secret.

## `msb_config_set`

Required: one explicit `scope`, plus **either** `path`/`operation` (and applicable
operation arguments) **or** an `operations` array of 1–64 operation objects.
Batch entries have the same operation arguments but no scope. Mixing the two
forms, nested scopes, approval flags, reset/lifecycle actions, file-path arguments
and arbitrary TOML writes is rejected.

| Argument | Values |
| --- | --- |
| `scope` | `session`, `project`, `global` (always explicit) |
| `path` | One leaf from `msb_config_get.supportedPaths`, e.g. `cpus`, `network.mode`, `secrets` |
| `operation` | `set`, `inherit`, `upsert`, `remove` |
| `value` | Required only for `set`/`upsert`; native Config values, with **camelCase entry keys** |
| `identity` | Required only for `remove`: secret env, mount guest path, or exact list string |
| `previousIdentity` | Optional only for `upsert`, to rename an entry |
| `operations` | Alternative to top-level operation fields: 1–64 ordered operations in the one scope |

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
{"scope":"session","path":"network.allow_hosts","operation":"upsert","value":"api.example.com"}
{"scope":"project","path":"secrets","operation":"upsert","value":{"env":"SERVICE_TOKEN","allowHosts":["api.example.com"]}}
{"scope":"global","path":"mounts","operation":"remove","identity":"/mnt/cache"}
{"scope":"project","path":"cpus","operation":"inherit"}
```

For a combined network change, use one approval and at most one restart:

```json
{"scope":"session","operations":[
  {"path":"network.allow_hosts","operation":"set","value":["registry.npmjs.org","github.com","api.github.com","codeload.github.com","raw.githubusercontent.com"]},
  {"path":"network.mode","operation":"set","value":"allowlist"}
]}
```

All operations run in order on one private draft. Only the final candidate is
validated; intermediate cross-field states are never saved or adopted. One
combined masked review authorizes one atomic settings commit and at most one
reload. Invalid, cancelled or stale proposals do not partially commit. Repeated
paths are allowed for ordered native entry CRUD; review describes the resulting
changes. Persistence and runtime activation remain separate: a reload failure
can leave the whole candidate saved but not adopted, without automatic rollback.
Bounded filesystem races and post-rename I/O ambiguity remain as documented in
[the backend contract](settings-backend.md#file-safety-and-bounded-guarantees).

Network domain lists require **exact ASCII DNS names**, e.g. `api.example.com`;
network rules also accept IP addresses/CIDRs. Secret destinations accept exact
DNS names or wildcard subdomain scopes such as `*.googleapis.com` (single leading
`*.` only), passed to the SDK's secret host pattern matcher. Add the apex
separately if needed. Wildcards remain invalid for network rules, and secret
scopes do not grant network access. Neither list accepts URLs, port selectors,
trailing-dot names or implicit subdomain grants; use punycode for IDNs.
IP addresses/CIDRs are not secret credential destinations.

For a secret upsert, omitting `value.value` retains the selected effective
entry's private credential/reference and origin. If that identity is hidden by
an authoritative higher layer, only the target-owned raw entry is a fallback.
A value explicitly removed/cleared/replaced away in the draft is not resurrected.
A new secret needs a literal/reference; `<redacted>`/`[REDACTED]` placeholders
cannot be saved as credentials. Mount entries use `type`, `hostPath`, `guestPath`,
`readonly`, `options` and the same native workspace/canonical/symlink/socket
protections. Persistent automatic sandbox naming uses `inherit`, not null.

Global/Project scopes save sparse host-owned defaults at the existing
[configuration locations](configuration.md#host-owned-project-overrides).
Session is memory-only, above Project/Global, never restored from transcripts, cleared on session/workspace identity
change, **Pi `/reload`**, or shutdown. Inherited defaults then return and may
allow broader access. Ordinary **settings reload preserves Session overrides**;
it is not Pi's extension `/reload`. Getter summaries, changed Session tool results,
the panel scope selector and shutdown notifications make this lifetime explicit.
Choose Project or Global explicitly, with approval, to persist restrictions;
there is no automatic promotion or restoration from transcripts. Unlike the panel's Session action, this tool
can edit Session settings while inactive. An approved reload may start an inactive
sandbox when desired `auto_start` is true; it never enables host execution as
error recovery. Other sessions adopt saved defaults on their next start/reload.

### Approval and results

**Every invocation**, even inherit/no-op, needs a fresh explicit approval inside
execution. `allow_host_execution` does not waive it. No UI, print/JSON mode, or a
competing panel/review rejects without mutation. Interactive RPC requires a client
that supports Pi's UI selector; there is no timeout/automatic approval.

Approval looks like the HOST-command question: **Allow configuration change?**,
a standalone `Scope: Session`, `Scope: Project`, or `Scope: Global` line
and the affected item, a focused color-coded diff, and vertical **No / Yes**
choices. There is no dashboard header, duplicate identity or routine source dump.
Scope names use the theme’s warning color; the `Scope:` label stays muted.
Native entry edits omit siblings and unchanged fields. Credentials/references stay `<redacted>`; a real rotation
shows `(changed)` even when both safe values look identical. Retained credentials
are not marked changed.

Edits based on inherited values are marked as overrides, and no-ops remain
explicit. Semantic warnings are not shown in the confirmation dialog. After the
change tool completes, its plain-text result returns relevant consequences to the
agent: promotion/higher-scope shadowing, restart/guest-state loss, inactive sandbox
start, whole-list replacement or clearing, removal/inherit, writable host mounts,
Session lifetime, network/DNS limitations, and the proposal's HOST bypass policy
(including pass-through tools and `block_third_party = false`). The agent should
explain relevant returned warnings to the user. Unrelated HOST reminders and full
raw/desired/adopted/provenance JSON are not displayed.

Approval uses Pi's standard No/Yes selector. In TUI, **No** is initially selected;
arrows/j/k choose No/Yes, Enter selects, and Escape cancels. The complete masked,
theme-colored diff and nonwarning context are passed to Pi without pagination or a
read-to-end gate. Pi owns layout; long questions may exceed the visible terminal
area, and the extension does not provide scrolling or guarantee every line is
visible. RPC receives the same plain-text question/diff with No/Yes and no ANSI.
Oversized diffs reject instead of hiding changed values.
Abort, cancellation, session replacement or changed sources, Session settings or
runtime state invalidate approval; nothing is automatically rebased/retried.

Rejected setter proposals include safe `validation` entries when a cause can be
identified: `code`, zero-based `operationIndex` (0 for a single operation), a
whitelisted `path` and static `expected`/`expectedSchema`. Text uses one-based
operation numbers. Cross-field failures report `operationIndex: null` and related
operation indices rather than falsely blaming one entry. Unattributable inherited,
source, mount or reference failures remain explicitly generic. Raw parser/error
messages, input values, secret identities and credential references are never
copied into these diagnostics. Rejections do not review, save or reload.

Outcomes include `inspected`, `rejected`, `cancelled`, `conflict`, `no_op`,
`applied` (`saved: true`, `reloaded: true`, with runtime status), and
`saved_but_reload_failed` (`saved: true`, `reloaded: false`). A completed reload
while off adopts extension policy but does not claim a running VM. Environment-
disabled reloads report saved-but-reload-failed. `apply_failed` with
`saved: "unknown"` means an I/O error may have occurred after atomic replacement;
inspect storage before retrying. No success result means only persistence.

The setter's transcript row does not echo raw arguments. Results show a brief,
truthful save/reload outcome; expanding shows the focused diff without warning
blocks, never the full review JSON. Model-facing setter text includes the full
semantic diff and relevant warnings for `applied`, `no_op` and
`saved_but_reload_failed`; the latter says saved but not fully activated, not
success. Structured `details` retain the complete sanitized review and
machine-readable outcome. Cancelled, rejected or conflicted changes do not claim
persistence or activation.
Getter text uses headings and indented setting lists; JSON is optional and
pretty-printed. The same three scope names use lower-case JSON keys.

Network inspection reports and changed-network setter text warn that DNS/IP
matching is **not per-request URL/TLS-hostname authorization**, shared-IP/cache
state matters, and destination rules are not HTTPS-only. Enabled DNS is a separate
runtime-host port 53 exception, not service-domain filtering or proof against
DNS exfiltration. HOST/pass-through tools remain outside the VM boundary.
