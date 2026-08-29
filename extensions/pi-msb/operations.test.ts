import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxTransport, StatResult } from "./types.ts";
import {
  createEditOps,
  createLsOps,
  createReadOps,
  createWriteOps,
} from "./operations.ts";

type Call = { command: string; args: string[] };

function fakeTransport(overrides: Partial<SandboxTransport> = {}) {
  const calls: Call[] = [];
  const transport: SandboxTransport = {
    readFile: async () => Buffer.from("guest contents"),
    writeFile: async () => {},
    exists: async () => true,
    stat: async (): Promise<StatResult> => ({
      kind: "file",
      size: 1,
      mode: 0o644,
      readonly: false,
      modifiedAt: null,
    }),
    list: async () => [
      { name: ".env", kind: "file" },
      { name: "src", kind: "directory" },
    ],
    copyFromHost: async () => {},
    copyToHost: async () => {},
    exec: async (command, args) => {
      calls.push({ command, args });
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    },
    execStream: async () => ({ exitCode: 0 }),
    dispose: async () => {},
    ...overrides,
  };
  return { transport, calls };
}

const options = { projectRoot: "/workspace/project" };

test("read uses the mounted absolute path, checks readability, and detects supported images", async () => {
  const { transport, calls } = fakeTransport({
    exec: async (command, args) => {
      calls.push({ command, args });
      if (command === "file") {
        return {
          stdout: Buffer.from("image/x-ms-bmp\n"),
          stderr: Buffer.alloc(0),
          exitCode: 0,
        };
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    },
  });
  const ops = createReadOps(transport, options);
  const path = "/workspace/project/-file with spaces.bmp";

  await ops.access(path);
  assert.deepEqual(await ops.readFile(path), Buffer.from("guest contents"));
  assert.equal(await ops.detectImageMimeType?.(path), "image/bmp");
  assert.deepEqual(calls, [
    {
      command: "sh",
      args: ["-c", 'test -r "$1"', "pi-msb-test", path],
    },
    { command: "file", args: ["--mime-type", "-b", "--", path] },
  ]);
});

test("readability failures retain missing-file semantics", async () => {
  const { transport, calls } = fakeTransport({
    exists: async () => false,
    exec: async (command, args) => {
      calls.push({ command, args });
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 1 };
    },
  });
  await assert.rejects(
    createReadOps(transport, options).access("/workspace/project/missing file"),
    /ENOENT: no such file or directory/,
  );
  assert.deepEqual(calls, [
    {
      command: "sh",
      args: [
        "-c",
        'test -r "$1"',
        "pi-msb-test",
        "/workspace/project/missing file",
      ],
    },
  ]);
});

test("leading-dash paths stay positional and are not interpolated", async () => {
  const { transport, calls } = fakeTransport();
  const path = "-leading-dash-file";
  await createReadOps(transport, options).access(path);
  assert.deepEqual(calls, [
    { command: "sh", args: ["-c", 'test -r "$1"', "pi-msb-test", path] },
  ]);
});

test("missing file executable is diagnosed and treated as a non-image", async () => {
  const { transport, calls } = fakeTransport({
    exec: async (command, args) => {
      calls.push({ command, args });
      if (command === "file") {
        return { stdout: Buffer.alloc(0), stderr: Buffer.from("not found"), exitCode: 127 };
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    },
  });
  const mime = await createReadOps(transport, options).detectImageMimeType?.(
    "/workspace/project/file.txt",
  );
  assert.equal(mime, null);
  assert.equal(calls[0]?.command, "file");
  assert.equal(calls[1]?.command, "sh");
});

test("mkdir failures preserve stderr", async () => {
  const { transport } = fakeTransport({
    exec: async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("mkdir: permission denied\n"),
      exitCode: 1,
    }),
  });
  await assert.rejects(
    createWriteOps(transport, options).mkdir("/workspace/project/blocked"),
    /mkdir: permission denied/,
  );
});

test("write creates parent directories and delegates bytes/content without path translation", async () => {
  const writes: Array<{ path: string; content: string | Buffer }> = [];
  const { transport, calls } = fakeTransport({
    writeFile: async (path, content) => {
      writes.push({ path, content });
    },
  });
  const ops = createWriteOps(transport, options);
  const path = "/workspace/project/a folder/-name.txt";

  await ops.mkdir("/workspace/project/a folder");
  await ops.writeFile(path, "hello");
  assert.deepEqual(calls, [
    { command: "mkdir", args: ["-p", "--", "/workspace/project/a folder"] },
  ]);
  assert.deepEqual(writes, [{ path, content: "hello" }]);
});

test("edit access requires both read and write access", async () => {
  const { transport, calls } = fakeTransport();
  await createEditOps(transport, options).access("/workspace/project/file");
  assert.deepEqual(calls, [
    {
      command: "sh",
      args: [
        "-c",
        'test -r "$1" && test -w "$1"',
        "pi-msb-test",
        "/workspace/project/file",
      ],
    },
  ]);
});

test("ls includes dotfiles and probes symlink directories without caching", async () => {
  const paths: string[] = [];
  const { transport, calls } = fakeTransport({
    list: async (path) => {
      paths.push(path);
      return [{ name: "linked", kind: "other" }, { name: ".hidden", kind: "file" }];
    },
    stat: async (path) => {
      paths.push(path);
      return {
        kind: path.endsWith("linked") ? "other" : "directory",
        size: 0,
        mode: 0o755,
        readonly: false,
        modifiedAt: null,
      };
    },
    exec: async (command, args) => {
      calls.push({ command, args });
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: command === "test" && args[0] === "-d" ? 0 : 0,
      };
    },
  });
  const ops = createLsOps(transport, options);
  assert.equal(await ops.exists("/workspace/project"), true);
  const stat = await ops.stat("/workspace/project/linked");
  assert.equal(stat.isDirectory(), true);
  assert.deepEqual(await ops.readdir("/workspace/project"), ["linked", ".hidden"]);
  assert.deepEqual(paths, [
    "/workspace/project/linked",
    "/workspace/project",
  ]);
  assert.deepEqual(calls, [
    {
      command: "sh",
      args: ["-c", 'test -d "$1"', "pi-msb-test", "/workspace/project/linked"],
    },
  ]);
});

test("symlink directory probes propagate transport failures", async () => {
  const expected = Object.assign(new Error("sandbox transport failed"), { code: "IO" });
  const { transport } = fakeTransport({
    stat: async () => ({
      kind: "other",
      size: 0,
      mode: 0o777,
      readonly: false,
      modifiedAt: null,
    }),
    exec: async () => {
      throw expected;
    },
  });
  const stat = createLsOps(transport, options).stat("/workspace/project/link");
  await assert.rejects(Promise.resolve(stat), (error: unknown) => error === expected);
});

test("a normal negative symlink directory probe is not a transport error", async () => {
  const { transport } = fakeTransport({
    stat: async () => ({
      kind: "other",
      size: 0,
      mode: 0o644,
      readonly: false,
      modifiedAt: null,
    }),
    exec: async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 1,
    }),
  });
  const stat = await createLsOps(transport, options).stat("/workspace/project/file");
  assert.equal(stat.isDirectory(), false);
});

test("missing test command is not classified as an outside-root missing path", async () => {
  const { transport } = fakeTransport({
    exec: async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("sh: test: not found\n"),
      exitCode: 127,
    }),
    exists: async () => false,
    stat: async () => ({
      kind: "other",
      size: 0,
      mode: 0o644,
      readonly: false,
      modifiedAt: null,
    }),
  });
  await assert.rejects(
    Promise.resolve(createLsOps(transport, options).stat("/tmp/not-mounted")),
    (error: unknown) =>
      (error as { code?: unknown }).code === "COMMAND_NOT_FOUND" &&
      !String(error).includes("not available in the sandbox"),
  );
});

test("outside-root missing paths explain the sandbox mount", async () => {
  const { transport } = fakeTransport({ exists: async () => false });
  await assert.rejects(
    Promise.resolve(createLsOps(transport, options).exists("/tmp/not-mounted")),
    /not available in the sandbox.*\/workspace\/project/,
  );
});

test("inside-root command failures retain their command error", async () => {
  const { transport } = fakeTransport({
    exec: async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("permission denied\n"),
      exitCode: 1,
    }),
  });
  await assert.rejects(
    createReadOps(transport, options).access("/workspace/project/secret"),
    /permission denied/,
  );
});
