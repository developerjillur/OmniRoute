import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// NexaLance: Claude Code traffic must reach Anthropic with the user's own words intact.
// The claude executor used to insert U+200D into words such as "cursor" in the system
// prompt, user messages and tool descriptions, changing the submitted code text.
// Other OAuth clients keep the existing compatibility path.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-text-fidelity-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");
const { prepareUpstreamBody } = await import("../../open-sse/handlers/chatCore/upstreamBody.ts");
const { isClaudeCodeOriginatedHeaders } = await import("../../open-sse/config/codexIdentity.ts");
const { setDetectedToolLimit, clearDetectedLimits } =
  await import("../../open-sse/services/toolLimitDetector.ts");
const originalFetch = globalThis.fetch;
const ZWJ = "‍";

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function dispatch(clientHeaders: Record<string, string>): Promise<string> {
  let sent = "";
  globalThis.fetch = (async (_url: unknown, init: { body?: unknown } = {}) => {
    sent = String(init.body ?? "");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    await new DefaultExecutor("claude").execute({
      model: "claude-opus-5",
      stream: false,
      credentials: { accessToken: "sk-ant-oat-test-token" },
      clientHeaders,
      body: {
        model: "claude-opus-5",
        max_tokens: 64,
        system: [{ type: "text", text: "Project uses cursor pagination and the Cline extension." }],
        tools: [
          {
            name: "Edit",
            description: "Replace text; works like a cursor in an editor.",
            input_schema: { type: "object", properties: {} },
          },
        ],
        messages: [
          { role: "user", content: [{ type: "text", text: "Set cursor: pointer on the button." }] },
        ],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  return sent;
}

test("native Claude Code requests reach Anthropic without zero-width joiners", async () => {
  const sent = await dispatch({
    "x-app": "cli",
    "user-agent": "claude-cli/2.1.287 (external, cli)",
  });
  assert.ok(sent.length > 0, "fetch did not capture a request body");
  assert.equal(sent.includes(ZWJ), false, "Claude Code text was obfuscated");
  assert.ok(sent.includes("cursor: pointer"), "user text changed");
  assert.ok(sent.includes("cursor pagination"), "system text changed");
  assert.ok(sent.includes("like a cursor in an editor"), "tool description changed");
});

test("non Claude Code clients on a Claude OAuth account are still obfuscated", async () => {
  const sent = await dispatch({ "user-agent": "some-other-agent/1.0" });
  assert.ok(sent.includes(ZWJ), "obfuscation for other clients was removed");
});

test("native Claude tool lists do not inherit the unrelated default 128-tool cap", async () => {
  const tools = Array.from({ length: 150 }, (_, i) => ({
    name: `native_tool_${i}`,
    description: "Tool",
    input_schema: { type: "object", properties: {} },
  }));
  const body = await prepareUpstreamBody({
    translatedBody: { model: "claude-opus-5-5", tools },
    modelToCall: "claude-opus-5-5",
    provider: "claude",
    targetFormat: "claude",
    credentials: null,
    clientRawRequest: {
      headers: { "x-app": "cli", "user-agent": "claude-cli/2.1.287 (external, cli)" },
    },
  });
  assert.deepEqual(body.tools, tools);
});

test("a detected provider tool cap does not silently remove native tools", async () => {
  setDetectedToolLimit("claude", 1);
  try {
    const tools = ["Read", "Edit"].map((name) => ({
      name,
      input_schema: { type: "object", properties: {} },
    }));
    const body = await prepareUpstreamBody({
      translatedBody: { tools },
      modelToCall: "claude-opus-5-5",
      provider: "claude",
      targetFormat: "claude",
      credentials: null,
      clientRawRequest: { headers: { "User-Agent": "claude-cli/2.1.287 (external, cli)" } },
    });
    assert.deepEqual(body.tools, tools);
  } finally {
    clearDetectedLimits();
  }
});

test("official CLI identity is recognized without treating arbitrary CLI clients as Claude", () => {
  assert.equal(
    isClaudeCodeOriginatedHeaders({ "User-Agent": "claude-cli/2.1.287 (external, cli)" }),
    true
  );
  assert.equal(
    isClaudeCodeOriginatedHeaders({ "user-agent": "another-cli/1", "x-app": "cli" }),
    false
  );
});
