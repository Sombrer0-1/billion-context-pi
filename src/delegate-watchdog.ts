import type { Readable } from "node:stream";

export interface WatchdogOptions {
  eofGraceMs: number;
  idleMs: number;
  timeoutMs: number;
  killGraceMs: number;
}

export interface WatchdogHooks {
  /** True once the run is finalized; watchdogs stop firing. */
  isSettled(): boolean;
  /** The child is about to be killed (SIGTERM). reason explains why. */
  onKill(reason: string): void;
  /** stdout EOF passed without the process exiting; force-finalize now. */
  onEofGrace(): void;
}

export interface WatchdogHandle {
  /** Re-arm the idle timer (call on every stdout data). */
  poke(): void;
  /** Stop all timers (call on finalize). */
  dispose(): void;
}

/**
 * Guarantees a hung child process gets killed. A stuck child holds its stdout
 * fd open, so stdout EOF never fires — hence the idle timer (no output for
 * idleMs) is the main defense; the hard time limit and the EOF grace period
 * cover the rest. Kill is SIGTERM, escalated to SIGKILL after killGraceMs.
 */
export function attachWatchdogs(
  child: { kill(signal: NodeJS.Signals): boolean; stdout: Readable | null },
  hooks: WatchdogHooks,
  opts: WatchdogOptions,
): WatchdogHandle {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let eofTimer: ReturnType<typeof setTimeout> | undefined;
  let killGraceTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (eofTimer) clearTimeout(eofTimer);
    if (killGraceTimer) clearTimeout(killGraceTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
  };

  const killByWatchdog = (reason: string): void => {
    if (hooks.isSettled()) return;
    hooks.onKill(reason);
    try {
      child.kill("SIGTERM");
    } catch {
      /* best-effort */
    }
    killGraceTimer = setTimeout(() => {
      if (hooks.isSettled()) return;
      try {
        child.kill("SIGKILL");
      } catch {
        /* best-effort */
      }
    }, opts.killGraceMs);
    killGraceTimer.unref?.();
  };

  const poke = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => killByWatchdog(`no output for ${opts.idleMs / 60_000}m`), opts.idleMs);
    idleTimer.unref?.();
  };

  poke();
  timeoutTimer = setTimeout(() => killByWatchdog(`${opts.timeoutMs / 60_000}m limit`), opts.timeoutMs);
  timeoutTimer.unref?.();

  const onStdoutEnd = (): void => {
    if (hooks.isSettled()) return;
    eofTimer = setTimeout(() => {
      if (hooks.isSettled()) return;
      hooks.onEofGrace();
      try {
        child.kill("SIGTERM");
      } catch {
        /* best-effort */
      }
    }, opts.eofGraceMs);
    eofTimer.unref?.();
  };
  child.stdout?.once("end", onStdoutEnd);

  return {
    poke,
    dispose: () => {
      clearTimers();
      child.stdout?.removeListener("end", onStdoutEnd);
    },
  };
}
