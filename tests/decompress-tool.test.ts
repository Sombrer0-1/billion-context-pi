import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpExtension } from "../src/index.js";

function captureApi() {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const api = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
  };
  return { api, handlers };
}

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

async function cleanState(sessionFile: string) {
  await rm(`${sessionFile}.acp.json`, { force: true });
}

function fakeCtx(entries: any[], stateFile: string) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
}

// Shared setup: assign refs + compress m00001 into block b1, return the tool
// handles + ctx so each test can drive the decompress tool.
async function setupWithCompressedBlock() {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);

  const stateFile = "/tmp/pai-acp-decompress-tool-it.session.json";
  await cleanState(stateFile);
  const longText = "This is a detailed message that needs to be compressed. ".repeat(130);
  const filler = (n: string) => `filler ${n} `.repeat(400);
  const entries = [
    userMsg("e1", longText),
    userMsg("e2", filler("two")), userMsg("e3", filler("three")),
    userMsg("e4", filler("four")), userMsg("e5", filler("five")),
    userMsg("e6", filler("six")), userMsg("e7", filler("seven")),
  ];
  const ctx = fakeCtx(entries, stateFile);

  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00001", summary: "Detailed initial context message for the decompress-tool tests." }] },
    undefined, undefined, ctx,
  );

  const decompressTool = api.tools.find((t: any) => t.name === "decompress")!;
  return { decompressTool, ctx };
}

test("decompress default writes content to an auto-generated file (no context bloat)", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  const res = await decompressTool.execute("tc2", { blockId: "b1" }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;

  assert.match(text, /written to/, "result reports a file path");
  assert.match(text, /acp-decompress\/b1-\d+\.txt/, "auto-generated path under ~/.cache/pi/acp-decompress");
  assert.match(text, /stays compressed/, "tells model the block stays compressed");
  assert.match(text, /Preview:/, "includes a head preview");
  // Crucially: the full long content is NOT in the tool result (it's in the file).
  // The result carries only a short head preview + boilerplate, so it must be
  // far smaller than the restored content (which the result itself reports as
  // ~7287 chars).
  assert.ok(text.length < 2000,
    `inline content must NOT be the full restored text (result was ${text.length} chars)`);
});

test("decompress inline:true returns the full content in the tool result", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  const res = await decompressTool.execute("tc3", { blockId: "b1", inline: true }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;

  assert.match(text, /inline:/, "result signals inline mode");
  assert.ok(text.includes("This is a detailed message that needs to be compressed."),
    "full restored content present in the tool result");
});

test("decompress toFile writes to the specified path", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  const dir = await mkdtemp(join(tmpdir(), "pai-acp-decompress-"));
  const target = join(dir, "custom.txt");
  const res = await decompressTool.execute("tc4", { blockId: "b1", toFile: target }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;

  assert.match(text, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "result mentions the custom path");
  const written = await readFile(target, "utf8");
  assert.ok(written.includes("This is a detailed message that needs to be compressed."),
    "file contains the full restored content");
});

test("decompress toFile rejects paths outside allowed roots", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  const res = await decompressTool.execute("tc5", { blockId: "b1", toFile: "/etc/passwd" }, undefined, undefined, ctx);
  const text = (res.content[0] as any).text as string;
  assert.match(text, /must be under/i, "rejects arbitrary filesystem path");
});

test("decompress keeps the block active after a file-mode call", async () => {
  const { decompressTool, ctx } = await setupWithCompressedBlock();
  await decompressTool.execute("tc6", { blockId: "b1" }, undefined, undefined, ctx);
  // Run the status tool to confirm b1 is still folded (active).
  const { api } = captureApi();
  // re-query via the same ctx's persisted state: simpler to just call decompress
  // again — a second file-mode call should succeed identically (block still there).
  const res2 = await decompressTool.execute("tc7", { blockId: "b1" }, undefined, undefined, ctx);
  const text2 = (res2.content[0] as any).text as string;
  assert.doesNotMatch(text2, /not found/i, "block still present after first decompress");
});
