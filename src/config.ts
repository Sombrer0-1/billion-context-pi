import { defaultConfig, type Config } from "acp-kernel";

/**
 * Adapter configuration. Maps onto acp-kernel's `Config` plus Pi-specific knobs
 * (live model context window, protected tools, state persistence).
 */
export interface AdapterConfig {
  /** When omitted, the adapter reads `ctx.model.contextWindow` live each turn.
   *  Set explicitly for tests/headless runs. */
  modelContextLimit?: number;
  protectedTools?: string[];
  preserveRecentMessages?: number;
  /** Check npm for a newer billion-context-pi on startup and auto-install it. Default: true.
   *  Disable via `autoUpdate: false` or env `ACP_AUTO_UPDATE=0` to avoid all
   *  network calls on startup. */
  autoUpdate?: boolean;
  /** Write ACP debug events to the debug log file (default ~/.pi/acp-debug.log).
   *  Default: false (or env ACP_DEBUG=1/true). */
  debug?: boolean;
  /** Enable acp_delegate tools (delegate/wait/cancel) and their system-prompt
   *  section. Default: true. Set `delegate: false` (adapter config or
   *  ~/.pi/acp.json) to skip registering them. */
  delegate?: boolean;
  coreOverrides?: Partial<Config>;
}

export function resolveConfig(adapter: AdapterConfig, liveContextLimit: number): Config {
  const envLimit = process.env.ACP_MODEL_CONTEXT_LIMIT;
  const envLimitNum = envLimit ? Number(envLimit) : NaN;
  const FALLBACK_LIMIT = 150_000;
  const limit =
    !Number.isNaN(envLimitNum) && envLimitNum > 0
      ? envLimitNum
      : adapter.modelContextLimit && adapter.modelContextLimit > 0
        ? adapter.modelContextLimit
        : liveContextLimit > 0
          ? liveContextLimit
          : FALLBACK_LIMIT;
  return defaultConfig(limit, {
    protectedTools: adapter.protectedTools ?? [],
    preserveRecentMessages: adapter.preserveRecentMessages ?? 5,
    ...adapter.coreOverrides,
  });
}
