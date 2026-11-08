import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, hostConfigPaths } from "./config.ts";
import { createMsbIntegration } from "./control.ts";

// Deliberately separate from ordinary/live-smoke tests: this downloads and builds images.
test("live Dockerfile build/export/SDK import/runtime roundtrip", { skip: process.env.PI_MSB_LIVE_BUILD_TEST !== "1", timeout: 25 * 60_000 }, async (t) => {
  const root = await fs.mkdtemp("/tmp/pi-msb-live-build-");
  const cwd = join(root, "workspace"); const agentDir = join(root, "agent");
  await fs.mkdir(cwd); await fs.mkdir(agentDir);
  const marker = randomUUID();
  const paths = await hostConfigPaths({ cwd, agentDir, projectTrusted: true, configDirName: "pi" });
  await fs.mkdir(dirname(paths.project), { recursive: true });
  await fs.writeFile(join(dirname(paths.project), "Dockerfile"), `FROM ${DEFAULT_CONFIG.image}\nRUN printf '%s' '${marker}' > /pi-msb-build-marker\n`);
  await fs.writeFile(paths.project, 'prune_on_start=false\n[docker]\nmode="disabled"\n');
  const integration = createMsbIntegration({ sessionId: `live-build-${marker}`, cwd, agentDir, configDirName: "pi", env: {} });
  t.after(async () => {
    await integration.manager.shutdown();
    const reference = integration.control.getEffectiveConfig().config.image;
    if (reference.startsWith("localhost/pi-msb-build:")) {
      const { Image } = await import("microsandbox");
      await Image.remove(reference);
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const state = await integration.configureSession({ sessionId: `live-build-${marker}`, cwd, projectTrusted: true });
  assert.equal(state.status, "active", state.reason);
  assert.equal(integration.control.getEffectiveConfig().config.pullPolicy, "never");
  const result = await integration.provider.withRuntime((runtime) => runtime.transport.exec("cat", ["/pi-msb-build-marker"]));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.toString(), marker);
});
