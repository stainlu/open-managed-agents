import { afterEach, describe, expect, it, vi } from "vitest";
import { adapterServerControlPlane, invokeAdapterServerTurn } from "./adapter-server-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("adapter-server client", () => {
  it("posts oma.adapter.v1 turn requests and maps usage/native metadata", async () => {
    let capturedBody: unknown;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        protocol_version: "oma.adapter.v1",
        output: "done",
        usage: { tokens_in: 11, tokens_out: 7, model: "deepseek/v4" },
        native: {
          native_session_id: "hermes-ses",
          native_thread_id: "thread-1",
          native_metadata: { checkpoint: 2 },
        },
        events: [],
      }), { status: 200 });
    }));

    const result = await invokeAdapterServerTurn({
      baseUrl: "http://adapter",
      token: "tok",
      content: "hello",
      sessionId: "ses_123",
      timeoutMs: 60_000,
      agent: {
        agentId: "agt_123",
        harnessId: "hermes",
        model: "deepseek/v4",
        tools: ["terminal"],
        instructions: "be concise",
        permissionPolicy: { type: "always_allow" },
        createdAt: 1,
        updatedAt: 1,
        archivedAt: null,
        version: 1,
        callableAgents: [],
        maxSubagentDepth: 0,
        mcpServers: {},
        thinkingLevel: "off",
        channels: { telegram: { enabled: false } },
      },
      session: {
        sessionId: "ses_123",
        agentId: "agt_123",
        harnessId: "hermes",
        nativeSessionId: null,
        nativeThreadId: null,
        nativeMetadata: null,
        environmentId: null,
        status: "running",
        ephemeral: false,
        remainingSubagentDepth: 0,
        turns: 1,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        error: null,
        createdAt: 1,
        lastEventAt: null,
        vaultId: null,
        parentSessionId: null,
        userId: null,
      },
    });

    expect(capturedBody).toMatchObject({
      protocol_version: "oma.adapter.v1",
      session: { managed_session_id: "ses_123" },
      agent: { harness_id: "hermes", model: "deepseek/v4" },
      turn: { content: "hello", stream: false },
    });
    expect(result).toEqual({
      output: "done",
      tokensIn: 11,
      tokensOut: 7,
      model: "deepseek/v4",
      events: [],
      native: {
        nativeSessionId: "hermes-ses",
        nativeThreadId: "thread-1",
        nativeMetadata: { checkpoint: 2 },
      },
    });
  });

  it("rejects readyz harness mismatches at control-connect time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        protocol_version: "oma.adapter.v1",
        harness_id: "codex",
        capabilities: {
          streaming: true,
          cancel: true,
          interrupt: true,
          tool_approvals: false,
          mcp: false,
          dynamic_model_patch: false,
          compaction: false,
          native_session_resume: true,
          usage: true,
          subagents: false,
        },
      }), { status: 200 }),
    ));

    await expect(adapterServerControlPlane("hermes").connect({
      id: "cnt_1",
      name: "adapter",
      baseUrl: "http://adapter",
      token: "tok",
    })).rejects.toThrow(/harness mismatch/);
  });
});
