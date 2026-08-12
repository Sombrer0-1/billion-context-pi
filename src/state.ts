import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createInitialState, type CompressionState } from "acp-kernel";
import { logError, logWarn } from "./log.js";

const STATE_SUFFIX = ".acp.json";

export interface LiveRefOrigin {
  rawId: string;
  identity: string;
}

interface StateCacheSlot {
  state: CompressionState;
  liveRefOrigins: LiveRefOrigin[];
}

function stateFileFor(sessionFile: string | undefined): string | null {
  if (sessionFile) return sessionFile + STATE_SUFFIX;
  return null;
}

function cacheKey(sessionFile: string | undefined, sessionId: string): string {
  return sessionFile ? `file:${sessionFile}` : `session:${sessionId}`;
}

export class SessionStateStore {
  private cache = new Map<string, StateCacheSlot>();

  async load(sessionFile: string | undefined, sessionId: string): Promise<CompressionState> {
    const file = stateFileFor(sessionFile);
    const key = cacheKey(sessionFile, sessionId);
    const cached = this.cache.get(key);
    if (cached) return cached.state;
    let state = createInitialState();
    let liveRefOrigins: LiveRefOrigin[] = [];
    if (file) {
      try {
        const raw = await fs.readFile(file, "utf8");
        const parsed = JSON.parse(raw) as CompressionState & { liveRefOrigins?: unknown };
        if (parsed && Array.isArray(parsed.blocks)) {
          state = mergeInitialState(parsed);
          liveRefOrigins = parseLiveRefOrigins(parsed.liveRefOrigins);
        }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          logWarn("state", { event: "load-failed", file, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    this.cache.set(key, { state, liveRefOrigins });
    return state;
  }

  async save(state: CompressionState, sessionFile: string | undefined, sessionId: string): Promise<void> {
    const file = stateFileFor(sessionFile);
    if (!file) return;
    const key = cacheKey(sessionFile, sessionId);
    const liveRefOrigins = this.cache.get(key)?.liveRefOrigins ?? [];
    this.cache.set(key, { state, liveRefOrigins });
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true }).catch((e: unknown) => {
      logError("state", { event: "save-mkdir-failed", dir, error: e instanceof Error ? e.message : String(e) });
    });
    const tmp = path.join(dir, `.acp-tmp-${path.basename(file)}`);
    try {
      await fs.writeFile(tmp, JSON.stringify({ ...state, liveRefOrigins }), "utf8");
      await fs.rename(tmp, file);
    } catch (e) {
      logError("state", { event: "save-failed", file, error: e instanceof Error ? e.message : String(e) });
    }
  }

  getLiveRefOrigins(sessionFile: string | undefined, sessionId: string): LiveRefOrigin[] {
    return [...(this.cache.get(cacheKey(sessionFile, sessionId))?.liveRefOrigins ?? [])];
  }

  setLiveRefOrigins(sessionFile: string | undefined, sessionId: string, origins: LiveRefOrigin[]): void {
    const key = cacheKey(sessionFile, sessionId);
    const slot = this.cache.get(key);
    if (slot) this.cache.set(key, { state: slot.state, liveRefOrigins: [...origins] });
  }

  invalidate(): void {
    this.cache.clear();
  }
}

function parseLiveRefOrigins(value: unknown): LiveRefOrigin[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is LiveRefOrigin => {
    if (!item || typeof item !== "object") return false;
    const origin = item as { rawId?: unknown; identity?: unknown };
    return typeof origin.rawId === "string" && typeof origin.identity === "string";
  });
}

function mergeInitialState(parsed: CompressionState): CompressionState {
  const fresh = createInitialState();
  return {
    blocks: parsed.blocks ?? fresh.blocks,
    messageRefs: parsed.messageRefs ?? fresh.messageRefs,
    nudge: { ...fresh.nudge, ...(parsed.nudge ?? {}) },
    stats: { ...fresh.stats, ...(parsed.stats ?? {}) },
    nextBlockId: parsed.nextBlockId ?? fresh.nextBlockId,
    nextRunId: parsed.nextRunId ?? fresh.nextRunId,
  };
}
