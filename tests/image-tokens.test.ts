import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { estimateTokens, collectImageTokens, modelSupportsImages, IMAGE_TOKEN_COST } from "../src/tokens.js";
import { countImageBlocks } from "../src/messages.js";

// Image blocks were invisible to the sent-view estimate (extractText drops
// them), so usage under-counted image-heavy sessions and density calibration
// chased a phantom gap (real includes image tokens, estimate did not).
// dog/billion-context-pi#200.

const STATE_FILE = "/tmp/pai-acp-image-tokens-it.session.json";

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

// pi's injected nudge text: "⚠️ Context limit reached — compress now. …"
const nudgeCount = (r: any) =>
  (r?.messages ?? []).filter((m: any) => m.role === "user" && /Context limit reached|compress/i.test(JSON.stringify(m.content))).length;

function ctxWithModel(entries: any[], limit: number, input: string[]) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: limit, input },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "image-tokens-session",
      getSessionFile: () => STATE_FILE,
    },
  };
}

const imgEntry = (id: string) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "",
  message: { role: "user", content: [{ type: "image", data: `payload-${id}`, mimeType: "image/png" }], timestamp: Date.now() },
});

const textEntry = (id: string, text: string) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "",
  message: { role: "user", content: text, timestamp: Date.now() },
});

test("countImageBlocks counts only image blocks", () => {
  assert.equal(countImageBlocks([{ type: "text", text: "hi" }, { type: "image", data: "a", mimeType: "image/png" }]), 1);
  assert.equal(countImageBlocks([{ type: "image", data: "a", mimeType: "image/png" }, { type: "image", data: "b", mimeType: "image/jpeg" }]), 2);
  assert.equal(countImageBlocks("plain string"), 0);
  assert.equal(countImageBlocks(undefined), 0);
});

test("modelSupportsImages reads the model input capability", () => {
  assert.equal(modelSupportsImages({ input: ["text", "image"] }), true);
  assert.equal(modelSupportsImages({ input: ["text"] }), false);
  assert.equal(modelSupportsImages({}), false);
  assert.equal(modelSupportsImages(undefined), false);
});

test("collectImageTokens maps entry ids to per-image cost", () => {
  const entries = [
    { id: "e1", type: "message", message: { role: "user", content: [{ type: "text", text: "see" }, { type: "image", data: "x", mimeType: "image/png" }] } },
    { id: "e2", type: "message", message: { role: "toolResult", toolName: "read", toolCallId: "c1", content: [{ type: "image", data: "y", mimeType: "image/png" }] } },
    { id: "e3", type: "message", message: { role: "user", content: "no images" } },
    { id: "e4", type: "model_change" },
  ];
  const map = collectImageTokens(entries, true);
  assert.equal(map.get("e1"), IMAGE_TOKEN_COST);
  assert.equal(map.get("e2"), IMAGE_TOKEN_COST);
  assert.ok(!map.has("e3"));
  assert.ok(!map.has("e4"));
});

test("collectImageTokens is empty for non-vision models", () => {
  const entries = [imgEntry("e1")];
  assert.equal(collectImageTokens(entries, false).size, 0);
});

test("estimateTokens adds image tokens and skips covered ids", () => {
  const msgs = [
    { id: "m1", role: "user", contentType: "text", text: "" },
    { id: "m2", role: "user", contentType: "text", text: "alpha beta gamma" },
  ];
  const imageTokens = new Map([["m1", IMAGE_TOKEN_COST]]);
  assert.equal(estimateTokens(msgs, undefined, imageTokens), IMAGE_TOKEN_COST + 4);
  assert.equal(estimateTokens(msgs, new Set(["m1"]), imageTokens), 4);
});

test("images count toward sent-view arbitration (vision model)", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 10_000 })(api as any);
  const entries = Array.from({ length: 8 }, (_, i) => imgEntry(`e${i}`));
  const ctx = ctxWithModel(entries, 10_000, ["text", "image"]);
  const r = await handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);
  // 8 × 1600 = 12.8K > 10K window — the nudge must fire even though the
  // visible text of every message is empty.
  assert.ok(nudgeCount(r) >= 1, "image tokens must push the sent view past the window");
  await rm(`${STATE_FILE}.acp.json`, { force: true });
});

test("identical text-only session stays quiet (same window)", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 10_000 })(api as any);
  const entries = Array.from({ length: 8 }, (_, i) => textEntry(`e${i}`, "x"));
  const ctx = ctxWithModel(entries, 10_000, ["text", "image"]);
  const r = await handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);
  assert.equal(nudgeCount(r), 0, "eight one-char messages must not trip the nudge");
  await rm(`${STATE_FILE}.acp.json`, { force: true });
});

test("images cost nothing for non-vision models", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 10_000 })(api as any);
  const entries = Array.from({ length: 8 }, (_, i) => imgEntry(`e${i}`));
  const ctx = ctxWithModel(entries, 10_000, ["text"]);
  const r = await handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);
  // pi-ai silently drops image blocks for non-vision models — counting them
  // would fabricate 12.8K of phantom usage.
  assert.equal(nudgeCount(r), 0, "non-vision model must not count image tokens");
  await rm(`${STATE_FILE}.acp.json`, { force: true });
});

test("pi host: image-only user message survives the transform with its ref tag", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const entries = [imgEntry("e1")];
  const ctx = ctxWithModel(entries, 200_000, ["text", "image"]);
  const r = await handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);
  assert.ok(r, "handler must not throw on an image-only message");
  const content = r.messages[0].content;
  const imageBlocks = content.filter((b: { type?: string }) => b.type === "image");
  assert.equal(imageBlocks.length, 1, "the image block must survive");
  assert.equal(imageBlocks[0]!.data, "payload-e1");
  const textBlock = content.find((b: { type?: string }) => b.type === "text");
  assert.ok(textBlock, "a ref-tag text block must accompany the image");
  assert.match(textBlock.text, /m\d{5}/, "ref tag present on the image-only message");
  await rm(`${STATE_FILE}.acp.json`, { force: true });
});
