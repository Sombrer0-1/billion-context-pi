import { promises as fs } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

const ENV_DEBUG = process.env.ACP_DEBUG === "1" || process.env.ACP_DEBUG === "true";
const LOG_FILE = process.env.ACP_LOG_FILE ?? path.join(homedir(), ".pi", "acp-debug.log");

let runtimeDebug: boolean | null = null;
let initialized = false;

/** Toggle debug at runtime from config (config.debug takes precedence over the
 *  env var when set). Called once during session_start. */
export function setDebugEnabled(enabled: boolean): void {
  runtimeDebug = enabled;
}

function debugOn(): boolean {
  return runtimeDebug ?? ENV_DEBUG;
}

async function write(line: string): Promise<void> {
  if (!debugOn()) return;
  if (!initialized) {
    initialized = true;
    await fs.mkdir(path.dirname(LOG_FILE), { recursive: true }).catch(() => {});
  }
  await fs.appendFile(LOG_FILE, line, "utf8").catch(() => {});
}

export const debug = {
  get enabled(): boolean {
    return debugOn();
  },
  get logFile(): string {
    return LOG_FILE;
  },
  event(scope: string, fields: Record<string, unknown>): void {
    if (!debugOn()) return;
    const ts = new Date().toISOString();
    const body = Object.entries(fields)
      .map(([k, v]) => `${k}=${fmt(v)}`)
      .join(" ");
    void write(`${ts} [${scope}] ${body}\n`);
  },
};

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    try {
      return JSON.stringify(v);
    } catch {
      return `[${v.length}]`;
    }
  }
  if (v && typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}
