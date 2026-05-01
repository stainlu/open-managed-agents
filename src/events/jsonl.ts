import { mkdirSync, readFileSync, statSync, unlinkSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Event } from "../orchestrator/types.js";
import type { ManagedEventLog, ManagedEventLogFollowOptions } from "./types.js";
import {
  mergeManagedEventsForSession,
  normalizeManagedEventBatch,
} from "./normalize.js";

export class ManagedJsonlEventLog implements ManagedEventLog {
  constructor(public readonly stateRoot: string) {}

  appendEvents(agentId: string, sessionId: string, events: Event[]): void {
    if (events.length === 0) return;
    const existingIds = new Set(
      this.listBySession(agentId, sessionId).map((event) => event.eventId),
    );
    const normalized = normalizeManagedEventBatch(sessionId, events, {
      seenEventIds: existingIds,
    });
    if (normalized.length === 0) return;
    const path = this.path(agentId, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      normalized.map((event) => JSON.stringify(event)).join("\n") + "\n",
      "utf8",
    );
  }

  listBySession(agentId: string, sessionId: string): Event[] {
    let raw: string;
    try {
      raw = readFileSync(this.path(agentId, sessionId), "utf8");
    } catch {
      return [];
    }
    const parsedEvents: Event[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Event;
        if (parsed.sessionId === sessionId) parsedEvents.push(parsed);
      } catch {
        // Skip partial/corrupt tail lines.
      }
    }
    return mergeManagedEventsForSession(sessionId, parsedEvents);
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
    try {
      return { bytes: statSync(this.path(agentId, sessionId)).size };
    } catch {
      return undefined;
    }
  }

  deleteBySession(agentId: string, sessionId: string): void {
    try {
      unlinkSync(this.path(agentId, sessionId));
    } catch {
      // Already gone.
    }
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

  private path(agentId: string, sessionId: string): string {
    return join(this.stateRoot, agentId, "sessions", sessionId, "managed-events.jsonl");
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
