import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveSecretValue } from "../extensions/pi-msb/config.ts";
import { createMsbIntegration } from "../extensions/pi-msb/control.ts";
import { fakeSdk } from "./fake-msb-sdk.ts";
import { registerConfigTools } from "../extensions/pi-msb/settings-tools.ts";
import { registerMsbCommand } from "../extensions/pi-msb/command.ts";

export default async function (pi: ExtensionAPI) {
  const cwd = process.env.PI_MSB_UI_FIXTURE_CWD!;
  const env = { HOME: process.env.HOME, PI_MSB_AUTO_START: "false", RUNTIME_HOST_ENV_SOURCE: process.env.RUNTIME_HOST_ENV_SOURCE, RUNTIME_COMMAND_TOKEN: process.env.RUNTIME_COMMAND_TOKEN };
  const integration = createMsbIntegration({ sessionId: "ui-runtime", cwd, agentDir: process.env.PI_CODING_AGENT_DIR!, configDirName: ".pi", env, sdkLoader: async () => fakeSdk([]), acquireOwnerLock: async () => ({ path: `${cwd}/../fixture.lock`, release: async () => {} }) });
  await integration.configureSession({ sessionId: "ui-runtime", cwd, projectTrusted: true });
  registerMsbCommand(pi, integration.control);
  registerConfigTools(pi, integration.control);
  pi.registerCommand("msb-fixture-enable", { handler: async () => { await integration.control.setEnabled(true); assert.equal(integration.control.getState().status, "active"); } });
  pi.registerCommand("msb-fixture-stop", { handler: async () => { await integration.control.setEnabled(false); } });
  pi.registerCommand("msb-fixture-verify-origin", { handler: async () => {
    const [hostEnv, hostCmd] = integration.configRef.value.secrets;
    assert.deepEqual(hostEnv, { env: "TOKEN", hostEnv: "RUNTIME_HOST_ENV_SOURCE", allowHosts: ["api.example"] });
    assert.deepEqual(hostCmd, { env: "COMMAND_TOKEN", hostCmd: 'printf %s "$RUNTIME_COMMAND_TOKEN"', allowHosts: ["command.example"] });
    assert.equal(await resolveSecretValue(hostEnv!, env), "RUNTIME_PRIVATE_SENTINEL");
    assert.equal(await resolveSecretValue(hostCmd!, env), "COMMAND_RUNTIME_PRIVATE_SENTINEL");
  } });
}
