import { highlightCode, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, ScrollView, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type KeybindingsManager } from "@earendil-works/pi-tui";

/** Escape nonprinting characters for display only; preserve ordinary Dockerfile syntax. */
export function dockerfileDisplay(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);
}
type Edit = { kind: " " | "+" | "-"; text: string };
const sourceLines = (text: string | null): string[] => text?.match(/[^\n]*\n|[^\n]+$/g) ?? [];

// Myers with a bounded work/trace budget. Pathological rewrites fall back to a complete,
// valid replacement of the unresolved middle, never to omission or truncated changes.
function middleEdits(a: string[], b: string[]): Edit[] {
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  let work = 0;
  for (let d = 0; d <= a.length + b.length; d++) {
    if ((work += 2 * d + 1) > 1_000_000) break;
    trace.push(new Map(frontier));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || k !== d && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1)
        ? frontier.get(k + 1) ?? 0 : (frontier.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
      frontier.set(k, x);
      if (x < a.length || y < b.length) continue;
      const edits: Edit[] = [];
      for (let depth = d; depth >= 0; depth--) {
        const previous = trace[depth]!;
        const diagonal = x - y;
        const previousDiagonal = diagonal === -depth || diagonal !== depth && (previous.get(diagonal - 1) ?? -1) < (previous.get(diagonal + 1) ?? -1) ? diagonal + 1 : diagonal - 1;
        const previousX = previous.get(previousDiagonal) ?? 0;
        const previousY = previousX - previousDiagonal;
        while (x > previousX && y > previousY) edits.push({ kind: " ", text: a[--x]! }), y--;
        if (!depth) break;
        if (x === previousX) edits.push({ kind: "+", text: b[--y]! });
        else edits.push({ kind: "-", text: a[--x]! });
      }
      return edits.reverse();
    }
  }
  return [...a.map((text): Edit => ({ kind: "-", text })), ...b.map((text): Edit => ({ kind: "+", text }))];
}

export interface SourceChange { path: string; before: string | null; after: string | null; modeBefore: number | null; modeAfter: number | null }
export function unifiedDockerfileDiff(change: SourceChange): string {
  const { before, after, modeBefore, modeAfter } = change;
  const path = dockerfileDisplay(change.path);
  const executableBefore = modeBefore !== null && !!(modeBefore & 0o111), executableAfter = modeAfter !== null && !!(modeAfter & 0o111);
  const badge = before === null ? "create" : after === null ? "delete" : before === after ? "permissions" : "edit";
  const executable = executableAfter ? " · executable" : executableBefore && after !== null ? " · executable removed" : "";
  const labels = [`${path} [${badge}${executable}]`];
  if (modeBefore !== null && modeAfter !== null && (modeBefore & ~0o111) !== (modeAfter & ~0o111)) {
    labels.push(`Permissions: ${modeBefore.toString(8).padStart(4, "0")} → ${modeAfter.toString(8).padStart(4, "0")}`);
  }
  if ([change.path, before ?? "", after ?? ""].some((text) => /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(text.replace(/\r?\n/g, "")))) labels.push("Control/format characters are shown as \\u{…}.");
  if (before === after) return labels.join("\n");
  const a = sourceLines(before), b = sourceLines(after);
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const edits: Edit[] = [...a.slice(0, prefix).map((text): Edit => ({ kind: " ", text })),
    ...middleEdits(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix)),
    ...a.slice(a.length - suffix).map((text): Edit => ({ kind: " ", text }))];
  const ranges: Array<[number, number]> = [];
  edits.forEach((edit, index) => {
    if (edit.kind === " ") return;
    const start = Math.max(0, index - 2), end = Math.min(edits.length, index + 3);
    const previous = ranges.at(-1);
    if (previous && start <= previous[1]) previous[1] = end;
    else ranges.push([start, end]);
  });
  labels.push(`--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ ${after === null ? "/dev/null" : `b/${path}`}`);
  if ((before ?? "").includes("\r\n") || (after ?? "").includes("\r\n")) {
    const endings = (content: string | null) => content === null ? "missing" : /\r\n/.test(content) ? /(?<!\r)\n/.test(content) ? "mixed LF/CRLF" : "CRLF" : "LF";
    labels.push(`Line endings: ${endings(before)} → ${endings(after)}; CR shown as \\u{d}.`);
  }
  let oldLine = 1, newLine = 1, cursor = 0;
  for (const [start, end] of ranges) {
    for (; cursor < start; cursor++) { if (edits[cursor]!.kind !== "+") oldLine++; if (edits[cursor]!.kind !== "-") newLine++; }
    const hunk = edits.slice(start, end);
    const oldCount = hunk.filter((edit) => edit.kind !== "+").length, newCount = hunk.filter((edit) => edit.kind !== "-").length;
    labels.push(`@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`);
    for (const edit of hunk) {
      labels.push(edit.kind + dockerfileDisplay(edit.text.endsWith("\n") ? edit.text.slice(0, -1) : edit.text));
      if (!edit.text.endsWith("\n")) labels.push("\\ No newline at end of file");
      if (edit.kind !== "+") oldLine++; if (edit.kind !== "-") newLine++;
    }
    cursor = end;
  }
  return labels.join("\n");
}

export interface DockerfileReviewCandidate {
  label: string;
  available: boolean;
  sections: Array<{ text: string; dockerfile?: boolean; diff?: boolean; source?: { before: string | null; after: string | null } }>;
  details: string;
}
export const DOCKERFILE_IMPACT = "Build may use public network; VM may restart and lose guest-local state.";
const persistenceNote = "Files are individually atomic, not jointly/crash atomic; partial/unknown saves never activate.";
interface ChangedDockerfileRow { index: number; text: string; kind: "file" | "note" | "add" | "remove" }
/** Read actual hunk counts; header-like source text inside a hunk is still changed code. */
export function dockerfileChangedRows(text: string): ChangedDockerfileRow[] {
  const rows: ChangedDockerfileRow[] = [];
  let oldRemaining = 0, newRemaining = 0, changed = false;
  for (const [index, line] of text.split("\n").entries()) {
    if (line === "\\ No newline at end of file") {
      if (changed) rows.push({ index, text: line, kind: "note" });
      continue;
    }
    if (oldRemaining || newRemaining) {
      if (line.startsWith("+") && newRemaining) { newRemaining--; changed = true; rows.push({ index, text: line, kind: "add" }); }
      else if (line.startsWith("-") && oldRemaining) { oldRemaining--; changed = true; rows.push({ index, text: line, kind: "remove" }); }
      else if (line.startsWith(" ") && oldRemaining && newRemaining) { oldRemaining--; newRemaining--; changed = false; }
      else throw new Error("Invalid unified review hunk");
      continue;
    }
    const hunk = /^@@ -\d+,(\d+) \+\d+,(\d+) @@$/.exec(line);
    if (hunk) { oldRemaining = Number(hunk[1]); newRemaining = Number(hunk[2]); changed = false; }
    else if (!index || line.startsWith("Permissions:") || line.startsWith("Line endings:")) rows.push({ index, text: line, kind: index ? "note" : "file" });
  }
  if (oldRemaining || newRemaining) throw new Error("Incomplete unified review hunk");
  return rows;
}
export function dockerfileReviewQuestion(candidates: DockerfileReviewCandidate[]): string {
  return [...candidates.flatMap((candidate) => [candidate.label, ...candidate.sections.flatMap((section) => section.dockerfile || section.diff ? dockerfileChangedRows(section.text).map((row) => row.text) : [section.text]), ""]),
    "Apply? Default: No."].join("\n");
}

export function highlightedDockerfileDiff(text: string, theme: Theme, source?: { before: string | null; after: string | null }): string[] {
  // Highlight complete sources before mapping onto hunks, retaining continuation/parser context.
  const highlightSource = (content: string | null) => highlightCode(sourceLines(content).map((line) => dockerfileDisplay(line.endsWith("\n") ? line.slice(0, -1) : line)).join("\n"), "dockerfile");
  const oldLines = source ? highlightSource(source.before) : undefined, newLines = source ? highlightSource(source.after) : undefined;
  let oldIndex = 0, newIndex = 0, inHunk = false;
  return text.split("\n").map((line) => {
    const hunk = /^@@ -(\d+),\d+ \+(\d+),\d+ @@$/.exec(line);
    if (hunk) { oldIndex = Math.max(0, Number(hunk[1]) - 1); newIndex = Math.max(0, Number(hunk[2]) - 1); inHunk = true; }
    if (/^[ +\-]/.test(line) && (inHunk || !source && !/^(---|\+\+\+)/.test(line))) {
      const color = line[0] === "+" ? "toolDiffAdded" : line[0] === "-" ? "toolDiffRemoved" : "toolDiffContext";
      const code = line[0] === "-" ? oldLines?.[oldIndex] : newLines?.[newIndex];
      if (line[0] !== "+") oldIndex++; if (line[0] !== "-") newIndex++;
      return theme.fg(color, line[0]!) + (code ?? highlightCode(line.slice(1), "dockerfile")[0] ?? "");
    }
    return theme.fg(line.startsWith("@@") ? "accent" : "muted", line);
  });
}

// A double-column glyph cannot fit a one-column terminal; spell it explicitly instead.
const narrowDisplay = (text: string, width: number) => width === 1 ? text.replace(/[^\x00-\x7f]/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`) : text;
const wrapReviewText = (text: string, width: number) => wrapTextWithAnsi(narrowDisplay(text, width), width)
  .map((line) => truncateToWidth(line, width, ""));
/** Hard-wrap code by terminal columns, retaining every character and all whitespace. */
export function wrapDockerfileDiffLine(text: string, width: number): string[] {
  const w = Math.max(1, width), code = narrowDisplay(text, w), columns = visibleWidth(code);
  if (columns <= w) return [code];
  const lines: string[] = [];
  for (let column = 0; column < columns;) {
    const line = sliceByColumn(code, column, w, true);
    lines.push(line);
    column += visibleWidth(line);
  }
  return lines;
}

type ReviewUi = { requestRender(): void; terminal: { rows: number } };
/** One interaction owns the candidate selector and its exact preview. Denial is always first. */
export function createDockerfileReview(candidates: DockerfileReviewCandidate[], tui: ReviewUi, theme: Theme, keys: KeybindingsManager,
  done: (value: number | undefined) => void, signal: AbortSignal): Component & { dispose(): void } {
  let index = 0, renderedIndex = -1, details = false, closed = false;
  let cachedWidth = -1, cachedBody: string[] | undefined;
  const invalidate = () => { cachedBody = undefined; };
  const refresh = () => { invalidate(); tui.requestRender(); };
  const cleanup = () => { signal.removeEventListener("abort", abort); };
  const finish = (value?: number) => { if (closed) return; closed = true; cleanup(); done(value); };
  const abort = () => queueMicrotask(() => finish());
  const preview = () => candidates[Math.max(0, index - 1)]!;
  const body: Component = { invalidate, render(width) {
    if (cachedBody && cachedWidth === width) return cachedBody;
    cachedWidth = width;
    const candidate = preview();
    cachedBody = candidate.sections.flatMap((section) => {
      if (!section.dockerfile && !section.diff) return wrapReviewText(section.text, width);
      const highlighted = section.dockerfile ? highlightedDockerfileDiff(section.text, theme, section.source) : undefined;
      return dockerfileChangedRows(section.text).flatMap((row) => {
        const color = row.kind === "add" ? "toolDiffAdded" : row.kind === "remove" ? "toolDiffRemoved" : row.kind === "file" ? "toolTitle" : "warning";
        return wrapDockerfileDiffLine(highlighted && ["add", "remove"].includes(row.kind) ? highlighted[row.index]! : theme.fg(color, row.text), width);
      });
    });
    if (details) {
      cachedBody.push(...["", "Details", `Destination: ${candidate.label}`, DOCKERFILE_IMPACT, persistenceNote, ...candidate.details.split("\n"), "", "Full unified review"].flatMap((line) => wrapReviewText(theme.fg("muted", line), width)));
      for (const section of candidate.sections.filter((section) => section.dockerfile || section.diff)) {
        const lines = section.dockerfile ? highlightedDockerfileDiff(section.text, theme, section.source) : section.text.split("\n");
        cachedBody.push(...lines.flatMap((line) => wrapDockerfileDiffLine(line, width)));
      }
    }
    return cachedBody;
  } };
  const scroll = new ScrollView(body, { scrollbar: "hidden", overscroll: "contain" });
  const component: Component & { dispose(): void } = {
    invalidate,
    render(width) {
      const w = Math.max(1, width), rows = Math.max(3, Math.min(18, tui.terminal.rows - 5));
      // All long labels and code wrap; viewport slicing is scrollable, never content truncation.
      const wrap = (text: string) => wrapReviewText(text, w);
      const heading = w >= 8 ? wrap(theme.fg("borderMuted", "─ ") + theme.fg("accent", "Apply?")) : [];
      const choiceRows = ["No", ...candidates.map((candidate) => candidate.label + (candidate.available ? "" : " [unavailable]"))]
        .map((label, choice) => {
          const color = choice === index ? choice === 0 ? "error" : "success" : choice === 0 ? "muted" : candidates[choice - 1]!.available ? "accent" : "dim";
          return wrap(theme.fg(color, `${choice === index ? "→ " : "  "}${label}`));
        });
      const actions = [...heading, ...choiceRows.flat()];
      const selectedActionEnd = heading.length + choiceRows.slice(0, index + 1).reduce((total, lines) => total + lines.length, 0);
      const help = "↑↓ scope · Enter apply/No · Esc cancel · Ctrl+N/P scroll · d details";
      const foot = wrap(theme.fg("dim", help));
      const spacing = rows >= actions.length + Math.min(foot.length, 2) + 3 ? 2 : 0;
      const actionHeight = Math.min(actions.length, Math.max(1, rows - Math.min(foot.length, 2) - 1));
      const height = Math.max(1, Math.min(10, rows - actionHeight - Math.min(foot.length, 2) - spacing));
      const lines = scroll.render(w);
      scroll.updateLayout(lines.length, height, () => tui.requestRender());
      // A rendered code preview is not approval evidence for a clipped destination label.
      renderedIndex = !index || selectedActionEnd <= actionHeight ? index : -1;
      const progress = lines.length > height ? ` · ${scroll.scrollTop + 1}–${Math.min(lines.length, scroll.scrollTop + height)}/${lines.length}` : "";
      return [...lines.slice(scroll.scrollTop, scroll.scrollTop + height), ...(spacing ? [""] : []), ...actions.slice(0, actionHeight), ...(spacing ? [""] : []),
        ...wrap(theme.fg("dim", help + progress)).slice(0, 2)].slice(0, rows);
    },
    handleInput(data) {
      if (closed) return;
      if (keys.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) return finish();
      if (keys.matches(data, "tui.select.confirm")) {
        if (!index) return finish();
        if (renderedIndex === index && preview().available) finish(index - 1);
        return;
      }
      if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
        index = (index + (keys.matches(data, "tui.select.up") ? candidates.length : 1)) % (candidates.length + 1);
        scroll.scrollToStart(); refresh();
      } else if (matchesKey(data, Key.ctrl("n")) || matchesKey(data, Key.ctrl("p")) || matchesKey(data, Key.pageDown) || matchesKey(data, Key.pageUp)) {
        const forward = matchesKey(data, Key.ctrl("n")) || matchesKey(data, Key.pageDown);
        scroll.scrollBy((forward ? 1 : -1) * Math.max(1, scroll.viewportHeight - 1)); tui.requestRender();
      } else if (data === "d") { details = !details; refresh(); }
    },
    dispose() { closed = true; cleanup(); },
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return component;
}

export async function approveDockerfileReview(ctx: ExtensionContext, candidates: DockerfileReviewCandidate[], signal: AbortSignal): Promise<number | undefined> {
  if (!ctx.hasUI || signal.aborted || !["tui", "rpc"].includes(ctx.mode)) return;
  const question = dockerfileReviewQuestion(candidates);
  if (Buffer.byteLength(question) > 256 * 1024) throw new Error("Complete review too large");
  if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
    let component: ReturnType<typeof createDockerfileReview> | undefined;
    // Newer hosts expose permission status; older hosts safely ignore this optional hint.
    const options = { overlay: false, blocked: { kind: "permission" as const, message: "Review Dockerfile changes" } };
    try {
      return await ctx.ui.custom<number | undefined>((tui, theme, keys, done) => {
        component = createDockerfileReview(candidates, tui, theme, keys, done, signal);
        return component;
      }, options);
    } finally {
      // A host may complete before mounting/disposing the factory result (e.g. abort).
      component?.dispose();
    }
  }
  const choice = await ctx.ui.select(question, ["No", ...candidates.filter((candidate) => candidate.available).map((candidate) => candidate.label)], { signal });
  if (signal.aborted) return;
  const index = candidates.findIndex((candidate) => candidate.available && candidate.label === choice);
  return index >= 0 ? index : undefined;
}
