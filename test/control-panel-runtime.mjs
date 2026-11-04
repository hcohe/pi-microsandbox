// Process-isolated integration fixture: real Pi loader, command context, custom UI,
// theme and renderers; terminal and SDK are doubled (no live VM).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = await realpath(await mkdtemp("/tmp/msb-panel-runtime-"));
try {
  const pkg = process.argv[2];
  const cwd = join(root, "home/workspace");
  await mkdir(cwd, { recursive: true });
  const canonicalAgent = join(root, "srv/pi/agent");
  const lexicalAgent = join(root, "home/.pi/agent");
  const token = join(root, "home/.pi/token");
  await mkdir(canonicalAgent, { recursive: true }); await mkdir(join(root, "home/.pi"));
  await symlink(canonicalAgent, lexicalAgent);
  await writeFile(token, "RUNTIME_PRIVATE_SENTINEL");
  await writeFile(join(root, "srv/pi/token"), "WRONG_RUNTIME_PRIVATE_SENTINEL");
  Object.assign(process.env, { HOME: join(root, "home"), PI_CODING_AGENT_DIR: lexicalAgent, PI_PACKAGE_DIR: pkg, PI_MSB_UI_FIXTURE_CWD: cwd, PI_MSB_UI_FIXTURE_TOKEN: token });
  execFileSync("git", ["init", "-q", cwd]);
  // Secret values are synthetic, never read from the real host's Pi config.
  await mkdir(join(canonicalAgent, "pi-microsandbox"));
  const originalPolicy = 'auto_start = false\n[[secrets]]\nenv = "TOKEN"\nvalue = "$FILE:../../token"\nallow_hosts = ["api.example"]\n';
  await writeFile(join(canonicalAgent, "pi-microsandbox/default.toml"), originalPolicy);
  const mod = (path) => import(pathToFileURL(join(pkg, "dist", `${path}.js`)));
  const { loadExtensions } = await mod("core/extensions/loader");
  const { ExtensionRunner } = await mod("core/extensions/runner");
  const { InteractiveMode } = await mod("modes/interactive/interactive-mode");
  const { initTheme, theme } = await mod("modes/interactive/theme/theme");
  initTheme("dark");
  const require = createRequire(join(pkg, "package.json"));
  const tui = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));
  const loaded = await loadExtensions([join(import.meta.dirname, "control-panel-runtime-extension.ts")], cwd);
  assert.deepEqual(loaded.errors, []);
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, {}, {});
  const command = loaded.extensions[0].commands.get("msb");
  assert.ok(command);
  let savedScopes = false;
  for (const Renderer of [tui.TuiMainScreen, tui.TuiAltScreen]) {
    let input;
    let output = "";
    let panel;
    let baseKeys = 0;
    const notices = [];
    const terminal = {
      columns: 80, rows: 24, kittyProtocolActive: false,
      start(onInput) { input = onInput; }, stop() {}, drainInput: async () => {},
      write(data) { output += data; }, hideCursor() {}, showCursor() {}, moveBy() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
    };
    const ui = new Renderer(terminal, false, root);
    const editor = { focused: false, getText: () => "", setText() {}, render: () => Array.from({ length: terminal.rows }, () => "UNDERLYING CHAT"), invalidate() {}, handleInput() { baseKeys++; } };
    ui.addChild(editor);
    if (ui instanceof tui.TuiAltScreen) ui.setLayoutRoot(editor);
    ui.setFocus(editor);
    const showOverlay = ui.showOverlay.bind(ui);
    ui.showOverlay = (component, options) => { panel = component; return showOverlay(component, options); };
    const mode = Object.create(InteractiveMode.prototype);
    Object.assign(mode, { ui, editor, keybindings: {} });
    const context = mode.createExtensionUIContext();
    context.notify = (message) => notices.push(message);
    runner.setUIContext(context, "tui");
    ui.start();
    try {
      for (let launch = 0; launch < 2; launch++) {
        panel = undefined;
        const opening = command.handler("", runner.createCommandContext());
        // Attach a rejection handler immediately so failures remain assertion errors.
        let failure;
        opening.catch((error) => { failure = error; });
        for (let n = 0; n < 500 && !panel && !failure && !notices.length; n++) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(failure, undefined);
        assert.deepEqual(notices, []);
        assert.ok(panel, "/msb must reach the real ui.custom overlay");
        await loaded.extensions[0].commands.get("msb-fixture-verify-origin").handler("", runner.createCommandContext());
        assert.equal(ui.hasOverlay(), true);
        assert.equal(panel.focused, true);
        assert.equal(editor.focused, false);
        const initial = tui.stripTerminalSequences(panel.render(80).join("\n"));
        assert.match(initial, /▸ Status *$/m);
        assert.doesNotMatch(initial, /Runtime|State:|No running policy adopted/);
        const roots = initial.split("\n").filter((line) => /^[> ] [▾▸] /.test(line));
        assert.deepEqual(roots.map((line) => line.slice(4).trimEnd()), ["General", "Resources", "Network", "Secrets", "Mounts", "Tools", "Advanced", "Status", "Sources & warnings", "Actions"]);
        assert.ok(roots.every((line) => /^[> ] ▸ /.test(line)));
        assert.match(initial, /^MICROSANDBOX *\n> ▸ General/m);
        assert.doesNotMatch(initial, /Configuration/);
        for (const [width, height] of [[80, 24], [24, 2], [24, 6], [32, 12], [40, 10], [120, 20], [1, 1]]) {
          terminal.columns = width; terminal.rows = height;
          const lines = panel.render(width);
          assert.equal(lines.length, height);
          assert.ok(lines.every((line) => tui.visibleWidth(line) === width));
          if (height >= 2) {
            assert.match(tui.stripTerminalSequences(lines.at(-1)), /q close/);
            assert.doesNotMatch(tui.stripTerminalSequences(lines.at(-1)), /w\/P\/G|w ephemeral/);
            assert.ok(lines.at(-1).includes(theme.bold(theme.fg("accent", "q")) + theme.fg("muted", " close")));
            assert.doesNotMatch(tui.stripTerminalSequences(lines.slice(0, -1).join("\n")), /q close|w\/P\/G|w ephemeral/);
          }
          output = ""; ui.renderNow(true);
          const frame = ui instanceof tui.TuiMainScreen ? ui.captureRenderState().previousLines.slice(-height).join("\n") : output;
          assert.doesNotMatch(frame, /UNDERLYING|RUNTIME_PRIVATE_SENTINEL/);
          input("\t"); assert.equal(baseKeys, launch);
        }
        terminal.columns = 80; terminal.rows = 24;
        // Exercise the editor through native input routing, then leave without applying.
        const key = async (data) => { input(data); await panel.waitForIdle(); };
        const choose = async (label) => {
          for (let n = 0; n < 300; n++) {
            const text = tui.stripTerminalSequences(panel.render(80).join("\n"));
            if (text.split("\n").some((line) => line.startsWith("> ") && line.slice(2).replace(/^\s*[▾▸]?\s*/, "").replace(/^\[ /, "").startsWith(label))) { return; }
            await key("j");
          }
          assert.fail(`Missing row: ${label}`);
        };
        const select = async (label) => { await choose(label); await key("\r"); };
        const expand = async (label) => {
          await choose(label);
          const line = tui.stripTerminalSequences(panel.render(80).join("\n")).split("\n").find((line) => line.startsWith("> "));
          if (line.includes("▸")) await key("l");
        };
        assert.doesNotMatch(tui.stripTerminalSequences(panel.render(80).join("\n")), /Section:|Search all settings/);
        await choose("General");
        for (const [left, right] of [["h", "l"], ["\x1b[D", "\x1b[C"]]) {
          await key(left); assert.match(tui.stripTerminalSequences(panel.render(80).join("\n")), /> ▸ General/);
          await key(right); assert.match(tui.stripTerminalSequences(panel.render(80).join("\n")), /> ▾ General/);
          await key(right); assert.match(tui.stripTerminalSequences(panel.render(80).join("\n")), />     Guest image:/);
          await key(left); await key(left);
          assert.match(tui.stripTerminalSequences(panel.render(80).join("\n")), /> ▸ General/);
        }
        await expand("Status");
        const status = tui.stripTerminalSequences(panel.render(80).join("\n"));
        assert.match(status, /State: off \[runtime\]/);
        assert.match(status, savedScopes ? /Last known policy \(not running\)/ : /No running policy adopted: No current policy \[runtime\]/);
        assert.doesNotMatch(status, /Guest image:|Virtual CPUs:|Docker mode:/);
        await choose("State:");
        for (const commandKey of ["e", "a", "d"]) await key(commandKey);
        assert.match(tui.stripTerminalSequences(panel.render(80).join("\n")), /> .*State: off \[runtime\]/);
        await choose("Status"); await key("h");
        if (launch === 1 && !savedScopes) {
          const labels = ["Apply for current running sandbox only", "Apply for all sandboxes in this project", "Apply for all sandboxes globally on this host"];
          await expand("General"); await choose("Show Footer:"); await key("e"); await select("false");
          await choose(labels[0]);
          assert.match(tui.stripTerminalSequences(panel.render(80).join("\n")), /Unavailable: no running sandbox/);
          await key("\r"); // Disabled is observable but cannot commit or start a guest.
          assert.doesNotMatch(tui.stripTerminalSequences(panel.render(80).join("\n")), /Result: Applied/);
          await select("Cancel");
          await loaded.extensions[0].commands.get("msb-fixture-enable").handler("", runner.createCommandContext());
          await expand("Actions"); await select("Reload settings"); await select("Confirm"); await key("\x1b");
          for (const [scope, value] of [[0, "false"], [1, "true"], [2, "false"]]) {
            await expand("General"); await choose("Show Footer:"); await key("e"); await select(value);
            await choose(labels[scope]);
            const styled = panel.render(160).join("\n");
            assert.ok(styled.includes(theme.fg("accent", theme.bold(`[ ${labels[scope]} ]`))));
            assert.ok(styled.includes(theme.fg("muted", theme.bold("[ Cancel ]"))));
            assert.notEqual(theme.fg("accent", theme.bold(`[ ${labels[scope]} ]`)), theme.fg("text", labels[scope]));
            if (scope === 0) for (const [width, height] of [[32, 12], [80, 20]]) {
              terminal.columns = width; terminal.rows = height;
              await writeFile(`/tmp/pi-msb-action-${width}x${height}.txt`, tui.stripTerminalSequences(panel.render(width).join("\n")) + "\n");
              await writeFile(`/tmp/pi-msb-action-${width}x${height}.ansi`, panel.render(width).join("\n") + "\n");
            }
            terminal.columns = 80; terminal.rows = 24;
            await key("\r");
            if (tui.stripTerminalSequences(panel.render(80).join("\n")).includes("Review change")) await select("Confirm");
            assert.match(tui.stripTerminalSequences(panel.render(80).join("\n")), /Result: Applied/);
            await key("\x1b");
          }
          savedScopes = true;
          await loaded.extensions[0].commands.get("msb-fixture-verify-origin").handler("", runner.createCommandContext());
          await loaded.extensions[0].commands.get("msb-fixture-stop").handler("", runner.createCommandContext());
        }
        await expand("Secrets"); await expand("Secrets:"); await expand("TOKEN:");
        await choose("Value / reference:"); await key("e"); await select("Replace value / reference:");
        assert.match(tui.stripTerminalSequences(panel.render(80).at(-1)), /Enter keep.*Esc cancel.*q literal text/);
        await key("qeadwPGRAW_INPUT_SENTINEL");
        assert.doesNotMatch(output + panel.render(80).join("\n"), /RAW_INPUT_SENTINEL|RUNTIME_PRIVATE_SENTINEL/);
        // Escape the masked input, then q closes directly from the clean entry form.
        await key("\x1b"); await key("q");
        await opening;
        assert.equal(ui.hasOverlay(), false);
        assert.equal(editor.focused, true);
        assert.equal(panel.focused, false);
        if (!savedScopes) {
          assert.equal(await readFile(join(canonicalAgent, "pi-microsandbox/default.toml"), "utf8"), originalPolicy);
          await assert.rejects(readFile(join(canonicalAgent, "pi-microsandbox/projects/workspace/config.toml")), { code: "ENOENT" });
        }
        output = ""; ui.renderNow(true); assert.match(output, /UNDERLYING/);
        input("x"); assert.equal(baseKeys, launch + 1);
      }
    } finally { ui.stop(); }
  }
  const policy = await readFile(join(canonicalAgent, "pi-microsandbox/default.toml"), "utf8");
  assert.ok(policy.includes("$FILE:../../token"));
  assert.doesNotMatch(policy, /RUNTIME_PRIVATE_SENTINEL/);
  assert.match(policy, /"show_footer" = false/);
  assert.match(await readFile(join(canonicalAgent, "pi-microsandbox/projects/workspace/config.toml"), "utf8"), /"show_footer" = true/);
  console.log(`PASS ${JSON.parse(await readFile(join(pkg, "package.json"), "utf8")).version}: real /msb loader/context/custom/theme, regular/fullscreen render, themed per-change scope buttons, masked input and focus teardown (fake SDK)`);
} finally { await rm(root, { recursive: true, force: true }); }
