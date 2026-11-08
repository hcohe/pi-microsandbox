import { constants, promises as fs } from "node:fs";

interface TarEntry { offset: number; size: number; header: Buffer }
const BLOCK = 512;
const MAX_ARCHIVE_BYTES = 16 * 1024 ** 3;
const MAX_METADATA_BYTES = 1024 * 1024;

/** Reduce an untrusted guest export to one Docker-save image, excluding all OCI/index aliases. */
export async function prepareBuildArchive(input: string, output: string, reference: string, platform: string, signal?: AbortSignal): Promise<void> {
  const file = await fs.open(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !stat.size || stat.size > MAX_ARCHIVE_BYTES || stat.size % BLOCK) throw new Error("Invalid build archive");
    const read = async (position: number, length: number): Promise<Buffer> => {
      signal?.throwIfAborted();
      const data = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const result = await file.read(data, offset, length - offset, position + offset);
        if (!result.bytesRead) throw new Error("Truncated archive");
        offset += result.bytesRead;
      }
      return data;
    };
    const entries = new Map<string, TarEntry>();
    const number = (data: Buffer) => {
      const text = data.toString("ascii").replace(/\0.*$/, "").trim();
      if (!/^[0-7]+$/.test(text)) throw new Error("Invalid tar number");
      const value = parseInt(text, 8);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid tar size");
      return value;
    };
    const name = (data: Buffer) => data.toString("utf8").replace(/\0.*$/, "");
    let position = 0;
    let ended = false;
    while (position < stat.size) {
      const header = await read(position, BLOCK);
      if (header.every((byte) => byte === 0)) {
        if (stat.size - position < BLOCK * 2) throw new Error("Missing tar terminator");
        for (let offset = position; offset < stat.size; offset += 64 * 1024) {
          if (!(await read(offset, Math.min(64 * 1024, stat.size - offset))).every((byte) => byte === 0)) throw new Error("Trailing archive data");
        }
        ended = true;
        break;
      }
      if (entries.size >= 16384) throw new Error("Too many archive entries");
      const checksum = number(header.subarray(148, 156));
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
      if (checksum !== sum) throw new Error("Invalid tar checksum");
      const prefix = name(header.subarray(345, 500));
      const path = `${prefix ? `${prefix}/` : ""}${name(header.subarray(0, 100))}`;
      if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === ".") || entries.has(path)) throw new Error("Unsafe archive entry");
      const size = number(header.subarray(124, 136));
      const type = header[156];
      if (![0, 48, 53].includes(type!) || type === 53 && size !== 0) throw new Error("Archive links/extensions/special files are forbidden");
      const offset = position + BLOCK;
      position = offset + Math.ceil(size / BLOCK) * BLOCK;
      if (position > stat.size) throw new Error("Invalid archive bounds");
      entries.set(path, { offset, size, header });
    }
    if (!ended) throw new Error("Missing archive terminator");
    const json = async (path: string): Promise<any> => {
      const entry = entries.get(path);
      if (!entry || entry.size > MAX_METADATA_BYTES || entry.header[156] === 53) throw new Error("Missing or oversized image metadata");
      return JSON.parse((await read(entry.offset, entry.size)).toString("utf8"));
    };
    const manifest = await json("manifest.json");
    if (!Array.isArray(manifest) || manifest.length !== 1) throw new Error("Expected exactly one exported image");
    const image = manifest[0];
    if (!image || !Array.isArray(image.RepoTags) || image.RepoTags.length !== 1 || image.RepoTags[0] !== reference || typeof image.Config !== "string" || !Array.isArray(image.Layers) || image.Layers.length > 4096 || image.Layers.some((layer: unknown) => typeof layer !== "string")) throw new Error("Unexpected exported image references");
    const config = await json(image.Config);
    if (config.os !== "linux" || `linux/${config.architecture}` !== platform) throw new Error("Exported image platform mismatch");
    if ([image.Config, ...image.Layers].some((path) => ["manifest.json", "index.json", "oci-layout", "repositories"].includes(path))) throw new Error("Reserved image member name");
    const required: string[] = ["manifest.json", image.Config, ...image.Layers];
    if (new Set(required).size !== required.length) throw new Error("Duplicate image members");
    for (const path of required) {
      const entry = entries.get(path);
      if (!entry || entry.header[156] === 53) throw new Error("Missing exported image member");
    }
    // Import only Docker-save metadata and its members, never arbitrary guest index.json,
    // repositories or extra manifests (Image.load otherwise imports every reference).
    const destination = await fs.open(output, "wx", 0o600);
    try {
      for (const path of required) {
        const entry = entries.get(path)!;
        await destination.writeFile(entry.header);
        const padded = Math.ceil(entry.size / BLOCK) * BLOCK;
        for (let offset = 0; offset < padded; offset += 64 * 1024) await destination.writeFile(await read(entry.offset + offset, Math.min(64 * 1024, padded - offset)));
      }
      await destination.writeFile(Buffer.alloc(BLOCK * 2));
    } finally { await destination.close(); }
    const after = await file.stat();
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error("Archive changed during validation");
  } finally { await file.close(); }
}
