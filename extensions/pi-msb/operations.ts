import type {
  EditOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { SandboxTransport } from "./types.ts";

export interface FileOpsOptions {
  /** The absolute project root mounted in the sandbox. */
  projectRoot: string;
}

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  // `file` uses this spelling on some distributions for BMP files.
  "image/x-ms-bmp",
]);

interface CodedError extends Error {
  code?: string | number;
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function isNotFound(error: unknown): boolean {
  const code = errorCode(error);
  return code === "NOT_FOUND" || code === "ENOENT";
}

function isOutsideProjectRoot(filePath: string, projectRoot: string): boolean {
  // Do not use this to rewrite paths. It is only an error-classification check.
  const root = resolveLexically(projectRoot);
  const candidate = resolveLexically(filePath);
  if (root === "/" || candidate === root) return false;
  return !candidate.startsWith(`${root}/`);
}

function resolveLexically(filePath: string): string {
  if (filePath === "/") return "/";
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}` || "/";
}

function sandboxPathError(filePath: string, projectRoot: string): Error {
  return new Error(
    `Path is not available in the sandbox: ${filePath}. ` +
      `The sandbox project root is ${projectRoot}; use a path mounted inside it.`,
  );
}

function withPathError<T>(
  filePath: string,
  options: FileOpsOptions,
  operation: () => Promise<T>,
): Promise<T> {
  return operation().catch((error: unknown) => {
    if (
      isNotFound(error) &&
      isOutsideProjectRoot(filePath, options.projectRoot)
    ) {
      throw sandboxPathError(filePath, options.projectRoot);
    }
    throw error;
  });
}

function commandError(
  command: string,
  args: readonly string[],
  exitCode: number,
  stderr: Buffer,
): CodedError {
  const detail = stderr.toString("utf8").trim();
  const error = new Error(
    detail || `${command} exited with code ${exitCode}`,
  ) as CodedError;
  // 127 means the executable/shell command is missing, not that the path was
  // absent. Keep that distinct so outside-root classification cannot rewrite it.
  error.code = exitCode === 127 ? "COMMAND_NOT_FOUND" : "EIO";
  // Keep the command in the fallback message useful without joining user input
  // into a shell command. Paths are deliberately not interpreted or executed.
  if (!detail && args.length === 0) error.message = `${command}: ${error.message}`;
  return error;
}

async function execChecked(
  transport: SandboxTransport,
  command: string,
  args: string[],
): Promise<void> {
  const result = await transport.exec(command, args);
  if (result.exitCode !== 0) {
    throw commandError(command, args, result.exitCode, result.stderr);
  }
}

async function testAccess(
  transport: SandboxTransport,
  script: string,
  filePath: string,
): Promise<void> {
  // The script is fixed; the path is a quoted positional shell argument. This
  // handles spaces and leading dashes without interpolating user input.
  const args = ["-c", script, "pi-msb-test", filePath];
  const result = await transport.exec("sh", args);
  if (result.exitCode === 0) return;

  const error = commandError("sh", args, result.exitCode, result.stderr);
  // `test` deliberately has a boolean exit status, so recover the useful
  // missing-vs-permission distinction from the transport's filesystem probe.
  // This probe is only made after a failed access check and never reads host fs.
  try {
    const exists = await transport.exists(filePath);
    if (!exists && result.exitCode !== 127) {
      error.code = "ENOENT";
      if (!result.stderr.length) {
        error.message = `ENOENT: no such file or directory, access '${filePath}'`;
      }
    } else if (exists && result.exitCode !== 127 && !result.stderr.length) {
      error.code = "EACCES";
      error.message = `EACCES: permission denied, access '${filePath}'`;
    }
  } catch {
    // Keep the original command error when the diagnostic probe is unavailable.
  }
  throw error;
}

async function testReadable(
  transport: SandboxTransport,
  filePath: string,
): Promise<void> {
  await testAccess(transport, 'test -r "$1"', filePath);
}

async function testWritable(
  transport: SandboxTransport,
  filePath: string,
): Promise<void> {
  await testAccess(transport, 'test -w "$1"', filePath);
}

async function testReadableAndWritable(
  transport: SandboxTransport,
  filePath: string,
): Promise<void> {
  await testAccess(transport, 'test -r "$1" && test -w "$1"', filePath);
}

async function diagnoseFileCapability(transport: SandboxTransport): Promise<void> {
  // `command` is a shell builtin on the supported images. The fixed script and
  // separate argv[0] make this a capability probe, not a path-bearing shell call.
  try {
    await transport.exec("sh", [
      "-c",
      "command -v file >/dev/null 2>&1",
      "pi-msb-file-capability",
    ]);
  } catch {
    // A missing shell is itself a capability failure; image detection remains
    // optional and the caller will treat the file as text.
  }
}

function isMissingFileCommand(error: unknown): boolean {
  const code = errorCode(error);
  if (
    code === "NOT_FOUND" ||
    code === "ENOENT" ||
    code === "COMMAND_NOT_FOUND" ||
    code === 127
  ) return true;
  return error instanceof Error && /(?:file: command not found|file not found)/i.test(error.message);
}

async function detectImageMimeType(
  transport: SandboxTransport,
  filePath: string,
): Promise<string | null> {
  let result;
  try {
    result = await transport.exec("file", ["--mime-type", "-b", "--", filePath]);
  } catch (error) {
    if (!isMissingFileCommand(error)) throw error;
    await diagnoseFileCapability(transport);
    return null;
  }

  if (result.exitCode !== 0) {
    if (result.exitCode === 127) await diagnoseFileCapability(transport);
    return null;
  }

  const mimeType = result.stdout.toString("utf8").trim().toLowerCase();
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) return null;
  return mimeType === "image/x-ms-bmp" ? "image/bmp" : mimeType;
}

export function createReadOps(
  transport: SandboxTransport,
  options: FileOpsOptions,
): ReadOperations {
  return {
    access: (absolutePath) =>
      withPathError(absolutePath, options, () =>
        testReadable(transport, absolutePath),
      ),
    readFile: (absolutePath) =>
      withPathError(absolutePath, options, () => transport.readFile(absolutePath)),
    detectImageMimeType: (absolutePath) =>
      withPathError(absolutePath, options, () =>
        detectImageMimeType(transport, absolutePath),
      ),
  };
}

export function createWriteOps(
  transport: SandboxTransport,
  options: FileOpsOptions,
): WriteOperations {
  return {
    mkdir: (directory) =>
      withPathError(directory, options, () =>
        execChecked(transport, "mkdir", ["-p", "--", directory]),
      ),
    writeFile: (absolutePath, content) =>
      withPathError(absolutePath, options, () =>
        transport.writeFile(absolutePath, content),
      ),
  };
}

export function createEditOps(
  transport: SandboxTransport,
  options: FileOpsOptions,
): EditOperations {
  const read = createReadOps(transport, options);
  const write = createWriteOps(transport, options);
  return {
    readFile: read.readFile,
    writeFile: write.writeFile,
    access: (absolutePath) =>
      withPathError(absolutePath, options, async () => {
        // Equivalent to `test -r path && test -w path`, with each path kept in
        // its own argument and no shell interpolation.
        await testReadableAndWritable(transport, absolutePath);
      }),
  };
}

async function isDirectory(
  transport: SandboxTransport,
  absolutePath: string,
): Promise<boolean> {
  const stat = await transport.stat(absolutePath);
  if (stat.kind === "directory") return true;

  // Some SDK stat implementations report a symlink as `other` instead of
  // following it. `test -d` supplies the same follow-symlink behavior as Node's
  // fs.stat used by Pi's built-in ls operation.
  const args = ["-c", 'test -d "$1"', "pi-msb-test", absolutePath];
  try {
    const result = await transport.exec("sh", args);
    // Exit 1 is the intended negative probe: missing/non-directory. Exit 127
    // means the shell/test command is unavailable and must remain an error.
    if (result.exitCode === 127) {
      throw commandError("sh", args, result.exitCode, result.stderr);
    }
    return result.exitCode === 0;
  } catch (error) {
    // Only a typed missing-path result is an intended negative probe. Transport
    // failures such as ACCESS, IO, TIMEOUT, or SANDBOX_DOWN must remain visible.
    if (isNotFound(error)) return false;
    throw error;
  }
}

export function createLsOps(
  transport: SandboxTransport,
  options: FileOpsOptions,
): LsOperations {
  return {
    exists: (absolutePath) =>
      withPathError(absolutePath, options, async () => {
        const exists = await transport.exists(absolutePath);
        if (
          !exists &&
          isOutsideProjectRoot(absolutePath, options.projectRoot)
        ) {
          throw sandboxPathError(absolutePath, options.projectRoot);
        }
        return exists;
      }),
    stat: (absolutePath) =>
      withPathError(absolutePath, options, async () => {
        const directory = await isDirectory(transport, absolutePath);
        return { isDirectory: () => directory };
      }),
    readdir: (absolutePath) =>
      withPathError(absolutePath, options, async () => {
        const entries = await transport.list(absolutePath);
        return entries.map((entry) => entry.name);
      }),
  };
}
