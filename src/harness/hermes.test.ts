import { describe, expect, it } from "vitest";
import { HermesHarnessAdapter } from "./hermes.js";
import { InMemoryStore } from "../store/memory.js";

describe("HermesHarnessAdapter", () => {
  it("builds a generic adapter-server container instead of OpenClaw-specific config", () => {
    const store = new InMemoryStore();
    const adapter = new HermesHarnessAdapter({
      runtimeImage: "open-managed-agents/hermes-agent:test",
      hostStateRoot: "/host/state",
      stateRoot: "/tmp/oma-hermes-test",
      network: "oma-net",
      gatewayPort: 18789,
      passthroughEnv: { OPENAI_API_KEY: "sk-test" },
      environments: store.environments,
    });

    const agent = store.agents.create({
      harnessId: "hermes",
      model: "deepseek/v4",
      tools: ["terminal"],
      instructions: "be concise",
      permissionPolicy: { type: "always_ask" },
      thinkingLevel: "off",
    });
    const session = store.sessions.create({
      agentId: agent.agentId,
      harnessId: "hermes",
      sessionId: "ses_123",
    });

    const spawn = adapter.buildSpawnOptions({
      agent,
      session,
      sessionId: session.sessionId,
    });

    expect(spawn.image).toBe("open-managed-agents/hermes-agent:test");
    expect(spawn.mounts).toEqual([
      {
        hostPath: `/host/state/${agent.agentId}/sessions/ses_123`,
        containerPath: "/workspace",
      },
    ]);
    expect(spawn.env).toMatchObject({
      OPENAI_API_KEY: "sk-test",
      OMA_ADAPTER_PROTOCOL: "oma.adapter.v1",
      OMA_ADAPTER_HARNESS_ID: "hermes",
      OMA_ADAPTER_PORT: "18789",
      OPENCLAW_GATEWAY_PORT: "18789",
      OMA_MANAGED_SESSION_ID: "ses_123",
      OMA_AGENT_ID: agent.agentId,
      HERMES_HOME: "/workspace/.hermes",
      TERMINAL_ENV: "local",
      HERMES_INTERACTIVE: "1",
    });
    expect(spawn.labels).toMatchObject({
      "orchestrator-harness-id": "hermes",
      "orchestrator-session-id": "ses_123",
    });
  });
});
