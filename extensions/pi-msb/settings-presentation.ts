/** Display-only aliases keep historical reviews and resolver IDs on the scope labels. */
export const settingsSourceLabel = (source: unknown): string => ({ global: "Global", "host-default": "Global", project: "Project", "host-project": "Project", session: "Session", ephemeral: "Session", temporary: "Session", env: "environment", defaults: "default" }[String(source)] ?? String(source));
/** Strip terminal controls from every external label, log, path and value. */
export const safeText = (value: unknown): string => String(value ?? "").replace(/\x1b\][^\x07]*(?:\x07|$)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\p{Cc}\p{Cf}]/gu, " ");
