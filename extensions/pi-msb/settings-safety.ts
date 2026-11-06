/** Public safety guidance: static text only, never configured values or credentials. */
export const HOST_SECRET_COMMAND_WARNING = "This secret source executes a shell command on the HOST, outside the sandbox, when secrets are activated. Command text is agent-readable; resolved credentials remain private. Explicit human authorization is required.";
export const SESSION_LIFETIME_WARNING = "Session overrides are memory-only. Pi /reload, session/workspace changes and shutdown clear them; inherited defaults return and may allow broader access. Settings reload does not clear them. Choose Project or Global explicitly to persist a change.";
export const NETWORK_IDENTITY_WARNING = "Network allowlists use DNS/IP state, not per-request URL or TLS-hostname authorization. Shared IPs and DNS cache state matter; destination rules are not HTTPS-only.";
export const DNS_EXCEPTION_WARNING = "DNS is a separate TCP/UDP port 53 exception to the runtime host, not a service-domain allowlist or a guarantee against DNS exfiltration.";
export const RECONNECTED_POLICY_WARNING = "This VM was reconnected, not created under this integration's verified configuration. Its network settings were not read back, so adopted network policy is unknown; desired settings are not proof of enforcement.";
export const POLICY_VERIFICATION_GUIDANCE = "Use sandbox connectivity probes for specific destinations (not proof of the entire policy), or explicitly approve a network-setting change that recreates the VM for a known adoption snapshot. Inspection never restarts the VM. Do not use live-only or no-op edits as network verification.";
export const SESSION_LIFETIME = {
  storage: "memory-only", clearedBy: ["Pi /reload", "session/workspace identity change", "shutdown"],
  preservedBy: ["settings reload"], persistentScopes: ["project", "global"],
  warning: SESSION_LIFETIME_WARNING,
};
