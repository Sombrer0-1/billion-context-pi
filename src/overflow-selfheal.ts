// Context-overflow self-heal (extension side).
//
// When the model API rejects a request because the context is too large (a
// context-overflow 400), the extension reacts on the NEXT turn:
//   1. LEARN the real window: many providers state it in the error body
//      ("prompt is too long: ... > 128000 maximum", "maximum context length is
//      128000 tokens"). We persist it per-session and re-center the kernel's
//      nudge/truncate bands on it — below the real limit, not above it (the
//      fallback 150k puts those bands ABOVE a smaller real window, so nothing
//      fires before the overflow).
//   2. ARM an emergency: we force the next context event's usage to >=95% so
//      the kernel's emergency nudge + tool-result truncate fire immediately,
//      even if the density-calibrated estimate under-reports the sent view.
//
// This is the extension-side mirror of the proxy's overflow self-heal
// (billion-context PR #172). Unlike throttle-retry we do NOT rewrite the error
// or ask pi to retry: the overflow is real, and re-sending the same context
// would overflow again. The error surfaces; the next turn recovers.
//
// NOTE: the OVERFLOW_MARKER below is deliberately a superset of the
// OVERFLOW_GUARD in src/throttle-retry.ts (which uses it to AVOID treating an
// overflow as a throttle). Keep the two in sync when either changes.

// Detect a context-overflow error. Deliberately does NOT match Bedrock's
// "too many tokens" throttle (a 429, handled by throttle-retry) — only
// genuine context-length errors.
export const OVERFLOW_MARKER =
  /prompt is too long|prompt_too_long|prompt_is_too_long|request_too_large|exceeds the context window|exceeds the (maximum |model['’]s )?limit|maximum context length|max context length|context length exceeded|context[_ ]length[_ ]exceeded|exceeded model token limit|input token count.*exceeds|reduce the length of the messages|token limit exceeded/i;

export interface OverflowInfo {
  isOverflow: boolean;
  /** The real context window, when the provider stated it in the error. */
  window?: number;
  message: string;
}

// Pure: detect a context-overflow error from an error haystack (the
// errorMessage plus any error content) and parse the real window when the
// provider states it.
export function inspectOverflowMessage(haystack: string | undefined | null): OverflowInfo {
  const body = (haystack ?? "").trim();
  if (!body || !OVERFLOW_MARKER.test(body)) return { isOverflow: false, message: body };
  return { isOverflow: true, window: parseOverflowWindow(body), message: body };
}

function parseOverflowWindow(text: string): number | undefined {
  // Anthropic: "prompt is too long: 130000 tokens > 128000 maximum" -> 128000
  let m = />\s*(\d[\d,]*)\s*(?:tokens?)?\s*maximum/i.exec(text);
  if (m) return toTokenNumber(m[1]);
  // OpenAI: "maximum context length is 128000 tokens"
  m = /maximum context length is (\d[\d,]*)/i.exec(text);
  if (m) return toTokenNumber(m[1]);
  // "...exceeds the model's maximum of N tokens" / "limit of N tokens"
  m = /(?:maximum|limit) of (\d[\d,]*)\s*(?:input\s+)?tokens/i.exec(text);
  if (m) return toTokenNumber(m[1]);
  return undefined;
}

function toTokenNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 1000 ? n : undefined;
}

// Per-session overflow self-heal state. Keyed by session id so concurrent
// sessions in one extension instance cannot share a learned window or an
// armed emergency (same rationale as the throttle episode).
export class OverflowEpisode {
  /** Real window learned from an overflow error (null until learned). */
  learnedWindow: number | null = null;
  /** When true, the next context event forces usage >=95% (emergency). */
  armed = false;
  reset(): void {
    this.learnedWindow = null;
    this.armed = false;
  }
}
