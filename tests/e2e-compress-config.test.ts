import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRuntime } from "../src/runtime.js";
import { loadUserConfig, applyUserConfig } from "../src/user-config.js";

// E2E for the three-level compress cascade: writes a REAL acp.json and drives
// the REAL production pipeline (loadUserConfig → applyUserConfig → setAdapter →
// configFor, the exact functions wired at src/index.ts:71-72,117), as opposed
// to the resolveCompress unit tests in config.test.ts.

function ctxFor(provider: string | undefined, id: string | undefined, contextWindow: number): ExtensionContext {
    return { model: { provider, id, contextWindow } } as unknown as ExtensionContext;
}

const ACP_JSON = {
    compress: {
        maxContextLimit: "75%",
        emergencyThresholdPercent: "92%",
        nudgeGrowthTokens: 50000,
        providers: {
            anthropic: {
                maxContextLimit: "80%",
                models: {
                    "claude-sonnet-4-5": { maxContextLimit: "70%", nudgeGrowthTokens: 30000 },
                },
            },
        },
    },
};

async function withConfigDir(json: unknown, fn: (cwd: string) => Promise<void>): Promise<void> {
    const cwd = await mkdtemp(join(tmpdir(), "pai-acp-e2e-compress-"));
    if (json !== undefined) {
        await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
        await writeFile(join(cwd, CONFIG_DIR_NAME, "acp.json"), JSON.stringify(json));
    }
    try {
        await fn(cwd);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
}

test("e2e compress config: acp.json provider/model overrides take effect through the real pipeline", async () => {
    await withConfigDir(ACP_JSON, async (cwd) => {
        const user = await loadUserConfig(cwd);
        assert.ok(user.compress, "acp.json compress block loaded from disk");

        const runtime = createRuntime({});
        runtime.setAdapter(applyUserConfig(runtime.adapter, user));

        const sonnet = runtime.configFor(ctxFor("anthropic", "claude-sonnet-4-5", 200_000));
        assert.equal(sonnet.nudge.maxContextLimitPct, 0.7, "model-level maxContextLimit 70% reaches the kernel");
        assert.equal(sonnet.nudge.growthFloor, 30000, "model-level nudgeGrowthTokens reaches the kernel");
        assert.equal(sonnet.nudge.growthCap, 30000);
        assert.equal(sonnet.nudge.emergencyThresholdPct, 0.92, "global emergencyThresholdPercent inherited (model omitted it)");
        assert.equal(sonnet.truncate.threshold, 0.92);

        const haiku = runtime.configFor(ctxFor("anthropic", "claude-haiku", 200_000));
        assert.equal(haiku.nudge.maxContextLimitPct, 0.8, "provider-level maxContextLimit 80% for an unlisted anthropic model");
        assert.equal(haiku.nudge.growthFloor, 50000, "global nudgeGrowthTokens inherited at the provider level");

        const openai = runtime.configFor(ctxFor("openai", "gpt-4o", 128_000));
        assert.equal(openai.nudge.maxContextLimitPct, 0.75, "unknown provider falls back to global 75%");
        assert.equal(openai.nudge.emergencyThresholdPct, 0.92);
        assert.equal(openai.modelContextLimit, 128_000, "live model context window passed through");
    });
});

test("e2e compress config: a single runtime resolves differently per model (proves per-turn, not static)", async () => {
    await withConfigDir(ACP_JSON, async (cwd) => {
        const runtime = createRuntime({});
        runtime.setAdapter(applyUserConfig(runtime.adapter, await loadUserConfig(cwd)));
        const sonnet = runtime.configFor(ctxFor("anthropic", "claude-sonnet-4-5", 200_000));
        const haiku = runtime.configFor(ctxFor("anthropic", "claude-haiku", 200_000));
        const openai = runtime.configFor(ctxFor("openai", "gpt-4o", 200_000));
        assert.notEqual(sonnet.nudge.maxContextLimitPct, haiku.nudge.maxContextLimitPct, "sonnet (70%) != haiku (80%)");
        assert.notEqual(haiku.nudge.maxContextLimitPct, openai.nudge.maxContextLimitPct, "haiku (80%) != openai (75%)");
    });
});

test("e2e compress config: without a config file the kernel defaults apply", async () => {
    const savedHome = process.env.HOME;
    await withConfigDir(undefined, async (cwd) => {
        process.env.HOME = cwd;
        const user = await loadUserConfig(cwd);
        assert.deepEqual(user, {}, "no acp.json anywhere (HOME + cwd) → empty user config");
        const runtime = createRuntime({});
        runtime.setAdapter(applyUserConfig(runtime.adapter, user));
        const cfg = runtime.configFor(ctxFor("anthropic", "claude-sonnet-4-5", 200_000));
        assert.equal(cfg.nudge.maxContextLimitPct, 0.75, "kernel default maxContextLimitPct");
        assert.equal(cfg.nudge.emergencyThresholdPct, 0.95, "kernel default emergencyThresholdPct");
        assert.equal(cfg.nudge.growthFloor, 50000, "kernel default growthFloor");
    });
    process.env.HOME = savedHome;
});
