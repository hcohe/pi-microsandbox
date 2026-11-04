import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveSecretValue } from "../extensions/pi-msb/config.ts";
import { createMsbIntegration } from "../extensions/pi-msb/control.ts";
import { fakeSdk } from "./fake-msb-sdk.ts";
import { registerConfigTools } from "../extensions/pi-msb/settings-tools.ts";
import { registerMsbCommand } from "../extensions/pi-msb/command.ts";

export default async function (pi: ExtensionAPI) {
  const cwd = process.env.PI_MSB_UI_FIXTURE_CWD!;
  const integration = createMsbIntegration({ sessionId: "ui-runtime", cwd, agentDir: process.env.PI_CODING_AGENT_DIR!, configDirName: ".pi", env: { HOME: process.env.HOME, PI_MSB_AUTO_START: "false" }, sdkLoader: async () => fakeSdk([]), acquireOwnerLock: async () => ({ path: `${cwd}/../fixture.lock`, release: async () => {} }) });
  await integration.configureSession({ sessionId: "ui-runtime", cwd, projectTrusted: true });
  registerMsbCommand(pi, integration.control);
  registerConfigTools(pi, integration.control);
  pi.registerCommand("msb-fixture-enable", { handler: async () => { await integration.control.setEnabled(true); assert.equal(integration.control.getState().status, "active"); } });
  pi.registerCommand("msb-fixture-stop", { handler: async () => { await integration.control.setEnabled(false); } });
  pi.registerCommand("msb-fixture-verify-origin", { handler: async () => {
    const value = integration.configRef.value.secrets[0]!.value;
    assert.equal(value, `$FILE:${process.env.PI_MSB_UI_FIXTURE_TOKEN}`);
    assert.equal(await resolveSecretValue(value, {}), "RUNTIME_PRIVATE_SENTINEL");
  } });
}
