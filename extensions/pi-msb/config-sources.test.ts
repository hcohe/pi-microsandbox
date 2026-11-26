import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { legacyConfigSources, resolveConfig, type ResolveConfigInput } from "./config.ts";
import { SettingsEditor } from "./settings.ts";

const base: ResolveConfigInput = { cwd: "/workspace", env: {}, projectTrusted: false, configDirName: ".pi" };

for (const [name, options, directory] of [
  ["OS home fallback", {}, join(homedir(), ".config")],
  ["environment home", { env: { HOME: "/environment-home" } }, "/environment-home/.config"],
  ["explicit home", { homedir: "/explicit-home", env: { HOME: "/environment-home" } }, "/explicit-home/.config"],
  ["environment XDG", { env: { HOME: "/environment-home", XDG_CONFIG_HOME: "/environment-xdg" } }, "/environment-xdg"],
  ["explicit XDG", { xdgConfigHome: "/explicit-xdg", env: { XDG_CONFIG_HOME: "/environment-xdg" } }, "/explicit-xdg"],
] as const) test(`legacy source discovery uses ${name}`, () => {
  assert.deepEqual(legacyConfigSources({ ...base, ...options }), [{ name: "legacy", path: join(directory, "pi-msb", "config.toml") }]);
});

for (const [file, expected] of [
  ["policy.toml", "/workspace/policy.toml"], ["../policy.toml", "/policy.toml"],
  ["/host/policy.toml", "/host/policy.toml"], ["/host/../policy.toml", "/host/../policy.toml"],
]) test(`environment policy source preserves resolver path semantics: ${file}`, () => {
  const sources = legacyConfigSources({ ...base, env: { PI_MSB_CONFIG_FILE: file } });
  assert.deepEqual(sources.map((source) => source.name), ["legacy", "environment file"]);
  assert.equal(sources[1]!.path, expected);
});

test("recovery inspects the same OS-home legacy source as resolution when HOME is absent", async (t) => {
  const root = await realpath(await mkdtemp("/tmp/pi-msb-source-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const legacy = join(homedir(), ".config", "pi-msb", "config.toml");
  const reads: string[] = [];
  const input: ResolveConfigInput = {
    ...base, cwd, agentDir: join(root, "agent"),
    readFile: async (file) => { reads.push(file); return file === legacy ? "cpus = 0\n" : null; },
  };
  await assert.rejects(resolveConfig(input), /cpus/);
  reads.length = 0;
  const inspection = await new SettingsEditor(input, "source-discovery").inspect();
  const recovery = inspection.recovery as { configurationValid: boolean; issues: string[] };
  assert.equal(recovery.configurationValid, false);
  assert.ok(recovery.issues.some((issue) => issue.startsWith("legacy: cpus:")), JSON.stringify(recovery.issues));
  assert.ok(reads.filter((file) => file === legacy).length >= 2, "resolution and recovery must both inspect the OS-home source");
  assert.ok(reads.every((file) => file.startsWith("/")), "recovery must not invent a relative legacy path");
});
