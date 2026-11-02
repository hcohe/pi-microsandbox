import { visibleWidth, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, normalizeConfigPath, parseTomlConfig } from "./config.ts";
import { SettingsInput } from "./settings-input.ts";
import { COLLECTION_REMOVALS } from "./settings.ts";
import { MaskedInput } from "./masked-input.ts";
import { SECTIONS, SETTINGS_FIELDS, valueAt, type Section, type SettingsField } from "./settings-fields.ts";
import type { SettingsDraft, SettingsScope } from "./settings.ts";
import type { MsbControl, Config } from "./types.ts";

type Context = Pick<ExtensionCommandContext, "ui" | "waitForIdle">;
type Row = { id: string; label: string; detail?: string; action?: () => void | Promise<void> };
type FormField = { name: string; value: string; secret?: boolean; choices?: string[]; description?: string };
export const SAVE_LABELS = ["Apply temporarily", "Apply to project settings", "Apply to global settings"] as const;
const scopes: SettingsScope[] = ["temporary", "project", "global"];
/** Strip terminal controls from every external label, log, path and value. */
export const safeText = (value: unknown): string => String(value ?? "").replace(/\x1b\][^\x07]*(?:\x07|$)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\p{Cc}\p{Cf}]/gu, " ");
const display = (value: unknown): string => value === null ? "automatic session name" : value === undefined ? "inherit" : typeof value === "string" ? value : JSON.stringify(value);

/** One focus model for forms, menus and save buttons; the whole model pages at tiny heights. */
export class ControlPanel implements Component, Focusable {
  focused = true;
  #draft: SettingsDraft;
  #pending?: SettingsDraft;
  #control: MsbControl;
  #ctx: Context;
  #tui: Pick<TUI, "terminal" | "requestRender">;
  #theme: Pick<Theme, "fg" | "bold" | "inverse">;
  #done: () => void;
  #section: Section = "Overview";
  #rows: Row[] = [];
  #focus = 0;
  #scroll = 0;
  #detailOffset = 0;
  #rowHeights: number[] = [];
  #capacity = 1;
  #dirty = false;
  #busy = false;
  #operation: Promise<void> = Promise.resolve();
  #closed = false;
  #feedback?: string;
  #message = "Arrows/Tab move · Enter select · Esc back";
  #values: any;
  #provenance: Record<string, string>;
  #paths: Record<string, string>;
  #warnings: string[];
  #changes = new Map<string, unknown>();
  #editing?: { input: SettingsInput | MaskedInput; accept: (value: string) => void | Promise<void>; cancel: () => void; label: string };
  #back?: () => void;
  #formCleanup?: () => void;

  constructor(options: { draft: SettingsDraft; control: MsbControl; ctx: Context; tui: Pick<TUI, "terminal" | "requestRender">; theme: Pick<Theme, "fg" | "bold" | "inverse">; done: () => void; paths: Record<string, string> }) {
    this.#draft = options.draft; this.#control = options.control; this.#ctx = options.ctx; this.#tui = options.tui; this.#theme = options.theme; this.#done = options.done; this.#paths = options.paths;
    const snapshot = this.#draft.snapshot();
    // Only the backend's redacted display crosses into presentation state.
    this.#values = parseTomlConfig(snapshot.effectiveToml, "global").value;
    if (snapshot.automaticSandboxName) this.#values.sandboxName = null;
    this.#provenance = snapshot.provenance; this.#warnings = snapshot.warnings;
    this.#home();
  }
  invalidate(): void {}
  #refresh(): void { if (!this.#closed) this.#tui.requestRender(); }
  #page(rows: Row[], back?: () => void): void { this.#rows = rows; this.#focus = 0; this.#scroll = 0; this.#detailOffset = 0; this.#back = back; this.#refresh(); }
  #rowValue(path: string): unknown { return this.#changes.has(path) ? this.#changes.get(path) : valueAt(this.#values, path); }
  #set(path: string, value: unknown): void { this.#draft.set(path, value); this.#changes.set(path, value); this.#dirty = true; }
  #inherit(path: string): void { this.#draft.inherit(path); this.#changes.set(path, undefined); this.#dirty = true; this.#home(); }
  #home(): void {
    if (this.#closed) return;
    const rows: Row[] = [
      ...(this.#feedback ? [this.#feedbackRow()] : []),
      { id: "section", label: `Section: ${this.#section}`, detail: "Select a section", action: () => this.#page(SECTIONS.map((section) => ({ id: section, label: section, action: () => { this.#section = section; this.#home(); } })), () => this.#home()) },
      { id: "search", label: "Search all settings", action: () => this.#input("Search names and descriptions", "", false, (query) => this.#page(SETTINGS_FIELDS.filter((field) => `${field.path} ${field.description}`.toLowerCase().includes(query.toLowerCase())).map((field) => this.#fieldRow(field)), () => this.#home())) },
    ];
    if (this.#section === "Overview") {
      const state = this.#control.getState(); const info = state.info;
      rows.push({ id: "status", label: `Runtime: ${state.status}`, detail: state.reason });
      if (info) for (const [name, value] of Object.entries({ Workspace: info.root, Workdir: info.cwd, Name: info.name, PID: info.pid, Age: `${Math.max(0, Math.floor((Date.now() - info.createdAt) / 1000))}s`, Image: info.image, Docker: `${info.docker.mode} / ${info.docker.readiness}`, Version: info.docker.version, Storage: info.docker.storageDriver, "Docker detail": info.docker.reason })) rows.push({ id: name, label: `${name}: ${value ?? "unknown"}` });
      rows.push({ id: "resources", label: `${display(this.#rowValue("cpus"))} CPUs · ${display(this.#rowValue("memory_mib"))} MiB`, detail: `Network: ${display(this.#rowValue("network.mode"))}. Draft values are not running until applied.` });
      rows.push({ id: "boundary", label: "Host workspace is mounted read/write", detail: "Entire Git worktree exposed. Host bypass is an explicit escape, never a recovery fallback by default." });
    } else if (this.#section === "Sources") {
      for (const [scope, path] of Object.entries(this.#paths)) rows.push({ id: scope, label: `${scope} target`, detail: path });
      rows.push({ id: "precedence", label: "Precedence (low to high)", detail: "Built-ins → PI_MSB_* environment → global host → project host → temporary memory. Project/global arrays replace lower lists. Global saves can be shadowed." });
      for (const warning of this.#warnings) rows.push({ id: `warning:${rows.length}`, label: "Warning", detail: warning });
      rows.push(...SETTINGS_FIELDS.map((field) => ({ id: field.path, label: `${field.path}: ${this.#owner(field.path)}`, detail: this.#summary(field.path), action: () => this.#field(field) })));
    } else if (this.#section === "Actions") rows.push(...this.#actions());
    else rows.push(...SETTINGS_FIELDS.filter((field) => field.section === this.#section).map((field) => this.#fieldRow(field)));
    rows.push(...SAVE_LABELS.map((label, index) => ({ id: `save:${scopes[index]}`, label, detail: index === 0 ? "Memory only; resets on session switch/end" : this.#paths[scopes[index]!], action: () => this.#save(scopes[index]!) })));
    rows.push({ id: "close", label: "Close", action: () => this.#exit() });
    this.#page(rows);
  }
  #owner(path: string): string { return this.#changes.has(path) ? "draft (not applied)" : this.#provenance[normalizeConfigPath(path).join(".")] ?? "built-ins / collection owners"; }
  #summary(path: string): string {
    if (path === "secrets") return `${(this.#rowValue(path) as any[] | undefined)?.length ?? 0} secrets (values masked)`;
    return display(this.#rowValue(path));
  }
  #fieldRow(field: SettingsField): Row { return { id: field.path, label: `${field.path}: ${this.#summary(field.path)}`, detail: `${field.description} Source: ${this.#owner(field.path)}`, action: () => this.#field(field) }; }
  #field(field: SettingsField): void {
    if (field.path === "secrets") { this.#secrets(); return; }
    if (field.path === "mounts") { this.#mounts(); return; }
    const value = this.#rowValue(field.path) ?? valueAt(DEFAULT_CONFIG, field.path);
    if (Array.isArray(value)) { this.#list(field, value.map(String)); return; }
    const set = (next: unknown) => { this.#set(field.path, next); this.#home(); };
    this.#page([
      { id: "description", label: field.path, detail: `${field.description} Current: ${display(value)}. Source: ${this.#owner(field.path)}` },
      ...(field.path === "sandbox_name" ? [{ id: "automatic-name", label: "Use automatic session name (temporary only)", detail: "Override lower-layer custom names with null in memory. Persistent files have no null; use Inherit there.", action: () => set(null) }] : []),
      ...(field.choices ? field.choices.map((choice) => ({ id: String(choice), label: `Use ${choice}`, action: () => set(choice) })) : [{ id: "edit", label: "Edit value", action: () => this.#input(field.path, String(value ?? ""), false, (text) => set(typeof valueAt(DEFAULT_CONFIG, field.path) === "number" ? Number(text) : text)) }]),
      { id: "inherit", label: "Inherit / remove chosen scope's assignment", detail: "Different from an empty value or list. Choose a save scope afterward.", action: () => this.#inherit(field.path) },
      { id: "back", label: "Back", action: () => this.#home() },
    ], () => this.#home());
  }
  #list(field: SettingsField, items: string[]): void {
    const back = () => this.#list(field, items);
    const edit = (index?: number) => this.#form(field.path, [{ name: "Value", value: index === undefined ? "" : items[index]! }], (fields) => {
      const value = fields[0]!.value;
      this.#draft.upsertListEntry(field.path, value, index === undefined ? undefined : items[index]);
      if (index === undefined) items.push(value); else items[index] = value;
      this.#changes.set(field.path, [...items]); this.#dirty = true; back();
    }, index === undefined ? undefined : () => { this.#draft.removeListEntry(field.path, items[index]!); items.splice(index, 1); this.#changes.set(field.path, [...items]); this.#dirty = true; back(); }, back);
    this.#page([
      { id: "description", label: field.path, detail: `${field.description}${COLLECTION_REMOVALS[field.path] ? ` Entry edits preserve the selected scope's other entries, never unrelated higher-scope entries. Saving reconciles conflicting ${COLLECTION_REMOVALS[field.path]} identities in the chosen scope; unrelated removals stay intact.` : ""}` },
      ...items.map((item, index) => ({ id: `item:${index}`, label: item, detail: "Enter to edit or delete", action: () => edit(index) })),
      { id: "add", label: "Add entry", action: () => edit() },
      { id: "clear", label: "Clear list (explicit empty)", action: () => { this.#set(field.path, []); this.#list(field, []); } },
      { id: "inherit", label: "Inherit list", action: () => this.#inherit(field.path) },
      { id: "back", label: "Back", action: () => this.#home() },
    ], () => this.#home());
  }
  #secrets(): void {
    const items = (this.#rowValue("secrets") ?? []) as Array<{ env: string; allowHosts: string[] }>;
    const edit = (entry?: typeof items[number]) => this.#form("Secret (never displayed)", [
      { name: "Environment name", value: entry?.env ?? "", description: "A valid environment variable, not a process-control name." },
      { name: "Allowed hosts", value: (entry?.allowHosts ?? []).join(", "), description: "Comma-separated destinations; at least one is required." },
      { name: "Replace value / reference", value: "", secret: true, description: entry ? "Leave blank to retain the private existing value. $ENV:NAME or $FILE:path recommended." : "Masked entry. $ENV:NAME or $FILE:path recommended." },
    ], (fields) => {
      const env = fields[0]!.value; const allowHosts = fields[1]!.value.split(",").map((host) => host.trim()).filter(Boolean); const value = fields[2]!.value;
      this.#draft.upsertSecret({ env, allowHosts, ...(value ? { value } : {}) }, entry?.env);
      this.#changes.set("secrets", [...items.filter((item) => item.env !== entry?.env && item.env !== env), { env, allowHosts, value: "<redacted>" }]);
      this.#dirty = true; this.#secrets();
    }, entry ? () => { this.#draft.removeSecret(entry.env); this.#changes.set("secrets", items.filter((item) => item.env !== entry.env)); this.#dirty = true; this.#secrets(); } : undefined, () => this.#secrets());
    this.#page([
      { id: "description", label: "Secrets", detail: "Values and references are never prefilled. Edit metadata without replacing a credential. Only selected entry edits are saved; unrelated higher-scope entries are never exported; conflicting remove_secrets identities in the chosen scope are reconciled." },
      ...items.map((entry) => ({ id: entry.env, label: `${entry.env}: ********`, detail: `${entry.allowHosts?.join(", ")} · ${this.#provenance[`secrets[${entry.env}]`] ?? "draft/inherited"}`, action: () => edit(entry) })),
      { id: "add", label: "Add secret", action: () => edit() },
      { id: "clear", label: "Clear secrets (explicit empty)", action: () => { this.#set("secrets", []); this.#secrets(); } },
      { id: "inherit", label: "Inherit secrets", action: () => this.#inherit("secrets") },
      { id: "back", label: "Back", action: () => this.#home() },
    ], () => this.#home());
  }
  #mounts(): void {
    const items = (this.#rowValue("mounts") ?? []) as Config["mounts"];
    const edit = (entry?: Config["mounts"][number]) => this.#form("Mount", [
      { name: "Type", value: entry?.type ?? "dir", choices: ["dir", "file", "named", "tmpfs"] },
      { name: "Host path / volume name", value: entry?.hostPath ?? "", description: "Absolute host path for dir/file; no host socket or writable policy exposure." },
      { name: "Guest path", value: entry?.guestPath ?? "", description: "Absolute path; cannot shadow workspace, /tmp or guest system paths." },
      { name: "Read only", value: String(entry?.readonly ?? true), choices: ["true", "false"] },
      { name: "Options", value: (entry?.options ?? []).join(", "), description: "Comma-separated noexec, nosuid, nodev." },
    ], (fields) => {
      const mount = { type: fields[0]!.value as Config["mounts"][number]["type"], ...(fields[1]!.value ? { hostPath: fields[1]!.value } : {}), guestPath: fields[2]!.value, readonly: fields[3]!.value === "true", options: fields[4]!.value.split(",").map((option) => option.trim()).filter(Boolean) };
      this.#draft.upsertMount(mount, entry?.guestPath);
      this.#changes.set("mounts", [...items.filter((item) => item.guestPath !== entry?.guestPath && item.guestPath !== mount.guestPath), mount]); this.#dirty = true; this.#mounts();
    }, entry ? () => { this.#draft.removeMount(entry.guestPath!); this.#changes.set("mounts", items.filter((item) => item.guestPath !== entry.guestPath)); this.#dirty = true; this.#mounts(); } : undefined, () => this.#mounts());
    this.#page([
      { id: "description", label: "Mounts", detail: "Host data stays on the host; writable mounts expose it. Named storage can persist. Only selected entry edits are applied to the chosen scope. Review the security boundary before saving. Conflicting remove_mounts identities in the chosen scope are reconciled." },
      ...items.map((entry) => ({ id: entry.guestPath!, label: `${entry.guestPath} (${entry.readonly ? "ro" : "rw"})`, detail: `${entry.type}: ${entry.hostPath ?? "memory"}`, action: () => edit(entry) })),
      { id: "add", label: "Add mount", action: () => edit() },
      { id: "clear", label: "Clear mounts (explicit empty)", action: () => { this.#set("mounts", []); this.#mounts(); } },
      { id: "inherit", label: "Inherit mounts", action: () => this.#inherit("mounts") },
      { id: "back", label: "Back", action: () => this.#home() },
    ], () => this.#home());
  }
  #form(title: string, fields: FormField[], save: (fields: FormField[]) => void, remove: (() => void) | undefined, back: () => void): void {
    const clear = () => { for (const field of fields) if (field.secret) field.value = ""; this.#formCleanup = undefined; };
    this.#formCleanup = clear;
    const show = () => this.#page([
      { id: "title", label: title },
      ...fields.map((field) => ({ id: field.name, label: `${field.name}: ${field.secret ? field.value ? "******** (replacement)" : "not replaced" : field.value}`, detail: field.description, action: () => {
        if (field.choices) this.#page(field.choices.map((value) => ({ id: value, label: value, action: () => { field.value = value; show(); } })), show);
        else this.#input(field.name, field.secret ? "" : field.value, !!field.secret, (value) => { field.value = value; show(); }, show);
      } })),
      { id: "save-item", label: "Keep draft entry", action: () => { save(fields); clear(); } },
      ...(remove ? [{ id: "delete-item", label: "Delete entry from draft", action: () => { remove(); clear(); } }] : []),
      { id: "cancel-item", label: "Cancel entry", action: () => { clear(); back(); } },
    ], () => { clear(); back(); });
    show();
  }
  #input(label: string, value: string, secret: boolean, accept: (value: string) => void | Promise<void>, cancel = () => this.#home()): void {
    const input = secret ? new MaskedInput() : new SettingsInput();
    if (input instanceof SettingsInput) { input.setValue(safeText(value)); input.handleInput("\x1b[F"); }
    input.focused = this.focused;
    this.#editing = { input, label, accept, cancel }; this.#refresh();
  }
  #confirm(title: string, detail: string, action: () => void | Promise<void>, back = () => this.#home()): void {
    this.#page([
      { id: "warning", label: title, detail },
      { id: "cancel", label: "Cancel", action: back },
      { id: "confirm", label: "Confirm", action },
    ], back);
    this.#focus = 1;
  }
  async #save(scope: SettingsScope): Promise<void> {
    let target: SettingsDraft | undefined;
    if (scope !== "temporary" && this.#changes.has("sandbox_name") && this.#changes.get("sandbox_name") === null) {
      this.#report("Automatic session naming is a temporary-only override. Choose Apply temporarily, or Inherit sandbox_name to remove a persistent assignment.");
      return;
    }
    try {
      target = await this.#draft.forScope(scope);
      if (this.#closed) { target.discard(); return; }
      const preview = await (this.#control.previewSettings?.(target) ?? target.preview());
      if (this.#closed) { target.discard(); return; }
      const entries = preview.collections.map((intent) => `${intent.operation.toUpperCase()} ${intent.path}[${intent.identities.join(", ") || "whole list"}]${intent.previousIdentity && intent.previousIdentity !== intent.identities[0] ? ` (was ${intent.previousIdentity})` : ""} from ${intent.source}${intent.sourcePath ? ` (${intent.sourcePath})` : ""}${intent.promoted ? ": DELIBERATE higher-scope import" : ""}${intent.shadowed ? ": shadowed; not effective here" : ""}`).join("; ");
      const summary = `${scope === "temporary" ? "Current session memory only" : target.path}. ${preview.changes.length} dirty settings: ${preview.changes.map((change) => change.path).join(", ") || "none"}. ${entries ? `Collection intent: ${entries}. ` : ""}${preview.effect === "restart" ? "RESTART: guest ephemeral state and nested containers may be lost. In-flight tools must finish." : "Live routing/presentation update; no guest restart required."} ${preview.shadowed.length ? `Shadowed (NOT effective): ${preview.shadowed.join(", ")}.` : ""} Conflicting same-scope removal controls shown in changed fields are reconciled. Host bypass/network/mount/environment settings can widen access; review before confirming.`;
      const pending = target; this.#pending = pending;
      this.#confirm(`Apply ${scope} settings?`, summary, async () => {
        let saved = false; let applied = false; let message = "";
        try {
          await this.#ctx.waitForIdle();
          if (this.#closed) return;
          const result = await pending.apply(); saved = result.saved; applied = true;
          if (this.#closed) return;
          await this.#control.reload({ allowRestart: preview.effect === "restart" });
          if (this.#closed) return;
          message = `${saved ? "Applied" : "No changes"}${result.shadowed.length ? `; shadowed: ${result.shadowed.join(", ")}` : ""}. Runtime: ${this.#control.getState().status}`;
        } catch { message = applied ? `${saved ? "Saved" : "Settings unchanged"}, but runtime failed. Review Overview and retry Reload; no automatic host escape.` : "Apply failed. Check values, secret references, policy paths and external edits. Reopen to verify storage after an I/O error; no automatic host escape."; }
        finally {
          pending.discard(); this.#pending = undefined;
          if (!this.#closed) {
            try {
              if (applied) await this.#reopenDraft();
              else await this.#refreshDraft();
            } catch { message += " Draft refresh failed; fix host configuration, then retry Reload or reopen the panel."; }
            if (!this.#closed) { this.#home(); this.#report(message); }
          }
        }
      }, () => { pending.discard(); this.#pending = undefined; this.#home(); });
    } catch { target?.discard(); this.#report("Validation failed. Check types/ranges, required secret hosts, references and mount/host policy guards. Draft retained."); }
  }
  #load(): void {
    const snapshot = this.#draft.snapshot(); this.#values = parseTomlConfig(snapshot.effectiveToml, "global").value;
    if (snapshot.automaticSandboxName) this.#values.sandboxName = null;
    this.#provenance = snapshot.provenance; this.#warnings = snapshot.warnings; this.#changes.clear(); this.#dirty = false;
  }
  async #reopenDraft(): Promise<void> {
    const fresh = await this.#control.settings!.open("temporary");
    if (this.#closed) { fresh.discard(); return; }
    this.#draft.discard(); this.#draft = fresh; this.#load();
  }
  async #refreshDraft(): Promise<void> {
    const next = await this.#draft.refresh();
    if (this.#closed) { next.discard(); return; }
    this.#draft.discard(); this.#draft = next;
    const snapshot = next.snapshot();
    this.#values = parseTomlConfig(snapshot.effectiveToml, "global").value;
    if (snapshot.automaticSandboxName) this.#values.sandboxName = null;
    this.#provenance = snapshot.provenance; this.#warnings = snapshot.warnings;
  }
  #feedbackRow(): Row { return { id: "feedback", label: `Result: ${this.#feedback}`, detail: "Enter for full result; arrows scroll wrapped text.", action: () => this.#text("Operation result", this.#feedback!) }; }
  #report(message: string): void {
    if (this.#closed) return;
    this.#message = message; this.#feedback = message;
    this.#rows = [this.#feedbackRow(), ...this.#rows.filter((row) => row.id !== "feedback")];
    this.#focus = 0; this.#scroll = 0; this.#detailOffset = 0; this.#refresh();
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
          try { await this.#refreshDraft(); } catch { message += " Draft refresh failed; fix host configuration and retry Reload."; }
          if (!this.#closed) { this.#home(); this.#report(message); }
        }
      }
    }) });
    return [
      dangerous("Enable sandbox", "Boot using current validated settings. No implicit host fallback.", () => this.#control.setEnabled(true)),
      dangerous("Turn off (HOST execution)", "DANGER: stops/removes the sandbox. Routed tools execute on the HOST. Guest ephemeral state is lost.", () => this.#control.setEnabled(false)),
      dangerous("Reload settings", "Re-read host configuration/environment. Changed runtime settings recreate the guest and lose ephemeral state.", () => this.#control.reload()),
      { id: "prune", label: "Prune stale sandboxes", detail: "Remove only stale owned sandboxes, never host files or volumes.", action: () => this.#confirm("Prune stale sandboxes?", "Current session and live owners are kept. Host files and named volumes are not deleted.", async () => { await this.#ctx.waitForIdle(); if (this.#closed) return; const report = await this.#control.pruneNow(); this.#text("Prune result", `Inspected: ${report.inspected}\nRemoved: ${report.removed.join(", ")}\nKept: ${report.kept.join(", ")}\nErrors: ${report.errors.length}\n${report.errors.join("\n")}`); }) },
      { id: "logs", label: "Recent logs (redacted)", detail: "Choose a non-negative tail count; guest logs may contain sensitive application data.", action: () => this.#input("Log tail lines (non-negative integer)", "100", false, async (value) => {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) { this.#report("Invalid log tail. Enter one non-negative safe integer."); return; }
        this.#text("Recent logs", await this.#control.getLogs(Number(value)));
      }) },
      { id: "config", label: "Effective configuration (redacted)", action: () => this.#text("Effective configuration", this.#control.getEffectiveConfigToml()) },
      { id: "seal", label: "Seal network in draft", detail: "Sets deny mode; apply with one of the three buttons.", action: () => { this.#set("network.mode", "deny"); this.#home(); } },
      dangerous("Reset temporary settings", "Discard current memory-only overrides, then reconfigure. Restart may lose guest state. Unsaved panel edits will also be discarded.", async () => { try { await this.#control.resetOverrides(); } finally { if (!this.#closed) await this.#reopenDraft(); } }),
      { id: "help", label: "Help", action: () => this.#text("Using /msb", "Select a section, search a setting, or choose Actions. Enter edits; Esc backs out. Entry edits affect only the draft. Inherit removes the chosen save scope's assignment; empty lists explicitly clear. Apply temporarily affects only this session. Project/global files live outside the workspace. Sources shows ownership; higher layers may shadow a save. Secrets never prefill values. Restarting loses guest ephemeral state; host files remain your responsibility. Close without applying to cancel.") },
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
    if (this.#dirty) this.#confirm("Discard unsaved changes?", "No setting changes will be applied. Previously confirmed saves are not undone.", () => this.close());
    else this.close();
  }
  async waitForIdle(): Promise<void> { await this.#operation; }
  close(): void { if (this.#closed) return; this.dispose(); this.#done(); }
  dispose(): void {
    if (this.#closed) return; this.#closed = true;
    this.#editing?.input.clear();
    this.#editing = undefined; this.#formCleanup?.(); this.#pending?.discard(); this.#pending = undefined; this.#draft.discard(); this.#changes.clear(); this.#values = {}; this.#rows = [];
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
    if (matchesKey(data, "escape")) { if (this.#back) this.#back(); else this.#exit(); }
    else if (matchesKey(data, "up") && this.#detailOffset > 0) this.#detailOffset--;
    else if (matchesKey(data, "down") && this.#detailOffset < Math.max(0, (this.#rowHeights[this.#focus] ?? 1) - this.#capacity)) this.#detailOffset++;
    else if (matchesKey(data, "up") || matchesKey(data, "shift+tab") || matchesKey(data, "left")) { this.#focus = (this.#focus - 1 + this.#rows.length) % this.#rows.length; this.#detailOffset = 0; }
    else if (matchesKey(data, "down") || matchesKey(data, "tab") || matchesKey(data, "right")) { this.#focus = (this.#focus + 1) % this.#rows.length; this.#detailOffset = 0; }
    else if (matchesKey(data, "enter")) {
      this.#busy = true;
      this.#operation = Promise.resolve().then(() => this.#rows[this.#focus]?.action?.()).catch(() => { this.#report("Action failed. Review settings and sandbox status; no automatic host escape."); }).finally(() => { this.#busy = false; this.#refresh(); });
    }
    this.#refresh();
  }
  render(width: number): string[] {
    width = Math.max(1, Math.floor(width));
    const height = Math.max(1, Math.floor(this.#tui.terminal.rows));
    const lines: string[] = [];
    const title = this.#theme.bold(this.#theme.fg("accent", `MICROSANDBOX${this.#dirty ? " · unsaved" : ""}`));
    if (height >= 4) lines.push(truncateToWidth(title, width));
    const capacity = Math.max(1, height - lines.length - (height >= 6 ? 1 : 0)); this.#capacity = capacity;
    if (this.#editing) {
      const edit = this.#editing;
      const prompt = wrapTextWithAnsi(safeText(edit.label), width);
      lines.push(...prompt.slice(0, Math.max(0, capacity - 1)));
      edit.input.focused = this.focused;
      lines.push(...edit.input.render(width).map((line) => truncateToWidth(line, width)));
    } else {
      const body: string[] = []; let focusedLine = 0; this.#rowHeights = [];
      for (let index = 0; index < this.#rows.length; index++) {
        const row = this.#rows[index]!; const active = index === this.#focus;
        const rowStart = body.length;
        if (active) focusedLine = rowStart;
        const label = `${active ? ">" : " "} ${safeText(row.label)}`;
        const labelLines = wrapTextWithAnsi(label, width);
        body.push(...labelLines.map((line) => active ? this.#theme.inverse(line) : line));
        if (row.detail && (active || width >= 80)) body.push(...wrapTextWithAnsi(this.#theme.fg("dim", safeText(row.detail)), width));
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
    if (height >= 6) { while (lines.length < height - 1) lines.push(""); lines.push(this.#theme.fg("muted", truncateToWidth(safeText(this.#busy ? "Working; please wait..." : this.#message), width))); }
    while (lines.length < height) lines.push("");
    // Pad opaque full viewport, so the native overlay never exposes underlying chat.
    return lines.slice(0, height).map((line) => truncateToWidth(line, width, "") + " ".repeat(Math.max(0, width - visibleWidth(truncateToWidth(line, width, "")))));
  }
}

let activePanel: ControlPanel | undefined;
let opening = false;
let generation = 0;
export async function closeControlPanel(): Promise<void> { generation++; const panel = activePanel; panel?.close(); await panel?.waitForIdle(); }
export async function openControlPanel(ctx: Context, control: MsbControl): Promise<void> {
  if (opening || activePanel) throw new Error("A Microsandbox panel is already open");
  if (!control.settings) throw new Error("This control adapter does not support settings");
  opening = true;
  const currentGeneration = generation;
  let draft: SettingsDraft | undefined;
  try {
    draft = await control.settings.open("temporary");
    const paths: Record<string, string> = { temporary: "Current session memory (no disk writes)" };
    for (const scope of ["project", "global"] as const) { const source = await control.settings.open(scope); paths[scope] = source.path!; source.discard(); }
    const selected = draft;
    if (generation !== currentGeneration) return;
    await ctx.ui.custom<void>((tui, theme, _keys, done) => {
      activePanel = new ControlPanel({ draft: selected, control, ctx, tui, theme, paths, done: () => { activePanel = undefined; done(); } });
      return activePanel;
    }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 } });
  } finally { await closeControlPanel(); activePanel = undefined; draft?.discard(); opening = false; }
}
