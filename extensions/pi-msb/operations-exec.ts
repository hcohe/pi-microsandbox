import type {
  BashOperations,
  FindOperations,
  GrepOperations,
} from "@earendil-works/pi-coding-agent";
import type {
  GrepFormattingHelpers,
  SandboxGrepExecute,
  SandboxTransport,
  ToolOpsProvider,
} from "./types.ts";

const DEFAULT_GREP_LIMIT = 100;
const BASH_COMMAND = "bash";
const RG_COMMAND = "rg";

function posix(value: string): string {
  return value.replaceAll("\\", "/");
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function braceAlternatives(pattern: string): string[] | null {
  let open = -1;
  let depth = 0;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === "{" && depth++ === 0) open = index;
    if (character === "}" && depth > 0 && --depth === 0) {
      const inside = pattern.slice(open + 1, index);
      const parts: string[] = [];
      let partStart = 0;
      let partDepth = 0;
      for (let partIndex = 0; partIndex < inside.length; partIndex++) {
        const partCharacter = inside[partIndex];
        if (partCharacter === "{") partDepth++;
        else if (partCharacter === "}") partDepth--;
        else if (partCharacter === "," && partDepth === 0) {
          parts.push(inside.slice(partStart, partIndex));
          partStart = partIndex + 1;
        }
      }
      if (parts.length === 0) return null;
      parts.push(inside.slice(partStart));
      return parts.map((part) => pattern.slice(0, open) + part + pattern.slice(index + 1));
    }
  }
  return null;
}

function globToRegExp(pattern: string): RegExp {
  const alternatives = braceAlternatives(pattern);
  if (alternatives) {
    return new RegExp(`^(?:${alternatives.map((part) => globToRegExp(part).source.slice(1, -1)).join("|")})$`);
  }

  let source = "^";
  let segmentStart = true;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index++;
        if (pattern[index + 1] === "/") {
          index++;
          // Recursive wildcards do not cross dot-prefixed path segments unless
          // the pattern explicitly starts that segment with '.'.
          source += "(?:(?!\\.)[^/]+/)*";
          segmentStart = true;
        } else if (segmentStart && index + 1 === pattern.length) {
          // A trailing globstar consumes zero or more non-hidden path
          // segments, rather than just one basename segment.
          source += "(?:(?!\\.)[^/]+(?:/(?!\\.)[^/]+)*)?";
          segmentStart = false;
        } else {
          source += segmentStart ? "(?!\\.)[^/]*" : "[^/]*";
          segmentStart = false;
        }
      } else {
        source += segmentStart ? "(?!\\.)[^/]*" : "[^/]*";
        segmentStart = false;
      }
    } else if (character === "?") {
      source += segmentStart ? "(?!\\.)[^/]" : "[^/]";
      segmentStart = false;
    } else if (character === "/") {
      source += "/";
      segmentStart = true;
    } else if (character === "\\" && index + 1 < pattern.length) {
      source += escapeRegex(pattern[++index]);
      segmentStart = false;
    } else {
      source += escapeRegex(character);
      segmentStart = false;
    }
  }
  return new RegExp(`${source}$`);
}

/** Match the same basename/path glob forms accepted by Pi's find and grep tools. */
export function matchesToolGlob(relativePath: string, pattern: string): boolean {
  const candidate = posix(relativePath).replace(/^\.\//, "");
  const normalizedPattern = posix(pattern).replace(/^\.\//, "");
  if (!normalizedPattern.includes("/")) {
    return globToRegExp(normalizedPattern).test(candidate.slice(candidate.lastIndexOf("/") + 1));
  }
  const patternToTest = normalizedPattern.startsWith("/")
    ? normalizedPattern.slice(1)
    : normalizedPattern;
  const matcher = globToRegExp(patternToTest);
  return matcher.test(candidate) ||
    (!patternToTest.startsWith("**/") && globToRegExp(`**/${patternToTest}`).test(candidate));
}

function transportErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function createBashOps(
  provider: Pick<ToolOpsProvider, "withRuntime">,
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const result = await provider.withRuntime(async ({ transport }) => {
          if (signal?.aborted) throw new Error("aborted");
          return transport.execStream(BASH_COMMAND, ["-lc", command], {
            cwd,
            timeoutMs: timeout === undefined ? undefined : timeout * 1000,
            signal,
            onStdout: onData,
            onStderr: onData,
          });
        });
        return { exitCode: result.exitCode };
      } catch (error) {
        const code = transportErrorCode(error);
        if (code === "ABORTED") throw new Error("aborted");
        if (code === "TIMEOUT") throw new Error(`timeout:${timeout}`);
        throw error;
      }
    },
  };
}

function normalizeSearchResult(raw: string, searchRoot: string): string {
  const line = posix(raw).replace(/\r$/, "");
  const root = posix(searchRoot).replace(/\/$/, "") || "/";
  if (line === root) return "";
  if (line.startsWith(`${root}/`)) return line;
  if (line.startsWith("/")) return line;
  const relative = line.startsWith("./") ? line.slice(2) : line;
  return root === "/" ? `/${relative}` : `${root}/${relative}`;
}

function relativeSearchResult(absolutePath: string, searchRoot: string): string {
  const root = posix(searchRoot).replace(/\/$/, "") || "/";
  if (root === "/" && absolutePath.startsWith("/")) return absolutePath.slice(1);
  if (absolutePath.startsWith(`${root}/`)) return absolutePath.slice(root.length + 1);
  return absolutePath;
}

export function createFindOps(t: SandboxTransport): FindOperations {
  return {
    exists: async (absolutePath) => {
      try {
        return await t.exists(absolutePath);
      } catch {
        return false;
      }
    },
    glob: async (pattern, cwd, options) => {
      const args = ["--files", "--hidden", "--color=never"];
      const ignores = new Set(["**/.git/**", "**/node_modules/**", ...options.ignore]);
      for (const ignore of ignores) {
        const normalized = posix(ignore).replace(/^!/, "");
        args.push("--glob", `!${normalized}`);
      }

      const result = await t.exec(RG_COMMAND, args, { cwd });
      if (result.exitCode >= 2) {
        const message = result.stderr.toString("utf8").trim() || `rg exited with code ${result.exitCode}`;
        throw new Error(message);
      }
      if (result.exitCode === 1 || result.stdout.length === 0) return [];

      const paths = result.stdout
        .toString("utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => normalizeSearchResult(line, cwd))
        .filter((line) => line.length > 0)
        .filter((line) => matchesToolGlob(relativeSearchResult(line, cwd), pattern));
      return paths.slice(0, Math.max(0, options.limit));
    },
  };
}

export function createGrepOps(t: SandboxTransport): GrepOperations {
  return {
    isDirectory: async (absolutePath) => (await t.stat(absolutePath)).kind === "directory",
    readFile: async (absolutePath) => (await t.readFile(absolutePath)).toString("utf8"),
  };
}

function resolvedPath(cwd: string, requested: unknown): string {
  const value = typeof requested === "string" && requested.length > 0 ? requested : ".";
  if (value.startsWith("/")) return posix(value).replace(/\/+/g, "/");
  const parts = posix(cwd).split("/").filter(Boolean);
  for (const part of posix(value).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function displayPath(searchRoot: string, rootIsDirectory: boolean, filePath: string): string {
  const normalizedFile = posix(filePath);
  if (!rootIsDirectory) {
    const slash = normalizedFile.lastIndexOf("/");
    return slash === -1 ? normalizedFile : normalizedFile.slice(slash + 1);
  }
  const normalizedRoot = posix(searchRoot).replace(/\/$/, "");
  if (normalizedFile === normalizedRoot) return normalizedFile;
  if (normalizedFile.startsWith(`${normalizedRoot}/`)) return normalizedFile.slice(normalizedRoot.length + 1);
  return normalizedFile;
}

function eventFilePath(searchRoot: string, eventPath: string): string {
  if (eventPath.startsWith("/")) return posix(eventPath);
  return `${searchRoot.replace(/\/$/, "")}/${posix(eventPath)}`;
}

function isAbortError(error: unknown): boolean {
  return transportErrorCode(error) === "ABORTED" ||
    (error instanceof Error && /^(?:operation )?aborted$/i.test(error.message));
}

export function createSandboxGrepExecute(args: {
  provider: ToolOpsProvider;
  cwd: string;
  helpers: GrepFormattingHelpers;
}): SandboxGrepExecute {
  return async (_id, params, signal, _onUpdate) => {
    if (signal?.aborted) throw new Error("Operation aborted");

    const controller = new AbortController();
    let externallyAborted = false;
    const abort = () => {
      externallyAborted = true;
      controller.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    // An abort can happen between the initial check and listener registration.
    if (signal?.aborted) abort();

    try {
      return await args.provider.withRuntime(async ({ transport }) => {
        if (controller.signal.aborted || signal?.aborted) throw new Error("Operation aborted");
        const searchRoot = resolvedPath(args.cwd, params.path);
      let rootIsDirectory: boolean;
        try {
          rootIsDirectory = (await transport.stat(searchRoot)).kind === "directory";
        } catch (error) {
          if (controller.signal.aborted || signal?.aborted || isAbortError(error)) {
            throw new Error("Operation aborted");
          }
          throw new Error(`Path not found: ${searchRoot}`);
        }
        if (controller.signal.aborted || signal?.aborted) throw new Error("Operation aborted");

      const pattern = typeof params.pattern === "string" ? params.pattern : "";
      const context = typeof params.context === "number" && params.context > 0 ? params.context : 0;
      const limit = Math.max(1, typeof params.limit === "number" ? params.limit : DEFAULT_GREP_LIMIT);
      const rgArgs = ["--json", "--line-number", "--color=never", "--hidden"];
      if (params.ignoreCase) rgArgs.push("--ignore-case");
      if (params.literal) rgArgs.push("--fixed-strings");
      if (typeof params.glob === "string" && params.glob.length > 0) {
        rgArgs.push("--glob", params.glob);
      }
      rgArgs.push("--", pattern, searchRoot);

      let killedForLimit = false;
      let matchCount = 0;
      let stderr = "";
      let pending = "";
      const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];

      const parseLine = (line: string): void => {
        if (!line.trim() || matchCount >= limit) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event?.type !== "match") return;
        const eventPath = event.data?.path?.text;
        const lineNumber = event.data?.line_number;
        if (typeof eventPath !== "string" || typeof lineNumber !== "number") return;
        matchCount++;
        matches.push({
          filePath: eventFilePath(searchRoot, eventPath),
          lineNumber,
          lineText: typeof event.data?.lines?.text === "string" ? event.data.lines.text : undefined,
        });
        if (matchCount >= limit) {
          killedForLimit = true;
          controller.abort();
        }
      };

      try {
        const result = await transport.execStream(RG_COMMAND, rgArgs, {
          cwd: args.cwd,
          signal: controller.signal,
          onStdout: (chunk) => {
            pending += chunk.toString("utf8");
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) parseLine(line);
          },
          onStderr: (chunk) => {
            stderr += chunk.toString("utf8");
          },
        });
        if (pending) parseLine(pending);
        if (externallyAborted || signal?.aborted) throw new Error("Operation aborted");
        if (!killedForLimit && result.exitCode >= 2) {
          throw new Error(stderr.trim() || `ripgrep exited with code ${result.exitCode}`);
        }
      } catch (error) {
        if (externallyAborted || signal?.aborted) throw new Error("Operation aborted");
        if (!killedForLimit && isAbortError(error)) throw new Error("Operation aborted");
        if (!killedForLimit) throw error;
      }

      if (externallyAborted || signal?.aborted) throw new Error("Operation aborted");
      if (matchCount === 0) {
        return { content: [{ type: "text", text: "No matches found" }], details: undefined };
      }

      const outputLines: string[] = [];
      let linesTruncated = false;
      const fileCache = new Map<string, string[]>();
      const getFileLines = async (filePath: string): Promise<string[]> => {
        const cached = fileCache.get(filePath);
        if (cached) return cached;
        let lines: string[];
        try {
          const content = (await transport.readFile(filePath)).toString("utf8");
          lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        } catch (error) {
          if (externallyAborted || signal?.aborted || isAbortError(error)) {
            throw new Error("Operation aborted");
          }
          lines = [];
        }
        fileCache.set(filePath, lines);
        return lines;
      };

      for (const match of matches) {
        if (externallyAborted || signal?.aborted) throw new Error("Operation aborted");
        const relativePath = displayPath(searchRoot, rootIsDirectory, match.filePath);
        if (context === 0 && match.lineText !== undefined) {
          const lineText = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
          const truncated = args.helpers.truncateLine(lineText);
          if (truncated.wasTruncated) linesTruncated = true;
          outputLines.push(`${relativePath}:${match.lineNumber}: ${truncated.text}`);
          continue;
        }

        const lines = await getFileLines(match.filePath);
        if (lines.length === 0) {
          outputLines.push(`${relativePath}:${match.lineNumber}: (unable to read file)`);
          continue;
        }
        const start = context > 0 ? Math.max(1, match.lineNumber - context) : match.lineNumber;
        const end = context > 0 ? Math.min(lines.length, match.lineNumber + context) : match.lineNumber;
        for (let current = start; current <= end; current++) {
          const raw = lines[current - 1] ?? "";
          const truncated = args.helpers.truncateLine(raw.replace(/\r/g, ""));
          if (truncated.wasTruncated) linesTruncated = true;
          const separator = current === match.lineNumber ? ":" : "-";
          outputLines.push(`${relativePath}${separator}${current}${separator} ${truncated.text}`);
        }
      }

      if (externallyAborted || signal?.aborted) throw new Error("Operation aborted");
      const rawOutput = outputLines.join("\n");
      const truncation = args.helpers.truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const details: Record<string, any> = {};
      const notices: string[] = [];
      if (killedForLimit) {
        details.matchLimitReached = limit;
        notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
      }
      if (truncation.truncated) {
        details.truncation = truncation;
        notices.push(`${args.helpers.formatSize(args.helpers.DEFAULT_MAX_BYTES)} limit reached`);
      }
      if (linesTruncated) {
        details.linesTruncated = true;
        notices.push("Some lines truncated to 500 chars. Use read tool to see full lines");
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

        return {
          content: [{ type: "text", text: output }],
          details: Object.keys(details).length > 0 ? details : undefined,
        };
      });
    } catch (error) {
      if (externallyAborted || signal?.aborted || isAbortError(error)) {
        throw new Error("Operation aborted");
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  };
}
