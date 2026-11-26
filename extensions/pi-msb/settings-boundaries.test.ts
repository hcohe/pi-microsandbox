import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as metadata from "./settings-metadata.ts";
import * as effect from "./settings-effect.ts";
import { SettingsConflictError } from "./settings-conflict.ts";
import * as editor from "./settings.ts";
import { settingsCapabilities } from "./settings-schema.ts";
import { SETTINGS_SCHEMA_VERSION } from "./settings-inspection.ts";

test("settings public compatibility exports retain shared definitions and error identity", () => {
  assert.equal(editor.SETTINGS_PATHS, metadata.SETTINGS_PATHS);
  assert.equal(editor.COLLECTION_REMOVALS, metadata.COLLECTION_REMOVALS);
  assert.equal(editor.LIVE_SETTINGS_KEYS, effect.LIVE_SETTINGS_KEYS);
  assert.equal(editor.classifySettingsEffect, effect.classifySettingsEffect);
  assert.equal(editor.SettingsConflictError, SettingsConflictError);
  assert.equal(settingsCapabilities.version, metadata.SETTINGS_SCHEMA_VERSION);
  assert.equal(SETTINGS_SCHEMA_VERSION, metadata.SETTINGS_SCHEMA_VERSION);
});

for (const [names, strict] of [
  [["settings-json.ts", "settings-schema.ts", "settings-fields.ts", "settings-validation.ts", "settings-inspection.ts"], false],
  [["settings-effect.ts", "sandbox-manager.ts"], true],
] as const) test(`${names.join(", ")} do not import the settings editor${strict ? " or filesystem configuration" : ""}`, () => {
  const loader = `export async function resolve(specifier, context, nextResolve) {
    if (/settings(?:-storage)?\\.ts$/.test(specifier)
      || specifier === "microsandbox"
      || (${strict} && /(?:node:fs|config\\.ts$|@earendil-works)/.test(specifier))) {
      throw new Error("Unexpected settings dependency: " + specifier + " from " + context.parentURL);
    }
    return nextResolve(specifier, context);
  }`;
  const modules = names.map((name) => new URL(name, import.meta.url).href);
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", `
    import { register } from "node:module";
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);
    for (const url of ${JSON.stringify(modules)}) await import(url);
    console.log("settings module boundaries passed");
  `], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /settings module boundaries passed/);
});
