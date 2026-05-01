import type { Event } from "../orchestrator/types.js";
import type { ManagedEventLog, ManagedEventLogFollowOptions } from "./types.js";
import { mergeManagedEventsForSession } from "./normalize.js";

export class CompositeManagedEventLog implements ManagedEventLog {
  constructor(
    public readonly stateRoot: string,
    private readonly logs: ManagedEventLog[],
  ) {}

  appendEvents(agentId: string, sessionId: string, events: Event[]): void {
    for (const log of this.logs) {
      if (!log.appendEvents) continue;
      log.appendEvents(agentId, sessionId, events);
      return;
    }
  }

  listBySession(agentId: string, sessionId: string): Event[] {
    return mergeManagedEventsForSession(
      sessionId,
      this.logs.flatMap((log) => log.listBySession(agentId, sessionId)),
    );
  }

  latestAgentMessage(agentId: string, sessionId: string): Event | undefined {
    return findLast(this.listBySession(agentId, sessionId), (e) => e.type === "agent.message");
  }

  latestAgentOutcome(agentId: string, sessionId: string): Event | undefined {
    return findLast(
      this.listBySession(agentId, sessionId),
      (e) => e.type === "agent.message" || e.type === "agent.tool_result",
    );
  }

  countUserTurns(agentId: string, sessionId: string): number {
    return this.listBySession(agentId, sessionId).filter((e) => e.type === "user.message").length;
  }

  statSessionLog(agentId: string, sessionId: string): { bytes: number } | undefined {
    const stats = this.logs
      .map((log) => log.statSessionLog(agentId, sessionId))
      .filter((stat): stat is { bytes: number } => stat !== undefined);
    if (stats.length === 0) return undefined;
    return { bytes: stats.reduce((sum, stat) => sum + stat.bytes, 0) };
  }

  deleteBySession(agentId: string, sessionId: string): void {
    for (const log of this.logs) log.deleteBySession(agentId, sessionId);
  }

  async *follow(
    agentId: string,
    sessionId: string,
    opts: ManagedEventLogFollowOptions = {},
  ): AsyncGenerator<Event> {
    const pollMs = opts.pollIntervalMs ?? 100;
    const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
    const seen = new Set<string>();
    const catchUp = this.listBySession(agentId, sessionId);
    let cursorSeen = opts.afterEventId === undefined;
    if (opts.afterEventId && !catchUp.some((e) => e.eventId === opts.afterEventId)) {
      cursorSeen = true;
    }
    for (const event of catchUp) {
      if (opts.signal?.aborted) return;
      seen.add(event.eventId);
      if (!cursorSeen) {
        if (event.eventId === opts.afterEventId) cursorSeen = true;
        continue;
      }
      yield event;
    }
    let lastYieldAt = Date.now();
    while (!opts.signal?.aborted) {
      await sleepWithAbort(pollMs, opts.signal).catch(() => undefined);
      if (opts.signal?.aborted) return;
      for (const event of this.listBySession(agentId, sessionId)) {
        if (seen.has(event.eventId)) continue;
        seen.add(event.eventId);
        lastYieldAt = Date.now();
        yield event;
      }
      if (
        opts.isSessionRunning &&
        !opts.isSessionRunning() &&
        Date.now() - lastYieldAt > idleTimeoutMs
      ) {
        return;
      }
    }
  }
}

function findLast(events: Event[], pred: (event: Event) => boolean): Event | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event && pred(event)) return event;
  }
  return undefined;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
