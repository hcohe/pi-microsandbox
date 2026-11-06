import { ConfigError, normalizeConfigPath } from "./config.ts";
import { SETTINGS_PATHS } from "./settings.ts";
import { settingsSchema } from "./settings-schema.ts";

export interface ValidationProblem {
  code: string;
  /** Zero-based in the submitted operations array; 0 for a single operation. null means no unique operation can be blamed. */
  operationIndex: number | null;
  path?: string;
  relatedOperations?: number[];
  expected: string;
  expectedSchema?: unknown;
}
export class SettingsValidationError extends Error {
  readonly problems: ValidationProblem[];
  constructor(problems: ValidationProblem[]) { super("Invalid settings proposal"); this.problems = problems; }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function operationProblem(index: number, input: unknown, code = "invalid_operation", expected?: string): ValidationProblem {
  const path = object(input) && typeof input.path === "string" && SETTINGS_PATHS.includes(input.path) ? input.path : undefined;
  const schema = path ? settingsSchema()[path] as Record<string, any> : undefined;
  return { code, operationIndex: index, ...(path ? { path } : {}),
    expected: expected ?? "Use path/operation and only the required operation-specific arguments. Network domains require exact DNS names; secret hosts also accept a single leading *. wildcard. IP/CIDR rules are network-only. Secrets require exactly one of hostEnv (variable NAME only) or hostCmd (human-authorized HOST command text). textValue literal credentials are forbidden, including placeholders. Upsert permits at most one supplied source; omit both to retain the selected existing source privately, including a literal. Getters, previews and saves never resolve sources or execute commands.",
    ...(schema ? { expectedSchema: object(input) && input.operation === "upsert" ? schema.upsertSchema ?? schema.valueSchema : schema.valueSchema } : {}),
  };
}

/** Translate only whitelisted issue prefixes into static diagnostics. Never expose error messages, input values, identities or secret sources. */
export function diagnoseConfigError(error: unknown, operations: Array<{ path: string }>): ValidationProblem[] | undefined {
  if (!(error instanceof ConfigError)) return undefined;
  const schemas = settingsSchema() as Record<string, any>;
  return error.issues.slice(0, 32).map((issue) => {
    const match = /^([A-Za-z_][A-Za-z0-9_.]*)(?:\[\d+\])?(?:\.[A-Za-z_][A-Za-z0-9_]*)?:/.exec(issue);
    let path: string | undefined;
    if (match) {
      const canonical = normalizeConfigPath(match[1]!).map((part) => part.replace(/MiB/g, "Mib").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)).join(".");
      if (SETTINGS_PATHS.includes(canonical) || canonical === "network") path = canonical;
    }
    const related = path ? operations.flatMap((operation, index) => operation.path === path || path === "network" && operation.path.startsWith("network.") ? [index] : []) : [];
    const schema = path ? schemas[path] : undefined;
    const secretDomain = path === "secrets" && issue.includes("must contain exact DNS names");
    return { code: secretDomain ? "invalid_domain" : path === "network" ? "cross_field_constraint" : path ? "invalid_value" : "candidate_validation_failed",
      operationIndex: related.length === 1 ? related[0]! : null,
      ...(path ? { path } : {}), ...(related.length > 1 ? { relatedOperations: related } : {}),
      expected: secretDomain ? "Secret allowHosts requires exact ASCII DNS names or wildcard subdomain scopes such as *.googleapis.com (single leading *. only). No URLs, ports, trailing dots or IP/CIDR rules."
        : path === "network" ? "allowlist requires at least one allowed destination or allow_dns=true. Check the final candidate, including inherited settings."
        : schema ? `${schema.description} ${schema.constraints ?? "Check the advertised value schema and inherited/shadowed configuration; dynamic mount/source/security validation still applies without resolving secret sources."}`
        : "A complete valid candidate, safe mounts/secret sources and readable unchanged policy sources are required. The failure could not be attributed safely to one operation; inspect settings before retrying.",
      ...(schema ? { expectedSchema: schema.valueSchema } : {}),
    };
  });
}
export function validationMessage(problems: ValidationProblem[]): string {
  return problems.map((problem) => `${problem.operationIndex === null ? "Final candidate" : `Operation ${problem.operationIndex + 1}`} ${problem.path ? `(${problem.path}) ` : ""}[${problem.code}]: ${problem.expected}`).join("\n");
}
