import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChildArgs } from "../src/delegate-tool.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Minimal ctx mock — buildChildArgs only reads ctx.model. */
function mockCtx(): ExtensionContext {
  return { model: { provider: "test", id: "test-model" } } as unknown as ExtensionContext;
}

test("buildChildArgs includes --tools whitelist for read-only roles", async () => {
  const { cliArgs } = await buildChildArgs(
    { agent: "reviewer", task: "review code" },
    "You are a reviewer.",
    mockCtx(),
  );
  const toolsIdx = cliArgs.indexOf("--tools");
  assert.ok(toolsIdx >= 0, "--tools flag present for reviewer");
  assert.equal(cliArgs[toolsIdx + 1], "read,bash", "reviewer gets read,bash whitelist");
});

test("buildChildArgs includes --tools whitelist for worker role", async () => {
  const { cliArgs } = await buildChildArgs(
    { agent: "worker", task: "fix bug" },
    "You are a worker.",
    mockCtx(),
  );
  const toolsIdx = cliArgs.indexOf("--tools");
  assert.ok(toolsIdx >= 0, "--tools flag present for worker");
  assert.equal(cliArgs[toolsIdx + 1], "read,edit,write,bash");
});

test("buildChildArgs places --tools before --provider/--model", async () => {
  const { cliArgs } = await buildChildArgs(
    { agent: "reviewer", task: "test", model: "openai/gpt-5" },
    "prompt",
    mockCtx(),
  );
  const toolsIdx = cliArgs.indexOf("--tools");
  const providerIdx = cliArgs.indexOf("--provider");
  assert.ok(toolsIdx >= 0 && providerIdx >= 0);
  assert.ok(toolsIdx < providerIdx, "--tools comes before --provider");
});

test("buildChildArgs omits --tools for unknown agent name", async () => {
  const { cliArgs } = await buildChildArgs(
    { agent: "nonexistent-role", task: "test" },
    "prompt",
    mockCtx(),
  );
  const toolsIdx = cliArgs.indexOf("--tools");
  assert.equal(toolsIdx, -1, "--tools not added for unknown agent");
});

test("buildChildArgs inherits model from ctx when model not specified", async () => {
  const { cliArgs } = await buildChildArgs(
    { agent: "reviewer", task: "test" },
    "prompt",
    mockCtx(),
  );
  const providerIdx = cliArgs.indexOf("--provider");
  const modelIdx = cliArgs.indexOf("--model");
  assert.ok(providerIdx >= 0, "--provider present from ctx.model");
  assert.equal(cliArgs[providerIdx + 1], "test");
  assert.ok(modelIdx >= 0, "--model present from ctx.model");
  assert.equal(cliArgs[modelIdx + 1], "test-model");
});
