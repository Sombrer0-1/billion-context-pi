import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { debug, logInfo, logWarn } from "./log.js";

declare const CURRENT_VERSION: string;

const PACKAGE_NAME = "billion-context-pi";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;
const CHECK_INTERVAL_MS = 3 * 60 * 1000;
// Resolved lazily (not at module load) so tests can redirect it via env at any
// time. Without this, parallel test processes race on the real file under the
// user's home dir: one process stamps the throttle timestamp while another has
// just deleted it, making the victim's check skip "npm view" entirely.
const throttleFile = () =>
  process.env.ACP_UPDATE_THROTTLE_FILE ?? join(homedir(), CONFIG_DIR_NAME, "agent", ".billion-context-pi-update-check");

// Guards against concurrent checks: the context event fires on every LLM call,
// so several can race past the throttle read before any writes the timestamp.
let updateInFlight = false;

export type NpmRunner = (
  args: string[],
  opts: { cwd?: string; timeout: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runNpm: NpmRunner = async (args, opts) => {
  return new Promise((resolve) => {
    execFile(
      "npm",
      args,
      { ...opts, shell: process.platform === "win32", maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({
          code: err ? 1 : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        }),
    );
  });
};

let runNpmImpl: NpmRunner = runNpm;

export function setRunNpmForTest(impl: NpmRunner): void {
  runNpmImpl = impl;
}

function parseVersion(v: string): number[] {
  return v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
}

export function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

async function readLastCheck(): Promise<number> {
  try {
    const data = await readFile(throttleFile(), "utf-8");
    return parseInt(data.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function writeLastCheck(timestamp: number): Promise<void> {
  try {
    await mkdir(dirname(throttleFile()), { recursive: true });
    await writeFile(throttleFile(), String(timestamp), "utf-8");
  } catch {
    // best-effort
  }
}

type PackageJson = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
};

async function readPackageJson(path: string): Promise<PackageJson | undefined> {
  try {
    const data = JSON.parse(await readFile(path, "utf-8"));
    return data && typeof data === "object" ? (data as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

export function findNpmRoot(extDir: string): string | undefined {
  let dir = dirname(extDir);
  for (;;) {
    if (dir.endsWith("node_modules")) return dirname(dir);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function findExtensionDir(): Promise<string | undefined> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = await readPackageJson(join(dir, "package.json"));
    if (pkg?.name === PACKAGE_NAME) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function autoInstallLatest(latest: string): Promise<boolean> {
  // Defense against a poisoned/MITM registry: only accept a strict semver,
  // then pass args as an array to execFile (never via a shell string) so the
  // version can never be interpreted as a command even if it slipped through.
  if (!SEMVER_RE.test(latest)) return false;
  const extDir = await findExtensionDir();
  if (!extDir) {
    logWarn("update", { event: "install-skip", reason: "extension-dir-not-found" });
    return false;
  }
  const npmDir = findNpmRoot(extDir);
  if (!npmDir) {
    logWarn("update", { event: "install-skip", reason: "not-under-node-modules", extDir });
    return false;
  }

  try {
    const { code, stderr } = await runNpmImpl(
      ["install", `${PACKAGE_NAME}@${latest}`, "--silent", "--no-audit", "--no-fund"],
      { cwd: npmDir, timeout: 60_000 },
    );
    if (code !== 0) {
      logWarn("update", {
        event: "auto-install-failed",
        latest,
        npmDir,
        stderr: stderr.trim().slice(-2000),
      });
    }
    return code === 0;
  } catch (e) {
    logWarn("update", {
      event: "auto-install-error",
      latest,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

async function fetchLatestVersion(): Promise<string | undefined> {
  // Prefer `npm view`: it honors the user's registry/proxy/auth config (mirrors,
  // corporate proxies) — the same toolchain as the install step. A direct fetch
  // to registry.npmjs.org fails on machines that only reach npm via a mirror or
  // proxy (Node fetch ignores HTTP_PROXY/HTTPS_PROXY).
  try {
    const { code, stdout } = await runNpmImpl(["view", PACKAGE_NAME, "version"], {
      timeout: 20_000,
    });
    if (code === 0) {
      const v = stdout
        .trim()
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .pop();
      if (v && SEMVER_RE.test(v)) return v;
    }
  } catch {
  }
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      logWarn("update", { event: "check-http", status: res.status });
      return undefined;
    }
    const data = (await res.json()) as { version?: string };
    return data.version;
  } catch (e) {
    logWarn("update", {
      event: "check-fetch-error",
      error: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
}

export async function checkForUpdate(
  autoUpdate: boolean,
  notify?: (msg: string) => void,
): Promise<void> {
  const envFlag = process.env.ACP_AUTO_UPDATE?.trim().toLowerCase();
  if (
    !autoUpdate ||
    envFlag === "0" ||
    envFlag === "false" ||
    envFlag === "no" ||
    envFlag === "off"
  ) {
    return;
  }
  if (updateInFlight) return;
  updateInFlight = true;
  try {
    const now = Date.now();
    const lastCheck = await readLastCheck();
    if (now - lastCheck < CHECK_INTERVAL_MS) return;

    await writeLastCheck(now);

    const runtimeVersion = await getRuntimeVersion();
    const latest = await fetchLatestVersion();
    if (!latest) return;

    const current = runtimeVersion ?? CURRENT_VERSION;
    const hasUpdate = isNewer(latest, current);
    debug.event("update-check", {
      current,
      latest,
      hasUpdate,
    });
    logInfo("update", { event: "check", current, latest, hasUpdate });

    if (hasUpdate) {
      const installed = await autoInstallLatest(latest);
      if (installed && notify) {
        notify(
          `\x1b[32m\u2714 ACP auto-updated ${current} \u2192 ${latest}. Restart Pi to finish.\x1b[0m`,
        );
        logInfo("update", { event: "auto-installed", from: current, to: latest });
      } else if (!installed && notify) {
        notify(
          `${PACKAGE_NAME} ${latest} available (you have ${current}). Run: pi update --extension npm:${PACKAGE_NAME}`,
        );
      }
    }
  } catch (e) {
    logWarn("update", { event: "check-error", error: e instanceof Error ? e.message : String(e) });
  } finally {
    updateInFlight = false;
  }
}

async function getRuntimeVersion(): Promise<string | undefined> {
  const extDir = await findExtensionDir();
  if (!extDir) return undefined;
  const pkg = await readPackageJson(join(extDir, "package.json"));
  return pkg?.version;
}
