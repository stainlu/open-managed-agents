export type ManagedRunRequest = {
  sessionId: string;
  agentId: string;
  content: string;
  model?: string;
  thinkingLevel?: string;
  queued: boolean;
};

export type ManagedRunExecutionResult =
  | { status: "executed" }
  | { status: "failed"; error: string }
  | {
      status: "skipped";
      reason:
        | "session_not_found"
        | "agent_not_found"
        | "agent_mismatch"
        | "session_not_inflight";
    };

export type ScheduleManagedRunArgs = {
  request: ManagedRunRequest;
  run: () => Promise<void>;
  onFailure: (error: unknown) => void;
};

export interface ManagedRunScheduler {
  schedule(args: ScheduleManagedRunArgs): void | Promise<void>;
}

export class InlineRunScheduler implements ManagedRunScheduler {
  schedule(args: ScheduleManagedRunArgs): void {
    void args.run().catch(args.onFailure);
  }
}

export function isManagedRunRequest(value: unknown): value is ManagedRunRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ManagedRunRequest>;
  if (typeof candidate.sessionId !== "string" || candidate.sessionId.length === 0) {
    return false;
  }
  if (typeof candidate.agentId !== "string" || candidate.agentId.length === 0) {
    return false;
  }
  if (typeof candidate.content !== "string") {
    return false;
  }
  if (candidate.model !== undefined && typeof candidate.model !== "string") {
    return false;
  }
  if (candidate.thinkingLevel !== undefined && typeof candidate.thinkingLevel !== "string") {
    return false;
  }
  return typeof candidate.queued === "boolean";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
