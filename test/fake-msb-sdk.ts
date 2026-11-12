import type { MicrosandboxModule } from "../extensions/pi-msb/control.ts";

function notFound(): Error {
  return Object.assign(new Error("not found"), { code: "NOT_FOUND" });
}

export function fakeSdk(calls: string[], initial?: { name: string; status: string; labels: Record<string, string> }, logText = ""): MicrosandboxModule {
  const sandboxes = new Map<string, any>();

  const rawSandbox = (name: string) => ({
    name,
    fs: () => ({
      read: async () => Buffer.alloc(0), write: async () => undefined, exists: async () => true,
      stat: async () => ({ kind: "directory", size: 0, mode: 0o755, readonly: false }), list: async () => [],
    }),
    execWith: async (command: string, configure: (builder: any) => void) => {
      const execution = { args: [] as string[], cwd: undefined as string | undefined, timeout: undefined as number | undefined };
      const builder: any = {
        args(value: string[]) { execution.args = value; return builder; },
        cwd(value: string) { execution.cwd = value; return builder; },
        timeout(value: number) { execution.timeout = value; return builder; },
      };
      configure(builder);
      calls.push(`exec:${command}:${JSON.stringify(execution.args)}`);
      return { stdoutBytes: () => Buffer.alloc(0), stderrBytes: () => Buffer.alloc(0), code: 0 };
    },
    execStreamWith: async () => ({ async *[Symbol.asyncIterator]() { yield { kind: "exited", code: 0 }; }, kill: async () => undefined }),
  });

  const makeHandle = (name: string, status: string, labels: Record<string, string>) => {
    const raw = rawSandbox(name);
    const handle: any = {
      name, status, createdAt: new Date(),
      config: () => ({ name, labels }),
      connect: async () => { calls.push(`connect:${name}`); return raw; },
      startDetached: async () => { calls.push(`start:${name}`); return raw; },
      stopWithTimeout: async () => { calls.push(`stop:${name}`); },
      waitUntilStopped: async () => ({ status: "stopped" }),
      remove: async () => { calls.push(`remove:${name}`); sandboxes.delete(name); },
      logs: async () => [{ text: () => logText }],
    };
    sandboxes.set(name, handle);
    return handle;
  };
  if (initial) makeHandle(initial.name, initial.status, initial.labels);

  const Sandbox = {
    builder(name: string) {
      const metadata = { labels: {} as Record<string, string> };
      const builder: any = {
        image(value: string) { calls.push(`image:${value}`); return builder; },
        pullPolicy(value: string) { calls.push(`pull-policy:${value}`); return builder; },
        cpus(value: number) { calls.push(`cpus:${value}`); return builder; },
        memory(value: number) { calls.push(`memory:${value}`); return builder; },
        idleTimeout(value: number) { calls.push(`idle:${value}`); return builder; },
        detached(value: boolean) { calls.push(`detached:${value}`); return builder; },
        workdir(value: string) { calls.push(`workdir:${value}`); return builder; },
        labels(value: Record<string, string>) { metadata.labels = value; calls.push(`labels:${JSON.stringify(value)}`); return builder; },
        volume(guest: string, configure: (mount: any) => void) {
          calls.push(`volume:${guest}`);
          const mount: any = {
            bind(value: string) { calls.push(`bind:${value}`); return mount; },
            named(value: string) { calls.push(`named:${value}`); return mount; },
            tmpfs() { calls.push("tmpfs"); return mount; },
            readonly() { calls.push("readonly"); return mount; },
            noexec() { calls.push("noexec"); return mount; },
            nosuid() { calls.push("nosuid"); return mount; },
            nodev() { calls.push("nodev"); return mount; },
          };
          configure(mount);
          return builder;
        },
        disableNetwork() { calls.push("network:deny"); return builder; },
        network(configure: (network: any) => void) { const network = { policy: () => { calls.push("network:policy"); return network; } }; configure(network); return builder; },
        port(host: number, guest: number) { calls.push(`port:${host}:${guest}`); return builder; },
        portBind(bind: string, host: number, guest: number) { calls.push(`port-bind:${bind}:${host}:${guest}`); return builder; },
        envs(value: Record<string, string>) { calls.push(`envs:${Object.keys(value).join(",")}`); return builder; },
        secret(configure: (secret: any) => void) {
          const secret: any = { env: (name: string) => { calls.push(`secret-env:${name}`); return secret; }, value: () => { calls.push("secret-value:masked"); return secret; }, requireTlsIdentity: () => secret, allowHost: () => secret, allowHostPattern: () => secret };
          configure(secret); return builder;
        },
        async create() {
          calls.push(`create:${name}`);
          makeHandle(name, "running", metadata.labels);
          return rawSandbox(name);
        },
      };
      return builder;
    },
    async get(name: string) { const handle = sandboxes.get(name); if (!handle) throw notFound(); return handle; },
    async listWith() { return { sandboxes: [], nextCursor: undefined }; },
  };
  return { Sandbox, defaultBackendKind: () => "local", Image: {
    get: async () => { throw Object.assign(new Error("image missing"), { code: "imageNotFound" }); },
    inspect: async () => { throw new Error("Unexpected image inspection"); },
    load: async () => { throw new Error("Unexpected image import"); },
    save: async () => { throw new Error("Unexpected image export"); },
  } };
}
