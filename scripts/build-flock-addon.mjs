#!/usr/bin/env node
import { copyFile, mkdir, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADDON_ROOT = join(ROOT, "native", "flock");
const NODE_API_VERSION = 10;
const HEADER_NODE_VERSION = "22.19.0";

function targetForCurrentHost() {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) {
    const report = process.report?.getReport();
    if (!report?.header?.glibcVersionRuntime) {
      throw new Error("flock addon builds require glibc Linux; musl and unknown libc targets are unsupported");
    }
    return `linux-${process.arch}-gnu`;
  }
  throw new Error(`unsupported flock addon build host: ${process.platform}-${process.arch}`);
}

function parseOutputArgument(args) {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--output" && args[1]) return resolve(args[1]);
  throw new Error("usage: node scripts/build-flock-addon.mjs [--output <directory>]");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function validateBinary(binary, target) {
  const description = run("file", [binary]);
  if (target === "darwin-arm64") {
    if (!/Mach-O 64-bit bundle arm64/.test(description)) {
      throw new Error(`unexpected Darwin addon type: ${description.trim()}`);
    }
    const loadCommands = run("otool", ["-l", binary]);
    if (!/(?:LC_BUILD_VERSION[\s\S]*?minos 11\.0)|(?:LC_VERSION_MIN_MACOSX[\s\S]*?version 11\.0)/.test(loadCommands)) {
      throw new Error("Darwin addon does not declare the required macOS 11.0 deployment target");
    }
    const symbols = run("nm", ["-u", binary]);
    if (!symbols.includes("_napi_create_function")) throw new Error("Darwin addon has no Node-API imports");
    if (/__Z/.test(symbols)) throw new Error("Darwin addon unexpectedly imports C++ symbols");
    const dependencies = run("otool", ["-L", binary])
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
    const unexpected = dependencies.filter((dependency) => dependency !== "/usr/lib/libSystem.B.dylib");
    if (unexpected.length > 0) {
      throw new Error(`Darwin addon links unexpected libraries: ${unexpected.join(", ")}`);
    }
    return;
  }

  const architecture = target === "linux-x64-gnu" ? "x86-64" : "ARM aarch64";
  if (!description.includes("ELF 64-bit") || !description.includes(architecture) || !description.includes("shared object")) {
    throw new Error(`unexpected Linux addon type: ${description.trim()}`);
  }
  const symbols = run("readelf", ["--dyn-syms", "--wide", binary]);
  if (!symbols.includes("napi_create_function")) throw new Error("Linux addon has no Node-API imports");
  if (/_Z[A-Za-z0-9_]/.test(symbols)) throw new Error("Linux addon unexpectedly imports C++ symbols");
  const versions = run("readelf", ["--version-info", binary]);
  for (const match of versions.matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
    const version = Number(match[1]) * 1000 + Number(match[2]);
    if (version > 2028) throw new Error(`Linux addon requires unsupported ${match[0]} (maximum GLIBC_2.28)`);
  }
}

const target = targetForCurrentHost();
const napi = Number(process.versions.napi);
if (!Number.isInteger(napi) || napi < NODE_API_VERSION) {
  throw new Error(`Node-API ${NODE_API_VERSION} is required to build flock (runtime reports ${process.versions.napi ?? "unknown"})`);
}

const outputDir = parseOutputArgument(process.argv.slice(2))
  ?? join(ADDON_ROOT, "prebuilds", target);
const nodeGyp = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "node-gyp.cmd" : "node-gyp");

await rm(join(ADDON_ROOT, "build"), { recursive: true, force: true });
run(nodeGyp, ["rebuild", "--directory", ADDON_ROOT, `--target=${HEADER_NODE_VERSION}`], { stdio: "inherit" });

const builtBinary = join(ADDON_ROOT, "build", "Release", "flock.node");
validateBinary(builtBinary, target);
await mkdir(outputDir, { recursive: true });
const outputBinary = join(outputDir, "flock.node");
await copyFile(builtBinary, outputBinary, fsConstants.COPYFILE_FICLONE);
validateBinary(outputBinary, target);
console.log(`built ${target} Node-API ${NODE_API_VERSION} addon: ${outputBinary}`);
