import { describe, expect, it, vi } from "vitest";

import type { AgentConfig, Session } from "../orchestrator/types.js";
import { HarnessControlError, HarnessInvocationError } from "./types.js";
import { FlueHarnessAdapter, type FlueEngine } from "./flue.js";

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
  it("runs prompt turns through an injected native Flue engine", async () => {
    const prompt = vi.fn<FlueEngine["prompt"]>(async (args) => ({
      text: `echo: ${args.content}`,
      usage: { input: 11, output: 7, cost: { total: 0.012 } },
      model: { id: args.model ?? args.agent.model },
      events: [
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
      ],
    }));
    const adapter = new FlueHarnessAdapter({ engine: { prompt } });
    const cfg = agent();
    const ses = session();

    const result = await adapter.invokeTurn({
      content: "hello",
      sessionId: ses.sessionId,
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
      timeoutMs: 60_000,
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
      nativeMetadata: { harness: "flue" },
    });
    expect(result.events?.map((event) => event.type)).toEqual([
      "user.message",
      "agent.thinking",
      "agent.tool_use",
      "agent.tool_result",
      "agent.message",
    ]);
    const createdAts = result.events?.map((event) => event.createdAt) ?? [];
    expect(createdAts).toEqual([...createdAts].sort((a, b) => a - b));
    expect(result.events?.at(-1)).toMatchObject({
      type: "agent.message",
      content: "echo: hello",
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

  it("does not claim streaming or managed cancellation before they are wired", async () => {
    const adapter = new FlueHarnessAdapter({
      engine: {
        prompt: vi.fn(async () => ({ text: "unused" })),
      },
    });

    expect(adapter.capabilities.streaming.support).toBe("unsupported");
    expect(adapter.capabilities.cancellation.support).toBe("unsupported");
    await expect(
      adapter.invokeStreamingTurn({
        content: "hello",
        sessionId: "ses_flue",
        timeoutMs: 60_000,
        agent: agent(),
      }),
    ).rejects.toThrow(HarnessInvocationError);
    await expect(adapter.abortSession({}, "ses_flue")).rejects.toThrow(
      HarnessControlError,
    );
  });
});
