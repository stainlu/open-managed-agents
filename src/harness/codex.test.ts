import { describe, expect, it } from "vitest";
import { CodexHarnessAdapter } from "./codex.js";
import { InMemoryStore } from "../store/memory.js";

describe("CodexHarnessAdapter", () => {
  it("builds an app-server adapter container with Codex workspace state", () => {
    const store = new InMemoryStore();
    const adapter = new CodexHarnessAdapter({
      runtimeImage: "open-managed-agents/codex-agent:test",
      hostStateRoot: "/host/state",
      stateRoot: "/tmp/oma-codex-test",
      network: "oma-net",
      gatewayPort: 18789,
      passthroughEnv: { OPENAI_API_KEY: "sk-test" },
      environments: store.environments,
    });

    const agent = store.agents.create({
      harnessId: "codex",
      model: "openai/gpt-5.5",
      tools: ["shell"],
      instructions: "be concise",
      permissionPolicy: { type: "always_ask" },
      thinkingLevel: "medium",
    });
    const session = store.sessions.create({
      agentId: agent.agentId,
      harnessId: "codex",
      sessionId: "ses_codex",
    });

    const spawn = adapter.buildSpawnOptions({
      agent,
      session,
      sessionId: session.sessionId,
    });

    expect(spawn.image).toBe("open-managed-agents/codex-agent:test");
    expect(spawn.mounts).toEqual([
      {
        hostPath: `/host/state/${agent.agentId}/sessions/ses_codex`,
        containerPath: "/workspace",
      },
    ]);
    expect(spawn.env).toMatchObject({
      OPENAI_API_KEY: "sk-test",
      CODEX_API_KEY: "sk-test",
      OMA_ADAPTER_PROTOCOL: "oma.adapter.v1",
      OMA_ADAPTER_HARNESS_ID: "codex",
      OMA_ADAPTER_PORT: "18789",
      OPENCLAW_GATEWAY_PORT: "18789",
      OMA_MANAGED_SESSION_ID: "ses_codex",
      OMA_AGENT_ID: agent.agentId,
      OMA_STATE_DIR: "/workspace",
      CODEX_HOME: "/workspace/.codex",
      OMA_CODEX_CWD: "/workspace",
    });
    expect(spawn.labels).toMatchObject({
      "orchestrator-harness-id": "codex",
      "orchestrator-session-id": "ses_codex",
    });
    expect(adapter.modelForUsage("openai/gpt-5.5")).toBe("gpt-5.5");
  });

  it("mirrors Codex-native auth env back to OpenAI auth env", () => {
    const store = new InMemoryStore();
    const adapter = new CodexHarnessAdapter({
      runtimeImage: "open-managed-agents/codex-agent:test",
      hostStateRoot: "/host/state",
      stateRoot: "/tmp/oma-codex-test",
      network: "oma-net",
      gatewayPort: 18789,
      passthroughEnv: { CODEX_API_KEY: "sk-codex-test" },
      environments: store.environments,
    });

    const agent = store.agents.create({
      harnessId: "codex",
      model: "openai/gpt-5.5",
    });
    const session = store.sessions.create({
      agentId: agent.agentId,
      harnessId: "codex",
      sessionId: "ses_codex_native",
    });

    const spawn = adapter.buildSpawnOptions({
      agent,
      session,
      sessionId: session.sessionId,
    });

    expect(spawn.env).toMatchObject({
      CODEX_API_KEY: "sk-codex-test",
      OPENAI_API_KEY: "sk-codex-test",
    });
  });
});
