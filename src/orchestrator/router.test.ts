import { afterEach, describe, expect, it, vi } from "vitest";

import type { ManagedEventLog } from "../events/types.js";
import {
  OpenClawHarnessAdapter,
  normalizeModelForRuntime,
} from "../harness/openclaw.js";
import { OpenClawJsonlEventLog } from "../harness/openclaw-events.js";
import { HarnessRegistry } from "../harness/registry.js";
import type { HarnessAdapter, HarnessCapabilities } from "../harness/types.js";
import type { GatewayWebSocketClient } from "../runtime/gateway-ws.js";
import { ParentTokenMinter } from "../runtime/parent-token.js";
import type {
  ManagedRunRequest,
  ManagedRunScheduler,
  ScheduleManagedRunArgs,
} from "../runtime/run-scheduler.js";
import type { ManagedSessionRuntime } from "../runtime/session-runtime.js";
import { InMemoryStore } from "../store/memory.js";
import type { QueueStore } from "../store/types.js";
import { LocalManagedWorkspace } from "../workspace/local.js";
import { clearZenMuxCatalogCache } from "./zenmux-pricing.js";
import {
  AgentRouter,
  RouterError,
  type RouterConfig,
} from "./router.js";
import type { Event } from "./types.js";

// These tests cover the decision-tree logic that doesn't require a live
// container: createSession, runEvent's pre-dispatch checks, and cancel's
// pre-abort checks. Paths that reach the pool / WS / chat.completions
// call are out of scope for unit tests and are covered by e2e.

function makeRouter(opts: {
  poolStub?: Partial<ManagedSessionRuntime>;
  eventReaderStub?: Partial<ManagedEventLog>;
  passthroughEnv?: Record<string, string>;
  capabilityOverrides?: Partial<HarnessCapabilities>;
  extraHarnesses?: HarnessAdapter[];
  runScheduler?: ManagedRunScheduler;
  runTimeoutMs?: number;
} = {}): {
  router: AgentRouter;
  store: InMemoryStore;
  queue: QueueStore;
  pool: Partial<ManagedSessionRuntime>;
} {
  const store = new InMemoryStore();
  const queue = store.queue;
  // Minimal pool stub: in tests that shouldn't reach the pool we leave
  // methods undefined so any accidental call throws TypeError and fails
  // loudly. Tests that DO want to exercise a pool interaction provide
  // their own shaped stub.
  const poolStub = opts.poolStub ?? {};
  if (!poolStub.getControlClient && poolStub.getWsClient) {
    poolStub.getControlClient = poolStub.getWsClient;
  }
  const pool = poolStub as ManagedSessionRuntime;
  const eventReader = (opts.eventReaderStub ??
    new OpenClawJsonlEventLog("/tmp/does-not-exist")) as ManagedEventLog;
  const stateRoot = eventReader.stateRoot ?? "/tmp/does-not-exist";
  const workspace = new LocalManagedWorkspace(stateRoot);
  const harness = new OpenClawHarnessAdapter({
    runtimeImage: "test-image",
    hostStateRoot: "/tmp/test-state",
    stateRoot,
    network: "test-net",
    gatewayPort: 18789,
    passthroughEnv: opts.passthroughEnv ?? {},
    orchestratorUrl: "http://orchestrator-test:8080",
    tokenMinter: new ParentTokenMinter(),
    environments: store.environments,
    vaults: store.vaults,
  });
  if (opts.capabilityOverrides) {
    (harness as { capabilities: HarnessCapabilities }).capabilities = {
      ...harness.capabilities,
      ...opts.capabilityOverrides,
    };
  }
  const cfg: RouterConfig = {
    passthroughEnv: opts.passthroughEnv ?? {},
    runTimeoutMs: opts.runTimeoutMs ?? 60_000,
    harnesses: new HarnessRegistry({ adapters: [harness, ...(opts.extraHarnesses ?? [])] }),
    runScheduler: opts.runScheduler,
  };
  const router = new AgentRouter(
    store.agents,
    store.environments,
    store.sessions,
    store.runs,
    eventReader,
    workspace,
    pool,
    queue,
    store.vaults,
    cfg,
  );
  return { router, store, queue, pool };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearZenMuxCatalogCache();
});

async function waitForSessionToStopRunning(
  store: InMemoryStore,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const status = store.sessions.get(sessionId)?.status;
    if (status !== "starting" && status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`session ${sessionId} stayed inflight`);
}

async function waitForCondition(
  label: string,
  pred: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function findLastEvent(
  events: Event[],
  pred: (event: Event) => boolean,
): Event | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event && pred(event)) return event;
  }
  return undefined;
}

async function* doneStream(): AsyncGenerator<string, void, void> {
  yield "[DONE]";
}

const unsupported = (detail: string) => ({
  support: "unsupported" as const,
  detail,
});

const supported = (detail: string) => ({
  support: "supported" as const,
  detail,
});

function nativeTestHarness(
  overrides: Partial<HarnessAdapter> = {},
): HarnessAdapter {
  const adapter: HarnessAdapter = {
    id: "native-test",
    displayName: "Native Test",
    runtimeMode: "native",
    capabilities: {
      start_turn: supported("native test turns"),
      streaming: supported("native test streaming"),
      native_session_resume: supported("native test metadata"),
      cancellation: unsupported("native test cancellation is not wired"),
      interruption: unsupported("native test interruption is not wired"),
      dynamic_model_patch: supported("native turns receive model fields directly"),
      compaction: unsupported("native test compaction is not wired"),
      tool_approvals: unsupported("native test approvals are not wired"),
      permission_deny: unsupported("native test deny policy is not wired"),
      mcp: unsupported("native test MCP is not wired"),
      managed_event_log: supported("native test emits managed events"),
      usage: supported("native test usage"),
      subagents: unsupported("native test subagents are not wired"),
    },
    shouldBypassWarmPool: () => true,
    modelForUsage: (model) => model,
    isFailureOutput: () => false,
    invokeTurn: vi.fn(async () => ({
      output: "native done",
      tokensIn: 11,
      tokensOut: 7,
    })),
    invokeStreamingTurn: vi.fn(async () => ({
      chunks: doneStream(),
      abort: async () => {},
    })),
    patchSession: vi.fn(async () => {}),
    abortSession: vi.fn(async () => {}),
    compactSession: vi.fn(async () => {}),
    resolveApproval: vi.fn(async () => {}),
    listApprovals: vi.fn(async () => []),
    subscribeApprovalRequested: vi.fn(() => () => {}),
    subscribeApprovalResolved: vi.fn(() => () => {}),
    subscribeTurnState: vi.fn(() => () => {}),
    ...overrides,
  };
  return adapter;
}

class RecordingRunScheduler implements ManagedRunScheduler {
  readonly scheduled: ScheduleManagedRunArgs[] = [];

  constructor(private readonly runImmediately = false) {}

  schedule(args: ScheduleManagedRunArgs): void | Promise<void> {
    this.scheduled.push(args);
    if (this.runImmediately) {
      return args.run().catch(args.onFailure);
    }
  }

  requests(): ManagedRunRequest[] {
    return this.scheduled.map((entry) => entry.request);
  }
}

describe("AgentRouter.createSession", () => {
  it("normalizes runtime models through ZenMux when ZENMUX_API_KEY is configured", () => {
    expect(
      normalizeModelForRuntime("moonshot/kimi-k2.6", { ZENMUX_API_KEY: "sk-test" }),
    ).toBe("zenmux/moonshot/kimi-k2.6");
    expect(
      normalizeModelForRuntime("zenmux/moonshot/kimi-k2.6", { ZENMUX_API_KEY: "sk-test" }),
    ).toBe("zenmux/moonshot/kimi-k2.6");
    expect(
      normalizeModelForRuntime("moonshot/kimi-k2.6", {}),
    ).toBe("moonshot/kimi-k2.6");
    expect(
      normalizeModelForRuntime("anthropic/claude-opus-4-7", { ZENMUX_API_KEY: "sk-test" }),
    ).toBe("zenmux/anthropic/claude-opus-4.7");
    expect(
      normalizeModelForRuntime("claude-opus-4-6", { ZENMUX_API_KEY: "sk-test" }),
    ).toBe("zenmux/anthropic/claude-opus-4.6");
  });

  it("creates a session bound to an existing agent", () => {
    const { router, store } = makeRouter();
    const agent = store.agents.create({
      model: "moonshot/kimi-k2.5",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    expect(session.agentId).toBe(agent.agentId);
    expect(session.harnessId).toBe("openclaw");
    expect(session.nativeSessionId).toBe(session.sessionId);
    expect(session.status).toBe("idle");
    expect(store.sessions.get(session.sessionId)).toBeDefined();
  });

  it("throws agent_not_found when agent does not exist", () => {
    const { router } = makeRouter();
    try {
      router.createSession("agt_missing");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouterError);
      expect((err as RouterError).code).toBe("agent_not_found");
    }
  });

  it("throws agent_archived once the agent is archived", () => {
    const { router, store } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    store.agents.archive(agent.agentId);
    try {
      router.createSession(agent.agentId);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouterError);
      expect((err as RouterError).code).toBe("agent_archived");
    }
  });

  it("throws unsupported_harness when the agent targets an unregistered harness", () => {
    const { router, store } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    (agent as { harnessId: string }).harnessId = "missing";
    try {
      router.createSession(agent.agentId);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouterError);
      expect((err as RouterError).code).toBe("unsupported_harness");
    }
  });

  it("rejects stored agent templates that request unsupported harness features", () => {
    const { router, store } = makeRouter({
      capabilityOverrides: {
        mcp: unsupported("MCP is not available in this harness"),
      },
    });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      mcpServers: {
        docs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      },
    });

    try {
      router.createSession(agent.agentId);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toMatchObject({
        name: "RouterError",
        code: "unsupported_capability",
      });
    }
  });

  it("inherits maxSubagentDepth from the agent template by default", () => {
    const { router, store } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: ["agt_worker"],
      maxSubagentDepth: 3,
    });
    const session = router.createSession(agent.agentId);
    expect(session.remainingSubagentDepth).toBe(3);
  });

  it("honors an explicit remainingSubagentDepth override (subagent spawn path)", () => {
    const { router, store } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: ["agt_x"],
      maxSubagentDepth: 5,
    });
    const session = router.createSession(agent.agentId, {
      remainingSubagentDepth: 2,
    });
    // Override wins over the agent template's 5 — child sessions inherit
    // parent.remaining_depth - 1, not the child agent's own max.
    expect(session.remainingSubagentDepth).toBe(2);
  });
});

describe("AgentRouter.warmSession", () => {
  function seedAgent(store: InMemoryStore) {
    return store.agents.create({
      model: "moonshot/kimi-k2.5",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
  }

  it("queues a template warm for a default session", async () => {
    const warmed: string[] = [];
    const { router, store } = makeRouter({
      poolStub: {
        warmForAgent: async (agentId: string) => {
          warmed.push(agentId);
        },
      },
    });
    const agent = seedAgent(store);
    const session = router.createSession(agent.agentId);

    await router.warmSession(session.sessionId);

    expect(warmed).toEqual([agent.agentId]);
  });

  it("does not warm native harnesses through the container pool", async () => {
    const warmForAgent = vi.fn(async () => {});
    const { router, store } = makeRouter({
      extraHarnesses: [nativeTestHarness()],
      poolStub: { warmForAgent },
    });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      harnessId: "native-test",
    });
    const session = router.createSession(agent.agentId);

    await router.warmSession(session.sessionId);
    await router.warmForAgent(agent.agentId);

    expect(warmForAgent).not.toHaveBeenCalled();
  });

  it("skips template warm for sessions with package preinstalls", async () => {
    const warmed: string[] = [];
    const { router, store } = makeRouter({
      poolStub: {
        warmForAgent: async (agentId: string) => {
          warmed.push(agentId);
        },
      },
    });
    const agent = seedAgent(store);
    const env = store.environments.create({
      name: "python",
      description: "",
      packages: { pip: ["numpy"] },
      networking: { type: "unrestricted" },
    });
    const session = router.createSession(agent.agentId, {
      environmentId: env.environmentId,
    });

    await router.warmSession(session.sessionId);

    expect(warmed).toEqual([]);
  });

  it("skips template warm for limited-networking sessions", async () => {
    const warmed: string[] = [];
    const { router, store } = makeRouter({
      poolStub: {
        warmForAgent: async (agentId: string) => {
          warmed.push(agentId);
        },
      },
    });
    const agent = seedAgent(store);
    const env = store.environments.create({
      name: "limited",
      description: "",
      networking: { type: "limited", allowedHosts: ["api.example.com"] },
    });
    const session = router.createSession(agent.agentId, {
      environmentId: env.environmentId,
    });

    await router.warmSession(session.sessionId);

    expect(warmed).toEqual([]);
  });

  it("skips template warm for vault-bound sessions", async () => {
    const warmed: string[] = [];
    const { router, store } = makeRouter({
      poolStub: {
        warmForAgent: async (agentId: string) => {
          warmed.push(agentId);
        },
      },
    });
    const agent = seedAgent(store);
    const vault = store.vaults.createVault({ userId: "usr_test", name: "prod" });
    const session = router.createSession(agent.agentId, {
      vaultId: vault.vaultId,
    });

    await router.warmSession(session.sessionId);

    expect(warmed).toEqual([]);
  });
});

describe("AgentRouter.streamEvent — pre-container decision tree", () => {
  // These tests exercise the parts of streamEvent that run BEFORE we hit
  // the pool / WS / fetch to the container — that surface is covered by
  // the existing e2e (test/e2e.sh) against a real container. The
  // pre-dispatch checks (session_not_found, agent_not_found,
  // session_busy) don't need a live container and are what we want to
  // lock against regressions.
  it("rejects unknown sessions with session_not_found", async () => {
    const { router } = makeRouter();
    await expect(
      router.streamEvent({ sessionId: "ses_nope", content: "hi" }),
    ).rejects.toMatchObject({ name: "RouterError", code: "session_not_found" });
  });

  it("rejects busy sessions with session_busy (streaming cannot interleave with the queue)", async () => {
    const { router, store } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    // Flip to starting directly to simulate a turn already inflight.
    store.sessions.beginRun(session.sessionId);
    await expect(
      router.streamEvent({ sessionId: session.sessionId, content: "hi" }),
    ).rejects.toMatchObject({ name: "RouterError", code: "session_busy" });
    // Session must still be inflight — a rejection must NOT inadvertently
    // transition state (a bug where we beginRun before checking status
    // would leave it inflight forever on the rejection path).
    expect(store.sessions.get(session.sessionId)?.status).toBe("starting");
  });

  it("rejects when the agent template was deleted after session creation", async () => {
    const { router, store } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    store.agents.delete(agent.agentId);
    await expect(
      router.streamEvent({ sessionId: session.sessionId, content: "hi" }),
    ).rejects.toMatchObject({ name: "RouterError", code: "agent_not_found" });
    // Session must be idle since we never got past validation.
    expect(store.sessions.get(session.sessionId)?.status).toBe("idle");
  });

  it("rejects harnesses that do not support streaming before acquiring a container", async () => {
    const { router, store } = makeRouter({
      capabilityOverrides: {
        streaming: unsupported("streaming is not implemented"),
      },
    });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      mcpServers: {},
    });
    const session = router.createSession(agent.agentId);

    await expect(
      router.streamEvent({ sessionId: session.sessionId, content: "hi" }),
    ).rejects.toMatchObject({ name: "RouterError", code: "unsupported_capability" });
    expect(store.sessions.get(session.sessionId)?.status).toBe("idle");
  });
});

describe("AgentRouter.streamEvent — finalization", () => {
  it("persists native metadata returned by a streaming harness result", async () => {
    const storedEvents: Event[] = [];
    const appendEvents = vi.fn((_agentId: string, sessionId: string, events: Event[]) => {
      storedEvents.push(...events.map((event) => ({ ...event, sessionId })));
    });
    const eventReader: Partial<ManagedEventLog> = {
      stateRoot: "/tmp/test-state",
      appendEvents,
      listBySession: () => storedEvents,
      countUserTurns: () => storedEvents.filter((event) => event.type === "user.message").length,
      latestAgentOutcome: () => findLastEvent(
        storedEvents,
        (event) => event.type === "agent.message" || event.type === "agent.tool_result",
      ),
      latestAgentMessage: () => findLastEvent(
        storedEvents,
        (event) => event.type === "agent.message",
      ),
    };
    vi.spyOn(OpenClawHarnessAdapter.prototype, "invokeStreamingTurn").mockResolvedValue({
      chunks: doneStream(),
      events: [
        {
          eventId: "evt_user",
          sessionId: "native-session",
          type: "user.message",
          content: "hi",
          createdAt: 1,
        },
        {
          eventId: "evt_agent",
          sessionId: "native-session",
          type: "agent.message",
          content: "done",
          createdAt: 2,
          tokensIn: 11,
          tokensOut: 7,
          model: "deepseek/v4",
        },
      ],
      result: {
        output: "done",
        tokensIn: 11,
        tokensOut: 7,
        model: "deepseek/v4",
        native: {
          nativeSessionId: "native-ses",
          nativeThreadId: "thread-1",
          nativeMetadata: { checkpoint: 3 },
        },
      },
      abort: async () => {},
    });
    const { router, store } = makeRouter({
      eventReaderStub: eventReader,
      poolStub: {
        acquireForSession: async () =>
          ({ baseUrl: "http://container.test", token: "tok" }) as any,
        evictSession: async () => {},
      },
    });
    const agent = store.agents.create({
      model: "deepseek/v4",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);

    const handle = await router.streamEvent({ sessionId: session.sessionId, content: "hi" });
    for await (const chunk of handle.chunks) {
      // Drain stream before finalization, matching the HTTP handler.
      expect(chunk).toBe("[DONE]");
    }
    await handle.finalize({ ok: true });

    const finished = store.sessions.get(session.sessionId);
    expect(finished?.status).toBe("idle");
    expect(finished?.tokensIn).toBe(11);
    expect(finished?.tokensOut).toBe(7);
    expect(finished?.nativeSessionId).toBe("native-ses");
    expect(finished?.nativeThreadId).toBe("thread-1");
    expect(finished?.nativeMetadata).toEqual({ checkpoint: 3 });
    expect(appendEvents).toHaveBeenCalledTimes(2);
  });
});

describe("AgentRouter quota enforcement", () => {
  // Quotas fire from runEvent / streamEvent's pre-dispatch checks, so we
  // can exercise them without needing a live pool — same shape as the
  // other router decision-tree tests above.
  function seedAgentWithQuota(
    store: InMemoryStore,
    quota: NonNullable<ReturnType<InMemoryStore["agents"]["get"]>>["quota"],
  ) {
    return store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      mcpServers: {},
      quota,
    });
  }

  it("rejects with quota_exceeded when the session's rolling cost >= maxCostUsdPerSession", async () => {
    const { router, store } = makeRouter();
    const agent = seedAgentWithQuota(store, { maxCostUsdPerSession: 1.0 });
    const session = router.createSession(agent.agentId);
    // Simulate a prior turn that brought us to the cap.
    store.sessions.addUsage(session.sessionId, {
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 1.0,
    });
    await expect(
      router.runEvent({ sessionId: session.sessionId, content: "another turn" }),
    ).rejects.toMatchObject({ name: "RouterError", code: "quota_exceeded" });
    // Session stayed idle — quota check must not flip state.
    expect(store.sessions.get(session.sessionId)?.status).toBe("idle");
  });

  it("rejects with quota_exceeded when tokens_in + tokens_out >= maxTokensPerSession", async () => {
    const { router, store } = makeRouter();
    const agent = seedAgentWithQuota(store, { maxTokensPerSession: 100 });
    const session = router.createSession(agent.agentId);
    store.sessions.addUsage(session.sessionId, {
      tokensIn: 80,
      tokensOut: 20,
      costUsd: 0,
    });
    await expect(
      router.runEvent({ sessionId: session.sessionId, content: "hi" }),
    ).rejects.toMatchObject({ name: "RouterError", code: "quota_exceeded" });
  });

  it("rejects with quota_exceeded when the session age has passed maxWallDurationMs", async () => {
    const { router, store } = makeRouter();
    const agent = seedAgentWithQuota(store, { maxWallDurationMs: 10 });
    const session = router.createSession(agent.agentId);
    await new Promise((r) => setTimeout(r, 20));
    await expect(
      router.runEvent({ sessionId: session.sessionId, content: "hi" }),
    ).rejects.toMatchObject({ name: "RouterError", code: "quota_exceeded" });
  });
});

describe("AgentRouter.runEvent — decision tree", () => {
  it("throws session_not_found for an unknown session", async () => {
    const { router } = makeRouter();
    await expect(
      router.runEvent({ sessionId: "ses_missing", content: "hi" }),
    ).rejects.toMatchObject({
      name: "RouterError",
      code: "session_not_found",
    });
  });

  it("throws agent_not_found when the agent was deleted but session lingers", async () => {
    // This path is a safety net: sessions outlive their template by design,
    // but if the template was deleted we can't spawn a container. Reject
    // explicitly rather than trying to spawn.
    const { router, store } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    store.agents.delete(agent.agentId);
    await expect(
      router.runEvent({ sessionId: session.sessionId, content: "hi" }),
    ).rejects.toMatchObject({
      name: "RouterError",
      code: "agent_not_found",
    });
  });

  it("rejects harnesses that do not support starting turns before flipping session state", async () => {
    const { router, store } = makeRouter({
      capabilityOverrides: {
        start_turn: unsupported("turns are disabled"),
      },
    });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      mcpServers: {},
    });
    const session = router.createSession(agent.agentId);

    await expect(
      router.runEvent({ sessionId: session.sessionId, content: "hi" }),
    ).rejects.toMatchObject({ name: "RouterError", code: "unsupported_capability" });
    expect(store.sessions.get(session.sessionId)?.status).toBe("idle");
  });

  it("queues the event when the session is currently running (no new run started)", async () => {
    // Session in "running" state → the event should land in the queue for
    // the in-flight run to pick up on completion. runEvent must return
    // queued=true and must NOT touch the pool (which would spawn a second
    // container).
    const { router, store, queue } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    // Simulate a run already in flight.
    store.sessions.beginRun(session.sessionId);
    expect(store.sessions.get(session.sessionId)?.status).toBe("starting");

    const result = await router.runEvent({
      sessionId: session.sessionId,
      content: "second message while first is running",
    });
    expect(result.queued).toBe(true);
    expect(result.session.status).toBe("starting");
    expect(store.runs.get(result.runId)).toMatchObject({
      runId: result.runId,
      sessionId: session.sessionId,
      agentId: agent.agentId,
      status: "queued",
      queued: true,
    });
    // Queue now has the one event we pushed.
    const next = queue.shift(session.sessionId);
    expect(next?.content).toBe("second message while first is running");
    expect(next?.runId).toBe(result.runId);
    // No more events queued.
    expect(queue.shift(session.sessionId)).toBeUndefined();
  });

  it("aborts one queued run by run id without cancelling the active session", async () => {
    const { router, store, queue } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    store.sessions.beginRun(session.sessionId);

    const queued = await router.runEvent({
      sessionId: session.sessionId,
      content: "queued work",
    });

    const aborted = await router.abortRun(session.sessionId, queued.runId, "not needed");

    expect(aborted.aborted).toBe(true);
    expect(aborted.removedQueued).toBe(true);
    expect(aborted.run).toMatchObject({
      runId: queued.runId,
      status: "cancelled",
      error: "not needed",
    });
    expect(queue.shift(session.sessionId)).toBeUndefined();
    expect(store.sessions.get(session.sessionId)?.status).toBe("starting");
  });

  it("includes an optional `model` override in the queued entry", async () => {
    const { router, store, queue } = makeRouter();
    const agent = store.agents.create({
      model: "moonshot/kimi-k2.5",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    store.sessions.beginRun(session.sessionId);

    await router.runEvent({
      sessionId: session.sessionId,
      content: "upgrade this turn",
      model: "anthropic/claude-sonnet-4-6",
    });
    const next = queue.shift(session.sessionId);
    expect(next?.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("rejects busy sessions instead of queueing when rejectIfBusy is set", async () => {
    const { router, store, queue } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    store.sessions.beginRun(session.sessionId);

    await expect(
      router.runEvent({
        sessionId: session.sessionId,
        content: "do not queue",
        rejectIfBusy: true,
      }),
    ).rejects.toMatchObject({ name: "RouterError", code: "session_busy" });
    expect(queue.size(session.sessionId)).toBe(0);
  });

  it("delegates idle run kickoff to the configured run scheduler", async () => {
    const runScheduler = new RecordingRunScheduler();
    const { router, store } = makeRouter({ runScheduler });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);

    const result = await router.runEvent({
      sessionId: session.sessionId,
      content: "scheduled turn",
      model: "anthropic/claude-sonnet-4-6",
      thinkingLevel: "high",
    });

    expect(result.queued).toBe(false);
    expect(store.sessions.get(session.sessionId)?.status).toBe("starting");
    expect(store.runs.get(result.runId)).toMatchObject({
      status: "starting",
      queued: false,
      model: "anthropic/claude-sonnet-4-6",
      thinkingLevel: "high",
    });
    expect(runScheduler.requests()).toEqual([
      {
        runId: result.runId,
        sessionId: session.sessionId,
        agentId: agent.agentId,
        content: "scheduled turn",
        model: "anthropic/claude-sonnet-4-6",
        thinkingLevel: "high",
        queued: false,
      },
    ]);
  });

  it("marks the session failed if the run scheduler throws synchronously", async () => {
    const runScheduler: ManagedRunScheduler = {
      schedule() {
        throw new Error("scheduler unavailable");
      },
    };
    const { router, store } = makeRouter({
      poolStub: { evictSession: async () => {} },
      runScheduler,
    });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);

    const result = await router.runEvent({
      sessionId: session.sessionId,
      content: "scheduled turn",
    });

    expect(result.queued).toBe(false);
    expect(store.sessions.get(session.sessionId)?.status).toBe("failed");
    expect(store.sessions.get(session.sessionId)?.error).toBe("scheduler unavailable");
    expect(store.runs.get(result.runId)).toMatchObject({
      status: "failed",
      error: "scheduler unavailable",
    });
  });

  it("rejects queued per-turn model overrides when the harness cannot patch a live session", async () => {
    const { router, store, queue } = makeRouter({
      capabilityOverrides: {
        dynamic_model_patch: unsupported("live model patching is unavailable"),
      },
    });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      mcpServers: {},
    });
    const session = router.createSession(agent.agentId);
    store.sessions.beginRun(session.sessionId);

    await expect(
      router.runEvent({
        sessionId: session.sessionId,
        content: "second message",
        model: "other-model",
      }),
    ).rejects.toMatchObject({ name: "RouterError", code: "unsupported_capability" });
    expect(queue.size(session.sessionId)).toBe(0);
    expect(store.sessions.get(session.sessionId)?.status).toBe("starting");
  });
});

describe("AgentRouter native harness runtime", () => {
  function managedEventStore() {
    const storedEvents: Event[] = [];
    const appendEvents = vi.fn((_agentId: string, sessionId: string, events: Event[]) => {
      for (const event of events) {
        if (storedEvents.some((stored) => stored.eventId === event.eventId)) continue;
        storedEvents.push({ ...event, sessionId });
      }
    });
    const eventReader: Partial<ManagedEventLog> = {
      appendEvents,
      listBySession: () => storedEvents,
      countUserTurns: () =>
        storedEvents.filter((event) => event.type === "user.message").length,
      latestAgentOutcome: () =>
        findLastEvent(
          storedEvents,
          (event) => event.type === "agent.message" || event.type === "agent.tool_result",
        ),
      latestAgentMessage: () =>
        findLastEvent(storedEvents, (event) => event.type === "agent.message"),
    };
    return { eventReader, appendEvents, storedEvents };
  }

  it("runs native harness turns without acquiring a container endpoint", async () => {
    const { eventReader } = managedEventStore();
    const acquireForSession = vi.fn(async () => {
      throw new Error("native harness should not acquire a container");
    });
    const invokeTurn = vi.fn(async (args) => ({
      output: "native done",
      tokensIn: 11,
      tokensOut: 7,
      model: args.agent?.model,
      events: [
        {
          eventId: "evt_native_user",
          sessionId: args.sessionId,
          type: "user.message" as const,
          content: args.content,
          createdAt: 1,
        },
        {
          eventId: "evt_native_agent",
          sessionId: args.sessionId,
          type: "agent.message" as const,
          content: "native done",
          createdAt: 2,
          tokensIn: 11,
          tokensOut: 7,
          model: args.agent?.model,
        },
      ],
    }));
    const { router, store } = makeRouter({
      extraHarnesses: [nativeTestHarness({ invokeTurn })],
      poolStub: {
        acquireForSession,
        evictSession: async () => {},
      },
      eventReaderStub: eventReader,
    });
    const agent = store.agents.create({
      model: "flue/native-test",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      harnessId: "native-test",
    });
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "hi native" });
    await waitForSessionToStopRunning(store, session.sessionId);

    expect(acquireForSession).not.toHaveBeenCalled();
    expect(invokeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: undefined,
        token: undefined,
        content: "hi native",
        sessionId: session.sessionId,
        runId: expect.stringMatching(/^run_/),
        agent: expect.objectContaining({ harnessId: "native-test" }),
      }),
    );
    const finished = store.sessions.get(session.sessionId);
    expect(finished?.status).toBe("idle");
    expect(finished?.tokensIn).toBe(11);
    expect(finished?.tokensOut).toBe(7);
  });

  it("executes a scheduled native run after run admission already happened", async () => {
    const { eventReader } = managedEventStore();
    const invokeTurn = vi.fn(async (args) => ({
      output: "scheduled native done",
      tokensIn: 3,
      tokensOut: 4,
      model: args.agent?.model,
      events: [
        {
          eventId: "evt_scheduled_user",
          sessionId: args.sessionId,
          type: "user.message" as const,
          content: args.content,
          createdAt: 1,
        },
        {
          eventId: "evt_scheduled_agent",
          sessionId: args.sessionId,
          type: "agent.message" as const,
          content: "scheduled native done",
          createdAt: 2,
          tokensIn: 3,
          tokensOut: 4,
          model: args.agent?.model,
        },
      ],
    }));
    const { router, store } = makeRouter({
      extraHarnesses: [nativeTestHarness({ invokeTurn })],
      poolStub: {
        acquireForSession: vi.fn(async () => {
          throw new Error("native harness should not acquire a container");
        }),
        evictSession: async () => {},
      },
      eventReaderStub: eventReader,
    });
    const agent = store.agents.create({
      model: "flue/native-test",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      harnessId: "native-test",
    });
    const session = router.createSession(agent.agentId);
    store.sessions.beginRun(session.sessionId);
    store.sessions.bumpTurns(session.sessionId);
    store.runs.create({
      runId: "run_scheduled",
      sessionId: session.sessionId,
      agentId: agent.agentId,
      status: "starting",
      queued: false,
    });

    const result = await router.executeScheduledRun({
      runId: "run_scheduled",
      sessionId: session.sessionId,
      agentId: agent.agentId,
      content: "scheduled",
      queued: false,
    });

    expect(result).toEqual({ status: "executed" });
    expect(invokeTurn).toHaveBeenCalledTimes(1);
    expect(store.sessions.get(session.sessionId)?.status).toBe("idle");
    expect(store.sessions.get(session.sessionId)?.tokensIn).toBe(3);
    expect(store.sessions.get(session.sessionId)?.tokensOut).toBe(4);
    expect(store.runs.get("run_scheduled")).toMatchObject({
      status: "succeeded",
      error: null,
    });

    await expect(router.executeScheduledRun({
      runId: "run_scheduled",
      sessionId: session.sessionId,
      agentId: agent.agentId,
      content: "duplicate delivery",
      queued: false,
    })).resolves.toEqual({
      status: "skipped",
      reason: "session_not_inflight",
    });
    expect(store.runs.get("run_scheduled")).toMatchObject({
      status: "succeeded",
      error: null,
    });
  });

  it("skips a scheduled run that is no longer inflight", async () => {
    const invokeTurn = vi.fn(async () => ({
      output: "should not run",
      tokensIn: 1,
      tokensOut: 1,
    }));
    const { router, store } = makeRouter({
      extraHarnesses: [nativeTestHarness({ invokeTurn })],
    });
    const agent = store.agents.create({
      model: "flue/native-test",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      harnessId: "native-test",
    });
    const session = router.createSession(agent.agentId);

    await expect(router.executeScheduledRun({
      runId: "run_duplicate",
      sessionId: session.sessionId,
      agentId: agent.agentId,
      content: "duplicate",
      queued: false,
    })).resolves.toEqual({
      status: "skipped",
      reason: "session_not_inflight",
    });
    expect(invokeTurn).not.toHaveBeenCalled();
  });

  it("marks a scheduled run failed without throwing to the Workflow runner", async () => {
    const invokeTurn = vi.fn(async () => {
      throw new Error("native scheduled failure");
    });
    const { router, store } = makeRouter({
      extraHarnesses: [nativeTestHarness({ invokeTurn })],
      poolStub: { evictSession: async () => {} },
    });
    const agent = store.agents.create({
      model: "flue/native-test",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      harnessId: "native-test",
    });
    const session = router.createSession(agent.agentId);
    store.sessions.beginRun(session.sessionId);
    store.sessions.bumpTurns(session.sessionId);
    store.runs.create({
      runId: "run_failed",
      sessionId: session.sessionId,
      agentId: agent.agentId,
      status: "starting",
      queued: false,
    });

    await expect(router.executeScheduledRun({
      runId: "run_failed",
      sessionId: session.sessionId,
      agentId: agent.agentId,
      content: "fail",
      queued: false,
    })).resolves.toEqual({
      status: "failed",
      error: "native scheduled failure",
    });
    expect(store.sessions.get(session.sessionId)?.status).toBe("failed");
    expect(store.sessions.get(session.sessionId)?.error).toBe("native scheduled failure");
    expect(store.runs.get("run_failed")).toMatchObject({
      status: "failed",
      error: "native scheduled failure",
    });
  });

  it("schedules queued follow-up turns through the same run scheduler", async () => {
    const { eventReader } = managedEventStore();
    const runScheduler = new RecordingRunScheduler(true);
    const releaseTurn: Array<() => void> = [];
    let turnIndex = 0;
    const invokeTurn = vi.fn(async (args) => {
      const index = turnIndex++;
      await new Promise<void>((resolve) => releaseTurn.push(resolve));
      return {
        output: `native done ${index}`,
        tokensIn: 1,
        tokensOut: 1,
        model: args.agent?.model,
        events: [
          {
            eventId: `evt_native_user_${index}`,
            sessionId: args.sessionId,
            type: "user.message" as const,
            content: args.content,
            createdAt: index * 10 + 1,
          },
          {
            eventId: `evt_native_agent_${index}`,
            sessionId: args.sessionId,
            type: "agent.message" as const,
            content: `native done ${index}`,
            createdAt: index * 10 + 2,
            tokensIn: 1,
            tokensOut: 1,
            model: args.agent?.model,
          },
        ],
      };
    });
    const { router, store } = makeRouter({
      extraHarnesses: [nativeTestHarness({ invokeTurn })],
      poolStub: {
        acquireForSession: vi.fn(async () => {
          throw new Error("native harness should not acquire a container");
        }),
        evictSession: async () => {},
      },
      eventReaderStub: eventReader,
      runScheduler,
    });
    const agent = store.agents.create({
      model: "flue/native-test",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      harnessId: "native-test",
    });
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "first" });
    await waitForCondition("first turn to start", () => invokeTurn.mock.calls.length === 1);

    const queued = await router.runEvent({
      sessionId: session.sessionId,
      content: "second",
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(queued.queued).toBe(true);

    releaseTurn[0]?.();
    await waitForCondition("queued turn to be scheduled", () => runScheduler.scheduled.length === 2);
    expect(runScheduler.requests()).toMatchObject([
      { content: "first", queued: false },
      {
        content: "second",
        model: "anthropic/claude-sonnet-4-6",
        queued: true,
      },
    ]);

    releaseTurn[1]?.();
    await waitForSessionToStopRunning(store, session.sessionId);
    expect(invokeTurn).toHaveBeenCalledTimes(2);
    expect(store.sessions.get(session.sessionId)?.status).toBe("idle");
    expect(store.runs.listBySession(session.sessionId).map((run) => ({
      runId: run.runId,
      status: run.status,
      queued: run.queued,
    }))).toEqual([
      { runId: expect.stringMatching(/^run_/), status: "succeeded", queued: false },
      { runId: queued.runId, status: "succeeded", queued: true },
    ]);
  });

  it("streams native harness turns without acquiring a container endpoint", async () => {
    const { eventReader } = managedEventStore();
    const acquireForSession = vi.fn(async () => {
      throw new Error("native harness should not acquire a container");
    });
    const invokeStreamingTurn = vi.fn(async (args) => ({
      chunks: doneStream(),
      events: [
        {
          eventId: "evt_native_stream_user",
          sessionId: args.sessionId,
          type: "user.message" as const,
          content: args.content,
          createdAt: 1,
        },
        {
          eventId: "evt_native_stream_agent",
          sessionId: args.sessionId,
          type: "agent.message" as const,
          content: "native streamed",
          createdAt: 2,
          tokensIn: 13,
          tokensOut: 5,
          model: args.agent?.model,
        },
      ],
      result: {
        output: "native streamed",
        tokensIn: 13,
        tokensOut: 5,
        model: args.agent?.model,
      },
      abort: async () => {},
    }));
    const { router, store } = makeRouter({
      extraHarnesses: [nativeTestHarness({ invokeStreamingTurn })],
      poolStub: {
        acquireForSession,
        evictSession: async () => {},
      },
      eventReaderStub: eventReader,
    });
    const agent = store.agents.create({
      model: "flue/native-test",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      harnessId: "native-test",
    });
    const session = router.createSession(agent.agentId);

    const handle = await router.streamEvent({ sessionId: session.sessionId, content: "stream" });
    for await (const chunk of handle.chunks) {
      expect(chunk).toBe("[DONE]");
    }
    await handle.finalize({ ok: true });

    expect(acquireForSession).not.toHaveBeenCalled();
    expect(invokeStreamingTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: undefined,
        token: undefined,
        content: "stream",
        sessionId: session.sessionId,
        runId: handle.runId,
      }),
    );
    const finished = store.sessions.get(session.sessionId);
    expect(finished?.status).toBe("idle");
    expect(finished?.tokensIn).toBe(13);
    expect(finished?.tokensOut).toBe(5);
    expect(store.runs.get(handle.runId)).toMatchObject({
      status: "succeeded",
      completedAt: expect.any(Number),
    });
  });

  it("appends live managed events while a native streaming turn is still running", async () => {
    const { eventReader, storedEvents } = managedEventStore();
    let releaseAgentEvent!: () => void;
    const agentEventReady = new Promise<void>((resolve) => {
      releaseAgentEvent = resolve;
    });
    async function* liveEvents(): AsyncGenerator<Event, void, void> {
      yield {
        eventId: "evt_live_user",
        sessionId: "native-session",
        type: "user.message",
        content: "stream",
        createdAt: 1,
      };
      await agentEventReady;
      yield {
        eventId: "evt_live_agent",
        sessionId: "native-session",
        type: "agent.message",
        content: "native streamed",
        createdAt: 2,
        tokensIn: 13,
        tokensOut: 5,
        model: "flue/native-test",
      };
    }
    async function* chunks(): AsyncGenerator<string, void, void> {
      yield JSON.stringify({ choices: [{ delta: { content: "native " } }] });
      releaseAgentEvent();
      yield "[DONE]";
    }
    const invokeStreamingTurn = vi.fn(async () => ({
      chunks: chunks(),
      liveEvents: liveEvents(),
      result: {
        output: "native streamed",
        tokensIn: 13,
        tokensOut: 5,
        model: "flue/native-test",
      },
      abort: async () => {},
    }));
    const { router, store } = makeRouter({
      extraHarnesses: [nativeTestHarness({ invokeStreamingTurn })],
      poolStub: {
        acquireForSession: async () => {
          throw new Error("native harness should not acquire a container");
        },
        evictSession: async () => {},
      },
      eventReaderStub: eventReader,
    });
    const agent = store.agents.create({
      model: "flue/native-test",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      harnessId: "native-test",
    });
    const session = router.createSession(agent.agentId);

    const handle = await router.streamEvent({ sessionId: session.sessionId, content: "stream" });
    await waitForCondition(
      "live user event append",
      () => storedEvents.some((event) => event.eventId === "evt_live_user"),
    );
    expect(store.sessions.get(session.sessionId)?.status).toBe("running");

    const seenChunks: string[] = [];
    for await (const chunk of handle.chunks) seenChunks.push(chunk);
    expect(seenChunks.at(-1)).toBe("[DONE]");
    await waitForCondition(
      "live agent event append",
      () => storedEvents.some((event) => event.eventId === "evt_live_agent"),
    );
    await handle.finalize({ ok: true });

    const finished = store.sessions.get(session.sessionId);
    expect(finished?.status).toBe("idle");
    expect(finished?.tokensIn).toBe(13);
    expect(finished?.tokensOut).toBe(5);
    expect(storedEvents.map((event) => event.eventId)).toEqual([
      "evt_live_user",
      "evt_live_agent",
    ]);
  });
});

describe("AgentRouter.observeAdoptedSession", () => {
  it("times out an adopted inflight session that never emits a terminal event", async () => {
    vi.useFakeTimers();
    try {
      const evicted: string[] = [];
      const latestAgentOutcome = vi.fn(async () => undefined);
      const { router, store } = makeRouter({
        runTimeoutMs: 10,
        poolStub: {
          getControlClient: () => undefined,
          evictSession: async (sessionId) => {
            evicted.push(sessionId);
          },
        },
        eventReaderStub: {
          stateRoot: "/tmp/test-state",
          latestAgentOutcome,
        },
      });
      const agent = store.agents.create({
        model: "m",
        tools: [],
        instructions: "",
        permissionPolicy: { type: "always_allow" },
        callableAgents: [],
        maxSubagentDepth: 0,
      });
      const session = router.createSession(agent.agentId);
      store.sessions.markRunning(session.sessionId);

      await router.observeAdoptedSession(session.sessionId);
      expect(store.sessions.get(session.sessionId)?.status).toBe("running");

      await vi.advanceTimersByTimeAsync(10);

      const finished = store.sessions.get(session.sessionId);
      expect(finished?.status).toBe("failed");
      expect(finished?.error).toMatch(/adopted session timed out/);
      expect(evicted).toEqual([session.sessionId]);
      expect(latestAgentOutcome).toHaveBeenCalledWith(agent.agentId, session.sessionId);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AgentRouter control capability enforcement", () => {
  it("rejects cancel when the harness does not support cancellation", async () => {
    const { router, store } = makeRouter({
      capabilityOverrides: {
        cancellation: unsupported("cancel is unavailable"),
      },
    });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      mcpServers: {},
    });
    const session = router.createSession(agent.agentId);
    store.sessions.beginRun(session.sessionId);

    await expect(router.cancel(session.sessionId)).rejects.toMatchObject({
      name: "RouterError",
      code: "unsupported_capability",
    });
    expect(store.sessions.get(session.sessionId)?.status).toBe("starting");
  });

  it("rejects tool confirmations when the harness does not expose approvals", async () => {
    const { router, store } = makeRouter({
      capabilityOverrides: {
        tool_approvals: unsupported("approvals are unavailable"),
      },
    });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      mcpServers: {},
    });
    const session = router.createSession(agent.agentId);

    await expect(
      router.confirmTool(session.sessionId, "approval_1", "allow"),
    ).rejects.toMatchObject({
      name: "RouterError",
      code: "unsupported_capability",
    });
  });

  it("rejects compaction when the harness marks it unsupported", async () => {
    const { router, store } = makeRouter({
      capabilityOverrides: {
        compaction: unsupported("manual compact is unavailable"),
      },
    });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      mcpServers: {},
    });
    const session = router.createSession(agent.agentId);

    await expect(router.compact(session.sessionId)).rejects.toMatchObject({
      name: "RouterError",
      code: "unsupported_capability",
    });
  });
});

describe("AgentRouter.runEvent — JSONL advancement guarantees", () => {
  function seedAgent(store: InMemoryStore) {
    return store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
  }

  it("bypasses warm-pool claim for delegating agents at acquire time", async () => {
    vi.stubEnv("OPENCLAW_TURN_ADVANCE_WAIT_MS", "0");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "done" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const acquireArgs: Array<{ bypassWarmPool?: boolean }> = [];
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi.fn(() => 0),
      latestAgentOutcome: vi.fn(() => undefined),
      latestAgentMessage: vi.fn(() => undefined),
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async (
          args: Parameters<ManagedSessionRuntime["acquireForSession"]>[0],
        ) => {
          acquireArgs.push({ bypassWarmPool: args.bypassWarmPool });
          return { baseUrl: "http://container.test", token: "tok" } as any;
        },
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as ManagedEventLog,
    });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: ["agt_child"],
      maxSubagentDepth: 1,
    });
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "delegate" });
    await waitForCondition("pool acquire", () => acquireArgs.length === 1);

    expect(acquireArgs[0]?.bypassWarmPool).toBe(true);
    await waitForSessionToStopRunning(store, session.sessionId);
  });

  it("fails the turn when chat.completions returns 200 but no new JSONL events were written", async () => {
    vi.stubEnv("OPENCLAW_TURN_ADVANCE_WAIT_MS", "0");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "all good" } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(undefined),
      latestAgentMessage: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(undefined),
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async () =>
          ({ baseUrl: "http://container.test", token: "tok" }) as any,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as ManagedEventLog,
    });
    const agent = seedAgent(store);
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "hi" });
    await waitForSessionToStopRunning(store, session.sessionId);

    const failed = store.sessions.get(session.sessionId);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("no new user.message was written to JSONL");
  });

  it("keeps the turn successful when the user turn is durable and only the assistant outcome lags JSONL", async () => {
    vi.stubEnv("OPENCLAW_TURN_ADVANCE_WAIT_MS", "0");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "direct completion" } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi.fn().mockReturnValue(1).mockReturnValueOnce(0),
      latestAgentOutcome: vi.fn().mockReturnValue(undefined),
      latestAgentMessage: vi.fn().mockReturnValue(undefined),
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async () =>
          ({ baseUrl: "http://container.test", token: "tok" }) as any,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as ManagedEventLog,
    });
    const agent = seedAgent(store);
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "hi" });
    await waitForSessionToStopRunning(store, session.sessionId);

    const finished = store.sessions.get(session.sessionId);
    expect(finished?.status).toBe("idle");
    expect(finished?.error).toBeNull();
    expect(finished?.tokensIn).toBe(11);
    expect(finished?.tokensOut).toBe(7);
  });

  it("keeps the turn successful when both user.message and agent.message advance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "done" } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 11,
          tokensOut: 7,
          costUsd: 0.12,
        }),
      latestAgentMessage: vi
        .fn()
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 11,
          tokensOut: 7,
          costUsd: 0.12,
        }),
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async () =>
          ({ baseUrl: "http://container.test", token: "tok" }) as any,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as ManagedEventLog,
    });
    const agent = seedAgent(store);
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "hi" });
    await waitForSessionToStopRunning(store, session.sessionId);

    const finished = store.sessions.get(session.sessionId);
    expect(finished?.status).toBe("idle");
    expect(finished?.error).toBeNull();
    expect(finished?.tokensIn).toBe(11);
    expect(finished?.tokensOut).toBe(7);
    expect(finished?.costUsd).toBe(0.12);
  });

  it("mirrors visible native events through the managed event append boundary after a successful turn", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "done" } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const nativeEvents: Event[] = [
      {
        eventId: "evt_user",
        sessionId: "native-session",
        type: "user.message",
        content: "hi",
        createdAt: 1,
      },
      {
        eventId: "evt_agent",
        sessionId: "native-session",
        type: "agent.message",
        content: "done",
        createdAt: 2,
        tokensIn: 11,
        tokensOut: 7,
      },
    ];
    const appendEvents = vi.fn();
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      appendEvents,
      listBySession: vi.fn().mockReturnValue(nativeEvents),
      countUserTurns: vi.fn().mockReturnValueOnce(0).mockReturnValue(1),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValue(nativeEvents[1]),
      latestAgentMessage: vi.fn().mockReturnValue(nativeEvents[1]),
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async () =>
          ({ baseUrl: "http://container.test", token: "tok" }) as any,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as ManagedEventLog,
    });
    const agent = seedAgent(store);
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "hi" });
    await waitForSessionToStopRunning(store, session.sessionId);

    expect(appendEvents).toHaveBeenCalledWith(agent.agentId, session.sessionId, nativeEvents);
  });

  it("keeps the turn successful when a tool result advances but no final agent.message is written", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "done" } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          eventId: "evt_tool_result",
          sessionId: "ses_unused",
          type: "agent.tool_result",
          content: "Fri Apr 24 17:58:01 UTC 2026",
          createdAt: Date.now(),
          toolName: "exec",
          toolCallId: "call-date",
        }),
      latestAgentMessage: vi
        .fn()
        .mockReturnValueOnce(undefined),
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async () =>
          ({ baseUrl: "http://container.test", token: "tok" }) as any,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as ManagedEventLog,
    });
    const agent = seedAgent(store);
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "what time is it?" });
    await waitForSessionToStopRunning(store, session.sessionId);

    const finished = store.sessions.get(session.sessionId);
    expect(finished?.status).toBe("idle");
    expect(finished?.error).toBeNull();
    expect(finished?.tokensIn).toBe(11);
    expect(finished?.tokensOut).toBe(7);
  });

  it("bakes first-turn model and thinking overrides into spawn options", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "done" } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 11,
          tokensOut: 7,
        }),
      latestAgentMessage: vi
        .fn()
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 11,
          tokensOut: 7,
        }),
    };
    let capturedSpawnOptions: unknown;
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async (args: { spawnOptions: unknown }) => {
          capturedSpawnOptions = args.spawnOptions;
          return { baseUrl: "http://container.test", token: "tok" } as any;
        },
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as ManagedEventLog,
    });
    const agent = store.agents.create({
      model: "moonshot/kimi-k2.5",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      thinkingLevel: "medium",
    });
    const session = router.createSession(agent.agentId);

    await router.runEvent({
      sessionId: session.sessionId,
      content: "hi",
      model: "openai/gpt-5.4",
      thinkingLevel: "high",
    });
    await waitForSessionToStopRunning(store, session.sessionId);

    expect(capturedSpawnOptions).toMatchObject({
      env: {
        OPENCLAW_MODEL: "openai/gpt-5.4",
        OPENCLAW_THINKING_LEVEL: "high",
      },
    });
  });

  it("uses WS patch instead of changing boot config for later-turn overrides", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "done" } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi
        .fn()
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(2),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce({
          eventId: "evt_old",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "old",
          createdAt: 1,
        })
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 11,
          tokensOut: 7,
        }),
      latestAgentMessage: vi
        .fn()
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 11,
          tokensOut: 7,
        }),
    };
    let capturedSpawnOptions: unknown;
    let patched: Record<string, unknown> | undefined;
    const fakeWs = {
      patch: async (_key: string, fields: Record<string, unknown>) => {
        patched = fields;
      },
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async (args: { spawnOptions: unknown }) => {
          capturedSpawnOptions = args.spawnOptions;
          return { baseUrl: "http://container.test", token: "tok" } as any;
        },
        getWsClient: () => fakeWs as unknown as GatewayWebSocketClient,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as ManagedEventLog,
    });
    const agent = store.agents.create({
      model: "moonshot/kimi-k2.5",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      thinkingLevel: "off",
    });
    const session = router.createSession(agent.agentId);
    store.sessions.bumpTurns(session.sessionId);

    await router.runEvent({
      sessionId: session.sessionId,
      content: "hi",
      model: "openai/gpt-5.4",
      thinkingLevel: "high",
    });
    await waitForSessionToStopRunning(store, session.sessionId);

    expect(capturedSpawnOptions).toMatchObject({
      env: {
        OPENCLAW_MODEL: "moonshot/kimi-k2.5",
        OPENCLAW_THINKING_LEVEL: "off",
      },
    });
    expect(patched).toEqual({
      model: "openai/gpt-5.4",
      thinkingLevel: "high",
    });
  });

  it("patches later turns back to off when the agent default is off", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "done" } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi
        .fn()
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(2),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce({
          eventId: "evt_old",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "old",
          createdAt: 1,
        })
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 11,
          tokensOut: 7,
        }),
      latestAgentMessage: vi
        .fn()
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 11,
          tokensOut: 7,
        }),
    };
    let patched: Record<string, unknown> | undefined;
    const fakeWs = {
      patch: async (_key: string, fields: Record<string, unknown>) => {
        patched = fields;
      },
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async () =>
          ({ baseUrl: "http://container.test", token: "tok" }) as any,
        getWsClient: () => fakeWs as unknown as GatewayWebSocketClient,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as ManagedEventLog,
    });
    const agent = store.agents.create({
      model: "moonshot/kimi-k2.5",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      thinkingLevel: "off",
    });
    const session = router.createSession(agent.agentId);
    store.sessions.bumpTurns(session.sessionId);

    await router.runEvent({
      sessionId: session.sessionId,
      content: "hi",
    });
    await waitForSessionToStopRunning(store, session.sessionId);

    expect(patched).toEqual({
      thinkingLevel: "off",
    });
  });

  it("falls back to transcript usage when the completion response omits usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "done" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 321,
          tokensOut: 45,
          costUsd: 0.42,
        }),
      latestAgentMessage: vi
        .fn()
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 321,
          tokensOut: 45,
          costUsd: 0.42,
        }),
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async () =>
          ({ baseUrl: "http://container.test", token: "tok" }) as any,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as ManagedEventLog,
    });
    const agent = seedAgent(store);
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "hi" });
    await waitForSessionToStopRunning(store, session.sessionId);

    const finished = store.sessions.get(session.sessionId);
    expect(finished?.status).toBe("idle");
    expect(finished?.tokensIn).toBe(321);
    expect(finished?.tokensOut).toBe(45);
    expect(finished?.costUsd).toBe(0.42);
  });

  it("normalizes input_tokens/output_tokens usage aliases from chat completion responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "done" } }],
            usage: { input_tokens: 18, output_tokens: 6 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          costUsd: 0.05,
        }),
      latestAgentMessage: vi
        .fn()
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          costUsd: 0.05,
        }),
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async () =>
          ({ baseUrl: "http://container.test", token: "tok" }) as any,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as ManagedEventLog,
    });
    const agent = seedAgent(store);
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "hi" });
    await waitForSessionToStopRunning(store, session.sessionId);

    const finished = store.sessions.get(session.sessionId);
    expect(finished?.status).toBe("idle");
    expect(finished?.tokensIn).toBe(18);
    expect(finished?.tokensOut).toBe(6);
    expect(finished?.costUsd).toBe(0.05);
  });

  it("estimates cost from the live ZenMux catalog when transcript cost is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "http://container.test/v1/chat/completions") {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "done" } }],
              usage: { prompt_tokens: 321, completion_tokens: 45 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url === "https://zenmux.ai/api/v1/models") {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "openai/gpt-5.4",
                  pricings: {
                    prompt: [{ value: 2.5, unit: "perMTokens", currency: "USD" }],
                    completion: [{ value: 10, unit: "perMTokens", currency: "USD" }],
                    request: [{ value: 0.01, unit: "perCount", currency: "USD" }],
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const fakeEvents = {
      stateRoot: "/tmp/test-state",
      countUserTurns: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1),
      latestAgentOutcome: vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 321,
          tokensOut: 45,
          model: "zenmux/openai/gpt-5.4",
        }),
      latestAgentMessage: vi
        .fn()
        .mockReturnValueOnce({
          eventId: "evt_new",
          sessionId: "ses_unused",
          type: "agent.message",
          content: "done",
          createdAt: Date.now(),
          tokensIn: 321,
          tokensOut: 45,
          model: "zenmux/openai/gpt-5.4",
        }),
    };
    const { router, store } = makeRouter({
      poolStub: {
        acquireForSession: async () =>
          ({ baseUrl: "http://container.test", token: "tok" }) as any,
        evictSession: async () => {},
      },
      eventReaderStub: fakeEvents as unknown as ManagedEventLog,
      passthroughEnv: { ZENMUX_API_KEY: "sk-test" },
    });
    const agent = store.agents.create({
      model: "openai/gpt-5.4",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);

    await router.runEvent({ sessionId: session.sessionId, content: "hi" });
    await waitForSessionToStopRunning(store, session.sessionId);

    const finished = store.sessions.get(session.sessionId);
    expect(finished?.status).toBe("idle");
    expect(finished?.tokensIn).toBe(321);
    expect(finished?.tokensOut).toBe(45);
    expect(finished?.costUsd).toBeCloseTo(0.0112525, 8);
  });
});

describe("AgentRouter.cancel — pre-abort checks", () => {
  it("throws session_not_found for an unknown session", async () => {
    const { router } = makeRouter();
    await expect(router.cancel("ses_missing")).rejects.toMatchObject({
      name: "RouterError",
      code: "session_not_found",
    });
  });

  it("throws session_not_running when the session is idle", async () => {
    const { router, store } = makeRouter();
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    // Session is idle (never called beginRun).
    await expect(router.cancel(session.sessionId)).rejects.toMatchObject({
      name: "RouterError",
      code: "session_not_running",
    });
  });

  it("cancels gracefully when running session has no pool entry (acquire phase)", async () => {
    // When cancel is called while the session is still acquiring a
    // container (no WS client yet), it should transition the session
    // to idle instead of throwing — the background task will detect
    // the flag and abort after acquire completes.
    const pool = {
      getWsClient: (_id: string): GatewayWebSocketClient | undefined => undefined,
    };
    const { router, store } = makeRouter({ poolStub: pool });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    store.sessions.beginRun(session.sessionId);

    const result = await router.cancel(session.sessionId);
    expect(result.status).toBe("idle");
  });

  it("routes native cancellation through the harness without a control client", async () => {
    const base = nativeTestHarness();
    const abortSession = vi.fn(async () => {});
    const native = nativeTestHarness({
      capabilities: {
        ...base.capabilities,
        cancellation: supported("native cancellation"),
      },
      abortSession,
    });
    const pool = {
      getWsClient: vi.fn((_id: string): GatewayWebSocketClient | undefined => undefined),
    };
    const { router, store } = makeRouter({
      extraHarnesses: [native],
      poolStub: pool,
    });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
      harnessId: "native-test",
    });
    const session = router.createSession(agent.agentId);
    store.sessions.beginRun(session.sessionId);

    const result = await router.cancel(session.sessionId);

    expect(result.status).toBe("idle");
    expect(pool.getWsClient).not.toHaveBeenCalled();
    expect(abortSession).toHaveBeenCalledWith(undefined, session.sessionId, undefined);
  });

  it("drains the queue and pending approvals then marks the session idle", async () => {
    // Happy-path cancel: WS abort succeeds, router clears per-session
    // bookkeeping. We use a fake ws that records the abort call and
    // resolves successfully.
    let abortedKey: string | undefined;
    const fakeWs = {
      abort: async (key: string) => {
        abortedKey = key;
      },
      close: async () => {},
    } as unknown as GatewayWebSocketClient;
    const pool = {
      getWsClient: (_id: string) => fakeWs,
    };
    const { router, store, queue } = makeRouter({ poolStub: pool });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    store.sessions.beginRun(session.sessionId);
    queue.enqueue(session.sessionId, {
      runId: "run_pending",
      content: "pending work",
      enqueuedAt: Date.now(),
    });

    const cancelled = await router.cancel(session.sessionId);
    expect(cancelled.status).toBe("idle");
    // Canonical session key is what OpenClaw's orphan-key migration
    // rewrites non-canonical forms to on startup, so using it directly
    // keeps our abort idempotent across OpenClaw restarts.
    expect(abortedKey).toBe(`agent:main:${session.sessionId}`);
    expect(queue.shift(session.sessionId)).toBeUndefined();
  });
});

describe("AgentRouter.getPendingApprovals", () => {
  it("returns an empty array for a session with no pending approvals", () => {
    const { router } = makeRouter();
    expect(router.getPendingApprovals("ses_whatever")).toEqual([]);
  });
});

class FakeApprovalWs {
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  pending: unknown[] = [];
  resolveImpl: (id: string, decision: string) => Promise<void> = async () => {};

  onEvent(eventName: string, handler: (payload: unknown) => void): () => void {
    const set = this.listeners.get(eventName) ?? new Set<(payload: unknown) => void>();
    set.add(handler);
    this.listeners.set(eventName, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.listeners.delete(eventName);
    };
  }

  async approvalList(): Promise<unknown[]> {
    return this.pending;
  }

  async approvalResolve(id: string, decision: string): Promise<void> {
    await this.resolveImpl(id, decision);
  }

  emit(eventName: string, payload: unknown): void {
    for (const handler of this.listeners.get(eventName) ?? []) {
      handler(payload);
    }
  }

  listenerCount(eventName: string): number {
    return this.listeners.get(eventName)?.size ?? 0;
  }
}

describe("AgentRouter approval flow", () => {
  function createApprovalSession(router: AgentRouter, store: InMemoryStore): string {
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_ask" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    return router.createSession(agent.agentId).sessionId;
  }

  it("keeps a pending approval when approvalResolve fails", async () => {
    const fakeWs = new FakeApprovalWs();
    fakeWs.resolveImpl = async () => {
      throw new Error("ws down");
    };
    const { router, store } = makeRouter({
      poolStub: {
        getWsClient: () => fakeWs as unknown as GatewayWebSocketClient,
      },
    });
    const sessionId = createApprovalSession(router, store);
    (router as any).pendingApprovals.set(sessionId, [{
      approvalId: "ap_1",
      sessionId,
      toolName: "write",
      toolCallId: "call_1",
      description: "write file?",
      arrivedAt: 1,
    }]);

    await expect(router.confirmTool(sessionId, "ap_1", "allow")).rejects.toMatchObject({
      name: "RouterError",
      code: "confirm_tool_failed",
    });
    expect(router.getPendingApprovals(sessionId)).toHaveLength(1);
    expect(router.getPendingApprovals(sessionId)[0]?.approvalId).toBe("ap_1");
  });

  it("rehydrates pending approvals from the gateway list with toolCallId metadata", async () => {
    const fakeWs = new FakeApprovalWs();
    fakeWs.pending = [{
      id: "ap_1",
      createdAtMs: 123,
      request: {
        toolName: "write",
        toolCallId: "call_1",
        description: "The agent wants to write a file.",
      },
    }];
    const { router, store } = makeRouter();
    const sessionId = createApprovalSession(router, store);

    await (router as any).ensureApprovalSubscriptions(
      sessionId,
      fakeWs as unknown as GatewayWebSocketClient,
    );

    expect(router.getPendingApprovals(sessionId)).toEqual([{
      approvalId: "ap_1",
      sessionId,
      toolName: "write",
      toolCallId: "call_1",
      description: "The agent wants to write a file.",
      arrivedAt: 123,
    }]);
  });

  it("deduplicates approval listeners per session and clears on resolved events", async () => {
    const fakeWs = new FakeApprovalWs();
    const { router, store } = makeRouter();
    const sessionId = createApprovalSession(router, store);

    await (router as any).ensureApprovalSubscriptions(
      sessionId,
      fakeWs as unknown as GatewayWebSocketClient,
    );
    await (router as any).ensureApprovalSubscriptions(
      sessionId,
      fakeWs as unknown as GatewayWebSocketClient,
    );

    expect(fakeWs.listenerCount("plugin.approval.requested")).toBe(1);
    expect(fakeWs.listenerCount("plugin.approval.resolved")).toBe(1);

    fakeWs.emit("plugin.approval.requested", {
      id: "ap_1",
      createdAtMs: 123,
      request: {
        title: "Tool requires confirmation: write",
        toolName: "write",
        toolCallId: "call_1",
        description: "desc",
      },
    });
    fakeWs.emit("plugin.approval.requested", {
      id: "ap_1",
      createdAtMs: 124,
      request: {
        title: "Tool requires confirmation: write",
        toolName: "write",
        toolCallId: "call_1",
        description: "desc",
      },
    });

    expect(router.getPendingApprovals(sessionId)).toHaveLength(1);
    expect(router.getPendingApprovals(sessionId)[0]?.toolCallId).toBe("call_1");

    fakeWs.emit("plugin.approval.resolved", { id: "ap_1", decision: "allow-once" });
    expect(router.getPendingApprovals(sessionId)).toEqual([]);
  });

  it("uses the session harness for control even if the agent template changes", async () => {
    const fakeWs = new FakeApprovalWs();
    const { router, store } = makeRouter({
      poolStub: {
        getWsClient: () => fakeWs as unknown as GatewayWebSocketClient,
      },
    });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_ask" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = router.createSession(agent.agentId);
    (agent as { harnessId: string }).harnessId = "missing";
    (router as any).pendingApprovals.set(session.sessionId, [{
      approvalId: "ap_1",
      sessionId: session.sessionId,
      toolName: "write",
      toolCallId: "call_1",
      description: "write file?",
      arrivedAt: 1,
    }]);

    await router.confirmTool(session.sessionId, "ap_1", "allow");

    expect(router.getPendingApprovals(session.sessionId)).toEqual([]);
  });

  it("syncs native harness approvals without a container control client", async () => {
    const listApprovals = vi.fn(async (_controlClient, sessionId: string) => [{
      approvalId: "ap_native_1",
      sessionId,
      toolName: "mcp__docs__write",
      toolCallId: "call_native_1",
      description: "write docs?",
      arrivedAt: 10,
    }]);
    const subscribeApprovalRequested = vi.fn((_controlClient, sessionId: string, handler) => {
      handler({
        approvalId: "ap_native_2",
        sessionId,
        toolName: "mcp__docs__search",
        toolCallId: "call_native_2",
        description: "search docs?",
        arrivedAt: 11,
      });
      return () => {};
    });
    const native = nativeTestHarness({
      capabilities: {
        ...nativeTestHarness().capabilities,
        tool_approvals: supported("native test approvals"),
      },
      listApprovals,
      subscribeApprovalRequested,
      subscribeApprovalResolved: vi.fn(() => () => {}),
    });
    const { router, store } = makeRouter({
      extraHarnesses: [native],
      poolStub: { getControlClient: () => undefined },
    });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_ask", tools: ["mcp__docs__write"] },
      callableAgents: [],
      maxSubagentDepth: 0,
      harnessId: "native-test",
    });
    const session = router.createSession(agent.agentId);

    await (router as any).ensureApprovalSubscriptions(session.sessionId, undefined);

    expect(listApprovals).toHaveBeenCalledWith(undefined, session.sessionId);
    expect(subscribeApprovalRequested).toHaveBeenCalledWith(
      undefined,
      session.sessionId,
      expect.any(Function),
    );
    expect(router.getPendingApprovals(session.sessionId).map((approval) => approval.approvalId))
      .toEqual(["ap_native_1"]);
  });

  it("resolves native harness approvals without a live container", async () => {
    const resolveApproval = vi.fn(async () => {});
    const native = nativeTestHarness({
      capabilities: {
        ...nativeTestHarness().capabilities,
        tool_approvals: supported("native test approvals"),
      },
      resolveApproval,
    });
    const { router, store } = makeRouter({
      extraHarnesses: [native],
      poolStub: { getControlClient: () => undefined },
    });
    const agent = store.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_ask", tools: ["mcp__docs__write"] },
      callableAgents: [],
      maxSubagentDepth: 0,
      harnessId: "native-test",
    });
    const session = router.createSession(agent.agentId);
    (router as any).pendingApprovals.set(session.sessionId, [{
      approvalId: "ap_native",
      sessionId: session.sessionId,
      toolName: "mcp__docs__write",
      toolCallId: "call_native",
      description: "write docs?",
      arrivedAt: 1,
    }]);

    await router.confirmTool(session.sessionId, "ap_native", "allow");

    expect(resolveApproval).toHaveBeenCalledWith(
      undefined,
      session.sessionId,
      "ap_native",
      "allow",
    );
    expect(router.getPendingApprovals(session.sessionId)).toEqual([]);
  });
});
