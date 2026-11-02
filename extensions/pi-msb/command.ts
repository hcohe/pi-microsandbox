import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { openControlPanel, PanelLaunchError } from "./control-panel.ts";
import type { MsbControl, RuntimeState } from "./types.ts";
export type CommandContext = Pick<ExtensionCommandContext, "ui" | "hasUI" | "mode" | "waitForIdle">;
export type CommandHandler = (args: string, ctx: CommandContext) => Promise<void>;

export function formatStatus(state: RuntimeState): string | undefined {
  switch (state.status) {
    case "active": {
      const info = state.info;
      if (!info) return "MSB active (sandbox details unavailable)";
      return `MSB active · ${info.root} · ${info.name}`;
    }
    case "booting":
      return "MSB booting…";
    case "stopping":
      return "MSB stopping…";
    case "off":
      return "MSB host (off)";
    case "host-fallback":
      return "MSB host fallback (sandbox unavailable)";
    case "unavailable":
      return `MSB unavailable (blocked)${state.reason ? `: ${state.reason}` : ""}`;
    case "disabled":
      return "MSB disabled";
    default:
      return undefined;
  }
}

/** Text injected into the agent system prompt for the current runtime. */
export function systemPromptNote(state: RuntimeState): string {
  switch (state.status) {
    case "active": {
      const info = state.info;
      if (!info) return "MSB is active, but runtime details are unavailable.";
      const targetWarning =
        " Host-target execution, when enabled, is an explicit escape from the sandbox and should be used deliberately.";
      return `MSB sandbox ${info.name} has the host workspace mounted read/write at ${info.root}.${targetWarning}`;
    }
    case "off":
      return "MSB is explicitly off: tools run on the host. No sandbox is active.";
    case "host-fallback":
      return "MSB could not start and is using the configured host fallback. This is different from explicitly turning MSB off.";
    case "unavailable":
      return "MSB is unavailable and routed tools are blocked. Open /msb and choose Enable sandbox after fixing the reported problem. Turning off in Actions explicitly permits host execution.";
    case "booting":
      return "MSB is booting; wait for it to become active before using routed tools.";
    case "stopping":
      return "MSB is stopping; routed tools are temporarily unavailable.";
    case "disabled":
      return "MSB is disabled.";
    default:
      return "MSB runtime state is unknown; routed tools remain fail-closed.";
  }
}

export function createCommandHandler(control: MsbControl): CommandHandler {
  return async (args, ctx) => {
    if (args.trim()) {
      ctx.ui.notify("/msb has no subcommands. Run /msb to open the full-screen control panel.", "error");
      return;
    }
    if (!ctx.hasUI || ctx.mode !== "tui") {
      ctx.ui.notify("/msb requires Pi interactive terminal mode. Start Pi interactively, or edit host-owned config.toml/default.toml and restart the session; PI_MSB_* environment settings are also supported.", "error");
      return;
    }
    try { await openControlPanel(ctx, control); }
    catch (error) {
      // Expected policy/I/O failures are actionable; unexpected bugs still reach Pi's error handler, but only through a diagnostic stripped of sensitive causes.
      if (!(error instanceof PanelLaunchError)) throw new PanelLaunchError("interactive overlay", error);
      if (error.unexpected) throw error;
      ctx.ui.notify(error.message, "error");
    }
  };
}
export function registerMsbCommand(pi: ExtensionAPI, control: MsbControl): void {
  pi.registerCommand("msb", { description: "Open Microsandbox control panel", handler: createCommandHandler(control) });
}
