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

function assistantThinkingOnly(thinking: string): object {
  return { role: "assistant", content: [{ type: "thinking", thinking }], timestamp: Date.now() };
}
function assistantThinkingAndText(thinking: string, text: string): object {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking }, { type: "text", text }],
    timestamp: Date.now(),
  };
}

test("entriesToCoreMessages drops thinking-only assistant turns (no empty assistant text → no provider 400)", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("before")),
    msgEntry("b", assistantThinkingOnly("internal reasoning, no output") as object),
    msgEntry("c", user("after")),
  ];
  const core = entriesToCoreMessages(entries);

  assert.deepEqual(core.map((m) => m.id), ["a", "c"], "thinking-only assistant dropped, not emitted as empty text");
  assert.ok(
    !core.some((m) => m.role === "assistant" && (!m.text || !m.text.trim())),
    "no empty-text assistant message in output",
  );
});

test("entriesToCoreMessages keeps assistant turn that has thinking AND text (text extracted, thinking ignored)", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", assistantThinkingAndText("private reasoning", "visible answer") as object),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core.length, 1);
  assert.equal(core[0]!.role, "assistant");
  assert.equal(core[0]!.contentType, "text");
  assert.equal(core[0]!.text, "visible answer", "text kept, thinking block not inlined");
});

test("entriesToCoreMessages drops assistant turn whose text is whitespace-only", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("before")),
    msgEntry("b", { role: "assistant", content: [{ type: "text", text: "   \n  " }], timestamp: Date.now() } as object),
    msgEntry("c", user("after")),
  ];
  const core = entriesToCoreMessages(entries);
  assert.deepEqual(core.map((m) => m.id), ["a", "c"], "whitespace-only assistant dropped");
});

function customEntry(id: string, customType: string, content: string | unknown[]): SessionEntry {
  return {
    type: "custom_message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType,
    content,
  } as SessionEntry;
}

test("entriesToCoreMessages projects custom_message as user message (string content)", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("hello")),
    customEntry("b", "subagent_result", "Sub-agent test completed (6s)."),
    msgEntry("c", user("ok")),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core.length, 3, "all 3 entries projected");
  assert.equal(core[1]!.id, "b");
  assert.equal(core[1]!.role, "user", "custom_message projected as user");
  assert.equal(core[1]!.contentType, "text");
  assert.equal(core[1]!.text, "Sub-agent test completed (6s).");
});

test("entriesToCoreMessages projects custom_message with array content", () => {
  const entries: SessionEntry[] = [
    customEntry("a", "subagent_result", [{ type: "text", text: "Array content here" }]),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core.length, 1);
  assert.equal(core[0]!.role, "user");
  assert.equal(core[0]!.text, "Array content here");
});

test("entriesToCoreMessages drops custom_message with empty content", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("before")),
    customEntry("b", "subagent_result", ""),
    msgEntry("c", user("after")),
  ];
  const core = entriesToCoreMessages(entries);

  assert.deepEqual(core.map((m) => m.id), ["a", "c"], "empty custom_message skipped");
});

test("entriesToCoreMessages extracts only text blocks from array content", () => {
  const entries: SessionEntry[] = [
    customEntry("a", "subagent_result", [
      { type: "text", text: "visible text" },
      { type: "image", url: "https://example.com/img.png" },
      { type: "text", text: "more text" },
    ]),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core.length, 1, "entry projected");
  assert.equal(core[0]!.text, "visible text\nmore text", "only text blocks extracted, joined with newline");
});

test("entriesToCoreMessages drops custom_message with non-text-only array content", () => {
  const entries: SessionEntry[] = [
    customEntry("a", "subagent_result", [{ type: "image", url: "https://example.com/img.png" }]),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core.length, 0, "non-text array content yields empty text → skipped");
});

test("custom_message round-trip: entriesToCoreMessages → collectOriginals → coreOutToAgentMessages preserves user role", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("hello")),
    customEntry("b", "subagent_result", "Sub-agent test completed (6s)."),
    msgEntry("c", user("ok")),
  ];

  // Step 1: entries → CoreMessage[]
  const coreMessages = entriesToCoreMessages(entries);

  // Step 2: simulate collectOriginals (mirrors src/index.ts collectOriginals logic)
  // For message entries, the original is entry.message.
  // For custom_message entries, the original is projected as a user AgentMessage
  // (NOT role:"custom", which Pi would silently drop).
  const originalById = new Map<string, SessionMessageEntry["message"]>();
  for (const entry of entries) {
    if (entry.type === "message") {
      originalById.set(entry.id, entry.message);
    } else if (entry.type === "custom_message") {
      const content = typeof entry.content === "string"
        ? [{ type: "text" as const, text: entry.content }]
        : entry.content;
      originalById.set(entry.id, { role: "user", content } as SessionMessageEntry["message"]);
    }
  }

  // Step 3: coreOutToAgentMessages restores from originalById
  const out = coreOutToAgentMessages(coreMessages, originalById);

  // The custom_message (id "b") should be restored as role:"user", not role:"custom"
  const customOut = out.find((m) => (m as { role?: string }).role === "user" &&
    Array.isArray((m as { content?: unknown[] }).content) &&
    ((m as { content: Array<{ type?: string; text?: string }> }).content.some((b) => b.text?.includes("Sub-agent test"))));
  assert.ok(customOut, "custom_message restored as a user message");
  assert.equal((customOut as { role: string }).role, "user", "role is user, not custom");

  // Ensure no role:"custom" in output (that would be silently dropped by Pi)
  const customs = out.filter((m) => (m as { role?: string }).role === "custom");
  assert.equal(customs.length, 0, "no role:custom messages in output");
});

test("entriesToCoreMessages still skips compaction and model_change", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("alpha")),
    { type: "compaction", id: "x", parentId: null, timestamp: "", summary: "s", firstKeptEntryId: "a", tokensBefore: 0 } as SessionEntry,
    { type: "model_change", id: "y", parentId: null, timestamp: "", provider: "p", modelId: "m" } as SessionEntry,
    msgEntry("b", user("beta")),
  ];
  const core = entriesToCoreMessages(entries);
  assert.deepEqual(core.map((m) => m.id), ["a", "b"]);
});

test("entriesToCoreMessages preserves omp execution roles (bashExecution/pythonExecution) as user text instead of dropping them", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", { role: "user", content: "run ls", timestamp: Date.now() }),
    msgEntry("b", { role: "bashExecution", command: "ls -la", output: [{ type: "text", text: "file1\nfile2" }], exitCode: 0, timestamp: Date.now() } as object),
    msgEntry("c", { role: "pythonExecution", command: "print('hi')", output: "hi", exitCode: 0, timestamp: Date.now() } as object),
    msgEntry("d", { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: Date.now() } as object),
  ];
  const core = entriesToCoreMessages(entries);
  assert.deepEqual(core.map((m) => m.id), ["a", "b", "c", "d"], "no messages dropped");
  const b = core[1]!;
  assert.equal(b.role, "user");
  assert.ok(b.text!.includes("$ ls -la"), "command rendered as $ command");
  assert.ok(b.text!.includes("file1"), "output text preserved");
  const c = core[2]!;
  assert.equal(c.role, "user");
  assert.ok(c.text!.includes("print('hi')"));
  assert.ok(c.text!.includes("hi"));
});

test("entriesToCoreMessages prefers content over fallback fields when an omp role carries both", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", { role: "bashExecution", content: [{ type: "text", text: "primary text" }], command: "should-not-appear", output: "neither", timestamp: Date.now() } as object),
  ];
  const core = entriesToCoreMessages(entries);
  assert.equal(core.length, 1);
  assert.equal(core[0]!.role, "user");
  assert.equal(core[0]!.text, "primary text");
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
