#!/usr/bin/env node
import { chmod, copyFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = ["darwin-arm64", "linux-arm64-gnu", "linux-x64-gnu"];

function usage() {
  throw new Error("usage: node scripts/assemble-package.mjs <artifact-root> <git-archive-staging-root>");
}

async function collectTree(root) {
  const entries = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new Error(`artifact tree contains a symlink: ${path}`);
      if (metadata.isDirectory()) {
        entries.push(`${path}/`);
        await visit(absolute);
      } else if (metadata.isFile()) {
        entries.push(path);
      } else {
        throw new Error(`artifact tree contains a non-regular entry: ${path}`);
      }
    }
  }
  await visit(root);
  return entries.sort();
}

async function validateBinary(path, target) {
  const bytes = await readFile(path);
  if (target === "darwin-arm64") {
    const expected = [0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01];
    if (bytes.length < 1024
      || !expected.every((byte, index) => bytes[index] === byte)
      || bytes.readUInt32LE(12) !== 8) {
      throw new Error(`${target}/flock.node is not a thin arm64 Mach-O bundle`);
    }
    return;
  }

  if (bytes.length < 1024
    || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46
    || bytes[4] !== 2 || bytes[5] !== 1) {
    throw new Error(`${target}/flock.node is not a 64-bit little-endian ELF binary`);
  }
  if (bytes.readUInt16LE(16) !== 3) {
    throw new Error(`${target}/flock.node is not an ELF shared object`);
  }
  const machine = bytes.readUInt16LE(18);
  const expectedMachine = target === "linux-x64-gnu" ? 62 : 183;
  if (machine !== expectedMachine) {
    throw new Error(`${target}/flock.node has ELF machine ${machine}, expected ${expectedMachine}`);
  }
}

if (process.argv.length !== 4) usage();
const artifactRoot = resolve(process.argv[2]);
const stagingRoot = resolve(process.argv[3]);
if (artifactRoot === stagingRoot || stagingRoot === ROOT) {
  throw new Error("assembly destination must be a separate temporary staging checkout");
}

const artifactMetadata = await lstat(artifactRoot);
if (!artifactMetadata.isDirectory() || artifactMetadata.isSymbolicLink()) {
  throw new Error("artifact root must be a real directory");
}
const stagingMetadata = await lstat(stagingRoot);
if (!stagingMetadata.isDirectory() || stagingMetadata.isSymbolicLink()) {
  throw new Error("staging root must be a real directory");
}
const manifestMetadata = await lstat(join(stagingRoot, "package.json"));
if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
  throw new Error("staging root must contain a regular package.json");
}
try {
  await lstat(join(stagingRoot, ".git"));
  throw new Error("staging root must be created from git archive, not a working checkout");
} catch (error) {
  if (error instanceof Error && error.message.includes("must be created")) throw error;
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
}

const expectedEntries = TARGETS.flatMap((target) => [`${target}/`, `${target}/flock.node`]).sort();
const actualEntries = await collectTree(artifactRoot);
if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
  throw new Error(
    `artifact root must contain exactly ${TARGETS.map((target) => `${target}/flock.node`).join(", ")}\n`
    + `received: ${actualEntries.join(", ") || "(empty)"}`,
  );
}

const destinationRoot = join(stagingRoot, "native", "flock", "prebuilds");
try {
  const destinationEntries = await collectTree(destinationRoot);
  if (destinationEntries.length !== 0) throw new Error("staging prebuild destination must be empty");
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
}

for (const target of TARGETS) {
  const source = join(artifactRoot, target, "flock.node");
  await validateBinary(source, target);
  const destinationDirectory = join(destinationRoot, target);
  await mkdir(destinationDirectory, { recursive: true, mode: 0o755 });
  const destination = join(destinationDirectory, "flock.node");
  await copyFile(source, destination);
  await chmod(destination, 0o755);
}

console.log(`assembled ${TARGETS.length} flock prebuilds into ${destinationRoot}`);
