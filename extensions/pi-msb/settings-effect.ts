import type { Config } from "./types.ts";

export type SettingsEffect = "none" | "live" | "restart";
export const LIVE_SETTINGS_KEYS: readonly (keyof Config)[] = Object.freeze(["blockThirdParty", "routeTools", "passThroughTools", "allowHostExecution", "allowSkillReads", "fallbackMode", "showFooter", "autoStart"]);
const LIVE_FIELDS = new Set<string>(LIVE_SETTINGS_KEYS);
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** Conservative: only live routing/presentation and startup-only preferences avoid recreation. */
export function classifySettingsEffect(before: Config, after: Config): SettingsEffect {
  const changed = Object.keys(before).filter((key) => !equal(before[key as keyof Config], after[key as keyof Config]));
  return !changed.length ? "none" : changed.every((key) => LIVE_FIELDS.has(key)) ? "live" : "restart";
}
