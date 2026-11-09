import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { MsbControl } from "./types.ts";

export const MAX_DIAGNOSTICS_BYTES = 48 * 1024;
const failureSummaries = {
  none: "No cached blocking failure.",
  unknown: "Cached failure cause unavailable. Inspect configuration and host runtime setup; diagnostics cannot run checks or repair it.",
  native_sdk_unavailable: "Native Microsandbox SDK could not load. Check the host installation and supported platform.",
  host_secret_command_failed: "A configured host secret command failed or returned no value. Check that command on the host before retrying activation.",
  host_secret_environment_unavailable: "A configured host secret environment source was unavailable. Check the host environment before retrying activation.",
  runtime_preparation_failed: "Guest runtime preparation failed. Check required image tools, bootstrap configuration and required Docker readiness.",
  runtime_start_failed: "Sandbox startup failed. Check host Microsandbox runtime setup and configuration before retrying activation.",
  invalid_configuration: "No valid configuration is cached. Inspect configuration with msb_config_get; invalid syntax may require manual host repair.",
  workspace_unavailable: "Workspace or session identity is unavailable. Check the host working directory and restart Pi.",
} as const;
export type DiagnosticFailureCode = keyof typeof failureSummaries;
const parameters = Type.Object({
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])),
}, { additionalProperties: false });
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const pick = (v: unknown, allowed: string[], fallback = "unknown") => typeof v === "string" && allowed.includes(v) ? v : fallback;

/** Allowlist, rather than serialize arbitrary adapter metadata/toJSON/errors.
 * All strings are fixed enums, fixed prose or constrained version numbers.
 * Thus both structured details and terminal rendering are bounded and inert.
 */
export function boundDiagnosticsReport(report: Record<string, unknown>): Record<string, unknown> {
  const runtime = record(report.runtime), readiness = record(report.readiness), host = record(report.host);
  const desired = record(report.desired), settings = record(desired.settings), adoption = record(report.adoption);
  const safeSettings: Record<string, unknown> = {};
  for (const key of ["autoStart", "allowHostExecution", "bootstrapTools", "blockThirdParty"]) if (typeof settings[key] === "boolean") safeSettings[key] = settings[key];
  for (const key of ["secretCount", "mountCount"]) if (Number.isSafeInteger(settings[key]) && Number(settings[key]) >= 0 && Number(settings[key]) <= 1_000_000) safeSettings[key] = settings[key];
  for (const [key, allowed] of Object.entries({ networkMode: ["default", "deny", "open", "allowlist"], dockerMode: ["disabled", "require", "auto"], fallbackMode: ["block", "host"] })) safeSettings[key] = pick(settings[key], allowed);
  const outcome = pick(report.outcome, ["diagnosed", "unavailable", "rejected"], "unavailable");
  const phase = pick(record(report.failure).phase, ["workspace_or_session_not_ready", "configuration_not_ready", "runtime_failure", "none"]);
  const code = (phase === "none" ? "none" : pick(record(report.failure).code, Object.keys(failureSummaries))) as DiagnosticFailureCode;
  return {
    outcome, readOnly: true, evidence: "cached; last-known, not live-probed",
    ...(outcome === "diagnosed" ? {
      runtime: { status: pick(runtime.status, ["active", "off", "disabled", "unavailable", "host-fallback", "booting", "stopping"]), execution: pick(runtime.execution, ["sandbox", "explicit-host", "fallback-host", "blocked"]) },
      readiness: Object.fromEntries(["workspaceReady", "settingsReady", "configReady"].map((key) => [key, readiness[key] === true])),
      host: { platform: pick(host.platform, ["darwin", "linux", "win32", "freebsd", "openbsd", "aix", "sunos", "android"]), arch: pick(host.arch, ["arm", "arm64", "x64", "ia32", "ppc64", "s390x", "riscv64"]), node: typeof host.node === "string" && /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host.node) ? host.node : "unknown" },
      failure: { phase, code, reason: failureSummaries[code] },
      desired: { evidence: "last-known resolution; not live", validForSession: readiness.configReady === true && desired.validForSession === true, ...(readiness.configReady === true && desired.validForSession === true ? { settings: safeSettings } : {}) },
      adoption: { evidence: "last-known; not live", known: adoption.known === true, verification: pick(adoption.verification, ["created", "reconnected"]) },
    } : { reason: outcome === "rejected" ? "Only optional format=text/json is accepted. No changes made." : "Safe diagnostics unavailable from this adapter. Error details withheld; no changes made." }),
    recovery: "Use msb_config_get to inspect constraints and msb_config_set to propose supported repairs, even while blocked. Diagnostics cannot repair anything; msb_config_set requires explicit approval. Invalid syntax may require manual host repair. Workspace identity failure requires host working-directory repair and Pi restart before editing. Never automatically disable protection or enable host fallback.",
    notPerformed: ["commands", "source reads", "environment reads", "credential resolution", "SDK loading", "logs/stdout", "health", "installation", "network", "virtualization", "credential validity", "writes", "repairs"],
  };
}
function result(report: Record<string, unknown>, format: "text" | "json" = "text") {
  const details = boundDiagnosticsReport(report);
  const text = (format === "text" ? "Microsandbox diagnostics (passive, read-only)\n" : "") + JSON.stringify(details, null, 2);
  return { content: [{ type: "text" as const, text }], details };
}

export function registerDiagnosticsTool(pi: ExtensionAPI, control: MsbControl): void {
  pi.registerTool({
    name: "msb_diagnostics", label: "Microsandbox diagnostics",
    description: "Passive read-only diagnostics available even when off or blocked. Only already held state and cached safe configuration projections; no settings inspection, source/environment reads, commands, SDK, logs, credential resolution, live checks, bootstrap or writes. Start here and use msb_config_get before explaining a narrow live diagnostic need and requesting one explicitly approved host bash command (finite positive timeout <=120 seconds, fixed session cwd, ready identity/configuration and existing host permission required). Never disable protection or enable fallback as a workaround. Optional format=text/json only. Both text and details bounded to 48 KiB; no overflow files.",
    parameters,
    renderCall() { return new Text("Microsandbox diagnostics (passive, read-only)", 0, 0); },
    renderResult() { return new Text("Passive diagnostics; no live checks or changes. See tool content for results.", 0, 0); },
    async execute(_id, params) {
      try {
        if (!params || typeof params !== "object" || Array.isArray(params)
          || Reflect.ownKeys(params).some((key) => key !== "format")
          || Object.hasOwn(params, "format") && params.format !== "text" && params.format !== "json") {
          return result({ outcome: "rejected" });
        }
        if (!control.getDiagnostics) return result({ outcome: "unavailable" }, params.format);
        return result(await control.getDiagnostics(), params.format);
      } catch {
        return result({ outcome: "unavailable" });
      }
    },
  });
}
