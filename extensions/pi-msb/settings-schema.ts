import { DEFAULT_CONFIG, normalizeConfigPath } from "./config.ts";
import { SETTINGS_FIELDS, valueAt } from "./settings-fields.ts";
import { COLLECTION_REMOVALS, LIVE_SETTINGS_KEYS } from "./settings.ts";
import { EXACT_DOMAIN_SCHEMA, SECRET_HOST_SCHEMA, networkDestinationKind } from "./network-domains.ts";
import { DNS_EXCEPTION_WARNING, NETWORK_IDENTITY_WARNING, SESSION_LIFETIME } from "./settings-safety.ts";

export const MAX_SETTINGS_OPERATIONS = 64;
const scopes = ["session", "project", "global"];
const nonempty = { type: "string", minLength: 1 };
const strings = { type: "array", items: nonempty };
const secretEntry = {
  type: "object", additionalProperties: false, required: ["env", "allowHosts"],
  oneOf: ["hostEnv", "hostCmd"].map((source) => ({ required: [source] })),
  description: "Agent-writable sources are hostEnv (variable NAME only) and hostCmd (command text). Literal textValue credentials are forbidden, including masked placeholders; use host configuration or the native editor for literals.",
  properties: {
    env: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$", description: "Environment name; protected process-control names are forbidden." },
    allowHosts: { type: "array", items: SECRET_HOST_SCHEMA, minItems: 1, description: "Exact domains or wildcard subdomain scopes such as *.googleapis.com (single leading *. only). Credential injection destinations, NOT additional network grants. TLS identity is required." },
    hostEnv: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$", description: "Readable/writable host environment variable NAME only, never its resolved value. Never resolved by getters, previews or saves." },
    hostCmd: { type: "string", pattern: "\\S", description: "Readable/writable command text: explicit human-authorized shell code on the HOST with Pi's privileges. Executed only when activating secrets, never by getters, previews or saves." },
  },
};
const mountEntry = {
  type: "object", additionalProperties: false, required: ["type", "guestPath", "readonly", "options"],
  properties: {
    type: { type: "string", enum: ["dir", "file", "named", "tmpfs"] },
    hostPath: { type: "string", description: "Absolute host path for dir/file, volume name for named; optional for tmpfs." },
    guestPath: { type: "string", pattern: "^/", description: "Absolute, nonoverlapping guest path; workspace, /tmp, system and Docker runtime paths are protected." },
    readonly: { type: "boolean" }, options: { type: "array", items: { type: "string", enum: ["noexec", "nosuid", "nodev"] } },
  },
};
const overrides: Record<string, Record<string, unknown>> = {
  image: nonempty, lock_dir: { type: "string", pattern: "\\S" },
  cpus: { type: "number", minimum: 1, maximum: 64 }, memory_mib: { type: "number", minimum: 128 },
  idle_timeout_sec: { type: "number", minimum: 0 }, stop_timeout_ms: { type: "number", minimum: 1 }, replace_timeout_ms: { type: "number", minimum: 1 },
  "docker.startup_timeout_ms": { type: "integer", minimum: 1, maximum: 300000 },
  sandbox_name: { type: ["string", "null"], description: "null selects automatic naming in Session only. In Project/Global use inherit for automatic naming." },
  route_tools: { type: "array", items: { type: "string", enum: [...DEFAULT_CONFIG.routeTools] } },
  "network.allow_hosts": { ...strings, description: "Exact DNS names, plus network-only IP/CIDR rules. No wildcards, URLs or ports." },
  secrets: { type: "array", items: secretEntry }, mounts: { type: "array", items: mountEntry },
};

/** Static discovery only: no configured values, credential resolution, SDK import or filesystem access. */
export function settingsSchema(): Record<string, unknown> {
  return Object.fromEntries(SETTINGS_FIELDS.map((field) => {
    const initial = valueAt(DEFAULT_CONFIG, field.path);
    const valueSchema: Record<string, unknown> = overrides[field.path] ?? (field.choices ? {
      type: [...new Set(field.choices.map((choice) => typeof choice))], enum: [...field.choices],
    } : Array.isArray(initial) ? strings : { type: typeof initial });
    const collection = !!COLLECTION_REMOVALS[field.path];
    return [field.path, {
      description: field.path === "secrets" ? "Destination-scoped secret injection. Agents may read/write hostEnv names and hostCmd text, never literal textValue credentials. Metadata-only upserts may retain an existing literal privately." : field.description, valueSchema, scopes,
      operations: collection ? ["set", "inherit", "upsert", "remove"] : ["set", "inherit"],
      effect: LIVE_SETTINGS_KEYS.includes(normalizeConfigPath(field.path)[0] as typeof LIVE_SETTINGS_KEYS[number]) ? "live" : "restart",
      ...(field.choiceHelp ? { choices: field.choiceHelp } : {}),
      ...(collection ? {
        collection: "set replaces the entire list; [] clears it. upsert/remove preserve unrelated scope siblings. Entries use camelCase keys.",
        identity: field.path === "secrets" ? "env" : field.path === "mounts" ? "normalized guestPath" : "exact list string",
        upsertSchema: field.path === "secrets" ? { ...secretEntry,
          oneOf: [...secretEntry.oneOf, { not: { anyOf: secretEntry.oneOf } }],
          description: "Supply at most one source: hostEnv or hostCmd. Omitting both retains the selected existing source privately, including a literal; a new entry requires a source. Never supply textValue, including placeholders.",
        }
          : field.path === "mounts" ? mountEntry : valueSchema.items,
      } : {}),
      ...(field.path === "network.allow_hosts" ? { semantics: networkSemantics.hostMatching } : {}),
      ...(field.path === "network.publish_ports" ? { constraints: "PORT, HOST:PORT or IP:HOST:PORT; ports 1–65535. Default bind is 127.0.0.1. Independent of Docker's inner port mapping." } : {}),
      ...(field.path === "network.mode" ? { constraints: "allowlist requires at least one host or allow_dns=true; only the final batch candidate is validated." } : {}),
      ...(field.path === "host_env" ? { constraints: "Names only, never values; protected process-control variables are forbidden. Forwarding requires expose_session_environment=true." } : {}),
      ...(field.path === "mounts" ? { constraints: "Host paths and ancestors must pass canonical/symlink/socket/workspace and host-policy protection checks; writable mounts expose host files." } : {}),
    }];
  }));
}

export const networkSemantics = {
  modes: {
    default: "Leave the Microsandbox SDK's default network policy in place. allow_hosts and allow_dns do not override that policy.",
    open: "Explicit SDK allow-all policy, including private/host access. allow_hosts and allow_dns do not restrict it.",
    allowlist: "Default-deny egress and ingress; add configured outbound destination rules and optionally a DNS rule.",
    deny: "Disable networking. Hosts and DNS permission do not reopen it.",
  },
  hostMatching: {
    dnsNames: "Exact SDK Domain match against a cached hostname for the remote IP; no automatic subdomains or apex expansion. DNS resolution/cache matters; this is not HTTP URL filtering.",
    wildcards: "Rejected in network.allow_hosts; enumerate exact domains. Secret allowHosts accepts a single leading *. for wildcard subdomain scopes, e.g. *.googleapis.com, via SDK allowHostPattern. Add the apex separately if needed; secret scopes never grant network access.",
    domainFormat: EXACT_DOMAIN_SCHEMA,
    addresses: "Network-only IPv4/IPv6 addresses use SDK Ip; CIDR rules use SDK Cidr. Secret destinations must be exact DNS names or wildcard subdomain scopes, not IP/CIDR rules.",
    protocolsAndPorts: "Host rules add no protocol or port restriction (SDK defaults); not HTTPS-only. URL schemes, paths and host:port are not supported selectors.",
  },
  dns: "Only allowlist with allow_dns=true adds a separate TCP+UDP port 53 rule to the SDK Host destination. This DNS exception is separate from allowed service hosts; it is not a guarantee of DNS confidentiality.",
  secrets: "Secret allowHosts constrain TLS-verified credential substitution, not egress authorization. They are not merged into network.allow_hosts; an out-of-list secret destination is not a network exception. Restricting networking does not require clearing unrelated secrets.",
  publishedPorts: "Configured mappings are forwarded separately; default bind is loopback. Non-loopback binds can expose guest services. Nested containers remain behind the VM's outer network boundary.",
};

export const settingsCapabilities = {
  version: 5, scopes, sessionLifetime: SESSION_LIFETIME,
  inspection: { sections: ["summary", "desired", "layers", "origins", "runtime", "schema", "capabilities", "policy", "warnings"],
    paths: "Supported leaves or network/docker groups; filters apply to setting-shaped sections. Policy/summary retain complete safety context.",
    format: "Human-readable text by default; json is indented. Structured details contain the selected JSON. Use knownSchemaVersion to omit unchanged schemas/capabilities.",
  }, discovery: "settingsSchema describes set values and native upsert entry shapes; supportedPaths remains the leaf inventory.",
  mutation: {
    tool: "msb_config_set", approval: "Fresh explicit No-first approval, including no-op; interactive TUI/RPC only.",
    single: "scope plus path/operation and operation-specific arguments",
    batch: { field: "operations", minItems: 1, maxItems: MAX_SETTINGS_OPERATIONS, sameScope: true, ordered: true,
      atomicSettingsCommit: true, approvals: 1, maxReloads: 1,
      semantics: "Mutually exclusive with top-level operation fields. All operations share one private draft. Validate the final candidate, review all changes together, then commit once and reload once. Invalid/cancelled/stale proposals do not partially commit. No intermediate candidate is adopted.",
      limitations: "Persistence and VM activation are separate, not a distributed transaction. Reload may fail after saving; no automatic rollback or retry. Existing bounded filesystem race/I/O guarantees still apply.",
      example: { scope: "session", operations: [
        { path: "network.allow_hosts", operation: "set", value: ["registry.npmjs.org", "github.com", "api.github.com", "codeload.github.com", "raw.githubusercontent.com"] },
        { path: "network.mode", operation: "set", value: "allowlist" },
      ] },
    },
  },
  validation: "Schema constraints are discoverable, not an authorization bypass. The resolver also validates cross-field, sparse-layer, filesystem and security constraints at preview and commit. effect is conservative; preview determines actual runtime impact.",
  network: networkSemantics,
};

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** Consume ONLY the agent-safe inspection/adoption projection, never raw Config or credentials. */
export function effectiveNetworkPolicy(settings: unknown): Record<string, unknown> | null {
  if (!object(settings) || !object(settings.network)) return null;
  const network = settings.network;
  if (typeof network.mode !== "string" || !Object.hasOwn(networkSemantics.modes, network.mode)
    || !stringList(network.allow_hosts) || typeof network.allow_dns !== "boolean" || !stringList(network.publish_ports)) return null;
  const mode = network.mode as keyof typeof networkSemantics.modes;
  const allowlist = mode === "allowlist";
  return {
    mode, summary: networkSemantics.modes[mode],
    egress: mode === "deny" ? "disabled" : allowlist ? "default-deny" : mode === "open" ? "allow-all" : "sdk-default",
    ingress: mode === "deny" ? "disabled" : allowlist ? "default-deny; published mappings configured separately" : mode === "open" ? "allow-all" : "sdk-default",
    allowedDestinations: allowlist ? network.allow_hosts.map((host) => ({ host,
      matcher: networkDestinationKind(host) === "cidr" ? "sdk-cidr" : networkDestinationKind(host) === "ip" ? "sdk-ip" : "sdk-domain-exact",
    })) : [],
    dns: { configured: network.allow_dns, explicitRule: allowlist && network.allow_dns ? { destination: "sdk-host", protocols: ["tcp", "udp"], port: 53 } : null },
    publishedPorts: network.publish_ports,
    secretInjection: {
      grantsNetworkAccess: false,
      destinations: Array.isArray(settings.secrets) ? settings.secrets.flatMap((entry) => object(entry) && typeof entry.env === "string" && stringList(entry.allow_hosts)
        ? [{ env: entry.env, allowHosts: entry.allow_hosts }] : []) : null,
      note: networkSemantics.secrets,
    },
    warnings: [
      ...(allowlist ? [NETWORK_IDENTITY_WARNING] : []),
      ...(allowlist && network.allow_dns ? [DNS_EXCEPTION_WARNING] : []),
      ...(allowlist && network.allow_hosts.some((host) => /[*?]/.test(host)) ? ["Last-known network policy contains legacy wildcard entries; these are rejected on the next configuration validation. Enumerate exact domains."] : []),
      ...(network.publish_ports.length ? ["Published ports are separate inbound exposure; review bind addresses."] : []),
    ],
  };
}
