import type { Event } from "../orchestrator/types.js";

export type Awaitable<T> = T | Promise<T>;

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
   * ManagedWorkspace instead of reaching through the event log. Cloud-native
   * event stores do not need to expose this.
   */
  readonly stateRoot?: string;
  appendEvents?(agentId: string, sessionId: string, events: Event[]): Awaitable<void>;
  listBySession(agentId: string, sessionId: string): Awaitable<Event[]>;
  latestAgentMessage(agentId: string, sessionId: string): Awaitable<Event | undefined>;
  latestAgentOutcome(agentId: string, sessionId: string): Awaitable<Event | undefined>;
  countUserTurns(agentId: string, sessionId: string): Awaitable<number>;
  statSessionLog(agentId: string, sessionId: string): Awaitable<{ bytes: number } | undefined>;
  deleteBySession(agentId: string, sessionId: string): Awaitable<void>;
  follow(
    agentId: string,
    sessionId: string,
    opts?: ManagedEventLogFollowOptions,
  ): AsyncGenerator<Event>;
};
