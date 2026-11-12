import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hostConfigPaths } from "./config.ts";
import { projectConfigPath } from "./project-storage-path.ts";

test("project-storage-path uses readable keys for home, root, outside-home and prefix boundaries", () => {
  const policy = "/agent/pi-microsandbox";
  for (const [home, root, key] of [
    ["/home/me", "/home/me/Code/app", "projects/Code/app/config.toml"],
    ["/home/me", "/home/me", "projects/config.toml"],
    ["/home/me", "/home/me-other/app", "projects-absolute/home/me-other/app/config.toml"],
    ["/home/me", "/srv/app", "projects-absolute/srv/app/config.toml"],
    ["/home/me", "/", "projects-absolute/config.toml"],
    ["/", "/", "projects/config.toml"],
    ["/", "/srv/app", "projects/srv/app/config.toml"],
  ]) assert.equal(projectConfigPath(policy, home!, root!), join(policy, key!));
});

test("project-storage-path canonical cwd, home and selected-agent aliases share a readable target", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-msb-readable-path-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"); const cwd = join(home, "Code", "app"); const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true }); await mkdir(agentDir);
  const homeAlias = join(root, "home-alias"); const cwdAlias = join(root, "cwd-alias"); const agentAlias = join(root, "agent-alias");
  await symlink(home, homeAlias); await symlink(cwd, cwdAlias); await symlink(agentDir, agentAlias);
  const input = { cwd, homedir: home, agentDir, env: {}, projectTrusted: true, configDirName: ".pi" };
  const expected = { global: join(agentDir, "pi-microsandbox", "default.toml"), project: join(agentDir, "pi-microsandbox", "projects", "Code", "app", "config.toml") };
  assert.deepEqual(await hostConfigPaths(input), expected);
  assert.deepEqual(await hostConfigPaths({ ...input, cwd: cwdAlias, homedir: homeAlias, agentDir: agentAlias }), expected);
});

for (const name of ["build-context", "BUILD-CONTEXT", "config.toml", "CONFIG.TOML", "Dockerfile", "dockerfile"]) {
  test(`project-storage-path rejects reserved component ${name} before use, irrespective of parent record order`, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-msb-reserved-path-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "home"); const parent = join(home, "parent"); const cwd = join(parent, name, "child");
    await mkdir(cwd, { recursive: true });
    const input = { cwd, homedir: home, agentDir: join(root, "agent"), env: {}, projectTrusted: true, configDirName: ".pi" };
    await assert.rejects(hostConfigPaths(input), /Project storage path conflicts with reserved artifact name/);
    const { SettingsEditor } = await import("./settings.ts");
    const draft = await new SettingsEditor({ ...input, cwd: parent }, "parent").open("project"); draft.set("cpus", 2); await draft.apply();
    await assert.rejects(hostConfigPaths(input), /Project storage path conflicts with reserved artifact name/);
    await assert.rejects(new SettingsEditor(input, "child").open("project"), /reserved artifact name/);
  });
}
