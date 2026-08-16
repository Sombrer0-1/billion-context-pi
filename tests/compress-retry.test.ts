import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { createRuntime, MAX_COMPRESS_ATTEMPTS } from "../src/runtime.js";

// Failure-triggered compress retry (session 01a00a38 post-mortem): the model's
// ONLY compress call in a 3-hour session was rejected by pi's typebox
// validation ("content.0: must be object" — vLLM non-strict tools stringified
// the array). The turn's nudge budget was consumed, the kernel's growth-gated
// nudge stayed silent for 95 minutes, and the session never compressed.
//
// Two fixes under test:
//  1. compress-tool accepts a JSON-encoded string for content (root cause).
//  2. A failed compress toolResult triggers an IMMEDIATE retry nudge quoting
//     the error, capped at MAX_COMPRESS_ATTEMPTS per user turn; success resets.

function captureApi() {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const api = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
  };
  return { api, handlers };
}

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

function toolResultMsg(id: string, toolCallId: string, text: string, isError: boolean) {
  return {
    type: "message", id, parentId: null, timestamp: "",
    message: {
      role: "toolResult", toolCallId, toolName: "compress",
      content: [{ type: "text", text }], isError, timestamp: Date.now(),
    },
  };
}

const VALIDATION_ERR = 'Validation failed for tool "compress":\n  - content.0: must be object\n\nReceived arguments:\n{"content":"[{\\"topic\\":\\"x\\"}]"}';

function fakeCtx(getEntries: () => any[], stateFile: string) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => null,
    sessionManager: {
      buildContextEntries: () => getEntries(),
      getSessionId: () => "retry-test-session",
      getSessionFile: () => stateFile,
    },
  };
}

const fire = (handlers: Map<string, ((e: any, ctx: any) => any)[]>, ctx: any) =>
  handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

const retryMsgs = (r: any) =>
  (r?.messages ?? []).filter((m: any) => m.role === "user" && /compress call FAILED/.test(JSON.stringify(m.content)));

const retryText = (r: any) => {
  const msgs = retryMsgs(r);
  return msgs.length > 0 ? (msgs[msgs.length - 1].content[0].text as string) : "";
};

const ZH = "中".repeat(6000); // big enough to stay compressible, small enough to avoid nudges

// ─── unit: runtime counter ──────────────────────────────────────────────────

test("noteCompressOutcomes: counts, caps, resets on success, resets per turn", () => {
  const rt = createRuntime({});
  const outcomes = (n: number) => Array.from({ length: n }, (_, i) => ({ toolCallId: `t${i}`, isError: true }));

  let r = rt.noteCompressOutcomes("u1", outcomes(1));
  assert.equal(r.count, 1);
  assert.equal(r.retryFor, "t0");
  assert.equal(r.cappedNow, false);

  // idempotent re-fire (same toolCallIds)
  r = rt.noteCompressOutcomes("u1", outcomes(1));
  assert.equal(r.count, 1, "no double count on re-fire");
  assert.equal(r.retryFor, "t0", "retry prompt persists while newest outcome is a failure");
  assert.equal(r.cappedNow, false);

  // second failure
  r = rt.noteCompressOutcomes("u1", [{ toolCallId: "t0", isError: true }, { toolCallId: "t1", isError: true }]);
  assert.equal(r.count, 2);
  assert.equal(r.retryFor, "t1");

  // third failure → cap: no more retry prompt, cappedNow fires once
  r = rt.noteCompressOutcomes("u1", outcomes(3));
  assert.equal(r.count, 3);
  assert.equal(r.retryFor, null, "capped: no retry prompt after MAX attempts");
  assert.equal(r.cappedNow, true);
  r = rt.noteCompressOutcomes("u1", outcomes(3));
  assert.equal(r.cappedNow, false, "cap notification is one-shot");
  assert.equal(MAX_COMPRESS_ATTEMPTS, 3);

  // success resets the counter
  r = rt.noteCompressOutcomes("u1", [...outcomes(3), { toolCallId: "t9", isError: false }]);
  assert.equal(r.count, 0);
  assert.equal(r.retryFor, null);

  // a NEW failure after success prompts again (fresh attempt cycle)
  r = rt.noteCompressOutcomes("u1", [...outcomes(3), { toolCallId: "t9", isError: false }, { toolCallId: "t10", isError: true }]);
  assert.equal(r.count, 1);
  assert.equal(r.retryFor, "t10");

  // new user turn → fresh counter even without a success in between
  r = rt.noteCompressOutcomes("u1", outcomes(3)); // back at cap
  r = rt.noteCompressOutcomes("u2", [{ toolCallId: "x0", isError: true }]);
  assert.equal(r.count, 1);
  assert.equal(r.retryFor, "x0");
});

// ─── unit: normalizeRanges via the tool ─────────────────────────────────────

test("compress tool accepts JSON-encoded string content (non-strict-tool providers)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-retry-str.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  // m00001 must clear BOTH protected-zone rules: outside the last-5 messages,
  // and the preserve-recent token walk (~5K tokens from the end) must exhaust
  // inside the big tail before reaching e1.
  const entries = Array.from({ length: 6 }, (_, i) => userMsg(`e${i + 1}`, ZH));
  const ctx = fakeCtx(() => entries, stateFile);
  await fire(handlers, ctx); // assigns refs

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const out = await compressTool.execute(
    "tc1",
    // exactly what session 01a00a38's model sent: a JSON-encoded array string
    { content: JSON.stringify([{ startId: "m00001", endId: "m00001", summary: "compressed from string form" }]) },
    undefined, undefined, ctx,
  );
  const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  assert.ok(!/Invalid content/.test(text), `string form must parse: ${text}`);
  assert.ok(/Compressed|compressed/.test(text), `expected success output: ${text}`);
  await rm(`${stateFile}.acp.json`, { force: true });
});

test("compress tool reports a helpful error for garbage string content", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-retry-str2.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", "hello world"), userMsg("e2", ZH)];
  const ctx = fakeCtx(() => entries, stateFile);
  await fire(handlers, ctx);

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const out = await compressTool.execute("tc1", { content: "not json {" }, undefined, undefined, ctx);
  const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  assert.ok(/Invalid content: not valid JSON/.test(text), `expected JSON error: ${text}`);
  assert.ok(/ARRAY/.test(text), "error must tell the model to pass an array");
  await rm(`${stateFile}.acp.json`, { force: true });
});

// ─── integration: retry nudge in the context transform ─────────────────────

test("failed compress toolResult triggers an immediate retry nudge that quotes the error", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-retry-it1.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });

  let entries: any[] = [userMsg("e1", ZH)];
  const ctx = fakeCtx(() => entries, stateFile);
  const r0 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r0).length, 0, "no failures yet → no retry nudge");

  entries = [...entries, toolResultMsg("e2", "call_1", VALIDATION_ERR, true)];
  const r1 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r1).length, 1, "failure → immediate retry nudge");
  const t1 = retryText(r1);
  assert.match(t1, /attempt 1 of 3/);
  assert.match(t1, /must be object/, "quotes the validation error");
  assert.ok(!t1.includes("Received arguments"), "does not quote the huge args dump");
  assert.ok(!t1.includes("Received arguments"), "does not quote the huge args dump");
  assert.ok(!/LAST retry/.test(t1), "attempt 1 must not claim last retry");
  assert.match(t1, /content must be an ARRAY/);

  // re-fire (streaming/tool loop fires context repeatedly): prompt persists
  const r2 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r2).length, 1, "retry nudge re-injects on every fire while unaddressed");
  assert.match(retryText(r2), /attempt 1 of 3/);

  // second failure → attempt 2, flagged as last retry
  entries = [...entries, toolResultMsg("e3", "call_2", VALIDATION_ERR, true)];
  const r3 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r3).length, 1);
  assert.match(retryText(r3), /attempt 2 of 3/);
  assert.match(retryText(r3), /LAST retry/);

  // third failure → capped: no more retry prompts
  entries = [...entries, toolResultMsg("e4", "call_3", VALIDATION_ERR, true)];
  const r4 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r4).length, 0, "cap reached → no retry nudge");
  await rm(`${stateFile}.acp.json`, { force: true });
});

test("success resets the retry counter; new turn gets a fresh budget", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-retry-it2.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });

  let entries: any[] = [userMsg("e1", ZH)];
  const ctx = fakeCtx(() => entries, stateFile);
  await fire(handlers, ctx);

  // fail once, then succeed
  entries = [...entries, toolResultMsg("e2", "call_1", VALIDATION_ERR, true)];
  const r1 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r1).length, 1);

  entries = [...entries, toolResultMsg("e3", "call_2", "Compressed 1 range (…)", false)];
  const r2 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r2).length, 0, "success → no retry nudge");

  // fresh failure after success → new attempt cycle (attempt 1, not 2)
  entries = [...entries, toolResultMsg("e4", "call_3", VALIDATION_ERR, true)];
  const r3 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r3).length, 1);
  assert.match(retryText(r3), /attempt 1 of 3/);

  // new user turn → fresh budget even mid-cycle
  entries = [...entries, userMsg("e5", "next question"), toolResultMsg("e6", "call_4", VALIDATION_ERR, true)];
  const r4 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r4).length, 1);
  assert.match(retryText(r4), /attempt 1 of 3/);
  await rm(`${stateFile}.acp.json`, { force: true });
});
