import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBashTimeout, capToolOutput } from "../src/tool-guardrails.js";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

type Content = ToolResultEvent["content"];
const text = (t: string): Content => [{ type: "text", text: t }];

test("resolveBashTimeout returns undefined when the model already set a timeout", () => {
  assert.equal(resolveBashTimeout({ timeout: 30 }, 600), undefined);
});

test("resolveBashTimeout injects the default when the model omitted timeout", () => {
  assert.equal(resolveBashTimeout({}, 600), 600);
  assert.equal(resolveBashTimeout({ timeout: undefined }, 600), 600);
});

test("resolveBashTimeout returns undefined when the default is disabled (0 / negative / NaN)", () => {
  assert.equal(resolveBashTimeout({}, 0), undefined);
  assert.equal(resolveBashTimeout({}, -5), undefined);
  assert.equal(resolveBashTimeout({}, Number.NaN), undefined);
});

test("resolveBashTimeout falls back to the 600s built-in default when default is undefined", () => {
  assert.equal(resolveBashTimeout({}, undefined), 600);
});

test("capToolOutput leaves small output untouched (returns undefined)", () => {
  assert.equal(capToolOutput(text("hello"), 100), undefined);
});

test("capToolOutput returns undefined when the cap is disabled", () => {
  assert.equal(capToolOutput(text("x".repeat(10_000)), 0), undefined);
  assert.equal(capToolOutput(text("x".repeat(10_000)), undefined), undefined);
});

test("capToolOutput truncates oversized text to under the byte cap and adds a notice", () => {
  const big = "line\n".repeat(4000);
  const out = capToolOutput(text(big), 500);
  assert.ok(out, "should return truncated content");
  const t = (out![0] as { text: string }).text;
  assert.ok(Buffer.byteLength(t, "utf8") <= 500 + 200, "truncated payload must be near the cap (notice adds a little)");
  assert.match(t, /ACP guardrail/);
  assert.match(t, /dropped/);
});

test("capToolOutput keeps a complete last line (no mid-line cut)", () => {
  const big = "0123456789\n".repeat(2000);
  const out = capToolOutput(text(big), 100);
  const t = (out![0] as { text: string }).text;
  const body = t.split("\n\n[ACP guardrail")[0];
  for (const line of body.split("\n")) {
    assert.ok(line.length === 0 || line.length === 10, "no partial line: " + JSON.stringify(line));
  }
});

test("capToolOutput mentions the saved full-output path for bash-style results", () => {
  const big = "x".repeat(10_000);
  const out = capToolOutput(text(big), 500, "/tmp/acp-full.log");
  const t = (out![0] as { text: string }).text;
  assert.match(t, /\/tmp\/acp-full\.log/);
});

test("capToolOutput preserves non-text (image) content alongside truncated text", () => {
  const img = { type: "image", source: { media_type: "image/png", data: "AAAA" } } as Content[number];
  const content: Content = [{ type: "text", text: "x".repeat(10_000) }, img];
  const out = capToolOutput(content, 500);
  assert.ok(out);
  assert.equal(out!.some((c) => c.type === "image"), true, "image part must survive");
  assert.equal(out!.some((c) => c.type === "text"), true, "truncated text part must be present");
});

test("capToolOutput is UTF-8 safe (never splits a multibyte sequence)", () => {
  const big = "中文测试\n".repeat(3000);
  const out = capToolOutput(text(big), 200);
  const t = (out![0] as { text: string }).text;
  const body = t.split("\n\n[ACP guardrail")[0];
  const buf = Buffer.from(body, "utf8");
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    const size = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
    assert.ok(i + size <= buf.length, "no truncated multibyte sequence at byte " + i);
    i += size;
  }
});
