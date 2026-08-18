import test from "node:test";
import assert from "node:assert/strict";

import { inspectOverflowMessage, OverflowEpisode, OVERFLOW_MARKER, reserveOutputHeadroom } from "../src/overflow-selfheal.js";

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

test("inspectOverflowMessage: OpenAI Responses 'maximum context size of N' phrasing", () => {
  // The newer Responses-API phrasing (the chat-completions one says
  // "maximum context LENGTH is") — must be detected AND parsed, or self-heal
  // learns no window for /responses relays.
  const info = inspectOverflowMessage(
    "This request's total token count is 130000, which exceeds the model's maximum context size of 128000 tokens.",
  );
  assert.equal(info.isOverflow, true);
  assert.equal(info.window, 128000);
  assert.equal(inspectOverflowMessage("maximum context size is 128,000").window, 128000);
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
  assert.equal(ep.learnedWindowFor("m1"), null);
  assert.equal(ep.armed, false);
  ep.setLearnedWindow("m1", 100000);
  ep.armed = true;
  assert.equal(ep.learnedWindowFor("m1"), 100000);
  assert.equal(ep.armed, true);
  ep.reset();
  assert.equal(ep.learnedWindowFor("m1"), null);
  assert.equal(ep.armed, false);
});

test("OverflowEpisode: learned windows are per-model (no cross-model crosstalk)", () => {
  // The footgun this PR fixes, in the reverse direction: an overflow on a
  // SMALL model must not keep capping a BIGGER model the user switches to
  // mid-session (the bands would sit far below the new model's real window).
  const ep = new OverflowEpisode();
  ep.setLearnedWindow("small-model", 100000);
  assert.equal(ep.learnedWindowFor("small-model"), 100000);
  assert.equal(ep.learnedWindowFor("big-model"), null, "other models unaffected");
  ep.setLearnedWindow("big-model", 200000);
  assert.equal(ep.learnedWindowFor("small-model"), 100000, "first model kept");
  assert.equal(ep.learnedWindowFor("big-model"), 200000);
  ep.setLearnedWindow("small-model", 90000);
  assert.equal(ep.learnedWindowFor("small-model"), 90000, "re-learned window overwrites");
});

test("reserveOutputHeadroom: reserves the output budget from the window", () => {
  assert.equal(reserveOutputHeadroom(100_000, 16_384), 83_616);
  assert.equal(reserveOutputHeadroom(128_000, 1), 127_999);
});

test("reserveOutputHeadroom: no-op for unusable maxOutput", () => {
  assert.equal(reserveOutputHeadroom(100_000, 0), 100_000);
  assert.equal(reserveOutputHeadroom(100_000, -5), 100_000);
  assert.equal(reserveOutputHeadroom(100_000, Number.NaN), 100_000);
  assert.equal(reserveOutputHeadroom(100_000, Number.POSITIVE_INFINITY), 100_000);
});

test("reserveOutputHeadroom: no-op when maxOutput >= window (degenerate request)", () => {
  assert.equal(reserveOutputHeadroom(100_000, 100_000), 100_000);
  assert.equal(reserveOutputHeadroom(100_000, 200_000), 100_000);
});

test("reserveOutputHeadroom: no-op for unusable window", () => {
  assert.equal(reserveOutputHeadroom(0, 10_000), 0);
  assert.equal(reserveOutputHeadroom(-1, 10_000), -1);
  assert.equal(reserveOutputHeadroom(Number.NaN, 10_000), Number.NaN);
});

test("OVERFLOW_MARKER: case-insensitive and matches the shared guard patterns", () => {
  assert.ok(OVERFLOW_MARKER.test("PROMPT IS TOO LONG"));
  assert.ok(OVERFLOW_MARKER.test("Context Length Exceeded"));
  assert.ok(OVERFLOW_MARKER.test("context_length_exceeded"));
  assert.ok(!OVERFLOW_MARKER.test("too many tokens, please wait before trying again"));
});
