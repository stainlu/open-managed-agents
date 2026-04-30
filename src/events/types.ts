import type { Event } from "../orchestrator/types.js";

export type ManagedEventLogFollowOptions = {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  idleTimeoutMs?: number;
  isSessionRunning?: () => boolean;
  afterEventId?: string;
};

export type ManagedEventLog = {
  /**
   * In-process state root used by managed workspace operations. For the
   * OpenClaw backend this is the host-mounted Pi/OpenClaw state directory.
   */
  readonly stateRoot: string;
  listBySession(agentId: string, sessionId: string): Event[];
  latestAgentMessage(agentId: string, sessionId: string): Event | undefined;
  latestAgentOutcome(agentId: string, sessionId: string): Event | undefined;
  countUserTurns(agentId: string, sessionId: string): number;
  statSessionLog(agentId: string, sessionId: string): { bytes: number } | undefined;
  deleteBySession(agentId: string, sessionId: string): void;
  follow(
    agentId: string,
    sessionId: string,
    opts?: ManagedEventLogFollowOptions,
  ): AsyncGenerator<Event>;
};
