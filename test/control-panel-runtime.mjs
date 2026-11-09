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
  await mkdir(canonicalAgent, { recursive: true }); await mkdir(join(root, "home/.pi"));
  await symlink(canonicalAgent, lexicalAgent);
  Object.assign(process.env, { HOME: join(root, "home"), PI_CODING_AGENT_DIR: lexicalAgent, PI_PACKAGE_DIR: pkg, PI_MSB_UI_FIXTURE_CWD: cwd, RUNTIME_HOST_ENV_SOURCE: "RUNTIME_PRIVATE_SENTINEL", RUNTIME_COMMAND_TOKEN: "COMMAND_RUNTIME_PRIVATE_SENTINEL" });
  execFileSync("git", ["init", "-q", cwd]);
  // Secret values are synthetic, never read from the real host's Pi config.
  await mkdir(join(canonicalAgent, "pi-microsandbox"));
  const originalPolicy = 'auto_start = false\n[[secrets]]\nenv = "TOKEN"\nhost_env = "RUNTIME_HOST_ENV_SOURCE"\nallow_hosts = ["api.example"]\n[[secrets]]\nenv = "COMMAND_TOKEN"\nhost_cmd = \'printf %s "$RUNTIME_COMMAND_TOKEN"\'\nallow_hosts = ["command.example"]\n';
  await writeFile(join(canonicalAgent, "pi-microsandbox/default.toml"), originalPolicy);
  const mod = (path) => import(pathToFileURL(join(pkg, "dist", `${path}.js`)));
  const { loadExtensions } = await mod("core/extensions/loader");
  const { ExtensionRunner } = await mod("core/extensions/runner");
  const { InteractiveMode } = await mod("modes/interactive/interactive-mode");
  const { ExtensionSelectorComponent } = await mod("modes/interactive/components/extension-selector");
  const { initTheme, theme } = await mod("modes/interactive/theme/theme");
  initTheme("dark");
  const require = createRequire(join(pkg, "package.json"));
  const tui = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));
  const loaded = await loadExtensions([join(import.meta.dirname, "control-panel-runtime-extension.ts")], cwd);
  assert.deepEqual(loaded.errors, []);
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, { getSessionId: () => "ui-runtime", getEntries: () => [] }, {});
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
    const editorContainer = new tui.Container();
    editorContainer.addChild(editor);
    ui.addChild(editorContainer);
    if (ui instanceof tui.TuiAltScreen) ui.setLayoutRoot(editorContainer);
    ui.setFocus(editor);
    const showOverlay = ui.showOverlay.bind(ui);
    ui.showOverlay = (component, options) => { panel = component; return showOverlay(component, options); };
    const mode = Object.create(InteractiveMode.prototype);
    Object.assign(mode, { ui, editor, editorContainer, extensionDialogs: [], keybindings: tui.getKeybindings(), programStatus: { setBlocked() {} } });
    const context = mode.createExtensionUIContext();
    context.notify = (message) => notices.push(message);
    const nativeSelect = context.select.bind(context);
    const custom = context.custom.bind(context);
    let selection;
    let customCalls = 0;
    context.select = (title, choices, options) => {
      selection = { title, choices, options };
      return nativeSelect(title, choices, options);
    };
    context.custom = (...args) => { customCalls++; return custom(...args); };
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
        assert.deepEqual(roots.map((line) => line.slice(4).trimEnd()), ["Resources", "Network", "Secrets", "Variables", "Mounts", "Tools", "Image", "Sources", "Actions", "Status", "General", "Advanced"]);
        assert.ok(roots.every((line) => /^[> ] ▸ /.test(line)));
        assert.match(initial, /^MICROSANDBOX *\n> ▸ Resources/m);
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
          assert.doesNotMatch(frame, /UNDERLYING|PRIVATE_SENTINEL/);
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
        await choose("Resources");
        for (const [left, right] of [["h", "l"], ["\x1b[D", "\x1b[C"]]) {
          await key(left); assert.match(tui.stripTerminalSequences(panel.render(80).join("\n")), /> ▸ Resources/);
          await key(right); assert.match(tui.stripTerminalSequences(panel.render(80).join("\n")), /> ▾ Resources/);
          await key(right); assert.match(tui.stripTerminalSequences(panel.render(80).join("\n")), />     Virtual CPUs:/);
          await key(left); await key(left);
          assert.match(tui.stripTerminalSequences(panel.render(80).join("\n")), /> ▸ Resources/);
        }
        await expand("Image"); await choose("Guest image:"); await key("e");
        const imageEditor = tui.stripTerminalSequences(panel.render(80).join("\n"));
        assert.match(imageEditor, /Enter a nonempty guest image name/);
        await key("\x1b"); await key("\r");
        assert.equal(tui.stripTerminalSequences(panel.render(80).join("\n")), imageEditor);
        await key("\x1b"); await choose("Image"); await key("h");
        await expand("Variables"); await choose("Host Env:"); await key("a");
        assert.match(tui.stripTerminalSequences(panel.render(80).join("\n")), /Enter one host environment variable name/);
        await key("\x1b"); await choose("Variables"); await key("h");
        await expand("Sources");
        assert.match(tui.stripTerminalSequences(panel.render(80).join("\n")), /Inheritance:/);
        await choose("Sources"); await key("h");
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
          const labels = ["Session", "Project", "Global"];
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
            if (scope === 1) {
              assert.match(tui.stripTerminalSequences(panel.render(80).join("\n")), /> \[ No \]/);
              await select("Yes (Only for workspace worktree)");
            }
            if (tui.stripTerminalSequences(panel.render(80).join("\n")).includes("Review change")) await select("Confirm");
            assert.match(tui.stripTerminalSequences(panel.render(80).join("\n")), /Result: Applied/);
            await key("\x1b");
          }
          savedScopes = true;
          await loaded.extensions[0].commands.get("msb-fixture-verify-origin").handler("", runner.createCommandContext());
          await loaded.extensions[0].commands.get("msb-fixture-stop").handler("", runner.createCommandContext());
        }
        await expand("Secrets"); await expand("Secrets:");
        for (const [name, source] of [["COMMAND_TOKEN", "Host shell command"], ["TOKEN", "Host environment variable"]]) {
          await expand(`${name}:`); await choose("Source:");
          const secretView = tui.stripTerminalSequences(panel.render(80).join("\n"));
          assert.ok(secretView.includes(source));
          assert.doesNotMatch(secretView, /PRIVATE_SENTINEL/);
          if (name === "COMMAND_TOKEN") { await choose(`${name}:`); await key("h"); }
        }
        await choose("Source value:"); await key("e"); await select("Source value:");
        assert.match(tui.stripTerminalSequences(panel.render(80).at(-1)), /Enter keep.*Esc cancel.*q literal text/);
        await key("qeadwPGRAW_INPUT_SENTINEL");
        assert.doesNotMatch(output + panel.render(80).join("\n"), /RAW_INPUT_SENTINEL|PRIVATE_SENTINEL/);
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
      await loaded.extensions[0].commands.get("msb-fixture-enable").handler("", runner.createCommandContext());
      // Execute actual loaded configuration tools with native extension UI/context.
      const inspect = runner.getToolDefinition("msb_config_get");
      const setter = runner.getToolDefinition("msb_config_set");
      assert.ok(inspect); assert.ok(setter);
      const inspection = await inspect.execute("inspect", {}, undefined, undefined, runner.createContext());
      assert.equal(inspection.details.outcome, "inspected");
      assert.deepEqual(Object.keys(inspection.details.layers).sort(), ["global", "project", "session", "worktree"]);
      assert.deepEqual(setter.parameters.properties.scope.anyOf.map((item) => item.const), ["session", "project", "global"]);
      assert.equal(inspection.details.capabilities.mutation.batch.maxReloads, 1);
      assert.deepEqual(inspection.details.settingsSchema["network.mode"].valueSchema.enum, ["default", "open", "allowlist", "deny"]);
      assert.ok(inspection.details.effectivePolicy.adopted);
      assert.doesNotMatch(JSON.stringify(inspection), /PRIVATE_SENTINEL/);
      assert.deepEqual(inspection.details.desired.secrets, [
        { env: "TOKEN", host_env: "RUNTIME_HOST_ENV_SOURCE", allow_hosts: ["api.example"] },
        { env: "COMMAND_TOKEN", host_cmd: 'printf %s "$RUNTIME_COMMAND_TOKEN"', allow_hosts: ["command.example"] },
      ]);
      assert.match(inspection.content[0].text, /Microsandbox settings/);
      for (const expanded of [false, true]) {
        const frame = inspect.renderResult(inspection, { expanded, isPartial: false }, theme, {}).render(100).join("\n");
        assert.doesNotMatch(frame, /PRIVATE_SENTINEL/);
      }
      const secretInspection = await inspect.execute("secret-sources", { sections: ["desired"], paths: ["secrets"], format: "json" }, undefined, undefined, runner.createContext());
      assert.deepEqual(JSON.parse(secretInspection.content[0].text), secretInspection.details);
      assert.deepEqual(secretInspection.details.desired.secrets, inspection.details.desired.secrets);
      assert.doesNotMatch(JSON.stringify(secretInspection), /PRIVATE_SENTINEL/);
      const filtered = await inspect.execute("filtered", { sections: ["summary", "desired"], paths: ["network"] }, undefined, undefined, runner.createContext());
      assert.deepEqual(Object.keys(filtered.details.desired), ["network"]);
      assert.equal(filtered.details.settingsSchema, undefined);
      for (const expanded of [false, true]) {
        const frame = inspect.renderResult(filtered, { expanded, isPartial: false }, theme, {}).render(100).join("\n");
        assert.match(tui.stripTerminalSequences(frame), /Pi \/reload/);
        assert.doesNotMatch(frame, /PRIVATE_SENTINEL/);
      }
      const json = await inspect.execute("json", { sections: ["desired"], paths: ["network.mode"], format: "json" }, undefined, undefined, runner.createContext());
      assert.deepEqual(JSON.parse(json.content[0].text), json.details);
      const invalid = await setter.execute("invalid", { scope: "session", operations: [{ path: "show_footer", operation: "set", value: true }, { path: "cpus", operation: "set", value: 0 }] }, undefined, undefined, runner.createContext());
      assert.equal(invalid.details.validation[0].operationIndex, 1); assert.equal(invalid.details.validation[0].path, "cpus");
      for (const action of ["default-cancel", "escape", "ctrl-c", "approve", "apply", "restart", "batch", "abort", "narrow-approve", "secret-hosts", "secret-rotation", "long-warnings", "host-no-op", "network-reload-failed", "network-restore"]) {
        selection = undefined;
        const previousCustomCalls = customCalls;
        const abort = new AbortController();
        const proposal = action === "network-restore" ? { scope: "session", path: "network.mode", operation: "set", value: "default" }
          : action === "network-reload-failed" ? { scope: "session", operations: [
            { path: "auto_start", operation: "set", value: true },
            { path: "network.allow_hosts", operation: "set", value: [`api-${Renderer.name.toLowerCase()}.example`] },
            { path: "network.mode", operation: "set", value: "allowlist" },
          ] }
          : ["long-warnings", "host-no-op"].includes(action) ? { scope: "session", path: "pass_through_tools", operation: "set", value: Array.from({ length: 40 }, (_, n) => `trusted-${n}-${Renderer.name}`) }
          : action === "secret-hosts" ? { scope: "global", path: "secrets", operation: "upsert", value: { env: "TOKEN", allowHosts: Array.from({ length: 40 }, (_, n) => `host-${n}.example`) } }
          : action === "secret-rotation" ? { scope: "global", path: "secrets", operation: "upsert", value: { env: "TOKEN", allowHosts: ["api.example"], hostCmd: "printf %s ROTATED_PUBLIC_COMMAND" } }
          : action === "apply" ? { scope: "session", path: "show_footer", operation: "set", value: !inspection.details.desired.show_footer }
          : action === "restart" ? { scope: "session", path: "memory_mib", operation: "set", value: inspection.details.desired.memory_mib + 128 }
          : action === "batch" ? { scope: "session", operations: [
            { path: "memory_mib", operation: "set", value: inspection.details.desired.memory_mib + 256 },
            { path: "idle_timeout_sec", operation: "set", value: inspection.details.desired.idle_timeout_sec + 1 },
          ] }
          : { scope: "session", path: "cpus", operation: "inherit" };
        const pending = setter.execute("config", proposal, abort.signal, undefined, runner.createContext());
        let failure; pending.catch((error) => { failure = error; });
        for (let n = 0; n < 500 && !selection && !failure; n++) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(failure, undefined); assert.ok(selection, "configuration execute must call the native selector");
        assert.deepEqual(selection.choices, ["No", "Yes"]);
        assert.ok(selection.options.signal instanceof AbortSignal);
        assert.equal(customCalls, previousCustomCalls);
        assert.equal(ui.hasOverlay(), false);
        panel = editorContainer.children[0];
        assert.ok(panel instanceof ExtensionSelectorComponent);
        assert.equal(editor.focused, false);
        for (const [width, height] of [[32, 10], [80, 24], [24, 2], [120, 40], [80, 24]]) {
          terminal.columns = width; terminal.rows = height;
          // Pi owns native layout; long titles can exceed the viewport. No extension clipping/gate.
          assert.doesNotMatch(panel.render(width).join("\n"), /PRIVATE_SENTINEL|UNDERLYING/);
          output = ""; ui.renderNow(true);
          assert.doesNotMatch(output, /PRIVATE_SENTINEL/);
        }
        const frame = selection.title;
        assert.doesNotMatch(frame, /PRIVATE_SENTINEL/);
        if (action === "secret-rotation") assert.ok(frame.includes(JSON.stringify(proposal.value.hostCmd)));
        const rendered = panel.render(100).join("\n");
        const native = new ExtensionSelectorComponent("Allow host execution?", ["No", "Yes"], () => {}, () => {});
        const nativeRows = native.render(100);
        assert.equal(panel.render(100)[0], nativeRows[0]);
        assert.equal(panel.render(100).at(-1), nativeRows.at(-1));
        assert.match(tui.stripTerminalSequences(rendered), /Allow configuration change\?/);
        assert.ok(rendered.includes(theme.fg("accent", "→ ") + theme.fg("accent", "No")));
        assert.match(tui.stripTerminalSequences(rendered), /\n → No *\n   Yes *\n/);
        assert.doesNotMatch(rendered, /MICROSANDBOX|End seen|Read to end|PgUp|PgDn|32×10/);
        const scopeLabel = proposal.scope[0].toUpperCase() + proposal.scope.slice(1);
        assert.ok(tui.stripTerminalSequences(frame).split("\n").includes(`Scope: ${scopeLabel}`));
        assert.ok(frame.includes(theme.fg("muted", "Scope: ") + theme.fg("warning", scopeLabel)));
        assert.ok(rendered.includes(theme.fg("muted", "Scope: ") + theme.fg("warning", scopeLabel)));
        const callFrame = setter.renderCall({ ...proposal, identity: "UNSAFE_PRIVATE_SENTINEL" }, theme, {}).render(100).join("\n");
        assert.doesNotMatch(callFrame, /PRIVATE_SENTINEL|allowHosts|value/);
        if (action.startsWith("secret-")) {
          assert.ok(frame.includes(theme.fg("toolDiffRemoved", "- ")));
          assert.ok(frame.includes(theme.fg("toolDiffAdded", "+ ")));
          assert.ok(rendered.includes(theme.fg("toolDiffRemoved", "- ")));
          assert.ok(rendered.includes(theme.fg("toolDiffAdded", "+ ")));
          assert.notEqual(theme.fg("toolDiffRemoved", "test"), theme.fg("toolDiffAdded", "test"));
          assert.ok(frame.includes(theme.fg("muted", "Scope: ") + theme.fg("warning", "Global")));
          assert.ok(frame.includes(theme.fg("muted", "Secret TOKEN")));
          assert.ok(rendered.includes(theme.fg("muted", "Secret TOKEN")));
          assert.doesNotMatch(frame, /adoptedRuntime|provenance|"before"|"after"/);
          if (action !== "secret-rotation") assert.doesNotMatch(frame, /HOST/);
          if (action === "secret-rotation") {
            assert.ok(frame.includes(theme.fg("toolDiffRemoved", "RUNTIME_HOST_ENV_SOURCE")));
            assert.ok(frame.includes(theme.fg("toolDiffAdded", "printf %s ROTATED_PUBLIC_COMMAND")));
            assert.match(tui.stripTerminalSequences(frame), /- Host variables: RUNTIME_HOST_ENV_SOURCE\n\+ Host command: printf %s ROTATED_PUBLIC_COMMAND/);
            assert.doesNotMatch(frame, /Hosts:/);
          }
        }
        if (action === "secret-hosts" || action === "long-warnings") {
          // All changed values go to Pi without pagination; warnings go to the agent after completion.
          for (let n = 0; n < 40; n++) assert.ok(frame.includes(action === "secret-hosts" ? `host-${n}.example` : `trusted-${n}`));
          if (action === "long-warnings") {
            assert.doesNotMatch(tui.stripTerminalSequences(frame), /without per-call host approval|Replaces this scope’s entire list/);
          }
        }
        const key = (value) => { input(value); ui.renderNow(true); };
        if (["default-cancel", "secret-hosts"].includes(action)) key("\r");
        if (action === "escape" || action === "secret-rotation") key("\x1b");
        if (action === "ctrl-c") key("\x03");
        if (action === "abort") abort.abort();
        if (action === "narrow-approve") { terminal.columns = 24; terminal.rows = 2; panel.render(24); }
        if (["approve", "apply", "restart", "batch", "narrow-approve", "long-warnings", "host-no-op", "network-reload-failed", "network-restore"].includes(action)) {
          // Yes works immediately, even for long reviews or tiny terminals: there is no end gate.
          key("\x1b[B"); assert.match(tui.stripTerminalSequences(panel.render(80).join("\n")), /→ Yes/); key("\r");
        }
        const result = await pending;
        const modelText = result.content[0].text;
        assert.doesNotMatch(modelText, /\x1b|PRIVATE_SENTINEL/);
        assert.doesNotMatch(JSON.stringify(result.details), /PRIVATE_SENTINEL/);
        const warnings = modelText.split("\n").filter((line) => line.startsWith("! "));
        for (const warning of warnings) assert.ok(!tui.stripTerminalSequences(frame).includes(warning));
        assert.doesNotMatch(tui.stripTerminalSequences(frame), /! |Restart:|May start the sandbox|DNS\/IP|DNS exfiltration|Session settings are memory-only/);
        if (action !== "secret-rotation") assert.doesNotMatch(frame, /HOST/);
        if (action === "long-warnings") {
          assert.match(modelText, /without per-call host approval/);
          assert.match(modelText, /Replaces this scope’s entire list/);
        }
        // The fake SDK deliberately lacks the allowlist policy builder: saving succeeds, activation fails.
        if (action === "network-reload-failed") {
          assert.equal(result.details.outcome, "saved_but_reload_failed");
          assert.equal(result.details.saved, true); assert.equal(result.details.reloaded, false);
          assert.match(modelText, /saved but not fully activated/); assert.doesNotMatch(modelText, /Saved · reloaded/);
          assert.match(modelText, /DNS\/IP/); assert.match(modelText, /DNS exfiltration/);
        }
        if (action === "host-no-op") {
          assert.equal(result.details.saved, false); assert.equal(result.details.reloaded, false);
          assert.match(modelText, /No change · not saved or reloaded/);
          assert.match(modelText, /without per-call host approval/);
        }
        if (action === "network-restore") assert.match(modelText, /May start the sandbox/);
        if (["restart", "batch"].includes(action)) assert.match(modelText, /Restart: temporary guest data/);
        if (["apply", "restart", "batch", "long-warnings", "network-reload-failed"].includes(action)) assert.match(modelText, /Settings reload does not clear/);
        for (const expanded of [false, true]) {
          const rendered = setter.renderResult(result, { expanded, isPartial: false }, theme, { isError: false }).render(100).join("\n");
          assert.doesNotMatch(rendered, /PRIVATE_SENTINEL|adoptedRuntime|provenance|"before"|"after"/);
          const humanText = tui.stripTerminalSequences(setter.renderResult(result, { expanded, isPartial: false }, theme, { isError: false }).render(10000).join("\n"));
          for (const warning of warnings) assert.ok(!humanText.includes(warning));
          if (["apply", "restart", "batch", "long-warnings", "network-restore"].includes(action)) assert.match(tui.stripTerminalSequences(rendered), /Saved · reloaded · runtime active/);
        }
        assert.equal(result.details.outcome, action === "network-reload-failed" ? "saved_but_reload_failed" : ["approve", "narrow-approve", "host-no-op"].includes(action) ? "no_op" : ["apply", "restart", "batch", "long-warnings", "network-restore"].includes(action) ? "applied" : "cancelled");
        if (["apply", "restart", "batch", "long-warnings", "network-restore"].includes(action)) { assert.equal(result.details.saved, true); assert.equal(result.details.reloaded, true); assert.equal(result.details.runtimeStatus, "active"); assert.equal(result.details.review.scope, proposal.scope); }
        assert.equal(ui.hasOverlay(), false); assert.equal(editor.focused, true);
        assert.equal(editorContainer.children[0], editor);
        assert.equal(customCalls, previousCustomCalls);
        terminal.columns = 80; terminal.rows = 24;
      }
      await loaded.extensions[0].commands.get("msb-fixture-stop").handler("", runner.createCommandContext());
    } finally { ui.stop(); }
  }
  // Actual entry registration provenance, including symlink loading and a duplicate-winning extension.
  const packageAlias = join(root, "package-link");
  await symlink(join(import.meta.dirname, ".."), packageAlias);
  const entry = join(packageAlias, "extensions/pi-msb/index.ts");
  const duplicate = join(root, "duplicate-config-tools.mjs");
  await writeFile(duplicate, `export default function(pi) { for (const name of ["msb_config_get", "msb_config_set"]) pi.registerTool({name,label:name,description:"duplicate host tool",parameters:{type:"object",properties:{}},execute:async()=>({content:[],details:{}})}); }`);
  for (const collision of [false, true]) {
    const gate = await loadExtensions(collision ? [duplicate, entry] : [entry], cwd);
    assert.deepEqual(gate.errors, []);
    const gateRunner = new ExtensionRunner(gate.extensions, gate.runtime, cwd, { getSessionId: () => "gate", getEntries: () => [] }, {});
    let provenance = "actual";
    gateRunner.bindCore({ getAllTools: () => gateRunner.getAllRegisteredTools().map(({definition, sourceInfo}) => ({ ...definition,
      sourceInfo: provenance === "missing" ? undefined : provenance === "mismatch" ? { ...sourceInfo, path: join(import.meta.dirname, "control-panel-runtime-extension.ts") } : sourceInfo,
    })) }, { getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined,
      hasPendingMessages: () => false, getSystemPrompt: () => "" });
    for (const source of ["actual", "missing", "mismatch"]) {
      provenance = source;
      for (const toolName of ["msb_config_get", "msb_config_set"]) {
        const answer = await gateRunner.emitToolCall({ type: "tool_call", toolName, toolCallId: "gate", input: {} });
        assert.equal(answer?.block === true, collision || source !== "actual", `${source}: collision=${collision}: ${toolName}`);
      }
    }
  }
  const policy = await readFile(join(canonicalAgent, "pi-microsandbox/default.toml"), "utf8");
  assert.match(policy, /^host_env = "RUNTIME_HOST_ENV_SOURCE"$/m);
  assert.ok(policy.includes(`host_cmd = ${JSON.stringify('printf %s "$RUNTIME_COMMAND_TOKEN"')}`));
  assert.doesNotMatch(policy, /^value\s*=/m);
  assert.match(policy, /^show_footer = false$/m);
  assert.match(await readFile(join(canonicalAgent, "pi-microsandbox/projects/workspace/config.toml"), "utf8"), /^show_footer = true$/m);
  console.log(`PASS ${JSON.parse(await readFile(join(pkg, "package.json"), "utf8")).version}: real /msb loader/context/custom/theme, regular/fullscreen render, themed per-change scope buttons, masked input, native No/Yes config approval, complete masked warning-free titles/agent-text-warnings/quiet-human-results/saved-not-activated/default-No/Escape/abort/immediate-long-review-consent/provenance-collision-gate and focus teardown (fake SDK)`);
} finally { await rm(root, { recursive: true, force: true }); }
