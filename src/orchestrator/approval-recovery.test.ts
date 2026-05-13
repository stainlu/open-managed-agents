import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedEventLog } from "../events/types.js";
import { HarnessRegistry } from "../harness/registry.js";
import type {
  HarnessAdapter,
  HarnessApprovalRequest,
  HarnessCapabilities,
} from "../harness/types.js";
import { NativeOnlySessionRuntime } from "../runtime/native.js";
import { SqliteStore } from "../store/sqlite.js";
import { LocalManagedWorkspace } from "../workspace/local.js";
import { AgentRouter, type RouterConfig } from "./router.js";
import type { Event } from "./types.js";

class EmptyEventLog implements ManagedEventLog {
  readonly stateRoot: string;

  constructor(stateRoot: string) {
    this.stateRoot = stateRoot;
  }

  async appendEvents(_agentId: string, _sessionId: string, _events: Event[]): Promise<void> {}

  async listBySession(_agentId: string, _sessionId: string): Promise<Event[]> {
    return [];
  }

  async latestAgentMessage(_agentId: string, _sessionId: string): Promise<Event | undefined> {
    return undefined;
  }

  async latestAgentOutcome(_agentId: string, _sessionId: string): Promise<Event | undefined> {
    return undefined;
  }

  async countUserTurns(_agentId: string, _sessionId: string): Promise<number> {
    return 0;
  }

  async statSessionLog(
    _agentId: string,
    _sessionId: string,
  ): Promise<{ bytes: number } | undefined> {
    return undefined;
  }

  async deleteBySession(_agentId: string, _sessionId: string): Promise<void> {}

  async *follow(_agentId: string, _sessionId: string): AsyncGenerator<Event> {}
}

const supported = (detail: string) => ({ support: "supported" as const, detail });
const unsupported = (detail: string) => ({ support: "unsupported" as const, detail });

function nativeApprovalHarness(overrides: Partial<HarnessAdapter> = {}): HarnessAdapter {
  const capabilities: HarnessCapabilities = {
    start_turn: supported("native approval test turns"),
    streaming: unsupported("streaming is not needed"),
    native_session_resume: supported("SQLite owns managed session metadata"),
    cancellation: unsupported("cancellation is not needed"),
    interruption: unsupported("interruption is not needed"),
    dynamic_model_patch: supported("native turns receive model fields directly"),
    compaction: unsupported("compaction is not needed"),
    tool_approvals: supported("native approval test approvals"),
    permission_deny: unsupported("deny is not needed"),
    mcp: unsupported("MCP is not needed"),
    managed_event_log: supported("managed events are OMA-owned"),
    usage: supported("usage is not needed"),
    subagents: unsupported("subagents are not needed"),
  };

  return {
    id: "native-test",
    displayName: "Native Test",
    runtimeMode: "native",
    capabilities,
    shouldBypassWarmPool: () => true,
    modelForUsage: (model) => model,
    isFailureOutput: () => false,
    invokeTurn: vi.fn(async () => ({ output: "", tokensIn: 0, tokensOut: 0 })),
    invokeStreamingTurn: vi.fn(async () => ({
      chunks: (async function* () {})(),
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
}

function makeRouter(store: SqliteStore, stateRoot: string, harness: HarnessAdapter): AgentRouter {
  const cfg: RouterConfig = {
    passthroughEnv: {},
    runTimeoutMs: 60_000,
    harnesses: new HarnessRegistry({ adapters: [harness], defaultId: "native-test" }),
  };
  return new AgentRouter(
    store.agents,
    store.environments,
    store.sessions,
    store.runs,
    new EmptyEventLog(stateRoot),
    new LocalManagedWorkspace(stateRoot),
    new NativeOnlySessionRuntime(),
    store.queue,
    store.approvals,
    store.vaults,
    cfg,
  );
}

describe("AgentRouter approval recovery", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "approval-recovery-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("surfaces and resolves a pending approval after reopening the durable store", async () => {
    const dbPath = join(tmpDir, "oma.db");
    const approval: HarnessApprovalRequest = {
      approvalId: "ap_restart",
      sessionId: "placeholder",
      toolName: "mcp__repo__write",
      toolCallId: "call_restart",
      description: "write after restart?",
      arrivedAt: 1234,
    };

    const firstStore = new SqliteStore(dbPath);
    const firstHarness = nativeApprovalHarness({
      listApprovals: vi.fn(async (_controlClient, sessionId: string) => [{
        ...approval,
        sessionId,
      }]),
    });
    const firstRouter = makeRouter(firstStore, tmpDir, firstHarness);
    const agent = firstStore.agents.create({
      model: "m",
      tools: [],
      instructions: "",
      permissionPolicy: { type: "always_ask", tools: ["mcp__repo__write"] },
      callableAgents: [],
      maxSubagentDepth: 0,
      harnessId: "native-test",
    });
    const session = firstRouter.createSession(agent.agentId);
    await (firstRouter as any).ensureApprovalSubscriptions(session.sessionId, undefined);
    expect(firstRouter.getPendingApprovals(session.sessionId)).toHaveLength(1);
    firstStore.close();

    const resolveApproval = vi.fn(async () => {});
    const secondStore = new SqliteStore(dbPath);
    const secondRouter = makeRouter(
      secondStore,
      tmpDir,
      nativeApprovalHarness({ resolveApproval }),
    );

    expect(secondRouter.getPendingApprovals(session.sessionId)).toEqual([
      {
        ...approval,
        sessionId: session.sessionId,
      },
    ]);

    await secondRouter.confirmTool(session.sessionId, "ap_restart", "allow");

    expect(resolveApproval).toHaveBeenCalledWith(
      undefined,
      session.sessionId,
      "ap_restart",
      "allow",
    );
    expect(secondRouter.getPendingApprovals(session.sessionId)).toEqual([]);
    secondStore.close();
  });
});
