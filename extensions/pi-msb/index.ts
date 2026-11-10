import { fileURLToPath } from "node:url";
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
import { notifyCustomImageBoot } from "./image-boot-notice.ts";
import { registerConfigTools } from "./settings-tools.ts";
import { registerDiagnosticsTool } from "./diagnostics-tools.ts";
import { registerDockerfileTools } from "./dockerfile-tools.ts";
import { SESSION_LIFETIME_WARNING } from "./settings-safety.ts";
import { registerSandboxTools } from "./tools.ts";
import type { ResolvedConfig, RuntimeState, SessionExecutionIdentity } from "./types.ts";

export function footerStatus(state: RuntimeState, visible: boolean): string | undefined {
  if (!visible) return undefined;
  switch (state.status) {
    case "active": return `${state.info?.name ?? "MSB active"}${state.observation === "asleep" ? " asleep" : state.observation === "unknown" ? " uncertain" : ""}`;
    case "off": return "Microsandbox disabled - Running on host";
    case "host-fallback": return "MSB host fallback";
    case "unavailable": return "Microsandbox Blocked";
    case "booting": return state.pendingName ?? state.info?.name ?? "MSB starting";
    case "stopping": return "MSB stopping";
    default: return "MSB disabled";
  }
}

export function styleFooterStatus(theme: Pick<ExtensionContext["ui"]["theme"], "fg">, text: string, state: RuntimeState, frame = 0): string {
  const { status, observation } = state;
  let circleColor: "success" | "warning" | "dim" | "error" = "warning";
  if (status === "unavailable" || status === "disabled") circleColor = "error";
  else if (status === "active" && !observation) circleColor = "success";
  else if (status === "booting") circleColor = frame % 2 === 0 ? "warning" : "dim";
  return `\x1b[22m${theme.fg("dim", text)} ${theme.fg(circleColor, "●")}\x1b[22m`;
}

/**
 * The extension entry point intentionally imports no native SDK. Loading this
 * module must remain safe on hosts without KVM or the microsandbox binary;
 * control.ts calls import("microsandbox") only when a session actually boots.
 */
export default function registerPiMsb(pi: ExtensionAPI): void {
  const integration = createMsbIntegration({
    sessionId: "uninitialized",
    cwd: process.cwd(),
    configDirName: CONFIG_DIR_NAME,
    env: process.env,
    appendEntry: (customType, data) => pi.appendEntry(customType, data),
    entries: () => currentContext?.sessionManager.getEntries() ?? [],
    onCustomImageBoot: (source) => {
      if (currentContext) notifyCustomImageBoot(currentContext, source);
    },
    onState: (state) => {
      if (currentContext) updateStatus(currentContext, state);
    },
  });
  const currentProvider = integration.provider;
  let currentContext: ExtensionContext | undefined;
  let lastConfig: ResolvedConfig = integration.control.getEffectiveConfig();
  let bootAnimation: ReturnType<typeof setInterval> | undefined;
  let bootState: { identity: SessionExecutionIdentity; state: RuntimeState } | undefined;
  let bootGeneration = 0;
  let customFooterInstalled = false;
  let uiGeneration = 0;
  let observationTimer: ReturnType<typeof setInterval> | undefined;
  let observationGeneration = 0;

  const stopObservation = (): void => {
    observationGeneration += 1;
    clearInterval(observationTimer);
    observationTimer = undefined;
  };

  const startObservation = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || observationTimer !== undefined || !currentProvider.refreshState) return;
    const generation = observationGeneration;
    let pending = false;
    observationTimer = setInterval(() => {
      if (pending || generation !== observationGeneration || !integration.configRef.value.showFooter) return;
      const ctx = currentContext;
      const identity = currentProvider.execution!.current();
      if (!ctx?.hasUI) return;
      pending = true;
      void currentProvider.refreshState!().then((state) => {
        if (generation !== observationGeneration || currentContext !== ctx
          || currentProvider.execution!.current() !== identity) return;
        updateStatus(ctx, state);
      }).catch(() => {
        if (generation !== observationGeneration || currentContext !== ctx
          || currentProvider.execution!.current() !== identity) return;
        const state = currentProvider.getState();
        updateStatus(ctx, state.status === "active" ? { ...state, observation: "unknown" } : state);
      }).finally(() => { pending = false; });
    }, 2_000);
  };

  const stopBootAnimation = (): void => {
    bootGeneration += 1;
    bootState = undefined;
    if (bootAnimation !== undefined) {
      clearInterval(bootAnimation);
      bootAnimation = undefined;
    }
  };

  const startBootAnimation = (): void => {
    if (!currentContext?.hasUI || bootAnimation !== undefined) return;
    const generation = bootGeneration;
    let frame = 0;
    const render = (): void => {
      // Read the current UI and theme on every tick, never a previous context.
      const ctx = currentContext;
      if (!ctx || generation !== bootGeneration || !integration.configRef.value.showFooter) return;
      const identity = currentProvider.execution!.current();
      let state: RuntimeState = { status: "booting", info: null };
      if (bootState?.identity === identity && identity.sessionId === ctx.sessionManager.getSessionId() && identity.cwd === ctx.cwd) {
        const current = currentProvider.getState();
        state = current.status === "booting" ? current : bootState.state;
      }
      const text = footerStatus(state, true)!;
      ctx.ui.setStatus("pi-msb", styleFooterStatus(ctx.ui.theme, text, state, frame));
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
    const text = footerStatus(state, integration.configRef.value.showFooter);
    if (text !== undefined) ensureCustomFooter(ctx);
    if (text === undefined) {
      stopBootAnimation();
      stopObservation();
      ctx.ui.setStatus("pi-msb", undefined);
      return;
    }
    startObservation(ctx);
    if (state.status === "booting") {
      bootState = { identity: currentProvider.execution!.current(), state };
      if (bootAnimation !== undefined) ctx.ui.setStatus("pi-msb", styleFooterStatus(ctx.ui.theme, text, state));
      startBootAnimation();
      return;
    }
    stopBootAnimation();
    ctx.ui.setStatus("pi-msb", styleFooterStatus(ctx.ui.theme, text, state));
  };

  registerSandboxTools(pi, {
    provider: currentProvider,
    config: integration.configRef.value,
    cwd: process.cwd(),
    hostReads: createHostReadAccess(),
    createHostReads: createHostReadAccess,
    ownedConfigToolEntry: fileURLToPath(import.meta.url),
    createGrepExecute: ({ provider, cwd, grepHelpers }) =>
      createSandboxGrepExecute({ provider, cwd, helpers: grepHelpers }),
    grepHelpers: { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead: truncateHead as (content: string, options?: unknown) => any, truncateLine, formatSize },
    systemPromptNote,
  });
  registerMsbCommand(pi, integration.control);
  registerConfigTools(pi, integration.control);
  registerDiagnosticsTool(pi, integration.control);
  registerDockerfileTools(pi, integration.control, currentProvider.execution);

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++uiGeneration;
    stopBootAnimation();
    stopObservation();
    currentContext = ctx;
    updateStatus(ctx, { status: "booting", info: null });
    try {
      // Discover the workspace before host config bootstrap/resolution, then
      // pass that same identity through sandbox boot. Bare loads never write.
      const pending = integration.configureSession({
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
        restored: undefined,
      });
      const identity = currentProvider.execution!.current();
      const state = await pending;
      if (generation !== uiGeneration || currentProvider.execution!.current() !== identity) return;
      lastConfig = integration.control.getEffectiveConfig();
      updateStatus(ctx, state);
      for (const warning of lastConfig.warnings) ctx.ui.notify(`pi-microsandbox: ${warning}`, "warning");
    } catch (error) {
      // Invalid config and native boot failures are fail-closed. Do not throw from
      // the lifecycle hook: Pi remains usable and routed tools remain blocked.
      if (generation !== uiGeneration) return;
      updateStatus(ctx, { status: "unavailable", info: null });
      ctx.ui.notify(`pi-microsandbox unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  const warnSessionReset = (ctx: ExtensionContext): void => {
    try {
      if (ctx.hasUI && Object.keys(integration.control.settings?.temporary() ?? {}).length) {
        ctx.ui.notify(`Session sandbox overrides are being cleared. ${SESSION_LIFETIME_WARNING}`, "warning");
      }
    } catch { /* Missing settings or notification failure must not prevent teardown. */ }
  };
  pi.on("session_shutdown", async (_event, ctx) => {
    warnSessionReset(ctx);
    integration.endSession();
    uiGeneration += 1;
    currentContext = undefined;
    stopBootAnimation();
    stopObservation();
    customFooterInstalled = false;
    ctx.ui.setStatus("pi-msb", undefined);
    await closeControlPanel();
    await integration.manager.shutdown();
    // Pi tears down extension-owned UI after this hook. Do not call
    // setFooter(undefined): another extension may have replaced our footer.
  });

  // The tools module owns skill capture. Session identity changes must invalidate
  // temporary settings before routing tools under the replacement session.
  pi.on("session_info_changed", async (_event, ctx) => {
    if (!currentContext) return;
    const identity = currentProvider.execution!.current();
    // Renaming a session does not affect the label; preserve any reload animation.
    if (ctx.sessionManager.getSessionId() === identity.sessionId && ctx.cwd === identity.cwd) return;
    warnSessionReset(ctx);
    integration.endSession();
    currentContext = ctx;
    const generation = ++uiGeneration;
    stopObservation();
    stopBootAnimation();
    updateStatus(ctx, { status: "booting", info: null });
    const pending = integration.configureSession({ sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
    const replacement = currentProvider.execution!.current();
    await closeControlPanel();
    try {
      await pending;
      if (generation !== uiGeneration || currentProvider.execution!.current() !== replacement) return;
    } catch (error) {
      if (generation !== uiGeneration) return;
      ctx.ui.notify(`pi-microsandbox unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
    if (generation === uiGeneration) updateStatus(ctx, integration.control.getState());
  });

  void lastConfig;
}
