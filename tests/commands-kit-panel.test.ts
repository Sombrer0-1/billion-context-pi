import { test } from "node:test";
import assert from "node:assert/strict";
import type { AcpRuntime } from "../src/runtime.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// tsup defines CURRENT_VERSION at build time; under the node test runner it
// is bare, so stub it before the module graph reads it.
(globalThis as Record<string, unknown>).CURRENT_VERSION ??= "0.0.0-test";
const { makeCommands } = await import("../src/commands.js");

function fakeRuntime(): AcpRuntime {
  return {
    configFor: () => ({ modelContextLimit: 1_000_000 }),
    stateFor: async () => ({
      state: { blocks: [], stats: { tokensCompressed: 0 }, messageRefs: { byRaw: {}, byRef: {} } },
      coreMessages: [],
    }),
    // Stub processTurn: we only exercise the panel's rendering of the
    // breakdown, not the kernel's classification logic.
    core: {
      processTurn: () => ({
        state: { blocks: [], stats: { tokensCompressed: 0 }, messageRefs: { byRaw: {}, byRef: {} } },
        nudge: {
          contextUsage: 0.43,
          reason: "idle — max compressible 8106 < threshold 50000",
          contextBreakdown: { tool: 20_000, system: 0, text: 4_000, code: 0, summaries: 0, growth: 6_100 },
        },
      }),
    },
  } as unknown as AcpRuntime;
}

test("/acp panel (kit-rendered) separates session accounting from sent view", async () => {
  const notified: string[] = [];
  const ctx = {
    ui: { notify: (t: string) => notified.push(t) },
    getContextUsage: () => ({ tokens: 430_000 }),
    model: { contextWindow: 1_000_000 },
    sessionManager: { getSessionId: () => "s", getSessionFile: () => "/tmp/s.json" },
  } as unknown as ExtensionCommandContext;

  const acp = makeCommands(fakeRuntime()).find((c) => c.name === "acp")!;
  await acp.options.handler!("", ctx);

  const text = notified[0] ?? "";
  assert.match(text, /Context \(session accounting\): 43% \(430k \/ 1\.0M\)/, text);
  assert.match(text, /Sent to LLM \(after compression\): 24k/, text);
  assert.match(text, /Session-only \(compressed originals \+ host overhead\): 406k/, text);
  assert.match(text, /Token Breakdown \(sent view\):/, text);
  assert.doesNotMatch(text, /Framework/, "fake Framework bucket must be gone");
  const toolLine = text.split("\n").find((l) => l.trim().startsWith("Tool"))!;
  assert.match(toolLine, / 83%/, `bar percentages must use the sent view: ${toolLine}`);
});
