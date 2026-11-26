import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import test, { type TestContext } from "node:test";
import { CONTEXT_LIMITS, readText, scanContext, validateContextEdits } from "./build-context-storage.ts";
import { BUILD_LIMITS } from "./image-source.ts";
import { openDockerfile } from "./dockerfile-storage.ts";
import { hostConfigPaths } from "./config.ts";

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/pi-msb-context-storage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = join(root, "cwd"), agentDir = join(root, "agent"); await fs.mkdir(cwd);
  const input = { cwd, agentDir, homedir: root, env: {}, projectTrusted: true, configDirName: ".pi" };
  const paths = await hostConfigPaths(input);
  const context = join(dirname(paths.project), "build-context");
  await fs.mkdir(context, { recursive: true });
  return { root, cwd, input, paths, context };
}

test("build-context-storage rejects patch payload bounds, overlap, duplicates and unsupported UTF-8 controls", () => {
  for (const edits of [
    [{ path: "one", content: "x".repeat(CONTEXT_LIMITS.fileBytes + 1) }],
    ["one", "two", "three"].map((path) => ({ path, content: "x".repeat(CONTEXT_LIMITS.fileBytes) })),
    Array.from({ length: 17 }, (_, index) => ({ path: `file-${index}`, content: "" })),
    [{ path: "same", content: "one" }, { path: "same", content: "two" }],
    [{ path: "ancestor", content: null }, { path: "ancestor/child", content: "text" }],
    [{ path: "text", content: "\ud800" }], [{ path: "text", content: "bad\x1b" }],
    [{ path: "text", content: null, executable: true }],
  ]) assert.throws(() => validateContextEdits(edits));
  validateContextEdits([{ path: ".dockerignore", content: "x".repeat(CONTEXT_LIMITS.fileBytes) }]);
});

for (const boundary of ["entries", "bytes", "depth"] as const) test(`build-context-storage final aggregate ${boundary} limit includes Dockerfile/implicit directories`, async (t) => {
  const f = await fixture(t);
  if (boundary === "entries") {
    // Root + 2046 files + Dockerfile = exactly 2048 entries.
    await Promise.all(Array.from({ length: BUILD_LIMITS.entries - 2 }, (_, index) => fs.writeFile(join(f.context, `file-${index}`), "")));
  } else if (boundary === "bytes") {
    const handle = await fs.open(join(f.context, "large-binary"), "w");
    try { await handle.truncate(BUILD_LIMITS.bytes - 1); } finally { await handle.close(); }
  } else {
    await fs.mkdir(join(f.context, ...Array.from({ length: 16 }, () => "dir")), { recursive: true });
  }
  const draft = await openDockerfile(f.input, f.cwd, "project", () => {});
  assert.ok(draft.context.length > 0);
  if (boundary === "depth") await assert.rejects(draft.prepare(undefined, [{ path: "dir/".repeat(16) + "new", content: "x" }]));
  else await assert.rejects(draft.prepare("FROM scratch\n", [{ path: "new", content: "xx" }]));
  await assert.rejects(fs.lstat(join(f.context, "new")), { code: "ENOENT" });
});

test("build-context-storage bounded inventory rejects excessive source entries/bytes/depth without reading contents", async (t) => {
  const f = await fixture(t);
  const file = join(f.context, "oversized-binary"); const handle = await fs.open(file, "w");
  try { await handle.truncate(BUILD_LIMITS.bytes + 1); } finally { await handle.close(); }
  await assert.rejects(scanContext(f.context));
  await fs.unlink(file);
  await fs.mkdir(join(f.context, ...Array.from({ length: 17 }, () => "dir")), { recursive: true });
  await assert.rejects(scanContext(f.context));
});

test("build-context-storage bounded reads reject BOM/control/binary/oversized inputs rather than truncating", async (t) => {
  const f = await fixture(t); const file = join(f.context, "file");
  for (const content of [Buffer.from([255]), Buffer.alloc(32769), Buffer.from("bad\0"), Buffer.from("\ufefftext")]) {
    await fs.writeFile(file, content); await assert.rejects(readText(file, CONTEXT_LIMITS.fileBytes));
    assert.deepEqual(await fs.readFile(file), content);
  }
  await fs.writeFile(file, "é".repeat(16384));
  assert.equal((await readText(file, CONTEXT_LIMITS.fileBytes)).bytes, CONTEXT_LIMITS.fileBytes);
});

test("build-context-storage source changed while staged retains external stage replacement and removes only owned empty directories", async (t) => {
  const f = await fixture(t); const draft = await openDockerfile(f.input, f.cwd, "project", () => {});
  await draft.prepare(undefined, [{ path: "nested/new", content: "approved" }]);
  const open = fs.open, rename = fs.rename; let stage: string | undefined;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).includes(".dockerfile-")) {
      stage = String(args[0]);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = (async (...values: Parameters<typeof handle.writeFile>) => {
        await write(...values);
        // Move our inode away and replace pathname with external bytes before staging identity capture.
        await rename(stage!, `${stage}.retained`);
        await fs.writeFile(stage!, "external", { mode: 0o600 });
      }) as typeof handle.writeFile;
    }
    return handle;
  });
  await assert.rejects(draft.save(undefined, async () => {}));
  assert.ok(stage); assert.equal(await fs.readFile(stage, "utf8"), "external");
  await assert.rejects(fs.lstat(join(f.context, "nested")), { code: "ENOENT" });
});

for (const paths of [
  ["asset.bin", "ASSET.BIN"],
  ["cafe\u0301.txt", "caf\u00e9.txt"],
  ["Dir/first", "dir/second"],
  ["cafe\u0301/first", "caf\u00e9/second"],
  ["parent", "PARENT/child"],
  ["\u03c2.txt", "\u03c3.txt"],
]) test(`build-context-storage rejects portable proposal spelling collisions ${JSON.stringify(paths)}`, () => {
  assert.throws(() => validateContextEdits(paths.map((path) => ({ path, content: "text" }))), /spelling alias/);
});

for (const path of ["dockerfile", "DockerFile", "DOCKERFILE", "Dockerfile/child", "dockerFILE/child"]) test(`build-context-storage rejects reserved root alias ${path}`, () => {
  assert.throws(() => validateContextEdits([{ path, content: "text" }]));
});

test("build-context-storage rejects ambiguous inventory spellings even on case-sensitive filesystems", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(join(f.context, "asset"), "one");
  try { await fs.lstat(join(f.context, "ASSET")); t.skip("Requires distinct case-sensitive directory entries"); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await fs.writeFile(join(f.context, "ASSET"), "two");
  await assert.rejects(scanContext(f.context), /spelling alias/);
  assert.equal(await fs.readFile(join(f.context, "asset"), "utf8"), "one");
  assert.equal(await fs.readFile(join(f.context, "ASSET"), "utf8"), "two");
});
