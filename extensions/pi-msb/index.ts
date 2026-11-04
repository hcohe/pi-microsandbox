import {
  CONFIG_DIR_NAME,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateLine,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHostReadAccess } from "./skill-access.ts";
import { createSandboxGrepExecute } from "./operations-exec.ts";
import { registerMsbCommand, systemPromptNote } from "./command.ts";
import { createMsbIntegration } from "./control.ts";
import { closeControlPanel } from "./control-panel.ts";
import { createMsbFooter } from "./footer.ts";
import { registerSandboxTools } from "./tools.ts";
import { displayId, type ResolvedConfig, type RuntimeState } from "./types.ts";

export function footerStatus(state: RuntimeState, visible: boolean, sessionId?: string): string | undefined {
  if (!visible) return undefined;
  const sessionDisplayId = sessionId ? displayId(sessionId) : undefined;
  switch (state.status) {
    case "active": return `msb-${state.info?.displayId ?? sessionDisplayId ?? "…"}`;
    case "off": return "MSB host";
    case "host-fallback": return "MSB host fallback";
    case "unavailable": return "MSB blocked";
    case "booting": return `msb-${sessionDisplayId ?? state.info?.displayId ?? "…"}`;
    case "stopping": return "MSB stopping";
    default: return "MSB disabled";
  }
}

export function styleFooterStatus(theme: Pick<ExtensionContext["ui"]["theme"], "fg">, text: string, status: RuntimeState["status"], frame = 0): string {
  let circleColor: "success" | "warning" | "dim" | "error" = "dim";
  if (status === "active") circleColor = "success";
  else if (status === "booting") circleColor = frame % 2 === 0 ? "warning" : "dim";
  else if (status === "unavailable") circleColor = "error";
  else if (status === "off" || status === "host-fallback" || status === "stopping") circleColor = "warning";
  return `\x1b[22m${theme.fg("dim", text)} ${theme.fg(circleColor, "●")}\x1b[22m`;
}

/**
 * The extension entry point intentionally imports no native SDK. Loading this
 * module must remain safe on hosts without KVM or the microsandbox binary;
 * control.ts calls import("microsandbox") only when a session actually boots.
 */
export default function registerPiMsb(pi: ExtensionAPI): void {
  const hostReads = createHostReadAccess();
  const integration = createMsbIntegration({
    sessionId: "uninitialized",
    cwd: process.cwd(),
    configDirName: CONFIG_DIR_NAME,
    env: process.env,
    appendEntry: (customType, data) => pi.appendEntry(customType, data),
    entries: () => currentContext?.sessionManager.getEntries() ?? [],
    onState: (state) => {
      if (currentContext) updateStatus(currentContext, state);
    },
  });
  const currentProvider = integration.provider;
  let currentContext: ExtensionContext | undefined;
  let currentSessionId: string | undefined;
  let currentCwd: string | undefined;
  let lastConfig: ResolvedConfig = integration.control.getEffectiveConfig();
  let bootAnimation: ReturnType<typeof setInterval> | undefined;
  let customFooterInstalled = false;

  const stopBootAnimation = (): void => {
    if (bootAnimation !== undefined) {
      clearInterval(bootAnimation);
      bootAnimation = undefined;
    }
  };

  const startBootAnimation = (): void => {
    if (bootAnimation !== undefined) return;
    let frame = 0;
    const render = (): void => {
      // Read the current session and theme on every tick, never a previous context.
      const ctx = currentContext;
      if (!ctx) return;
      const text = footerStatus({ status: "booting", info: null }, true, ctx.sessionManager.getSessionId())!;
      ctx.ui.setStatus("pi-msb", styleFooterStatus(ctx.ui.theme, text, "booting", frame));
      frame = (frame + 1) % 2;
    };
    render();
    bootAnimation = setInterval(render, 400);
  };

  const ensureCustomFooter = (ctx: ExtensionContext): void => {
    if (customFooterInstalled) return;
    ctx.ui.setFooter((tui, theme, footerData) => createMsbFooter(tui, theme, ctx, footerData));
    customFooterInstalled = true;
  };

  const updateStatus = (ctx: ExtensionContext, state: RuntimeState): void => {
    const text = footerStatus(state, integration.configRef.value.showFooter, ctx.sessionManager.getSessionId());
    if (text !== undefined) ensureCustomFooter(ctx);
    if (text === undefined) {
      stopBootAnimation();
      ctx.ui.setStatus("pi-msb", undefined);
      return;
    }
    if (state.status === "booting") {
      startBootAnimation();
      return;
    }
    stopBootAnimation();
    ctx.ui.setStatus("pi-msb", styleFooterStatus(ctx.ui.theme, text, state.status));
  };

  registerSandboxTools(pi, {
    provider: currentProvider,
    config: integration.configRef.value,
    cwd: process.cwd(),
    hostReads,
    createGrepExecute: ({ provider, cwd, grepHelpers }) =>
      createSandboxGrepExecute({ provider, cwd, helpers: grepHelpers }),
    grepHelpers: { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead: truncateHead as (content: string, options?: unknown) => any, truncateLine, formatSize },
    systemPromptNote,
  });
  registerMsbCommand(pi, integration.control);

  pi.on("session_start", async (_event, ctx) => {
    stopBootAnimation();
    currentContext = ctx;
    currentSessionId = ctx.sessionManager.getSessionId();
    currentCwd = ctx.cwd;
    updateStatus(ctx, { status: "booting", info: null });
    try {
      // Discover the workspace before host config bootstrap/resolution, then
      // pass that same identity through sandbox boot. Bare loads never write.
      const state = await integration.configureSession({
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
        restored: undefined,
      });
      lastConfig = integration.control.getEffectiveConfig();
      updateStatus(ctx, state);
      for (const warning of lastConfig.warnings) ctx.ui.notify(`pi-microsandbox: ${warning}`, "warning");
    } catch (error) {
      // Invalid config and native boot failures are fail-closed. Do not throw from
      // the lifecycle hook: Pi remains usable and routed tools remain blocked.
      updateStatus(ctx, { status: "unavailable", info: null });
      ctx.ui.notify(`pi-microsandbox unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await closeControlPanel();
    integration.endSession();
    stopBootAnimation();
    await integration.manager.shutdown();
    hostReads.clear();
    ctx.ui.setStatus("pi-msb", undefined);
    // Pi tears down extension-owned UI after this hook. Do not call
    // setFooter(undefined): another extension may have replaced our footer.
    currentContext = undefined;
  });

  // The tools module owns skill capture. Session identity changes must invalidate
  // temporary settings before routing tools under the replacement session.
  pi.on("session_info_changed", async (_event, ctx) => {
    if (!currentContext) return;
    if (ctx.sessionManager.getSessionId() !== currentSessionId || ctx.cwd !== currentCwd) {
      await closeControlPanel();
      integration.endSession();
      currentContext = ctx;
      currentSessionId = ctx.sessionManager.getSessionId();
      currentCwd = ctx.cwd;
      stopBootAnimation();
      updateStatus(ctx, { status: "booting", info: null });
      await integration.configureSession({ sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
    }
    updateStatus(ctx, integration.control.getState());
  });

  void lastConfig;
}
