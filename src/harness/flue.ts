import { randomUUID } from "node:crypto";
import type { AgentConfig, Event, McpServerConfig, Session } from "../orchestrator/types.js";
import type { VaultStore } from "../store/types.js";
import {
  WorkspaceError,
  type ManagedWorkspace,
  type WorkspaceEntry,
} from "../workspace/types.js";
import { injectMcpVaultCredentials } from "./mcp-credentials.js";
import type {
  HarnessAdapter,
  HarnessAgentConfigValidationInput,
  HarnessAgentConfigValidationIssue,
  HarnessApprovalRequest,
  HarnessApprovalResolution,
  HarnessCapabilities,
  HarnessStreamingTurn,
  HarnessStreamingTurnInvocationArgs,
  HarnessTurnInvocationArgs,
  HarnessTurnResult,
  HarnessTurnStateEvent,
} from "./types.js";
import { HarnessControlError, HarnessInvocationError } from "./types.js";
import type { ManagedHarnessStateStore } from "./state-store.js";

export type FlueEnginePromptArgs = {
  content: string;
  sessionId: string;
  runId?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  agent: AgentConfig;
  session?: Session;
  model?: string;
  thinkingLevel?: AgentConfig["thinkingLevel"];
};

export type FlueEngineUsage = {
  input?: number;
  output?: number;
  cost?: {
    total?: number;
  };
};

export type FlueEnginePromptResult = {
  text: string;
  usage?: FlueEngineUsage;
  model?: string | { id?: string };
  events?: FlueRuntimeEvent[];
  native?: HarnessTurnResult["native"];
};

export type FlueEngineShellArgs = Omit<FlueEnginePromptArgs, "content"> & {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
};

export type FlueEngineShellResult = FlueShellResult & {
  events?: FlueRuntimeEvent[];
  native?: {
    nativeSessionId?: string | null;
    nativeThreadId?: string | null;
    nativeMetadata?: Record<string, unknown> | null;
  };
};

export type FlueEngineTaskArgs = Omit<FlueEnginePromptArgs, "content"> & {
  task: string;
  cwd?: string;
};

export type FlueEngineTaskResult = FlueEnginePromptResult;

export type FlueEngine = {
  prompt(args: FlueEnginePromptArgs): Promise<FlueEnginePromptResult>;
  stream?(args: FlueEnginePromptArgs): Promise<HarnessStreamingTurn>;
  shell?(args: FlueEngineShellArgs): Promise<FlueEngineShellResult>;
  task?(args: FlueEngineTaskArgs): Promise<FlueEngineTaskResult>;
};

export type FlueShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type FlueShellInvocationArgs = {
  agent: AgentConfig;
  session?: Session;
  sessionId: string;
  runId?: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
};

export type FlueShellInvocationResult = FlueShellResult & {
  events?: Event[];
  native?: FlueEngineShellResult["native"];
};

export type FlueTaskInvocationArgs = {
  agent: AgentConfig;
  session?: Session;
  sessionId: string;
  runId?: string;
  task: string;
  cwd?: string;
  timeoutMs: number;
  model?: string;
  thinkingLevel?: AgentConfig["thinkingLevel"];
};

export type FlueTaskInvocationResult = {
  output: string;
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
  model?: string;
  events?: Event[];
  native?: HarnessTurnResult["native"];
};

export type FlueManagedWorkspaceCommandInvocation = {
  workspace: ManagedWorkspace;
  agentId: string;
  sessionId: string;
  command: string;
  /**
   * Absolute cwd inside the Flue sandbox view. OMA validates that this path is
   * within the mounted managed workspace before calling the executor.
   */
  cwd: string;
  /**
   * Absolute root where the managed workspace is mounted inside Flue's
   * SessionEnv.
   */
  workspaceRoot: string;
  /**
   * Cwd relative to the managed workspace root. Empty string means workspace
   * root.
   */
  relCwd: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  signal?: AbortSignal;
};

export type FlueManagedWorkspaceCommandExecutor = {
  /**
   * Execute against the same managed workspace exposed through Flue fs calls.
   * Implementations that use a remote sandbox must make command-side file
   * mutations visible through the supplied ManagedWorkspace before resolving.
   */
  exec(args: FlueManagedWorkspaceCommandInvocation): Promise<FlueShellResult>;
};

export type FlueProviderSettings = {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  storeResponses?: boolean;
};

export type FlueProviderConfig = Record<string, FlueProviderSettings>;

export type FlueMcpTransport = "streamable-http" | "sse";

export type FlueToolDef = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
};

export type FlueToolApprovalRequester = {
  request(args: {
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<"allow" | "deny">;
};

export type FlueMcpConnectOptions = {
  url: string | URL;
  transport?: FlueMcpTransport;
  headers?: Record<string, string>;
  requestInit?: RequestInit;
  fetch?: typeof fetch;
  clientName?: string;
  clientVersion?: string;
};

export type FlueMcpConnection = {
  name: string;
  tools: FlueToolDef[];
  close(): Promise<void>;
};

type FlueMcpScope = {
  tools: FlueToolDef[];
  close(): Promise<void>;
};

export type FlueMcpConnector = (
  name: string,
  options: FlueMcpConnectOptions,
) => Promise<FlueMcpConnection>;

export type CloudflareAIBindingLike = {
  run: (...args: unknown[]) => unknown;
};

export type FlueCloudflareAIBindingConfig = {
  binding: CloudflareAIBindingLike;
  gateway?: Record<string, unknown>;
  providerPrefix?: string;
};

export type FlueHarnessAdapterConfig = {
  passthroughEnv?: Record<string, string>;
  providerConfig?: FlueProviderConfig;
  cloudflareAiBinding?: CloudflareAIBindingLike;
  cloudflareAiGateway?: Record<string, unknown>;
  cloudflareAiProviderPrefix?: string;
  workspace?: ManagedWorkspace;
  workspaceCwd?: string;
  workspaceCommandExecutor?: FlueManagedWorkspaceCommandExecutor;
  sessionStateStore?: ManagedHarnessStateStore;
  vaults?: Pick<VaultStore, "listCredentials">;
  mcpConnector?: FlueMcpConnector;
  engine?: FlueEngine;
  loadEngine?: () => Promise<FlueEngine>;
};

const PROVIDER_API_KEY_ENV: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  "openai-codex": ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  zai: ["ZAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  huggingface: ["HF_TOKEN"],
  fireworks: ["FIREWORKS_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
};

export const FLUE_PROVIDER_ENV_KEYS = Array.from(
  new Set(Object.values(PROVIDER_API_KEY_ENV).flat()),
);

export function deriveFlueProviderConfigFromEnv(
  env: Record<string, string>,
): FlueProviderConfig {
  const result: FlueProviderConfig = {};
  for (const [provider, keys] of Object.entries(PROVIDER_API_KEY_ENV)) {
    const key = keys.find((candidate) => nonEmptyString(env[candidate]));
    if (key) result[provider] = { apiKey: env[key] };
  }
  return result;
}

export function mergeFlueProviderConfig(
  derived: FlueProviderConfig,
  explicit: FlueProviderConfig | undefined,
): FlueProviderConfig {
  if (!explicit) return derived;
  const merged: FlueProviderConfig = { ...derived };
  for (const [provider, settings] of Object.entries(explicit)) {
    const headers = {
      ...(merged[provider]?.headers ?? {}),
      ...(settings.headers ?? {}),
    };
    const next: FlueProviderSettings = {
      ...(merged[provider] ?? {}),
      ...settings,
    };
    if (Object.keys(headers).length > 0) next.headers = headers;
    merged[provider] = next;
  }
  return merged;
}

type FlueRuntimeEvent = {
  type?: string;
  runId?: string;
  parentRunId?: string;
  kind?: string;
  status?: string;
  eventIndex?: number;
  text?: string;
  delta?: string;
  content?: string;
  prompt?: string;
  message?: string;
  level?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  error?: unknown;
  isError?: boolean;
  taskId?: string;
  workId?: string;
  workKind?: string;
  operationId?: string;
  operationKind?: string;
  role?: string;
  cwd?: string;
  sessionId?: string;
  parentSession?: string;
  durationMs?: number;
  messagesBefore?: number;
  messagesAfter?: number;
  estimatedTokens?: number;
  reason?: string;
  stopReason?: string;
  usage?: FlueEngineUsage;
  model?: string | { id?: string };
};

export class FlueHarnessAdapter implements HarnessAdapter {
  readonly id = "flue";
  readonly displayName = "Flue";
  readonly runtimeMode = "native";
  readonly capabilities = {
    start_turn: {
      support: "supported",
      detail: "Runs a Flue prompt through the native SDK bridge.",
    },
    streaming: {
      support: "partial",
      detail: "Streams Flue prompt text deltas and live managed events; task streaming and shell streaming are not wired yet.",
    },
    native_session_resume: {
      support: "partial",
      detail: "Flue session data is persisted through OMA-managed harness state when configured; Cloudflare session-state wiring is not promoted yet.",
    },
    cancellation: {
      support: "partial",
      detail: "Active Flue prompt, task, and shell operations are cancelled with AbortSignal; task lifecycle is not promoted to OMA child sessions yet.",
    },
    interruption: {
      support: "unsupported",
      detail: "Steer/send style interruption is not exposed for Flue yet.",
    },
    dynamic_model_patch: {
      support: "supported",
      detail: "Per-turn model and thinking overrides are passed directly to Flue prompt calls.",
    },
    compaction: {
      support: "unsupported",
      detail: "Flue compaction is not exposed through OMA control methods yet.",
    },
    tool_approvals: {
      support: "partial",
      detail:
        "Exact always_ask approvals are enforced for URL MCP tools connected by OMA and Flue's built-in bash tool at OMA's SessionEnv.exec boundary; approve-all policy is rejected.",
    },
    permission_deny: {
      support: "partial",
      detail:
        "Exact deny policy is enforced for URL MCP tools connected by OMA and Flue's built-in bash tool at OMA's SessionEnv.exec boundary; other built-in/non-MCP tool names are rejected.",
    },
    mcp: {
      support: "partial",
      detail:
        "URL-based MCP servers are connected through Flue's MCP client with OMA vault injection, exact MCP-tool deny filtering, and exact MCP-tool approvals; stdio MCP servers are rejected.",
    },
    managed_event_log: {
      support: "partial",
      detail: "Adapter emits managed prompt boundary events and maps selected Flue runtime, task, and shell operation events.",
    },
    usage: {
      support: "supported",
      detail: "Maps Flue prompt usage input/output/cost fields when present.",
    },
    subagents: {
      support: "partial",
      detail: "Flue task operations can be observed and invoked through the bridge, but OMA first-class child sessions are not wired yet.",
    },
  } satisfies HarnessCapabilities;

  private enginePromise: Promise<FlueEngine> | undefined;
  private readonly activeCalls = new Map<string, AbortController>();
  private readonly pendingAborts = new Map<string, unknown>();
  private readonly approvals = new FlueApprovalBroker();

  constructor(private readonly cfg: FlueHarnessAdapterConfig = {}) {}

  validateAgentConfig(
    agent: HarnessAgentConfigValidationInput,
  ): HarnessAgentConfigValidationIssue | undefined {
    return validateFlueAgentConfig(agent);
  }

  shouldBypassWarmPool(): boolean {
    return true;
  }

  modelForUsage(model: string): string {
    return model;
  }

  isFailureOutput(_output: string): boolean {
    return false;
  }

  async invokeTurn(args: HarnessTurnInvocationArgs): Promise<HarnessTurnResult> {
    this.assertLlmCallable(args);
    const runId = args.runId ?? createFallbackRunId();
    const callController = this.startCall(args.sessionId);
    const engine = await this.resolveEngine();
    let result: FlueEnginePromptResult;
    try {
      result = await engine.prompt({
        content: args.content,
        sessionId: args.sessionId,
        runId,
        timeoutMs: args.timeoutMs,
        signal: AbortSignal.any([
          callController.signal,
          AbortSignal.timeout(args.timeoutMs),
        ]),
        agent: args.agent,
        session: args.session,
        model: args.model,
        thinkingLevel: args.thinkingLevel,
      });
    } finally {
      this.finishCall(args.sessionId, callController);
    }

    const model = modelId(result.model) ?? args.model ?? args.agent.model;
    const tokensIn = finiteTokenCount(result.usage?.input);
    const tokensOut = finiteTokenCount(result.usage?.output);
    const costUsd = finiteNumber(result.usage?.cost?.total);
    const events = buildManagedEvents({
      content: args.content,
      output: result.text,
      sessionId: args.sessionId,
      runId,
      model,
      tokensIn,
      tokensOut,
      costUsd,
      flueEvents: result.events ?? [],
    });

    return {
      output: result.text,
      tokensIn,
      tokensOut,
      model,
      events,
      native: result.native ?? {
        nativeSessionId: args.sessionId,
        nativeThreadId: null,
        nativeMetadata: { harness: "flue", runId },
      },
    };
  }

  async invokeStreamingTurn(
    args: HarnessStreamingTurnInvocationArgs,
  ): Promise<HarnessStreamingTurn> {
    this.assertLlmCallable(args);
    const runId = args.runId ?? createFallbackRunId();
    const engine = await this.resolveEngine();
    if (!engine.stream) {
      throw new HarnessInvocationError("Flue engine does not expose streaming prompt calls");
    }
    const callController = this.startCall(args.sessionId);
    let stream: HarnessStreamingTurn;
    try {
      stream = await engine.stream({
        content: args.content,
        sessionId: args.sessionId,
        runId,
        timeoutMs: args.timeoutMs,
        signal: AbortSignal.any([
          callController.signal,
          AbortSignal.timeout(args.timeoutMs),
        ]),
        agent: args.agent,
        session: args.session,
        model: args.model,
        thinkingLevel: args.thinkingLevel,
      });
    } catch (err) {
      this.finishCall(args.sessionId, callController);
      throw err;
    }

    let finished = false;
    const cleanup = (): void => {
      if (finished) return;
      finished = true;
      this.finishCall(args.sessionId, callController);
    };
    return {
      chunks: (async function* (): AsyncGenerator<string, void, void> {
        try {
          for await (const chunk of stream.chunks) {
            yield chunk;
          }
        } finally {
          cleanup();
        }
      })(),
      liveEvents: stream.liveEvents,
      events: stream.events,
      get result() {
        return stream.result;
      },
      abort: async (reason?: string) => {
        callController.abort(reason ?? new Error(`OMA cancelled Flue session ${args.sessionId}`));
        await stream.abort(reason);
        cleanup();
      },
    };
  }

  async invokeShell(args: FlueShellInvocationArgs): Promise<FlueShellInvocationResult> {
    const issue = validateFlueAgentConfig(args.agent);
    if (issue) {
      throw new HarnessInvocationError(issue.detail);
    }
    const runId = args.runId ?? createFallbackRunId();
    const engine = await this.resolveEngine();
    if (!engine.shell) {
      throw new HarnessInvocationError("Flue engine does not expose shell calls");
    }
    const callController = this.startCall(args.sessionId);
    let result: FlueEngineShellResult;
    try {
      result = await engine.shell({
        command: args.command,
        cwd: args.cwd,
        env: args.env,
        sessionId: args.sessionId,
        runId,
        timeoutMs: args.timeoutMs,
        signal: AbortSignal.any([
          callController.signal,
          AbortSignal.timeout(args.timeoutMs),
        ]),
        agent: args.agent,
        session: args.session,
      });
    } finally {
      this.finishCall(args.sessionId, callController);
    }
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      events: mapFlueEvents(
        result.events ?? [],
        args.sessionId,
        runId,
        runId,
        Date.now(),
      ),
      native: result.native ?? {
        nativeSessionId: args.sessionId,
        nativeThreadId: null,
        nativeMetadata: { harness: "flue", runId, operation: "shell" },
      },
    };
  }

  async invokeTask(args: FlueTaskInvocationArgs): Promise<FlueTaskInvocationResult> {
    this.assertLlmCallable(args);
    const runId = args.runId ?? createFallbackRunId();
    const engine = await this.resolveEngine();
    if (!engine.task) {
      throw new HarnessInvocationError("Flue engine does not expose task calls");
    }
    const callController = this.startCall(args.sessionId);
    let result: FlueEngineTaskResult;
    try {
      result = await engine.task({
        task: args.task,
        cwd: args.cwd,
        sessionId: args.sessionId,
        runId,
        timeoutMs: args.timeoutMs,
        signal: AbortSignal.any([
          callController.signal,
          AbortSignal.timeout(args.timeoutMs),
        ]),
        agent: args.agent,
        session: args.session,
        model: args.model,
        thinkingLevel: args.thinkingLevel,
      });
    } finally {
      this.finishCall(args.sessionId, callController);
    }
    const model = modelId(result.model) ?? args.model ?? args.agent.model;
    const tokensIn = finiteTokenCount(result.usage?.input);
    const tokensOut = finiteTokenCount(result.usage?.output);
    const costUsd = finiteNumber(result.usage?.cost?.total);
    return {
      output: result.text,
      tokensIn,
      tokensOut,
      costUsd,
      model,
      events: mapFlueEvents(
        result.events ?? [],
        args.sessionId,
        runId,
        runId,
        Date.now(),
      ),
      native: result.native ?? {
        nativeSessionId: args.sessionId,
        nativeThreadId: null,
        nativeMetadata: { harness: "flue", runId, operation: "task" },
      },
    };
  }

  async patchSession(): Promise<void> {
    // Native Flue turns receive model/thinking at invocation time; there is no
    // endpoint-backed live session patch in this adapter.
  }

  async abortSession(_controlClient: unknown, sessionId: string): Promise<void> {
    const reason = new Error(`OMA cancelled Flue session ${sessionId}`);
    const active = this.activeCalls.get(sessionId);
    if (!active) {
      this.pendingAborts.set(sessionId, reason);
      return;
    }
    active.abort(reason);
  }

  async compactSession(): Promise<void> {
    throw new HarnessControlError(
      "unsupported_capability",
      "Flue compaction is not wired yet",
    );
  }

  async resolveApproval(
    _controlClient: unknown,
    sessionId: string,
    approvalId: string,
    decision: "allow" | "deny",
  ): Promise<void> {
    this.approvals.resolve(sessionId, approvalId, decision);
  }

  async listApprovals(
    _controlClient: unknown,
    sessionId: string,
  ): Promise<HarnessApprovalRequest[]> {
    return this.approvals.list(sessionId);
  }

  subscribeApprovalRequested(
    _controlClient: unknown,
    sessionId: string,
    handler: (approval: HarnessApprovalRequest) => void,
  ): () => void {
    return this.approvals.subscribeRequested(sessionId, handler);
  }

  subscribeApprovalResolved(
    _controlClient: unknown,
    handler: (resolution: HarnessApprovalResolution) => void,
  ): () => void {
    return this.approvals.subscribeResolved(handler);
  }

  subscribeTurnState(
    _controlClient: unknown,
    _sessionId: string,
    _handler: (event: HarnessTurnStateEvent) => void,
  ): () => void {
    return () => {};
  }

  private resolveEngine(): Promise<FlueEngine> {
    if (this.cfg.engine) return Promise.resolve(this.cfg.engine);
    if (!this.enginePromise) {
      this.enginePromise = this.cfg.loadEngine
        ? this.cfg.loadEngine()
        : Promise.resolve(new OptionalSdkFlueEngine(
          this.cfg.passthroughEnv ?? {},
          this.cfg.providerConfig,
          this.cfg.cloudflareAiBinding
            ? {
              binding: this.cfg.cloudflareAiBinding,
              gateway: this.cfg.cloudflareAiGateway,
              providerPrefix: this.cfg.cloudflareAiProviderPrefix,
            }
            : undefined,
          this.cfg.workspace,
          this.cfg.workspaceCwd,
          this.cfg.workspaceCommandExecutor,
          this.cfg.sessionStateStore,
          this.cfg.vaults,
          this.cfg.mcpConnector,
          this.approvals,
        ));
    }
    return this.enginePromise;
  }

  private assertLlmCallable(
    args: { agent?: AgentConfig },
  ): asserts args is typeof args & { agent: AgentConfig } {
    if (!args.agent) {
      throw new HarnessInvocationError("Flue LLM call requires agent config");
    }
    const issue = validateFlueAgentConfig(args.agent);
    if (issue) {
      throw new HarnessInvocationError(issue.detail);
    }
  }

  private startCall(sessionId: string): AbortController {
    const callController = new AbortController();
    this.activeCalls.set(sessionId, callController);
    if (this.pendingAborts.has(sessionId)) {
      callController.abort(this.pendingAborts.get(sessionId));
    }
    return callController;
  }

  private finishCall(sessionId: string, callController: AbortController): void {
    if (this.activeCalls.get(sessionId) === callController) {
      this.activeCalls.delete(sessionId);
    }
    this.pendingAborts.delete(sessionId);
  }
}

class OptionalSdkFlueEngine implements FlueEngine {
  private internalPromise: Promise<FlueInternalModule> | undefined;
  private appPromise: Promise<FlueAppModule> | undefined;
  private cloudflarePromise: Promise<FlueCloudflareModule> | undefined;
  private clientPromise: Promise<FlueClientModule> | undefined;
  private providersConfigured = false;
  private storePromise: Promise<unknown> | undefined;

  constructor(
    private readonly passthroughEnv: Record<string, string>,
    private readonly providerConfig: FlueProviderConfig | undefined,
    private readonly cloudflareAi: FlueCloudflareAIBindingConfig | undefined,
    private readonly workspace: ManagedWorkspace | undefined,
    private readonly workspaceCwd: string | undefined,
    private readonly workspaceCommandExecutor: FlueManagedWorkspaceCommandExecutor | undefined,
    private readonly sessionStateStore: ManagedHarnessStateStore | undefined,
    private readonly vaults: Pick<VaultStore, "listCredentials"> | undefined,
    private readonly mcpConnector: FlueMcpConnector | undefined,
    private readonly approvals: FlueApprovalBroker | undefined,
  ) {}

  async prompt(args: FlueEnginePromptArgs): Promise<FlueEnginePromptResult> {
    const runId = args.runId ?? createFallbackRunId();
    const ctx = await this.createContext({ ...args, runId });
    const events: FlueRuntimeEvent[] = [];
    ctx.setEventCallback((event: FlueRuntimeEvent) => {
      events.push(event);
    });
    let mcp: FlueMcpScope | undefined;
    try {
      mcp = await this.connectMcpTools(args);
      const flueAgent = await ctx.init({
        id: args.agent.agentId,
        model: args.model ?? args.agent.model,
        thinkingLevel: args.thinkingLevel ?? args.agent.thinkingLevel,
        tools: mcp.tools,
      });
      const session = await flueAgent.session(args.sessionId);
      const response = await session.prompt(args.content, {
        model: args.model,
        thinkingLevel: args.thinkingLevel,
        signal: args.signal ?? AbortSignal.timeout(args.timeoutMs),
      });
      return {
        text: typeof response.text === "string" ? response.text : "",
        usage: response.usage,
        model: response.model,
        events,
      };
    } finally {
      ctx.setEventCallback(undefined);
      this.approvals?.clearSession(args.sessionId);
      await mcp?.close();
    }
  }

  async stream(args: FlueEnginePromptArgs): Promise<HarnessStreamingTurn> {
    const runId = args.runId ?? createFallbackRunId();
    const ctx = await this.createContext({ ...args, runId });
    const turnId = runId;
    const createdAt = Date.now();
    let eventIndex = 0;
    let output = "";
    let result: HarnessTurnResult | undefined;
    let promptHandle: FlueCallHandle | undefined;
    let mcp: FlueMcpScope | undefined;
    const chunks = new AsyncQueue<string>();
    const liveEvents = new AsyncQueue<Event>();
    const modelForChunks = args.model ?? args.agent.model;

    liveEvents.push({
      eventId: `evt_flue_${turnId}_user`,
      sessionId: args.sessionId,
      type: "user.message",
      content: args.content,
      createdAt,
      runId,
    });

    ctx.setEventCallback((event: FlueRuntimeEvent) => {
      if (event.type === "text_delta" && typeof event.text === "string") {
        output += event.text;
        chunks.push(openAiTextChunk({
          id: turnId,
          model: modelForChunks,
          content: event.text,
        }));
      }
      const mapped = mapFlueEvent(
        event,
        args.sessionId,
        runId,
        `evt_flue_${turnId}_runtime_${eventIndex}`,
        createdAt + eventIndex + 1,
      );
      eventIndex++;
      if (mapped) liveEvents.push(mapped);
    });

    (async () => {
      try {
        mcp = await this.connectMcpTools(args);
        const flueAgent = await ctx.init({
          id: args.agent.agentId,
          model: args.model ?? args.agent.model,
          thinkingLevel: args.thinkingLevel ?? args.agent.thinkingLevel,
          tools: mcp.tools,
        });
        const session = await flueAgent.session(args.sessionId);
        promptHandle = session.prompt(args.content, {
          model: args.model,
          thinkingLevel: args.thinkingLevel,
          signal: args.signal ?? AbortSignal.timeout(args.timeoutMs),
        }) as FlueCallHandle;
        const response = await promptHandle;
        const text = typeof response.text === "string" ? response.text : "";
        if (output.length === 0 && text.length > 0) {
          chunks.push(openAiTextChunk({ id: turnId, model: modelForChunks, content: text }));
        }
        output = text;
        const model = modelId(response.model) ?? args.model ?? args.agent.model;
        const tokensIn = finiteTokenCount(response.usage?.input);
        const tokensOut = finiteTokenCount(response.usage?.output);
        const costUsd = finiteNumber(response.usage?.cost?.total);
        result = {
          output,
          tokensIn,
          tokensOut,
          model,
          native: {
            nativeSessionId: args.sessionId,
            nativeThreadId: null,
            nativeMetadata: { harness: "flue", runId },
          },
        };
        liveEvents.push({
          eventId: `evt_flue_${turnId}_agent`,
          sessionId: args.sessionId,
          type: "agent.message",
          content: output,
          createdAt: createdAt + eventIndex + 1,
          tokensIn,
          tokensOut,
          costUsd,
          model,
          runId,
        });
        chunks.push(openAiFinishChunk({ id: turnId, model }));
        chunks.push("[DONE]");
        chunks.close();
        liveEvents.close();
      } catch (err) {
        chunks.fail(err);
        liveEvents.fail(err);
      } finally {
        ctx.setEventCallback(undefined);
        this.approvals?.clearSession(args.sessionId);
        await mcp?.close();
      }
    })();

    return {
      chunks: chunks.iterate(),
      liveEvents: liveEvents.iterate(),
      get result() {
        return result;
      },
      abort: async (reason?: string) => {
        promptHandle?.abort?.(reason);
      },
    };
  }

  async shell(args: FlueEngineShellArgs): Promise<FlueEngineShellResult> {
    const runId = args.runId ?? createFallbackRunId();
    const ctx = await this.createContext({
      ...args,
      content: args.command,
      runId,
    });
    const events: FlueRuntimeEvent[] = [];
    ctx.setEventCallback((event: FlueRuntimeEvent) => {
      events.push(event);
    });
    try {
      const flueAgent = await ctx.init({
        id: args.agent.agentId,
        model: false,
        thinkingLevel: args.thinkingLevel ?? args.agent.thinkingLevel,
      });
      const session = await flueAgent.session(args.sessionId);
      const result = await session.shell(args.command, {
        cwd: args.cwd,
        env: args.env,
        signal: args.signal ?? AbortSignal.timeout(args.timeoutMs),
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        events,
        native: {
          nativeSessionId: args.sessionId,
          nativeThreadId: null,
          nativeMetadata: { harness: "flue", runId, operation: "shell" },
        },
      };
    } finally {
      ctx.setEventCallback(undefined);
      this.approvals?.clearSession(args.sessionId);
    }
  }

  async task(args: FlueEngineTaskArgs): Promise<FlueEngineTaskResult> {
    const runId = args.runId ?? createFallbackRunId();
    const ctx = await this.createContext({
      ...args,
      content: args.task,
      runId,
    });
    const events: FlueRuntimeEvent[] = [];
    ctx.setEventCallback((event: FlueRuntimeEvent) => {
      events.push(event);
    });
    let mcp: FlueMcpScope | undefined;
    try {
      mcp = await this.connectMcpTools(args);
      const flueAgent = await ctx.init({
        id: args.agent.agentId,
        model: args.model ?? args.agent.model,
        thinkingLevel: args.thinkingLevel ?? args.agent.thinkingLevel,
        tools: mcp.tools,
      });
      const session = await flueAgent.session(args.sessionId);
      const response = await session.task(args.task, {
        cwd: args.cwd,
        model: args.model,
        thinkingLevel: args.thinkingLevel,
        signal: args.signal ?? AbortSignal.timeout(args.timeoutMs),
      });
      return {
        text: typeof response.text === "string" ? response.text : "",
        usage: response.usage,
        model: response.model,
        events,
        native: {
          nativeSessionId: args.sessionId,
          nativeThreadId: null,
          nativeMetadata: { harness: "flue", runId, operation: "task" },
        },
      };
    } finally {
      ctx.setEventCallback(undefined);
      this.approvals?.clearSession(args.sessionId);
      await mcp?.close();
    }
  }

  private async createContext(args: FlueEnginePromptArgs): Promise<FlueContextLike> {
    await this.configureProviders();
    const internal = await this.loadInternal();
    const store = await this.loadStore(internal, args);
    const env = this.workspace
      ? await FlueManagedWorkspaceSessionEnv.create({
        workspace: this.workspace,
        agentId: args.agent.agentId,
        sessionId: args.sessionId,
        cwd: this.workspaceCwd,
        instructions: args.agent.instructions,
        commandExecutor: this.workspaceCommandExecutor,
        permissionPolicy: args.agent.permissionPolicy,
        approvals: this.approvals,
      })
      : new MemorySessionEnv(args.agent.instructions, {
        sessionId: args.sessionId,
        permissionPolicy: args.agent.permissionPolicy,
        approvals: this.approvals,
      });
    return internal.createFlueContext({
      id: args.agent.agentId,
      runId: args.runId ?? createFallbackRunId(),
      payload: { content: args.content, managedSessionId: args.sessionId },
      env: this.passthroughEnv,
      req: undefined,
      agentConfig: {
        systemPrompt: "",
        skills: {},
        roles: {},
        model: undefined,
        resolveModel: internal.resolveModel,
        thinkingLevel: args.agent.thinkingLevel,
      },
      createDefaultEnv: async () => env,
      createLocalEnv: async () => env,
      defaultStore: store,
    });
  }

  private async loadInternal(): Promise<FlueInternalModule> {
    if (!this.internalPromise) {
      this.internalPromise = importFlueRuntimeSubpath(
        "internal",
        validateFlueInternalModule,
        "runtime helpers",
      );
    }
    return this.internalPromise;
  }

  private async configureProviders(): Promise<void> {
    if (this.providersConfigured) return;
    const providerConfig = mergeFlueProviderConfig(
      deriveFlueProviderConfigFromEnv(this.passthroughEnv),
      this.providerConfig,
    );
    if (Object.keys(providerConfig).length === 0 && !this.cloudflareAi) {
      this.providersConfigured = true;
      return;
    }

    const app = await this.loadApp();
    if (this.cloudflareAi) {
      const [internal, cloudflare] = await Promise.all([
        this.loadInternal(),
        this.loadCloudflare(),
      ]);
      const providerPrefix = this.cloudflareAi.providerPrefix ?? "cloudflare";
      app.registerApiProvider(cloudflare.getCloudflareAIBindingApiProvider());
      if (!internal.hasRegisteredProvider(providerPrefix)) {
        app.registerProvider(providerPrefix, {
          api: "cloudflare-ai-binding",
          binding: this.cloudflareAi.binding,
          gateway: this.cloudflareAi.gateway ?? { id: "default" },
        });
      }
    }
    for (const [provider, settings] of Object.entries(providerConfig)) {
      app.configureProvider(provider, settings);
    }
    this.providersConfigured = true;
  }

  private async loadApp(): Promise<FlueAppModule> {
    if (!this.appPromise) {
      this.appPromise = importFlueRuntimeSubpath(
        "app",
        validateFlueAppModule,
        "provider configuration helpers",
      );
    }
    return this.appPromise;
  }

  private async loadCloudflare(): Promise<FlueCloudflareModule> {
    if (!this.cloudflarePromise) {
      this.cloudflarePromise = importFlueRuntimeSubpath(
        "cloudflare",
        validateFlueCloudflareModule,
        "Cloudflare AI binding helpers",
      );
    }
    return this.cloudflarePromise;
  }

  private async loadStore(
    internal: FlueInternalModule,
    args: FlueEnginePromptArgs,
  ): Promise<unknown> {
    if (this.sessionStateStore) {
      return new FlueManagedSessionStore(
        this.sessionStateStore,
        args.agent.agentId,
        args.sessionId,
      );
    }
    if (!this.storePromise) {
      this.storePromise = Promise.resolve(new internal.InMemorySessionStore());
    }
    return this.storePromise;
  }

  private async connectMcpTools(args: {
    agent: AgentConfig;
    session?: Session;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<FlueMcpScope> {
    let servers: AgentConfig["mcpServers"];
    try {
      servers = injectMcpVaultCredentials(
        args.agent.mcpServers,
        this.vaults,
        args.session?.vaultId,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HarnessInvocationError(message);
    }
    const entries = Object.entries(servers ?? {});
    if (entries.length === 0) {
      return {
        tools: applyFlueToolPolicy([], args.agent.permissionPolicy, {
          approvals: this.approvals,
          sessionId: args.sessionId,
          signal: args.signal,
        }),
        close: async () => {},
      };
    }
    if (args.signal?.aborted) throw abortErrorFor(args.signal);

    const connector = await this.resolveMcpConnector();
    const connections: FlueMcpConnection[] = [];
    try {
      for (const [name, server] of entries) {
        connections.push(await connector(
          name,
          flueMcpConnectOptions(name, server),
        ));
      }
    } catch (err) {
      await closeFlueMcpConnections(connections);
      throw err;
    }
    try {
      return {
        tools: applyFlueToolPolicy(
          connections.flatMap((connection) => connection.tools),
          args.agent.permissionPolicy,
          {
            approvals: this.approvals,
            sessionId: args.sessionId,
            signal: args.signal,
          },
        ),
        close: () => closeFlueMcpConnections(connections),
      };
    } catch (err) {
      await closeFlueMcpConnections(connections);
      throw err;
    }
  }

  private async resolveMcpConnector(): Promise<FlueMcpConnector> {
    if (this.mcpConnector) return this.mcpConnector;
    const client = await this.loadClient();
    return client.connectMcpServer;
  }

  private async loadClient(): Promise<FlueClientModule> {
    if (!this.clientPromise) {
      this.clientPromise = importFlueRuntimeRoot(
        validateFlueClientModule,
        "MCP client helpers",
      );
    }
    return this.clientPromise;
  }
}

export class FlueManagedSessionStore {
  constructor(
    private readonly store: ManagedHarnessStateStore,
    private readonly agentId: string,
    private readonly managedSessionId: string,
  ) {}

  async save(id: string, data: unknown): Promise<void> {
    await this.store.save({
      harnessId: "flue",
      agentId: this.agentId,
      sessionId: this.managedSessionId,
      key: id,
      value: data,
    });
  }

  async load(id: string): Promise<unknown | null> {
    return await this.store.load({
      harnessId: "flue",
      agentId: this.agentId,
      sessionId: this.managedSessionId,
      key: id,
    });
  }

  async delete(id: string): Promise<void> {
    await this.store.delete({
      harnessId: "flue",
      agentId: this.agentId,
      sessionId: this.managedSessionId,
      key: id,
    });
  }
}

type FluePendingApproval = {
  approval: HarnessApprovalRequest;
  resolve: (decision: "allow" | "deny") => void;
  reject: (err: unknown) => void;
  cleanup: () => void;
};

class FlueApprovalBroker implements FlueToolApprovalRequester {
  private readonly pending = new Map<string, FluePendingApproval>();
  private readonly requestedHandlers = new Map<
    string,
    Set<(approval: HarnessApprovalRequest) => void>
  >();
  private readonly resolvedHandlers = new Set<
    (resolution: HarnessApprovalResolution) => void
  >();

  request(args: {
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<"allow" | "deny"> {
    if (args.signal?.aborted) return Promise.reject(abortErrorFor(args.signal));
    const approvalId = `ap_flue_${randomUUID()}`;
    const approval: HarnessApprovalRequest = {
      approvalId,
      sessionId: args.sessionId,
      toolName: args.toolName,
      toolCallId: approvalId,
      description: flueApprovalDescription(args.toolName, args.args),
      arrivedAt: Date.now(),
    };
    return new Promise<"allow" | "deny">((resolve, reject) => {
      const abort = () => {
        this.pending.delete(approvalId);
        reject(args.signal ? abortErrorFor(args.signal) : new Error("approval aborted"));
      };
      const cleanup = () => {
        args.signal?.removeEventListener("abort", abort);
      };
      args.signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(approvalId, {
        approval,
        resolve,
        reject,
        cleanup,
      });
      for (const handler of this.requestedHandlers.get(args.sessionId) ?? []) {
        handler(approval);
      }
    });
  }

  resolve(
    sessionId: string,
    approvalId: string,
    decision: "allow" | "deny",
  ): void {
    const pending = this.pending.get(approvalId);
    if (!pending || pending.approval.sessionId !== sessionId) {
      throw new HarnessControlError(
        "tool_approval_not_found",
        `Flue approval ${approvalId} is not pending for session ${sessionId}`,
      );
    }
    this.pending.delete(approvalId);
    pending.cleanup();
    pending.resolve(decision);
    for (const handler of this.resolvedHandlers) {
      handler({ approvalId, decision });
    }
  }

  list(sessionId: string): HarnessApprovalRequest[] {
    return [...this.pending.values()]
      .map((entry) => entry.approval)
      .filter((approval) => approval.sessionId === sessionId);
  }

  subscribeRequested(
    sessionId: string,
    handler: (approval: HarnessApprovalRequest) => void,
  ): () => void {
    const handlers = this.requestedHandlers.get(sessionId) ?? new Set();
    handlers.add(handler);
    this.requestedHandlers.set(sessionId, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.requestedHandlers.delete(sessionId);
    };
  }

  subscribeResolved(
    handler: (resolution: HarnessApprovalResolution) => void,
  ): () => void {
    this.resolvedHandlers.add(handler);
    return () => {
      this.resolvedHandlers.delete(handler);
    };
  }

  clearSession(sessionId: string): void {
    for (const [approvalId, pending] of [...this.pending.entries()]) {
      if (pending.approval.sessionId !== sessionId) continue;
      this.pending.delete(approvalId);
      pending.cleanup();
      pending.reject(new Error(`Flue session ${sessionId} ended before tool approval resolved`));
    }
  }
}

type FlueInternalModule = {
  createFlueContext: (config: Record<string, unknown>) => FlueContextLike;
  InMemorySessionStore: new () => unknown;
  resolveModel: (model: string | false | undefined) => unknown;
  hasRegisteredProvider: (provider: string) => boolean;
};

type FlueAppModule = {
  configureProvider: (provider: string, settings: FlueProviderSettings) => void;
  registerApiProvider: (provider: unknown) => void;
  registerProvider: (provider: string, registration: Record<string, unknown>) => void;
};

type FlueCloudflareModule = {
  getCloudflareAIBindingApiProvider: () => unknown;
};

type FlueClientModule = {
  connectMcpServer: FlueMcpConnector;
};

type FlueContextLike = {
  setEventCallback(callback: ((event: FlueRuntimeEvent) => void) | undefined): void;
  init(options: Record<string, unknown>): Promise<FlueAgentLike>;
};

type FlueAgentLike = {
  session(id?: string): Promise<FlueSessionLike>;
};

type FlueSessionLike = {
  prompt(
    content: string,
    options?: Record<string, unknown>,
  ): FlueCallHandle;
  shell(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): FlueCallHandle<FlueShellResult>;
  task(
    content: string,
    options?: {
      cwd?: string;
      model?: string;
      thinkingLevel?: AgentConfig["thinkingLevel"];
      signal?: AbortSignal;
    },
  ): FlueCallHandle<FluePromptResponseLike>;
};

type FluePromptResponseLike = {
  text?: string;
  usage?: FlueEngineUsage;
  model?: string | { id?: string };
};

type FlueCallHandle<T = FluePromptResponseLike> = PromiseLike<T> & {
  signal?: AbortSignal;
  abort?: (reason?: unknown) => void;
};

async function importFlueRuntimeSubpath<T>(
  subpath: "app" | "cloudflare" | "internal",
  validate: (mod: unknown) => T,
  purpose: string,
): Promise<T> {
  const specifiers = [`@flue/runtime/${subpath}`, `@flue/sdk/${subpath}`];
  return importFirstFlueModule(specifiers, validate, purpose);
}

async function importFlueRuntimeRoot<T>(
  validate: (mod: unknown) => T,
  purpose: string,
): Promise<T> {
  const specifiers = ["@flue/runtime", "@flue/sdk/client"];
  return importFirstFlueModule(specifiers, validate, purpose);
}

async function importFirstFlueModule<T>(
  specifiers: readonly string[],
  validate: (mod: unknown) => T,
  purpose: string,
): Promise<T> {
  const failures: string[] = [];
  for (const specifier of specifiers) {
    try {
      return validate(await import(specifier));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${specifier}: ${message}`);
    }
  }
  throw new HarnessInvocationError(
    `Flue harness requires ${specifiers.join(" or ")} for ${purpose}: ${failures.join("; ")}`,
  );
}

function validateFlueInternalModule(mod: unknown): FlueInternalModule {
  const candidate = mod as Partial<FlueInternalModule>;
  if (
    typeof candidate.createFlueContext !== "function" ||
    typeof candidate.InMemorySessionStore !== "function" ||
    typeof candidate.resolveModel !== "function" ||
    typeof candidate.hasRegisteredProvider !== "function"
  ) {
    throw new Error("Flue runtime internal module did not expose the expected runtime helpers");
  }
  return candidate as FlueInternalModule;
}

function validateFlueAppModule(mod: unknown): FlueAppModule {
  const candidate = mod as Partial<FlueAppModule>;
  if (
    typeof candidate.configureProvider !== "function" ||
    typeof candidate.registerApiProvider !== "function" ||
    typeof candidate.registerProvider !== "function"
  ) {
    throw new Error("Flue runtime app module did not expose the expected provider helpers");
  }
  return candidate as FlueAppModule;
}

function validateFlueCloudflareModule(mod: unknown): FlueCloudflareModule {
  const candidate = mod as Partial<FlueCloudflareModule>;
  if (typeof candidate.getCloudflareAIBindingApiProvider !== "function") {
    throw new Error("Flue runtime Cloudflare module did not expose getCloudflareAIBindingApiProvider()");
  }
  return candidate as FlueCloudflareModule;
}

function validateFlueClientModule(mod: unknown): FlueClientModule {
  const candidate = mod as Partial<FlueClientModule>;
  if (typeof candidate.connectMcpServer !== "function") {
    throw new Error("Flue runtime root module did not expose connectMcpServer()");
  }
  return candidate as FlueClientModule;
}

function validateFlueAgentConfig(
  agent: HarnessAgentConfigValidationInput,
): HarnessAgentConfigValidationIssue | undefined {
  if (agent.tools.length > 0) {
    return {
      capability: "agent_tools",
      detail:
        "Flue harness does not map OMA agent.tools yet; use an agent with an empty tools list or wire Flue-native tools in a Flue app",
    };
  }
  const permissionIssue = validateFluePermissionPolicy(
    agent.permissionPolicy,
    agent.mcpServers,
  );
  if (permissionIssue) return permissionIssue;
  for (const [name, server] of Object.entries(agent.mcpServers ?? {})) {
    const detail = validateFlueMcpServerConfig(name, server);
    if (detail) return { capability: "mcp", detail };
  }
  return undefined;
}

function validateFluePermissionPolicy(
  policy: HarnessAgentConfigValidationInput["permissionPolicy"],
  mcpServers: HarnessAgentConfigValidationInput["mcpServers"],
): HarnessAgentConfigValidationIssue | undefined {
  if (policy.type !== "deny" && policy.type !== "always_ask") return undefined;
  if (policy.type === "always_ask" && !policy.tools) {
    return {
      capability: "tool_approvals",
      detail:
        "Flue approve-all policy is not supported; provide exact URL MCP tool names such as mcp__server__tool",
    };
  }
  const tools = policy.type === "always_ask" ? (policy.tools ?? []) : policy.tools;
  const capability = policy.type === "always_ask" ? "tool_approvals" : "permission_deny";
  const action = policy.type === "always_ask" ? "approval" : "deny";
  const unsupportedTools = tools.filter((tool) => !isFluePolicyToolName(tool));
  if (unsupportedTools.length > 0) {
    return {
      capability,
      detail: [
        `Flue ${action} policy currently supports only exact URL MCP tool names such as`,
        `mcp__server__tool plus the built-in bash tool; unsupported entries: ${unsupportedTools.join(", ")}`,
      ].join(" "),
    };
  }
  if (
    tools.some((tool) => isFlueMcpToolName(tool)) &&
    Object.keys(mcpServers ?? {}).length === 0
  ) {
    return {
      capability,
      detail:
        `Flue ${action} policy for MCP tools requires URL MCP servers on the agent; no MCP servers are configured`,
    };
  }
  return undefined;
}

function applyFlueToolPolicy(
  tools: FlueToolDef[],
  policy: AgentConfig["permissionPolicy"],
  args: {
    approvals?: FlueApprovalBroker;
    sessionId: string;
    signal?: AbortSignal;
  },
): FlueToolDef[] {
  if (policy.type !== "deny" && policy.type !== "always_ask") return tools;
  const exposed = new Set(tools.map((tool) => tool.name));
  const requested = (policy.type === "always_ask" ? (policy.tools ?? []) : policy.tools)
    .filter((tool) => isFlueMcpToolName(tool));
  const missing = requested.filter((tool) => !exposed.has(tool));
  if (missing.length > 0) {
    throw new HarnessInvocationError(
      `Flue ${policy.type === "always_ask" ? "approval" : "deny"} policy targets MCP tools that were not exposed by connected URL MCP servers: ${missing.join(", ")}`,
    );
  }
  if (requested.length === 0) return tools;
  if (policy.type === "always_ask") {
    if (!args.approvals) {
      throw new HarnessInvocationError("Flue approval policy requires an OMA approval broker");
    }
    const approvals = args.approvals;
    const approvalRequired = new Set(requested);
    return tools.map((tool) => {
      if (!approvalRequired.has(tool.name)) return tool;
      return {
        ...tool,
        execute: async (params, signal) => {
          const approvalSignal = signal ?? args.signal;
          const decision = await approvals.request({
            sessionId: args.sessionId,
            toolName: tool.name,
            args: params,
            signal: approvalSignal,
          });
          if (decision !== "allow") {
            throw new Error(`OMA denied ${flueToolLabel(tool.name)}`);
          }
          return await tool.execute(params, signal);
        },
      };
    });
  }
  const denied = new Set(policy.tools);
  return tools.filter((tool) => !denied.has(tool.name));
}

const FLUE_BUILTIN_BASH_TOOL_NAME = "bash";

function isFluePolicyToolName(name: string): boolean {
  return isFlueMcpToolName(name) || name === FLUE_BUILTIN_BASH_TOOL_NAME;
}

function isFlueMcpToolName(name: string): boolean {
  return name.startsWith("mcp__");
}

function flueToolLabel(toolName: string): string {
  return isFlueMcpToolName(toolName)
    ? `Flue MCP tool ${toolName}`
    : `Flue tool ${toolName}`;
}

function flueApprovalDescription(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const serialized = JSON.stringify(args);
  const suffix = serialized && serialized !== "{}" ? ` with ${serialized}` : "";
  return `${flueToolLabel(toolName)}${suffix}`;
}

async function enforceFlueBashPolicy(args: {
  policy: AgentConfig["permissionPolicy"] | undefined;
  approvals: FlueToolApprovalRequester | undefined;
  sessionId: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const policy = args.policy;
  if (
    !policy ||
    (policy.type !== "deny" && policy.type !== "always_ask") ||
    !fluePolicyTargetsBash(policy)
  ) {
    return;
  }
  if (policy.type === "deny") {
    throw new HarnessInvocationError(
      "Flue bash execution is denied by OMA permission policy",
    );
  }
  if (!args.approvals) {
    throw new HarnessInvocationError("Flue bash approval policy requires an OMA approval broker");
  }
  const decision = await args.approvals.request({
    sessionId: args.sessionId,
    toolName: FLUE_BUILTIN_BASH_TOOL_NAME,
    args: compactRecord({
      command: args.command,
      cwd: args.cwd,
      env: args.env,
      timeout: args.timeout,
    }),
    signal: args.signal,
  });
  if (decision !== "allow") {
    throw new Error(`OMA denied ${flueToolLabel(FLUE_BUILTIN_BASH_TOOL_NAME)}`);
  }
}

function fluePolicyTargetsBash(policy: AgentConfig["permissionPolicy"]): boolean {
  if (policy.type === "deny") return policy.tools.includes(FLUE_BUILTIN_BASH_TOOL_NAME);
  if (policy.type === "always_ask") return policy.tools?.includes(FLUE_BUILTIN_BASH_TOOL_NAME) === true;
  return false;
}

function compactRecord(
  record: Record<string, unknown | undefined>,
): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) compacted[key] = value;
  }
  return compacted;
}

function validateFlueMcpServerConfig(
  name: string,
  server: McpServerConfig,
): string | undefined {
  const stdioFields = [
    typeof server.command === "string" ? "command" : undefined,
    Array.isArray(server.args) ? "args" : undefined,
    server.env ? "env" : undefined,
    typeof server.cwd === "string" ? "cwd" : undefined,
  ].filter(Boolean);
  if (stdioFields.length > 0) {
    return `Flue MCP server "${name}" uses stdio/local fields (${stdioFields.join(", ")}); Flue MCP support only accepts URL-based streamable-http/SSE servers`;
  }
  if (!nonEmptyString(server.url)) {
    return `Flue MCP server "${name}" must provide a URL; stdio MCP servers are not supported by the Flue bridge`;
  }
  const transport = (objectRecord(server) ?? {}).transport;
  if (
    transport !== undefined &&
    transport !== "streamable-http" &&
    transport !== "sse"
  ) {
    return `Flue MCP server "${name}" has unsupported transport "${String(transport)}"; expected streamable-http or sse`;
  }
  return undefined;
}

function flueMcpConnectOptions(
  name: string,
  server: McpServerConfig,
): FlueMcpConnectOptions {
  const detail = validateFlueMcpServerConfig(name, server);
  if (detail) throw new HarnessInvocationError(detail);
  const extra = objectRecord(server) ?? {};
  const options: FlueMcpConnectOptions = {
    url: server.url as string,
    clientName: "open-managed-agents",
    clientVersion: "0.1.0",
  };
  const transport = extra.transport;
  if (transport === "streamable-http" || transport === "sse") {
    options.transport = transport;
  }
  if (server.headers) options.headers = server.headers;
  if (objectRecord(extra.requestInit)) {
    options.requestInit = extra.requestInit as RequestInit;
  }
  return options;
}

function emptyFlueMcpScope(): FlueMcpScope {
  return {
    tools: [],
    close: async () => {},
  };
}

async function closeFlueMcpConnections(
  connections: FlueMcpConnection[],
): Promise<void> {
  await Promise.allSettled(connections.map((connection) => connection.close()));
}

export class FlueManagedWorkspaceSessionEnv {
  readonly cwd: string;

  private constructor(
    private readonly workspace: ManagedWorkspace,
    private readonly agentId: string,
    private readonly sessionId: string,
    cwd: string | undefined,
    private readonly commandExecutor: FlueManagedWorkspaceCommandExecutor | undefined,
    private readonly permissionPolicy: AgentConfig["permissionPolicy"] | undefined,
    private readonly approvals: FlueToolApprovalRequester | undefined,
  ) {
    this.cwd = normalizeWorkspaceCwd(cwd);
  }

  static async create(args: {
    workspace: ManagedWorkspace;
    agentId: string;
    sessionId: string;
    cwd?: string;
    instructions: string;
    commandExecutor?: FlueManagedWorkspaceCommandExecutor;
    permissionPolicy?: AgentConfig["permissionPolicy"];
    approvals?: FlueToolApprovalRequester;
  }): Promise<FlueManagedWorkspaceSessionEnv> {
    const env = new FlueManagedWorkspaceSessionEnv(
      args.workspace,
      args.agentId,
      args.sessionId,
      args.cwd,
      args.commandExecutor,
      args.permissionPolicy,
      args.approvals,
    );
    await env.seedInstructions(args.instructions);
    return env;
  }

  async exec(command: string, options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<FlueShellResult> {
    if (options?.signal?.aborted) throw abortErrorFor(options.signal);
    await enforceFlueBashPolicy({
      policy: this.permissionPolicy,
      approvals: this.approvals,
      sessionId: this.sessionId,
      command,
      cwd: options?.cwd,
      env: options?.env,
      timeout: options?.timeout,
      signal: options?.signal,
    });
    if (this.commandExecutor) {
      const cwd = options?.cwd ? this.resolvePath(options.cwd) : this.cwd;
      const relCwd = this.toWorkspaceRelPath(cwd, { allowRoot: true });
      const result = await this.commandExecutor.exec({
        workspace: this.workspace,
        agentId: this.agentId,
        sessionId: this.sessionId,
        command,
        cwd,
        workspaceRoot: this.cwd,
        relCwd,
        env: options?.env,
        timeoutSeconds: options?.timeout,
        signal: options?.signal,
      });
      if (options?.signal?.aborted) throw abortErrorFor(options.signal);
      return result;
    }
    return {
      stdout: "",
      stderr: `Shell execution is disabled in OMA's managed Flue workspace. Command was: ${command}`,
      exitCode: 126,
    };
  }

  async readFile(path: string): Promise<string> {
    const data = await this.readFileBuffer(path);
    return new TextDecoder().decode(data);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const relPath = this.toWorkspaceRelPath(path, { allowRoot: false });
    return await this.workspace.readFile(this.agentId, this.sessionId, relPath);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const relPath = this.toWorkspaceRelPath(path, { allowRoot: false });
    const data = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
    await this.workspace.writeFile(this.agentId, this.sessionId, relPath, data);
  }

  async stat(path: string): Promise<{
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    size: number;
    mtime: Date;
  }> {
    const relPath = this.toWorkspaceRelPath(path, { allowRoot: true });
    if (relPath) {
      const entry = await this.findEntry(relPath);
      if (entry?.type === "file") {
        return {
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          size: entry.size,
          mtime: new Date(entry.mtime),
        };
      }
      if (!entry) {
        throw new WorkspaceError("file_not_found", `workspace path not found: ${relPath}`);
      }
    }

    const entries = await this.workspace.listFiles(this.agentId, this.sessionId, relPath);
    return {
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
      size: 0,
      mtime: new Date(latestWorkspaceMtime(entries)),
    };
  }

  async readdir(path: string): Promise<string[]> {
    const relPath = this.toWorkspaceRelPath(path, { allowRoot: true });
    const entries = await this.workspace.listFiles(this.agentId, this.sessionId, relPath);
    return entries.map((entry) => entry.name).sort();
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch (err) {
      if (isWorkspaceNotFound(err) || isInvalidWorkspacePath(err)) return false;
      throw err;
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.toWorkspaceRelPath(path, { allowRoot: true });
    if (options?.recursive) return;
    const parent = dirname(this.resolvePath(path));
    if (!await this.exists(parent)) {
      throw new Error(`parent directory missing: ${parent}`);
    }
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const relPath = this.toWorkspaceRelPath(path, { allowRoot: false });
    try {
      await this.workspace.deleteFile(this.agentId, this.sessionId, relPath);
      return;
    } catch (err) {
      if (isWorkspaceNotFound(err)) {
        if (options?.force) return;
        throw err;
      }
      if (!isInvalidWorkspacePath(err)) throw err;
    }

    if (!options?.recursive) {
      throw new WorkspaceError("invalid_path", `not a file: ${relPath}`);
    }
    await this.deleteTree(relPath);
  }

  resolvePath(path: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    return normalizePath(`${this.cwd}/${path}`);
  }

  private async seedInstructions(instructions: string): Promise<void> {
    if (!instructions.trim()) return;
    const agentsPath = "AGENTS.md";
    try {
      await this.workspace.readFile(this.agentId, this.sessionId, agentsPath, { maxBytes: 1 });
      return;
    } catch (err) {
      if (!isWorkspaceNotFound(err)) throw err;
    }
    await this.workspace.writeFile(
      this.agentId,
      this.sessionId,
      agentsPath,
      Buffer.from(instructions),
    );
  }

  private async deleteTree(relPath: string): Promise<void> {
    const entries = await this.workspace.listFiles(this.agentId, this.sessionId, relPath);
    for (const entry of entries) {
      if (entry.type === "dir") {
        await this.deleteTree(entry.path);
      } else {
        await this.workspace.deleteFile(this.agentId, this.sessionId, entry.path);
      }
    }
  }

  private async findEntry(relPath: string): Promise<WorkspaceEntry | undefined> {
    const idx = relPath.lastIndexOf("/");
    const parent = idx === -1 ? "" : relPath.slice(0, idx);
    const name = idx === -1 ? relPath : relPath.slice(idx + 1);
    try {
      const entries = await this.workspace.listFiles(this.agentId, this.sessionId, parent);
      return entries.find((entry) => entry.name === name);
    } catch (err) {
      if (isWorkspaceNotFound(err)) return undefined;
      throw err;
    }
  }

  private toWorkspaceRelPath(
    path: string,
    opts: { allowRoot: boolean },
  ): string {
    const absolute = this.resolvePath(path);
    if (absolute === this.cwd) {
      if (opts.allowRoot) return "";
      throw new WorkspaceError("invalid_path", "refusing to target workspace root");
    }
    const prefix = `${this.cwd}/`;
    if (!absolute.startsWith(prefix)) {
      throw new WorkspaceError("invalid_path", `path outside managed workspace: ${absolute}`);
    }
    return absolute.slice(prefix.length);
  }
}

class MemorySessionEnv {
  readonly cwd = "/home/user";
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>(["/", "/home", "/home/user", "/tmp"]);
  private readonly createdAt = new Date();

  constructor(
    instructions: string,
    private readonly policy?: {
      sessionId: string;
      permissionPolicy?: AgentConfig["permissionPolicy"];
      approvals?: FlueToolApprovalRequester;
    },
  ) {
    if (instructions.trim()) {
      this.writeFileSync("/home/user/AGENTS.md", instructions);
    }
  }

  async exec(command: string, options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (options?.signal?.aborted) throw abortErrorFor(options.signal);
    if (this.policy) {
      await enforceFlueBashPolicy({
        policy: this.policy.permissionPolicy,
        approvals: this.policy.approvals,
        sessionId: this.policy.sessionId,
        command,
        cwd: options?.cwd,
        env: options?.env,
        timeout: options?.timeout,
        signal: options?.signal,
      });
    }
    return {
      stdout: "",
      stderr: `Shell execution is disabled in OMA's initial native Flue memory sandbox. Command was: ${command}`,
      exitCode: 126,
    };
  }

  async readFile(path: string): Promise<string> {
    const data = await this.readFileBuffer(path);
    return new TextDecoder().decode(data);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const normalized = this.resolvePath(path);
    const data = this.files.get(normalized);
    if (!data) throw new Error(`file not found: ${normalized}`);
    return data;
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    this.writeFileSync(path, content);
  }

  async stat(path: string): Promise<{
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    size: number;
    mtime: Date;
  }> {
    const normalized = this.resolvePath(path);
    const file = this.files.get(normalized);
    if (file) {
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        size: file.byteLength,
        mtime: this.createdAt,
      };
    }
    if (this.dirs.has(normalized)) {
      return {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        size: 0,
        mtime: this.createdAt,
      };
    }
    throw new Error(`path not found: ${normalized}`);
  }

  async readdir(path: string): Promise<string[]> {
    const normalized = this.resolvePath(path);
    if (!this.dirs.has(normalized)) throw new Error(`not a directory: ${normalized}`);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const entries = new Set<string>();
    for (const dir of this.dirs) {
      if (!dir.startsWith(prefix) || dir === normalized) continue;
      const rest = dir.slice(prefix.length);
      const name = rest.split("/")[0];
      if (name) entries.add(name);
    }
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const name = rest.split("/")[0];
      if (name) entries.add(name);
    }
    return [...entries].sort();
  }

  async exists(path: string): Promise<boolean> {
    const normalized = this.resolvePath(path);
    return this.files.has(normalized) || this.dirs.has(normalized);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const normalized = this.resolvePath(path);
    if (options?.recursive) {
      this.ensureDir(normalized);
      return;
    }
    const parent = dirname(normalized);
    if (!this.dirs.has(parent)) throw new Error(`parent directory missing: ${parent}`);
    this.dirs.add(normalized);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const normalized = this.resolvePath(path);
    if (this.files.delete(normalized)) return;
    if (!this.dirs.has(normalized)) {
      if (options?.force) return;
      throw new Error(`path not found: ${normalized}`);
    }
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const hasChildren = [...this.files.keys(), ...this.dirs].some(
      (entry) => entry.startsWith(prefix) && entry !== normalized,
    );
    if (hasChildren && !options?.recursive) {
      throw new Error(`directory not empty: ${normalized}`);
    }
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(prefix)) this.files.delete(file);
    }
    for (const dir of [...this.dirs]) {
      if (dir.startsWith(prefix) || dir === normalized) this.dirs.delete(dir);
    }
  }

  resolvePath(path: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    return normalizePath(`${this.cwd}/${path}`);
  }

  private writeFileSync(path: string, content: string | Uint8Array): void {
    const normalized = this.resolvePath(path);
    this.ensureDir(dirname(normalized));
    const data = typeof content === "string"
      ? new TextEncoder().encode(content)
      : content;
    this.files.set(normalized, data);
  }

  private ensureDir(path: string): void {
    const normalized = normalizePath(path);
    let current = "";
    for (const part of normalized.split("/")) {
      if (!part) {
        this.dirs.add("/");
        continue;
      }
      current += `/${part}`;
      this.dirs.add(current);
    }
  }
}

function buildManagedEvents(args: {
  content: string;
  output: string;
  sessionId: string;
  runId?: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | undefined;
  flueEvents: FlueRuntimeEvent[];
}): Event[] {
  const turnId = args.runId ?? createFallbackRunId();
  const createdAt = Date.now();
  const events: Event[] = [
    {
      eventId: `evt_flue_${turnId}_user`,
      sessionId: args.sessionId,
      type: "user.message",
      content: args.content,
      createdAt,
      runId: args.runId,
    },
  ];
  const runtimeEvents = mapFlueEvents(
    args.flueEvents,
    args.sessionId,
    args.runId,
    turnId,
    createdAt + 1,
  );
  events.push(...runtimeEvents);
  events.push({
    eventId: `evt_flue_${turnId}_agent`,
    sessionId: args.sessionId,
    type: "agent.message",
    content: args.output,
    createdAt: createdAt + runtimeEvents.length + 1,
    tokensIn: args.tokensIn,
    tokensOut: args.tokensOut,
    costUsd: args.costUsd,
    model: args.model,
    runId: args.runId,
  });
  return events;
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (err: unknown) => void;
  }> = [];
  private closed = false;
  private error: unknown;

  push(value: T): void {
    if (this.closed || this.error) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed || this.error) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ value: undefined, done: true });
    }
  }

  fail(err: unknown): void {
    if (this.closed || this.error) return;
    this.error = err;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(err);
    }
  }

  async *iterate(): AsyncGenerator<T, void, void> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift() as T;
        continue;
      }
      if (this.error) throw this.error;
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

function openAiTextChunk(args: {
  id: string;
  model: string;
  content: string;
}): string {
  return JSON.stringify({
    id: `chatcmpl-flue-${args.id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: args.model,
    choices: [
      {
        index: 0,
        delta: { content: args.content },
        finish_reason: null,
      },
    ],
  });
}

function openAiFinishChunk(args: { id: string; model: string }): string {
  return JSON.stringify({
    id: `chatcmpl-flue-${args.id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: args.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  });
}

function mapFlueEvents(
  flueEvents: FlueRuntimeEvent[],
  sessionId: string,
  fallbackRunId: string | undefined,
  turnId: string,
  baseTime: number,
): Event[] {
  const events: Event[] = [];
  let index = 0;
  for (const event of flueEvents) {
    const mapped = mapFlueEvent(
      event,
      sessionId,
      fallbackRunId,
      `evt_flue_${turnId}_runtime_${index}`,
      baseTime + index,
    );
    index++;
    if (mapped) events.push(mapped);
  }
  return events;
}

function mapFlueEvent(
  event: FlueRuntimeEvent,
  sessionId: string,
  fallbackRunId: string | undefined,
  eventId: string,
  createdAt: number,
): Event | undefined {
  const runId = event.runId ?? fallbackRunId;
  switch (event.type) {
    case "run_start":
      return {
        eventId,
        sessionId,
        type: "session.run_start",
        content: runLifecycleContent("started", event, runId),
        createdAt,
        runId,
        runKind: event.kind,
        parentRunId: event.parentRunId,
        eventIndex: finiteEventIndex(event.eventIndex),
      };
    case "run_end":
      return {
        eventId,
        sessionId,
        type: "session.run_end",
        content: runLifecycleContent("ended", event, runId),
        createdAt,
        runId,
        runKind: event.kind,
        runStatus: event.status,
        parentRunId: event.parentRunId,
        eventIndex: finiteEventIndex(event.eventIndex),
        isError: event.status === "failed",
      };
    case "thinking_end":
      return {
        eventId,
        sessionId,
        type: "agent.thinking",
        content: event.content ?? "",
        createdAt,
        runId,
        eventIndex: finiteEventIndex(event.eventIndex),
      };
    case "tool_start":
      return {
        eventId,
        sessionId,
        type: "agent.tool_use",
        content: stringifyContent(event.args),
        createdAt,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        toolArguments: objectRecord(event.args),
        runId,
        eventIndex: finiteEventIndex(event.eventIndex),
      };
    case "tool_end":
    case "tool_call":
      return {
        eventId,
        sessionId,
        type: "agent.tool_result",
        content: stringifyContent(event.result ?? event.error),
        createdAt,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        isError: Boolean(event.isError),
        runId,
        eventIndex: finiteEventIndex(event.eventIndex),
      };
    case "task_start":
      return mapNestedRunStart({
        event,
        eventId,
        sessionId,
        fallbackRunId,
        createdAt,
        childRunId: event.taskId ?? event.workId,
        runKind: event.workKind ?? "task",
        label: "task",
        prompt: event.prompt,
      });
    case "task":
    case "task_end":
      return mapNestedRunEnd({
        event,
        eventId,
        sessionId,
        fallbackRunId,
        createdAt,
        childRunId: event.taskId ?? event.workId,
        runKind: event.workKind ?? "task",
        label: "task",
      });
    case "operation_start":
      return mapNestedRunStart({
        event,
        eventId,
        sessionId,
        fallbackRunId,
        createdAt,
        childRunId: event.operationId,
        runKind: event.operationKind ?? "operation",
        label: "operation",
      });
    case "operation":
      return mapNestedRunEnd({
        event,
        eventId,
        sessionId,
        fallbackRunId,
        createdAt,
        childRunId: event.operationId,
        runKind: event.operationKind ?? "operation",
        label: "operation",
      });
    case "compaction_start":
      return {
        eventId,
        sessionId,
        type: "session.compaction",
        content: `Flue compaction started${event.content ? `: ${event.content}` : ""}`,
        createdAt,
        runId,
        eventIndex: finiteEventIndex(event.eventIndex),
      };
    case "compaction_end":
      return {
        eventId,
        sessionId,
        type: "session.compaction",
        content: "Flue compaction ended",
        createdAt,
        runId,
        eventIndex: finiteEventIndex(event.eventIndex),
      };
    case "compaction":
      return {
        eventId,
        sessionId,
        type: "session.compaction",
        content: compactionContent(event),
        createdAt,
        runId,
        eventIndex: finiteEventIndex(event.eventIndex),
      };
    default:
      return undefined;
  }
}

function mapNestedRunStart(args: {
  event: FlueRuntimeEvent;
  eventId: string;
  sessionId: string;
  fallbackRunId: string | undefined;
  createdAt: number;
  childRunId: string | undefined;
  runKind: string;
  label: string;
  prompt?: string;
}): Event {
  const runId = args.childRunId ?? args.event.runId ?? args.fallbackRunId;
  return {
    eventId: args.eventId,
    sessionId: args.sessionId,
    type: "session.run_start",
    content: nestedRunContent("started", args.label, args.event, runId, args.prompt),
    createdAt: args.createdAt,
    runId,
    runKind: args.runKind,
    parentRunId: nestedParentRunId(args.event, args.fallbackRunId, runId),
    eventIndex: finiteEventIndex(args.event.eventIndex),
  };
}

function mapNestedRunEnd(args: {
  event: FlueRuntimeEvent;
  eventId: string;
  sessionId: string;
  fallbackRunId: string | undefined;
  createdAt: number;
  childRunId: string | undefined;
  runKind: string;
  label: string;
}): Event {
  const runId = args.childRunId ?? args.event.runId ?? args.fallbackRunId;
  const usage = args.event.usage;
  const mapped: Event = {
    eventId: args.eventId,
    sessionId: args.sessionId,
    type: "session.run_end",
    content: nestedRunContent("ended", args.label, args.event, runId),
    createdAt: args.createdAt,
    runId,
    runKind: args.runKind,
    runStatus: args.event.status ?? (args.event.isError ? "failed" : "completed"),
    parentRunId: nestedParentRunId(args.event, args.fallbackRunId, runId),
    eventIndex: finiteEventIndex(args.event.eventIndex),
    isError: Boolean(args.event.isError),
  };
  if (usage?.input !== undefined) mapped.tokensIn = finiteTokenCount(usage.input);
  if (usage?.output !== undefined) mapped.tokensOut = finiteTokenCount(usage.output);
  const costUsd = finiteNumber(usage?.cost?.total);
  if (costUsd !== undefined) mapped.costUsd = costUsd;
  return mapped;
}

function nestedParentRunId(
  event: FlueRuntimeEvent,
  fallbackRunId: string | undefined,
  childRunId: string | undefined,
): string | undefined {
  const parent = event.parentRunId ?? event.runId ?? fallbackRunId;
  return parent && parent !== childRunId ? parent : undefined;
}

function nestedRunContent(
  action: "started" | "ended",
  label: string,
  event: FlueRuntimeEvent,
  runId: string | undefined,
  prompt?: string,
): string {
  const parts = [`Flue ${label} ${action}`];
  if (runId) parts.push(runId);
  const details = [
    event.operationKind ? `kind=${event.operationKind}` : undefined,
    event.workKind ? `kind=${event.workKind}` : undefined,
    event.role ? `role=${event.role}` : undefined,
    event.cwd ? `cwd=${event.cwd}` : undefined,
    finiteNumber(event.durationMs) !== undefined ? `durationMs=${event.durationMs}` : undefined,
  ].filter(Boolean);
  if (details.length > 0) parts.push(`(${details.join(", ")})`);
  const body = prompt ?? event.prompt ?? event.message ?? stringifyContent(event.result ?? event.error);
  return body ? `${parts.join(" ")}\n${body}` : parts.join(" ");
}

function compactionContent(event: FlueRuntimeEvent): string {
  const details = [
    typeof event.messagesBefore === "number" ? `before=${event.messagesBefore}` : undefined,
    typeof event.messagesAfter === "number" ? `after=${event.messagesAfter}` : undefined,
    finiteNumber(event.durationMs) !== undefined ? `durationMs=${event.durationMs}` : undefined,
  ].filter(Boolean);
  return details.length > 0
    ? `Flue compaction ended (${details.join(", ")})`
    : "Flue compaction ended";
}

function runLifecycleContent(
  action: "started" | "ended",
  event: FlueRuntimeEvent,
  runId: string | undefined = event.runId,
): string {
  const parts = [`Flue run ${action}`];
  if (runId) parts.push(runId);
  const details = [
    event.kind ? `kind=${event.kind}` : undefined,
    event.status ? `status=${event.status}` : undefined,
    event.parentRunId ? `parent=${event.parentRunId}` : undefined,
  ].filter(Boolean);
  if (details.length > 0) parts.push(`(${details.join(", ")})`);
  return parts.join(" ");
}

function finiteEventIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function createFallbackRunId(): string {
  return `run_${randomUUID().replace(/-/g, "")}`;
}

function modelId(model: string | { id?: string } | undefined): string | undefined {
  if (typeof model === "string") return model;
  if (typeof model?.id === "string" && model.id.length > 0) return model.id;
  return undefined;
}

function finiteTokenCount(value: unknown): number {
  const n = finiteNumber(value);
  return n === undefined ? 0 : Math.max(0, Math.trunc(n));
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function isWorkspaceNotFound(err: unknown): boolean {
  return err instanceof WorkspaceError && err.code === "file_not_found";
}

function isInvalidWorkspacePath(err: unknown): boolean {
  return err instanceof WorkspaceError && err.code === "invalid_path";
}

function abortErrorFor(signal: AbortSignal): DOMException {
  const err = new DOMException("This operation was aborted", "AbortError") as DOMException & {
    cause?: unknown;
  };
  err.cause = signal.reason;
  return err;
}

function latestWorkspaceMtime(entries: WorkspaceEntry[]): number {
  return entries.reduce((latest, entry) => Math.max(latest, entry.mtime), 0);
}

function normalizeWorkspaceCwd(cwd: string | undefined): string {
  const normalized = normalizePath(cwd?.trim() || "/workspace");
  return normalized === "/" ? "/workspace" : normalized;
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "/" : normalized.slice(0, idx);
}
