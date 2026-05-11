import { randomUUID } from "node:crypto";
import type { AgentConfig, Event, Session } from "../orchestrator/types.js";
import type {
  HarnessAdapter,
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

export type FlueEngine = {
  prompt(args: FlueEnginePromptArgs): Promise<FlueEnginePromptResult>;
  stream?(args: FlueEnginePromptArgs): Promise<HarnessStreamingTurn>;
};

export type FlueHarnessAdapterConfig = {
  passthroughEnv?: Record<string, string>;
  sessionStateStore?: ManagedHarnessStateStore;
  engine?: FlueEngine;
  loadEngine?: () => Promise<FlueEngine>;
};

type FlueRuntimeEvent = {
  type?: string;
  text?: string;
  delta?: string;
  content?: string;
  prompt?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  workId?: string;
  workKind?: string;
  sessionId?: string;
  durationMs?: number;
  usage?: FlueEngineUsage;
  model?: string | { id?: string };
};

type OptionalImport = (specifier: string) => Promise<unknown>;

const optionalImport = new Function(
  "specifier",
  "return import(specifier)",
) as OptionalImport;

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
      detail: "Streams Flue prompt text deltas and live managed events; task/shell streaming is not wired yet.",
    },
    native_session_resume: {
      support: "partial",
      detail: "Flue session data is persisted through OMA-managed harness state when configured; Cloudflare session-state wiring is not promoted yet.",
    },
    cancellation: {
      support: "partial",
      detail: "Active Flue prompt turns, including streamed prompts, are cancelled with AbortSignal; task cancellation is not wired yet.",
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
      support: "unsupported",
      detail: "Flue tool approvals are not mapped into OMA confirmations yet.",
    },
    permission_deny: {
      support: "unsupported",
      detail: "OMA per-tool deny policy is not mapped to Flue tools yet.",
    },
    mcp: {
      support: "unsupported",
      detail: "OMA MCP server config is not mapped to Flue yet.",
    },
    managed_event_log: {
      support: "partial",
      detail: "Adapter emits managed user/agent prompt boundary events and maps selected Flue runtime events.",
    },
    usage: {
      support: "supported",
      detail: "Maps Flue prompt usage input/output/cost fields when present.",
    },
    subagents: {
      support: "partial",
      detail: "Flue task events can be observed, but OMA first-class child sessions are not wired yet.",
    },
  } satisfies HarnessCapabilities;

  private enginePromise: Promise<FlueEngine> | undefined;
  private readonly activeCalls = new Map<string, AbortController>();
  private readonly pendingAborts = new Map<string, unknown>();

  constructor(private readonly cfg: FlueHarnessAdapterConfig = {}) {}

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
    this.assertPromptCallable(args);
    const callController = this.startCall(args.sessionId);
    const engine = await this.resolveEngine();
    let result: FlueEnginePromptResult;
    try {
      result = await engine.prompt({
        content: args.content,
        sessionId: args.sessionId,
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
        nativeMetadata: { harness: "flue" },
      },
    };
  }

  async invokeStreamingTurn(
    args: HarnessStreamingTurnInvocationArgs,
  ): Promise<HarnessStreamingTurn> {
    this.assertPromptCallable(args);
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

  async resolveApproval(): Promise<void> {
    throw new HarnessControlError(
      "unsupported_capability",
      "Flue tool approvals are not wired yet",
    );
  }

  async listApprovals(): Promise<HarnessApprovalRequest[]> {
    return [];
  }

  subscribeApprovalRequested(
    _controlClient: unknown,
    _sessionId: string,
    _handler: (approval: HarnessApprovalRequest) => void,
  ): () => void {
    return () => {};
  }

  subscribeApprovalResolved(
    _controlClient: unknown,
    _handler: (resolution: HarnessApprovalResolution) => void,
  ): () => void {
    return () => {};
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
          this.cfg.sessionStateStore,
        ));
    }
    return this.enginePromise;
  }

  private assertPromptCallable(
    args: HarnessTurnInvocationArgs | HarnessStreamingTurnInvocationArgs,
  ): asserts args is typeof args & { agent: AgentConfig } {
    if (!args.agent) {
      throw new HarnessInvocationError("Flue turn requires agent config");
    }
    if (args.agent.tools.length > 0) {
      throw new HarnessInvocationError(
        "Flue harness does not map OMA agent.tools yet; use an agent with an empty tools list or wire Flue-native tools in a Flue app",
      );
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
  private storePromise: Promise<unknown> | undefined;

  constructor(
    private readonly passthroughEnv: Record<string, string>,
    private readonly sessionStateStore: ManagedHarnessStateStore | undefined,
  ) {}

  async prompt(args: FlueEnginePromptArgs): Promise<FlueEnginePromptResult> {
    const ctx = await this.createContext(args);
    const events: FlueRuntimeEvent[] = [];
    ctx.setEventCallback((event: FlueRuntimeEvent) => {
      events.push(event);
    });

    const flueAgent = await ctx.init({
      id: args.agent.agentId,
      model: args.model ?? args.agent.model,
      thinkingLevel: args.thinkingLevel ?? args.agent.thinkingLevel,
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
  }

  async stream(args: FlueEnginePromptArgs): Promise<HarnessStreamingTurn> {
    const ctx = await this.createContext(args);
    const turnId = `${Date.now()}_${randomUUID()}`;
    const createdAt = Date.now();
    let eventIndex = 0;
    let output = "";
    let result: HarnessTurnResult | undefined;
    let promptHandle: FlueCallHandle | undefined;
    const chunks = new AsyncQueue<string>();
    const liveEvents = new AsyncQueue<Event>();
    const modelForChunks = args.model ?? args.agent.model;

    liveEvents.push({
      eventId: `evt_flue_${turnId}_user`,
      sessionId: args.sessionId,
      type: "user.message",
      content: args.content,
      createdAt,
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
        `evt_flue_${turnId}_runtime_${eventIndex}`,
        createdAt + eventIndex + 1,
      );
      eventIndex++;
      if (mapped) liveEvents.push(mapped);
    });

    (async () => {
      try {
        const flueAgent = await ctx.init({
          id: args.agent.agentId,
          model: args.model ?? args.agent.model,
          thinkingLevel: args.thinkingLevel ?? args.agent.thinkingLevel,
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
            nativeMetadata: { harness: "flue" },
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

  private async createContext(args: FlueEnginePromptArgs): Promise<FlueContextLike> {
    const internal = await this.loadInternal();
    const store = await this.loadStore(internal, args);
    const env = new MemorySessionEnv(args.agent.instructions);
    return internal.createFlueContext({
      id: args.agent.agentId,
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
      this.internalPromise = optionalImport("@flue/sdk/internal")
        .then((mod) => validateFlueInternalModule(mod))
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          throw new HarnessInvocationError(
            `Flue harness requires @flue/sdk to be installed and resolvable at runtime: ${message}`,
          );
        });
    }
    return this.internalPromise;
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

type FlueInternalModule = {
  createFlueContext: (config: Record<string, unknown>) => FlueContextLike;
  InMemorySessionStore: new () => unknown;
  resolveModel: (model: string | false | undefined) => unknown;
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
};

type FluePromptResponseLike = {
  text?: string;
  usage?: FlueEngineUsage;
  model?: string | { id?: string };
};

type FlueCallHandle = PromiseLike<FluePromptResponseLike> & {
  signal?: AbortSignal;
  abort?: (reason?: unknown) => void;
};

function validateFlueInternalModule(mod: unknown): FlueInternalModule {
  const candidate = mod as Partial<FlueInternalModule>;
  if (
    typeof candidate.createFlueContext !== "function" ||
    typeof candidate.InMemorySessionStore !== "function" ||
    typeof candidate.resolveModel !== "function"
  ) {
    throw new Error("@flue/sdk/internal did not expose the expected runtime helpers");
  }
  return candidate as FlueInternalModule;
}

class MemorySessionEnv {
  readonly cwd = "/home/user";
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>(["/", "/home", "/home/user", "/tmp"]);
  private readonly createdAt = new Date();

  constructor(instructions: string) {
    if (instructions.trim()) {
      this.writeFileSync("/home/user/AGENTS.md", instructions);
    }
  }

  async exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | undefined;
  flueEvents: FlueRuntimeEvent[];
}): Event[] {
  const turnId = `${Date.now()}_${randomUUID()}`;
  const createdAt = Date.now();
  const events: Event[] = [
    {
      eventId: `evt_flue_${turnId}_user`,
      sessionId: args.sessionId,
      type: "user.message",
      content: args.content,
      createdAt,
    },
  ];
  const runtimeEvents = mapFlueEvents(
    args.flueEvents,
    args.sessionId,
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
  turnId: string,
  baseTime: number,
): Event[] {
  const events: Event[] = [];
  let index = 0;
  for (const event of flueEvents) {
    const mapped = mapFlueEvent(
      event,
      sessionId,
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
  eventId: string,
  createdAt: number,
): Event | undefined {
  switch (event.type) {
    case "thinking_end":
      return {
        eventId,
        sessionId,
        type: "agent.thinking",
        content: event.content ?? "",
        createdAt,
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
      };
    case "tool_end":
      return {
        eventId,
        sessionId,
        type: "agent.tool_result",
        content: stringifyContent(event.result),
        createdAt,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        isError: Boolean(event.isError),
      };
    case "task_start":
      return {
        eventId,
        sessionId,
        type: "session.runtime_notice",
        content: `Flue task started${event.workId ? `: ${event.workId}` : ""}${
          event.prompt ? `\n${event.prompt}` : ""
        }`,
        createdAt,
      };
    case "task_end":
      return {
        eventId,
        sessionId,
        type: "session.runtime_notice",
        content: `Flue task ended${event.isError ? " with error" : ""}${
          event.workId ? `: ${event.workId}` : ""
        }`,
        createdAt,
      };
    case "compaction_start":
      return {
        eventId,
        sessionId,
        type: "session.compaction",
        content: `Flue compaction started${event.content ? `: ${event.content}` : ""}`,
        createdAt,
      };
    case "compaction_end":
      return {
        eventId,
        sessionId,
        type: "session.compaction",
        content: "Flue compaction ended",
        createdAt,
      };
    default:
      return undefined;
  }
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
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
