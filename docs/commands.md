# The `/msb` control room

[Back to README](../README.md) · [Agent recipes](agent-recipes.md)

Type **`/msb`** in interactive Pi to open the full-screen panel. Opening it
neither saves settings nor starts a VM. All trees begin collapsed, with
**Resources** selected. Explore first. Twiddle knobs second.

The panel requires a terminal TUI; it isn't available in headless, print, or RPC
mode. Agent inspection works headlessly, and agent changes can use an interactive
TUI/RPC approval UI. Those are separate [tools](tools.md), not `/msb` subcommands.
Old commands such as `/msb on` and `/msb set` are no longer accepted.

## Where everything lives

| Tree | What's inside |
| --- | --- |
| **Resources** | CPUs and RAM |
| **Network** | Mode, destination rules, DNS, published ports |
| **Secrets** | Destination-scoped credentials and their sources |
| **Variables** | Host environment variables to forward |
| **Mounts** | Extra directories, files, named volumes, or tmpfs |
| **Tools** | Third-party blocking, routing, pass-throughs, host execution |
| **Image** | Image reference and pull policy |
| **Sources** | Committed origins, inheritance diagnostics, warnings |
| **Actions** | Enable/off, reload, reset Session overrides, logs, prune, help |
| **Status** | Read-only `[runtime]` information, identity, adoption, Docker readiness |
| **General** | General preferences |
| **Advanced** | Timeouts, bootstrap, fallback, skill-read policy, session environment, and other advanced settings |

Settings describe **desired policy** and show where committed values came from.
Mixed collections show entry origins. **Status is not another copy of the
settings**: it records known runtime information. A reconnected VM can show
“VM instance not verified”; don't mistake desired values for live measurements.
Inactive snapshots are last-known, not running. A cancelled proposal or failed
activation doesn't advance the successful-adoption timestamp.

## Your keyboard cheat sheet

These keys apply while browsing, not while typing into a field:

| Key | Action |
| --- | --- |
| `j` / down, `k` / up | Next / previous visible row |
| `l` / right | Expand, or enter the first child |
| `h` / left | Collapse, or move to the parent |
| Enter / `e` | Edit; Enter also expands groups or activates actions |
| `a` | Add an entry to the selected collection |
| `d` | Delete an entry, or inherit a scalar at the chosen scope |
| Tab / Shift-Tab | Move between rows/controls, skipping long text |
| PageDown / PageUp | Scroll a long selected row |
| Esc | Back/cancel; close from the tree |
| `q` | Close from non-input screens; confirm if discarding a proposal |

The bottom hint line follows your selection. Editors show format examples;
letters are ordinary text while typing, including pasted text. Enter accepts a
field, Esc cancels. If you try to close an edited form, **Cancel** is the default
at the discard prompt. Cancel returns to your proposal rather than applying it.
Long diagnostics/results are scrollable; Enter opens the full result.

## Apply scopes

Each scalar edit or entry operation offers:

- **Session:** memory-only, above Project and Global. Panel Session edits require
  a running sandbox and cannot silently boot one. Cleared on Pi `/reload`,
  session/workspace switch, or shutdown; not restored on resume.
- **Project:** approve the shared main/root record from Git main, linked and nested
  cwd: No / Apply shared Project. Current/future registered worktrees adopt it on
  reload/start. No checkout-only destination exists. Non-Git/unsupported layouts
  save a cwd-local sparse override.
- **Global:** save a sparse baseline in host-owned `default.toml`.
- **Cancel:** discard the proposal without changing storage or runtime.

Ordinary settings reload preserves Session overrides. Once they reset, inherited
settings return and can be more permissive. Persist lasting restrictions deliberately.
[Locations and precedence →](configuration.md#host-owned-project-overrides)

Apply automatically reloads **this sandbox**, waiting for idle and asking for
meaningful restart/security confirmation. Other sessions adopt saved defaults on
their next start/reload. Higher overrides are not silently cleared. After a
successful apply, **Quit** is selected; Enter closes the panel, not the VM.
Choose **Back** to keep exploring.

### Entries, inheritance, and private sources

`d` on a scalar removes that scope's assignment so it can inherit. On an entry,
it removes that entry. Collection parents have no bulk-clear/inherit action;
use agent tools or host files for explicit whole-list operations.

Entry edits preserve unrelated scope-owned entries, including hidden ones. They
don't flatten inherited settings or copy unrelated credentials into a lower
scope. Deliberately importing a higher-scope entry is called out in review,
because it can make a permission or credential available more broadly.

Secret and mount forms keep their fields together. Secret source fields are
masked and **never prefilled**. Leaving a source replacement blank keeps the
private source; cancellation clears secret buffers. Agent inspection differs:
it can see host variable names and command text, but not credential values.

### Read the result, not just the button

Resources, images, network, secrets, mounts, environment, and lifecycle settings
may recreate the VM. That loses guest-local files, containers, and caches—not
writes already made to host files. Routing, footer, access policy, and
`auto_start` preferences adopt live. `auto_start = false` doesn't stop a running
VM or enable host tools.

Host execution, pass-throughs, fallback, writable mounts, skill-read policy, and
more permissive inheritance deserve careful review. Allowed third-party tools
run outside the VM without per-call host approval.

A setting can be **saved but not activated**. The panel keeps the prior adoption
snapshot last-known and stays editable after failure; it doesn't silently enable
host execution. Fix the cause and use **Actions → Reload settings**. External
file changes can invalidate a proposal; cancel and reopen rather than blindly
retrying. Changed saves preserve unknown keys but not comments/layout; no-ops do
not touch files. [Detailed save guarantees →](settings-backend.md#file-safety-and-bounded-guarantees)

## Actions: the big switches

- **Enable sandbox:** start/re-enable using current desired settings.
- **Turn off (HOST execution):** explicitly stop/remove the guest and hand tools
  to the unsandboxed host after confirmation. This is not a troubleshooting shortcut.
- **Reload settings:** re-read external policy and reconcile runtime; preserves
  Session overrides. Normal applied edits already do this.
- **Reset Session overrides:** clear only committed memory overrides, then
  reconcile after confirmation. Project/Global files stay unchanged; inherited
  policy may be broader.
- **Recent logs / effective configuration:** redacted diagnostic views. Log tail
  defaults to 100; display caps at 2000 lines and reports truncation. Review logs
  before sharing—unrelated application secrets may still appear.
- **Seal network:** apply the network restriction through scope actions.
- **Prune stale sandboxes:** remove eligible stale managed sandboxes, preserving
  live owners/current session. Never deletes host files or legacy named volumes.

Dangerous lifecycle actions confirm and wait for idle. Failed startup reports a
safe stage/error class rather than raw credential-bearing exceptions. For
recovery while ordinary tools are blocked, ask your agent for
[`msb_diagnostics`](troubleshooting.md).
