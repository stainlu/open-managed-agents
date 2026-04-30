import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParentTokenMinter } from "../runtime/parent-token.js";
import { InMemoryStore } from "../store/memory.js";
import { OpenClawHarnessAdapter, normalizeModelForRuntime } from "./openclaw.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeAdapter(store = new InMemoryStore()) {
  const root = mkdtempSync(join(tmpdir(), "oma-openclaw-adapter-"));
  tempRoots.push(root);
  const tokenMinter = new ParentTokenMinter(Buffer.from("0123456789abcdef"));
  const adapter = new OpenClawHarnessAdapter({
    runtimeImage: "open-managed-agents/openclaw-agent:test",
    hostStateRoot: join(root, "host"),
    stateRoot: join(root, "state"),
    network: "oma-test-net",
    gatewayPort: 18789,
    passthroughEnv: {
      ZENMUX_API_KEY: "sk-test",
      CUSTOM_PROVIDER_KEY: "provider-secret",
    },
    orchestratorUrl: "http://open-managed-agents-orchestrator:8080",
    tokenMinter,
    environments: store.environments,
    vaults: store.vaults,
  });
  return { adapter, store, root, tokenMinter };
}

function createAgent(store: InMemoryStore) {
  return store.agents.create({
    model: "claude-opus-4-6",
    tools: ["exec", "write"],
    instructions: "You are useful.",
    permissionPolicy: { type: "always_ask", tools: ["write"] },
    callableAgents: ["agt_research"],
    maxSubagentDepth: 2,
    mcpServers: {
      docs: {
        url: "https://api.example.com/v2/mcp",
        headers: { "x-static": "kept" },
      },
    },
  });
}

describe("OpenClawHarnessAdapter", () => {
  it("normalizes OpenClaw spawn options behind the harness boundary", () => {
    const { adapter, store, root, tokenMinter } = makeAdapter();
    const agent = createAgent(store);
    const vault = store.vaults.createVault({ userId: "usr_1", name: "test" });
    store.vaults.addCredential({
      vaultId: vault.vaultId,
      name: "generic",
      type: "static_bearer",
      matchUrl: "https://api.example.com/",
      token: "generic-token",
    });
    store.vaults.addCredential({
      vaultId: vault.vaultId,
      name: "specific",
      type: "static_bearer",
      matchUrl: "https://api.example.com/v2/",
      token: "specific-token",
    });

    const spawn = adapter.buildSpawnOptions({
      sessionId: "ses_1",
      agent,
      session: {
        environmentId: null,
        remainingSubagentDepth: 1,
        vaultId: vault.vaultId,
      },
      modelOverride: "anthropic/claude-opus-4-7",
      thinkingLevel: "high",
    });

    expect(spawn.image).toBe("open-managed-agents/openclaw-agent:test");
    expect(spawn.containerPort).toBe(18789);
    expect(spawn.network).toBe("oma-test-net");
    expect(spawn.mounts).toEqual([
      {
        hostPath: join(root, "host", agent.agentId, "sessions", "ses_1"),
        containerPath: "/workspace",
      },
    ]);
    expect(existsSync(join(root, "state", agent.agentId, "sessions", "ses_1"))).toBe(true);
    expect(spawn.labels).toMatchObject({
      "orchestrator-agent-id": agent.agentId,
      "orchestrator-session-id": "ses_1",
    });
    expect(spawn.env.OPENCLAW_AGENT_ID).toBe("main");
    expect(spawn.env.OPENCLAW_MODEL).toBe("zenmux/anthropic/claude-opus-4.7");
    expect(spawn.env.OPENCLAW_THINKING_LEVEL).toBe("high");
    expect(spawn.env.OPENCLAW_TOOLS).toBe("exec,write");
    expect(spawn.env.OPENCLAW_CONFIRM_TOOLS).toBe("write");
    expect(spawn.env.OPENCLAW_ORCHESTRATOR_URL).toBe(
      "http://open-managed-agents-orchestrator:8080",
    );
    expect(spawn.env.CUSTOM_PROVIDER_KEY).toBe("provider-secret");
    expect(spawn.env.OPENCLAW_INSTRUCTIONS).toContain("openclaw-call-agent");
    expect(spawn.env.OPENCLAW_INSTRUCTIONS).toContain("agt_research");

    const token = tokenMinter.verify(spawn.env.OPENCLAW_ORCHESTRATOR_TOKEN);
    expect(token).toMatchObject({
      parentSessionId: "ses_1",
      parentAgentId: agent.agentId,
      allowlist: ["agt_research"],
      remainingDepth: 1,
    });

    const mcp = JSON.parse(spawn.env.OPENCLAW_MCP_SERVERS_JSON) as {
      docs: { headers: Record<string, string> };
    };
    expect(mcp.docs.headers).toEqual({
      "x-static": "kept",
      Authorization: "Bearer specific-token",
    });
  });

  it("keeps warm-pool bypass policy with the OpenClaw adapter", () => {
    const { adapter, store } = makeAdapter();
    const limited = store.environments.create({
      name: "limited",
      networking: {
        type: "limited",
        allowedHosts: ["api.example.com"],
        allowMcpServers: false,
        allowPackageManagers: false,
      },
    });
    const withPackages = store.environments.create({
      name: "packages",
      packages: { npm: ["typescript"] },
      networking: { type: "unrestricted" },
    });
    const plain = store.environments.create({
      name: "plain",
      networking: { type: "unrestricted" },
    });

    expect(adapter.shouldBypassWarmPool(undefined)).toBe(false);
    expect(adapter.shouldBypassWarmPool({ environmentId: null, vaultId: null })).toBe(false);
    expect(adapter.shouldBypassWarmPool({ environmentId: plain.environmentId, vaultId: null })).toBe(false);
    expect(adapter.shouldBypassWarmPool({ environmentId: null, vaultId: "vlt_1" })).toBe(true);
    expect(adapter.shouldBypassWarmPool({ environmentId: limited.environmentId, vaultId: null })).toBe(true);
    expect(adapter.shouldBypassWarmPool({ environmentId: withPackages.environmentId, vaultId: null })).toBe(true);
  });

  it("invokes OpenClaw turns through the canonical session key", async () => {
    const { adapter } = makeAdapter();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "done" } }],
          usage: { input_tokens: 11, output_tokens: 7 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await adapter.invokeTurn({
      baseUrl: "http://container.test",
      token: "gateway-token",
      sessionId: "ses_1",
      content: "hello",
      timeoutMs: 1000,
    });

    expect(result).toEqual({ output: "done", tokensIn: 11, tokensOut: 7 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://container.test/v1/chat/completions");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer gateway-token",
      "x-openclaw-agent-id": "main",
      "x-openclaw-session-key": "agent:main:ses_1",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "openclaw/main",
      user: "ses_1",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });
  });

  it("invokes streaming OpenClaw turns and yields OpenAI SSE data frames", async () => {
    const { adapter } = makeAdapter();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"delta"'));
        controller.enqueue(encoder.encode(':"one"}\n\n'));
        controller.enqueue(encoder.encode("event: ignored\ndata: [DONE]\n\n"));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const stream = await adapter.invokeStreamingTurn({
      baseUrl: "http://container.test",
      token: "gateway-token",
      sessionId: "ses_1",
      content: "hello",
      timeoutMs: 1000,
    });
    const chunks: string[] = [];
    for await (const chunk of stream.chunks) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['{"delta":"one"}', "[DONE]"]);
    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      Accept: "text/event-stream",
      Authorization: "Bearer gateway-token",
      "x-openclaw-session-key": "agent:main:ses_1",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("maps managed control-plane calls to the OpenClaw gateway protocol", async () => {
    const { adapter } = makeAdapter();
    const calls: unknown[] = [];
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const control = {
      async patch(key: string, fields: Record<string, unknown>) {
        calls.push({ method: "patch", key, fields });
      },
      async abort(key: string) {
        calls.push({ method: "abort", key });
      },
      async compact(key: string) {
        calls.push({ method: "compact", key });
      },
      async approvalResolve(id: string, decision: string) {
        calls.push({ method: "approvalResolve", id, decision });
      },
      async approvalList() {
        return [{
          id: "ap_1",
          createdAtMs: 123,
          request: {
            toolName: "write",
            toolCallId: "call_1",
            description: "write?",
          },
        }];
      },
      onEvent(eventName: string, handler: (payload: unknown) => void) {
        const set = listeners.get(eventName) ?? new Set<(payload: unknown) => void>();
        set.add(handler);
        listeners.set(eventName, set);
        return () => {
          set.delete(handler);
          if (set.size === 0) listeners.delete(eventName);
        };
      },
    };
    const emit = (eventName: string, payload: unknown): void => {
      for (const handler of listeners.get(eventName) ?? []) handler(payload);
    };

    await adapter.patchSession(control, "ses_1", {
      model: "provider/model-x",
      thinkingLevel: "high",
    });
    await adapter.abortSession(control, "ses_1");
    await adapter.compactSession(control, "ses_1");
    await adapter.resolveApproval(control, "ap_1", "allow");

    expect(calls).toEqual([
      {
        method: "patch",
        key: "agent:main:ses_1",
        fields: { model: "zenmux/provider/model-x", thinkingLevel: "high" },
      },
      { method: "abort", key: "agent:main:ses_1" },
      { method: "compact", key: "agent:main:ses_1" },
      { method: "approvalResolve", id: "ap_1", decision: "allow-once" },
    ]);

    await expect(adapter.listApprovals(control, "ses_1")).resolves.toEqual([{
      approvalId: "ap_1",
      sessionId: "ses_1",
      toolName: "write",
      toolCallId: "call_1",
      description: "write?",
      arrivedAt: 123,
    }]);

    const requested: unknown[] = [];
    const resolved: unknown[] = [];
    const states: unknown[] = [];
    const unsubscribeRequested = adapter.subscribeApprovalRequested(
      control,
      "ses_1",
      (approval) => requested.push(approval),
    );
    adapter.subscribeApprovalResolved(control, (resolution) => resolved.push(resolution));
    adapter.subscribeTurnState(control, "ses_1", (event) => states.push(event));

    emit("plugin.approval.requested", {
      id: "ap_2",
      createdAtMs: 456,
      request: { toolName: "exec", description: "run command" },
    });
    emit("plugin.approval.resolved", { id: "ap_2", decision: "deny" });
    emit("chat", { sessionKey: "agent:main:other", state: "final" });
    emit("chat", { sessionKey: "agent:main:ses_1", state: "error", errorMessage: "failed" });

    expect(requested).toEqual([{
      approvalId: "ap_2",
      sessionId: "ses_1",
      toolName: "exec",
      toolCallId: undefined,
      description: "run command",
      arrivedAt: 456,
    }]);
    expect(resolved).toEqual([{ approvalId: "ap_2", decision: "deny" }]);
    expect(states).toEqual([{ state: "error", errorMessage: "failed" }]);

    unsubscribeRequested();
    expect(listeners.get("plugin.approval.requested")).toBeUndefined();
  });

  it("does not change model names when ZenMux is not configured", () => {
    expect(normalizeModelForRuntime("deepseek/deepseek-v4-pro", {})).toBe(
      "deepseek/deepseek-v4-pro",
    );
  });
});
