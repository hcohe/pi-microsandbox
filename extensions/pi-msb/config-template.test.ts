import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, ensureDefaultHostConfig, parseTomlConfig, resolveConfig, validateConfig } from "./config.ts";
import { defaultConfigTemplate } from "./config-template.ts";

const uncomment = (text: string): string => text.replace(/^# /gm, "");

async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-msb-config-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const file = join(agentDir, "pi-microsandbox", "default.toml");
  await mkdir(workspace);
  return { root, workspace, agentDir, file };
}

test("config-template is fully commented and covers current default settings", () => {
  const template = defaultConfigTemplate(DEFAULT_CONFIG);
  assert.ok(template.split("\n").every((line) => !line.trim() || line.startsWith("#")));
  assert.deepEqual(parseTomlConfig(template, "host-default").value, {});
  const defaults = template.replace(/^## Example: [\s\S]*?^## End example\n/gm, "");
  const parsed = parseTomlConfig(uncomment(defaults), "host-default");
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(validateConfig(parsed.value), DEFAULT_CONFIG);
  // Compatibility-only host-read keys stay in the runtime schema, not the user reference.
  // sandboxName has no TOML null default and is covered by its separate example.
  const omittedDefaults = ["sandboxName", "hostRoAllowlist"];
  assert.deepEqual(Object.keys(parsed.value).sort(), Object.keys(DEFAULT_CONFIG).filter((key) => !omittedDefaults.includes(key)).sort());
  assert.doesNotMatch(template, /host_ro_allowlist|PI_MSB_HOST_RO_PATHS|^# remove_/m);
  assert.deepEqual(Object.keys(parsed.value.network!).sort(), Object.keys(DEFAULT_CONFIG.network).sort());
  assert.deepEqual(Object.keys(parsed.value.docker!).sort(), Object.keys(DEFAULT_CONFIG.docker).sort());
  assert.match(defaults, /sandbox_name defaults to null/);
});

test("config-template describes host-owned configuration without compatibility guidance", () => {
  const template = defaultConfigTemplate(DEFAULT_CONFIG);
  assert.match(template, /Precedence: built-ins < environment < session overrides < this default\.toml\n## < host-owned per-project override/);
  assert.match(template, /projects\/Code\/app\/config\.toml/);
  assert.match(template, /PI_MSB_\* environment settings and session \/msb overrides/);
  assert.doesNotMatch(template, /legacy|deprecated|migrat|PI_MSB_CONFIG_FILE|CONFIG_DIR_NAME/i);
});

test("config-template independent uncommented examples parse and validate without warnings", () => {
  const template = defaultConfigTemplate(DEFAULT_CONFIG);
  const examples = [...template.matchAll(/^## Example: ([^\n]+)\n([\s\S]*?)^## End example/gm)];
  assert.equal(examples.length, 3);
  const parsed = new Map(examples.map((example) => {
    const name = example[1]!;
    const layer = parseTomlConfig(uncomment(example[2]!), "host-default");
    assert.deepEqual(layer.warnings, [], name);
    assert.doesNotThrow(() => validateConfig(layer.value), name);
    return [name, layer.value];
  }));
  assert.equal(parsed.get("sandbox-name")?.sandboxName, "my-isolated-session");
  const secrets = parsed.get("secrets")!.secrets!;
  assert.deepEqual(Object.keys(secrets[0]!).sort(), ["allowHosts", "env", "value"]);
  assert.ok(secrets.some((secret) => secret.value!.startsWith("$ENV:")));
  assert.ok(secrets.some((secret) => secret.value!.startsWith("$FILE:")));
  const mounts = parsed.get("mounts")!.mounts!;
  assert.deepEqual(mounts.map((mount) => mount.type), ["dir", "file", "named", "tmpfs"]);
  assert.deepEqual(Object.keys(mounts[0]!).sort(), ["guestPath", "hostPath", "options", "readonly", "type"]);
  assert.ok(mounts.flatMap((mount) => mount.options ?? []).every((option) => ["noexec", "nosuid", "nodev"].includes(option)));
  // In-place editing works too: choose the examples instead of empty list defaults.
  const inPlace = parseTomlConfig(uncomment(template.replace(/^# (?:secrets|mounts) = \[\]\n/gm, "")), "host-default");
  assert.deepEqual(inPlace.warnings, []);
  assert.equal(inPlace.value.sandboxName, "my-isolated-session");
  assert.equal(inPlace.value.secrets?.length, 2);
  assert.equal(inPlace.value.mounts?.length, 4);
  assert.doesNotThrow(() => validateConfig(inPlace.value));
});

test("config-template bootstrap creates private files only if missing and is idempotent", async (t) => {
  const { workspace, agentDir, file } = await fixture(t);
  await Promise.all([ensureDefaultHostConfig(workspace, agentDir), ensureDefaultHostConfig(workspace, agentDir)]);
  assert.equal(await readFile(file, "utf8"), defaultConfigTemplate(DEFAULT_CONFIG));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(file))).mode & 0o777, 0o700);
  assert.equal((await stat(agentDir)).mode & 0o777, 0o700);
  await assert.rejects(stat(join(dirname(file), "projects")), { code: "ENOENT" });
  for (const text of ["", "# user file\ncpus = 2\n"]) {
    await writeFile(file, text);
    const before = await stat(file);
    await ensureDefaultHostConfig(workspace, agentDir);
    const after = await stat(file);
    assert.equal(await readFile(file, "utf8"), text);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
  }
});

test("config-template bootstrap respects Pi custom agent directory without a host-home write", async (t) => {
  const { workspace, agentDir, file } = await fixture(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await ensureDefaultHostConfig(workspace);
    assert.equal(await readFile(file, "utf8"), defaultConfigTemplate(DEFAULT_CONFIG));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("config-template bootstrap rejects workspace paths, symlink targets, and dangling links before writing", async (t) => {
  const { root, workspace, agentDir, file } = await fixture(t);
  await assert.rejects(ensureDefaultHostConfig(workspace, join(workspace, "agent")), /outside the mounted workspace/);
  await assert.rejects(stat(join(workspace, "agent")), { code: "ENOENT" });
  await mkdir(agentDir);
  await symlink(workspace, dirname(file));
  await assert.rejects(ensureDefaultHostConfig(workspace, agentDir), /outside the mounted workspace/);
  await assert.rejects(stat(join(workspace, "default.toml")), { code: "ENOENT" });
  await rm(dirname(file));
  await mkdir(dirname(file));
  const local = join(workspace, "policy.toml");
  await writeFile(local, "");
  await symlink(local, file);
  await assert.rejects(ensureDefaultHostConfig(workspace, agentDir), /outside the mounted workspace/);
  assert.equal(await readFile(local, "utf8"), "");
  await rm(file);
  await symlink(join(root, "missing"), file);
  await assert.rejects(ensureDefaultHostConfig(workspace, agentDir), /canonicalized/);
});

test("config-template rejects lexical and canonical ancestor traversal through the workspace", async (t) => {
  const { root, workspace } = await fixture(t);
  const outside = join(root, "outside");
  await mkdir(outside);
  const lexicalAgent = join(workspace, "agent");
  await symlink(outside, lexicalAgent);
  const projectAlias = join(root, "project-alias");
  await symlink(workspace, projectAlias);
  const bridge = join(workspace, "bridge");
  await mkdir(bridge);
  await symlink(outside, join(bridge, "pi-microsandbox"));
  const traversingAgent = join(root, "traversing-agent");
  await symlink(bridge, traversingAgent);
  for (const [project, agentDir] of [
    [workspace, lexicalAgent], [projectAlias, join(projectAlias, "agent")],
    [workspace, traversingAgent],
  ] as const) {
    await assert.rejects(ensureDefaultHostConfig(project, agentDir), /outside the mounted workspace/);
    await assert.rejects(resolveConfig({
      cwd: project, agentDir, projectTrusted: true, configDirName: ".pi", env: {},
    }), /outside the mounted workspace/);
  }
  await assert.rejects(stat(join(outside, "default.toml")), { code: "ENOENT" });
  await assert.rejects(stat(join(outside, "pi-microsandbox")), { code: "ENOENT" });
  const safeAgent = join(root, "safe-agent");
  await ensureDefaultHostConfig(projectAlias, safeAgent);
  assert.equal((await resolveConfig({
    cwd: projectAlias, agentDir: safeAgent, projectTrusted: true, configDirName: ".pi", env: {},
  })).config.cpus, DEFAULT_CONFIG.cpus);
});

test("config-template bootstrap preserves safe existing symlinks and fails on unusable directories", async (t) => {
  const { root, workspace, agentDir, file } = await fixture(t);
  await mkdir(dirname(file), { recursive: true });
  const external = join(root, "external.toml");
  await writeFile(external, "cpus = 2\n", { mode: 0o640 });
  const before = await stat(external);
  await symlink(external, file);
  await ensureDefaultHostConfig(workspace, agentDir);
  assert.equal(await readFile(file, "utf8"), "cpus = 2\n");
  assert.equal((await stat(external)).mode, before.mode);
  await rm(agentDir, { recursive: true });
  await writeFile(agentDir, "not a directory");
  await assert.rejects(ensureDefaultHostConfig(workspace, agentDir), /host configuration.*canonicalized|could not be created/);
});

test("config-template is not bootstrapped by read-only config resolution", async (t) => {
  const { workspace, agentDir, file } = await fixture(t);
  const input = { cwd: workspace, agentDir, projectTrusted: true, configDirName: ".pi", env: {} };
  assert.equal((await resolveConfig(input)).config.cpus, DEFAULT_CONFIG.cpus);
  await assert.rejects(stat(file), { code: "ENOENT" });
});
