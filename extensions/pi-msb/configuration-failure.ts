import { ConfigError } from "./config.ts";
import { diagnoseConfigError } from "./settings-validation.ts";

export interface ConfigurationFailureSnapshot {
  readonly kind: "validation" | "syntax" | "read" | "policy" | "unknown";
  readonly summary: string;
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
  const kind = issues.some((issue) => issue.startsWith("invalid TOML in ") || issue === "invalid raw configuration") ? "syntax"
    : issues.some((issue) => /^(?:host|global) configuration must be outside the mounted workspace\b/.test(issue)
      || issue === "writable host mounts must not expose host configuration"
      || issue === "host mounts must not expose Dockerfile or build-context sources") ? "policy"
    : issues.some((issue) => /^(?:host configuration|host-owned Dockerfile|host-owned loaded Dockerfile selection) (?:could not|ancestors could not|path could not)/.test(issue)) ? "read"
    : error instanceof ConfigError ? "validation" : "unknown";
  const problems = kind === "validation" ? (diagnoseConfigError(error, []) ?? []).map(({ code, path, expected, expectedSchema }) =>
    ({ code, ...(path ? { path } : {}), expected, ...(expectedSchema ? { expectedSchema } : {}) })) : [];
  const unique = [...new Map(problems.map((problem) => [JSON.stringify(problem), problem])).values()];
  let truncated = error instanceof ConfigError && error.issues.length > 32;
  // Bound the cached projection independently of the outer diagnostics envelope.
  while (Buffer.byteLength(JSON.stringify(unique)) > 16 * 1024) { unique.pop(); truncated = true; }
  const snapshot: ConfigurationFailureSnapshot = freeze(structuredClone({ kind, summary: summaries[kind], problems: unique, truncated,
    recovery: "Use msb_diagnostics and msb_config_get to inspect constraints, then request an explicitly approved msb_config_set repair. Syntax, unreadable sources and policy boundaries may require manual host repair. Reload after repair; never automatically disable protection or enable host fallback." }));
  snapshots.add(snapshot);
  return snapshot;
}

/** Branding survives both diagnostics bounds; arbitrary adapter objects do not. */
export function isConfigurationFailureSnapshot(value: unknown): value is ConfigurationFailureSnapshot {
  return !!value && typeof value === "object" && snapshots.has(value);
}

export function formatConfigurationFailure(snapshot: ConfigurationFailureSnapshot): string {
  const problems = snapshot.problems.slice(0, 3).map((problem) => `${problem.path ?? "Configuration"}: ${problem.expected}${problem.expectedSchema ? ` Expected schema: ${JSON.stringify(problem.expectedSchema)}` : ""}`);
  return [`Microsandbox configuration failed: ${snapshot.summary}`, ...problems,
    ...(snapshot.truncated || snapshot.problems.length > 3 ? ["More constraints are available in msb_diagnostics."] : []),
    "Configuration was not applied. A previously active VM may remain running; no automatic host fallback.", snapshot.recovery].join("\n");
}
