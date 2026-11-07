# Settings backend integration contract

This is the backend seam used by the full-screen `/msb` control panel and the
[model-facing configuration tools](tools.md). All modules remain flat and ship with
the existing package manifest. No SDK import, configuration creation, or write
occurs when constructing the editor.

## Module boundaries

- `settings.ts` owns private drafts, candidate resolution and guarded commits. Its
  existing exports for leaf inventory, collection removals, effect classification,
  live keys and `SettingsConflictError` remain compatibility reexports.
- `settings-metadata.ts` owns the leaf inventory (derived from `DEFAULT_CONFIG`),
  collection-removal mapping and single schema version shared by discovery and
  inspection. JSON projection, fields, schema and validation do not import the
  editor; the editor can consume the JSON projection without a value-import cycle.
- `settings-effect.ts` is the shared runtime change policy. It imports only Config
  types, so the sandbox manager does not load the filesystem editor or resolver
  for classification. `settings-conflict.ts` provides shared error identity.
- Internal `settings-storage.ts` owns source fingerprints, ancestor anchors and
  guarded atomic replacement, retaining the existing checks, permissions and
  ordering. Candidate validation, workspace boundaries and approval guards stay
  with the editor; this is not a general repository storage API.
- `settings-presentation.ts` contains display sanitization and scope aliases only.
  The panel reexports them for compatibility; diff/inspection helpers consume the
  small module directly rather than loading the interactive panel.

Tool and native-panel transaction workflows remain separate, including their
intentional approval, review and reload differences.

## Entry points

- Native `MsbControl.settings` exposes a `SettingsEditor` (optional only to keep
  injected/third-party control adapters compatible). Construct one per integration,
  never one per screen. The internal `temporary` layer is the public **Session**
  scope, not a fourth scope. `MsbIntegration.endSession()` clears it.
- `SETTINGS_PATHS` enumerates every public schema leaf in TOML spelling. `network`
  and `docker` are individual leaf fields; arrays are complete collections.
- `await editor.open("temporary" | "project" | "global")` captures raw target
  data, the effective baseline, and a draft revision. No file is created.
- `draft.set(path, value)` marks exactly one schema leaf dirty. For arrays this
  is an **explicit whole-list replacement** (`[]` is an explicit clear), not CRUD.
  `inherit(path)` removes that target-layer assignment, distinct from `[]` or `""`.
  Snake/camel names work; values use the existing normalized Config shapes.
- `draft.upsertSecret({env, allowHosts, textValue?, hostEnv?, hostCmd?}, previousEnv?)`
  accepts exactly one source for a new secret. Omitting all source fields retains
  the selected entry's private source, including prior pending replacements.
  Supplying a source replaces the previous source rather than combining them. `removeSecret(env)` records deletion of that identity.
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
  Literal `textValue` credentials are masked in snapshots/diffs and agent JSON.
  `hostEnv` names and `hostCmd` text are readable agent metadata; effective TOML
  still masks all source fields. Never feed masked values back into `set`.
  Native editor APIs support literals; the agent setter rejects `textValue`.
- `await draft.forScope(scope)` transfers dirty scalar fields and **entry intent**,
  not an effective collection snapshot. On preview/apply, entry operations replay
  over the chosen scope's at-or-below-scope baseline: Global excludes Project/Session;
  Project excludes Session; Session includes the current effective settings.
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
saved globally: the sanitized review must name its identity and policy origin and
retain a warning that this broadens its scope. The panel displays warnings in its
review; configuration tools return relevant warnings to the agent after completion
rather than showing warning lines in their confirmation dialog. Metadata-only
secret editing retains that selected entry's private credential, not a different same-name target credential.

Secret sources retain their raw spelling across scopes. `textValue` is always
literal; `hostEnv` names a host variable and `hostCmd` specifies a host shell
command. Credential bytes are **never read/resolved for persistence**, and host
commands are never executed for inspection, validation, preview or saving.
Explicit whole-array `set` means exactly the supplied replacement, does not
preserve omitted target entries, and is always distinguished from entry CRUD in
confirmation. `[]` clears only the chosen scope; higher layers can still shadow
that clear.

TOML has no null: persistent `sandbox_name = null` is rejected; choose inherit or
an explicit string. Session null is supported. The existing limited TOML
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
is validated before any write or Session mutation. Changed saves use exclusive
0600 same-directory temporary files, 0700 new directories, file sync, atomic rename
and directory sync; failed temporary files are removed. Unrelated existing
ancestor-directory permissions are not changed.

Target inode/content/metadata and ancestor inode checks detect ordinary external
edits/replacement. Guarding and revalidation are repeated immediately before
rename. Portable Node filesystem APIs do **not** provide an atomic compare-and-swap
rename or openat-style ancestor pinning: a hostile host process racing directories
or another editor's final rename window is outside the complete guarantee. This
is not a replacement for host-owned, workspace-inaccessible policy directories.
For ordinary, unbound `draft.apply()`, only the target has an external-edit
fingerprint; other layers are re-read and validated at commit rather than locked.
Approval-bound tool commits additionally guard all contributing sources as described
below. Filesystem errors after atomic replacement
(e.g. directory sync) may mean the file was saved despite an error: reload/reopen
before retrying. Runtime is not mutated by the settings editor in that case.

## Passive diagnostics and blocked-state recovery

`msb_diagnostics` uses the native control facade's cached, sanitized diagnostic
snapshot of allowlisted enums, booleans, counts and constrained host versions.
Arbitrary error/configuration strings are withheld, even if they appear redactable.
Its invocation does not call the settings inspector (which fingerprints
sources/environment), load the SDK, resolve credentials, read logs, execute host
commands, or perform lifecycle operations. Runtime and desired/adopted information
is explicitly last-known; missing redaction context produces a generic failure
rather than raw error text. Output is bounded in both presentation and structured
results. Registration is unconditional and the third-party gate grants only the
exact tool name with this extension's verified entry provenance.

Blocked runtime state does not disable configuration inspection or approved
settings changes. Invalid configuration inspection exposes degraded `recovery`
metadata instead of claiming defaults are a valid desired policy. Supported
semantic repairs retain the original raw scope source for truthful review and
source/anchor guards, validate the complete final layered candidate, and use the
normal approval-bound atomic commit. A recovery review additionally discloses the
complete newly activated safety policy, including read-only mounts, environment
forwarding, next-session host mode, network, and secret destinations. Private
`draft.hostCommandsForApproval()` binds exact final host command source to that
same review and supplies only the human command appendix; never serialize it.
Masked critical policy or an oversized review fails closed. Invalid syntax or unknown workspace identity
cannot be repaired by silently dropping/overwriting source data. Activation stays
separate: an already saved repair can still report `saved_but_reload_failed`.

## Agent-safe inspection and approval-bound commits

The model-facing getter adds static `settings-schema.ts` discovery (value schemas,
constraints, operations/scopes, batch capabilities and network semantics) and
network policy summaries computed **only from agent-safe inspection/adoption
projections**. Desired and last-known adopted policy remain separate; unknown
adopted network state stays null. No SDK is imported or credential resolved for
this metadata. `network-domains.ts` defines the common exact-domain format,
secret-only leading `*.` wildcard scopes, and network-only IP/CIDR inputs.
`settings-inspection.ts` applies section/path filters after that boundary and
renders readable text/indented JSON while keeping selected structured details.
Filters never authorize new reads, field/index paths or mutations. Static schema
caching uses the caller's version, not transcript state. Safe validation diagnostics
use whitelisted issue prefixes, static expected schemas and operation indices;
unattributable source/dynamic failures remain generic, with no raw error echo.

The setter accepts a single operation or 1–64 ordered operations in one explicit
scope. Each request owns one draft and modal lease: apply every operation, validate
and review the final candidate once, bind one approval to all changes, commit once,
then reload at most once. No intermediate candidate is persisted/adopted. Batch
requests retain the same stale-source/session/runtime guards, masked review,
sparse persistence, native collection intent and save-versus-activation outcomes.
This does not make persistence and VM activation a distributed transaction or
remove the bounded filesystem guarantees above.

`editor.inspect(runtime?, privateSources?)` reads each contributing policy once,
returns all supported effective settings, sparse Global/Project/Session layers (`layers.global`, `.project`, `.session`),
origins and warnings as JSON, and does not bootstrap/write/reload. `settings-json.ts`
whitelists schema fields and omits arbitrary unknown raw values. The dependency-free
`settings-redaction.ts` masks literal credentials (and deprecated `value` inputs),
including repeated occurrences in metadata. Host environment source names and
host commands are readable; resolved credential bytes never enter inspection.

`draft.reviewForApproval(effect)` binds the draft's private intent and resolved
candidate digest (including proposed mount canonical identities) to every source
content/identity/metadata fingerprint, resolver/environment state, and editor
revision captured at open. It returns a strict masked JSON before/after review.
`apply({guard})` rechecks that binding and caller abort/session/runtime conditions
through the existing atomic-write guards; stale approval conflicts without retry.
Successful approved applies return a private `assertUnchanged` activation guard.
Pass it through native `reload({allowRestart, guard})`, which checks before/after
resolution and preserves the established settings context without configuration
writes. This prevents adopting newly changed unreviewed live policy after saving. Disabled
environment reloads fail explicitly for this guarded path. Ordinary panel/reload
behavior is unchanged. Portable final rename races remain subject to the bounded
filesystem guarantees above; target metadata necessarily changes on our save,
while its exact expected content and all other source metadata remain guarded.

`editor.acquireInteraction()` is the shared integration-local panel/tool modal
lease. Competing callers fail busy; release it in finally. Session lifecycle
invalidates its AbortSignal. `settings-approval.ts` uses Pi's public native
No/Yes selector in TUI and RPC, with No selected by default. There is no custom
pagination or read-to-end gate; Pi controls presentation of the complete masked
diff and nonwarning context, and long questions may exceed the visible terminal.
Only semantic warning lines are filtered from tool approval and human setter
results; the orange scope name is retained. Warning generation and sanitized
review metadata are unchanged. Setter model-visible plain text includes relevant
warnings for applied/no-op and saved-but-reload-failed outcomes, with saved versus
activated status explicit. The agent is instructed to explain these warnings to
the user after completion. Getter inspection diagnostics are unchanged.
Proposed host commands have a JSON-quoted appendix in the human approval question.
This executable code must be visible to the human; the source command text is
also readable agent metadata. Literal credentials remain masked. The complete
question remains size-bounded.
No ordinary panel conditional-confirmation path authorizes tool mutations.

Secret upsert with all source fields omitted prefers the selected effective
identity. If absent there, it can retain only a target-owned hidden raw identity,
with truthful origin and shadowing metadata.
Earlier removal/clear/replacement/inheritance prevents fallback resurrection.
This fallback never selects unrelated scope credentials or promotes siblings.

Privacy context is captured from all original contributing raw files, parsed
`PI_MSB_*` settings, raw CLI settings and internal temporary/resolved layers, including
credentials shadowed by higher scopes. The optional internal second argument of
`resolveConfig` receives only a bound sanitizer after successful resolution; it
adds no reads or credential resolution and returns no raw layers. Read views bind
that sanitizer to the same revision/source snapshot as inspection and approval.
Adopted metadata is assembled before the review's final sanitization.

Native `getAgentRuntimePolicy()` returns a separate already-safe JSON projection
frozen at successful adoption using that request's private resolution context.
Failed/proposed resolutions do not replace it, and later desired-source changes
cannot remove its historical masking context. Existing `getRuntimePolicy()` and
panel metadata remain unchanged. Agent tools never reconstruct safety from the
older value-masked TOML snapshot; adapters without the safe accessor report
adopted values unavailable. No sanitizer closure/private context crosses an
agent result, error or log boundary.
