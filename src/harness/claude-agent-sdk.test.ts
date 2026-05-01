import { describe, expect, it } from "vitest";
import { ClaudeAgentSdkHarnessAdapter } from "./claude-agent-sdk.js";
import { InMemoryStore } from "../store/memory.js";

describe("ClaudeAgentSdkHarnessAdapter", () => {
  it("builds a Claude Agent SDK adapter container with persisted Claude config", () => {
    const store = new InMemoryStore();
    const adapter = new ClaudeAgentSdkHarnessAdapter({
      runtimeImage: "open-managed-agents/claude-agent-sdk-agent:test",
      hostStateRoot: "/host/state",
      stateRoot: "/tmp/oma-claude-agent-sdk-test",
      network: "oma-net",
      gatewayPort: 18789,
      passthroughEnv: { ANTHROPIC_API_KEY: "sk-ant-test" },
      environments: store.environments,
    });

    const agent = store.agents.create({
      harnessId: "claude-agent-sdk",
      model: "anthropic/claude-sonnet-4-6",
      tools: ["shell", "file"],
      instructions: "be concise",
      permissionPolicy: { type: "always_ask" },
      thinkingLevel: "medium",
    });
    const session = store.sessions.create({
      agentId: agent.agentId,
      harnessId: "claude-agent-sdk",
      sessionId: "ses_claude_sdk",
    });

    const spawn = adapter.buildSpawnOptions({
      agent,
      session,
      sessionId: session.sessionId,
    });

    expect(spawn.image).toBe("open-managed-agents/claude-agent-sdk-agent:test");
    expect(spawn.mounts).toEqual([
      {
        hostPath: `/host/state/${agent.agentId}/sessions/ses_claude_sdk`,
        containerPath: "/workspace",
      },
    ]);
    expect(spawn.env).toMatchObject({
      ANTHROPIC_API_KEY: "sk-ant-test",
      OMA_ADAPTER_PROTOCOL: "oma.adapter.v1",
      OMA_ADAPTER_HARNESS_ID: "claude-agent-sdk",
      OMA_ADAPTER_PORT: "18789",
      OPENCLAW_GATEWAY_PORT: "18789",
      OMA_MANAGED_SESSION_ID: "ses_claude_sdk",
      OMA_AGENT_ID: agent.agentId,
      OMA_STATE_DIR: "/workspace",
      OMA_CLAUDE_CWD: "/workspace",
      OMA_CLAUDE_CONFIG_DIR: "/workspace/.claude",
      CLAUDE_CONFIG_DIR: "/workspace/.claude",
    });
    expect(spawn.labels).toMatchObject({
      "orchestrator-harness-id": "claude-agent-sdk",
      "orchestrator-session-id": "ses_claude_sdk",
    });
    expect(adapter.modelForUsage("anthropic/claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });
});
