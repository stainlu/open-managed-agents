import type { SpawnOptions } from "../runtime/container.js";
import type { ContainerControlPlane } from "../runtime/control.js";
import type { AgentConfig, EnvironmentConfig, Event, Session } from "../orchestrator/types.js";
import type { HarnessId } from "./ids.js";

export type { HarnessId } from "./ids.js";

export type HarnessSessionContext = Pick<
  Session,
  "environmentId" | "remainingSubagentDepth"
> & {
  vaultId?: string | null;
};

export type HarnessSpawnOptionsArgs = {
  sessionId: string;
  agent: AgentConfig;
  session: HarnessSessionContext;
  modelOverride?: string;
  thinkingLevel?: AgentConfig["thinkingLevel"];
};

export type HarnessTurnInvocationArgs = {
  baseUrl: string;
  token: string;
  content: string;
  sessionId: string;
  timeoutMs: number;
  agent?: AgentConfig;
  session?: Session;
  environment?: EnvironmentConfig;
  model?: string;
  thinkingLevel?: AgentConfig["thinkingLevel"];
};

export type HarnessTurnResult = {
  output: string;
  tokensIn: number;
  tokensOut: number;
  model?: string;
  events?: Event[];
  native?: {
    nativeSessionId?: string | null;
    nativeThreadId?: string | null;
    nativeMetadata?: Record<string, unknown> | null;
  };
};

export type HarnessStreamingTurnInvocationArgs = HarnessTurnInvocationArgs;

export type HarnessStreamingTurn = {
  chunks: AsyncGenerator<string, void, void>;
  abort(reason?: string): Promise<void>;
};

export type HarnessApprovalRequest = {
  approvalId: string;
  sessionId: string;
  toolName: string;
  toolCallId?: string;
  description: string;
  arrivedAt: number;
};

export type HarnessApprovalResolution = {
  approvalId: string;
  decision?: string;
};

export type HarnessTurnStateEvent = {
  state: string;
  errorMessage?: string;
};

export class HarnessInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessInvocationError";
  }
}

export class HarnessControlError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HarnessControlError";
  }
}

export type HarnessAdapter = {
  readonly id: HarnessId;
  readonly displayName: string;
  readonly controlPlane?: ContainerControlPlane;
  buildSpawnOptions(args: HarnessSpawnOptionsArgs): SpawnOptions;
  shouldBypassWarmPool(session: Pick<Session, "environmentId" | "vaultId"> | undefined): boolean;
  modelForUsage(model: string): string;
  isFailureOutput(output: string): boolean;
  invokeTurn(args: HarnessTurnInvocationArgs): Promise<HarnessTurnResult>;
  invokeStreamingTurn(args: HarnessStreamingTurnInvocationArgs): Promise<HarnessStreamingTurn>;
  patchSession(
    controlClient: unknown,
    sessionId: string,
    fields: { model?: string; thinkingLevel?: AgentConfig["thinkingLevel"] },
  ): Promise<void>;
  abortSession(controlClient: unknown, sessionId: string): Promise<void>;
  compactSession(controlClient: unknown, sessionId: string): Promise<void>;
  resolveApproval(
    controlClient: unknown,
    sessionId: string,
    approvalId: string,
    decision: "allow" | "deny",
  ): Promise<void>;
  listApprovals(
    controlClient: unknown,
    sessionId: string,
  ): Promise<HarnessApprovalRequest[]>;
  subscribeApprovalRequested(
    controlClient: unknown,
    sessionId: string,
    handler: (approval: HarnessApprovalRequest) => void,
  ): () => void;
  subscribeApprovalResolved(
    controlClient: unknown,
    handler: (resolution: HarnessApprovalResolution) => void,
  ): () => void;
  subscribeTurnState(
    controlClient: unknown,
    sessionId: string,
    handler: (event: HarnessTurnStateEvent) => void,
  ): () => void;
};
