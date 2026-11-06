import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { approveSettings } from "./settings-approval.ts";
import { formatSettingsDiff, settingsDiff, type SettingsDiffLine } from "./settings-diff.ts";

const theme = { fg: (role: string, text: string) => `<${role}>${text}</${role}>`, bold: (text: string) => text };
const review: SettingsDiffLine[] = [{ kind: "context", text: "review" }];
function context(mode: string, select: (...args: any[]) => Promise<string | undefined>, hasUI = true): ExtensionContext {
  return { hasUI, mode, ui: { theme, select, custom: () => assert.fail("settings approval must not open an extension overlay") } } as unknown as ExtensionContext;
}

for (const mode of ["tui", "rpc"]) {
  test(`settings approval: ${mode} native No/Yes options, signal, explicit consent only on every invocation`, async () => {
    const abort = new AbortController();
    let calls = 0;
    for (const answer of [undefined, "No", "Approve", "Yes", "Yes"]) {
      const ctx = context(mode, async (title, choices, options) => {
        calls++;
        assert.equal(title, `Allow configuration change?\n\n${mode === "tui" ? "<muted>review</muted>" : "review"}`);
        assert.deepEqual(choices, ["No", "Yes"]);
        assert.deepEqual(options, { signal: abort.signal });
        return answer;
      });
      assert.equal(await approveSettings(ctx, review, abort.signal), answer === "Yes");
    }
    assert.equal(calls, 5);
  });

  test(`settings approval: ${mode} pre-abort, no UI and unsupported modes never open a selector`, async () => {
    const select = async () => assert.fail("must not request approval");
    const abort = new AbortController(); abort.abort();
    assert.equal(await approveSettings(context(mode, select), review, abort.signal), false);
    assert.equal(await approveSettings(context(mode, select, false), review, new AbortController().signal), false);
    for (const unsupported of ["print", "json", "unknown"]) {
      assert.equal(await approveSettings(context(unsupported, select), review, new AbortController().signal), false);
    }
  });

  test(`settings approval: ${mode} abort while selecting rejects even a late Yes; selector errors propagate`, async () => {
    const abort = new AbortController();
    const ctx = context(mode, async (_title, _choices, { signal }) => {
      assert.equal(signal, abort.signal); abort.abort(); return "Yes";
    });
    assert.equal(await approveSettings(ctx, review, abort.signal), false);
    await assert.rejects(approveSettings(context(mode, async () => { throw new Error("selector failure"); }), review, new AbortController().signal), /selector failure/);
  });

  test(`settings approval: ${mode} passes the complete long diff without warning kinds; Yes needs no paging`, async () => {
    const long: SettingsDiffLine[] = [
      { kind: "scope", label: "Scope", text: "Global" },
      { kind: "context", text: "Secret TOKEN" },
      { kind: "context", text: "! Keep this nonwarning context" },
      ...[
        "Restart: temporary guest data and nested containers may be lost.",
        "May start the sandbox because auto-start is enabled.",
        "This mount allows changes to HOST files.",
        "When listed: These tools run on the HOST without per-call host approval.",
        "Removes this override; inherited settings may take effect.",
        "Higher-priority settings still apply.",
        "Copies this entry from Project into Global; the higher scope still wins.",
        "Session settings clear on Pi /reload.",
        "DNS/IP matching is not per-request URL/TLS-hostname authorization.",
        "DNS exfiltration remains possible.",
      ].map((text): SettingsDiffLine => ({ kind: "warning", text })),
      { kind: "removed", label: "Credential", text: "<redacted>" },
      { kind: "added", label: "Credential", text: "<redacted> (changed)" },
      ...Array.from({ length: 200 }, (_, n): SettingsDiffLine => n % 2
        ? { kind: "warning", text: `warning-${n}: relevant consequence` }
        : { kind: "added", label: "Hosts", text: `host-${n}.example ${"long value ".repeat(20)}` }),
    ];
    let calls = 0;
    const ctx = context(mode, async (title, choices, options) => {
      calls++;
      assert.equal(title, ["Allow configuration change?", "", ...formatSettingsDiff(long.filter((line) => line.kind !== "warning"), mode === "tui" ? theme : undefined)].join("\n"));
      assert.deepEqual(choices, ["No", "Yes"]); assert.ok(options.signal);
      assert.doesNotMatch(title, /warning-\d+: relevant consequence/);
      assert.match(title, /host-198\.example/);
      assert.match(title, /! Keep this nonwarning context/);
      for (const warning of long.filter((line) => line.kind === "warning")) assert.ok(!title.includes(warning.text));
      assert.doesNotMatch(title, /Read to end|PgUp|PgDn|32×10/);
      if (mode === "rpc") assert.doesNotMatch(title, /\x1b|<warning>|<muted>/);
      else {
        assert.ok(title.includes("<muted>Scope: </muted><warning>Global</warning>"));
        assert.ok(title.includes("<muted>Secret TOKEN</muted>"));
        assert.ok(title.includes("<toolDiffRemoved><redacted></toolDiffRemoved>"));
        assert.ok(title.includes("<toolDiffAdded><redacted> (changed)</toolDiffAdded>"));
        assert.doesNotMatch(title, /<warning>!/);
      }
      return "Yes";
    });
    assert.equal(await approveSettings(ctx, long, new AbortController().signal), true);
    assert.equal(calls, 1);
  });
}

for (const [scope, label] of [["session", "Session"], ["project", "Project"], ["global", "Global"]]) {
  test(`settings approval: standalone Scope: ${label} in native TUI and RPC question`, async () => {
    const lines = settingsDiff({ scope, focus: [{ path: "cpus", deltas: [{ field: "cpus", before: 2, after: 4 }], inheritedDeltas: [], reconciledDeltas: [], hostBypass: [], changed: true, effectiveChanged: true }], collections: [], shadowed: [] });
    for (const mode of ["tui", "rpc"]) {
      const ctx = context(mode, async (title) => {
        assert.ok(title.split("\n").includes(mode === "tui" ? `<muted>Scope: </muted><warning>${label}</warning>` : `Scope: ${label}`));
        assert.match(title, /CPUs/); return "No";
      });
      assert.equal(await approveSettings(ctx, lines, new AbortController().signal), false);
    }
  });
}
