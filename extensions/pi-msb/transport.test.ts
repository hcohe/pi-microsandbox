import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import {
  causalErrorDetails,
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

// Import the installed SDK's JS wrapper directly, not its native-loading entrypoint.
async function sdkHandle(
  events: Array<Record<string, unknown> | Error | null>,
  hooks: { kill?: () => Promise<void>; close?: () => Promise<void> } = {},
) {
  const { ExecHandle } = await import(new URL("./exec.js", import.meta.resolve("microsandbox")).href);
  const state = { kills: 0, closes: 0, receives: 0 };
  const handle = new ExecHandle({
    async recv() {
      state.receives++;
      const event = events.shift() ?? null;
      if (event instanceof Error) throw event;
      return event;
    },
    async kill() {
      state.kills++;
      await hooks.kill?.();
    },
  });
  const iterate = handle[Symbol.asyncIterator].bind(handle);
  handle[Symbol.asyncIterator] = () => {
    const iterator = iterate();
    const close = iterator.return.bind(iterator);
    iterator.return = async () => {
      state.closes++;
      await hooks.close?.();
      return await close();
    };
    return iterator;
  };
  return { handle, state, events };
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
  assert.equal("copyFromHost" in transport, false);
  assert.equal("copyToHost" in transport, false);
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

test("requires an exit event even when the stream produced output", async () => {
  for (const events of [[], [{ kind: "stdout", data: "partial output" }]]) {
    const handle = new FakeHandle();
    for (const event of events) handle.push(event);
    handle.ended = true;
    const transport = createSdkTransport(basicSandbox({ execStreamWith: async () => handle }));
    await assert.rejects(transport.execStream("truncated", []), (error: unknown) => {
      return error instanceof SandboxTransportError && error.code === "INVALID";
    });
  }
});

test("rejects malformed exit codes rather than reporting successful completion", async (t) => {
  for (const code of [undefined, null, "0", false, {}, NaN, Infinity, -Infinity, 0.5]) {
    await t.test(`exit code ${String(code)}`, async () => {
      const handle = new FakeHandle();
      handle.push({ kind: "exited", code });
      const transport = createSdkTransport(basicSandbox({ execStreamWith: async () => handle }));
      await assert.rejects(transport.execStream("malformed", []), (error: unknown) => {
        return error instanceof SandboxTransportError && error.code === "INVALID";
      });
    });
  }
});

test("a valid exit event does not hide a subsequent malformed completion", async () => {
  const handle = new FakeHandle();
  handle.push({ kind: "exited", code: 0 });
  handle.push({ kind: "exited", code: "0" });
  const transport = createSdkTransport(basicSandbox({ execStreamWith: async () => handle }));
  await assert.rejects(transport.execStream("malformed", []), (error: unknown) => {
    return error instanceof SandboxTransportError && error.code === "INVALID";
  });
});

test("accepts finite integer stream exit codes including zero", async () => {
  for (const code of [0, 127, -1]) {
    const handle = new FakeHandle();
    handle.push({ kind: "exited", code });
    const transport = createSdkTransport(basicSandbox({ execStreamWith: async () => handle }));
    assert.deepEqual(await transport.execStream("complete", []), { exitCode: code });
  }
});

test("abort and dispose take precedence over missing or malformed completion", async (t) => {
  for (const completion of ["missing", "malformed"]) {
    for (const cancellation of ["abort", "dispose", "both"]) {
      await t.test(`${cancellation} with ${completion} completion`, async () => {
        const controller = new AbortController();
        const reason = new Error("cancelled");
        let killed = false;
        const handle = {
          kill: async () => { killed = true; },
          async *[Symbol.asyncIterator]() {
            yield { kind: "stdout", data: "partial output" };
            if (completion === "malformed") yield { kind: "exited", code: NaN };
          },
        };
        const transport = createSdkTransport(basicSandbox({ execStreamWith: async () => handle }));
        let disposing: Promise<void> | undefined;
        const pending = transport.execStream("cancelled", [], {
          signal: controller.signal,
          onStdout: () => {
            if (cancellation !== "dispose") controller.abort(reason);
            if (cancellation !== "abort") disposing = transport.dispose();
          },
        });
        await assert.rejects(pending, (error: unknown) => {
          assert.ok(error instanceof SandboxTransportError);
          assert.equal(error.code, cancellation === "dispose" ? "SANDBOX_DOWN" : "ABORTED");
          if (cancellation !== "dispose") assert.equal(error.cause, reason);
          return true;
        });
        await disposing;
        assert.equal(killed, true);
      });
    }
  }
});

test("SDK wrapper requires an explicit valid completion and cleans up failures", async (t) => {
  const cases = [
    { name: "empty", events: [], code: "INVALID" },
    { name: "output then EOF", events: [{ eventType: "stdout", data: Buffer.from("partial") }], code: "INVALID" },
    ...[NaN, Infinity, -Infinity, 0.5].map((code) => ({
      name: `malformed ${code}`,
      events: [{ eventType: "exited", code }],
      code: "INVALID",
    })),
    ...[undefined, null, "0"].map((code) => ({
      name: `normalizer rejects ${code}`,
      events: [{ eventType: "exited", code }],
      // The installed SDK throws an untyped Error before transport validation.
      code: "UNKNOWN",
    })),
    {
      name: "recv rejects after valid exit",
      events: [{ eventType: "exited", code: 0 }, new Error("[ExecTimeout] timed out")],
      code: "TIMEOUT",
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const wrapped = await sdkHandle([...scenario.events]);
      const controller = new AbortController();
      const transport = createSdkTransport(basicSandbox({ execStreamWith: async () => wrapped.handle }));
      await assert.rejects(transport.execStream("broken", [], { signal: controller.signal }), (error: unknown) => {
        assert.ok(error instanceof SandboxTransportError);
        assert.equal(error.code, scenario.code);
        if (scenario.code === "UNKNOWN") {
          assert.ok(error.cause instanceof Error);
          assert.match(error.cause.message, /missing code on Exited/);
        }
        return true;
      });
      assert.equal(wrapped.state.kills, 1);
      assert.equal(wrapped.state.closes, 1);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      controller.abort();
      await transport.dispose();
      assert.equal(wrapped.state.kills, 1);
    });
  }
});

test("SDK wrapper preserves normal nonzero exits without cleanup kills", async () => {
  for (const code of [0, 23, 127, -1]) {
    const wrapped = await sdkHandle([{ eventType: "exited", code }]);
    const controller = new AbortController();
    const transport = createSdkTransport(basicSandbox({ execStreamWith: async () => wrapped.handle }));
    assert.deepEqual(await transport.execStream("complete", [], { signal: controller.signal }), { exitCode: code });
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await transport.dispose();
    assert.equal(wrapped.state.kills, 0);
  }
});

test("failed consumption closes its SDK iterator without draining unread events", async () => {
  const wrapped = await sdkHandle([
    { eventType: "exited", code: NaN },
    { eventType: "stdout", data: Buffer.from("must not deliver") },
  ]);
  const transport = createSdkTransport(basicSandbox({ execStreamWith: async () => wrapped.handle }));
  await assert.rejects(transport.execStream("broken", [], {
    onStdout: () => assert.fail("cleanup must not deliver more output"),
  }), { code: "INVALID" });
  assert.deepEqual(wrapped.state, { kills: 1, closes: 1, receives: 1 });
  assert.equal(wrapped.events.length, 1);
});

test("cleanup errors preserve the primary stream error", async () => {
  const wrapped = await sdkHandle([{ eventType: "exited", code: NaN }], {
    kill: async () => { throw new Error("[Io] kill failed"); },
    close: async () => { throw new Error("close failed"); },
  });
  const transport = createSdkTransport(basicSandbox({ execStreamWith: async () => wrapped.handle }));
  await assert.rejects(transport.execStream("broken", []), { code: "INVALID" });
  assert.deepEqual(wrapped.state, { kills: 1, closes: 1, receives: 1 });
  await transport.dispose();
});

test("dispose waits for failed-stream cleanup without a kill/done cycle", async (t) => {
  for (const abort of [false, true]) {
    await t.test(`abort during cleanup: ${abort}`, async () => {
      let releaseKill!: () => void;
      let startedKill!: () => void;
      const killing = new Promise<void>((resolve) => { startedKill = resolve; });
      const gate = new Promise<void>((resolve) => { releaseKill = resolve; });
      const wrapped = await sdkHandle([{ eventType: "exited", code: NaN }], {
        kill: async () => { startedKill(); await gate; },
      });
      const controller = new AbortController();
      const reason = new Error("cancel during cleanup");
      const transport = createSdkTransport(basicSandbox({ execStreamWith: async () => wrapped.handle }));
      const pending = transport.execStream("broken", [], { signal: controller.signal });
      await killing;
      let disposed = false;
      const disposing = transport.dispose().then(() => { disposed = true; });
      if (abort) controller.abort(reason);
      await Promise.resolve();
      assert.equal(disposed, false);
      releaseKill();
      await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof SandboxTransportError);
        assert.equal(error.code, abort ? "ABORTED" : "SANDBOX_DOWN");
        if (abort) assert.equal(error.cause, reason);
        return true;
      });
      await disposing;
      assert.equal(wrapped.state.kills, 1);
      assert.equal(wrapped.state.closes, 1);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    });
  }
});

test("uncooperative cleanup is bounded and does not mask the stream error", { timeout: 5000 }, async () => {
  const never = () => new Promise<void>(() => undefined);
  const wrapped = await sdkHandle([{ eventType: "exited", code: NaN }], { kill: never, close: never });
  const controller = new AbortController();
  const transport = createSdkTransport(basicSandbox({ execStreamWith: async () => wrapped.handle }));
  const pending = transport.execStream("broken", [], { signal: controller.signal });
  await assert.rejects(pending, { code: "INVALID" });
  await transport.dispose();
  assert.equal(wrapped.state.kills, 1);
  assert.equal(wrapped.state.closes, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
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

test("stream diagnostics retain raw output counts, real observed exit and typed failure without SDK messages", async () => {
  const wrapped = await sdkHandle([
    { eventType: "stdout", data: Buffer.from([0xff, 0, 65]) },
    { eventType: "stderr", data: Buffer.from("partial stderr") },
    { eventType: "exited", code: 23 },
    Object.assign(new Error("PRIVATE connection detail\u202e"), { code: "CONNECTION_CLOSED" }),
  ], { kill: async () => { throw Object.assign(new Error("PRIVATE kill"), { code: "IO" }); }, close: async () => { throw new Error("PRIVATE close"); } });
  const transport = createSdkTransport(basicSandbox({ execStreamWith: async () => wrapped.handle }));
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  await assert.rejects(transport.execStream("broken", [], { timeoutMs: 123, onStdout: (data) => stdout.push(Buffer.from(data)), onStderr: (data) => stderr.push(Buffer.from(data)) }), (error: unknown) => {
    assert.ok(error instanceof SandboxTransportError);
    assert.equal(error.code, "SANDBOX_DOWN");
    const diagnostics = error.diagnostics!;
    assert.equal(diagnostics.failureKind, "transport");
    assert.equal(diagnostics.observedExitCode, 23);
    assert.equal(diagnostics.events, 3);
    assert.equal(diagnostics.stdoutBytes, 3);
    assert.equal(diagnostics.stderrBytes, 14);
    assert.equal(diagnostics.requestedTimeoutMs, 123);
    assert.equal(diagnostics.sdkStreamingTimeoutEnforced, true);
    assert.ok(diagnostics.elapsedMs >= diagnostics.lastOutputElapsedMs!);
    assert.deepEqual(diagnostics.cleanup, [{ operation: "kill", outcome: "failed", code: "IO" }, { operation: "iteratorReturn", outcome: "failed", code: "UNKNOWN" }]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE|connection detail/);
    assert.ok(diagnostics.causes.some((cause) => cause.code === "SANDBOX_DOWN"));
    return true;
  });
  assert.deepEqual(Buffer.concat(stdout), Buffer.from([0xff, 0, 65]));
  assert.equal(Buffer.concat(stderr).toString(), "partial stderr");
  await transport.dispose();
});

test("causal diagnostics bound depth, cycles and typed tokens without reading messages", () => {
  const error: any = new Error("PRIVATE MESSAGE"); error.code = "IO";
  error.cause = error;
  assert.deepEqual(causalErrorDetails(error), [{ name: "Error", code: "IO" }]);
  error.code = "SECRET\u202e\x1b";
  assert.deepEqual(causalErrorDetails(error), [{ name: "Error" }]);
  let chain: Error = new Error("private");
  for (let i = 0; i < 10; i++) chain = new Error("private", { cause: chain });
  assert.equal(causalErrorDetails(chain).length, 4);
  const hostile = Object.defineProperty({}, "cause", { get() { throw new Error("private getter"); } });
  assert.deepEqual(causalErrorDetails(hostile), [{ name: "Error" }]);
});

test("pinned SDK streaming timeout errors retain typed failure and cleanup without inferring EOF timeouts", async () => {
  const wrapped = await sdkHandle([new ExecTimeoutError("PRIVATE timeout")]);
  const transport = createSdkTransport(basicSandbox({ execStreamWith: async () => wrapped.handle }));
  await assert.rejects(transport.execStream("sleep", ["10"], { timeoutMs: 1 }), (error: unknown) => {
    assert.ok(error instanceof SandboxTransportError);
    assert.equal(error.code, "TIMEOUT");
    assert.equal(error.diagnostics?.failureKind, "timeout");
    assert.equal(error.diagnostics?.sdkStreamingTimeoutEnforced, true);
    assert.deepEqual(error.diagnostics?.cleanup.map((item) => item.operation), ["kill", "iteratorReturn"]);
    assert.doesNotMatch(JSON.stringify(error.diagnostics), /PRIVATE/);
    return true;
  });
  await transport.dispose();
});
