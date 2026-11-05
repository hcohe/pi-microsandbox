# Microsandbox control panel

[Back to README](../README.md)

Run **`/msb`** in interactive Pi. It opens full-screen with collapsed trees
directly below **MICROSANDBOX**, initially focused on Resources. Opening never writes
settings or starts a sandbox.
Headless/RPC/print invocations report an actionable error; configure host-owned
files or `PI_MSB_*` before starting a session instead.

Model-facing [`msb_config_get` / `msb_config_set`](tools.md) are separate tools,
not `/msb` subcommands. Inspection works headlessly; tool mutations always need
fresh No-first approval in an interactive TUI/RPC client. The panel and tool
review cannot overlap. Existing panel navigation and scope actions are unchanged.

## Top-level trees

- **Resources**, **Network**, **Secrets**, **Variables**, **Mounts**, **Tools**,
  **Image**, **Sources**, **Actions**, **Status**, **General**, and **Advanced**
  are the visible roots, in that order, with
  no wrapper. The settings trees edit desired policy. Values show their
  committed origin: default, environment, Global, Project or Session. Mixed
  collections show entry sources rather than claiming a single group owner.
- **Resources** contains only `cpus` and `memory_mib`. The timeout settings
  `idle_timeout_sec`, `stop_timeout_ms` and `replace_timeout_ms` are in **Advanced**.
- **Image** contains only `image` and `pull_policy`. **Variables** contains only
  `host_env`; `expose_session_environment` remains in **Advanced**.
- **Sources** retains committed-origin targets, inheritance diagnostics and warnings.
- **Tools** contains `block_third_party`, `route_tools`, `pass_through_tools`
  and `allow_host_execution`, in that order. Other advanced policy settings,
  including `allow_skill_reads` and `fallback_mode`, remain in **Advanced**.
- **Status** starts collapsed with a plain heading. Its inner
  items are read-only and labeled **[runtime]**: state, adoption/last-known timestamp,
  pending changes, identity (name/displayId/PID/cwd/root/createdAt), and Docker
  readiness/version/storage/reason when known. Configurable policy is not
  duplicated here. Proposals, external file edits, canceled changes and failed
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
| `d` | Propose entry deletion or scalar inheritance at the chosen scope; no action on a collection parent |
| Enter | Edit an editable item (same as `e`); otherwise expand a group or activate an action/form control |
| `q` | Close the TUI from the tree or any non-input screen; confirm proposal discard |
| Esc | Back/cancel; close from tree |
| Tab / Shift-Tab | Next / previous row, also skipping long diagnostic text |
| PageDown / PageUp | Scroll a long selected row |

Status metadata has no edit/add/delete actions. Letters are ordinary text in
text and masked inputs, including Kitty input and bracketed paste. Enter accepts
a field; Esc cancels it. Closing an active proposal or edited entry form asks to
discard, with **Cancel selected by default**. Cancel at that prompt returns to the
same screen. Escape/Cancel backs out of a proposal without changing committed
settings or runtime, and clears secret buffers.

The contextual footer is exactly one line pinned to the terminal's last row,
with bold, theme-accented keys and muted action words. It keeps full labels when
space permits and compacts to grouped keys (`Enter/e/a/d`) and arrow navigation
at mobile widths. Menus show short, friendly field hints. Value and choice editors
add format guidance and examples; on tiny screens, input takes priority over that
guidance. Editors show keep/cancel hints, not tree commands; busy screens ask you
to wait. Content has a separate viewport and cannot displace the footer.
At the physical limit of a one-row terminal only, selected content/errors take
priority over hints. Selection scrolls into view and reflows on resize.
Results/errors become focused, scrollable rows even at one or three terminal
rows; Enter opens the full result. Arrows scroll long transient descriptions;
Tab moves directly between controls.

## Apply scopes

Each scalar choice/text edit and each entry operation is applied or canceled
before returning to the settings tree. Structured secret/mount forms keep fields
together and expose the same focusable, theme-accented action buttons:

1. **Session** — integration session memory
   only, above host policy; no disk writes or transcript serialization. Cleared
   on session/workspace switch or shutdown, not restored on resume. Unavailable with a clear
   reason when no sandbox is running; it cannot silently boot a guest.
2. **Project** — persist sparse Project defaults
   in the canonical host-owned project `config.toml`.
3. **Global** — persist sparse Global defaults
   in `default.toml` shared by projects.
4. **Cancel** — discard this proposal without writes or runtime changes.

Apply automatically reconfigures/reloads **this sandbox**, after any meaningful
restart/security confirmation. Other sandboxes pick up persisted defaults on next
start/reload; there is no broadcast. Higher Project/Session overrides can shadow
lower-scope changes and are never automatically cleared. No manual Reload is
needed for normal edits. After a successful apply, **Quit** is selected by default;
Enter closes only the `/msb` panel, leaving the sandbox running. **Back** returns
to the settings tree.

Only the one deliberate operation is persisted, never a flattened effective
configuration or runtime snapshot. Entry CRUD preserves the chosen scope's other
entries, including those hidden by higher layers. It never exports unrelated
Project/Session credentials, mounts, hosts, environment or tool permissions.
A deliberate higher-scope entry import is identified by origin and identity in
confirmation: that particular permission/credential may become available to
other projects. Metadata edits retain private values/references without reading
credential bytes for display.

Collections have no bulk-clear or parent inheritance control. `d` removes one
entry; removing the last may leave an explicit empty list, still with entry
removal intent. Scalar `d` previews inheritance at the chosen scope.
Project/Session layers can shadow a lower-scope change or deletion; preview and
results report shadowing and no-ops. Conflicting same-scope `remove_*` identities are reconciled; unrelated removals stay intact.
Unknown raw settings are retained; comments/layout are not preserved on changed
saves. Unsafe paths and external edits are rejected; cancel and reopen a stale proposal.

Confirmation shows scope, changed fields, entry intents/origins, higher-scope
imports, runtime effect and shadowing. Resources, image, networking, secrets,
mounts, environment and boot/lifecycle changes may recreate the guest. Confirm
before losing guest ephemeral state and nested containers. Host writes already
happened and cannot be undone. Routing/footer/access policy and `auto_start`
preferences adopt live; `auto_start = false` never stops a running guest or
hands tools to the host. Pass-through tool edits and third-party blocking changes
require explicit confirmation: permitted third-party tools execute on the host
outside the sandbox without per-call host approval. Host-execution, host-fallback
and constrained host skill-read policy changes also warn and require confirmation,
including inheritance that may expose a more permissive lower policy.
Automatic session naming is a Session-only override; inherit removes persistent
naming assignments.

Saved settings and successful runtime adoption are separate outcomes. Failed
activation keeps the panel editable and the previous snapshot last-known; it
never silently enables host execution. Fix the cause, then use
**Actions → Reload settings** for recovery or external-file refresh. Apply
failures offer retry/cancel without exposing credential-bearing error text. A
saved-but-runtime-failed result does not claim storage was unchanged.

## Actions and diagnostics

**Actions** retains enable, **Turn off (HOST execution)**,
reload, prune, redacted logs (validated non-negative tail count, default 100),
effective redacted desired-config diagnostics, seal network through scope actions,
**Reset Session overrides** and help. Reset discards only current
memory-only overrides, leaves Project/Global defaults unchanged, and reconciles
automatically after destructive/restart confirmation. Dangerous actions require
explicit confirmation and idle. Status remains observational.

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
