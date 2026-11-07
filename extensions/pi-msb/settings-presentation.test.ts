import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { safeText, settingsSourceLabel } from "./settings-presentation.ts";

test("display text preserves ordinary Unicode and existing value coercion", () => {
  for (const [input, expected] of [[null, ""], [undefined, ""], [false, "false"], [0, "0"], ["測試 café 🐧", "測試 café 🐧"]] as const) {
    assert.equal(safeText(input), expected);
  }
  assert.equal(safeText({ toString: () => "external label" }), "external label");
});

test("display sanitization strips CSI and BEL-terminated or unterminated OSC sequences", () => {
  assert.equal(safeText("before\x1b[31mred\x1b[0m after"), "beforered after");
  assert.equal(safeText("before\x1b]0;forged title\x07after"), "beforeafter");
  assert.equal(safeText("before\x1b]unfinished title"), "before");
  // Preserve the existing display regex exactly: unlike input sanitization,
  // an ST terminator does not end this OSC match.
  assert.equal(safeText("before\x1b]0;title\x1b\\after"), "before");
});

test("display sanitization replaces controls with spaces, not input-style deletion", () => {
  assert.equal(safeText("a\nb\rc\td\x00e\x7ff\u0085g\u200bh\u202ei"), "a b c d e f g h i");
  assert.equal(safeText("  keep  spacing  "), "  keep  spacing  ");
});

test("source labels preserve all historical display aliases and unknown source text", () => {
  for (const [source, expected] of Object.entries({
    global: "Global", "host-default": "Global", project: "Project", "host-project": "Project",
    session: "Session", ephemeral: "Session", temporary: "Session", env: "environment", defaults: "default",
  })) assert.equal(settingsSourceLabel(source), expected);
  for (const source of ["inherited / unknown", "GLOBAL", "", null, undefined, 7]) {
    assert.equal(settingsSourceLabel(source), String(source));
  }
  // Labels are aliases only; sanitization remains the display caller's job.
  assert.equal(settingsSourceLabel("unknown\nsource"), "unknown\nsource");
});

for (const [names, blockPi] of [
  [["settings-presentation.ts", "settings-diff.ts"], true],
  // Inspection still uses config.ts/getAgentDir; only its presentation dependency is lightweight.
  [["settings-inspection.ts"], false],
] as const) test(`${names.join(", ")} import without panel/input dependencies${blockPi ? " or Pi/TUI/SDK" : ""}`, () => {
  const loader = `export async function resolve(specifier, context, nextResolve) {
    if (specifier === "microsandbox" || /control-panel|settings-input|masked-input/.test(specifier)
      || (${blockPi} && /@earendil-works\\/pi-(?:tui|coding-agent)/.test(specifier))) {
      throw new Error("Unexpected presentation dependency: " + specifier + " from " + context.parentURL);
    }
    return nextResolve(specifier, context);
  }`;
  const modules = names.map((name) => new URL(name, import.meta.url).href);
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", `
    import { register } from "node:module";
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);
    for (const url of ${JSON.stringify(modules)}) await import(url);
    console.log("lightweight settings imports passed");
  `], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /lightweight settings imports passed/);
});
