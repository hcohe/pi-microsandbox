import assert from "node:assert/strict";
import test from "node:test";

import {
  createSdkTransport,
  SandboxTransportError,
} from "./transport.ts";

class ExecTimeoutError extends Error {}
class SandboxNotFoundError extends Error {}

class FakeHandle {
  readonly events: Array<Record<string, unknown>> = [];
  readonly waiters: Array<(result: IteratorResult<Record<string, unknown>>) => void> = [];
  killed = false;
  ended = false;

  push(event: Record<string, unknown>): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.events.push(event);
    if (event.kind === "exited") this.ended = true;
  }

  async kill(): Promise<void> {
    this.killed = true;
    if (!this.ended) this.push({ kind: "exited", code: 137 });
  }

  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    return {
      next: async (): Promise<IteratorResult<Record<string, unknown>>> => {
        const event = this.events.shift();
        if (event) return { value: event, done: false };
        if (this.ended) return { value: undefined, done: true };
        return await new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function builderRecorder(calls: string[]): any {
  const builder = {
    args(args: string[]) {
      calls.push(`args:${JSON.stringify(args)}`);
      return builder;
    },
    cwd(cwd: string) {
      calls.push(`cwd:${cwd}`);
      return builder;
    },
    timeout(timeoutMs: number) {
      calls.push(`timeout:${timeoutMs}`);
      return builder;
    },
  };
  return builder;
}

function basicSandbox(overrides: Record<string, unknown> = {}): any {
  const calls: string[] = [];
  const fs = {
    read: async () => new Uint8Array([0, 255, 1]),
    write: async () => undefined,
    exists: async () => true,
    stat: async () => ({
      kind: "symlink",
      size: 3,
      mode: 0o644,
      readonly: false,
      modified: new Date(1234),
    }),
    list: async () => [
      { path: "/tmp/.hidden", kind: "file" },
      { path: "/tmp/link", kind: "symlink" },
      { path: "/tmp/device", kind: "other" },
    ],
    copyFromHost: async () => undefined,
    copyToHost: async () => undefined,
  };
  const sandbox = {
    calls,
    fs: () => fs,
    execWith: async (_command: string, configure: (builder: any) => any) => {
      configure(builderRecorder(calls));
      return {
        stdoutBytes: () => new Uint8Array([0, 255]),
        stderrBytes: () => new Uint8Array([2]),
        code: 7,
      };
    },
    ...overrides,
  };
  return sandbox;
}

test("maps filesystem calls and preserves binary data", async () => {
  const sandbox = basicSandbox();
  const transport = createSdkTransport(sandbox);

  assert.deepEqual(await transport.readFile("/tmp/data"), Buffer.from([0, 255, 1]));
  await transport.writeFile("/tmp/data", Buffer.from([255, 0]));
  assert.equal(await transport.exists("/tmp/data"), true);
  assert.deepEqual(await transport.stat("/tmp/link"), {
    kind: "other",
    size: 3,
    mode: 0o644,
    readonly: false,
    modifiedAt: 1234,
  });
  assert.deepEqual(await transport.list("/tmp"), [
    { name: ".hidden", kind: "file" },
    { name: "link", kind: "other" },
    { name: "device", kind: "other" },
  ]);
  await transport.copyFromHost("/host/a", "/guest/a");
  await transport.copyToHost("/guest/a", "/host/a");
});

test("configures collected execution exactly and returns raw output bytes", async () => {
  const sandbox = basicSandbox();
  const transport = createSdkTransport(sandbox);

  const result = await transport.exec("printf", ["--", "x"], {
    cwd: "/work",
    timeoutMs: 2500,
  });
  assert.deepEqual(result, {
    stdout: Buffer.from([0, 255]),
    stderr: Buffer.from([2]),
    exitCode: 7,
  });
  assert.deepEqual(sandbox.calls, [
    'args:["--","x"]',
    "cwd:/work",
    "timeout:2500",
  ]);
});

test("omits optional execution setters when options are absent", async () => {
  const sandbox = basicSandbox();
  const transport = createSdkTransport(sandbox);
  await transport.exec("true", []);
  assert.deepEqual(sandbox.calls, ["args:[]"]);
});

test("preserves a missing executable's normal exit code 127", async () => {
  const sandbox = basicSandbox({
    execWith: async () => ({
      stdoutBytes: () => new Uint8Array(),
      stderrBytes: () => Buffer.from("missing executable\n"),
      code: 127,
    }),
  });
  const result = await createSdkTransport(sandbox).exec("not-installed", []);

  assert.equal(result.exitCode, 127);
  assert.equal(result.stderr.toString(), "missing executable\n");
});

test("routes stdout and stderr independently and captures exit after output", async () => {
  const handle = new FakeHandle();
  handle.push({ kind: "stdout", data: Uint8Array.from([0, 255]) });
  handle.push({ kind: "stderr", data: "warning\n" });
  handle.push({ kind: "stdout", data: Uint8Array.from([1]) });
  handle.push({ kind: "exited", code: 23 });
  const calls: string[] = [];
  const sandbox = basicSandbox({
    execStreamWith: async (_command: string, configure: (builder: any) => any) => {
      configure(builderRecorder(calls));
      return handle;
    },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const transport = createSdkTransport(sandbox);

  const result = await transport.execStream("rg", ["needle"], {
    cwd: "/work",
    onStdout: (data) => stdout.push(data),
    onStderr: (data) => stderr.push(data),
  });

  assert.equal(result.exitCode, 23);
  assert.deepEqual(Buffer.concat(stdout), Buffer.from([0, 255, 1]));
  assert.equal(Buffer.concat(stderr).toString(), "warning\n");
  assert.deepEqual(calls, ['args:["needle"]', "cwd:/work"]);
});

test("keeps concurrent stream handles isolated", async () => {
  const handles: FakeHandle[] = [];
  const sandbox = basicSandbox({
    execStreamWith: async () => {
      const handle = new FakeHandle();
      handles.push(handle);
      const id = handles.length;
      queueMicrotask(() => {
        handle.push({ kind: "stdout", data: `stream-${id}` });
        handle.push({ kind: "exited", code: id });
      });
      return handle;
    },
  });
  const transport = createSdkTransport(sandbox);
  const output: string[] = [];
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      transport.execStream(`cmd-${index}`, [], {
        onStdout: (data) => output.push(data.toString()),
      }),
    ),
  );

  assert.equal(new Set(output).size, 20);
  assert.deepEqual(results.map((result) => result.exitCode).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
});

test("abort kills only the selected handle and rejects with ABORTED", async () => {
  const handles: FakeHandle[] = [];
  const sandbox = basicSandbox({
    execStreamWith: async () => {
      const handle = new FakeHandle();
      handles.push(handle);
      return handle;
    },
  });
  const transport = createSdkTransport(sandbox);
  const first = new AbortController();
  const second = new AbortController();
  const pendingFirst = transport.execStream("long", [], { signal: first.signal });
  const pendingSecond = transport.execStream("other", [], { signal: second.signal });

  first.abort();
  await assert.rejects(pendingFirst, (error: unknown) => {
    return error instanceof SandboxTransportError && error.code === "ABORTED";
  });
  assert.equal(handles[0].killed, true);
  assert.equal(handles[1].killed, false);
  await transport.dispose();
  await assert.rejects(pendingSecond, (error: unknown) => {
    return error instanceof SandboxTransportError && error.code === "SANDBOX_DOWN";
  });
});

test("maps typed SDK timeout and not-found errors without message matching", async () => {
  const timeoutSandbox = basicSandbox({
    execWith: async () => {
      throw new ExecTimeoutError("timeout text should remain only in cause");
    },
  });
  const timeoutTransport = createSdkTransport(timeoutSandbox);
  await assert.rejects(timeoutTransport.exec("sleep", ["1"]), (error: unknown) => {
    return error instanceof SandboxTransportError && error.code === "TIMEOUT" && error.cause instanceof ExecTimeoutError;
  });

  const missingSandbox = basicSandbox({
    fs: () => ({
      read: async () => {
        throw new SandboxNotFoundError("missing");
      },
    }),
  });
  await assert.rejects(createSdkTransport(missingSandbox).readFile("/missing"), (error: unknown) => {
    return error instanceof SandboxTransportError && error.code === "NOT_FOUND";
  });
});

test("dispose kills and drains active handles, is idempotent, and rejects new work", async () => {
  const handle = new FakeHandle();
  const sandbox = basicSandbox({ execStreamWith: async () => handle });
  const transport = createSdkTransport(sandbox);
  const pending = transport.execStream("long", []);
  await transport.dispose();
  assert.equal(handle.killed, true);
  await assert.rejects(pending, (error: unknown) => {
    return error instanceof SandboxTransportError && error.code === "SANDBOX_DOWN";
  });
  await transport.dispose();
  await assert.rejects(transport.exists("/tmp"), (error: unknown) => {
    return error instanceof SandboxTransportError && error.code === "SANDBOX_DOWN";
  });
});

test("dispose waits for an in-flight stream acquisition and drains its late handle", async () => {
  let resolveHandle!: (handle: FakeHandle) => void;
  const acquisition = new Promise<FakeHandle>((resolve) => {
    resolveHandle = resolve;
  });
  const sandbox = basicSandbox({
    execStreamWith: async () => acquisition,
  });
  const transport = createSdkTransport(sandbox);
  const pending = transport.execStream("late", []);
  await Promise.resolve();

  let disposed = false;
  const disposing = transport.dispose().then(() => {
    disposed = true;
  });
  await Promise.resolve();
  assert.equal(disposed, false);

  const lateHandle = new FakeHandle();
  resolveHandle(lateHandle);
  await disposing;
  assert.equal(lateHandle.killed, true);
  await assert.rejects(pending, (error: unknown) => {
    return error instanceof SandboxTransportError && error.code === "SANDBOX_DOWN";
  });
});

test("does not import microsandbox at module load", async () => {
  const transport = createSdkTransport({});
  await assert.rejects(transport.exec("true", []), (error: unknown) => {
    return error instanceof SandboxTransportError && error.code === "INVALID";
  });
});
