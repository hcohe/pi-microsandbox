import { visibleWidth, matchesKey, decodeKittyPrintable, isKeyRelease, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { ConfigError, DEFAULT_CONFIG, normalizeConfigPath, parseTomlConfig } from "./config.ts";
import { SettingsInput } from "./settings-input.ts";
import { MaskedInput } from "./masked-input.ts";
import { SECTIONS, SETTINGS_FIELDS, valueAt, SECRET_HOST_HELP, MOUNT_OPTION_HELP, type FieldHelp, type SettingsField } from "./settings-fields.ts";
import type { SettingsDraft, SettingsScope } from "./settings.ts";
import type { MsbControl, Config } from "./types.ts";

type Context = Pick<ExtensionCommandContext, "ui" | "waitForIdle">;
type Row = { id: string; label: string; detail?: string; instructions?: string; action?: () => void | Promise<void>; parent?: string; depth?: number; children?: Row[]; value?: string; origin?: string; button?: boolean; disabled?: boolean; edit?: () => void | Promise<void>; add?: () => void | Promise<void>; remove?: () => void | Promise<void>; removeLabel?: string; readonly?: boolean };
type FormField = FieldHelp & { name: string; value: string; secret?: boolean; choices?: string[] };
const originLabel = (source: string): string => ({ "host-default": "global", "host-project": "project", temporary: "ephemeral", env: "environment", defaults: "default" }[source] ?? source);
const fieldLabel = (path: string): string => ({ cpus: "Virtual CPUs", memory_mib: "Memory (MiB)", image: "Guest image", sandbox_name: "Sandbox name", "network.allow_hosts": "Allowed hosts", "network.mode": "Network mode", "docker.mode": "Docker mode" }[path] ?? path.split(".").pop()!.split("_").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" "));
/** Strip terminal controls from every external label, log, path and value. */
export const safeText = (value: unknown): string => String(value ?? "").replace(/\x1b\][^\x07]*(?:\x07|$)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\p{Cc}\p{Cf}]/gu, " ");
const display = (value: unknown): string => value === null ? "automatic session name" : value === undefined ? "inherit" : typeof value === "string" ? value : JSON.stringify(value);
const HOST_BOUNDARY_WARNINGS: Readonly<Record<string, string>> = {
  pass_through_tools: "HOST execution / sandbox bypass: tools allowed by pass_through_tools execute on the HOST outside the sandbox without per-call host approval.",
  block_third_party: "HOST execution / sandbox bypass: block_third_party = false allows unrecognized third-party tools to execute on the HOST outside the sandbox without per-call host approval.",
  allow_skill_reads: "HOST read / sandbox bypass: allow_skill_reads = true permits constrained reads of discovered skills and generated prompts from the HOST outside the sandbox.",
  allow_host_execution: "HOST execution: allow_host_execution = true permits explicit execution outside the sandbox after individual tool-call approval.",
  fallback_mode: "HOST execution / sandbox bypass: fallback_mode = host permits unsandboxed HOST tools after sandbox failure.",
};
function displayConfig(toml: string) {
  const value = parseTomlConfig(toml, "global").value;
  return { ...value, ...(value.secrets ? { secrets: value.secrets.map((secret) => ({ env: secret.env, allowHosts: secret.allowHosts, value: "<redacted>" })) } : {}) };
}

/** Stable tree identities share a bounded viewport with transient editors and confirmations. */
export class ControlPanel implements Component, Focusable {
  focused = true;
  #draft: SettingsDraft;
  #pending?: SettingsDraft;
  #control: MsbControl;
  #ctx: Context;
  #tui: Pick<TUI, "terminal" | "requestRender">;
  #theme: Pick<Theme, "fg" | "bold" | "inverse">;
  #done: () => void;
  #tree = true;
  #treeFocus = "configuration/General";
  #expanded = new Set<string>();
  #rows: Row[] = [];
  #focus = 0;
  #scroll = 0;
  #detailOffset = 0;
  #rowHeights: number[] = [];
  #capacity = 1;
  #baselineReady = true;
  #proposal = false;
  #proposalTree?: { focus: string; expanded: Set<string> };
  #busy = false;
  #operation: Promise<void> = Promise.resolve();
  #closed = false;
  #feedback?: string;
  #values: any;
  #provenance: Record<string, string>;
  #paths: Record<string, string>;
  #warnings: string[];
  #scalarIntent = new Map<string, unknown>();
  #editing?: { input: SettingsInput | MaskedInput; accept: (value: string) => void | Promise<void>; cancel: () => void; label: string; editorHelp: string };
  #back?: () => void | Promise<void>;
  #formCleanup?: () => void;
  #formDirty = false;
  #exitConfirmation = false;

  constructor(options: { draft: SettingsDraft; control: MsbControl; ctx: Context; tui: Pick<TUI, "terminal" | "requestRender">; theme: Pick<Theme, "fg" | "bold" | "inverse">; done: () => void; paths: Record<string, string> }) {
    this.#draft = options.draft; this.#control = options.control; this.#ctx = options.ctx; this.#tui = options.tui; this.#theme = options.theme; this.#done = options.done; this.#paths = options.paths;
    const snapshot = this.#draft.snapshot();
    // Mask references too; only private backend entry edits retain credential origins.
    this.#values = displayConfig(snapshot.effectiveToml);
    if (snapshot.automaticSandboxName) this.#values.sandboxName = null;
    this.#provenance = snapshot.provenance; this.#warnings = snapshot.warnings;
    this.#home();
  }
  invalidate(): void {}
  #refresh(): void { if (!this.#closed) this.#tui.requestRender(); }
  #page(rows: Row[], back?: () => void | Promise<void>): void { if (this.#closed) return; this.#tree = false; this.#rows = rows; this.#focus = 0; this.#scroll = 0; this.#detailOffset = 0; this.#back = back; this.#refresh(); }
  #rowValue(path: string): unknown { return valueAt(this.#values, path); }
  async #propose(mutate: (draft: SettingsDraft) => void, scope?: SettingsScope): Promise<void> {
    if (!this.#baselineReady) { this.#report("Settings unavailable. Repair host configuration, then Reload or reopen before editing."); return; }
    // The root owns a clean private baseline. Resolve this one intent before another edit.
    this.#scalarIntent.clear();
    this.#proposalTree = { focus: this.#treeFocus, expanded: new Set(this.#expanded) };
    this.#proposal = true;
    try { mutate(this.#draft); }
    catch { this.#formCleanup?.(); this.#proposalError("Invalid entry. Cancel to correct required names, hosts, references and field types.", false); return; }
    this.#formCleanup?.();
    if (scope) await this.#applyScope(scope); else this.#scopeActions();
  }
  #set(path: string, value: unknown): Promise<void> {
    return this.#propose((draft) => { draft.set(path, value); this.#scalarIntent.set(path, value); });
  }
  #inherit(path: string): Promise<void> {
    return this.#propose((draft) => { draft.inherit(path); this.#scalarIntent.set(path, undefined); });
  }
  async #cancelProposal(): Promise<void> {
    this.#pending?.discard(); this.#pending = undefined; this.#formCleanup?.();
    this.#proposal = false; this.#scalarIntent.clear();
    if (this.#proposalTree) { this.#treeFocus = this.#proposalTree.focus; this.#expanded = this.#proposalTree.expanded; this.#proposalTree = undefined; }
    try { await this.#reopenDraft(); this.#home(); }
    catch { this.#report("Settings refresh failed. Close and reopen after repairing host configuration. No proposal was applied."); }
  }
  #scopeRows(apply: (scope: SettingsScope) => void | Promise<void>): Row[] {
    const active = this.#control.getState().status === "active";
    return [
      { id: "apply-temporary", label: "Apply for current running sandbox only", button: true, disabled: !active, detail: active ? "Current integration session memory only; no disk writes." : "Unavailable: no running sandbox. Enable a sandbox first, or choose project/global defaults.", action: active ? () => apply("temporary") : undefined },
      { id: "apply-project", label: "Apply for all sandboxes in this project", button: true, detail: "Persist project defaults and reload this sandbox.", action: () => apply("project") },
      { id: "apply-global", label: "Apply for all sandboxes globally on this host", button: true, detail: "Persist host defaults and reload this sandbox.", action: () => apply("global") },
    ];
  }
  #scopeActions(): void {
    this.#page([
      { id: "proposal", label: "Apply change", detail: "Choose where this one change applies. Cancel leaves committed settings and runtime unchanged." },
      ...this.#scopeRows((scope) => this.#applyScope(scope)),
      { id: "cancel", label: "Cancel", button: true, action: () => this.#cancelProposal() },
    ], () => this.#cancelProposal());
    this.#focus = 1;
  }
  #proposalError(message: string, retry = true): void {
    this.#page([
      { id: "feedback", label: `Result: ${message}`, detail: retry ? "Cancel to correct the entry. Retry revalidates the same isolated change; nothing else is included." : "Cancel to correct the entry. No setting changes were applied." },
      ...(retry ? [{ id: "retry", label: "Retry", button: true, action: () => this.#scopeActions() }] : []),
      { id: "cancel", label: "Cancel", button: true, action: () => this.#cancelProposal() },
    ], () => this.#cancelProposal());
  }
  #home(refresh = true): void {
    if (this.#closed) return;
    this.#tree = true; this.#back = undefined;
    const state = this.#control.getState();
    const policy = this.#control.getRuntimePolicy?.();
    const runtimeValues = policy ? displayConfig(policy.effectiveToml) : undefined;
    if (runtimeValues && policy?.automaticSandboxName) runtimeValues.sandboxName = null;
    const fields = (root: string, values: any, provenance: Record<string, string>, readonly: boolean): Row[] => SECTIONS.filter((section) => SETTINGS_FIELDS.some((field) => field.section === section)).map((section) => ({
      id: `${root}/${section}`, label: section, children: SETTINGS_FIELDS.filter((field) => field.section === section).map((field) => {
        const path = field.path; const id = `${root}/${path}`;
        const value = readonly ? valueAt(values, path) : this.#rowValue(path);
        const collection = Array.isArray(valueAt(DEFAULT_CONFIG, path));
        const known = !readonly || policy?.knownFields.includes(normalizeConfigPath(path)[0] as keyof Config);
        const baseline = valueAt(values, path);
        const fallbackSource = collection && Array.isArray(baseline) && baseline.length === 0 ? "defaults" : collection ? "mixed / entry sources" : "unknown";
        const origin = !known ? "unverified" : originLabel(provenance[normalizeConfigPath(path).join(".")] ?? fallbackSource);
        const edit = readonly ? undefined : () => this.#field(field);
        const add = readonly || !collection ? undefined : () => this.#addEntry(field);
        const row: Row = { id, label: fieldLabel(path), value: !known ? "unknown — not verified" : Array.isArray(value) ? `${value.length} entries` : display(value), origin, detail: field.hint, readonly, edit: collection ? undefined : edit, add, removeLabel: "inherit", remove: readonly || collection ? undefined : () => this.#inherit(path) };
        if (collection && known) {
          row.children = (Array.isArray(value) ? value : []).map((entry: any) => {
            const identity = path === "secrets" ? entry.env : path === "mounts" ? entry.guestPath : String(entry);
            const entryId = `${id}/${identity}`;
            const entryOrigin = originLabel(provenance[`${path}[${identity}]`] ?? provenance[normalizeConfigPath(path).join(".")] ?? "inherited / unknown");
            const editEntry = readonly ? undefined : () => this.#editEntry(field, entry);
            const remove = readonly ? undefined : () => this.#removeEntry(field, entry);
            const result: Row = { id: entryId, label: String(identity), value: path === "secrets" ? "********" : path === "mounts" ? entry.readonly ? "ro" : "rw" : undefined, origin: entryOrigin, readonly, edit: editEntry, add, remove, removeLabel: "delete" };
            if (path === "secrets" || path === "mounts") {
              const children = path === "secrets" ? { "Environment name": entry.env, "Allowed hosts": entry.allowHosts, "Value / reference": "********" } : { Type: entry.type, "Host path / volume name": entry.hostPath ?? "memory", "Guest path": entry.guestPath, "Read only": entry.readonly, Options: entry.options ?? [] };
              result.children = Object.entries(children).map(([label, value]) => {
                const childId = `${entryId}/${label}`;
                const listAdd = readonly ? undefined : () => this.#recordList(path, entry, label);
                return { id: childId, label, value: Array.isArray(value) ? `${value.length} entries` : display(value), origin: entryOrigin, readonly, edit: readonly ? undefined : () => this.#editEntry(field, entry, label), add: Array.isArray(value) ? listAdd : add,
                  ...(Array.isArray(value) ? { children: value.map((item: string) => ({ id: `${childId}/${item}`, label: item, readonly, origin: entryOrigin, edit: readonly ? undefined : () => this.#recordList(path, entry, label, item), add: listAdd, remove: readonly ? undefined : () => this.#recordList(path, entry, label, item, true), removeLabel: "delete" })) } : {}),
                };
              });
            }
            return result;
          });
        }
        return row;
      }),
    }));
    const statusRow = (id: string, label: string, value?: string, detail?: string): Row => ({ id: `configuration/status/${id}`, label, value, detail, origin: "runtime", readonly: true });
    const status: Row = { id: "configuration/status", label: "Status", readonly: true, children: [
      statusRow("state", "State", state.status, state.reason),
      ...((this.#baselineReady && policy && SETTINGS_FIELDS.some((field) => policy.knownFields.includes(normalizeConfigPath(field.path)[0] as keyof Config) && JSON.stringify(valueAt(this.#values, field.path)) !== JSON.stringify(valueAt(runtimeValues, field.path)))) ? [statusRow("pending", "Desired changes pending (not running)")] : []),
      statusRow("adoption", policy ? state.status === "active" ? "Actually adopted policy" : "Last known policy (not running)" : this.#control.getRuntimePolicy ? "No running policy adopted" : "Policy snapshot unavailable", policy ? new Date(policy.adoptedAt).toISOString() : "No current policy"),
      ...(policy?.verification === "reconnected" ? [statusRow("verification", "VM instance not verified", "Existing/reconnected guest: image and other VM settings are unverified.")] : []),
      ...(state.info ? [
        ...(["name", "displayId", "pid", "cwd", "root", "createdAt"] as const).map((key) => statusRow(`info/${key}`, key, display(state.info![key]))),
        ...(["readiness", "version", "storageDriver", "reason"] as const).filter((key) => state.info!.docker[key] !== undefined).map((key) => statusRow(`docker/${key}`, `Docker ${key}`, display(state.info!.docker[key]))),
      ] : []),
    ] };
    const roots: Row[] = [
      ...(this.#baselineReady ? fields("configuration", this.#values, this.#provenance, false) : [{ id: "settings-unavailable", label: "Settings unavailable", detail: "Last apply result remains valid. Repair host configuration, then Reload or reopen before editing." }]),
      status,
      { id: "configuration/sources", label: "Sources & warnings", children: [
        ...Object.entries(this.#paths).map(([scope, path]) => ({ id: `source/${scope}`, label: `${originLabel(scope)} target`, value: path })),
        { id: "precedence", label: "Inheritance", value: "default → environment → global → project → ephemeral", detail: "Each change is applied or canceled before another edit. Arrays replace lower lists; entry edits preserve scope isolation. Host worktree is read/write." },
        ...this.#warnings.map((warning, index) => ({ id: `warning/${index}`, label: "Warning", value: warning })),
      ] },
      { id: "configuration/actions", label: "Actions", children: [ ...(this.#feedback ? [this.#feedbackRow()] : []), ...this.#actions()] },
    ];
    const rows: Row[] = [];
    const flatten = (node: Row, parent?: string, depth = 0) => { node.parent = parent; node.depth = depth; rows.push(node); if (node.children && this.#expanded.has(node.id)) for (const child of node.children) flatten(child, node.id, depth + 1); };
    for (const root of roots) flatten(root);
    this.#rows = rows;
    let index = rows.findIndex((row) => row.id === this.#treeFocus);
    while (index < 0 && this.#treeFocus.includes("/")) { this.#treeFocus = this.#treeFocus.slice(0, this.#treeFocus.lastIndexOf("/")); index = rows.findIndex((row) => row.id === this.#treeFocus); }
    this.#focus = Math.max(0, index); this.#treeFocus = rows[this.#focus]!.id;
    if (refresh) this.#refresh();
  }
  #owner(path: string): string { return originLabel(this.#provenance[normalizeConfigPath(path).join(".")] ?? "mixed / entry sources"); }
  #field(field: SettingsField): void {
    const value = this.#rowValue(field.path) ?? valueAt(DEFAULT_CONFIG, field.path);
    const set = (next: unknown) => this.#set(field.path, next);
    const input = () => this.#input(field.path, String(value ?? ""), false, field.editorHelp, (text) => set(typeof valueAt(DEFAULT_CONFIG, field.path) === "number" ? Number(text) : text));
    if (field.choices || field.path === "sandbox_name") this.#page([
      { id: "description", label: fieldLabel(field.path), detail: `${field.hint}. Source: ${this.#owner(field.path)}`, instructions: field.editorHelp },
      ...(field.choices ? field.choices.map((choice) => ({ id: String(choice), label: String(choice), instructions: field.choiceHelp![String(choice)]!, action: () => set(choice) })) : [
        { id: "automatic-name", label: "Automatic session name (ephemeral only)", instructions: "Keep a session-generated name without persisting it to project or global defaults.", action: () => set(null) },
        { id: "edit", label: "Edit value", instructions: "Enter a custom name, such as my-project, instead of a session-generated name.", action: input },
      ]),
      { id: "back", label: "Back", action: () => this.#home() },
    ], () => this.#home());
    else input();
  }
  #recordList(path: string, entry: any, label: string, previous?: string, remove = false): void | Promise<void> {
    const key = path === "secrets" ? "allowHosts" : "options";
    const apply = (value?: string) => this.#propose((draft) => {
      const items = [...(entry[key] ?? [])].filter((item) => item !== previous && item !== value);
      if (value !== undefined) items.push(value);
      const next = { ...entry, [key]: items };
      const identity = path === "secrets" ? entry.env : entry.guestPath;
      if (path === "secrets") draft.upsertSecret({ env: entry.env, allowHosts: items });
      else draft.upsertMount(next, identity);
      const parent = `configuration/${path}/${identity}/${label}`;
      this.#expanded.add(`configuration/${path}/${identity}`); this.#expanded.add(parent);
      this.#treeFocus = value === undefined ? parent : `${parent}/${value}`;
    });
    if (remove) return apply(); else this.#input(label, previous ?? "", false, path === "secrets" ? SECRET_HOST_HELP.itemHelp : MOUNT_OPTION_HELP.itemHelp, apply);
  }
  #addEntry(field: SettingsField): void { this.#editEntry(field); }
  #entryDone(path: string, identity: string, previous?: string): void {
    const old = `configuration/${path}/${previous ?? identity}`; const next = `configuration/${path}/${identity}`;
    for (const id of [...this.#expanded]) if (id === old || id.startsWith(`${old}/`)) { this.#expanded.delete(id); this.#expanded.add(next + id.slice(old.length)); }
    this.#expanded.add(`configuration/${path}`); this.#treeFocus = next;
  }
  #removeEntry(field: SettingsField, entry: any): Promise<void> {
    const path = field.path; const identity = path === "secrets" ? entry.env : path === "mounts" ? entry.guestPath : String(entry);
    return this.#propose((draft) => {
      if (path === "secrets") draft.removeSecret(identity);
      else if (path === "mounts") draft.removeMount(identity);
      else draft.removeListEntry(path, identity);
      this.#treeFocus = `configuration/${path}`;
    });
  }
  #editEntry(field: SettingsField, entry?: any, child?: string): void {
    if (field.path === "secrets") { this.#secret(entry, child); return; }
    if (field.path === "mounts") { this.#mount(entry, child); return; }
    this.#input(field.path, entry ?? "", false, field.editorHelp, (value) => this.#propose((draft) => {
      draft.upsertListEntry(field.path, value, entry);
      this.#entryDone(field.path, value, entry);
    }));
  }
  #secret(entry?: { env: string; allowHosts: string[] }, child?: string): void {
    this.#form("Secret (never displayed)", [
      { name: "Environment name", value: entry?.env ?? "", hint: "The variable your app reads", editorHelp: "Enter an environment variable name using letters, digits and underscores; do not start with a digit.\nExample: SERVICE_TOKEN\nProcess-control variable names are not allowed." },
      { name: "Allowed hosts", value: (entry?.allowHosts ?? []).join(", "), ...SECRET_HOST_HELP },
      { name: "Replace value / reference", value: "", secret: true, hint: entry ? "Keep or replace the private value" : "A private value for your app", editorHelp: (entry ? "Leave blank to keep the existing secret and its original reference.\n" : "Enter a secret value or reference; input stays masked.\n") + "Reference syntax: $ENV:NAME or $FILE:/absolute/path (recommended).\nReferences are resolved privately; never paste credentials into help or logs." },
    ], (fields, scope) => this.#propose((draft) => {
      const env = fields[0]!.value; const allowHosts = fields[1]!.value.split(",").map((host) => host.trim()).filter(Boolean); const value = fields[2]!.value;
      draft.upsertSecret({ env, allowHosts, ...(value ? { value } : {}) }, entry?.env);
      this.#entryDone("secrets", env, entry?.env);
    }, scope), () => this.#home(), child === "Value / reference" ? "Replace value / reference" : child);
  }
  #mount(entry?: Config["mounts"][number], child?: string): void {
    this.#form("Mount", [
      { name: "Type", value: entry?.type ?? "dir", choices: ["dir", "file", "named", "tmpfs"], hint: "What kind of storage to attach", editorHelp: "Choose dir, file, named or tmpfs storage.\nFor example, dir shares a host directory; tmpfs uses temporary memory-backed storage.", choiceHelp: { dir: "Mount a host directory; Host path must be absolute.", file: "Mount a host file; Host path must be absolute.", named: "Use a named volume; enter its name instead of a host path.", tmpfs: "Create temporary memory-backed storage; leave Host path blank." } },
      { name: "Host path / volume name", value: entry?.hostPath ?? "", hint: "Where this storage comes from", editorHelp: "For dir/file, enter an absolute host path; for named, enter a volume name; for tmpfs, leave blank.\nExamples: /opt/shared-data or app-data\nHost sockets are blocked. Writable mounts must not expose host configuration or policy paths." },
      { name: "Guest path", value: entry?.guestPath ?? "", hint: "Where the sandbox sees this storage", editorHelp: "Enter an absolute guest path.\nExample: /mnt/data\nIt must not overlap the workspace, /tmp, protected guest system or Docker runtime paths, or another mount." },
      { name: "Read only", value: String(entry?.readonly ?? true), choices: ["true", "false"], hint: "Whether the sandbox can change files", editorHelp: "Choose true to prevent guest writes, or false to allow them.\nFor example, true is appropriate for shared reference data.", choiceHelp: { true: "Prevent guest writes through this mount.", false: "Permit writes; dir/file mounts let the guest change the actual HOST files. Writable policy exposure is blocked." } },
      { name: "Options", value: (entry?.options ?? []).join(", "), ...MOUNT_OPTION_HELP },
    ], (fields, scope) => this.#propose((draft) => {
      const mount = { type: fields[0]!.value as Config["mounts"][number]["type"], ...(fields[1]!.value ? { hostPath: fields[1]!.value } : {}), guestPath: fields[2]!.value, readonly: fields[3]!.value === "true", options: fields[4]!.value.split(",").map((option) => option.trim()).filter(Boolean) };
      draft.upsertMount(mount, entry?.guestPath); this.#entryDone("mounts", mount.guestPath, entry?.guestPath);
    }, scope), () => this.#home(), child);
  }
  #form(title: string, fields: FormField[], save: (fields: FormField[], scope: SettingsScope) => Promise<void>, back: () => void, selected?: string): void {
    const clear = () => { for (const field of fields) if (field.secret) field.value = ""; this.#formDirty = false; this.#formCleanup = undefined; };
    this.#formDirty = false; this.#formCleanup = clear;
    const show = () => this.#page([
      { id: "title", label: title },
      ...fields.map((field) => ({ id: field.name, label: `${field.name}: ${field.secret ? field.value ? "******** (replacement)" : "not replaced" : field.value}`, detail: field.hint, action: () => {
        if (field.choices) this.#page([
          { id: "title", label: field.name, instructions: field.editorHelp },
          ...field.choices.map((value) => ({ id: value, label: value, instructions: field.choiceHelp![value]!, action: () => { this.#formDirty ||= field.value !== value; field.value = value; show(); } })),
          { id: "back", label: "Back", action: show },
        ], show);
        else this.#input(field.name, field.secret ? "" : field.value, !!field.secret, field.editorHelp, (value) => { this.#formDirty ||= field.value !== value; field.value = value; show(); }, show);
      } })),
      ...this.#scopeRows((scope) => save(fields, scope)),
      { id: "cancel-item", label: "Cancel", button: true, action: () => { clear(); back(); } },
    ], () => { clear(); back(); });
    show();
    if (selected) this.#focus = Math.max(0, this.#rows.findIndex((row) => row.id === selected));
  }
  #input(label: string, value: string, secret: boolean, editorHelp: string, accept: (value: string) => void | Promise<void>, cancel = () => this.#home()): void {
    const input = secret ? new MaskedInput() : new SettingsInput();
    if (input instanceof SettingsInput) { input.setValue(safeText(value)); input.handleInput("\x1b[F"); }
    input.focused = this.focused;
    this.#editing = { input, label, editorHelp, accept, cancel }; this.#refresh();
  }
  #confirm(title: string, detail: string, action: () => void | Promise<void>, back: () => void | Promise<void> = () => this.#home()): void {
    this.#page([
      { id: "warning", label: title, instructions: detail },
      { id: "cancel", label: "Cancel", button: true, action: back },
      { id: "confirm", label: "Confirm", button: true, action },
    ], back);
    this.#focus = 1;
  }
  async #applyScope(scope: SettingsScope): Promise<void> {
    if (scope === "temporary" && this.#control.getState().status !== "active") { this.#proposalError("Current-only unavailable: no running sandbox. Choose project/global defaults or cancel."); return; }
    let target: SettingsDraft | undefined;
    if (scope !== "temporary" && this.#scalarIntent.has("sandbox_name") && this.#scalarIntent.get("sandbox_name") === null) {
      this.#proposalError("Automatic session naming is a current-session-only override. Choose current running sandbox, or cancel and inherit Sandbox name.");
      return;
    }
    try {
      target = await this.#draft.forScope(scope);
      if (this.#closed) { target.discard(); return; }
      const preview = await (this.#control.previewSettings?.(target) ?? target.preview());
      if (this.#closed) { target.discard(); return; }
      const entries = preview.collections.map((intent) => `${intent.operation.toUpperCase()} ${intent.path}[${intent.identities.join(", ") || "whole list"}]${intent.previousIdentity && intent.previousIdentity !== intent.identities[0] ? ` (was ${intent.previousIdentity})` : ""} from ${originLabel(intent.source)}${intent.sourcePath ? ` (${intent.sourcePath})` : ""}${intent.promoted ? ": DELIBERATE higher-scope import" : ""}${intent.shadowed ? ": shadowed; not effective here" : ""}`);
      const effective = displayConfig(preview.effectiveToml);
      const intentPaths = new Set([...this.#scalarIntent.keys(), ...preview.changes.map((change) => change.path), ...preview.collections.map((entry) => entry.path)]);
      const hostBoundaryWarnings = [...intentPaths].map((path) => HOST_BOUNDARY_WARNINGS[path]).filter((warning): warning is string => warning !== undefined);
      const summary = [
        ...hostBoundaryWarnings,
        ...(scope === "temporary" ? ["Current integration session memory only."] : [
          `Settings file: ${target.path}`,
          "Persist defaults; reload this sandbox only.",
          "Others pick up on next start/reload.",
        ]),
        ...preview.changes.map((change) => `${change.path}: ${change.operation === "inherit" ? "inherit → " : ""}${/secret/i.test(change.path) ? "<redacted>" : display(valueAt(effective, change.path))}`),
        ...entries.map((entry) => `Collection intent: ${entry}.`),
        preview.effect === "restart" ? "RESTART: guest ephemeral state and nested containers may be lost. In-flight tools must finish." : "Live routing/presentation update; no guest restart required.",
        ...(preview.shadowed.length ? [`Shadowed (NOT effective): ${preview.shadowed.join(", ")}.`] : []),
        "Conflicting same-scope removal controls shown in changed fields are reconciled.",
        "Host bypass/network/mount/environment settings can widen access.",
      ].map(safeText).join("\n");
      const pending = target; this.#pending = pending;
      const apply = async () => {
        let saved = false; let applied = false; let message = "";
        try {
          await this.#ctx.waitForIdle();
          if (this.#closed) return;
          if (scope === "temporary" && this.#control.getState().status !== "active") throw new Error("No running sandbox");
          const result = await pending.apply(); saved = result.saved; applied = true;
          if (this.#closed) return;
          await this.#control.reload({ allowRestart: preview.effect === "restart" });
          if (this.#closed) return;
          message = `${saved ? "Applied" : "No changes"}${result.shadowed.length ? `; shadowed: ${result.shadowed.join(", ")}` : ""}. Runtime: ${this.#control.getState().status}`;
        } catch { message = applied ? `${saved ? "Saved" : "Settings unchanged"}, but runtime failed. Review Status and retry Reload; no automatic host escape.` : "Apply failed. Check values, secret references, policy paths and external edits. Reopen to verify storage after an I/O error; no automatic host escape."; }
        finally {
          pending.discard(); this.#pending = undefined;
          if (!this.#closed) {
            if (applied) {
              this.#proposal = false; this.#proposalTree = undefined; this.#scalarIntent.clear();
              try { await this.#reopenDraft(); }
              catch { message += " Settings refresh failed; fix host configuration, then reopen the panel."; }
              if (!this.#closed) this.#report(message);
            } else this.#proposalError(message);
          }
        }
      };
      const needsConfirmation = hostBoundaryWarnings.length > 0 || preview.effect === "restart" || preview.collections.some((entry) => entry.promoted || entry.operation === "remove") || preview.shadowed.length > 0 || [...this.#scalarIntent.values()].includes(undefined) || preview.changes.some((change) => /network|mount|host|fallback|docker/.test(change.path));
      if (needsConfirmation) this.#confirm("Review change", summary, apply, () => this.#cancelProposal());
      else await apply();
    } catch { target?.discard(); this.#pending = undefined; this.#proposalError("Validation failed. Check types/ranges, required secret hosts, references and mount/host policy guards. Nothing applied."); }
  }
  #load(): void {
    const snapshot = this.#draft.snapshot(); this.#values = displayConfig(snapshot.effectiveToml);
    if (snapshot.automaticSandboxName) this.#values.sandboxName = null;
    this.#provenance = snapshot.provenance; this.#warnings = snapshot.warnings; this.#scalarIntent.clear(); this.#proposal = false; this.#baselineReady = true;
  }
  async #reopenDraft(): Promise<void> {
    // A failed refresh must not leave a consumed/canceled proposal usable by the next edit.
    this.#draft.discard(); this.#baselineReady = false;
    const fresh = await this.#control.settings!.open("temporary");
    if (this.#closed) { fresh.discard(); return; }
    this.#draft = fresh; this.#load();
  }
  #feedbackRow(): Row { return { id: "feedback", label: `Result: ${this.#feedback}`, detail: "Enter for full result; arrows scroll wrapped text.", action: () => this.#text("Operation result", this.#feedback!) }; }
  #report(message: string): void {
    if (this.#closed) return;
    this.#formCleanup?.(); this.#feedback = message;
    this.#page([this.#feedbackRow(), { id: "back", label: "Back", action: () => this.#home() }], () => this.#home());
  }
  #actions(): Row[] {
    const dangerous = (label: string, detail: string, run: () => Promise<unknown>): Row => ({ id: label, label, detail, action: () => this.#confirm(label, detail, async () => {
      let message = "";
      try {
        await this.#ctx.waitForIdle(); if (this.#closed) return;
        await run();
        const status = this.#control.getState().status;
        message = `${["unavailable", "host-fallback"].includes(status) ? "Action failed" : "Completed"}. Runtime: ${status}`;
      } catch { message = "Action failed. Review settings and sandbox status; no automatic host escape."; }
      finally {
        if (!this.#closed) {
          try { await this.#reopenDraft(); } catch { message += " Settings refresh failed; fix host configuration and retry Reload."; }
          if (!this.#closed) { this.#home(); this.#report(message); }
        }
      }
    }) });
    return [
      dangerous("Enable sandbox", "Boot using current validated settings. No implicit host fallback.", () => this.#control.setEnabled(true)),
      dangerous("Turn off (HOST execution)", "DANGER: stops/removes the sandbox. Routed tools execute on the HOST. Guest ephemeral state is lost.", () => this.#control.setEnabled(false)),
      dangerous("Reload settings", "Re-read host configuration/environment. Changed runtime settings recreate the guest and lose ephemeral state.", () => this.#control.reload()),
      { id: "prune", label: "Prune stale sandboxes", detail: "Remove only stale owned sandboxes, never host files or volumes.", action: () => this.#confirm("Prune stale sandboxes?", "Current session and live owners are kept. Host files and named volumes are not deleted.", async () => { await this.#ctx.waitForIdle(); if (this.#closed) return; const report = await this.#control.pruneNow(); this.#text("Prune result", `Inspected: ${report.inspected}\nRemoved: ${report.removed.join(", ")}\nKept: ${report.kept.join(", ")}\nErrors: ${report.errors.length}\n${report.errors.join("\n")}`); }) },
      { id: "logs", label: "Recent logs (redacted)", detail: "Choose a non-negative tail count; guest logs may contain sensitive application data.", action: () => this.#input("Log tail lines (non-negative integer)", "100", false, "Enter a non-negative integer for the number of recent log lines.\nExample: 100\nGuest logs may contain sensitive application data even when redacted.", async (value) => {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) { this.#report("Invalid log tail. Enter one non-negative safe integer."); return; }
        this.#text("Recent logs", await this.#control.getLogs(Number(value)));
      }) },
      { id: "config", label: "Effective configuration (redacted)", action: () => this.#text("Effective configuration", this.#control.getEffectiveConfigToml()) },
      { id: "seal", label: "Seal network", detail: "Set deny mode after choosing where it applies.", action: () => this.#set("network.mode", "deny") },
      dangerous("Reset current sandbox overrides", "Discard only current memory-only overrides; project/global defaults are unchanged. Reconfigure automatically. Restart may lose guest state.", async () => { try { await this.#control.resetOverrides(); } finally { if (!this.#closed) await this.#reopenDraft(); } }),
      { id: "help", label: "Help", action: () => this.#text("Using /msb", "General, Resources, Network, Secrets, Mounts, Advanced, Status, Sources & warnings and Actions start collapsed directly below MICROSANDBOX. Settings edit desired policy; Status shows read-only [runtime] metadata and adoption time (or last known when inactive), not a duplicate policy. j/k or arrows move; h/l collapse/parent or expand/child. e edits; a adds to collections; d removes an entry or inherits a scalar at the chosen scope. Each edit offers current running sandbox, project defaults, global defaults, or Cancel. Apply automatically reloads this sandbox; other sandboxes pick up defaults on next start/reload. Higher overrides may shadow changes. q closes (proposal discard defaults to cancel); in text inputs q is literal and Esc cancels. Entry edits never export unrelated credentials. Sources show committed origins. Host worktree is read/write. Restart loses guest state. Project/global policy stays outside the workspace.") },
    ];
  }
  #text(title: string, text: string): void {
    const lines = text.split(/\r?\n/);
    this.#page([
      { id: "title", label: title },
      ...lines.slice(0, 2000).map((line, index) => ({ id: `line:${index}`, label: line })),
      ...(lines.length > 2000 ? [{ id: "truncated", label: "Display capped at 2000 lines; choose a smaller log tail." }] : []),
      { id: "back", label: "Back", action: () => this.#home() },
    ], () => this.#home());
  }
  #exit(): void {
    if (this.#exitConfirmation) return;
    if (!this.#proposal && !this.#formDirty) { this.close(); return; }
    const previous = { rows: this.#rows, tree: this.#tree, focus: this.#focus, scroll: this.#scroll, detailOffset: this.#detailOffset, back: this.#back };
    this.#exitConfirmation = true;
    this.#confirm("Discard proposed change?", "No setting changes will be applied. Previously applied changes are not undone.", () => this.close(), () => {
      this.#exitConfirmation = false;
      this.#rows = previous.rows; this.#tree = previous.tree; this.#focus = previous.focus; this.#scroll = previous.scroll; this.#detailOffset = previous.detailOffset; this.#back = previous.back;
      this.#refresh();
    });
  }
  async waitForIdle(): Promise<void> { await this.#operation; }
  close(): void { if (this.#closed) return; this.dispose(); this.#done(); }
  dispose(): void {
    if (this.#closed) return; this.#closed = true; this.focused = false;
    this.#editing?.input.clear();
    this.#editing = undefined; this.#formCleanup?.(); this.#pending?.discard(); this.#pending = undefined; this.#draft.discard(); this.#scalarIntent.clear(); this.#values = {}; this.#rows = [];
  }
  handleInput(data: string): void {
    if (this.#closed || this.#busy) return;
    if (this.#editing) {
      const edit = this.#editing;
      if (edit.input.isPasting || data.includes("\x1b[200~")) edit.input.handleInput(data);
      else if (matchesKey(data, "escape")) { edit.input.clear(); this.#editing = undefined; edit.cancel(); }
      else if (matchesKey(data, "enter")) {
        const value = edit.input instanceof MaskedInput ? edit.input.take() : edit.input.getValue();
        this.#editing = undefined;
        this.#busy = true;
        this.#operation = Promise.resolve().then(() => edit.accept(value)).catch(() => { this.#report("Invalid entry or failed action; check required names, hosts, field types and runtime status."); }).finally(() => { this.#busy = false; this.#refresh(); });
      } else {
        edit.input.focused = this.focused;
        edit.input.handleInput(data);
      }
      this.#refresh(); return;
    }
    if (this.#tree) this.#home(false);
    if (isKeyRelease(data)) return;
    const modified = /^\x1b\[27;([12]);(\d+)~$/.exec(data);
    const key = data.length === 1 ? data : decodeKittyPrintable(data) ?? (modified && Number(modified[2]) >= 32 && Number(modified[2]) <= 126 ? String.fromCodePoint(Number(modified[2])) : undefined);
    const row = this.#rows[this.#focus];
    const run = (action?: () => void | Promise<void>) => {
      if (!action) return;
      this.#busy = true;
      this.#operation = Promise.resolve().then(action).catch(() => this.#report("Action failed. Review settings and sandbox status; no automatic host escape.")).finally(() => { this.#busy = false; this.#refresh(); });
    };
    if (key === "q") this.#exit();
    else if (matchesKey(data, "escape")) { if (this.#back) run(this.#back); else this.#exit(); }
    else if (this.#tree && key === "e") run(row?.edit);
    else if (this.#tree && key === "a") run(row?.add);
    else if (this.#tree && key === "d") run(row?.remove);
    else if (this.#tree && (matchesKey(data, "left") || key === "h")) {
      if (row?.children && this.#expanded.has(row.id)) this.#expanded.delete(row.id);
      else if (row?.parent) this.#treeFocus = row.parent;
      this.#home(); this.#detailOffset = 0;
    } else if (this.#tree && (matchesKey(data, "right") || key === "l" || matchesKey(data, "enter") && row?.children)) {
      if (row?.children) {
        if (this.#expanded.has(row.id) && row.children[0]) this.#treeFocus = row.children[0].id;
        else this.#expanded.add(row.id);
      }
      this.#home(); this.#detailOffset = 0;
    } else if (matchesKey(data, "pageUp") && this.#detailOffset > 0) this.#detailOffset--;
    else if (matchesKey(data, "pageDown") && this.#detailOffset < Math.max(0, (this.#rowHeights[this.#focus] ?? 1) - this.#capacity)) this.#detailOffset++;
    else if (!this.#tree && matchesKey(data, "up") && this.#detailOffset > 0) this.#detailOffset--;
    else if (!this.#tree && matchesKey(data, "down") && this.#detailOffset < Math.max(0, (this.#rowHeights[this.#focus] ?? 1) - this.#capacity)) this.#detailOffset++;
    else if (matchesKey(data, "up") || matchesKey(data, "shift+tab") || key === "k") { this.#focus = (this.#focus - 1 + this.#rows.length) % this.#rows.length; this.#detailOffset = 0; }
    else if (matchesKey(data, "down") || matchesKey(data, "tab") || key === "j") { this.#focus = (this.#focus + 1) % this.#rows.length; this.#detailOffset = 0; }
    else if (matchesKey(data, "enter")) run(row?.action);
    if (this.#tree && !this.#closed) this.#treeFocus = this.#rows[this.#focus]!.id;
    this.#refresh();
  }
  #footer(width: number, selected?: Row): string {
    if (this.#busy) return this.#theme.fg("muted", width >= 32 ? "Working · keys after completion" : "Working · please wait");
    type Hint = [key: string, action: string];
    const close: Hint = ["q", "close"];
    const navigation: Hint = ["j/k h/l", ""];
    const edits: Hint[] = [
      ...(selected?.edit ? [["e", "edit"] as Hint] : []),
      ...(selected?.add ? [["a", "add"] as Hint] : []),
      ...(selected?.remove ? [["d", selected.removeLabel ?? "delete"] as Hint] : []),
      ...(selected?.action ? [["Enter", "run"] as Hint] : []),
    ];
    const grouped: Hint[] = edits.length ? [[edits.map(([key]) => key).join("/"), ""]] : [];
    const candidates: { hints: Hint[]; separator: string }[] = (this.#editing ? [
      { hints: [["Enter", "keep"], ["Esc", "cancel"], ["q", "literal text"]], separator: " · " },
      { hints: [["Enter", "keep"], ["Esc", "cancel"]], separator: " " },
    ] : this.#tree ? [
      { hints: [close, ["j/k", "move"], ["h/l", "fold"], ...edits], separator: " · " },
      { hints: [close, navigation, ...edits], separator: " " },
      { hints: [close, navigation, ...grouped], separator: " " },
      { hints: [close, ["↑↓←→", ""], ...grouped], separator: " " },
    ] : [
      { hints: [close, ["Enter", "select"], ["Esc", "back"], ["↑/↓", "scroll"], ["Tab", "next"]], separator: " · " },
      { hints: [close, ["↵", ""], ["Esc", "back"], ["↑↓", ""], ["Tab", ""]], separator: " " },
      { hints: [close, ["↵", ""], ["Esc", ""], ["↑↓", ""], ["Tab", ""]], separator: " " },
    ]);
    const text = ([key, action]: Hint) => key + (action ? ` ${action}` : "");
    const candidate = candidates.find(({ hints, separator }) => visibleWidth(hints.map(text).join(separator)) <= width) ?? candidates[candidates.length - 1]!;
    return candidate.hints.map(([key, action]) => this.#theme.bold(this.#theme.fg("accent", key)) + (action ? this.#theme.fg("muted", ` ${action}`) : "")).join(this.#theme.fg("muted", candidate.separator));
  }
  #instructions(help: string, width: number): string[] {
    // Preserve intentional help/review line breaks; every line still strips terminal controls.
    return help.split("\n").flatMap((line) => wrapTextWithAnsi(this.#theme.fg("muted", safeText(line)), width));
  }
  render(width: number): string[] {
    width = Math.max(1, Math.floor(width));
    const height = Math.max(1, Math.floor(this.#tui.terminal.rows));
    if (this.#tree && !this.#editing) this.#home(false);
    const lines: string[] = [];
    const title = this.#theme.bold(this.#theme.fg("accent", "MICROSANDBOX"));
    if (height >= 8) lines.push(truncateToWidth(title, width));
    const selected = this.#rows[this.#focus];
    const footer = this.#footer(width, selected);
    // One physical row cannot show both content/error and hints: content wins.
    const footerCount = height >= 2 ? 1 : 0;
    const capacity = Math.max(1, height - lines.length - footerCount); this.#capacity = capacity;
    if (this.#editing) {
      const edit = this.#editing;
      const prompt = wrapTextWithAnsi(this.#theme.bold(this.#theme.fg("accent", safeText(edit.label))), width);
      // Input and the pinned footer win over help on tiny screens; editing keys never scroll help.
      const promptLines = prompt.slice(0, Math.max(0, capacity - 1));
      lines.push(...promptLines);
      const helpLines = this.#instructions(edit.editorHelp, width);
      lines.push(...helpLines.slice(0, Math.max(0, capacity - promptLines.length - 1)));
      edit.input.focused = this.focused;
      lines.push(...edit.input.render(width).slice(0, 1).map((line) => truncateToWidth(line, width)));
    } else {
      const body: string[] = []; let focusedLine = 0; this.#rowHeights = [];
      for (let index = 0; index < this.#rows.length; index++) {
        const row = this.#rows[index]!; const active = index === this.#focus;
        const rowStart = body.length;
        if (active) focusedLine = rowStart;
        const prefix = `${active ? ">" : " "} ${"  ".repeat(row.depth ?? 0)}${row.children ? this.#expanded.has(row.id) ? "▾ " : "▸ " : this.#tree ? "  " : ""}`;
        const heading = !this.#tree && ["title", "description", "proposal"].includes(row.id);
        const label = prefix + (heading ? this.#theme.bold(this.#theme.fg("accent", safeText(row.label))) : this.#theme.fg(row.children || row.button && !row.disabled && !row.id.includes("cancel") ? "accent" : row.id === "back" || row.id.includes("cancel") || row.disabled ? "muted" : row.id === "feedback" && /failed|invalid/i.test(row.label) ? "error" : row.id.includes("warning") || row.id === "feedback" ? "warning" : "text", row.button ? this.#theme.bold(`[ ${safeText(row.label)} ]`) : safeText(row.label)))
          + (row.value !== undefined ? this.#theme.fg(row.id === "configuration/status/state" ? this.#control.getState().status === "active" ? "success" : ["unavailable", "host-fallback"].includes(this.#control.getState().status) ? "error" : "warning" : "syntaxString", `: ${safeText(row.value)}`) : "")
          + (row.origin ? this.#theme.fg("dim", ` [${safeText(row.origin)}]`) : "");
        const labelLines = wrapTextWithAnsi(label, width);
        body.push(...labelLines.map((line) => active ? this.#theme.inverse(line) : line));
        if (row.detail && (!this.#tree && (active || width >= 80) || active && row.id === "configuration/status/state")) body.push(...wrapTextWithAnsi(this.#theme.fg("muted", safeText(row.detail)), width));
        if (row.instructions && (active || width >= 80)) body.push(...this.#instructions(row.instructions, width));
        this.#rowHeights.push(body.length - rowStart);
      }
      this.#detailOffset = Math.min(this.#detailOffset, Math.max(0, (this.#rowHeights[this.#focus] ?? 1) - capacity));
      focusedLine += this.#detailOffset;
      if (this.#detailOffset > 0) this.#scroll = focusedLine;
      if (focusedLine < this.#scroll) this.#scroll = focusedLine;
      if (focusedLine >= this.#scroll + capacity) this.#scroll = focusedLine - capacity + 1;
      this.#scroll = Math.max(0, Math.min(this.#scroll, Math.max(0, body.length - capacity)));
      lines.push(...body.slice(this.#scroll, this.#scroll + capacity));
    }
    if (footerCount) {
      while (lines.length < height - footerCount) lines.push("");
      lines.push(footer);
    }
    while (lines.length < height) lines.push("");
    // Pad opaque full viewport, so the native overlay never exposes underlying chat.
    return lines.slice(0, height).map((line) => truncateToWidth(line, width, "") + " ".repeat(Math.max(0, width - visibleWidth(truncateToWidth(line, width, "")))));
  }
}

export type PanelLaunchStage = "settings access" | "ephemeral settings" | "project settings" | "global settings" | "interactive overlay" | "panel construction";
const launchHelp: Record<PanelLaunchStage, string> = {
  "settings access": "Check working directory/Git discovery and restart Pi.",
  "ephemeral settings": "Check host-owned settings and policy boundaries.",
  "project settings": "Check the host-owned project settings target and its directory permissions/symlinks.",
  "global settings": "Check the host-owned global settings target and its directory permissions/symlinks.",
  "interactive overlay": "Check Pi interactive UI support and report a compatibility bug if this persists.",
  "panel construction": "Report a control-panel bug with the Pi version and this diagnostic.",
};
/** Never retain or print arbitrary messages, stacks, causes, names or codes from credential-bearing errors. */
export class PanelLaunchError extends Error {
  readonly unexpected: boolean;
  constructor(stage: PanelLaunchStage, error: unknown) {
    const kind = error instanceof ConfigError ? "ConfigError" : error instanceof TypeError ? "TypeError" : error instanceof RangeError ? "RangeError" : error instanceof ReferenceError ? "ReferenceError" : error instanceof SyntaxError ? "SyntaxError" : error instanceof Error ? "Error" : "unknown error";
    const code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
    const safeCode = ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "EROFS", "ENOSPC", "EMFILE"].includes(code) ? code as string : undefined;
    super(`Unable to open /msb at ${stage} (${kind}${safeCode ? ` / ${safeCode}` : ""}). ${launchHelp[stage]} Opening the panel applies no settings.`);
    this.name = "PanelLaunchError";
    this.unexpected = !(error instanceof ConfigError) && !safeCode;
  }
}

let activePanel: ControlPanel | undefined;
let opening = false;
let generation = 0;
export async function closeControlPanel(): Promise<void> { generation++; const panel = activePanel; panel?.close(); await panel?.waitForIdle(); }
export async function openControlPanel(ctx: Context, control: MsbControl): Promise<void> {
  if (opening || activePanel) throw new Error("A Microsandbox panel is already open");
  opening = true;
  const currentGeneration = generation;
  let draft: SettingsDraft | undefined;
  let stage: PanelLaunchStage = "settings access";
  try {
    const settings = control.settings;
    if (!settings) throw new Error("This control adapter does not support settings");
    stage = "ephemeral settings";
    draft = await settings.open("temporary");
    const paths: Record<string, string> = { temporary: "Current session memory (no disk writes)" };
    for (const scope of ["project", "global"] as const) { stage = `${scope} settings`; const source = await settings.open(scope); paths[scope] = source.path!; source.discard(); }
    const selected = draft;
    if (generation !== currentGeneration) return;
    stage = "interactive overlay";
    await ctx.ui.custom<void>((tui, theme, _keys, done) => {
      stage = "panel construction";
      activePanel = new ControlPanel({ draft: selected, control, ctx, tui, theme, paths, done: () => { activePanel = undefined; done(); } });
      stage = "interactive overlay";
      return activePanel;
    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
  } catch (error) { throw new PanelLaunchError(stage, error); }
  finally { await closeControlPanel(); activePanel = undefined; draft?.discard(); opening = false; }
}
