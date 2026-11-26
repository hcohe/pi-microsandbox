import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { readRawConfig } from "./config.ts";
import { projectConfigPath } from "./project-storage-path.ts";
import { readRepositoryCatalog, repositoryMetadata } from "./repository-catalog.ts";

async function fixture(t: TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pi-msb-readable-catalog-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "agent", "pi-microsandbox");
  const options = { root, home, parse: readRawConfig };
  const save = async (file: string, text: string) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, text); };
  const repository = async (main: string) => {
    await mkdir(join(main, ".git"), { recursive: true });
    const metadata = repositoryMetadata(join(main, ".git"), main);
    const file = projectConfigPath(root, home, main);
    const text = `_repository = {version=1,common_dir=${JSON.stringify(metadata.common_dir)},main_root=${JSON.stringify(main)}}\ncpus=2\n`;
    await save(file, text);
    return { file, text, metadata };
  };
  return { home, root, options, save, repository };
}

test("repository-catalog reads hierarchical home/absolute records and skips local configs and all context bytes", async (t) => {
  const f = await fixture(t);
  const a = await f.repository(join(f.home, "Code", "team", "app"));
  const b = await f.repository(join(f.home, "outside-home", "other"));
  // A different canonical home makes both existing records absolute; relocate
  // their artifacts to the exact expected readable keys for that home.
  const home = join(f.home, "new-home"); await mkdir(home);
  for (const entry of [a, b]) await f.save(projectConfigPath(f.root, home, entry.metadata.main_root), entry.text);
  await rm(join(f.root, "projects"), { recursive: true });
  await f.save(join(f.root, "projects", "local", "config.toml"), "cpus=3\n");
  await f.save(join(f.root, "projects", "local", "build-context", "config.toml"), a.text);
  await f.save(join(f.root, "projects", "context-only", "build-context", "config.toml"), "NOT TOML PRIVATE SOURCE");
  // The old hash-style registry is not even traversed.
  await f.save(join(f.root, "repositories", "0".repeat(64), "config.toml"), "INVALID PRIVATE OLD POLICY");
  const entries = await readRepositoryCatalog({ ...f.options, home });
  assert.deepEqual(entries.map((entry) => entry.metadata.main_root).sort(), [a.metadata.main_root, b.metadata.main_root].sort());
  assert.ok(entries.every((entry) => entry.file.includes("/projects-absolute/") && !entry.file.includes("/repositories/")));
});

test("repository-catalog predicts an absent deep readable record in the same atomic config artifact", async (t) => {
  const f = await fixture(t);
  const a = await f.repository(join(f.home, "Code", "deep", "app"));
  await rm(join(f.root, "projects"), { recursive: true });
  assert.deepEqual(await readRepositoryCatalog(f.options), []);
  assert.deepEqual(JSON.parse(JSON.stringify(await readRepositoryCatalog({ ...f.options, replacement: { file: a.file, text: a.text } }))), [{ file: a.file, metadata: a.metadata }]);
  assert.deepEqual(await readRepositoryCatalog(f.options), []);
});

test("repository-catalog rejects wrong expected paths, hardlinked files and symlinked structural ancestors", async (t) => {
  const f = await fixture(t); const a = await f.repository(join(f.home, "Code", "app"));
  const wrong = join(f.root, "projects", "wrong", "config.toml");
  await f.save(wrong, a.text);
  await assert.rejects(readRepositoryCatalog(f.options), /Unsafe repository catalog/);
  await rm(dirname(wrong), { recursive: true });
  const hardlink = join(f.home, "hardlink"); await link(a.file, hardlink);
  await assert.rejects(readRepositoryCatalog(f.options), /Unsafe repository catalog/);
  await rm(hardlink);
  const alias = join(f.root, "projects", "alias"); await symlink(dirname(a.file), alias);
  await assert.rejects(readRepositoryCatalog(f.options), /Unsafe repository catalog/);
  assert.equal(await readFile(a.file, "utf8"), a.text);
});

test("repository-catalog bounds config count, traversal entries and hierarchy depth", async (t) => {
  const f = await fixture(t);
  const projects = join(f.root, "projects"); await mkdir(projects, { recursive: true });
  for (let i = 0; i < 257; i++) await f.save(join(projects, `project-${i}`, "config.toml"), "cpus=2\n");
  await assert.rejects(readRepositoryCatalog(f.options), /Unsafe repository catalog/);
  await rm(projects, { recursive: true }); await mkdir(projects);
  await mkdir(join(projects, ...Array(257).fill("d")), { recursive: true });
  await assert.rejects(readRepositoryCatalog(f.options), /Unsafe repository catalog/);
  await rm(projects, { recursive: true }); await mkdir(projects);
  // Ordinary unrelated structural entries count toward the traversal bound too.
  for (let i = 0; i < 4096; i++) await writeFile(join(projects, `entry-${i}`), "");
  await assert.rejects(readRepositoryCatalog(f.options), /Unsafe repository catalog/);
});
