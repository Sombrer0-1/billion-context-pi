import { test } from "node:test";
import { createInitialState, createCore } from "acp-kernel";

test("dbg why nudge idle at 20k/20k", () => {
  const core = createCore();
  const msgs: any[] = [];
  for (let i = 0; i < 12; i++) {
    msgs.push({ id: `h_${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `historical detail ${i}. ${"x".repeat(2000)}` });
  }
  const t = core.processTurn({ messages: msgs, state: createInitialState(), config: { modelContextLimit: 20_000, nudge: { maxContextLimitPct: 0.75, minContextLimitPct: 0.45, growthFloor: 50_000, growthCap: 50_000, minGrowthFloor: 20_000, minGrowthRatio: 0.45, growthRatio: 0.05 } } as any, tokenCount: 20_000 });
  console.log("shouldInject:", t.nudge?.shouldInject, "reason:", t.nudge?.reason);
  console.log("breakdown:", JSON.stringify(t.nudge?.breakdown));
  console.log("recommended:", t.nudge?.recommendedRanges?.length);
});
