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
import { createMsbFooter } from "./footer.ts";
import { registerSandboxTools } from "./tools.ts";
import type { ResolvedConfig, RuntimeState } from "./types.ts";

export function footerStatus(state: RuntimeState, visible: boolean): string | undefined {
  if (!visible) return undefined;
  switch (state.status) {
    case "active": return `msb-${state.info?.displayId ?? "active"}`;
    case "off": return "MSB host";
    case "host-fallback": return "MSB host fallback";
    case "unavailable": return "MSB blocked";
    case "booting": return "(msb) preparing sandbox...";
    case "stopping": return "MSB stopping";
    default: return "MSB disabled";
  }
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
  let lastConfig: ResolvedConfig = integration.control.getEffectiveConfig();
  let bootAnimation: ReturnType<typeof setInterval> | undefined;
  let customFooterInstalled = false;

  const styleFooterStatus = (ctx: ExtensionContext, text: string): string =>
    `\x1b[22m${ctx.ui.theme.fg("dim", text)}\x1b[22m`;

  const stopBootAnimation = (): void => {
    if (bootAnimation !== undefined) {
      clearInterval(bootAnimation);
      bootAnimation = undefined;
    }
  };

  const startBootAnimation = (ctx: ExtensionContext): void => {
    if (bootAnimation !== undefined) return;
    const frames = [
      "(msb) preparing sandbox.",
      "(msb) preparing sandbox..",
      "(msb) preparing sandbox...",
    ];
    let frame = 0;
    const render = (): void => {
      ctx.ui.setStatus("pi-msb", styleFooterStatus(ctx, frames[frame]));
      frame = (frame + 1) % frames.length;
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
    const text = footerStatus(state, integration.configRef.value.showFooter);
    if (text !== undefined) ensureCustomFooter(ctx);
    if (text === undefined) {
      stopBootAnimation();
      ctx.ui.setStatus("pi-msb", undefined);
      return;
    }
    if (state.status === "booting") {
      startBootAnimation(ctx);
      return;
    }
    stopBootAnimation();
    ctx.ui.setStatus("pi-msb", styleFooterStatus(ctx, text));
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
    currentContext = ctx;
    updateStatus(ctx, { status: "booting", info: null });
    try {
      // configureSession performs Git discovery before project config resolution,
      // so trust and the nearest project file are evaluated against the real root.
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
    stopBootAnimation();
    await integration.manager.shutdown();
    hostReads.clear();
    ctx.ui.setStatus("pi-msb", undefined);
    // Pi tears down extension-owned UI after this hook. Do not call
    // setFooter(undefined): another extension may have replaced our footer.
    currentContext = undefined;
  });

  // The tools module owns the skill capture hook. This handler only keeps the
  // footer in sync after transitions initiated by commands or reload.
  pi.on("session_info_changed", () => {
    if (currentContext) updateStatus(currentContext, integration.control.getState());
  });

  void lastConfig;
}
