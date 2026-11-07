import { DEFAULT_CONFIG } from "./config.ts";

/** Static discovery version shared by schema capabilities and inspection. */
export const SETTINGS_SCHEMA_VERSION = 5;
const snake = (key: string): string => key.replace(/MiB/g, "Mib").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
/** Complete schema leaf inventory. Arrays are edited as collections, never indexed paths. */
export const SETTINGS_PATHS: readonly string[] = Object.freeze(Object.entries(DEFAULT_CONFIG).flatMap(([key, value]) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).map((child) => `${snake(key)}.${snake(child)}`) : [snake(key)]));
/** A deliberate authoritative collection edit wins over conflicting removals in that same scope. */
export const COLLECTION_REMOVALS: Readonly<Record<string, string>> = Object.freeze({
  route_tools: "remove_route_tools", pass_through_tools: "remove_pass_through_tools",
  host_env: "remove_host_env",
  secrets: "remove_secrets", mounts: "remove_mounts",
  "network.allow_hosts": "network.remove_allow_hosts", "network.publish_ports": "network.remove_publish_ports",
});
