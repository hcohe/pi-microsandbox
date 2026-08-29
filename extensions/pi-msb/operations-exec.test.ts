import assert from "node:assert/strict";
import test from "node:test";
import {
  createBashOps,
  createFindOps,
  createSandboxGrepExecute,
  matchesToolGlob,
} from "./operations-exec.ts";

const helpers = {
  DEFAULT_MAX_BYTES: 50 * 1024,
  DEFAULT_MAX_LINES: 2000,
  truncateHead(content: string) {
    return {
      content,
      truncated: false,
      totalLines: content ? content.split("\n").length : 0,
      totalBytes: Buffer.byteLength(content),
      outputLines: content ? content.split("\n").length : 0,
      maxBytes: 50 * 1024,
    };
  },
  truncateLine(line: string, maxChars = 500) {
    return line.length > maxChars
      ? { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true }
      : { text: line, wasTruncated: false };
  },
  formatSize: (bytes: number) => `${bytes}B`,
};

test("matchesToolGlob supports basename, recursive, question, and brace globs", () => {
  assert.equal(matchesToolGlob("src/a.ts", "*.ts"), true);
  assert.equal(matchesToolGlob("src/a.ts", "src/*.ts"), true);
  assert.equal(matchesToolGlob("src/deep/a.ts", "src/**/*.ts"), true);
  assert.equal(matchesToolGlob("foo/bar/baz.txt", "foo/**"), true);
  assert.equal(matchesToolGlob("foo/bar/baz.txt", "foo/**.txt"), false);
  assert.equal(matchesToolGlob("foo/.hidden/baz.txt", "foo/**"), false);
  assert.equal(matchesToolGlob("packages/src/a.ts", "src/*.ts"), true);
  assert.equal(matchesToolGlob("src/a.ts", "src/?.ts"), true);
  assert.equal(matchesToolGlob("src/a.ts", "**/*.{ts,tsx}"), true);
  assert.equal(matchesToolGlob("src/a.js", "**/*.{ts,tsx}"), false);
  assert.equal(matchesToolGlob(".env", "*"), false);
  assert.equal(matchesToolGlob(".env", ".*"), true);
  assert.equal(matchesToolGlob(".config/settings.ts", "**/*.ts"), false);
  assert.equal(matchesToolGlob(".config/settings.ts", "**/.*/*.ts"), true);
});

test("bash delegates every call to a runtime and merges both streams", async () => {
  const calls: unknown[] = [];
  const provider = {
    async withRuntime(callback: any) {
      return callback({
        transport: {
          async execStream(command: string, args: string[], options: any) {
            calls.push({ command, args, cwd: options.cwd, timeoutMs: options.timeoutMs });
            options.onStdout?.(Buffer.from("out"));
            options.onStderr?.(Buffer.from("err"));
            return { exitCode: 7 };
          },
        },
      });
    },
  };
  const chunks: string[] = [];
  const result = await createBashOps(provider).exec("printf '$'", "/guest/work", {
    onData: (chunk) => chunks.push(chunk.toString()),
    timeout: 2,
    env: { MUST_BE_IGNORED: "yes" },
  });
  assert.deepEqual(result, { exitCode: 7 });
  assert.deepEqual(chunks, ["out", "err"]);
  assert.deepEqual(calls, [{ command: "bash", args: ["-lc", "printf '$'"], cwd: "/guest/work", timeoutMs: 2000 }]);
});

test("bash maps transport abort and timeout sentinels", async () => {
  for (const [code, message] of [["ABORTED", "aborted"], ["TIMEOUT", "timeout:3"]]) {
    const provider = {
      async withRuntime(callback: any) {
        return callback({ transport: { async execStream() { throw Object.assign(new Error("transport"), { code }); } } });
      },
    };
    await assert.rejects(
      createBashOps(provider).exec("true", "/guest", { onData() {}, timeout: 3 }),
      new Error(message),
    );
  }
});

test("find runs rg, applies ignore and host-side glob matching", async () => {
  const calls: unknown[] = [];
  const transport = {
    async exists() { return true; },
    async exec(command: string, args: string[], options: any) {
      calls.push({ command, args, options });
      return {
        stdout: Buffer.from("a.ts\nsrc/b.ts\n.hidden.ts\nsrc/.hidden.ts\nnode_modules/no.ts\n"),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      };
    },
  } as any;
  const results = await createFindOps(transport).glob("**/*.ts", "/guest/repo", {
    ignore: ["**/vendor/**"],
    limit: 2,
  });
  // FindOperations feeds Pi's wrapper, which relativizes absolute paths itself.
  assert.deepEqual(results, ["/guest/repo/a.ts", "/guest/repo/src/b.ts"]);
  assert.deepEqual(results.map((path) => path.slice("/guest/repo/".length)), ["a.ts", "src/b.ts"]);
  assert.deepEqual(calls[0], {
    command: "rg",
    args: [
      "--files", "--hidden", "--color=never",
      "--glob", "!**/.git/**", "--glob", "!**/node_modules/**", "--glob", "!**/vendor/**",
    ],
    options: { cwd: "/guest/repo" },
  });
});

test("find treats rg code 1 as empty and code 2 as an error", async () => {
  const noFiles = {
    async exec() {
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 1 };
    },
  } as any;
  assert.deepEqual(
    await createFindOps(noFiles).glob("*.ts", "/guest/repo", { ignore: [], limit: 10 }),
    [],
  );

  const failed = {
    async exec() {
      return { stdout: Buffer.alloc(0), stderr: Buffer.from("bad search"), exitCode: 2 };
    },
  } as any;
  await assert.rejects(
    async () => createFindOps(failed).glob("*.ts", "/guest/repo", { ignore: [], limit: 10 }),
    new Error("bad search"),
  );
});

test("sandbox grep streams JSON, kills at the limit, and formats context", async () => {
  let streamOptions: any;
  let readCount = 0;
  const transport = {
    async stat() { return { kind: "directory" }; },
    async readFile() {
      readCount++;
      return Buffer.from("before\nneedle\nafter\n");
    },
    async execStream(_command: string, _args: string[], options: any) {
      streamOptions = options;
      options.onStdout?.(Buffer.from(
        '{"type":"match","data":{"path":{"text":"file.txt"},"line_number":2,"lines":{"text":"needle\\n"}}}\n',
      ));
      if (options.signal.aborted) throw Object.assign(new Error("aborted"), { code: "ABORTED" });
      return { exitCode: 0 };
    },
  } as any;
  const provider = { async withRuntime(callback: any) { return callback({ transport }); } } as any;
  const execute = createSandboxGrepExecute({ provider, cwd: "/guest/repo", helpers });
  const result = await execute("id", { pattern: "needle", context: 1, limit: 1 });
  assert.equal(streamOptions.signal.aborted, true);
  assert.equal(readCount, 1);
  assert.match(result.content[0].text, /file\.txt-1- before\nfile\.txt:2: needle\nfile\.txt-3- after/);
  assert.match(result.content[0].text, /1 matches limit reached\. Use limit=2/);
  assert.equal(result.details.matchLimitReached, 1);
});

test("sandbox grep ignores invalid JSON and reports no matches", async () => {
  const transport = {
    async stat() { return { kind: "directory" }; },
    async execStream(_command: string, _args: string[], options: any) {
      options.onStdout?.(Buffer.from("not json\n{\"type\":\"summary\"}\n"));
      return { exitCode: 1 };
    },
  } as any;
  const provider = { async withRuntime(callback: any) { return callback({ transport }); } } as any;
  const result = await createSandboxGrepExecute({ provider, cwd: "/guest/repo", helpers })("id", { pattern: "missing" });
  assert.deepEqual(result, { content: [{ type: "text", text: "No matches found" }], details: undefined });
});

test("sandbox grep propagates a transport abort without an external signal", async () => {
  const transport = {
    async stat() { return { kind: "directory" }; },
    async execStream() {
      throw Object.assign(new Error("sandbox stopped"), { code: "ABORTED" });
    },
  } as any;
  const provider = { async withRuntime(callback: any) { return callback({ transport }); } } as any;
  await assert.rejects(
    createSandboxGrepExecute({ provider, cwd: "/guest/repo", helpers })("id", { pattern: "needle" }),
    new Error("Operation aborted"),
  );
});

test("sandbox grep closes aborts during runtime acquisition and stat", async () => {
  let releaseRuntime!: () => void;
  let statCalls = 0;
  const runtimeReady = new Promise<void>((resolve) => { releaseRuntime = resolve; });
  const transport = {
    async stat() {
      statCalls++;
      return { kind: "directory" };
    },
  } as any;
  const provider = {
    async withRuntime(callback: any) {
      await runtimeReady;
      return callback({ transport });
    },
  } as any;
  const controller = new AbortController();
  const pending = createSandboxGrepExecute({ provider, cwd: "/guest/repo", helpers })(
    "id",
    { pattern: "needle" },
    controller.signal,
  );
  await Promise.resolve();
  controller.abort();
  releaseRuntime();
  await assert.rejects(pending, new Error("Operation aborted"));
  assert.equal(statCalls, 0);

  const abortingProvider = {
    async withRuntime() {
      throw Object.assign(new Error("runtime stopped"), { code: "ABORTED" });
    },
  } as any;
  await assert.rejects(
    createSandboxGrepExecute({ provider: abortingProvider, cwd: "/guest/repo", helpers })("id", { pattern: "needle" }),
    new Error("Operation aborted"),
  );

  const abortingStat = {
    async stat() {
      throw Object.assign(new Error("stat stopped"), { code: "ABORTED" });
    },
  } as any;
  const activeProvider = { async withRuntime(callback: any) { return callback({ transport: abortingStat }); } } as any;
  await assert.rejects(
    createSandboxGrepExecute({ provider: activeProvider, cwd: "/guest/repo", helpers })("id", { pattern: "needle" }),
    new Error("Operation aborted"),
  );
});

test("sandbox grep forwards case, literal, and glob flags", async () => {
  let command: string | undefined;
  let commandArgs: string[] | undefined;
  const transport = {
    async stat() { return { kind: "file" }; },
    async execStream(receivedCommand: string, receivedArgs: string[], options: any) {
      command = receivedCommand;
      commandArgs = receivedArgs;
      options.onStdout?.(Buffer.from(
        '{"type":"match","data":{"path":{"text":"file.txt"},"line_number":1,"lines":{"text":"Needle\\n"}}}\n',
      ));
      return { exitCode: 0 };
    },
  } as any;
  const provider = { async withRuntime(callback: any) { return callback({ transport }); } } as any;
  await createSandboxGrepExecute({ provider, cwd: "/guest/repo", helpers })("id", {
    pattern: "Needle",
    path: "/guest/repo/file.txt",
    ignoreCase: true,
    literal: true,
    glob: "*.txt",
  });
  assert.equal(command, "rg");
  assert.deepEqual(commandArgs?.slice(0, 9), [
    "--json", "--line-number", "--color=never", "--hidden",
    "--ignore-case", "--fixed-strings", "--glob", "*.txt", "--",
  ]);
});
