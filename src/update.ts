import { readFile, writeFile, mkdir, access } from "node:fs/promises";
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

export type NodeRunner = (
  args: string[],
  opts: { timeout: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

// Always shell:false: process.execPath is absolute, so no win32 shell quoting
// hazards. Used to smoke-import a freshly installed extension entry.
export const runNode: NodeRunner = (args, opts) => {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { ...opts, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({
          code: err ? 1 : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        }),
    );
  });
};

let runNodeImpl: NodeRunner = runNode;

export function setRunNodeForTest(impl: NodeRunner): void {
  runNodeImpl = impl;
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
  main?: string;
  dependencies?: Record<string, string>;
  exports?: Record<string, string | { import?: string }>;
  pi?: { extensions?: string[] };
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

export type InstallOutcome = "ok" | "failed" | "rolled-back";

// The declared entries pi/loaders may touch: pi's own extension entry, the
// ESM export, and main. All of them must exist on disk after an install.
function declaredEntries(pkg: PackageJson): string[] {
  const dot = pkg.exports?.["."];
  const exportEntry = typeof dot === "string" ? dot : dot?.import;
  return [...new Set([pkg.pi?.extensions?.[0], exportEntry, pkg.main])]
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

// A bad publish (missing dist, syntax error, ABI break) must never strand the
// user: npm's exit code 0 only means "tarball extracted", not "extension
// loads". A broken extension can never load again — and an extension that
// cannot load can never auto-update itself back to health. That is a permanent
// brick, so verify before declaring success: files present, version matches,
// and the entry imports cleanly in a child process.
export async function verifyInstall(
  npmDir: string,
  latest: string,
): Promise<{ ok: boolean; reason?: string }> {
  const dir = join(npmDir, "node_modules", PACKAGE_NAME);
  const pkg = await readPackageJson(join(dir, "package.json"));
  if (!pkg?.version) return { ok: false, reason: "package-json-missing" };
  if (pkg.version !== latest) return { ok: false, reason: `version-mismatch:${pkg.version}` };
  const entries = declaredEntries(pkg);
  if (entries.length === 0) return { ok: false, reason: "no-entry-declared" };
  for (const rel of entries) {
    try {
      await access(join(dir, rel));
    } catch {
      return { ok: false, reason: `entry-missing:${rel}` };
    }
  }
  // Smoke-import the entry pi will actually load. pathToFileURL handles
  // Windows drive letters (a bare "C:\..." import() is parsed as a protocol).
  const smokeEntry = pkg.pi?.extensions?.[0] ?? entries[0];
  if (!smokeEntry) return { ok: false, reason: "no-entry-declared" };
  const entry = join(dir, smokeEntry);
  const SMOKE =
    "const{pathToFileURL}=require('node:url');" +
    "import(pathToFileURL(process.argv[1]).href).then(()=>{}," +
    "(e)=>{console.error(e&&e.stack||e);process.exit(1)})";
  const { code, stderr } = await runNodeImpl(["-e", SMOKE, entry], { timeout: 15_000 });
  if (code !== 0) return { ok: false, reason: `entry-import-failed:${stderr.trim().slice(-500)}` };
  return { ok: true };
}

// extDirOverride exists so tests can point the installer at a fixture layout
// (the test runner itself is never under node_modules, so the real discovery
// always bails at "not-under-node-modules" and the install path would be
// unreachable otherwise).
export async function autoInstallLatest(latest: string, extDirOverride?: string): Promise<InstallOutcome> {
  // Defense against a poisoned/MITM registry: only accept a strict semver,
  // then pass args as an array to execFile (never via a shell string) so the
  // version can never be interpreted as a command even if it slipped through.
  if (!SEMVER_RE.test(latest)) return "failed";
  const extDir = extDirOverride ?? (await findExtensionDir());
  if (!extDir) {
    logWarn("update", { event: "install-skip", reason: "extension-dir-not-found" });
    return "failed";
  }
  const npmDir = findNpmRoot(extDir);
  if (!npmDir) {
    logWarn("update", { event: "install-skip", reason: "not-under-node-modules", extDir });
    return "failed";
  }

  try {
    // --no-save: the host project's package.json/lockfile must never be
    // mutated by an auto-update; node_modules is what pi loads from anyway.
    const installArgs = (v: string) => [
      "install",
      `${PACKAGE_NAME}@${v}`,
      "--silent",
      "--no-audit",
      "--no-fund",
      "--no-save",
    ];
    const prevVersion = (await readPackageJson(join(extDir, "package.json")))?.version ?? CURRENT_VERSION;
    const { code, stderr } = await runNpmImpl(installArgs(latest), { cwd: npmDir, timeout: 60_000 });
    if (code !== 0) {
      logWarn("update", {
        event: "auto-install-failed",
        latest,
        npmDir,
        stderr: stderr.trim().slice(-2000),
      });
      return "failed";
    }
    const verify = await verifyInstall(npmDir, latest);
    if (!verify.ok) {
      // Roll back to what was running before: a broken latest must not sit on
      // disk waiting for the next restart to brick the extension.
      const rollbackTo = SEMVER_RE.test(prevVersion) ? prevVersion : CURRENT_VERSION;
      logWarn("update", { event: "auto-install-verify-failed", latest, reason: verify.reason, rollbackTo });
      const rb = await runNpmImpl(installArgs(rollbackTo), { cwd: npmDir, timeout: 60_000 });
      logInfo("update", { event: "rollback", from: latest, to: rollbackTo, ok: rb.code === 0 });
      return "rolled-back";
    }
    return "ok";
  } catch (e) {
    logWarn("update", {
      event: "auto-install-error",
      latest,
      error: e instanceof Error ? e.message : String(e),
    });
    return "failed";
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
      const outcome = await autoInstallLatest(latest);
      if (outcome === "ok" && notify) {
        notify(
          `\x1b[32m\u2714 ACP auto-updated ${current} \u2192 ${latest}. Restart Pi to finish.\x1b[0m`,
        );
        logInfo("update", { event: "auto-installed", from: current, to: latest });
      } else if (outcome === "rolled-back" && notify) {
        // Tell the user what happened and DO NOT suggest the manual install
        // hint — latest is known broken, and following the hint would brick
        // the extension by hand.
        notify(
          `\x1b[33mACP ${latest} failed verification and was rolled back. Keeping ${current}. A later release will auto-update.\x1b[0m`,
        );
      } else if (notify) {
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
