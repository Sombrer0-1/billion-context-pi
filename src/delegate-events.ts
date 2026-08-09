// Parsing helpers for `pi --mode json` event streams. The child delegate runs
// in JSON Event Stream Mode, so its stdout is newline-delimited JSON events
// instead of the final reply text. These pure functions map raw lines to
// structured events and format them for the activity file.

export interface ToolStartEvent {
  kind: "tool-start";
  toolName: string;
  argsText: string;
}

export interface ToolUpdateEvent {
  kind: "tool-update";
  toolCallId: string;
  text: string;
}

export interface ToolEndEvent {
  kind: "tool-end";
  toolName: string;
  isError: boolean;
}

export interface ReplyDeltaEvent {
  kind: "reply-delta";
  delta: string;
}

export interface ReplyCompleteEvent {
  kind: "reply-complete";
  content: string;
}

export interface ThinkingDeltaEvent {
  kind: "thinking-delta";
  delta: string;
}

export type ParsedEvent =
  | ToolStartEvent
  | ToolUpdateEvent
  | ToolEndEvent
  | ReplyDeltaEvent
  | ReplyCompleteEvent
  | ThinkingDeltaEvent
  | ThinkingEndEvent;

export interface ThinkingEndEvent {
  kind: "thinking-end";
}

/**
 * Accumulates thinking_delta tokens and emits one human-readable line per
 * thinking segment (a segment ends at thinking_end / text_start). Nothing is
 * emitted when showThinking is off.
 */
export class ThinkingCollector {
  private buf = "";

  constructor(private readonly showThinking: boolean) {}

  push(delta: string): void {
    this.buf += delta;
  }

  /** Return the segment line to write ("" when empty or disabled), resetting. */
  flush(): string {
    const text = this.buf.trim();
    this.buf = "";
    if (!this.showThinking || !text) return "";
    return `[thinking] ${text}\n`;
  }
}
/** Parse one newline-delimited JSON line; null for non-JSON or irrelevant events. */
export function parseEventLine(line: string): ParsedEvent | null {
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof ev !== "object" || ev === null) return null;
  const e = ev as Record<string, unknown>;
  if (e.type === "message_update") {
    const am = e.assistantMessageEvent;
    if (typeof am !== "object" || am === null) return null;
    const msg = am as Record<string, unknown>;
    switch (msg.type) {
      case "text_delta":
        return { kind: "reply-delta", delta: String(msg.delta ?? "") };
      case "text_end":
        return { kind: "reply-complete", content: String(msg.content ?? "") };
      case "thinking_delta":
        return { kind: "thinking-delta", delta: String(msg.delta ?? "") };
      case "thinking_end":
        return { kind: "thinking-end" };
      default:
        return null;
    }
  }
  if (e.type === "tool_execution_start") {
    return {
      kind: "tool-start",
      toolName: String(e.toolName ?? ""),
      argsText: formatArgs(e.args),
    };
  }
  if (e.type === "tool_execution_update") {
    return {
      kind: "tool-update",
      toolCallId: String(e.toolCallId ?? ""),
      text: extractContentText(e.partialResult),
    };
  }
  if (e.type === "tool_execution_end") {
    return {
      kind: "tool-end",
      toolName: String(e.toolName ?? ""),
      isError: Boolean(e.isError),
    };
  }
  return null;
}

/** bash commands read as the command string; everything else as JSON. */
function formatArgs(args: unknown): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (typeof a.command === "string") return a.command;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/** Join `content[].text` blocks from a tool result / partialResult payload. */
export function extractContentText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const content = (payload as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" ? String((c as Record<string, unknown>).text ?? "") : ""))
    .join("");
}

/** Format a parsed event as human-readable activity file lines (each with a
 *  trailing newline; empty when none). */
export function activityLines(ev: ParsedEvent, opts: { showThinking: boolean }): string[] {
  switch (ev.kind) {
    case "tool-start":
      return [`[tool] ${ev.toolName}${ev.argsText ? ` ${ev.argsText}` : ""}\n`];
    case "tool-update": {
      if (!ev.text) return [];
      return [ev.text.endsWith("\n") ? ev.text : `${ev.text}\n`];
    }
    case "tool-end":
      return [`[done] ${ev.toolName}${ev.isError ? " (error)" : ""}\n`];
    case "thinking-delta":
      return opts.showThinking ? [`[thinking] ${ev.delta}\n`] : [];
    default:
      return [];
  }
}

/**
 * partialResult is an accumulated snapshot (not a delta), so each update
 * carries everything so far. Return only the newly-appended portion.
 */
export function newPortion(text: string, prev: string): string {
  if (text.startsWith(prev)) return text.slice(prev.length);
  return text;
}
