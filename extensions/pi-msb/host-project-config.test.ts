import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, resolveConfig, toEffectiveToml, type ResolveConfigInput } from "./config.ts";

const home = "/home/test";
const root = `${home}/Code/pi-microsandbox`;
const agentDir = `${home}/.pi/agent`;
const policyFile = `${agentDir}/pi-microsandbox/projects/Code/pi-microsandbox/.pi-msb.toml`;
const localFile = `${root}/.pi-msb.toml`;
const defaultFile = `${agentDir}/pi-microsandbox/default.toml`;

function fixture(files: Map<string, string>, overrides: Partial<ResolveConfigInput> = {}): ResolveConfigInput {
  return {
    cwd: root, repoRoot: root, projectTrusted: true, configDirName: ".pi",
    homedir: home, agentDir, env: {},
    readFile: async (path) => files.get(path) ?? null,
    exists: async (path) => files.has(path),
    realpath: async (path) => path,
    stat: async () => ({ isSocket: () => false }),
    ...overrides,
  };
}

test("host defaults apply to all projects above local, environment, and session settings", async () => {
  const files = new Map([
    [defaultFile, 'cpus = 2\nfallback_mode = "block"\nnetwork.mode = "deny"'],
    [localFile, 'cpus = 64\nfallback_mode = "host"'],
  ]);
  for (const cwd of [root, `${home}/Code/other`, "/srv/app"]) {
    const result = await resolveConfig(fixture(files, {
      cwd, repoRoot: cwd, env: { PI_MSB_CPUS: "32" }, cliOverridesToml: 'cpus = 16\nnetwork.mode = "open"',
    }));
    assert.equal(result.config.cpus, 2);
    assert.equal(result.config.fallbackMode, "block");
    assert.equal(result.config.network.mode, "deny");
    assert.equal(result.provenance.cpus, "host-default");
  }
});

test("host project settings override host defaults while inheriting unspecified fields", async () => {
  const files = new Map([
    [defaultFile, `
cpus = 2
memory_mib = 2048
secrets = [{ env = "DEFAULT_TOKEN", value = "$ENV:DEFAULT_TOKEN", allow_hosts = ["default.example"] }]
[network]
mode = "allowlist"
allow_hosts = ["default.example"]
allow_dns = false
`],
    [policyFile, `
cpus = 3
secrets = []
[network]
allow_hosts = ["project.example"]
`],
  ]);
  const result = await resolveConfig(fixture(files));
  assert.equal(result.config.cpus, 3);
  assert.equal(result.config.memoryMiB, 2048);
  assert.equal(result.config.network.mode, "allowlist");
  assert.equal(result.config.network.allowDns, false);
  assert.deepEqual(result.config.network.allowHosts, ["project.example"]);
  assert.deepEqual(result.config.secrets, []);
  assert.equal(result.provenance.cpus, "host-project");
  assert.equal(result.provenance.memoryMiB, "host-default");
});

test("host defaults replace local lists and resolve their own relative secret references", async () => {
  const files = new Map([
    [localFile, `
pass_through_tools = ["unsafe"]
host_env = ["UNSAFE"]
mounts = [{ host_path = "/sensitive", guest_path = "/mnt/sensitive", readonly = false }]
secrets = [{ env = "EXTRA", value = "$ENV:EXTRA", allow_hosts = ["evil.example"] }]
[network]
allow_hosts = ["evil.example"]
`],
    [defaultFile, `
route_tools = ["read"]
pass_through_tools = []
host_env = []
mounts = []
secrets = [{ env = "TOKEN", value = "$FILE:token", allow_hosts = ["api.example"] }]
[network]
allow_hosts = ["api.example"]
`],
  ]);
  const result = await resolveConfig(fixture(files));
  assert.deepEqual(result.config.routeTools, ["read"]);
  assert.deepEqual(result.config.passThroughTools, []);
  assert.deepEqual(result.config.hostEnv, []);
  assert.deepEqual(result.config.mounts, []);
  assert.deepEqual(result.config.network.allowHosts, ["api.example"]);
  assert.deepEqual(result.config.secrets, [{ env: "TOKEN", value: `$FILE:${dirname(defaultFile)}/token`, allowHosts: ["api.example"] }]);
  assert.equal(result.provenance["secrets[TOKEN]"], "host-default");
});

test("host project policy overrides global, local, environment, and session scalars", async () => {
  const files = new Map([
    [`${home}/.config/pi-msb/config.toml`, "memory_mib = 1024"],
    ["/external.toml", "memory_mib = 2048"],
    [localFile, 'memory_mib = 3072\nfallback_mode = "host"\nallow_host_execution = true\nnetwork.mode = "open"'],
    [policyFile, 'memory_mib = 8192\nfallback_mode = "block"\nallow_host_execution = false\nnetwork.mode = "deny"'],
  ]);
  const result = await resolveConfig(fixture(files, {
    cwd: `${root}/packages/app`,
    env: { PI_MSB_CONFIG_FILE: "/external.toml", PI_MSB_MEMORY_MIB: "4096", PI_MSB_NETWORK__MODE: "open" },
    cliOverridesToml: 'memory_mib = 6144\nfallback_mode = "host"\nnetwork.mode = "open"',
  }));
  assert.equal(result.config.memoryMiB, 8192);
  assert.equal(result.config.fallbackMode, "block");
  assert.equal(result.config.allowHostExecution, false);
  assert.equal(result.config.network.mode, "deny");
  for (const field of ["memoryMiB", "fallbackMode", "allowHostExecution", "network.mode"]) {
    assert.equal(result.provenance[field], "host-project");
  }
  assert.equal(result.config.cpus, DEFAULT_CONFIG.cpus);
});

test("host policy arrays replace lower-layer secrets, mounts, and allowlists", async () => {
  const files = new Map([
    [localFile, `
route_tools = ["read", "bash"]
pass_through_tools = ["unsafe"]
host_env = ["UNSAFE"]
host_ro_allowlist = ["/sensitive"]
secrets = [{ env = "EXTRA", value = "$ENV:EXTRA", allow_hosts = ["evil.example"] }, { env = "TOKEN", value = "$FILE:/unapproved/token", allow_hosts = ["evil.example"] }]
mounts = [{ host_path = "/sensitive", guest_path = "/mnt/sensitive", readonly = false }]
[network]
allow_hosts = ["evil.example"]
publish_ports = ["0.0.0.0:8080:80"]
`],
    [policyFile, `
route_tools = ["read"]
pass_through_tools = []
host_env = []
host_ro_allowlist = []
mounts = []
secrets = [{ env = "TOKEN", value = "$ENV:SAFE_TOKEN", allow_hosts = ["api.example"] }]
[network]
mode = "allowlist"
allow_hosts = ["api.example"]
publish_ports = []
`],
  ]);
  const result = await resolveConfig(fixture(files, {
    cliOverridesToml: 'secrets = [{ env = "SESSION", value = "$ENV:SESSION", allow_hosts = ["evil.example"] }]',
  }));
  assert.deepEqual(result.config.routeTools, ["read"]);
  assert.deepEqual(result.config.passThroughTools, []);
  assert.deepEqual(result.config.hostEnv, []);
  assert.deepEqual(result.config.hostRoAllowlist, []);
  assert.deepEqual(result.config.mounts, []);
  assert.deepEqual(result.config.network.allowHosts, ["api.example"]);
  assert.deepEqual(result.config.network.publishPorts, []);
  assert.deepEqual(result.config.secrets, [{ env: "TOKEN", value: "$ENV:SAFE_TOKEN", allowHosts: ["api.example"] }]);
  assert.equal(result.provenance["secrets[TOKEN]"], "host-project");
  assert.equal(result.provenance["secrets[EXTRA]"], undefined);
  assert.equal(result.provenance["mounts[/mnt/sensitive]"], undefined);
});

test("empty host secret and route lists stay empty through validation", async () => {
  const result = await resolveConfig(fixture(new Map([
    [localFile, 'secrets = [{ env = "TOKEN", value = "$ENV:TOKEN", allow_hosts = ["evil.example"] }]'],
    [policyFile, "secrets = []\nroute_tools = []"],
  ])));
  assert.deepEqual(result.config.secrets, []);
  assert.deepEqual(result.config.routeTools, []);
});

test("host policy loads for untrusted projects and resolves relative secret files beside itself", async () => {
  const result = await resolveConfig(fixture(new Map([
    [localFile, "memory_mib = 128"],
    [defaultFile, "cpus = 2"],
    [policyFile, 'memory_mib = 2048\nsecrets = [{ env = "TOKEN", value = "$FILE:token", allow_hosts = ["api.example"] }]'],
  ]), { projectTrusted: false }));
  assert.equal(result.config.memoryMiB, 2048);
  assert.equal(result.config.cpus, 2);
  assert.equal(result.config.secrets[0]?.value, `$FILE:${dirname(policyFile)}/token`);
  assert.match(result.warnings.join("\n"), /not trusted/);
});

test("missing host policy preserves existing precedence and unspecified fields", async () => {
  const files = new Map([[localFile, 'memory_mib = 2048\nnetwork.mode = "deny"']]);
  const input = fixture(files, { env: { PI_MSB_MEMORY_MIB: "3072" }, cliOverridesToml: "memory_mib = 4096" });
  assert.equal((await resolveConfig(input)).config.memoryMiB, 4096);
  files.set(policyFile, "cpus = 2");
  const result = await resolveConfig(input);
  assert.equal(result.config.memoryMiB, 4096);
  assert.equal(result.config.network.mode, "deny");
  assert.equal(result.config.cpus, 2);
});

test("non-Git projects use their cwd and outside-home projects use a distinct absolute namespace", async () => {
  for (const [cwd, expected] of [
    [root, policyFile],
    ["/srv/app", `${agentDir}/pi-microsandbox/projects-absolute/srv/app/.pi-msb.toml`],
    [`${home}/srv/app`, `${agentDir}/pi-microsandbox/projects/srv/app/.pi-msb.toml`],
  ]) {
    const result = await resolveConfig(fixture(new Map([[expected, "cpus = 3"]]), { cwd, repoRoot: null }));
    assert.equal(result.config.cpus, 3);
  }
});

test("canonical project identity prevents symlink aliases from bypassing host policy", async () => {
  const alias = "/alias/project";
  const result = await resolveConfig(fixture(new Map([[policyFile, "cpus = 3"]]), {
    cwd: alias, repoRoot: alias,
    realpath: async (path) => path === alias ? root : path,
  }));
  assert.equal(result.config.cpus, 3);
});

test("the default policy directory comes from Pi getAgentDir, including PI_CODING_AGENT_DIR", async () => {
  const file = join(getAgentDir(), "pi-microsandbox/projects/Code/pi-microsandbox/.pi-msb.toml");
  const result = await resolveConfig(fixture(new Map([[file, "cpus = 3"]]), { agentDir: undefined }));
  assert.equal(result.config.cpus, 3);
});

test("invalid host policies fail closed and literal values remain redacted", async () => {
  for (const file of [defaultFile, policyFile]) {
    for (const text of ["cpus = 0", 'fallback_mode = "invalid"', 'secrets = [{ env = "TOKEN", value = "private-value", allow_hosts = [] }]', "[[secrets]"]) {
      await assert.rejects(resolveConfig(fixture(new Map([[file, text]]))), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /private-value/);
        return true;
      });
    }
  }
  const result = await resolveConfig(fixture(new Map([[policyFile, 'secrets = [{ env = "TOKEN", value = "private-value", allow_hosts = ["api.example"] }]']])));
  assert.doesNotMatch(toEffectiveToml(result), /private-value/);
  assert.doesNotMatch(result.warnings.join("\n"), /private-value/);
});

test("host policy must not reside in or symlink into the mounted workspace", async () => {
  for (const file of [defaultFile, policyFile]) {
    for (const exposed of [file, dirname(file)]) {
      await assert.rejects(resolveConfig(fixture(new Map([[file, "cpus = 3"]]), {
        realpath: async (path) => path === exposed ? `${root}/policy` : path,
      })), /outside the mounted workspace/);
    }
  }
});

test("writable mounts must not expose the host policy", async () => {
  for (const file of [defaultFile, policyFile]) {
    for (const hostPath of [agentDir, dirname(file), file, `${agentDir}/pi-microsandbox/projects/future`]) {
      await assert.rejects(resolveConfig(fixture(new Map([[file, `mounts = [{ host_path = "${hostPath}", guest_path = "/mnt/policy", readonly = false }]`]]))), /writable host mounts must not expose host configuration/);
    }
  }
});

test("a workspace inside the host policy directory cannot create new overrides", async () => {
  const cwd = `${agentDir}/pi-microsandbox/projects/other`;
  await assert.rejects(resolveConfig(fixture(new Map([[defaultFile, "cpus = 3"]]), {
    cwd, repoRoot: cwd,
  })), /outside the mounted workspace/);
});

test("missing project overrides cannot be created through writable symlinked policy directories", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-msb-host-policy-alias-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, "home", "Code", "app");
  const agent = join(dir, "agent");
  const policyDir = join(agent, "pi-microsandbox/projects/Code/app");
  const cache = join(dir, "cache");
  await mkdir(project, { recursive: true });
  await mkdir(cache);
  await mkdir(dirname(policyDir), { recursive: true });
  await symlink(cache, policyDir);
  await writeFile(join(agent, "pi-microsandbox/default.toml"), `mounts = [{ host_path = ${JSON.stringify(cache)}, guest_path = "/mnt/cache", readonly = false }]`);
  const input: ResolveConfigInput = { cwd: project, repoRoot: project, projectTrusted: true, configDirName: ".pi", homedir: join(dir, "home"), agentDir: agent, env: {} };
  await assert.rejects(resolveConfig(input), /writable host mounts must not expose host configuration/);
  await rm(policyDir);
  await symlink(join(cache, "missing"), policyDir);
  await assert.rejects(resolveConfig(input), /host configuration path could not be canonicalized/);
});

test("real filesystem policy changes are re-read and unreadable policies fail closed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-msb-host-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, "home", "Code", "app");
  const agent = join(dir, "agent");
  const policy = join(agent, "pi-microsandbox/projects/Code/app/.pi-msb.toml");
  await mkdir(project, { recursive: true });
  await mkdir(dirname(policy), { recursive: true });
  const input: ResolveConfigInput = { cwd: project, repoRoot: project, projectTrusted: true, configDirName: ".pi", homedir: join(dir, "home"), agentDir: agent, env: {} };
  assert.equal((await resolveConfig(input)).config.cpus, DEFAULT_CONFIG.cpus);
  await writeFile(policy, "cpus = 2");
  await writeFile(join(project, ".pi-msb.toml"), "cpus = 64");
  assert.equal((await resolveConfig(input)).config.cpus, 2);
  await writeFile(policy, "cpus = 3");
  assert.equal((await resolveConfig(input)).config.cpus, 3);
  await rm(policy);
  await mkdir(policy);
  await assert.rejects(resolveConfig(input), /host configuration could not be read/);
  await rm(policy, { recursive: true });
  const baseline = join(agent, "pi-microsandbox/default.toml");
  await mkdir(baseline);
  await assert.rejects(resolveConfig(input), /host configuration could not be read/);
  await rm(baseline, { recursive: true });
  const localPolicy = join(project, "policy.toml");
  await writeFile(localPolicy, "cpus = 64");
  await symlink(localPolicy, policy);
  await assert.rejects(resolveConfig(input), /outside the mounted workspace/);
});
