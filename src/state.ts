import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createInitialState, type CompressionState } from "acp-kernel";

const STATE_SUFFIX = ".acp.json";

function stateFileFor(sessionFile: string | undefined): string | null {
  if (sessionFile) return sessionFile + STATE_SUFFIX;
  // No session file (--no-session, e.g. delegate children): state is ephemeral,
  // do NOT persist. Previously this fell back to process.cwd() and polluted
  // the parent's working directory with .acp-<sid>.json litter.
  return null;
}

export class SessionStateStore {
  private cache: CompressionState | null = null;
  private loadedKey: string | null = null;

  async load(sessionFile: string | undefined, _sessionId: string): Promise<CompressionState> {
    const file = stateFileFor(sessionFile);
    if (file && this.loadedKey === file && this.cache) return this.cache;
    let state = createInitialState();
    if (file) {
      try {
        const raw = await fs.readFile(file, "utf8");
        const parsed = JSON.parse(raw) as CompressionState;
        if (parsed && Array.isArray(parsed.blocks)) state = mergeInitialState(parsed);
      } catch {
        // missing/corrupt file -> fresh state
      }
    }
    this.cache = state;
    this.loadedKey = file;
    return state;
  }

  async save(state: CompressionState, sessionFile: string | undefined, _sessionId: string): Promise<void> {
    const file = stateFileFor(sessionFile);
    if (!file) return; // ephemeral session: don't persist
    this.cache = state;
    this.loadedKey = file;
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const tmp = path.join(dir, `.acp-tmp-${path.basename(file)}`);
    await fs.writeFile(tmp, JSON.stringify(state), "utf8");
    await fs.rename(tmp, file);
  }

  invalidate(): void {
    this.cache = null;
    this.loadedKey = null;
  }
}

// Persisted state may predate new fields; fill any gaps so acp-kernel always sees
// a complete CompressionState (forward-compatible load).
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
