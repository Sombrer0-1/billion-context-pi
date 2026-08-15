import { test } from "bun:test";
import assert from "node:assert/strict";
import { makeCommands } from "../src/commands.js";
import type { AcpRuntime } from "../src/runtime.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

(globalThis as Record<string, unknown>).CURRENT_VERSION ??= "0.0.0-test";

function runtime(): AcpRuntime {
  return {
    configFor: () => ({ modelContextLimit: 1_000_000 }),
    stateFor: async () => ({ state: { blocks: [], stats: { tokensCompressed: 0 }, messageRefs: { byRaw: {}, byRef: {} } }, coreMessages: [] }),
    core: {
      processTurn: () => ({
        messages: [],
        state: { blocks: [], stats: { tokensCompressed: 0 }, messageRefs: { byRaw: {}, byRef: {} } },
        nudge: {
          shouldInject: false,
          reason: "idle",
          contextUsage: 0.43,
          compressibleRanges: [],
          contextBreakdown: { system: 0, tool: 20_000, text: 4_000, code: 0, summaries: 0, total: 24_000, growth: 6_100 },
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
    getSystemPrompt: () => undefined,
  } as unknown as ExtensionCommandContext;

  const acp = makeCommands(runtime()).find((c) => c.name === "acp")!;
  await acp.options.handler!("", ctx);

  const text = notified[0] ?? "";
  assert.match(text, /Context \(session accounting\): 43% \(430k \/ 1\.0M\)/, text);
  assert.match(text, /Sent to LLM \(after compression\): 24k/);
  assert.match(text, /Session-only \(compressed originals \+ host overhead\): 406k/);
  assert.doesNotMatch(text, /Framework/, "fake Framework bucket must be gone (kit panel)");
});
