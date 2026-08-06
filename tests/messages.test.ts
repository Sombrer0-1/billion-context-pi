import { test } from "node:test";
import assert from "node:assert/strict";
import { entriesToCoreMessages, coreOutToAgentMessages } from "../src/messages.js";
import type { CoreMessage } from "acp-kernel";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

const LT = "\x3c";
const GT = "\x3e";
function acpRef(ref: string, tokens = "2", type = "text"): string {
  return LT + 'acp tokens="' + tokens + '" type="' + type + '"' + GT + ref + LT + "/acp" + GT;
}

function msgEntry(id: string, message: object): SessionMessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: message as SessionMessageEntry["message"],
  };
}

function user(text: string): object {
  return { role: "user", content: text, timestamp: Date.now() };
}
function userBlocks(text: string): object {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}
function assistantToolCall(name: string): object {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name, arguments: {} }],
    api: "anthropic",
    provider: "anthropic",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}
function assistantParallelToolCalls(calls: { id: string; name: string; args?: unknown }[]): object {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "Running multiple tools" },
      ...calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args ?? {} })),
    ],
    api: "anthropic",
    provider: "anthropic",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}
function toolResult(callId: string, name: string, text: string): object {
  return { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: Date.now() };
}

test("entriesToCoreMessages projects user/assistant/toolResult roles and extracts text", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("hello world")),
    msgEntry("b", userBlocks("block text")),
    msgEntry("c", assistantToolCall("read")),
    msgEntry("d", toolResult("tc1", "read", "file contents")),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core[0]!.role, "user");
  assert.equal(core[0]!.text, "hello world");
  assert.equal(core[1]!.text, "block text");
  assert.equal(core[2]!.role, "assistant");
  assert.equal(core[2]!.contentType, "tool-call");
  assert.equal(core[2]!.toolName, "read");
  assert.equal(core[3]!.role, "tool");
  assert.equal(core[3]!.contentType, "tool-result");
  assert.equal(core[3]!.text, "file contents");
});

test("entriesToCoreMessages skips non-message entries (compaction, model_change)", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("alpha")),
    { type: "compaction", id: "x", parentId: null, timestamp: "", summary: "s", firstKeptEntryId: "a", tokensBefore: 0 } as SessionEntry,
    { type: "model_change", id: "y", parentId: null, timestamp: "", provider: "p", modelId: "m" } as SessionEntry,
    msgEntry("b", user("beta")),
  ];
  const core = entriesToCoreMessages(entries);
  assert.deepEqual(core.map((m) => m.id), ["a", "b"]);
});

test("coreOutToAgentMessages patches the ref tag onto original messages", () => {
  const tag = acpRef("m00001") + "\n";
  const original = msgEntry("a", user("hello")).message;
  const originalById = new Map([["a", original]]);
  const coreOut: CoreMessage[] = [{ id: "a", role: "user", contentType: "text", text: tag + "hello" }];

  const out = coreOutToAgentMessages(coreOut, originalById);
  const content = (out[0] as { content: Array<{ type: string; text: string }> }).content;
  assert.equal(content[0]!.type, "text");
  assert.ok(content[0]!.text.includes("hello"), "content includes original text");
  assert.ok(content[0]!.text.includes("m00001"), "content includes ref id");
  assert.equal(content.length, 1, "tag embedded in single text block, not separate");
});

test("coreOutToAgentMessages returns original unchanged when no ref tag is present", () => {
  const original = msgEntry("a", user("hello")).message;
  const originalById = new Map([["a", original]]);
  const coreOut: CoreMessage[] = [{ id: "a", role: "user", contentType: "text", text: "hello" }];

  const out = coreOutToAgentMessages(coreOut, originalById);
  assert.equal(out[0], original, "un-tagged message returned by reference, untouched");
});

test("coreOutToAgentMessages filters out synthetic summary messages (compress-as-anchor)", () => {
  const originalById = new Map<string, SessionMessageEntry["message"]>();
  const coreOut: CoreMessage[] = [
    { id: "acp_summary_b0", role: "system", contentType: "text", text: "[Compressed conversation section]\nbody" },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  assert.equal(out.length, 0, "synthetic summary messages should be filtered out");
});

test("coreOutToAgentMessages reconstructs parallel tool-call assistant message from split core messages", () => {
  const assistantMsg = assistantParallelToolCalls([
    { id: "call_a", name: "read" },
    { id: "call_b", name: "write" },
    { id: "call_c", name: "list" },
  ]);
  const originalById = new Map([["entry1", assistantMsg as SessionMessageEntry["message"]]]);

  const tag = acpRef("m00003");
  const coreOut: CoreMessage[] = [
    { id: "entry1#call_a", role: "assistant", contentType: "tool-call", toolName: "read", toolCallId: "call_a", text: tag + "\nRunning multiple tools\n{}" },
    { id: "entry1#call_b", role: "assistant", contentType: "tool-call", toolName: "write", toolCallId: "call_b", text: tag + "\n{}" },
    { id: "entry1#call_c", role: "assistant", contentType: "tool-call", toolName: "list", toolCallId: "call_c", text: tag + "\n{}" },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  assert.equal(out.length, 1, "3 split tool-calls merge into 1 assistant message");

  const content = (out[0] as { content: Array<{ type: string; id?: string; text?: string }> }).content;
  const toolCalls = content.filter((b) => b.type === "toolCall");
  assert.equal(toolCalls.length, 3, "all 3 toolCall blocks preserved");
  assert.deepEqual(toolCalls.map((b) => b.id), ["call_a", "call_b", "call_c"]);

  const textBlocks = content.filter((b) => b.type === "text");
  assert.ok(textBlocks.length >= 1, "text block preserved");
  assert.ok(!textBlocks[0]!.text!.includes("m00003"), "assistant message: no tag injected (skip applied)");
});

test("coreOutToAgentMessages drops pruned tool-call blocks when only some survive", () => {
  const assistantMsg = assistantParallelToolCalls([
    { id: "call_a", name: "read" },
    { id: "call_b", name: "write" },
    { id: "call_c", name: "list" },
  ]);
  const originalById = new Map([["entry1", assistantMsg as SessionMessageEntry["message"]]]);

  const coreOut: CoreMessage[] = [
    { id: "entry1#call_a", role: "assistant", contentType: "tool-call", toolName: "read", toolCallId: "call_a", text: "[m00003] {}" },
    { id: "entry1#call_c", role: "assistant", contentType: "tool-call", toolName: "list", toolCallId: "call_c", text: "[m00003] {}" },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  assert.equal(out.length, 1);

  const content = (out[0] as { content: Array<{ type: string; id?: string }> }).content;
  const toolCalls = content.filter((b) => b.type === "toolCall");
  assert.equal(toolCalls.length, 2, "only 2 surviving tool-call blocks");
  assert.deepEqual(toolCalls.map((b) => b.id), ["call_a", "call_c"]);
});
