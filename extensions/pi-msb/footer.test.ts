import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { alignFooterRow, createMsbFooter } from "./footer.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function context(): ExtensionContext {
  return {
    model: undefined,
    thinkingLevel: "off",
    sessionManager: {
      getCwd: () => "/repo",
      getSessionName: () => undefined,
      getEntries: () => [],
    },
    modelRegistry: {
      getProvider: () => undefined,
      isUsingOAuth: () => false,
    },
    getContextUsage: () => ({ tokens: 0, contextWindow: 272_000, percent: 0 }),
  } as unknown as ExtensionContext;
}

function footerData(statuses: ReadonlyMap<string, string>): ReadonlyFooterDataProvider {
  return {
    getGitBranch: () => "main",
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => 1,
    onBranchChange: () => () => undefined,
  };
}

const tui = { requestRender() {} } as unknown as TUI;

test("aligns the MSB value against the right edge", () => {
  const row = alignFooterRow("left", "MSB active", 24);
  assert.equal(visibleWidth(row), 24);
  assert.ok(row.endsWith("MSB active"));
});

test("MSB status occupies the upper-right footer without adding a status row", () => {
  const component = createMsbFooter(
    tui,
    plainTheme,
    context(),
    footerData(new Map([["pi-msb", "msb-bf9379"]])),
  );
  const lines = component.render(80);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^\/repo \(main\)\s+msb-bf9379$/);
  assert.match(lines[1]!, /^0\.0%\/272k\s+no-model$/);
});

test("keeps statuses from other extensions on the shared status row", () => {
  const component = createMsbFooter(
    tui,
    plainTheme,
    context(),
    footerData(new Map([
      ["pi-msb", "MSB active"],
      ["other", "Other ready"],
    ])),
  );
  const lines = component.render(60);
  assert.equal(lines.length, 3);
  assert.equal(lines[2], "Other ready");
});
