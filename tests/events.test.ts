import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEventLine, activityLines, extractContentText, newPortion, ThinkingCollector } from "../src/delegate-events.js";

test("parses text_delta and text_end from message_update", () => {
  const delta = parseEventLine('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello "}}');
  assert.deepEqual(delta, { kind: "reply-delta", delta: "Hello " });

  const end = parseEventLine('{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello world"}}');
  assert.deepEqual(end, { kind: "reply-complete", content: "Hello world" });
});

test("parses thinking_delta wrapped in message_update", () => {
  const ev = parseEventLine('{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":" wan"}}');
  assert.deepEqual(ev, { kind: "thinking-delta", delta: " wan" });
});

test("parses tool_execution_start with bash command args", () => {
  const ev = parseEventLine('{"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"echo hi"}}');
  assert.deepEqual(ev, { kind: "tool-start", toolName: "bash", argsText: "echo hi" });
});

test("parses tool_execution_update partialResult text", () => {
  const ev = parseEventLine(
    '{"type":"tool_execution_update","toolCallId":"call_1","toolName":"bash","args":{"command":"echo hi"},"partialResult":{"content":[{"type":"text","text":"hi\\n"}],"details":{}}}',
  );
  assert.deepEqual(ev, { kind: "tool-update", toolCallId: "call_1", text: "hi\n" });
});

test("parses tool_execution_end with isError", () => {
  const ok = parseEventLine('{"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":{"content":[{"type":"text","text":"hi\\n"}]},"isError":false}');
  assert.deepEqual(ok, { kind: "tool-end", toolName: "bash", isError: false });

  const err = parseEventLine('{"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":{},"isError":true}');
  assert.deepEqual(err, { kind: "tool-end", toolName: "bash", isError: true });
});

test("ignores non-JSON lines and irrelevant events", () => {
  assert.equal(parseEventLine("not json"), null);
  assert.equal(parseEventLine('{"type":"turn_start","sessionId":"s"}'), null);
  assert.equal(parseEventLine('{"type":"message_update","assistantMessageEvent":{"type":"text_start"}}'), null);
});

test("extractContentText joins text blocks and tolerates non-array content", () => {
  assert.equal(extractContentText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "ab");
  assert.equal(extractContentText({ content: [] }), "");
  assert.equal(extractContentText({}), "");
  assert.equal(extractContentText(null), "");
});

test("activityLines formats tool activity and gates thinking", () => {
  assert.deepEqual(
    activityLines({ kind: "tool-start", toolName: "bash", argsText: "echo hi" }, { showThinking: false }),
    ["[tool] bash echo hi\n"],
  );
  assert.deepEqual(
    activityLines({ kind: "tool-update", toolCallId: "c", text: "hi\n" }, { showThinking: false }),
    ["hi\n"],
  );
  assert.deepEqual(
    activityLines({ kind: "tool-end", toolName: "bash", isError: true }, { showThinking: false }),
    ["[done] bash (error)\n"],
  );
  assert.deepEqual(
    activityLines({ kind: "thinking-delta", delta: " wan" }, { showThinking: false }),
    [],
  );
  assert.deepEqual(
    activityLines({ kind: "thinking-delta", delta: " wan" }, { showThinking: true }),
    ["[thinking]  wan\n"],
  );
});

test("newPortion returns only the appended part of a snapshot", () => {
  assert.equal(newPortion("hello", ""), "hello");
  assert.equal(newPortion("hello world", "hello"), " world");
  assert.equal(newPortion("hello", "hello"), "");
  assert.equal(newPortion("rewritten", "hello"), "rewritten");
});

test("parses thinking_end from message_update", () => {
  const ev = parseEventLine('{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","contentIndex":0}}');
  assert.deepEqual(ev, { kind: "thinking-end" });
});

test("ThinkingCollector merges deltas into one line per segment", () => {
  const on = new ThinkingCollector(true);
  on.push("The user ");
  on.push("wants me ");
  assert.equal(on.flush(), "[thinking] The user wants me\n");
  assert.equal(on.flush(), "", "second flush is empty");

  const off = new ThinkingCollector(false);
  off.push("hidden ");
  assert.equal(off.flush(), "", "disabled collector emits nothing");
});

test("parses auto_retry_start and auto_retry_end", () => {
  const start = parseEventLine('{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"529 {\\"error\\":{\\"type\\":\\"overloaded_error\\"}}"}');
  assert.deepEqual(start, {
    kind: "retry-start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2000,
    errorMessage: '529 {"error":{"type":"overloaded_error"}}',
  });

  const end = parseEventLine('{"type":"auto_retry_end","success":true,"attempt":2}');
  assert.deepEqual(end, { kind: "retry-end", success: true, attempt: 2 });
});

test("activityLines formats retry events", () => {
  assert.deepEqual(
    activityLines({ kind: "retry-start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529 overloaded" }, { showThinking: false }),
    ["[retry] attempt 1/3, backoff 2000ms — 529 overloaded\n"],
  );
  assert.deepEqual(
    activityLines({ kind: "retry-start", attempt: 2, maxAttempts: 3, delayMs: 5000, errorMessage: "" }, { showThinking: false }),
    ["[retry] attempt 2/3, backoff 5000ms\n"],
  );
  assert.deepEqual(
    activityLines({ kind: "retry-end", success: true, attempt: 2 }, { showThinking: false }),
    ["[retry] attempt 2 succeeded\n"],
  );
  assert.deepEqual(
    activityLines({ kind: "retry-end", success: false, attempt: 3 }, { showThinking: false }),
    ["[retry] attempt 3 failed\n"],
  );
});
