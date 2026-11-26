import { isIP } from "node:net";

/** Exact domain input contract shared by network destinations and credential scopes. */
export const EXACT_DOMAIN_PATTERN = "^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?![\\s\\S])";
export const EXACT_DOMAIN_SCHEMA = {
  type: "string", minLength: 1, maxLength: 253, pattern: EXACT_DOMAIN_PATTERN,
  description: "Exact ASCII DNS name (punycode for international names). No wildcard, implicit subdomains, scheme, path, port, whitespace or trailing dot. IP/CIDR rules are network-only.",
};
const exactDomain = new RegExp(EXACT_DOMAIN_PATTERN);
export function isExactDomain(value: unknown): value is string {
  return typeof value === "string" && value.length <= 253 && !isIP(value) && exactDomain.test(value);
}
/** Secret-only wildcard scopes use a single leading "*." and a valid DNS suffix. */
export const SECRET_HOST_SCHEMA = {
  anyOf: [
    EXACT_DOMAIN_SCHEMA,
    { ...EXACT_DOMAIN_SCHEMA, maxLength: 255, pattern: EXACT_DOMAIN_PATTERN.replace("^", "^\\*\\."),
      description: "Wildcard secret destination, e.g. *.googleapis.com. Only a single leading *. is supported; not a network grant." },
  ],
  description: "Exact ASCII DNS name or wildcard subdomain scope such as *.googleapis.com. No URLs, ports or IP/CIDR rules.",
};
export function isSecretHost(value: unknown): value is string {
  return isExactDomain(value) || typeof value === "string" && value.startsWith("*.") && isExactDomain(value.slice(2));
}
export function networkDestinationKind(value: unknown): "domain" | "ip" | "cidr" | null {
  if (typeof value !== "string") return null;
  if (isIP(value)) return "ip";
  if (value.includes("/")) {
    const [address, prefix, extra] = value.split("/");
    const version = isIP(address!);
    return extra === undefined && version && /^\d+$(?![\s\S])/.test(prefix ?? "") && Number(prefix) <= (version === 4 ? 32 : 128) ? "cidr" : null;
  }
  return isExactDomain(value) ? "domain" : null;
}
