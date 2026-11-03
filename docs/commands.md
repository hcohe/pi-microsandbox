# Microsandbox control panel

[Back to README](../README.md)

Run **`/msb`** in interactive Pi. It opens full-screen with collapsed trees
directly below **MICROSANDBOX**, initially focused on General. Opening never writes
settings or starts a sandbox.
Headless/RPC/print invocations report an actionable error; configure host-owned
files or `PI_MSB_*` before starting a session instead.

## Top-level trees

- **General**, **Resources**, **Network**, **Secrets**, **Mounts**, **Advanced**,
  **Status**, **Sources & warnings**, and **Actions** are the visible roots, with
  no wrapper. The settings trees edit desired policy. Values show their
  committed origin: default, environment, global, project or ephemeral. Mixed
  collections show entry sources rather than claiming a single group owner.
  `* draft`, `draft entry` and `inherit on save` mark intent, not a saved origin.
- **Status** starts collapsed with a plain heading. Its inner
  items are read-only and labeled **[runtime]**: state, adoption/last-known timestamp,
  pending changes, identity (name/displayId/PID/cwd/root/createdAt), and Docker
  readiness/version/storage/reason when known. Configurable policy is not
  duplicated here. Drafts, external file edits, canceled saves and failed
  activation do not replace the successful-adoption timestamp. Inactive
  adoption is explicitly **last known (not running)**; absent snapshots or
  unsupported adapters are reported honestly. Existing/reconnected guests show
  **VM instance not verified**: desired image/resources/network/etc. are not
  verified live metadata. Live/no-op reloads cannot restore VM certainty.

Secrets and mounts expand into child fields; lists expand into individual entries.
Secret values/references are always masked, never prefilled. Blank replacement
retains the private credential, including its FILE reference origin. Compact entry
forms keep a record together; cancel clears secret buffers.

## Keys

These bindings apply in normal tree mode, **not while typing**:

| Key | Action |
| --- | --- |
| `j` / down, `k` / up | Next / previous visible node |
| `h` / left | Collapse, otherwise parent; no-op on a collapsed top-level group |
| `l` / right | Expand, otherwise first child |
| `e` | Edit the selected supported settings item |
| `a` | Add to the selected collection (or entry's collection) |
| `d` | Delete an entry; remove a scalar/collection override at the eventual save scope (inherit) |
| `w` | Save + reload ephemeral current-session edits |
| `P` | Save + reload host-owned project edits |
| `G` | Save + reload host-owned global edits |
| Enter | Expand a group or activate an action/form control |
| `q` | Close the TUI from the tree or any non-input screen; confirm unsaved discard |
| Esc | Back/cancel; close from tree |
| Tab / Shift-Tab | Next / previous row, also skipping long diagnostic text |
| PageDown / PageUp | Scroll a long selected row |

`P` and `G` are uppercase. Save keys always target the desired settings draft,
including when Status has focus. Status metadata has no edit/add/delete actions.
In text and masked inputs, `q/e/a/d/w/P/G/j/k/h/l` are ordinary text, including
Kitty input and bracketed paste. Enter accepts a field; Esc cancels it. Closing a
dirty draft or edited entry form asks to discard, with **Cancel selected by default**.
Cancel returns to the same screen without dropping pending entries or saves;
Escape backs out of transient screens without closing.

The contextual footer is exactly one line pinned to the terminal's last row,
with bold, theme-accented keys and muted action words. It keeps full labels when
space permits and compacts to grouped keys (`e/a/d`, `w/P/G`) and arrow navigation
at mobile widths. Editors show keep/cancel hints, not tree commands; busy screens
ask you to wait. Content has a separate viewport and cannot displace the footer.
At the physical limit of a one-row terminal only, selected content/errors take
priority over hints. Selection scrolls into view and reflows on resize.
Results/errors become focused, scrollable rows even at one or three terminal
rows; Enter opens the full result. Arrows scroll long transient descriptions;
Tab moves directly between controls.

## Save scopes

1. **`w` ephemeral** — memory only, above host policy, never appended to the
   transcript or restored on resume; cleared on session switch/shutdown.
2. **`P` project** — canonical host-owned project `config.toml`.
3. **`G` global** — host-owned `default.toml` shared by projects.

Only deliberately dirty fields and entry operations are saved, never a flattened
effective configuration or runtime snapshot. Entry CRUD preserves the chosen scope's other
entries, including those hidden by higher layers. It never exports unrelated
project/ephemeral credentials, mounts, hosts, environment or tool permissions.
A deliberate higher-scope entry import is identified by origin and identity in
confirmation: that particular permission/credential may become available to
other projects. Metadata edits retain private values/references without reading
credential bytes for display.

**Clear list (explicit empty)** is a distinct whole-list replacement. `d` on the
collection inherits instead. Project/ephemeral layers can shadow a lower-scope
save or deletion; preview and results report shadowing and no-ops. Conflicting
same-scope `remove_*` identities are reconciled; unrelated removals stay intact.
Unknown raw settings are retained; comments/layout are not preserved on changed
saves. Unsafe paths and external edits are rejected; reopen a stale draft.

Confirmation shows scope, changed fields, entry intents/origins, higher-scope
imports, runtime effect and shadowing. Resources, image, networking, secrets,
mounts, environment and boot/lifecycle changes may recreate the guest. Confirm
before losing guest ephemeral state and nested containers. Host writes already
happened and cannot be undone. Routing/footer/access policy and `auto_start`
preferences adopt live; `auto_start = false` never stops a running guest or
hands tools to the host. Automatic session naming is an ephemeral-only override;
inherit removes persistent naming assignments.

Saved settings and successful runtime adoption are separate outcomes. Failed
activation keeps the panel editable and the previous snapshot last-known; it
never silently enables host execution. Fix the cause, then use
**Actions → Reload settings**. Reload/Enable refresh the draft
while preserving deliberate unsaved edits.

## Actions and diagnostics

**Actions** retains enable, **Turn off (HOST execution)**,
reload, prune, redacted logs (validated non-negative tail count, default 100),
effective redacted desired-config diagnostics, seal network in the draft,
reset ephemeral settings and help. Dangerous actions require explicit
confirmation and idle. Status remains observational.

Turn off deliberately hands tools to the unsandboxed host. This differs from
`fallback_mode = "host"`, which permits automatic host execution after failure.
Keep `block` for untrusted work. Prune preserves live owners/current session and
never removes host files or legacy named volumes. There are no workspace modes
or volume/export/copy actions; see [storage](storage.md) and [safety](safety.md).
Diagnostics cap display at 2000 lines, disclose truncation, and redact configured
secret bytes. Choose a smaller log tail when needed.

Launch failures name the settings/UI stage and a safe error class or known
filesystem code, never raw credential-bearing error contents. Check the named
host target's permissions/symlinks. A symlinked Pi agent root is supported;
policy descendants must be regular files/directories. Unexpected programming
failures reach Pi's handler as sanitized diagnostics.
