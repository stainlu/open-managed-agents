import type { SpawnOptions } from "../runtime/container.js";
import type { AgentConfig, Session } from "../orchestrator/types.js";

export type HarnessId = "openclaw";

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
  thinkingLevel?: string;
};

export type HarnessTurnInvocationArgs = {
  baseUrl: string;
  token: string;
  content: string;
  sessionId: string;
  timeoutMs: number;
};

export type HarnessTurnResult = {
  output: string;
  tokensIn: number;
  tokensOut: number;
  model?: string;
};

export class HarnessInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessInvocationError";
  }
}

export type HarnessAdapter = {
  readonly id: HarnessId;
  readonly displayName: string;
  buildSpawnOptions(args: HarnessSpawnOptionsArgs): SpawnOptions;
  shouldBypassWarmPool(session: Pick<Session, "environmentId" | "vaultId"> | undefined): boolean;
  invokeTurn(args: HarnessTurnInvocationArgs): Promise<HarnessTurnResult>;
};
