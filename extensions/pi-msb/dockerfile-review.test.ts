import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { highlightCode, initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { Container, isViewportTUI, KeybindingsManager, ScrollView, TUI_KEYBINDINGS, TuiAltScreen, TuiMainScreen, Text, visibleWidth, VStack, type Component, type Terminal } from "@earendil-works/pi-tui";
import { formatSettingsDiff } from "./settings-diff.ts";
import { approveDockerfileReview, createDockerfileReview, dockerfileDisplay, dockerfileChangedRows, dockerfileReviewQuestion, highlightedDockerfileDiff, unifiedDockerfileDiff, wrapDockerfileDiffLine, type DockerfileReviewCandidate } from "./dockerfile-review.ts";

// Use theme assets matching the pinned test library, not the invoking Pi installation.
process.env.PI_PACKAGE_DIR = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent", import.meta.url));

const diff = (before: string | null, after: string | null, modeBefore: number | null = before === null ? null : 0o600, modeAfter: number | null = after === null ? null : 0o600) => unifiedDockerfileDiff({ path: "Dockerfile", before, after, modeBefore, modeAfter });
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const theme = { fg: (_token: string, text: string) => text } as Theme;
const keys = new KeybindingsManager(TUI_KEYBINDINGS);
const candidate = (label: string, code = "+RUN apt-get install -y cowsay", available = true): DockerfileReviewCandidate => {
  if (/^[+-]/.test(code)) {
    const lines = code.split("\n");
    code = `Dockerfile [edit]\n--- a/Dockerfile\n+++ b/Dockerfile\n@@ -1,${lines.filter((line) => line.startsWith("-")).length} +1,${lines.filter((line) => line.startsWith("+")).length} @@\n${code}`;
  }
  return { scope: "project", label, available, sections: [{ text: code, dockerfile: true }] };
};
function dialogTheme(appearance: "dark" | "light"): Theme {
  const json = JSON.parse(readFileSync(new URL(`../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${appearance}.json`, import.meta.url), "utf8"));
  const resolve = (value: string | number): string | number => typeof value === "string" && json.vars[value] !== undefined ? resolve(json.vars[value]) : value;
  const colors = Object.fromEntries(Object.entries(json.colors).map(([key, value]) => [key, resolve(value as string | number)]));
  return new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], "truecolor");
}

// Reconstruct printable LF sources from every unified hunk to check line ranges and completeness.
function applyReview(before: string, review: string): string {
  const original = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const result: string[] = [];
  const lines = review.split("\n");
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const hunk = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[i]!);
    if (!hunk) continue;
    const start = Number(hunk[1]) - (Number(hunk[2]) ? 1 : 0);
    result.push(...original.slice(cursor, start)); cursor = start;
    let oldCount = 0, newCount = 0;
    while (i + 1 < lines.length && /^[ +\-]/.test(lines[i + 1]!)) {
      const line = lines[++i]!;
      if (line[0] !== "+") { assert.equal(original[cursor++], line.slice(1) + "\n"); oldCount++; }
      if (line[0] !== "-") { result.push(line.slice(1) + "\n"); newCount++; }
    }
    assert.equal(oldCount, Number(hunk[2])); assert.equal(newCount, Number(hunk[4]));
  }
  return result.concat(original.slice(cursor)).join("");
}

test("unifiedDockerfileDiff tiny insertion in large source is compact, not a full replacement", () => {
  const before = Array.from({ length: 2000 }, (_, i) => `RUN echo ${i}\n`).join("");
  const after = before.replace("RUN echo 1000\n", "RUN echo 1000\nRUN cowsay hi\n");
  const review = diff(before, after);
  assert.ok(review.length < 350, review);
  assert.match(review, /@@ -1000,4 \+1000,5 @@/);
  assert.match(review, /\+RUN cowsay hi/);
  assert.ok(!review.includes('"RUN'));
  assert.equal(applyReview(before, review), after);
});

test("unifiedDockerfileDiff includes all separated hunks, exact line counts and repeated-line edits", () => {
  const before = Array.from({ length: 80 }, (_, i) => `RUN ${i % 5}\n`).join("");
  const after = before.split("\n").map((line, i) => i === 2 ? "RUN first" : i === 43 ? "RUN second" : line).join("\n") + "RUN final\n";
  const review = diff(before, after);
  assert.equal((review.match(/^@@/gm) ?? []).length, 3);
  assert.equal(applyReview(before, review), after);
  let seed = 7;
  const next = () => (seed = (seed * 16807) % 2147483647) % 7;
  for (let n = 0; n < 200; n++) {
    const a = Array.from({ length: next() * 4 }, () => `RUN ${next()}\n`).join("");
    const b = Array.from({ length: next() * 4 }, () => `RUN ${next()}\n`).join("");
    assert.equal(applyReview(a, diff(a, b)), b);
  }
});

test("unifiedDockerfileDiff bounded pathological rewrites retain every changed line", () => {
  const before = Array.from({ length: 1200 }, (_, i) => `old-${i}\n`).join("");
  const after = Array.from({ length: 1200 }, (_, i) => `new-${i}\n`).join("");
  assert.equal(applyReview(before, diff(before, after)), after);
});

test("unifiedDockerfileDiff creates/deletes entire files, empty files, final newlines and CRLF exactly", () => {
  assert.match(diff(null, "FROM pinned\n"), /\[create\][\s\S]*--- \/dev\/null[\s\S]*@@ -0,0 \+1,1 @@\n\+FROM pinned$/);
  assert.match(diff("one\ntwo\n", null), /\[delete\][\s\S]*\+\+\+ \/dev\/null[\s\S]*-one\n-two$/);
  assert.match(diff(null, ""), /\[create\]/);
  assert.ok(!diff(null, "FROM pinned\n").includes('+ ""'));
  assert.match(diff("RUN old", "RUN new\n"), /-RUN old\n\\ No newline at end of file\n\+RUN new$/);
  assert.match(diff("RUN old\n", "RUN new"), /\+RUN new\n\\ No newline at end of file$/);
  assert.match(diff("RUN same\r\n", "RUN same\n"), /-RUN same\\u\{d\}\n\+RUN same/);
  assert.match(diff("RUN same\n", "RUN same\r\n"), /\+RUN same\\u\{d\}/);
});

test("unifiedDockerfileDiff context mode-only and executable removal has meaningful labels, not raw metadata", () => {
  const text = unifiedDockerfileDiff({ path: "build-context/setup.sh", before: "echo hi\n", after: "echo hi\n", modeBefore: 0o700, modeAfter: 0o600 });
  assert.equal(text, "build-context/setup.sh [permissions · executable removed]");
  assert.match(diff(null, "echo hi\n", null, 0o700), /\[create · executable\]/);
});

test("dockerfileDisplay escapes actual terminal/bidi/control characters while preserving literal backslashes", () => {
  const hostile = "bad\x1b]8;;evil\x07\r\n\t\x7f\x85\u202e\u2028\u2066\\u{1b}";
  const safe = dockerfileDisplay(hostile);
  assert.ok(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(safe));
  assert.ok(safe.includes("\\u{1b}")); assert.ok(safe.endsWith("\\u{1b}"));
  const literal = "RUN echo \\u{1b} \\"; assert.equal(dockerfileDisplay(literal), literal);
  const review = unifiedDockerfileDiff({ path: hostile, before: null, after: hostile, modeBefore: null, modeAfter: 0o600 });
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}]/u.test(review));
});

test("highlightedDockerfileDiff uses actual Pi Dockerfile syntax highlighting and semantic diff colors in dark/light", () => {
  const tokens: string[] = [];
  const themed = { fg: (token: string, text: string) => { tokens.push(token); return text; } } as Theme;
  const rendered: string[] = [];
  for (const name of ["dark", "light"]) {
    initTheme(name, false);
    const source = 'RUN echo "$HOME"';
    const result = highlightedDockerfileDiff(`@@ -1,1 +1,1 @@\n-${source}\n+${source}`, themed);
    assert.equal(result[2], "+" + highlightCode(source, "dockerfile")[0]);
    assert.match(result[2]!, /\x1b\[/);
    assert.equal(strip(result[2]!), `+${source}`);
    rendered.push(result[2]!);
  }
  assert.notEqual(rendered[0], rendered[1]);
  assert.ok(tokens.includes("toolDiffAdded") && tokens.includes("toolDiffRemoved") && tokens.includes("accent"));
});

function component(candidates = [candidate("This worktree — app"), candidate("All worktrees — repo", "+RUN shared")], rows = 24) {
  initTheme("dark", false);
  const abort = new AbortController(); const answers: Array<number | undefined> = [];
  let renders = 0;
  const view = createDockerfileReview(candidates, { requestRender() { renders++; }, terminal: { rows } }, theme, keys, (value) => answers.push(value), abort.signal);
  return { view, answers, abort, renders: () => renders };
}

test("createDockerfileReview No default/Enter/Escape/abort/dispose fail closed; selection approves exactly rendered candidate once", async () => {
  for (const action of ["enter", "escape", "abort", "dispose"] as const) {
    const f = component(); f.view.render(80);
    if (action === "abort") { f.abort.abort(); await Promise.resolve(); }
    else if (action === "dispose") f.view.dispose();
    else f.view.handleInput!(action === "enter" ? "\r" : "\x1b");
    f.view.handleInput!("\x1b[B"); f.view.handleInput!("\r");
    assert.ok(f.answers.every((answer) => answer === undefined));
    assert.equal(f.answers.length, action === "dispose" ? 0 : 1);
  }
  const f = component();
  assert.match(strip(f.view.render(80).join("\n")), /→ No/);
  f.view.handleInput!("\x1b[B"); f.view.render(80);
  f.view.handleInput!("\x1b[B"); f.view.handleInput!("\r");
  assert.deepEqual(f.answers, [], "unrendered changed scope cannot be approved");
  const lines = strip(f.view.render(80).join("\n"));
  assert.match(lines, /→ All worktrees — repo/); assert.match(lines, /\+RUN shared/); assert.ok(!lines.includes("+RUN apt-get"));
  f.view.handleInput!("\r"); f.view.handleInput!("\r"); assert.deepEqual(f.answers, [1]); f.view.dispose();
});

test("createDockerfileReview unavailable cannot approve; injected application keybindings are honored", () => {
  const f = component([candidate("Unavailable", "UNAVAILABLE", false)]);
  f.view.handleInput!("\x1b[B"); f.view.render(60); f.view.handleInput!("d"); f.view.handleInput!("\r"); assert.deepEqual(f.answers, []); f.abort.abort();
  const answers: Array<number | undefined> = [];
  const custom = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "j", "tui.select.confirm": "x" });
  const view = createDockerfileReview([candidate("Apply")], { requestRender() {}, terminal: { rows: 24 } }, theme, custom, (value) => answers.push(value), new AbortController().signal);
  view.handleInput!("j"); view.render(80); view.handleInput!("x"); assert.deepEqual(answers, [0]); view.dispose();
});

test("createDockerfileReview width-safe wrapping, bounded scroll/resize and theme invalidation", () => {
  const text = Array.from({ length: 100 }, (_, i) => `+RUN echo line-${i} /a/long/path/with/界`).join("\n");
  const f = component([candidate("This worktree — long-project-name", text)], 14);
  for (const width of [1, 2, 7, 20, 80]) {
    const lines = f.view.render(width); assert.ok(lines.length <= 14);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  const seen: string[] = [];
  for (let i = 0; i < 120; i++) { seen.push(strip(f.view.render(80).join("\n"))); f.view.handleInput!("\x0e"); }
  const all = seen.join("\n"); for (let i = 0; i < 100; i++) assert.ok(all.includes(`line-${i} `), `unreachable diff line ${i}`);
  assert.doesNotMatch(all, /↑↓|Ctrl\+N|details|Details|Full unified|\d+–\d+\/\d+/);
  const scrolled = f.view.render(80); f.view.handleInput!("d"); assert.deepEqual(f.view.render(80), scrolled);
  f.view.handleInput!("\x1b[5~"); assert.notDeepEqual(f.view.render(80), scrolled, "PageUp scrolls without a footer");
  f.view.handleInput!("\x1b[6~"); assert.deepEqual(f.view.render(80), scrolled, "PageDown restores the position");
  f.view.invalidate(); f.view.render(30); assert.ok(f.renders() > 0); f.view.dispose();
});

test("Dockerfile review uses the freed footer rows for changed code and leaves a blank line after Yes", () => {
  const f = component([candidate("Project", Array.from({ length: 40 }, (_, i) => `+RUN echo line-${i}`).join("\n"))]);
  const lines = f.view.render(90).map(strip);
  assert.equal(lines.length, 18);
  assert.deepEqual(lines.slice(-4), ["", "→ No", "  Yes", ""]);
  assert.ok(!lines.some((line) => line.includes("Apply?")));
  assert.ok(lines.includes("+RUN echo line-10"), "removed footer rows are available to the preview");
  f.view.dispose();
});

test("approveDockerfileReview RPC and select-only TUI use one compact question with both distinct diffs; no custom RPC", async () => {
  const views = [candidate("This worktree — app", "+RUN local"), candidate("All worktrees — repo", "-RUN old\n+RUN shared"), candidate("Broken", "UNAVAILABLE", false)];
  for (const mode of ["rpc", "tui"] as const) {
    let calls = 0;
    const ctx = { hasUI: true, mode, ui: { ...(mode === "rpc" ? { custom() { assert.fail("RPC custom UI forbidden"); } } : {}), async select(question: string, choices: string[]) {
      calls++; assert.equal(question, dockerfileReviewQuestion(views)); assert.match(question, /\+RUN local/); assert.match(question, /\+RUN shared/);
      assert.deepEqual(choices, ["No", views[0]!.label, views[1]!.label]); return choices[2];
    } } } as any;
    assert.equal(await approveDockerfileReview(ctx, views, new AbortController().signal), 1); assert.equal(calls, 1);
  }
});

test("RPC approval discloses existing-file privacy changes without default-create permission noise", async () => {
  const views = [candidate("Apply", diff("FROM base\n", "FROM base\nRUN install cowsay\n", 0o644, 0o600))];
  const ctx = { hasUI: true, mode: "rpc", ui: { async select(question: string, choices: string[]) {
    assert.match(question, /Permissions: 0644 → 0600/);
    assert.match(question, /\+RUN install cowsay/);
    assert.deepEqual(choices, ["No", "Yes"]);
    return "No";
  } } } as any;
  assert.equal(await approveDockerfileReview(ctx, views, new AbortController().signal), undefined);
  assert.doesNotMatch(diff(null, "FROM base\n"), /Permissions:|0600/);
  assert.match(diff("FROM base\n", "FROM base\n", 0o660, 0o600), /Permissions: 0660 → 0600/);
});

test("approveDockerfileReview uses one inline custom UI for approval or cancellation, never select or overlay hooks", async () => {
  for (const approve of [false, true]) {
    let calls = 0;
    const ctx = { hasUI: true, mode: "tui", ui: { select() { assert.fail("no fallback after inline review"); }, custom(factory: any, options: any) {
      calls++;
      assert.equal(options.overlay, false); assert.equal(options.overlayOptions, undefined); assert.equal(options.onHandle, undefined);
      assert.deepEqual(options.blocked, { kind: "permission", message: "Review Dockerfile changes" });
      return new Promise<number | undefined>((resolve) => {
        // No overlay handles or input-listener APIs are provided to this inline component.
        const view = factory({ requestRender() {}, terminal: { rows: 24 } }, theme, keys, resolve);
        view.render(80);
        if (approve) { view.handleInput("\x1b[B"); view.render(80); }
        view.handleInput("\r"); view.dispose();
      });
    } } } as any;
    assert.equal(await approveDockerfileReview(ctx, [candidate("Apply")], new AbortController().signal), approve ? 0 : undefined);
    assert.equal(calls, 1);
  }
});

test("approveDockerfileReview pre-aborted/headless requests and forged unavailable selections never approve", async () => {
  const abort = new AbortController(); abort.abort();
  const ctx = { hasUI: true, mode: "rpc", ui: { select() { assert.fail("already aborted"); } } } as any;
  assert.equal(await approveDockerfileReview(ctx, [candidate("Apply")], abort.signal), undefined);
  assert.equal(await approveDockerfileReview({ ...ctx, hasUI: false }, [candidate("Apply")], new AbortController().signal), undefined);
  ctx.ui.select = async () => "Broken";
  assert.equal(await approveDockerfileReview(ctx, [candidate("Apply"), candidate("Broken", "UNAVAILABLE", false)], new AbortController().signal), undefined);
});

for (const appearance of ["dark", "light"] as const) for (const Renderer of [TuiMainScreen, TuiAltScreen]) test(`Dockerfile review inline ${Renderer.name} ${appearance} routes selection, universal scrolling, resize and confirmation`, async () => {
  initTheme(appearance, false);
  let input!: (data: string) => void, resize!: () => void;
  const writes: string[] = [];
  const terminal = {
    columns: 70, rows: 24, kittyProtocolActive: false,
    start(onInput, onResize) { input = onInput; resize = onResize; }, stop() {}, async drainInput() {},
    write(data) { writes.push(data); }, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  } satisfies Terminal;
  const tui = new Renderer(terminal, false, "/tmp");
  const answers: Array<number | undefined> = [];
  const editor = new Text("Previous editor focus", 0, 0);
  const editorArea = new Container(); editorArea.addChild(editor);
  const transcript = new ScrollView(new Text("Chat transcript remains above approval", 0, 0), { primary: true });
  const root = new VStack([{ component: transcript, grow: 1, shrink: 1, minSize: 1 }, { component: editorArea, shrink: 0 }, new Text("Normal footer", 0, 0)]);
  tui.addChild(root);
  if (isViewportTUI(tui)) tui.setLayoutRoot(root);
  tui.setFocus(editor);
  // The public component tree replaces only the editor area, preserving transcript/footer layout.
  const mount = (review: Component) => { editorArea.clear(); editorArea.addChild(review); tui.setFocus(review); tui.requestRender(); };
  const restore = () => { editorArea.clear(); editorArea.addChild(editor); tui.setFocus(editor); tui.requestRender(); };
  const view = createDockerfileReview([candidate("This worktree — app", Array.from({ length: 70 }, (_, i) => `+RUN echo row-${i}`).join("\n"))], tui, dialogTheme(appearance), keys, (value) => answers.push(value), new AbortController().signal);
  mount(view);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
  try {
    tui.start(); await tick();
    assert.equal(tui.hasOverlay(), false);
    assert.match(strip(view.render(70).join("\n")), /→ No/);
    const layout = strip(root.render(70).join("\n"));
    assert.ok(layout.indexOf("Chat transcript") < layout.indexOf("→ No"));
    assert.ok(layout.indexOf("→ No") < layout.indexOf("Normal footer"));
    assert.ok(view.render(70).length <= 18, "inline review leaves room for transcript and footer");
    input("\x0e"); await tick(); assert.match(strip(view.render(70).join("\n")), /→ No/);
    input("\x10"); await tick(); assert.match(strip(view.render(70).join("\n")), /→ No/);
    input("\x1b[B"); await tick();
    const beforeScroll = strip(view.render(70).join("\n"));
    input("\x0e"); await tick();
    const afterScroll = strip(view.render(70).join("\n"));
    assert.notEqual(afterScroll, beforeScroll, "Ctrl+N must scroll the inline review in both TUI modes");
    input("\x10"); await tick();
    assert.equal(strip(view.render(70).join("\n")), beforeScroll, "Ctrl+P must scroll back without changing the choice");
    const seen = new Set(beforeScroll.split("\n"));
    for (let i = 0; i < 20; i++) {
      input("\x0e"); await tick();
      for (const line of strip(view.render(70).join("\n")).split("\n")) seen.add(line);
    }
    for (let i = 0; i < 70; i++) assert.ok(seen.has(`+RUN echo row-${i}`), `unreachable inline diff line ${i}`);
    terminal.columns = 9; resize(); await tick();
    assert.ok(view.render(9).every((line) => visibleWidth(line) <= 9));
    terminal.columns = 70; resize(); await tick();
    input("\r"); await tick();
    assert.deepEqual(answers, [0]); assert.ok(writes.some((text) => text.includes("row-")));
    view.dispose(); restore(); await tick(); assert.equal(tui.getFocusedComponent(), editor);
    assert.equal(tui.hasOverlay(), false);
    const longCandidates = [candidate(`This worktree — ${"local-name-".repeat(16)}`), candidate(`All worktrees — ${"repository-name-".repeat(12)}`)];
    const narrowAnswers: Array<number | undefined> = [];
    const narrowView = createDockerfileReview(longCandidates, tui, dialogTheme(appearance), keys, (value) => narrowAnswers.push(value), new AbortController().signal);
    mount(narrowView);
    try {
      terminal.columns = 9; resize(); await tick();
      input("\x1b[B"); await tick(); input("\x1b[B"); await tick();
      input("\r"); await tick(); assert.deepEqual(narrowAnswers, [], "a clipped repository destination must not approve");
      terminal.columns = 240; resize(); await tick();
      assert.ok(strip(narrowView.render(240).join("\n")).includes(`→ ${longCandidates[1]!.label}`));
      input("\r"); await tick(); assert.deepEqual(narrowAnswers, [1]);
    } finally { narrowView.dispose(); restore(); terminal.columns = 70; resize(); }
    await tick(); assert.equal(tui.getFocusedComponent(), editor);
    for (const action of ["default-No", "escape", "abort"] as const) {
      const abort = new AbortController(); const denied: Array<number | undefined> = [];
      const denyView = createDockerfileReview([candidate("Apply")], tui, dialogTheme(appearance), keys, (value) => denied.push(value), abort.signal);
      mount(denyView);
      try {
        await tick();
        if (action === "abort") abort.abort(); else input(action === "escape" ? "\x1b" : "\r");
        await tick(); assert.deepEqual(denied, [undefined]);
      } finally { denyView.dispose(); restore(); }
      await tick(); assert.equal(tui.getFocusedComponent(), editor);
      assert.equal(tui.hasOverlay(), false);
    }
  } finally { view.dispose(); restore(); tui.stop(); }
});

test("approveDockerfileReview deferred abort disposes even when host never mounts; factory failure also cleans up", async () => {
  for (const fail of [false, true]) {
    const abort = new AbortController(); let doneCalls = 0, disposals = 0, returned = false;
    const ctx = { hasUI: true, mode: "tui", ui: { custom(factory: any, options: any) {
      assert.equal(options.overlay, false); assert.equal(options.overlayOptions, undefined); assert.equal(options.onHandle, undefined);
      if (!fail) abort.abort(); // Cancellation between the outer check and factory.
      return new Promise((resolve, reject) => {
        const view = factory({ requestRender() {}, terminal: { rows: 24 } }, theme, keys, (value: unknown) => {
          assert.equal(returned, true, "done must not run synchronously inside factory"); doneCalls++; resolve(value);
        });
        const dispose = view.dispose.bind(view); view.dispose = () => { disposals++; dispose(); };
        returned = true;
        if (fail) reject(new Error("factory host failure before mount"));
      });
    } } } as any;
    if (fail) await assert.rejects(approveDockerfileReview(ctx, [candidate("Apply")], abort.signal), /factory host failure/);
    else assert.equal(await approveDockerfileReview(ctx, [candidate("Apply")], abort.signal), undefined);
    assert.equal(disposals, 1); abort.abort(); await Promise.resolve(); assert.equal(doneCalls, fail ? 0 : 1);
  }
});

test("highlightedDockerfileDiff maps complete-source syntax onto separated unified hunks", () => {
  initTheme("dark", false);
  const before = "FROM pinned\nRUN echo first \\\n    && echo unchanged \\\n    && echo last\n";
  const after = before.replace("echo first", "echo cowsay");
  const review = diff(before, after);
  const highlighted = highlightedDockerfileDiff(review, theme, { before, after });
  const source = after.match(/[^\n]*\n|[^\n]+$/g)!.map((line) => dockerfileDisplay(line.endsWith("\n") ? line.slice(0, -1) : line)).join("\n");
  const fullSyntax = highlightCode(source, "dockerfile");
  const changed = highlighted.find((line) => strip(line).startsWith("+RUN "));
  assert.equal(changed, "+" + fullSyntax[1]);
  const continuation = highlighted.find((line) => strip(line).includes("&& echo unchanged"));
  assert.equal(continuation, " " + fullSyntax[2]);
  assert.equal(strip(highlighted.join("\n")), review);
});


test("highlightedDockerfileDiff never mistakes changed code for file headers or loses newline/CR bytes", () => {
  initTheme("dark", false);
  for (const [before, after] of [[null, "++literal\nRUN cowsay\n"], ["--literal\nRUN old\n", "RUN cowsay\n"], ["RUN a\r\nRUN b", "RUN a\nRUN cowsay"], ["RUN same\n", "RUN prefix\nRUN same\n"]] as const) {
    const review = diff(before, after);
    assert.equal(strip(highlightedDockerfileDiff(review, theme, { before, after }).join("\n")), review);
  }
});

test("wrapDockerfileDiffLine hard-wraps long image pins and whitespace without losing code or wide glyphs", () => {
  initTheme("dark", false);
  const image = "+FROM ghcr.io/example/cowsay@sha256:" + "abcdef0123456789".repeat(4);
  const wrapped = wrapDockerfileDiffLine(image, 90);
  assert.equal(wrapped[0], image.slice(0, 90));
  assert.ok(wrapped[0]!.startsWith("+FROM ghcr.io/")); assert.equal(wrapped.join(""), image);
  const code = "+RUN printf '界🙂'  \\";
  const highlighted = "+" + highlightCode(code.slice(1), "dockerfile")[0];
  for (const width of [1, 2, 3, 7, 20, 90]) {
    const lines = wrapDockerfileDiffLine(highlighted, width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    const expected = width === 1 ? code.replace(/[^\x00-\x7f]/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`) : code;
    assert.equal(strip(lines.join("")), expected);
  }
});

test("Dockerfile review shows only scope, changed code and bottom choices", () => {
  const source = "FROM ghcr.io/example/cowsay@sha256:" + "a".repeat(64) + "\nRUN install cowsay \\\n    && cleanup\n";
  const review = diff(null, source);
  assert.ok(!/Mode:|0600|Control\/format|literal backslash/.test(review));
  assert.ok(review.includes("+RUN install cowsay \\\n")); assert.ok(!review.includes("cowsay \\\\"));
  assert.match(diff(null, "RUN echo\tfoo\n"), /Control\/format characters/);
  assert.match(diff("RUN same\r\n", "RUN same\n"), /Line endings: CRLF → LF/);
  const f = component([candidate("This worktree — app", review), candidate("All worktrees — repo", review)]);
  const initial = strip(f.view.render(90).join("\n"));
  assert.match(initial, /→ No/); assert.doesNotMatch(initial, /Preview:/);
  f.view.handleInput!("\x1b[B");
  const selected = strip(f.view.render(90).join("\n"));
  assert.equal((selected.match(/This worktree — app/g) ?? []).length, 1);
  assert.doesNotMatch(selected, /Build may use public network/);
  assert.ok(!/Selected:|Preview:|Save \+ reload|Mode:|0600|Control\/format|\d+–\d+\/\d+/.test(selected));
  assert.match(selected, /\+FROM ghcr\.io\/example\/cowsay@sha256:a+/);
  assert.doesNotMatch(selected, /↑↓|Ctrl\+N|details|\d+–\d+\/\d+/);
  f.view.dispose();
});

test("dockerfileChangedRows retains all separated changes and header-like source, but no patch headers or unchanged context", () => {
  const before = "FROM unchanged\n--- removed literal\n" + "RUN unchanged\n".repeat(12) + "@@ removed literal\n";
  const after = "FROM unchanged\n+++ added literal\n" + "RUN unchanged\n".repeat(12) + "@@ added literal\n";
  const review = diff(before, after);
  assert.equal((review.match(/^@@/gm) ?? []).length, 2);
  const rows = dockerfileChangedRows(review).map((row) => row.text);
  assert.deepEqual(rows, ["Dockerfile [edit]", "---- removed literal", "++++ added literal", "-@@ removed literal", "+@@ added literal"]);
  assert.equal(rows.filter((line) => line.includes("unchanged")).length, 0);
  assert.match(dockerfileChangedRows(diff("RUN old", "RUN new\r\n")).map((row) => row.text).join("\n"), /Line endings:[\s\S]*\\ No newline at end of file/);
});

test("inline dialog uses real theme colors and pads the bottom actions in dark/light", () => {
  const outputs: string[] = [];
  for (const appearance of ["dark", "light"] as const) {
    initTheme(appearance, false);
    const palette = dialogTheme(appearance);
    const view = createDockerfileReview([candidate("This worktree — app"), candidate("All worktrees — repo")], { requestRender() {}, terminal: { rows: 24 } }, palette, keys, () => {}, new AbortController().signal);
    const lines = view.render(90), plain = lines.map(strip);
    const code = plain.findIndex((line) => line.startsWith("+RUN")), no = plain.indexOf("→ No"), lastAction = plain.indexOf("  All worktrees — repo");
    assert.ok(code >= 0 && code < no && no < lastAction);
    assert.equal(plain[no - 1], ""); assert.equal(lastAction, plain.length - 2);
    assert.equal(plain.at(-1), "");
    assert.ok(!plain.some((line) => line.includes("Apply?")));
    assert.equal(lines[no], palette.fg("accent", "→ ") + palette.fg("accent", "No"));
    assert.equal(lines[lastAction], `  ${palette.fg("text", "All worktrees — repo")}`);
    assert.match(lines[no]!, /\x1b\[/); outputs.push(lines[no]!);
    view.handleInput!("\x1b[B");
    const selected = view.render(90);
    assert.ok(selected.includes(palette.fg("accent", "→ ") + palette.fg("accent", "This worktree — app")));
    view.dispose();
  }
  assert.notEqual(outputs[0], outputs[1]);
});

test("Dockerfile review has no footer, progress or details; d cannot change the preview or authorize a selection", () => {
  const before = "FROM unchanged\nRUN old\n", after = "FROM unchanged\nRUN cowsay\n";
  const f = component([candidate("All worktrees — repo", diff(before, after)), candidate("Other destination", "+RUN other")]);
  const initial = f.view.render(90);
  f.view.handleInput!("d"); assert.deepEqual(f.view.render(90), initial);
  f.view.handleInput!("\r"); assert.deepEqual(f.answers, [undefined], "d leaves No selected");
  f.view.dispose();

  const selected = component([candidate("All worktrees — repo", diff(before, after)), candidate("Other destination", "+RUN other")]);
  selected.view.render(90); selected.view.handleInput!("\x1b[B");
  selected.view.handleInput!("d"); selected.view.handleInput!("\r");
  assert.deepEqual(selected.answers, [], "d does not bypass the rendered-preview guard");
  const rendered = selected.view.render(90);
  selected.view.handleInput!("d"); assert.deepEqual(selected.view.render(90), rendered);
  const plain = strip(rendered.join("\n"));
  assert.match(plain, /-RUN old\n\+RUN cowsay/);
  assert.doesNotMatch(plain, /↑↓|Ctrl\+N|details|Details|Full unified|Destination:|Build may|Repository metadata|--- a\/|\+\+\+ b\/|@@|unchanged|\d+–\d+\/\d+/);
  selected.view.handleInput!("\r"); assert.deepEqual(selected.answers, [0]); selected.view.dispose();
});

test("RPC changed-code review includes both distinct variants before one approval, with no ANSI, context or warning wall", async () => {
  const local = candidate("This worktree — app", diff("FROM unchanged\nRUN local-old\n", "FROM unchanged\nRUN local-new\n", 0o644, 0o600));
  const shared = candidate("All worktrees — repo", diff("FROM unchanged\nRUN shared-old\n", "FROM unchanged\nRUN shared-new\n"));
  let calls = 0;
  const ctx = { hasUI: true, mode: "rpc", ui: { async select(question: string, choices: string[]) {
    calls++;
    for (const code of ["-RUN local-old", "+RUN local-new", "-RUN shared-old", "+RUN shared-new", "Permissions: 0644 → 0600"]) assert.ok(question.includes(code));
    assert.doesNotMatch(question, /\x1b|unchanged|--- a\/|\+\+\+ b\/|@@|Preview:|Build may|Shared on|Register immutable/);
    assert.ok(question.indexOf("+RUN shared-new") < question.indexOf("Apply?"));
    assert.deepEqual(choices, ["No", local.label, shared.label]);
    return shared.label;
  } } } as any;
  assert.equal(await approveDockerfileReview(ctx, [local, shared], new AbortController().signal), 1); assert.equal(calls, 1);
});


test("narrow review cannot approve a hidden or incomplete selected destination; resizing restores exact-candidate approval", () => {
  const local = `This worktree — ${"local-name-".repeat(16)}`;
  const shared = `All worktrees — ${"repository-name-".repeat(12)}`;
  for (const width of [1, 2, 7, 12, 24]) {
    const f = component([candidate(local), candidate(shared, "+RUN shared")]);
    f.view.handleInput!("\x1b[B"); f.view.handleInput!("\x1b[B");
    const narrow = strip(f.view.render(width).join("\n"));
    assert.ok(!narrow.replace(/\n/g, "").includes(shared), "regression setup must clip the selected label");
    assert.doesNotMatch(narrow, /^Apply$/m, "never substitute generic Apply for a hidden scope");
    f.view.handleInput!("\r"); assert.deepEqual(f.answers, []);
    const wide = strip(f.view.render(240).join("\n"));
    assert.ok(wide.includes(`→ ${shared}`));
    f.view.handleInput!("\r"); assert.deepEqual(f.answers, [1]); f.view.dispose();
  }
});

test("narrow clipped actions retain unconditional Escape and No denial", () => {
  for (const escape of [false, true]) {
    const f = component([candidate(`This worktree — ${"local-".repeat(40)}`), candidate(`All worktrees — ${"repo-".repeat(40)}`)]);
    f.view.handleInput!("\x1b[B"); f.view.handleInput!("\x1b[B"); f.view.render(7);
    if (escape) f.view.handleInput!("\x1b");
    else { f.view.handleInput!("\x1b[B"); f.view.render(7); f.view.handleInput!("\r"); }
    assert.deepEqual(f.answers, [undefined]); f.view.dispose();
  }
});

for (const appearance of ["dark", "light"] as const) test(`single-target review matches settings scope and native selector colors; changed-file headings dim in ${appearance}`, () => {
  initTheme(appearance, false);
  const palette = dialogTheme(appearance);
  for (const scope of ["project", "global"] as const) for (const before of [null, "RUN old\n"]) {
    const c = candidate("Apply shared Project (repo)", diff(before, "RUN cowsay\n"));
    c.scope = scope;
    const context = unifiedDockerfileDiff({ path: "build-context/setup.sh", before: null, after: "echo hi\n", modeBefore: null, modeAfter: 0o600 });
    c.sections.push({ text: context, diff: true });
    const answers: Array<number | undefined> = [];
    const view = createDockerfileReview([c], { requestRender() {}, terminal: { rows: 24 } }, palette, keys, (value) => answers.push(value), new AbortController().signal);
    const lines = view.render(120);
    const label = scope === "project" ? "Project" : "Global";
    assert.equal(lines[0], formatSettingsDiff([{ kind: "scope", label: "Scope", text: label }], palette)[0]);
    assert.equal(lines[0], palette.fg("muted", "Scope: ") + palette.fg("warning", label));
    assert.equal(lines[1], "");
    assert.equal(strip(lines[2]!), `Dockerfile [${before === null ? "create" : "edit"}]`);
    assert.ok(lines.includes(palette.fg("dim", `Dockerfile [${before === null ? "create" : "edit"}]`)));
    assert.ok(lines.includes(palette.fg("dim", "build-context/setup.sh [create]")));
    assert.ok(lines.includes(palette.fg("accent", "→ ") + palette.fg("accent", "No")));
    assert.ok(lines.includes(`  ${palette.fg("text", "Yes")}`));
    assert.ok(lines.includes(palette.fg("toolDiffAdded", "+") + highlightCode("RUN cowsay", "dockerfile")[0]));
    assert.doesNotMatch(strip(lines.join("\n")), /Apply shared Project/);
    view.handleInput!("\x1b[B"); view.handleInput!("\r");
    assert.deepEqual(answers, [], "a newly selected Yes still requires its preview to render");
    const selected = view.render(120);
    assert.ok(selected.includes(`  ${palette.fg("text", "No")}`));
    assert.ok(selected.includes(palette.fg("accent", "→ ") + palette.fg("accent", "Yes")));
    view.handleInput!("\r"); assert.deepEqual(answers, [0]); view.dispose();
  }
});

test("single-target RPC/select-only TUI use concise scope and exact No/Yes mapping, rejecting old, unavailable and aborted answers", async () => {
  for (const mode of ["rpc", "tui"] as const) for (const scope of ["project", "global"] as const) {
    const c = candidate("Apply shared Project (repo)"); c.scope = scope;
    for (const answer of ["Yes", "No", undefined, "Apply", c.label, "All worktrees — repo", "d", "unexpected"]) {
      const ctx = { hasUI: true, mode, ui: { async select(question: string, choices: string[]) {
        assert.match(question, new RegExp(`^Scope: ${scope === "project" ? "Project" : "Global"}\\n\\nDockerfile`));
        assert.doesNotMatch(question, /Apply shared Project|\x1b/);
        assert.deepEqual(choices, ["No", "Yes"]); return answer;
      } } } as any;
      assert.equal(await approveDockerfileReview(ctx, [c], new AbortController().signal), answer === "Yes" ? 0 : undefined);
    }
    for (const available of [false, true]) {
      const abort = new AbortController(); c.available = available;
      const ctx = { hasUI: true, mode, ui: { async select(_question: string, choices: string[]) {
        assert.deepEqual(choices, available ? ["No", "Yes"] : ["No"]);
        if (available) abort.abort(); return "Yes";
      } } } as any;
      assert.equal(await approveDockerfileReview(ctx, [c], abort.signal), undefined);
    }
  }
});

test("multi-target select-only review never treats Yes or duplicate destination labels as an exact candidate", async () => {
  for (const answer of ["Yes", "No", "Duplicate"]) {
    const ctx = { hasUI: true, mode: "rpc", ui: { async select() { return answer; } } } as any;
    assert.equal(await approveDockerfileReview(ctx, [candidate("Duplicate"), candidate("Duplicate", "+RUN other")], new AbortController().signal), undefined);
  }
});
