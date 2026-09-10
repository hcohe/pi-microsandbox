import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CONFIG,
  ConfigError,
  applyOverride,
  isDisabledByEnv,
  mergeConfigLayers,
  overridesToToml,
  parseEnvConfig,
  parseTomlConfig,
  removeOverride,
  resolveConfig,
  resolveSecretValue,
  toEffectiveToml,
  validateConfig,
} from "./config.ts";

const layer = (name: "global" | "project" | "env" | "cli", value: any) => ({ name, value, warnings: [] });

test("defaults and precedence are deterministic", async () => {
  assert.equal(DEFAULT_CONFIG.mode, "direct");
  assert.equal(DEFAULT_CONFIG.image, "ghcr.io/hcohe/pi-microsandbox:latest");
  assert.equal(DEFAULT_CONFIG.bootstrapTools, "auto");
  assert.equal(DEFAULT_CONFIG.showFooter, true);
  const files = new Map([
    ["/cfg/pi-msb/config.toml", "memory_mib = 1024\nroute_tools = [\"read\", \"bash\"]"],
    ["/repo/.pi-msb.toml", "memory_mib = 2048\nnetwork.mode = \"deny\""],
  ]);
  const result = await resolveConfig({
    cwd: "/repo/src", repoRoot: "/repo", projectTrusted: true, configDirName: "pi",
    xdgConfigHome: "/cfg", env: { PI_MSB_MEMORY_MIB: "3072" },
    readFile: async (path) => files.get(path) ?? null,
    exists: async (path) => files.has(path),
  });
  assert.equal(result.config.memoryMiB, 3072);
  assert.equal(result.config.network.mode, "deny");
  assert.deepEqual(result.config.routeTools, DEFAULT_CONFIG.routeTools);
  assert.equal(result.provenance.memoryMiB, "env");
  assert.equal(result.config.volumeQuotaMiB, 2048);
  assert.deepEqual(result.config.passThroughTools, ["todo", "ask_user_question", "web_search", "source_check", "fetch_content"]);
});

test("untrusted project configuration is skipped", async () => {
  const result = await resolveConfig({
    cwd: "/repo", repoRoot: "/repo", projectTrusted: false, configDirName: "pi", env: {},
    exists: async (path) => path === "/repo/.pi-msb.toml",
    readFile: async (path) => path === "/repo/.pi-msb.toml" ? "memory_mib = 9999" : null,
  });
  assert.equal(result.config.memoryMiB, DEFAULT_CONFIG.memoryMiB);
  assert.match(result.warnings.join("\n"), /not trusted/);
});

test("identity arrays replace and remove safely", () => {
  const value = mergeConfigLayers([
    { name: "defaults", value: DEFAULT_CONFIG, warnings: [] },
    layer("global", { secrets: [{ env: "TOKEN", value: "$ENV:A", allowHosts: ["a"] }], mounts: [{ type: "dir", hostPath: "/a", guestPath: "/mnt/data", readonly: true, options: [] }] }),
    layer("cli", { removeSecrets: ["TOKEN"], mounts: [{ type: "dir", hostPath: "/b", guestPath: "/mnt/data", readonly: false, options: [] }] }),
  ]);
  assert.deepEqual(value.value.secrets, []);
  assert.equal((value.value.mounts as any[])[0].hostPath, "/b");
});

test("nested network removal controls parse without unknown-key warnings", () => {
  const toml = parseTomlConfig('[network]\nremove_allow_hosts = ["api.example"]\nremove_publish_ports = ["8080:80"]', "global");
  assert.deepEqual(toml.warnings, []);
  assert.deepEqual((toml.value.network as any).removeAllowHosts, ["api.example"]);
  assert.deepEqual((toml.value.network as any).removePublishPorts, ["8080:80"]);
  const malformedToml = parseTomlConfig('[network]\nremove_allow_hosts.foo = ["api.example"]', "global");
  assert.ok(malformedToml.warnings.some((warning) => warning.includes("network.removeAllowHosts.foo")));
  const env = parseEnvConfig({
    PI_MSB_NETWORK__REMOVE_ALLOW_HOSTS: "api.example:registry.example",
    PI_MSB_NETWORK__REMOVE_PUBLISH_PORTS: '["8080:80"]',
  });
  assert.deepEqual(env.warnings, []);
  assert.deepEqual((env.value.network as any).removeAllowHosts, ["api.example", "registry.example"]);
  assert.deepEqual((env.value.network as any).removePublishPorts, ["8080:80"]);
  const malformedEnv = parseEnvConfig({ PI_MSB_NETWORK__REMOVE_ALLOW_HOSTS__FOO: "api.example" });
  assert.ok(malformedEnv.warnings.some((warning) => warning.includes("network.removeAllowHosts.foo")));
});

test("top-level network removal controls warn as unknown", () => {
  const toml = parseTomlConfig('remove_allow_hosts = ["api.example"]\nremove_publish_ports = ["8080:80"]', "global");
  assert.ok(toml.warnings.some((warning) => warning.includes("removeAllowHosts")));
  assert.ok(toml.warnings.some((warning) => warning.includes("removePublishPorts")));
  const env = parseEnvConfig({
    PI_MSB_REMOVE_ALLOW_HOSTS: "api.example",
    PI_MSB_REMOVE_PUBLISH_PORTS: '["8080:80"]',
  });
  assert.ok(env.warnings.some((warning) => warning.includes("removeAllowHosts")));
  assert.ok(env.warnings.some((warning) => warning.includes("removePublishPorts")));
});

test("object-form secret and mount removals are recognized", () => {
  const parsed = parseTomlConfig('remove_secrets = [{ env = "TOKEN" }]\nremove_mounts = [{ guest_path = "/mnt/data" }]', "global");
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual((parsed.value as any).removeSecrets, [{ env: "TOKEN" }]);
  assert.deepEqual((parsed.value as any).removeMounts, [{ guestPath: "/mnt/data" }]);
});

test("prototype-polluting keys are rejected at every config ingress", () => {
  const objectPrototype = Object.prototype as Record<string, unknown>;
  const isConfigError = (error: unknown) => error instanceof ConfigError;
  delete objectPrototype.piMsbPolluted;

  try {
    for (const toml of [
      "[__proto__]\npi_msb_polluted = true",
      'network = { __proto__ = { pi_msb_polluted = true } }',
      "[[mounts]]\nconstructor = {}",
      "prototype.value = true",
      '["__proto__"]\npi_msb_polluted = true',
    ]) {
      assert.throws(() => parseTomlConfig(toml, "project"), isConfigError);
      assert.equal(objectPrototype.piMsbPolluted, undefined);
    }

    assert.throws(() => parseEnvConfig({ PI_MSB_CONSTRUCTOR: "value" }), isConfigError);
    assert.throws(() => parseEnvConfig({ PI_MSB_NETWORK: '{"__proto__":{"piMsbPolluted":true}}' }), isConfigError);

    for (const value of [
      JSON.parse('{"__proto__":{"piMsbPolluted":true}}'),
      JSON.parse('{"network":{"constructor":{}}}'),
      JSON.parse('{"mounts":[{"prototype":{}}]}'),
      { network: { __proto__: { piMsbPolluted: true } } },
    ]) {
      assert.throws(() => mergeConfigLayers([layer("global", value)]), isConfigError);
      assert.throws(() => validateConfig(value), isConfigError);
      assert.equal(objectPrototype.piMsbPolluted, undefined);
    }

    assert.throws(() => applyOverride({}, "__proto__.pi_msb_polluted", true), isConfigError);
    assert.throws(() => applyOverride({}, "network", JSON.parse('{"constructor":{}}')), isConfigError);
    assert.throws(() => removeOverride(JSON.parse('{"prototype":{}}'), "network"), isConfigError);
    assert.throws(() => overridesToToml(JSON.parse('{"__proto__":{}}')), isConfigError);
    assert.equal(objectPrototype.piMsbPolluted, undefined);
  } finally {
    delete objectPrototype.piMsbPolluted;
  }
});

test("nested network removal controls remove only network allowlists", () => {
  const merged = mergeConfigLayers([
    { name: "defaults", value: DEFAULT_CONFIG, warnings: [] },
    layer("global", { network: { allowHosts: ["api.example", "registry.example"], publishPorts: ["8080:80", "127.0.0.1:9000:90"] } }),
    layer("cli", { network: { removeAllowHosts: ["api.example"], removePublishPorts: ["8080:80"] } }),
  ]);
  assert.deepEqual((merged.value.network as any).allowHosts, ["registry.example"]);
  assert.deepEqual((merged.value.network as any).publishPorts, ["127.0.0.1:9000:90"]);
  assert.equal((merged.value as any).allowHosts, undefined);
  assert.equal((merged.value as any).publishPorts, undefined);
  assert.equal(merged.provenance["network.allowHosts"], "cli");
  assert.equal(merged.provenance["network.publishPorts"], "cli");
});

test("mount defaults and canonical guest identity are stable", () => {
  const first = parseTomlConfig('mounts = [{ host_path = "/repo/data", guest_path = "/mnt/../mnt/data" }]', "global");
  const second = parseTomlConfig('mounts = [{ type = "dir", host_path = "/other", guest_path = "/mnt/data", readonly = false, options = ["noexec"] }]', "cli");
  const merged = mergeConfigLayers([{ name: "defaults", value: DEFAULT_CONFIG, warnings: [] }, first, second]);
  assert.equal((merged.value.mounts as any[]).length, 1);
  assert.deepEqual(merged.value.mounts?.[0], { type: "dir", hostPath: "/other", guestPath: "/mnt/data", readonly: false, options: ["noexec"] });
  const defaults = mergeConfigLayers([{ name: "defaults", value: DEFAULT_CONFIG, warnings: [] }, parseTomlConfig('mounts = [{ host_path = "/repo/data" }]', "global")]).value.mounts?.[0] as any;
  assert.deepEqual(defaults, { type: "dir", hostPath: "/repo/data", guestPath: "/repo/data", readonly: true, options: [] });
});

test("route fields reject unknown tools and the legacy host path env alias is accepted", async () => {
  assert.throws(() => validateConfig({ routeTools: ["read", "not-a-tool"] as any }), /routeTools/);
  const parsed = parseEnvConfig({ PI_MSB_HOST_RO_PATHS: "/repo/one,/repo/two" });
  assert.deepEqual(parsed.value.hostRoAllowlist, ["/repo/one", "/repo/two"]);
  const resolved = await resolveConfig({ cwd: "/repo", projectTrusted: true, configDirName: "pi", env: { PI_MSB_HOST_RO_PATHS: "/outside/one" }, readFile: async () => null, exists: async () => false, realpath: async (path) => path });
  assert.equal(resolved.config.mounts[0]?.readonly, true);
  assert.equal(resolved.config.mounts[0]?.guestPath, "/outside/one");
});

test("trusted project mounts use realpaths for repository containment", async () => {
  const rejected = resolveConfig({
    cwd: "/repo", repoRoot: "/repo", projectTrusted: true, configDirName: "pi", env: {},
    exists: async (path) => path === "/repo/.pi-msb.toml",
    readFile: async (path) => path === "/repo/.pi-msb.toml" ? 'mounts = [{ host_path = "/repo/link", guest_path = "/outside/mount", readonly = false }]' : null,
    realpath: async (path) => path === "/repo/link" ? "/outside/secret" : path,
  });
  await assert.rejects(rejected, (error: unknown) => error instanceof ConfigError && error.issues.some((issue) => issue.includes("outside the repository")));
  await assert.rejects(resolveConfig({
    cwd: "/repo", repoRoot: "/repo", projectTrusted: true, configDirName: "pi", env: {},
    exists: async (path) => path === "/repo/.pi-msb.toml",
    readFile: async (path) => path === "/repo/.pi-msb.toml" ? 'mounts = [{ host_path = "/repo/link", guest_path = "/outside/mount" }]' : null,
    realpath: async () => { throw new Error("cannot resolve"); },
  }), (error: unknown) => error instanceof ConfigError && error.issues.some((issue) => issue.includes("canonicalized")));
});

test("mounts cannot shadow reserved tmp or the project mount", async () => {
  assert.throws(() => validateConfig({ mounts: [{ type: "dir", hostPath: "/host", guestPath: "/tmp/work", readonly: true, options: [] }] }), /reserved \/tmp/);
  await assert.rejects(() => resolveConfig({
    cwd: "/repo", repoRoot: "/repo", projectTrusted: true, configDirName: "pi", env: {},
    cliOverridesToml: 'mounts = [{ host_path = "/host", guest_path = "/repo/sub" }]',
    readFile: async () => null, exists: async () => false,
  }), (error: unknown) => error instanceof ConfigError && error.issues.some((issue) => issue.includes("project mount")));
});

test("null secret and mount entries fail closed", () => {
  assert.throws(() => validateConfig({ secrets: [null] as any }), /secrets\[0\]/);
  assert.throws(() => validateConfig({ mounts: [null] as any }), /mounts\[0\]/);
});

test("validation reports all hard issues and mount overlap", () => {
  assert.throws(() => validateConfig({
    cpus: 0,
    network: { mode: "open", publishPorts: ["99999"], allowHosts: [], allowDns: true },
    mounts: [
      { type: "dir", hostPath: "/a", guestPath: "/mnt", readonly: true, options: [] },
      { type: "dir", hostPath: "/b", guestPath: "/mnt/sub", readonly: true, options: [] },
    ],
  }), (error: unknown) => error instanceof ConfigError && error.issues.length >= 3);
});

test("footer visibility is configurable and shown by default", () => {
  const toml = parseTomlConfig("show_footer = false", "global");
  assert.equal(toml.value.showFooter, false);
  assert.deepEqual(toml.warnings, []);

  const env = parseEnvConfig({ PI_MSB_SHOW_FOOTER: "false" });
  assert.equal(env.value.showFooter, false);
  assert.deepEqual(env.warnings, []);
  assert.throws(() => validateConfig({ showFooter: "yes" as any }), /showFooter: must be boolean/);
});

test("environment JSON, nesting, POSIX arrays, and controls", () => {
  const parsed = parseEnvConfig({
    PI_MSB_HOST_ENV: "PUBLIC_ONE:PUBLIC_TWO",
    PI_MSB_NETWORK__ALLOW_HOSTS: "api.example:registry.example",
    PI_MSB_NETWORK__MODE: "deny",
    PI_MSB_NETWORK__PUBLISH_PORTS: "[\"127.0.0.1:8080:80\"]",
    PI_MSB_DISABLE: "1",
    PI_MSB_CONFIG_FILE: "/secret/path",
  });
  assert.deepEqual(parsed.value.hostEnv, ["PUBLIC_ONE", "PUBLIC_TWO"]);
  assert.deepEqual((parsed.value.network as any).allowHosts, ["api.example", "registry.example"]);
  assert.equal((parsed.value.network as any).mode, "deny");
  assert.deepEqual((parsed.value.network as any).publishPorts, ["127.0.0.1:8080:80"]);
  assert.equal(parsed.warnings.length, 0);
  assert.equal(isDisabledByEnv({ PI_MSB_DISABLE: "true" }), true);
  assert.equal(isDisabledByEnv({ PI_MSB_DISABLE: "0" }), false);
});

test("effective TOML redacts literal secret values", () => {
  const config = validateConfig({ secrets: [{ env: "TOKEN", value: "do-not-print", allowHosts: ["api.example"] }] });
  const output = toEffectiveToml({ config, provenance: {}, warnings: [] });
  assert.doesNotMatch(output, /do-not-print/);
  assert.match(output, /<redacted>/);
  assert.match(toEffectiveToml({ config: validateConfig({ secrets: [{ env: "TOKEN", value: "$ENV:TOKEN", allowHosts: ["api.example"] }] }), provenance: {}, warnings: [] }), /\$ENV:TOKEN/);
});

test("table-array overrides round trip with valid TOML headers", () => {
  let overrides: any = applyOverride({}, "mounts", [
    { type: "dir", hostPath: "/host/one", guestPath: "/mnt/one", readonly: false, options: [] },
    { type: "file", hostPath: "/host/two", guestPath: "/mnt/two", readonly: true, options: ["noexec"] },
  ]);
  overrides = applyOverride(overrides, "remove_mounts", [{ guestPath: "/mnt/old" }]);
  overrides = applyOverride(overrides, "secrets", [{ env: "TOKEN", value: "$ENV:TOKEN", allowHosts: ["api.example"] }]);

  const toml = overridesToToml(overrides);
  assert.equal(toml.match(/^\[\[mounts\]\]$/gm)?.length, 2);
  assert.match(toml, /^\[\[remove_mounts\]\]$/m);
  assert.match(toml, /^\[\[secrets\]\]$/m);
  assert.deepEqual(parseTomlConfig(toml, "cli").value, overrides);
});

test("overrides round trip and secret references never leak on errors", async () => {
  const base = applyOverride({}, "network.publish_ports", ["8080"]);
  assert.deepEqual((base.network as any).publishPorts, ["8080"]);
  assert.deepEqual(removeOverride(base, "network.publish_ports"), { network: {} });
  assert.deepEqual(parseTomlConfig(overridesToToml(base), "cli").value, base);
  await assert.rejects(() => resolveSecretValue("$ENV:MISSING", {}), (error: unknown) => error instanceof ConfigError && !error.message.includes("MISSING"));
});

test("project-relative secret files use the canonical path approved by policy", async () => {
  const projectConfig = "/repo/packages/app/.pi-msb.toml";
  const referencedPath = "/repo/packages/app/secrets/token";
  const canonicalPath = "/repo/private/token";
  const result = await resolveConfig({
    cwd: "/repo/packages/app/src", repoRoot: "/repo", projectTrusted: true, configDirName: "pi", env: {},
    homedir: "/home/test", xdgConfigHome: "/cfg",
    exists: async (path) => path === projectConfig,
    readFile: async (path) => path === projectConfig
      ? '[[secrets]]\nenv="TOKEN"\nvalue="$FILE:secrets/token"\nallow_hosts=["api.example"]'
      : null,
    realpath: async (path) => path === referencedPath ? canonicalPath : path,
  });

  assert.equal(result.config.secrets[0]?.value, `$FILE:${canonicalPath}`);
  let readPath = "";
  assert.equal(await resolveSecretValue(result.config.secrets[0]!.value, {}, async (path) => {
    readPath = path;
    return "secret-value";
  }), "secret-value");
  assert.equal(readPath, canonicalPath);
});

test("trusted project literal secrets warn without leaking their value", async () => {
  const result = await resolveConfig({
    cwd: "/repo", repoRoot: "/repo", projectTrusted: true, configDirName: "pi", env: {},
    exists: async (path) => path === "/repo/.pi-msb.toml",
    readFile: async (path) => path === "/repo/.pi-msb.toml" ? '[[secrets]]\nenv="TOKEN"\nvalue="super-secret-literal"\nallow_hosts=["api.example"]' : null,
  });
  assert.ok(result.warnings.some((warning) => /literal secret/i.test(warning)));
  assert.doesNotMatch(result.warnings.join("\\n"), /super-secret-literal/);
});

test("open mode warning and empty secret host hard fail", async () => {
  await assert.rejects(() => resolveConfig({
    cwd: "/tmp", projectTrusted: true, configDirName: "pi", env: { PI_MSB_NETWORK__MODE: "open" },
    cliOverridesToml: '[[secrets]]\nenv="TOKEN"\nvalue="$ENV:TOKEN"\nallow_hosts=[]',
    readFile: async () => null, exists: async () => false,
  }), (error: unknown) => error instanceof ConfigError && error.issues.some((issue) => issue.includes("allowHosts")));
});
