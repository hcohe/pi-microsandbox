import { ConfigError } from "./config.ts";
import { diagnoseConfigError } from "./settings-validation.ts";

export interface ConfigurationFailureSnapshot {
  readonly kind: "validation" | "syntax" | "read" | "policy" | "unknown";
  readonly summary: string;
  readonly workspaceOverlap?: true;
  readonly problems: readonly Readonly<{ code: string; path?: string; expected: string; expectedSchema?: unknown }>[];
  readonly truncated: boolean;
  readonly recovery: string;
}
const snapshots = new WeakSet<object>();
const summaries = {
  validation: "Configuration values failed validation.",
  syntax: "Configuration TOML syntax could not be parsed. Repair the syntax on the host before reloading.",
  read: "Host-owned configuration could not be read or safely inspected. Check host file access and path identity before reloading.",
  policy: "Configuration violates host-owned policy boundaries. Keep policy sources outside the mounted workspace and protected from writable mounts.",
  unknown: "Configuration resolution failed; unclassified error detail withheld. Inspect configuration and host policy sources before reloading.",
} as const;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Capture only static constraints and allowlisted field names, never rejected values,
 * parser prose, source paths or credentials (including those unknown to the old config).
 */
export function configurationFailureSnapshot(error: unknown): ConfigurationFailureSnapshot {
  const issues = error instanceof ConfigError ? error.issues.slice(0, 32) : [];
  const workspaceOverlap = issues.some((issue) => /^(?:host|global) configuration must be outside the mounted workspace\b/.test(issue));
  const kind = issues.some((issue) => issue.startsWith("invalid TOML in ") || issue === "invalid raw configuration") ? "syntax"
    : workspaceOverlap || issues.some((issue) => issue === "writable host mounts must not expose host configuration"
      || issue === "host mounts must not expose Dockerfile or build-context sources") ? "policy"
    : issues.some((issue) => /^(?:host configuration|host-owned Dockerfile|host-owned loaded Dockerfile selection) (?:could not|ancestors could not|path could not)/.test(issue)) ? "read"
    : error instanceof ConfigError ? "validation" : "unknown";
  const problems = kind === "validation" ? (diagnoseConfigError(error, []) ?? []).map(({ code, path, expected, expectedSchema }) =>
    ({ code, ...(path ? { path } : {}), expected, ...(expectedSchema ? { expectedSchema } : {}) })) : [];
  const unique = [...new Map(problems.map((problem) => [JSON.stringify(problem), problem])).values()];
  let truncated = error instanceof ConfigError && error.issues.length > 32;
  // Bound the cached projection independently of the outer diagnostics envelope.
  while (Buffer.byteLength(JSON.stringify(unique)) > 16 * 1024) { unique.pop(); truncated = true; }
  const snapshot: ConfigurationFailureSnapshot = freeze(structuredClone({ kind, summary: summaries[kind],
    ...(kind === "policy" && workspaceOverlap ? { workspaceOverlap: true as const } : {}), problems: unique, truncated,
    recovery: "Use msb_diagnostics and msb_config_get to inspect constraints, then request an explicitly approved msb_config_set repair. Syntax, unreadable sources and policy boundaries may require manual host repair. Reload after repair; never automatically disable protection or enable host fallback." }));
  snapshots.add(snapshot);
  return snapshot;
}

/** Branding survives both diagnostics bounds; arbitrary adapter objects do not. */
export function isConfigurationFailureSnapshot(value: unknown): value is ConfigurationFailureSnapshot {
  return !!value && typeof value === "object" && snapshots.has(value);
}

const warningReasons = {
  validation: "One or more settings need a different value.",
  syntax: "There’s a TOML syntax problem in the settings file.",
  read: "Microsandbox couldn’t safely read its settings on the host.",
  policy: "These settings could expose files that control what the sandbox can access. If code inside the sandbox can change those files, it could grant itself access you didn’t approve.",
  unknown: "Microsandbox couldn’t verify these settings.",
} as const;

const repairSteps = {
  validation: "Use msb_config_set to review and approve a fix.",
  syntax: "Fix the TOML syntax on the host, then reload.",
  read: "Check that the settings files are readable on the host, then reload.",
  policy: "Keep sandbox settings and image build files on the host, outside the workspace and any folders shared with the sandbox. Then reload.",
  unknown: "Check the settings on the host and reload once they’re fixed.",
} as const;

export function formatConfigurationFailure(snapshot: ConfigurationFailureSnapshot): string {
  const problems = snapshot.problems.slice(0, 3).map(({ path, expected }) => `  • ${path ?? "Configuration"}: ${expected}`);
  return [
    "Microsandbox didn’t apply these settings",
    "",
    warningReasons[snapshot.kind],
    ...problems,
    "",
    "You can keep using Pi. An already-running sandbox can continue with its previous settings. If there’s no sandbox running, sandboxed tools won’t run until this is fixed. Tools won’t automatically run on your host instead.",
    "",
    `What to do: Check msb_diagnostics and msb_config_get for details. ${repairSteps[snapshot.kind]}`,
  ].join("\n");
}
