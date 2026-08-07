import {
  isBashToolResult,
  isToolCallEventType,
  type ExtensionAPI,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOL_BASH_TIMEOUT, DEFAULT_TOOL_OUTPUT_MAX_BYTES } from "./config.js";
import { debug } from "./log.js";
import type { AcpRuntime } from "./runtime.js";

type ContentPart = ToolResultEvent["content"][number];

export function resolveBashTimeout(
  input: { timeout?: number },
  defaultTimeout: number | undefined,
): number | undefined {
  if (input.timeout !== undefined) return undefined;
  const d = defaultTimeout ?? DEFAULT_TOOL_BASH_TIMEOUT;
  if (!Number.isFinite(d) || d <= 0) return undefined;
  return d;
}

export function capToolOutput(
  content: ToolResultEvent["content"],
  maxBytes: number | undefined,
  fullPath?: string,
): ToolResultEvent["content"] | undefined {
  const max = maxBytes ?? DEFAULT_TOOL_OUTPUT_MAX_BYTES;
  if (!Number.isFinite(max) || max <= 0) return undefined;
  const kept: ContentPart[] = [];
  const texts: string[] = [];
  for (const c of content) {
    if (c.type === "text") texts.push((c as { text: string }).text);
    else kept.push(c);
  }
  if (texts.length === 0) return undefined;
  const combined = texts.join("\n");
  const total = Buffer.byteLength(combined, "utf8");
  if (total <= max) return undefined;
  const head = keepHead(combined, max);
  const dropped = total - Buffer.byteLength(head, "utf8");
  kept.push({ type: "text", text: head + buildNotice(dropped, max, fullPath) } as ContentPart);
  return kept;
}

function keepHead(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0) {
    const b = buf[end];
    if (b === undefined || (b & 0xc0) !== 0x80) break;
    end--;
  }
  let head = buf.subarray(0, end).toString("utf8");
  const nl = head.lastIndexOf("\n");
  if (nl >= Math.floor(maxBytes / 2)) head = head.slice(0, nl);
  return head;
}

function buildNotice(dropped: number, maxBytes: number, fullPath?: string): string {
  const where = fullPath
    ? `Full output saved: ${fullPath}`
    : "Refine the tool call (narrow pattern / lower limit) to reduce output.";
  return `\n\n[ACP guardrail: dropped ~${formatBytes(dropped)} (cap ${formatBytes(maxBytes)}). ${where}]`;
}

function formatBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`;
}

export function wireToolGuardrails(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;
    const t = resolveBashTimeout(event.input, runtime.adapter.toolBashDefaultTimeout);
    if (t !== undefined) {
      event.input.timeout = t;
      debug.event("guardrail-bash-timeout", { applied: t });
    }
  });

  pi.on("tool_result", (event) => {
    const max = runtime.adapter.toolOutputMaxBytes;
    if (max === undefined || max <= 0) return;
    const fullPath = isBashToolResult(event) ? event.details?.fullOutputPath : undefined;
    const next = capToolOutput(event.content, max, fullPath);
    if (next) {
      debug.event("guardrail-output-cap", { max, hadPath: !!fullPath });
      return { content: next };
    }
  });
}
