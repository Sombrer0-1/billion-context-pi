import test from "node:test";
import assert from "node:assert/strict";

import { inspectOverflowMessage, OverflowEpisode, OVERFLOW_MARKER } from "../src/overflow-selfheal.js";

test("inspectOverflowMessage: detects OpenAI context-overflow + parses window", () => {
  const info = inspectOverflowMessage(
    `This model's maximum context length is 128000 tokens. However, you requested 130000 output tokens and your prompt contains approximately 129000 tokens. Please reduce the length of the input prompt or the number of requested output tokens.`,
  );
  assert.equal(info.isOverflow, true);
  assert.equal(info.window, 128000);
});

test("inspectOverflowMessage: detects Anthropic overflow + parses '> N maximum' window", () => {
  const info = inspectOverflowMessage("prompt is too long: 130000 tokens > 128000 maximum");
  assert.equal(info.isOverflow, true);
  assert.equal(info.window, 128000);
});

test("inspectOverflowMessage: comma-grouped window", () => {
  const info = inspectOverflowMessage("maximum context length is 128,000 tokens");
  assert.equal(info.isOverflow, true);
  assert.equal(info.window, 128000);
});

test("inspectOverflowMessage: 'limit of N tokens' form", () => {
  const info = inspectOverflowMessage("input exceeds the model's limit of 64000 tokens");
  assert.equal(info.isOverflow, true);
  assert.equal(info.window, 64000);
});

test("inspectOverflowMessage: overflow without a stated window → window undefined", () => {
  const info = inspectOverflowMessage("prompt is too long, please shorten the conversation");
  assert.equal(info.isOverflow, true);
  assert.equal(info.window, undefined);
});

test("inspectOverflowMessage: bare markers without a number", () => {
  assert.equal(inspectOverflowMessage("error: context_length_exceeded").isOverflow, true);
  assert.equal(inspectOverflowMessage("request_too_large").isOverflow, true);
  assert.equal(inspectOverflowMessage("your prompt exceeds the context window").isOverflow, true);
  assert.equal(inspectOverflowMessage("exceeded model token limit").isOverflow, true);
});

test("inspectOverflowMessage: Bedrock throttle (429 'too many tokens') is NOT a context overflow", () => {
  const info = inspectOverflowMessage("429 rate limit: Too many tokens, please wait before trying again.");
  assert.equal(info.isOverflow, false);
});

test("inspectOverflowMessage: quota/billing errors are not context overflows", () => {
  assert.equal(inspectOverflowMessage("insufficient_quota: you have exceeded your quota").isOverflow, false);
  assert.equal(inspectOverflowMessage("out of budget for this billing period").isOverflow, false);
});

test("inspectOverflowMessage: normal assistant text / empty → not overflow", () => {
  assert.equal(inspectOverflowMessage("Here is the code you asked for.").isOverflow, false);
  assert.equal(inspectOverflowMessage("").isOverflow, false);
  assert.equal(inspectOverflowMessage(undefined).isOverflow, false);
});

test("inspectOverflowMessage: rejects a sub-1000 'window' (not a real context limit)", () => {
  // A tiny number in a marker-adjacent sentence must not be mistaken for a window.
  const info = inspectOverflowMessage("prompt is too long: 50 tokens > 30 maximum");
  assert.equal(info.isOverflow, true);
  assert.equal(info.window, undefined, "30 is below the 1000 floor → treated as unparseable");
});

test("OverflowEpisode: initial state + reset", () => {
  const ep = new OverflowEpisode();
  assert.equal(ep.learnedWindow, null);
  assert.equal(ep.armed, false);
  ep.learnedWindow = 100000;
  ep.armed = true;
  assert.equal(ep.learnedWindow, 100000);
  assert.equal(ep.armed, true);
  ep.reset();
  assert.equal(ep.learnedWindow, null);
  assert.equal(ep.armed, false);
});

test("OVERFLOW_MARKER: case-insensitive and matches the shared guard patterns", () => {
  assert.ok(OVERFLOW_MARKER.test("PROMPT IS TOO LONG"));
  assert.ok(OVERFLOW_MARKER.test("Context Length Exceeded"));
  assert.ok(OVERFLOW_MARKER.test("context_length_exceeded"));
  assert.ok(!OVERFLOW_MARKER.test("too many tokens, please wait before trying again"));
});
