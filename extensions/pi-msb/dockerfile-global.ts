/** Literal GLOBAL is reserved only as the first FROM base, never expanded through ARG. */
export function rewriteGlobalBase(data: Buffer, reference: string): Buffer | undefined {
  const text = data.toString("utf8");
  const lines = text.matchAll(/[^\n]+\n?|\n/g);
  let escape = "\\";
  let syntax: string | undefined;
  let directives = true;
  let logical = "";
  let offsets: number[] = [];
  const from: Array<{ text: string; offsets: number[] }> = [];
  const heredocs: Array<{ delimiter: string; tabs: boolean }> = [];
  for (const line of lines) {
    const raw = line[0].replace(/\r?\n$/, "");
    if (heredocs.length) {
      const next = heredocs[0]!;
      if ((next.tabs ? raw.replace(/^\t+/, "") : raw) === next.delimiter) heredocs.shift();
      continue;
    }
    if (directives) {
      const directive = raw.match(/^\s*#\s*(syntax|escape|check)\s*=\s*(.*?)\s*$/i);
      if (directive) {
        if (directive[1]!.toLowerCase() === "escape") escape = directive[2]!;
        if (directive[1]!.toLowerCase() === "syntax") syntax = directive[2]!;
        continue;
      }
      directives = false;
    }
    // Empty physical lines, like comments, do not end a continued instruction.
    if (/^\s*(?:#|$)/.test(raw)) continue;
    // Docker removes leading instruction/continuation whitespace, not embedded whitespace.
    const leading = raw.match(/^\s*/)?.[0].length ?? 0;
    const content = raw.slice(leading);
    const end = content.replace(/[ \t]+$/, "");
    const continued = (escape === "\\" || escape === "`") && end.endsWith(escape) && end.at(-2) !== escape;
    const fragment = continued ? end.slice(0, -1) : content;
    logical += fragment;
    for (let i = 0; i < fragment.length; i++) offsets.push(line.index! + leading + i);
    if (continued) continue;
    if (/^from(?:\s|$)/i.test(logical)) from.push({ text: logical, offsets });
    if (/^(run|copy|add)\s/i.test(logical)) heredocs.push(...heredocDelimiters(logical));
    logical = ""; offsets = [];
  }
  if (/^from(?:\s|$)/i.test(logical)) from.push({ text: logical, offsets });
  const reserved = from.filter((instruction) => {
    const operands = instruction.text.replace(/^from\s*/i, "").replace(/\s+as\s+\S+\s*$/i, "");
    return /(?:^|\s)["']?global["']?(?:\s|$)/i.test(operands);
  });
  if (!reserved.length) return undefined;
  if (reserved.length !== 1 || reserved[0] !== from[0]) throw new Error("FROM GLOBAL is supported only in the first FROM instruction");
  const first = from[0]!;
  const match = first.text.match(/^(from\s+(?:--platform=\S+\s+)?)(global)(?:\s+as\s+([a-zA-Z0-9_.-]+))?\s*$/i);
  if (!match) throw new Error("Unsupported FROM GLOBAL syntax; use FROM [--platform=TOKEN] GLOBAL [AS name]");
  if (from.some((instruction) => /\s+as\s+global\s*$/i.test(instruction.text))) throw new Error("GLOBAL is reserved and cannot be a stage name in a FROM GLOBAL build");
  if (syntax && !/^(?:docker\.io\/)?docker\/dockerfile(?::[\w.-]+)?(?:@sha256:[a-f0-9]{64})?$/i.test(syntax)) throw new Error("FROM GLOBAL requires the standard Dockerfile frontend");
  if (!["\\", "`"].includes(escape) || !Buffer.from(text).equals(data)) throw new Error("FROM GLOBAL requires valid UTF-8 and a supported escape directive");
  const positions = new Set(first.offsets.slice(match[1]!.length, match[1]!.length + match[2]!.length));
  const start = Math.min(...positions);
  // Replace only token characters, preserving even comments within a continued instruction.
  return Buffer.from(text.split("").map((char, index) => index === start ? reference : positions.has(index) ? "" : char).join(""));
}

/** Recognize BuildKit's word-shaped heredoc declarations, not quoted shell text. */
function heredocDelimiters(instruction: string): Array<{ delimiter: string; tabs: boolean }> {
  const result: Array<{ delimiter: string; tabs: boolean }> = [];
  let quote = "";
  for (let i = 0; i < instruction.length; i++) {
    const char = instruction[i]!;
    if (char === "\\" && quote !== "'") { i++; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "#" && /\s/.test(instruction[i - 1] ?? " ")) break;
    if (char !== "<" || !/(?:^|\s)\d*$/.test(instruction.slice(0, i))) continue;
    if (instruction[i + 1] !== "<" || instruction[i + 2] === "<") continue;
    const tabs = instruction[i + 2] === "-";
    let end = i + (tabs ? 3 : 2);
    let delimiter = "", delimiterQuote = "";
    for (; end < instruction.length; end++) {
      const next = instruction[end]!;
      if (!delimiterQuote && /\s/.test(next)) break;
      if (next === "\\" && delimiterQuote !== "'") { delimiter += instruction[++end] ?? ""; continue; }
      if (next === delimiterQuote) { delimiterQuote = ""; continue; }
      if (!delimiterQuote && (next === "'" || next === '"')) { delimiterQuote = next; continue; }
      delimiter += next;
    }
    if (!delimiter || delimiterQuote) continue;
    result.push({ delimiter, tabs });
    i = end - 1;
  }
  return result;
}
