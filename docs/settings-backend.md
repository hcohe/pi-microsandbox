# Settings backend integration contract

This is the backend seam used by the full-screen `/msb` control panel. All modules remain flat and ship with
the existing package manifest. No SDK import, configuration creation, or write
occurs when constructing the editor.

## Entry points

- Native `MsbControl.settings` exposes a `SettingsEditor` (optional only to keep
  injected/third-party control adapters compatible). Construct one per integration,
  never one per screen. `MsbIntegration.endSession()` clears its temporary layer.
- `SETTINGS_PATHS` enumerates every public schema leaf in TOML spelling. `network`
  and `docker` are individual leaf fields; arrays are complete collections.
- `await editor.open("temporary" | "project" | "global")` captures raw target
  data, the effective baseline, and a draft revision. No file is created.
- `draft.set(path, value)` marks exactly one schema leaf dirty. For arrays this
  is an **explicit whole-list replacement** (`[]` is an explicit clear), not CRUD.
  `inherit(path)` removes that target-layer assignment, distinct from `[]` or `""`.
  Snake/camel names work; values use the existing normalized Config shapes.
- `draft.upsertSecret({env, allowHosts, value?}, previousEnv?)` retains the selected
  entry's credential/reference privately when `value` is omitted, including prior
  pending replacements. `removeSecret(env)` records deletion of that identity.
  `upsertMount(mount, previousGuest?)`/`removeMount(guest)` likewise record only
  deliberate entry operations, including renames.
- `upsertListEntry(path, value, previousValue?)`/`removeListEntry(path, value)` do
  the same for network hosts/ports, host environment and routing/pass-through
  lists. Frontends must use these for list CRUD, not pass a
  displayed effective array to `set`. Clear/replacement is separately deliberate.
- `draft.snapshot()` returns a **masked raw target layer with deliberate entry
  operations**, not the materialized candidate and never an effective config
  suitable for persistence. Inherited baseline entries are not flattened into
  that snapshot. Original raw keys can be snake/camel spelling.
  Secret values (including reference strings) are masked in raw snapshots/diffs.
  Use the effective TOML display for ENV/FILE reference details; literal secrets
  are redacted there. Never feed masked values back into `set`.
- `await draft.forScope(scope)` transfers dirty scalar fields and **entry intent**,
  not an effective collection snapshot. On preview/apply, entry operations replay
  over the chosen scope's at-or-below-scope baseline: global excludes project/temp;
  project excludes temp; temporary includes the current effective session.
  Existing target-only entries survive. Unrelated higher-scope entries never get
  imported, even when hidden target entries are absent from the displayed list.
  Use this for the three scope buttons and confirm `preview()` before applying.
  Inherit removes an assignment from the **chosen scope**; it does not remove a
  higher-precedence assignment.
- `await draft.refresh()` explicitly rebases private dirty edits after a lifecycle
  revision change in the same session/workspace/cwd. A separate context generation
  rejects replay after switch/shutdown/cwd changes, including switching away and
  back. Ordinary `set`, `preview`, `apply` and `forScope` still reject stale drafts.
- `await draft.preview()` validates the sparse target itself and the complete
  candidate through `resolveConfig`, including all mount/workspace/socket policy.
  It returns masked changes, resulting effective TOML/provenance/warnings,
  `shadowed` paths still owned by higher layers, and `effect` (`none/live/restart`).
  `collections` separately describes upsert/remove versus explicit replace/clear/
  inherit, selected identities, original policy layer/path, intentional higher-
  scope promotion, and shadowing. It never contains credential values. A deletion
  absent in the chosen scope can be a no-op while still reported as shadowed if
  that identity survives in a higher layer.
- `await draft.apply()` revalidates, commits to memory or atomically replaces the
  chosen file, and returns the preview plus `saved` and **runtimeApplied: false**.
  No-op applies do not write or invalidate drafts. Successful changed applies
  close that draft and invalidate older drafts; reopen before further editing.
  `discard()` closes the draft and clears retained raw/secret draft data.

Only target raw data and deliberate edits are serialized. Scalars stay sparse.
Entry CRUD may materialize the selected scope's baseline collection because host
arrays remain authoritative, but **never materializes unrelated higher-scope
entries**. No array-union or raw configuration precedence semantics were changed.
A specifically selected higher-scope secret/mount/list entry may be intentionally
saved globally: confirmation must name its identity and policy origin and warn
that this broadens its scope. Metadata-only secret editing retains that selected
entry's private credential, not a different same-name target credential.

Unedited target-owned references retain their raw spelling. References inherited
from lower policies or deliberately imported from another scope are anchored to
their actual origin before persistence; `$ENV:NAME` remains a reference. New
relative FILE input originates beside the draft's policy file, or at session cwd
for temporary input. FILE paths are canonicalized when necessary, but credential
bytes are **never read/resolved for persistence**. Explicit whole-array `set`
means exactly the supplied replacement, does not preserve omitted target entries,
and is always distinguished from entry CRUD in confirmation. `[]` clears only the
chosen scope; higher layers can still shadow that clear.

TOML has no null: persistent `sandbox_name = null` is rejected; choose inherit or
an explicit string. Temporary null is supported. The existing limited TOML
reader is still authoritative: comments/layout are not preserved on a real save,
but unrelated parsed raw keys/values are. Deliberately edited authoritative
collections reconcile only conflicting same-scope merge-removal identities; the
preview lists those `remove_*` changes. Unrelated removal entries/controls are
preserved, and higher-layer removal policies still apply. Sparse scalar saves
never alter removal controls.

## Lifecycle/UI integration

`index.ts` calls `endSession()` on shutdown and identity replacement; the panel
closes and drains pending operations first. Historical session override entries
are ignored. Settings apply commits storage/memory; the panel then invokes
`control.reload()` to adopt effective settings. Native `control.previewSettings(draft)`
compares privately against adopted runtime configuration, not merely disk baseline;
`reload({ allowRestart: false })` refuses a newly discovered disruptive change,
so late external edits cannot silently turn a confirmed live apply into a restart. Save and runtime failures are
reported separately.

The guarded manager adopts routing/access-policy/footer and automatic-start
preference changes live. `auto_start` never stops an active guest or selects host
execution when edited. The panel uses one isolated private draft per operation;
apply or cancel resolves it before another edit. Lifecycle actions are separate.
Committed applies reopen a fresh baseline even when runtime activation fails.
Other effective changes force recreation after owner-lock and label checks,
even if inspected workspace/image labels still match. Restart confirmation is
conservative and warns about ephemeral guest/container loss. Reload waits for
active callbacks; it never executes tools on the host as error recovery. Configured
explicit host fallback remains an opt-in security decision. Runtime failure after
a successful save requires fixing the cause and retrying reload/reopening.

Only redacted TOML, masked snapshots and metadata cross into presentation state.
Never stringify `getEffectiveConfig()` or `editor.temporary()` in a frontend;
those internal resolver contracts can contain literal credentials. Secret inputs
are always empty initially, use a dedicated masked component, and clear on cancel,
keep/discard and teardown. Current configured secret bytes are redacted privately
before returning recent logs or prune diagnostic details; arbitrary application logs may still be sensitive.

## File safety and bounded guarantees

Targets come only from shared `hostConfigPaths`: host `default.toml` globally,
canonical project `projects/.../config.toml` or `projects-absolute/.../config.toml`.
Writes reject symlink targets/ancestors, dangling links, nonregular files, mounted
workspace locations, and policy exposure through writable mounts. Every candidate
is validated before any write or temporary mutation. Changed saves use exclusive
0600 same-directory temporary files, 0700 new directories, file sync, atomic rename
and directory sync; failed temporary files are removed. Unrelated existing
ancestor-directory permissions are not changed.

Target inode/content/metadata and ancestor inode checks detect ordinary external
edits/replacement. Guarding and revalidation are repeated immediately before
rename. Portable Node filesystem APIs do **not** provide an atomic compare-and-swap
rename or openat-style ancestor pinning: a hostile host process racing directories
or another editor's final rename window is outside the complete guarantee. This
is not a replacement for host-owned, workspace-inaccessible policy directories.
Only the target has an external-edit fingerprint; other layers are re-read and
validated at commit rather than locked. Filesystem errors after atomic replacement
(e.g. directory sync) may mean the file was saved despite an error: reload/reopen
before retrying. Runtime is not mutated by the settings editor in that case.
