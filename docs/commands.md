# Microsandbox control panel

[Back to README](../README.md)

Run **`/msb`** in interactive Pi to open the native full-screen control panel.
There are no subcommands or argument completions. Headless/RPC/print invocations
return an actionable error without executing lifecycle actions; configure the
host-owned files or `PI_MSB_*` environment variables before starting a session.

If opening fails, the diagnostic identifies the settings/UI stage and a safe error
class or known filesystem code, never raw config/error contents. Check the named
host settings target's permissions and symlinks; a symlinked Pi agent root is
supported, but policy descendants must be regular directories/files. Unexpected
programming failures reach Pi's error handler as sanitized diagnostics. Opening
applies no settings and never enables host execution.

## Navigate and edit

Use arrows or Tab to move, Enter to select/edit, and Esc to go back. Long screens
scroll automatically to the focused row; arrows also scroll long descriptions.
The layout reflows on resize, including narrow terminals and very short heights.
Save actions stack vertically and remain reachable with Tab. Results and failures
become focused, scrollable rows even on one- or three-row terminals; Enter opens
the full result text. Esc in a field
cancels that entry; closing a dirty panel asks before discarding changes.

- **Overview**: runtime state, full sandbox identity, workspace/workdir, image,
  PID, age, resources, network and Docker readiness/version/storage.
- **General / Resources**: image, boot policy, CPU/RAM, timeouts and presentation.
  `auto_start` only controls automatic boot on startup; changing it never stops a
  running guest or hands tools to the host. Sandbox naming has an explicit automatic
  session-name override for temporary scope; use Inherit for persistent files.
- **Network**: mode, DNS, allowed-host and published-port list add/edit/delete.
- **Secrets**: add/edit/delete environment names, destination hosts and masked
  replacement values or `$ENV:NAME` / `$FILE:path` references. Values are never
  prefilled. Leave replacement blank when editing to retain the existing private
  value; cancel clears entry buffers. Prefer references over literal credentials.
- **Mounts**: typed mount forms for host/guest paths, read-only and options.
- **Advanced**: all remaining supported settings, including routing, Docker,
  host environment, owner locks and explicit host-access controls.
- **Sources**: canonical save paths, precedence, warnings and effective provenance.
  Search all settings by name or description from any section.
- **Actions**: enable, turn off, reload, prune, redacted logs with a selectable non-negative tail count (default 100),
  prune error details, effective redacted configuration, seal networking in the draft, reset temporary
  settings, and help. Dangerous actions require explicit confirmation and idle.

Collection entry changes stay in the draft until applied. Add/edit/delete applies
only to selected identities in the chosen save scope, preserving that scope's
other entries (including entries hidden by the current project's settings).
It does **not** export unrelated project/session secrets, mounts, hosts, ports,
environment variables or tool permissions into global settings. A deliberately
edited project/session entry can be saved globally; confirmation identifies its
origin and explicitly warns about that higher-scope import. This can make that
specific credential or permission available to other projects—review it carefully.
Metadata-only secret editing retains the selected entry's credential/reference.

**Clear list/secrets/mounts** is a distinct explicit empty replacement of the
chosen scope's collection, not entry deletion. **Inherit** removes an assignment
from that scope. Higher project/session settings can still shadow either action;
confirmation and results report that honestly, including no-op lower-scope
removals. The backend also supports deliberate whole-list replacement, never
inferred from ordinary CRUD. Existing `remove_*` controls are reconciled only for
conflicting entries in the chosen scope and listed in preview; unrelated removals
remain intact. Unknown raw settings are retained; comments/layout are not
preserved on changed saves. Opening/cancelling the panel applies nothing.

## Three save buttons

1. **Apply temporarily** — current session memory only, above host policy; never
   appended to the transcript or restored on resume. Cleared on switch/shutdown.
2. **Apply to project settings** — host-owned canonical project `config.toml`.
3. **Apply to global settings** — host-owned `default.toml` for all projects.

Only deliberately dirty fields and entry operations are saved, never a flattened
effective snapshot. Materializing an authoritative list uses only its chosen
scope and lower layers; unrelated higher-scope entries are excluded. Unchanged
target credentials/references are preserved, and deliberately transferred FILE
references keep their source origin without reading credential bytes. Confirmation
shows target, changed fields, entry identities/origins, explicit clears/replacements,
intentional higher-scope imports, runtime effect and shadowed settings. Higher
project/temporary layers can shadow a global save; saving does not imply it became
effective. Saves re-resolve and validate the selected scope before committing.
External edits and unsafe filesystem paths are rejected; reopen a stale draft.

Resources, image, network/ports, secrets, mounts, environment and boot/lifecycle
changes recreate the guest when enabled. Confirm the disruption: guest ephemeral
state and nested containers can be lost. Host workspace writes already happened
and are not undone. Routing/footer/access-policy and automatic-start preference
changes adopt live. Lifecycle actions refresh the panel draft while retaining
deliberate unsaved edits; a saved-but-failed activation leaves the panel editable. Save
success and runtime activation failure are reported separately; failure never
silently turns the sandbox off or enables host fallback. Fix the cause and use
Actions → Reload settings, or close/reopen after external file changes.

**Turn off (HOST execution)** deliberately hands tools to the unsandboxed host.
This differs from `fallback_mode = "host"`, which permits automatic host execution
on sandbox failure. Keep the default `block` for untrusted work.

Prune walks all SDK pages, preserves live owners/current session, and never
removes legacy named volumes. There are no workspace modes, volume/export/copy
actions. Host files remain your responsibility; see [storage](storage.md) and
[host-read exceptions](safety.md#host-read-exceptions).

Diagnostic screens cap display at 2000 lines and disclose truncation. Choose a
smaller log tail if needed; configured secret bytes are redacted by the backend.
