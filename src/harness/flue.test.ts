import { describe, expect, it, vi } from "vitest";

import type { AgentConfig, Event, Session } from "../orchestrator/types.js";
import { HarnessInvocationError } from "./types.js";
import type { ManagedHarnessStateStore } from "./state-store.js";
import {
  deriveFlueProviderConfigFromEnv,
  FlueHarnessAdapter,
  FlueManagedSessionStore,
  mergeFlueProviderConfig,
  type FlueEngine,
} from "./flue.js";

function agent(patch: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agentId: "agt_flue",
    harnessId: "flue",
    model: "anthropic/claude-sonnet-4-6",
    tools: [],
    instructions: "You are concise.",
    permissionPolicy: { type: "always_allow" },
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    version: 1,
    callableAgents: [],
    maxSubagentDepth: 0,
    mcpServers: {},
    thinkingLevel: "medium",
    channels: { telegram: { enabled: false } },
    ...patch,
  };
}

function session(patch: Partial<Session> = {}): Session {
  return {
    sessionId: "ses_flue",
    agentId: "agt_flue",
    harnessId: "flue",
    nativeSessionId: "ses_flue",
    nativeThreadId: null,
    nativeMetadata: null,
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    lastEventAt: null,
    error: null,
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    ephemeral: false,
    environmentId: null,
    vaultId: null,
    parentSessionId: null,
    remainingSubagentDepth: 0,
    userId: null,
    ...patch,
  };
}

describe("FlueHarnessAdapter", () => {
  it("derives Flue provider settings from OMA-managed provider env", () => {
    expect(
      deriveFlueProviderConfigFromEnv({
        ANTHROPIC_API_KEY: "ant",
        OPENAI_API_KEY: "oa",
        MOONSHOT_API_KEY: "moon",
        GEMINI_API_KEY: "gemini",
      }),
    ).toMatchObject({
      anthropic: { apiKey: "ant" },
      openai: { apiKey: "oa" },
      "openai-codex": { apiKey: "oa" },
      moonshotai: { apiKey: "moon" },
      "moonshotai-cn": { apiKey: "moon" },
      google: { apiKey: "gemini" },
    });
  });

  it("lets explicit Flue provider config override derived credentials", () => {
    expect(
      mergeFlueProviderConfig(
        {
          openai: {
            apiKey: "derived",
            headers: { "x-derived": "1" },
          },
        },
        {
          openai: {
            apiKey: "explicit",
            baseUrl: "https://gateway.example.com/openai",
            headers: { "x-explicit": "1" },
          },
          anthropic: {
            apiKey: "ant",
          },
        },
      ),
    ).toEqual({
      openai: {
        apiKey: "explicit",
        baseUrl: "https://gateway.example.com/openai",
        headers: { "x-derived": "1", "x-explicit": "1" },
      },
      anthropic: {
        apiKey: "ant",
      },
    });
  });

  it("registers the Cloudflare AI binding for cloudflare-prefixed Flue models", async () => {
    const run = vi.fn(async () => new Response([
      `data: ${JSON.stringify({
        id: "chatcmpl_fake",
        model: "@cf/openai/gpt-oss-20b",
        choices: [{ delta: { content: "hi" }, finish_reason: null }],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl_fake",
        model: "@cf/openai/gpt-oss-20b",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"), {
      headers: { "content-type": "text/event-stream" },
    }));
    const adapter = new FlueHarnessAdapter({
      cloudflareAiBinding: { run },
      cloudflareAiGateway: { id: "test-gateway" },
    });

    const result = await adapter.invokeTurn({
      content: "hello",
      sessionId: "ses_flue_cf",
      timeoutMs: 60_000,
      agent: agent({ model: "cloudflare/@cf/openai/gpt-oss-20b" }),
    });

    expect(result).toMatchObject({
      output: "hi",
      tokensIn: 3,
      tokensOut: 2,
      model: "@cf/openai/gpt-oss-20b",
    });
    expect(run).toHaveBeenCalledWith(
      "@cf/openai/gpt-oss-20b",
      expect.objectContaining({
        stream: true,
        stream_options: { include_usage: true },
      }),
      expect.objectContaining({
        returnRawResponse: true,
        gateway: { id: "test-gateway" },
      }),
    );
  });

  it("runs prompt turns through an injected native Flue engine", async () => {
    const prompt = vi.fn<FlueEngine["prompt"]>(async (args) => ({
      text: `echo: ${args.content}`,
      usage: { input: 11, output: 7, cost: { total: 0.012 } },
      model: { id: args.model ?? args.agent.model },
      events: [
        {
          type: "run_start",
          runId: "run_01",
          kind: "prompt",
          eventIndex: 0,
        },
        {
          type: "thinking_end",
          content: "short plan",
        },
        {
          type: "tool_start",
          toolName: "bash",
          toolCallId: "tool_1",
          args: { command: "pwd" },
        },
        {
          type: "tool_end",
          toolName: "bash",
          toolCallId: "tool_1",
          result: { stdout: "/workspace" },
          isError: false,
        },
        {
          type: "run_end",
          runId: "run_01",
          kind: "prompt",
          status: "completed",
          eventIndex: 3,
        },
      ],
    }));
    const adapter = new FlueHarnessAdapter({ engine: { prompt } });
    const cfg = agent();
    const ses = session();

    const result = await adapter.invokeTurn({
      content: "hello",
      sessionId: ses.sessionId,
      runId: "run_managed_1",
      timeoutMs: 60_000,
      agent: cfg,
      session: ses,
      model: "anthropic/claude-opus-4-7",
      thinkingLevel: "high",
    });

    expect(adapter.runtimeMode).toBe("native");
    expect(prompt).toHaveBeenCalledWith({
      content: "hello",
      sessionId: ses.sessionId,
      runId: "run_managed_1",
      timeoutMs: 60_000,
      signal: expect.any(AbortSignal),
      agent: cfg,
      session: ses,
      model: "anthropic/claude-opus-4-7",
      thinkingLevel: "high",
    });
    expect(result).toMatchObject({
      output: "echo: hello",
      tokensIn: 11,
      tokensOut: 7,
      model: "anthropic/claude-opus-4-7",
    });
    expect(result.native).toMatchObject({
      nativeSessionId: ses.sessionId,
      nativeMetadata: { harness: "flue", runId: "run_managed_1" },
    });
    expect(result.events?.map((event) => event.type)).toEqual([
      "user.message",
      "session.run_start",
      "agent.thinking",
      "agent.tool_use",
      "agent.tool_result",
      "session.run_end",
      "agent.message",
    ]);
    expect(result.events?.find((event) => event.type === "session.run_start")).toMatchObject({
      runId: "run_01",
      runKind: "prompt",
      eventIndex: 0,
    });
    expect(result.events?.find((event) => event.type === "session.run_end")).toMatchObject({
      runId: "run_01",
      runKind: "prompt",
      runStatus: "completed",
      eventIndex: 3,
      isError: false,
    });
    const createdAts = result.events?.map((event) => event.createdAt) ?? [];
    expect(createdAts).toEqual([...createdAts].sort((a, b) => a - b));
    expect(result.events?.at(-1)).toMatchObject({
      type: "agent.message",
      content: "echo: hello",
      runId: "run_managed_1",
      tokensIn: 11,
      tokensOut: 7,
      costUsd: 0.012,
      model: "anthropic/claude-opus-4-7",
    });
  });

  it("fails loudly instead of silently ignoring OMA agent.tools", async () => {
    const adapter = new FlueHarnessAdapter({
      engine: {
        prompt: vi.fn(async () => ({ text: "unused" })),
      },
    });

    await expect(
      adapter.invokeTurn({
        content: "hello",
        sessionId: "ses_flue",
        timeoutMs: 60_000,
        agent: agent({ tools: ["calculator"] }),
      }),
    ).rejects.toThrow(HarnessInvocationError);
  });

  it("aborts active prompt turns through AbortSignal", async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let signal: AbortSignal | undefined;
    const adapter = new FlueHarnessAdapter({
      engine: {
        prompt: vi.fn((args) => {
          signal = args.signal;
          resolveStarted();
          return new Promise<never>((_resolve, reject) => {
            if (!signal) {
              reject(new Error("missing signal"));
              return;
            }
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener("abort", () => reject(signal?.reason), {
              once: true,
            });
          });
        }),
      },
    });

    const turn = adapter.invokeTurn({
      content: "hello",
      sessionId: "ses_flue",
      timeoutMs: 60_000,
      agent: agent(),
    });
    await started;

    await adapter.abortSession(undefined, "ses_flue");

    expect(signal?.aborted).toBe(true);
    await expect(turn).rejects.toThrow("OMA cancelled Flue session ses_flue");
  });

  it("remembers cancellation that arrives before the prompt handle starts", async () => {
    const adapter = new FlueHarnessAdapter({
      engine: {
        prompt: vi.fn((args) => {
          if (args.signal?.aborted) {
            return Promise.reject(args.signal.reason);
          }
          return Promise.resolve({ text: "unused" });
        }),
      },
    });

    await adapter.abortSession(undefined, "ses_flue");

    await expect(
      adapter.invokeTurn({
        content: "hello",
        sessionId: "ses_flue",
        timeoutMs: 60_000,
        agent: agent(),
      }),
    ).rejects.toThrow("OMA cancelled Flue session ses_flue");
  });

  it("streams prompt chunks through an injected native Flue engine", async () => {
    async function* chunks(): AsyncGenerator<string, void, void> {
      yield JSON.stringify({
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
      });
      yield "[DONE]";
    }
    async function* liveEvents(): AsyncGenerator<Event, void, void> {
      yield {
        eventId: "evt_live_user",
        sessionId: "ses_flue",
        type: "user.message",
        content: "hello",
        createdAt: 1,
      };
    }
    const abort = vi.fn(async () => {});
    const result = {
      output: "hi",
      tokensIn: 3,
      tokensOut: 2,
      model: "anthropic/claude-sonnet-4-6",
    };
    const adapter = new FlueHarnessAdapter({
      engine: {
        prompt: vi.fn(async () => ({ text: "unused" })),
        stream: vi.fn(async () => ({
          chunks: chunks(),
          liveEvents: liveEvents(),
          result,
          abort,
        })),
      },
    });

    expect(adapter.capabilities.streaming.support).toBe("partial");
    expect(adapter.capabilities.cancellation.support).toBe("partial");
    const stream = await adapter.invokeStreamingTurn({
      content: "hello",
      sessionId: "ses_flue",
      timeoutMs: 60_000,
      agent: agent(),
    });

    const streamed: string[] = [];
    for await (const chunk of stream.chunks) streamed.push(chunk);
    const events = [];
    for await (const event of stream.liveEvents ?? (async function* () {})()) {
      events.push(event);
    }

    expect(streamed.at(-1)).toBe("[DONE]");
    expect(events).toHaveLength(1);
    expect(stream.result).toBe(result);
  });

  it("fails loudly when an injected Flue engine does not expose streaming", async () => {
    const adapter = new FlueHarnessAdapter({
      engine: {
        prompt: vi.fn(async () => ({ text: "unused" })),
      },
    });

    await expect(
      adapter.invokeStreamingTurn({
        content: "hello",
        sessionId: "ses_flue",
        timeoutMs: 60_000,
        agent: agent(),
      }),
    ).rejects.toThrow("Flue engine does not expose streaming prompt calls");
  });
});

describe("FlueManagedSessionStore", () => {
  it("scopes Flue storage keys under the OMA managed session", async () => {
    const saved = new Map<string, unknown>();
    const stateStore: ManagedHarnessStateStore = {
      async save(args) {
        saved.set(JSON.stringify({
          harnessId: args.harnessId,
          agentId: args.agentId,
          sessionId: args.sessionId,
          key: args.key,
        }), args.value);
      },
      async load(args) {
        return saved.get(JSON.stringify(args)) ?? null;
      },
      async delete(args) {
        saved.delete(JSON.stringify(args));
      },
      async deleteBySession() {},
    };
    const store = new FlueManagedSessionStore(stateStore, "agt_1", "ses_1");

    await store.save("agent:agt_1:task:ses_1:t1", { version: 2 });

    await expect(store.load("agent:agt_1:task:ses_1:t1")).resolves.toEqual({
      version: 2,
    });
    await store.delete("agent:agt_1:task:ses_1:t1");
    await expect(store.load("agent:agt_1:task:ses_1:t1")).resolves.toBeNull();
  });
});
