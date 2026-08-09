import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  createCore,
  defaultCountTokens,
  type CompressionCore,
  type CompressionState,
  type Config,
} from "acp-kernel";
import { resolveConfig, type AdapterConfig } from "./config.js";
import { entriesToCoreMessages } from "./messages.js";
import { SessionStateStore } from "./state.js";

// pi exposes `sessionManager.buildContextEntries()`; omp (oh-my-pi) only has
// `getBranch()`. Both return chronological SessionEntry[]; feature-detect so the
// adapter runs under either host (omp's runner silently swallows the TypeError).
type SessionEntrySource = {
  buildContextEntries?: () => SessionEntry[];
  getBranch?: () => SessionEntry[];
};

export function readContextEntries(sm: ExtensionContext["sessionManager"]): SessionEntry[] {
  const source = sm as unknown as SessionEntrySource;
  if (typeof source.buildContextEntries === "function") return source.buildContextEntries();
  if (typeof source.getBranch === "function") return source.getBranch();
  return [];
}

export interface AcpRuntime {
  core: CompressionCore;
  store: SessionStateStore;
  adapter: AdapterConfig;
  setAdapter(adapter: AdapterConfig): void;
  /** Record that a nudge was already shown for the turn keyed by last user msg
   *  id, so a tier/growth nudge prints at most once per turn instead of on
   *  every context event (pi fires multiple per assistant reply). */
  markNudgeShown(turnKey: string): void;
  nudgeShownFor(turnKey: string): boolean;
  /** Clear per-turn nudge tracking. Called on session_start so the Set does not
   *  grow unbounded across sessions in a long-lived Pi process. */
  clearNudgeTracking(): void;
  liveContextLimit(ctx: ExtensionContext): number;
  configFor(ctx: ExtensionContext): Config;
  stateFor(ctx: ExtensionContext): Promise<{ state: CompressionState; coreMessages: ReturnType<typeof entriesToCoreMessages>; entries: SessionEntry[] }>;
  save(state: CompressionState, ctx: ExtensionContext): Promise<void>;
  acquireLock(sid: string): Promise<() => void>;
}

export function createRuntime(adapter: AdapterConfig): AcpRuntime {
  const core = createCore({ countTokens: defaultCountTokens });
  const store = new SessionStateStore();
  const locks = new Map<string, Promise<void>>();
  let adapterRef = adapter;
  const nudgeShownTurns = new Set<string>();

  async function acquireLock(sid: string): Promise<() => void> {
    const prev = locks.get(sid) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = () => {
        locks.delete(sid);
        resolve();
      };
    });
    locks.set(sid, prev.then(() => next));
    await prev;
    return release;
  }

  function liveContextLimit(ctx: ExtensionContext): number {
    // Prefer pi's reported context window (matches what the footer shows) over
    // ctx.model.contextWindow, which can be stale or unset for some providers.
    const usage = ctx.getContextUsage?.();
    if (usage?.contextWindow && usage.contextWindow > 0) return usage.contextWindow;
    const m = ctx.model as { contextWindow?: number } | undefined;
    return m?.contextWindow ?? 0;
  }

  function configFor(ctx: ExtensionContext): Config {
    return resolveConfig(adapterRef, liveContextLimit(ctx));
  }

  async function stateFor(ctx: ExtensionContext) {
    const sm = ctx.sessionManager;
    const state = await store.load(sm.getSessionFile() ?? undefined, sm.getSessionId());
    const entries = readContextEntries(sm);
    return { state, coreMessages: entriesToCoreMessages(entries), entries };
  }

  async function save(state: CompressionState, ctx: ExtensionContext) {
    const sm = ctx.sessionManager;
    await store.save(state, sm.getSessionFile() ?? undefined, sm.getSessionId());
  }

  return { core, store, get adapter() { return adapterRef; }, setAdapter: (a) => { adapterRef = a; }, markNudgeShown: (k) => { nudgeShownTurns.add(k); }, nudgeShownFor: (k) => nudgeShownTurns.has(k), clearNudgeTracking: () => { nudgeShownTurns.clear(); }, liveContextLimit, configFor, stateFor, save, acquireLock };
}
