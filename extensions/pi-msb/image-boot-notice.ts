import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DockerfileSource } from "./image-source.ts";

/** Presentation only: retain the configured agent alias, never rebase source ownership. */
export function customImageBootMessage(source: DockerfileSource, home = homedir()): string {
  const path = join(source.agentAlias, relative(source.agentRoot, source.dockerfile));
  const homeRelative = relative(home, path);
  const display = homeRelative === "" ? "~"
    : !isAbsolute(homeRelative) && homeRelative !== ".." && !homeRelative.startsWith(`..${sep}`) ? `~/${homeRelative}` : path;
  const safePath = display.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);
  return `Booting from custom image (${source.scope === "host-project" ? "Project" : "Global"} Dockerfile: ${safePath})`;
}

export function notifyCustomImageBoot(ctx: Pick<ExtensionContext, "hasUI" | "mode" | "ui">, source: DockerfileSource): void {
  if (!ctx.hasUI) return;
  const message = customImageBootMessage(source);
  ctx.ui.notify(ctx.mode === "tui" ? ctx.ui.theme.fg("dim", message) : message, "info");
}
