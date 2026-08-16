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
// Fixes under test (incl. review findings on the first cut, 7ddd2c6):
//  1. compress-tool accepts a JSON-encoded string for content (root cause).
//  2. A failed compress toolResult triggers an IMMEDIATE retry nudge quoting
//     the error, capped at MAX_COMPRESS_ATTEMPTS per user turn; success resets.
//  3. Argument errors THROW (pi only marks thrown tool errors isError:true —
//     a returned error string would be isError:false: no nudge + counter reset).
//  4. Outcomes are scoped to the CURRENT user turn: a stale failure from an
//     earlier turn never re-prompts (the "attempt 0 of 3" forever-nag bug).
//  5. Neutral outcomes (non-error text that is not a success panel, e.g.
//     "No ranges provided.") neither reset nor advance the counter.

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

// Simulates pi's thrown-validation toolResult shape (what a failed compress
// call looks like in entries — whether thrown by pi-ai validation or by
// handleCompress's own argument checks).
const VALIDATION_ERR = 'Validation failed for tool "compress":\n  - content.0: must be object\n\nReceived arguments:\n{"content":"[{\\"topic\\":\\"x\\"}]"}';
const SUCCESS_PANEL = "▣ ACP | 58.5K → 5.7K tokens (~52.8K reclaimed, 4 blocks)";
const NEUTRAL_TEXT = "No ranges provided.";

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

const ZH = "中".repeat(6000);

// ─── unit: runtime counter ──────────────────────────────────────────────────

test("noteCompressOutcomes: counts, caps, resets on success, resets per turn, neutral freezes", () => {
  const rt = createRuntime({});
  const fail = (id: string) => ({ toolCallId: id, isError: true, success: false });
  const success = (id: string) => ({ toolCallId: id, isError: false, success: true });
  const neutral = (id: string) => ({ toolCallId: id, isError: false, success: false });

  let r = rt.noteCompressOutcomes("u1", [fail("t0")]);
  assert.equal(r.count, 1);
  assert.equal(r.retryFor, "t0");
  assert.equal(r.cappedNow, false);

  // idempotent re-fire (same toolCallIds): count frozen, prompt persists
  r = rt.noteCompressOutcomes("u1", [fail("t0")]);
  assert.equal(r.count, 1, "no double count on re-fire");
  assert.equal(r.retryFor, "t0", "retry prompt persists while newest outcome is a failure");

  // neutral outcome: no reset, no prompt (latest is not an error)
  r = rt.noteCompressOutcomes("u1", [fail("t0"), neutral("n1")]);
  assert.equal(r.count, 1, "neutral does not reset the counter");
  assert.equal(r.retryFor, null, "neutral as newest outcome does not prompt");

  // a NEW failure after a neutral one: attempt 2, not 1 — neutral cannot
  // bypass the cap by resetting between failures
  r = rt.noteCompressOutcomes("u1", [fail("t0"), neutral("n1"), fail("t9")]);
  assert.equal(r.count, 2);
  assert.equal(r.retryFor, "t9");

  // third distinct failure → cap: no more retry prompt, cappedNow fires once
  r = rt.noteCompressOutcomes("u1", [fail("t0"), neutral("n1"), fail("t9"), fail("tc")]);
  assert.equal(r.count, 3);
  assert.equal(r.retryFor, null, "capped: no retry prompt after MAX attempts");
  assert.equal(r.cappedNow, true);
  r = rt.noteCompressOutcomes("u1", [fail("t0"), neutral("n1"), fail("t9"), fail("tc")]);
  assert.equal(r.cappedNow, false, "cap notification is one-shot");
  assert.equal(MAX_COMPRESS_ATTEMPTS, 3);

  // success resets the counter
  r = rt.noteCompressOutcomes("u1", [fail("t0"), neutral("n1"), fail("t9"), fail("tc"), success("ts")]);
  assert.equal(r.count, 0);
  assert.equal(r.retryFor, null);

  // a NEW failure after success prompts again (fresh attempt cycle)
  r = rt.noteCompressOutcomes("u1", [fail("t0"), neutral("n1"), fail("t9"), fail("tc"), success("ts"), fail("td")]);
  assert.equal(r.count, 1);
  assert.equal(r.retryFor, "td");

  // new user turn → fresh counter even without a success in between
  r = rt.noteCompressOutcomes("u1", [fail("t0"), neutral("n1"), fail("t9"), fail("tc"), success("ts"), fail("td"), fail("te"), fail("tf")]);
  assert.equal(r.count, 3, "back at cap");
  r = rt.noteCompressOutcomes("u2", [fail("x0")]);
  assert.equal(r.count, 1);
  assert.equal(r.retryFor, "x0");

  // defense in depth: a deduped stale failure with a reset counter must NOT
  // produce a prompt (the "attempt 0 of 3" bug — caller scoping prevents the
  // situation, the count>=1 guard nails it shut)
  r = rt.noteCompressOutcomes("u3", [fail("x0")]);
  assert.equal(r.count, 0, "stale id deduped, count stays 0 after turn change");
  assert.equal(r.retryFor, null, "no prompt without a counted failure in this turn");
});

// ─── unit: normalizeRanges via the tool ─────────────────────────────────────

test("compress tool accepts JSON-encoded string content (non-strict-tool providers)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-retry-str.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", ZH)];
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
  assert.ok(/ACP \|/.test(text), `expected success panel: ${text}`);
  await rm(`${stateFile}.acp.json`, { force: true });
});

test("compress tool THROWS on garbage string content (isError:true → retry nudge fires)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-retry-str2.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", ZH)];
  const ctx = fakeCtx(() => entries, stateFile);
  await fire(handlers, ctx);

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  // pi-agent-core marks only THROWN tool errors isError:true; returning the
  // error string would be isError:false (no nudge + counter reset — review
  // finding 2 on 7ddd2c6), so the tool must reject.
  await assert.rejects(
    () => compressTool.execute("tc1", { content: "not json {" }, undefined, undefined, ctx),
    /Invalid content: not valid JSON[\s\S]*ARRAY/,
  );
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

test("stale failure from an earlier turn never re-prompts (no 'attempt 0 of 3' forever-nag)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-retry-it3.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });

  let entries: any[] = [userMsg("e1", ZH)];
  const ctx = fakeCtx(() => entries, stateFile);
  await fire(handlers, ctx);

  // turn 1: failure → prompt (attempt 1 of 3), model ignores it
  entries = [...entries, toolResultMsg("e2", "call_1", VALIDATION_ERR, true)];
  const r1 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r1).length, 1);

  // turn 2: user asks something new — the old failure must NOT resurface
  entries = [...entries, userMsg("e3", "next question")];
  for (let i = 0; i < 3; i++) {
    const r = await fire(handlers, ctx);
    assert.equal(retryMsgs(r).length, 0, `turn 2 fire ${i + 1}: no stale retry nudge`);
    assert.ok(!/attempt 0 of 3/.test(JSON.stringify(r.messages)), "impossible attempt 0 label");
  }

  // turn 3 likewise
  entries = [...entries, userMsg("e4", "another question")];
  const r3 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r3).length, 0, "turn 3: still no stale retry nudge");

  // a NEW failure in turn 3 gets a fresh budget (attempt 1, not 0 or 2)
  entries = [...entries, toolResultMsg("e5", "call_9", VALIDATION_ERR, true)];
  const r4 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r4).length, 1);
  assert.match(retryText(r4), /attempt 1 of 3/);
  await rm(`${stateFile}.acp.json`, { force: true });
});

test("neutral outcomes freeze the counter; success resets; new turn gets a fresh budget", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-retry-it2.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });

  let entries: any[] = [userMsg("e1", ZH)];
  const ctx = fakeCtx(() => entries, stateFile);
  await fire(handlers, ctx);

  // fail once (attempt 1), then a NEUTRAL outcome (isError:false, no panel):
  // no prompt, and the counter must NOT reset —
  entries = [...entries, toolResultMsg("e2", "call_1", VALIDATION_ERR, true)];
  const r1 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r1).length, 1);

  entries = [...entries, toolResultMsg("e3", "call_2", NEUTRAL_TEXT, false)];
  const r2 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r2).length, 0, "neutral outcome → no prompt");

  // next failure is attempt 2 (neutral did not reset the cycle)
  entries = [...entries, toolResultMsg("e4", "call_3", VALIDATION_ERR, true)];
  const r3 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r3).length, 1);
  assert.match(retryText(r3), /attempt 2 of 3/);

  // genuine success panel resets the counter
  entries = [...entries, toolResultMsg("e5", "call_4", SUCCESS_PANEL, false)];
  const r4 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r4).length, 0);

  // fresh failure after success → new cycle (attempt 1, not 2)
  entries = [...entries, toolResultMsg("e6", "call_5", VALIDATION_ERR, true)];
  const r5 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r5).length, 1);
  assert.match(retryText(r5), /attempt 1 of 3/);

  // new user turn mid-cycle → fresh budget, and the pre-turn failure is out of scope
  entries = [...entries, userMsg("e7", "next question")];
  const r6 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r6).length, 0, "pre-turn failure out of scope after user message");
  await rm(`${stateFile}.acp.json`, { force: true });
});
