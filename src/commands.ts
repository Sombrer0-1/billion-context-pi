import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { defaultCountTokens, parseBlockIdArg, collectBlockContent } from "acp-kernel";
import { getSystemPromptText } from "./compat.js";
import { buildStatusPanel } from "billion-context-kit";
import { getDelegateUsage } from "./delegate-tool.js";

declare const CURRENT_VERSION: string;

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

export function makeCommands(runtime: AcpRuntime): Array<{ name: string; options: CommandOptions }> {
  return [
    {
      name: "acp",
      options: {
        description: "Show ACP context usage, token breakdown, and compression status.",
        handler: async (_args, ctx) => ctx.ui.notify(await statusReport(runtime, ctx)),
      },
    },
    {
      name: "acp-status",
      options: {
        description: "Detailed ACP status (block tiers, token breakdown, delegate usage).",
        handler: async (_args, ctx) => ctx.ui.notify(await statusReport(runtime, ctx)),
      },
    },
    {
      name: "acp-decompress",
      options: {
        description: "Restore a compressed block's content (shown here, block stays folded). Usage: /acp-decompress b3",
        handler: async (args, ctx) => {
          const blockId = parseBlockIdArg(args);
          if (!blockId) {
            ctx.ui.notify('Usage: /acp-decompress <blockId> (e.g. "b3")');
            return;
          }
          const { state, coreMessages } = await runtime.stateFor(ctx);
          const block = state.blocks.find((b) => b.blockId === blockId);
          if (!block) {
            ctx.ui.notify(`Block ${blockId} not found.`);
            return;
          }
          const { text, count } = collectBlockContent(state, block, coreMessages, { full: false });
          if (count === 0) {
            ctx.ui.notify(`Block ${blockId} has no restorable message content.`);
            return;
          }
          ctx.ui.notify(`Block ${blockId} (${count} items):\n\n${text}`);
        },
      },
    },
    {
      name: "acp-search",
      options: {
        description: "Search compressed block summaries. Usage: /acp-search auth token",
        handler: async (args, ctx) => {
          const query = args.trim();
          if (!query) {
            ctx.ui.notify("Usage: /acp-search <query>");
            return;
          }
          const { state } = await runtime.stateFor(ctx);
          const hits = runtime.core.search(query, state);
          if (hits.length === 0) {
            ctx.ui.notify("No matching blocks.");
            return;
          }
          const lines = hits.map((b) => `[${b.blockId}] (t${b.tier}) ${b.topic ?? ""}`.trim());
          ctx.ui.notify(lines.join("\n"));
        },
      },
    },
  ];
}

async function statusReport(runtime: AcpRuntime, ctx: ExtensionCommandContext): Promise<string> {
  const { state, coreMessages } = await runtime.stateFor(ctx);
  const config = runtime.configFor(ctx);
  // Use pi's real context usage (anchored on provider usage) instead of a
  // chars/4 estimate — matches the footer percentage and the nudge decision
  // the context transform computes.
  const realUsage = ctx.getContextUsage?.();
  const tokenCount = realUsage?.tokens && realUsage.tokens > 0 ? realUsage.tokens : defaultCountTokens(coreMessages.map((m) => m.text ?? "").join("\n"));

  const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount });

  // Shared kit surface renders the panel (dual accounting, viability
  // filtering, bars, block list with topic fallback). Host-specific inputs:
  const systemPromptText = getSystemPromptText(ctx);
  const versionStr = CURRENT_VERSION ? `billion-context-pi@${CURRENT_VERSION}` : undefined;
  let text = buildStatusPanel({
    version: versionStr,
    tokenCount,
    systemPromptTokens: systemPromptText ? defaultCountTokens(systemPromptText) : 0,
    state: turn.state,
    nudge: turn.nudge,
    modelContextLimit: config.modelContextLimit,
  });

  // pi-specific footer: delegate usage is tracked outside the main totals.
  const delegateUsage = getDelegateUsage();
  if (delegateUsage && delegateUsage.totalTokens > 0) {
    const cost = delegateUsage.cost.total;
    const costStr = cost > 0 ? ` ($${cost.toFixed(4)})` : "";
    text += "\n\n── Session delegate usage (excluded from main totals) ──\n";
    text += `Tokens: ${delegateUsage.input.toLocaleString()} in, ${delegateUsage.output.toLocaleString()} out (${delegateUsage.totalTokens.toLocaleString()} total)${costStr}`;
  }
  return text;
}
