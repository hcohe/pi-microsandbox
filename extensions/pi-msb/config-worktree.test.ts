import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { hostConfigPaths, hostConfigTargets, resolveConfig, type ResolveConfigInput } from "./config.ts";

async function fixture(t: TestContext, parent = tmpdir()) {
  const root = await realpath(await mkdtemp(join(parent, "pi-msb-config-worktree-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = join(root, "repository");
  const linked = join(root, "external", "checkout");
  const registration = join(main, ".git", "worktrees", "checkout");
  await mkdir(registration, { recursive: true });
  await mkdir(linked, { recursive: true });
  await writeFile(join(registration, "commondir"), "../..\n");
  await writeFile(join(registration, "gitdir"), `${join(linked, ".git")}\n`);
  await writeFile(join(linked, ".git"), `gitdir: ${registration}\n`);
  const input: ResolveConfigInput = { cwd: linked, homedir: root, agentDir: join(root, "agent"), env: {}, projectTrusted: true, configDirName: ".pi" };
  const paths = await hostConfigPaths(input);
  const save = async (file: string, text: string) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, file === paths.project ? `_repository = { version = 1, common_dir = ${JSON.stringify(join(main, ".git"))}, main_root = ${JSON.stringify(main)} }\n${text}` : text);
  };
  return { root, main, linked, registration, input, paths, save };
}

test("host Project uses one main-root record from main, linked and nested cwd; legacy overlays never contribute", async (t) => {
  const f = await fixture(t);
  const nested = join(f.linked, "nested"); const mainNested = join(f.main, "nested");
  await mkdir(nested); await mkdir(mainNested);
  await f.save(f.paths.global, "cpus = 1");
  await f.save(f.paths.project, "cpus = 2\nmemory_mib = 2048");
  const legacy = (await hostConfigTargets(f.input)).ignoredLegacyPaths;
  for (const path of legacy) await f.save(path, 'cpus = 0\nsecrets = "DO_NOT_PARSE_PRIVATE"');
  for (const cwd of [f.main, f.linked, nested, mainNested]) {
    assert.deepEqual(await hostConfigPaths({ ...f.input, cwd }), f.paths);
    const resolved = await resolveConfig({ ...f.input, cwd });
    assert.equal(resolved.config.cpus, 2);
    assert.equal(resolved.config.memoryMiB, 2048);
    assert.equal(resolved.provenance.cpus, "host-project");
    assert.ok(resolved.warnings.some((warning) => warning.includes("Ignored legacy Worktree")));
    assert.doesNotMatch(resolved.warnings.join(" "), /DO_NOT_PARSE_PRIVATE/);
  }
  assert.equal((await resolveConfig({ ...f.input, temporaryOverrides: { cpus: 5 } })).config.cpus, 5);
});

test("host Project source ignores legacy Dockerfile/context and retains explicit image and Session precedence", async (t) => {
  const f = await fixture(t);
  await f.save(f.paths.project, "cpus = 2");
  const dockerfile = join(dirname(f.paths.project), "Dockerfile");
  await f.save(dockerfile, "FROM scratch\nLABEL scope=shared\n");
  const legacy = (await hostConfigTargets(f.input)).ignoredLegacyPaths[0]!;
  await f.save(join(dirname(legacy), "Dockerfile"), "INVALID PRIVATE LEGACY");
  await f.save(join(dirname(legacy), "build-context", "secret"), "PRIVATE");
  const result = await resolveConfig(f.input);
  assert.equal(result.imageBuild?.scope, "host-project");
  assert.equal(result.imageBuild?.dockerfile, dockerfile);
  assert.equal(result.provenance.image, "host-project");
  await mkdir(join(dirname(dockerfile), "build-context"));
  for (const hostPath of [dockerfile, join(dirname(dockerfile), "build-context")]) {
    await assert.rejects(resolveConfig({ ...f.input, temporaryOverrides: { mounts: [{ type: "dir", hostPath, guestPath: "/mnt/build", readonly: true, options: [] }] } }), /must not expose Dockerfile or build-context/);
  }
  await f.save(f.paths.project, 'image = "example.test/project:tag"');
  assert.equal((await resolveConfig(f.input)).config.image, "example.test/project:tag");
  assert.equal((await resolveConfig({ ...f.input, temporaryOverrides: { image: "example.test/session:tag" } })).config.image, "example.test/session:tag");
});

test("nested Project inheritance never changes actual cwd mount shadow checks", async (t) => {
  const f = await fixture(t, fileURLToPath(new URL("../../", import.meta.url)));
  const cwd = join(f.linked, "nested"); await mkdir(cwd);
  await f.save(f.paths.project, "cpus = 2");
  const input = { ...f.input, cwd };
  assert.equal((await resolveConfig(input)).config.cpus, 2);
  await resolveConfig({ ...input, temporaryOverrides: { mounts: [{ type: "dir", hostPath: f.main, guestPath: "/mnt/main", readonly: true, options: [] }] } });
  await assert.rejects(resolveConfig({ ...input, temporaryOverrides: { mounts: [{ type: "dir", hostPath: f.main, guestPath: cwd, readonly: true, options: [] }] } }), /must not shadow the project mount/);
});

test("host worktree policy and reciprocal Git proof cannot be exposed by writable mounts", async (t) => {
  const f = await fixture(t);
  for (const hostPath of [f.main, join(f.main, ".git"), f.registration, join(f.registration, "gitdir"), join(f.registration, "commondir"), dirname((await hostConfigTargets(f.input)).ignoredLegacyPaths[0]!)]) {
    await mkdir(dirname((await hostConfigTargets(f.input)).ignoredLegacyPaths[0]!), { recursive: true });
    await assert.rejects(resolveConfig({ ...f.input, temporaryOverrides: { mounts: [{ type: "dir", hostPath, guestPath: "/mnt/proof", readonly: false, options: [] }] } }), /writable host mounts must not expose host configuration/);
  }
  await resolveConfig({ ...f.input, temporaryOverrides: { mounts: [{ type: "dir", hostPath: f.registration, guestPath: "/mnt/proof", readonly: true, options: [] }] } });
  // A symlink spelling cannot bypass the reservation.
  const alias = join(f.root, "metadata-alias");
  await symlink(f.registration, alias);
  await assert.rejects(resolveConfig({ ...f.input, temporaryOverrides: { mounts: [{ type: "dir", hostPath: alias, guestPath: "/mnt/proof", readonly: false, options: [] }] } }), /writable host mounts must not expose host configuration/);
});

test("host config rejects guest-fabricated reciprocal proof inside the actual cwd bind", async (t) => {
  const f = await fixture(t);
  const common = join(f.linked, "fake-main", ".git");
  const registration = join(common, "worktrees", "fabricated");
  await mkdir(registration, { recursive: true });
  await writeFile(join(registration, "commondir"), "../..");
  await writeFile(join(registration, "gitdir"), join(f.linked, ".git"));
  await writeFile(join(f.linked, ".git"), `gitdir: ${registration}\n`);
  await assert.rejects(hostConfigTargets(f.input), /could not be safely verified/);
  await assert.rejects(resolveConfig(f.input), /could not be safely verified/);
});


test("ignored legacy diagnostics are metadata-only, nofollow, redacted and preserve all bytes/inodes", async (t) => {
  const f = await fixture(t);
  const nested = join(f.linked, "nested"); await mkdir(nested);
  const input = { ...f.input, cwd: nested };
  const targets = await hostConfigTargets(input);
  await f.save(f.paths.project, "cpus = 2");
  const [exact, checkout, main] = targets.ignoredLegacyPaths;
  assert.equal(targets.ignoredLegacyPaths.length, 3);
  const legacyText = 'invalid TOML PRIVATE_LEGACY_CREDENTIAL';
  await f.save(exact!, legacyText);
  const context = join(dirname(exact!), "build-context"); await mkdir(context);
  await fs.writeFile(join(context, "secret"), "PRIVATE_CONTEXT");
  const outside = join(f.root, "outside-legacy"); await mkdir(outside);
  await fs.writeFile(join(outside, "config.toml"), "PRIVATE_OUTSIDE");
  await mkdir(dirname(dirname(main!)), { recursive: true });
  await symlink(outside, dirname(main!));
  await f.save(checkout!, "cpus = 64");
  await symlink(join(outside, "config.toml"), join(dirname(checkout!), "Dockerfile"));
  const before = await fs.lstat(exact!); const file = await fs.lstat(join(context, "secret"));
  const read = fs.readFile; const open = fs.open;
  const ignoredRoots = [dirname(exact!), dirname(checkout!), dirname(main!), outside];
  const assertNotLegacy = (path: unknown) => {
    assert.ok(!ignoredRoots.some((root) => String(path) === root || String(path).startsWith(root + "/")), `legacy content read: ${String(path)}`);
  };
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => { assertNotLegacy(args[0]); return read(...args); });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => { assertNotLegacy(args[0]); return open(...args); });
  const resolved = await resolveConfig(input);
  assert.equal(resolved.config.cpus, 2);
  const warnings = resolved.warnings.join(" ");
  for (const path of [exact!, checkout!, dirname(main!)]) assert.ok(warnings.includes(path));
  assert.match(warnings, /Preserved, not loaded or copied/); assert.match(warnings, /fresh approval/);
  assert.doesNotMatch(warnings, /PRIVATE_LEGACY|PRIVATE_CONTEXT|PRIVATE_OUTSIDE/);
  t.mock.restoreAll();
  assert.equal(await fs.readFile(exact!, "utf8"), legacyText); assert.equal((await fs.lstat(exact!)).ino, before.ino);
  assert.equal((await fs.lstat(join(context, "secret"))).ino, file.ino);
  assert.equal(await fs.readFile(join(context, "secret"), "utf8"), "PRIVATE_CONTEXT");
  assert.ok((await fs.lstat(dirname(main!))).isSymbolicLink());
});
