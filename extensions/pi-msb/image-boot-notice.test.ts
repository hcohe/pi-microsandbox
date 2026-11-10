import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { hostConfigPaths, resolveConfig } from "./config.ts";
import { customImageBootMessage, notifyCustomImageBoot } from "./image-boot-notice.ts";
import type { DockerfileSource } from "./image-source.ts";

const source: DockerfileSource = {
  dockerfile: "/dotfiles/agent/pi-microsandbox/projects/Code/kah-movil/Dockerfile",
  agentRoot: "/dotfiles/agent", agentAlias: "/home/user/pi/agent", cacheDir: "/dotfiles/agent/pi-microsandbox/build-cache",
  scope: "host-project", identity: "loaded", platform: "linux/arm64",
};

test("custom image boot notice has exact Project/Global wording and preserves configured agent spelling", () => {
  assert.equal(customImageBootMessage(source, "/home/user"), "Booting from custom image (Project Dockerfile: ~/pi/agent/pi-microsandbox/projects/Code/kah-movil/Dockerfile)");
  const global = { ...source, scope: "host-default" as const, dockerfile: "/dotfiles/agent/pi-microsandbox/Dockerfile" };
  assert.equal(customImageBootMessage(global, "/home/user"), "Booting from custom image (Global Dockerfile: ~/pi/agent/pi-microsandbox/Dockerfile)");
  assert.equal(customImageBootMessage({ ...global, agentAlias: "/home/user/.pi/agent" }, "/home/user"), "Booting from custom image (Global Dockerfile: ~/.pi/agent/pi-microsandbox/Dockerfile)");
});

test("custom image boot paths stay absolute outside home, respect component boundaries and escape controls/bidi before styling", () => {
  for (const agentAlias of ["/srv/pi/agent", "/home/username/pi/agent"]) {
    assert.equal(customImageBootMessage({ ...source, agentAlias }, "/home/user"), `Booting from custom image (Project Dockerfile: ${agentAlias}/pi-microsandbox/projects/Code/kah-movil/Dockerfile)`);
  }
  const unsafe = { ...source, agentAlias: "/home/user/pi\n\r\t\x1b]0;bad\x07\x9b\u202e\u2066\u2028/agent" };
  const message = customImageBootMessage(unsafe, "/home/user");
  assert.match(message, /pi\\u000a\\u000d\\u0009\\u001b\]0;bad\\u0007\\u009b\\u202e\\u2066\\u2028\/agent/);
  assert.doesNotMatch(message, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
});

test("custom image notice uses theme dim and info only in TUI, plain RPC, and no UI calls in print/JSON", () => {
  for (const mode of ["tui", "rpc", "print", "json"] as const) {
    const notifications: unknown[] = [], colors: string[] = [];
    const hasUI = mode === "tui" || mode === "rpc";
    const ctx = { mode, hasUI, ui: {
      theme: { fg(role: string, text: string) { assert.equal(mode, "tui"); colors.push(role); return `\x1b[90m${text}\x1b[39m`; } },
      notify(message: string, level: string) { assert.ok(hasUI); notifications.push([message, level]); },
    } };
    notifyCustomImageBoot(ctx as any, { ...source, agentAlias: "/srv/agent\x1b\u202e" });
    assert.deepEqual(colors, mode === "tui" ? ["dim"] : []);
    assert.equal(notifications.length, hasUI ? 1 : 0);
    if (hasUI) {
      const [message, level] = notifications[0] as string[];
      assert.equal(level, "info");
      assert.ok(message.includes("\\u001b\\u202e"));
      if (mode === "rpc") assert.doesNotMatch(message, /\x1b/);
    }
  }
});

test("resolved symlink agent alias is display-only and source information is not a config warning", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/pi-msb-boot-alias-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = join(root, "home", "Code", "kah-movil"), canonicalAgent = join(root, "dotfiles", "agent"), agentDir = join(root, "home", "pi", "agent");
  await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(canonicalAgent, { recursive: true });
  await fs.mkdir(dirname(agentDir), { recursive: true }); await fs.symlink(canonicalAgent, agentDir);
  const input = { cwd, agentDir, homedir: join(root, "home"), env: {}, projectTrusted: true, configDirName: "pi" };
  const paths = await hostConfigPaths(input), dockerfile = join(dirname(paths.project), "Dockerfile");
  await fs.mkdir(dirname(dockerfile), { recursive: true }); await fs.writeFile(dockerfile, "FROM scratch\n");
  const resolved = await resolveConfig(input);
  assert.deepEqual(resolved.warnings, []);
  assert.equal(resolved.imageBuild!.agentRoot, canonicalAgent);
  assert.equal(resolved.imageBuild!.dockerfile, dockerfile);
  assert.equal(resolved.imageBuild!.agentAlias, agentDir);
  assert.equal(customImageBootMessage(resolved.imageBuild!, input.homedir), "Booting from custom image (Project Dockerfile: ~/pi/agent/pi-microsandbox/projects/Code/kah-movil/Dockerfile)");
});

for (const scope of ["project", "global"] as const) test(`index custom image notice follows ${scope} startup/reload lifecycle without warnings or duplication`, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/pi-msb-boot-notice-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = join(root, "cwd"); await fs.mkdir(cwd);
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import {promises as fs} from 'node:fs';
    import {dirname, join} from 'node:path';
    import {registerHooks} from 'node:module';
    const controlUrl = ${JSON.stringify(new URL("./control.ts", import.meta.url).href)};
    const indexUrl = ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    const {buildSdk} = await import(${JSON.stringify(new URL("../../test/image-build-fixture.ts", import.meta.url).href)});
    const {DEFAULT_CONFIG, hostConfigPaths, resolveConfig} = await import(${JSON.stringify(new URL("./config.ts", import.meta.url).href)});
    const {customImageBootMessage} = await import(${JSON.stringify(new URL("./image-boot-notice.ts", import.meta.url).href)});
    const {snapshotDockerfile} = await import(${JSON.stringify(new URL("./image-source.ts", import.meta.url).href)});
    const calls = [], sdk = buildSdk(calls);
    sdk.NetworkPolicy.allowAll=()=>({});
    globalThis.fixture = {sdk};
    const wrapper = 'data:text/javascript,' + encodeURIComponent(
      'import {createMsbIntegration as create} from ' + JSON.stringify(controlUrl) + ';' +
      'export function createMsbIntegration(options) { const f=globalThis.fixture;' +
      'return f.integration=create({...options,sdkLoader:async()=>f.sdk,acquireOwnerLock:async()=>({path:"test",release:async()=>{}})}); }');
    registerHooks({resolve(specifier,context,next) {
      if(context.parentURL===indexUrl && specifier==='./control.ts') return {url:wrapper,shortCircuit:true};
      return next(specifier,context);
    }});
    const input = {cwd:process.cwd(),agentDir:process.env.PI_CODING_AGENT_DIR,env:process.env,configDirName:'pi'};
    const paths = await hostConfigPaths(input), policy = paths['${scope}'];
    const dockerfile = join(dirname(policy),'Dockerfile');
    await fs.mkdir(dirname(policy),{recursive:true});
    await fs.writeFile(policy,'auto_start=true\\nprune_on_start=false\\n[docker]\\nmode="disabled"\\n[network]\\nmode="open"\\n');
    const hooks = new Map(), notices = [];
    const {default:register} = await import(indexUrl);
    register({registerTool(){},registerCommand(){},appendEntry(){},on(event,handler){hooks.set(event,[...(hooks.get(event)??[]),handler]);}});
    const integration=globalThis.fixture.integration;
    const ctx={cwd:process.cwd(),mode:'rpc',hasUI:true,isProjectTrusted:()=>true,
      sessionManager:{getSessionId:()=> 'notice',getEntries:()=>[]},
      ui:{theme:{fg:(role,text)=>role+':'+text},setFooter(){},setStatus(){},notify(message,level){notices.push([message,level]);}}};
    const lifecycle=event=>hooks.get(event).at(-1)({},ctx);
    const custom=()=>notices.filter(([text])=>text.includes('Booting from custom image'));
    await lifecycle('session_start'); // bundled image: no custom notice
    assert.equal(custom().length,0);
    assert.ok(notices.some(([text,level])=>text.includes('network.mode=')&&level==='warning'));
    await lifecycle('session_shutdown');
    await fs.writeFile(dockerfile,'FROM scratch\\n');
    await lifecycle('session_start'); // unloaded source fails closed before boot
    assert.equal(integration.control.getState().status,'unavailable'); assert.equal(custom().length,0);
    const selected=(await resolveConfig(input)).imageBuild;
    const snapshot=await snapshotDockerfile(selected,DEFAULT_CONFIG.image);
    const buildSource={...selected,identity:snapshot.identity};
    const built=await integration.control.buildDockerfile({source:buildSource});
    await integration.control.loadDockerfile({source:buildSource,artifactId:built.artifact.artifactId,expectedSelectionVersion:'missing'});
    assert.equal(custom().length,0,'build/load alone must not notify');
    await integration.control.getEffectiveConfig(); await integration.control.settings.inspect();
    assert.equal(custom().length,0,'passive inspections must not notify');
    await integration.control.reload();
    assert.equal(integration.control.getState().status,'active');
    assert.deepEqual(custom(),[[customImageBootMessage(selected),'info']]);
    assert.doesNotMatch(JSON.stringify(notices),/image source:|generated local image|pull_policy=never|\\\\u001b/);
    await integration.control.reload();
    assert.equal(custom().length,1,'no-op reload must not duplicate');
    process.env.PI_MSB_SHOW_FOOTER='false'; await integration.control.reload();
    assert.equal(custom().length,1,'live-only reload must not notify');
    await fs.unlink(dockerfile); // selected image survives source deletion
    process.env.PI_MSB_CPUS='3'; await integration.control.reload();
    assert.equal(custom().length,2,'restart with deleted source retains selected notice');
    await lifecycle('session_shutdown'); await lifecycle('session_start');
    assert.equal(custom().length,3,'loaded startup with deleted source must notify once');
    ctx.mode='tui'; process.env.PI_MSB_CPUS='4'; await integration.control.reload();
    assert.equal(custom().length,4);
    assert.deepEqual(custom().at(-1),['dim:'+customImageBootMessage(selected),'info']);
    ctx.mode='print'; ctx.hasUI=false;
    process.env.PI_MSB_CPUS='5'; await integration.control.reload();
    assert.equal(custom().length,4,'headless boot must not notify');
    ctx.mode='rpc'; ctx.hasUI=true;
    const imageGet=sdk.Image.get; sdk.Image.get=async()=>{throw Error('missing loaded image');};
    await assert.rejects(integration.control.reload(),/activation failed/);
    assert.equal(custom().length,4,'unverifiable loaded image must not announce boot');
    sdk.Image.get=imageGet;
    await integration.control.setEnabled(false); await integration.control.reload();
    assert.equal(custom().length,4,'Off reload must not notify');
    process.env.PI_MSB_DISABLE='1'; await integration.control.reload();
    assert.equal(custom().length,4,'disabled reload must not notify');
    process.env.PI_MSB_DISABLE='0';
    await fs.writeFile(policy,(await fs.readFile(policy,'utf8')).replace('auto_start=true','auto_start=false'));
    await lifecycle('session_shutdown'); await lifecycle('session_start');
    assert.equal(custom().length,4,'autoStart=false must not notify');
    await fs.writeFile(policy,'image="explicit"\\nauto_start=true\\nprune_on_start=false\\n[docker]\\nmode="disabled"\\n');
    await integration.control.reload(); assert.equal(custom().length,4,'explicit image must not notify');
    await lifecycle('session_shutdown');
    console.log('PASS custom boot notice');
  `], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_MSB_DISABLE: "0", PI_MSB_BOOTSTRAP_TOOLS: "false", PI_MSB_PRUNE_ON_START: "false" }, encoding: "utf8", stdio: "pipe", timeout: 30_000 });
  assert.match(output, /PASS custom boot notice/);
});
