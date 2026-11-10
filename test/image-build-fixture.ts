import { promises as fs } from "node:fs";
import { join } from "node:path";
import { fakeSdk } from "./fake-msb-sdk.ts";
import { nativeBuildPlatform } from "../extensions/pi-msb/image-source.ts";
import type { MicrosandboxModule } from "../extensions/pi-msb/control.ts";

export function tarArchive(files: Record<string, string | Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const [path, value] of Object.entries(files)) {
    const data = Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(path, 0, 100);
    header.write("0000644\0", 100, 8);
    header.write("0000000\0", 108, 8);
    header.write("0000000\0", 116, 8);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    header.write("00000000000\0", 136, 12);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
export function dockerArchive(reference: string, platform = nativeBuildPlatform(), extra: Record<string, string> = {}): Buffer {
  return tarArchive({
    "manifest.json": JSON.stringify([{ Config: "config.json", RepoTags: [reference], Layers: ["layer.tar"] }]),
    "config.json": JSON.stringify({ os: platform.split("/")[0], architecture: platform.split("/")[1], rootfs: { type: "layers", diff_ids: [] } }),
    "layer.tar": "layer bytes", ...extra,
  });
}
export function buildSdk(calls: string[], hooks: {
  archive?: (reference: string) => Buffer;
  create?: () => Promise<void>;
  build?: () => Promise<void>;
  import?: () => Promise<void>;
  failStep?: string;
  persistBeforeCreate?: boolean;
  stderr?: string;
} = {}): MicrosandboxModule {
  const sdk = fakeSdk(calls);
  const runtimeBuilder = sdk.Sandbox.builder;
  const runtimeGet = sdk.Sandbox.get;
  const records = new Map<string, any>();
  const images = new Map<string, any>();
  sdk.Sandbox.get = async (name: string) => {
    if (!name.startsWith("pi-msb-builder-")) return runtimeGet(name);
    calls.push(`builder-get:${name}`);
    const handle = records.get(name);
    if (!handle) throw Object.assign(new Error("PRIVATE NOT FOUND"), { code: "sandboxNotFound" });
    return handle;
  };
  sdk.defaultBackendKind = () => "local";
  sdk.NetworkPolicy = { fromProfiles: (profiles: string[]) => {
    calls.push(`builder-profiles:${profiles.join(",")}`);
    return { defaultEgress: "deny", defaultIngress: "allow", rules: [{ public: true }, { dns: true }] };
  } };
  sdk.Image = {
    get: async (reference: string) => { calls.push(`image-get:${reference}`); if (!images.has(reference)) throw new Error("missing"); return images.get(reference); },
    load: async (path: string, options?: { tag?: string }) => {
      calls.push(`image-load:${path}`);
      await hooks.import?.();
      if (hooks.failStep === "import") throw new Error("PRIVATE IMPORT OUTPUT");
      const tag = options!.tag!;
      images.set(tag, { reference: tag, architecture: nativeBuildPlatform().split("/")[1], os: "linux", manifestDigest: `sha256:${"a".repeat(64)}` });
      return [images.get(tag)];
    },
  };
  sdk.Sandbox.builder = (name: string) => {
    if (!name.startsWith("pi-msb-builder-")) return runtimeBuilder(name);
    const volumes: Record<string, string> = {};
    let reference = "";
    let labels: Record<string, string> = {};
    const builder: any = {};
    for (const method of ["image", "rootDisk", "pullPolicy", "cpus", "memory", "security", "user", "detached", "maxDuration", "idleTimeout", "workdir"]) builder[method] = (value: unknown) => { calls.push(`builder-${method}:${value}`); return builder; };
    builder.labels = (value: Record<string, string>) => { labels = value; calls.push(`builder-labels:${JSON.stringify(value)}`); return builder; };
    builder.network = (configure: (network: any) => void) => { configure({ policy: (policy: any) => { calls.push(`builder-network:${JSON.stringify(policy)}`); } }); return builder; };
    builder.volume = (guest: string, configure: (mount: any) => void) => {
      const mount = { bind: (host: string) => { volumes[guest] = host; calls.push(`builder-bind:${guest}:${host}`); return mount; }, readonly: () => { calls.push(`builder-readonly:${guest}`); return mount; } };
      configure(mount); return builder;
    };
    builder.create = async () => {
      calls.push("builder-create");
      const handle = {
        name, id: `record-${name}`, backendKind: "local", config: () => ({ name, labels }),
        destroy: async (options: { timeoutMs: number }) => {
          calls.push(`builder-record-destroy:${name}:${options.timeoutMs}`);
          if (records.get(name) !== handle) throw new Error("Sandbox replaced");
          calls.push("builder-destroy");
          if (hooks.failStep === "destroy") throw new Error("PRIVATE CLEANUP");
          records.delete(name);
        },
      };
      if (hooks.persistBeforeCreate !== false) records.set(name, handle);
      await hooks.create?.();
      if (hooks.failStep === "create") throw new Error("PRIVATE CREATE OUTPUT");
      const raw: any = {
        name, ownsLifecycle: true, backendKind: "local", config: async () => ({ name, labels }),
        destroy: async (options: { timeoutMs: number }) => handle.destroy(options),
        execStreamWith: async (_command: string, configure: (exec: any) => void) => {
          let args: string[] = [];
          const exec: any = { args: (value: string[]) => { args = value; return exec; }, timeout: () => exec };
          configure(exec);
          calls.push(`builder-exec:${JSON.stringify(args)}`);
          return {
            kill: async () => { calls.push("builder-kill"); },
            async *[Symbol.asyncIterator]() {
              if (args.includes("buildx")) { reference = args[args.indexOf("--tag") + 1]!; await hooks.build?.(); }
              if (args.includes("save")) await fs.writeFile(join(volumes["/pi-msb-output"]!, "image.tar"), (hooks.archive ?? dockerArchive)(reference));
              yield { kind: "stdout", data: Buffer.from("BUILD STDOUT") };
              yield { kind: "stderr", data: Buffer.from(hooks.stderr ?? "PRIVATE GUEST OUTPUT") };
              yield { kind: "exited", code: hooks.failStep === "build" && args.includes("buildx") ? 1 : hooks.failStep === "export" && args.includes("save") ? 42 : 0 };
            },
          };
        },
      };
      return raw;
    };
    return builder;
  };
  return sdk;
}
