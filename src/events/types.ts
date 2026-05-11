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
   * Legacy in-process state root for local JSONL readers and Docker harness
   * spawn configuration. New workspace operations should depend on
   * ManagedWorkspace instead of reaching through the event log.
   */
  readonly stateRoot: string;
  appendEvents?(agentId: string, sessionId: string, events: Event[]): void;
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
