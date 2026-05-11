import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { Event } from "../orchestrator/types.js";
import {
  D1ManagedEventLog,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1Result,
} from "./d1.js";

describe("D1ManagedEventLog", () => {
  it("appends, normalizes, dedupes, and lists events in session order", async () => {
    const { db, close } = sqliteD1();
    try {
      const log = new D1ManagedEventLog(db);
      await log.appendEvents("agt_1", "ses_1", [
        event({ eventId: "evt_2", sessionId: "wrong", createdAt: 20, content: { ok: true } }),
        event({ eventId: "evt_1", sessionId: "wrong", createdAt: 10, content: "hello" }),
        event({ eventId: "evt_1", sessionId: "wrong", createdAt: 10, content: "duplicate" }),
      ]);
      await log.appendEvents("agt_1", "ses_1", [
        event({ eventId: "evt_2", createdAt: 20, content: "duplicate second batch" }),
        event({ eventId: "evt_3", createdAt: 30, content: "done" }),
      ]);

      const listed = await log.listBySession("agt_1", "ses_1");
      expect(listed.map((e) => e.eventId)).toEqual(["evt_1", "evt_2", "evt_3"]);
      expect(listed.map((e) => e.sessionId)).toEqual(["ses_1", "ses_1", "ses_1"]);
      expect(listed[1]?.content).toBe('{"ok":true}');
    } finally {
      close();
    }
  });

  it("reads latest outcomes, user-turn counts, and approximate byte stats", async () => {
    const { db, close } = sqliteD1();
    try {
      const log = new D1ManagedEventLog(db);
      await log.appendEvents("agt_1", "ses_1", [
        event({ eventId: "user_1", type: "user.message", createdAt: 10, content: "hi" }),
        event({ eventId: "msg_1", type: "agent.message", createdAt: 20, content: "first" }),
        event({ eventId: "tool_1", type: "agent.tool_result", createdAt: 30, content: "tool" }),
      ]);

      expect(await log.countUserTurns("agt_1", "ses_1")).toBe(1);
      expect((await log.latestAgentMessage("agt_1", "ses_1"))?.eventId).toBe("msg_1");
      expect((await log.latestAgentOutcome("agt_1", "ses_1"))?.eventId).toBe("tool_1");
      expect((await log.statSessionLog("agt_1", "ses_1"))?.bytes).toBeGreaterThan(0);
      expect(await log.statSessionLog("agt_1", "missing")).toBeUndefined();
    } finally {
      close();
    }
  });

  it("deletes one managed session without touching other sessions", async () => {
    const { db, close } = sqliteD1();
    try {
      const log = new D1ManagedEventLog(db);
      await log.appendEvents("agt_1", "ses_1", [event({ eventId: "evt_1" })]);
      await log.appendEvents("agt_1", "ses_2", [event({ eventId: "evt_2" })]);

      await log.deleteBySession("agt_1", "ses_1");

      expect(await log.listBySession("agt_1", "ses_1")).toEqual([]);
      expect((await log.listBySession("agt_1", "ses_2")).map((e) => e.eventId)).toEqual(["evt_2"]);
    } finally {
      close();
    }
  });

  it("follows existing and newly appended events with resume cursors", async () => {
    const { db, close } = sqliteD1();
    try {
      const log = new D1ManagedEventLog(db);
      await log.appendEvents("agt_1", "ses_1", [
        event({ eventId: "evt_1", createdAt: 10 }),
        event({ eventId: "evt_2", createdAt: 20 }),
      ]);

      const abort = new AbortController();
      const followed = log.follow("agt_1", "ses_1", {
        afterEventId: "evt_1",
        pollIntervalMs: 1,
        signal: abort.signal,
      });

      expect((await followed.next()).value?.eventId).toBe("evt_2");
      await log.appendEvents("agt_1", "ses_1", [event({ eventId: "evt_3", createdAt: 30 })]);
      expect((await followed.next()).value?.eventId).toBe("evt_3");
      abort.abort();
      expect((await followed.next()).done).toBe(true);
    } finally {
      close();
    }
  });

  it("rejects dynamic table names that are not SQL identifiers", () => {
    const { db, close } = sqliteD1();
    try {
      expect(() => new D1ManagedEventLog(db, { tableName: "managed_events; drop table x" }))
        .toThrow(/invalid SQL identifier/);
    } finally {
      close();
    }
  });
});

function event(patch: Partial<Event> = {}): Event {
  return {
    eventId: patch.eventId ?? "evt",
    sessionId: patch.sessionId ?? "ses_1",
    type: patch.type ?? "agent.message",
    content: patch.content ?? "ok",
    createdAt: patch.createdAt ?? 1,
    tokensIn: patch.tokensIn,
    tokensOut: patch.tokensOut,
    costUsd: patch.costUsd,
    model: patch.model,
    toolName: patch.toolName,
    toolCallId: patch.toolCallId,
    toolArguments: patch.toolArguments,
    isError: patch.isError,
  };
}

function sqliteD1(): { db: D1DatabaseLike; close: () => void } {
  const sqlite = new Database(":memory:");
  return {
    db: new SqliteD1Database(sqlite),
    close: () => sqlite.close(),
  };
}

class SqliteD1Database implements D1DatabaseLike {
  constructor(private readonly db: Database.Database) {}

  prepare(query: string): D1PreparedStatementLike {
    return new SqliteD1PreparedStatement(this.db, query);
  }

  async batch(statements: D1PreparedStatementLike[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }
}

class SqliteD1PreparedStatement implements D1PreparedStatementLike {
  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new SqliteD1PreparedStatement(this.db, this.query, values);
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return {
      results: this.db.prepare(this.query).all(...this.values) as T[],
    };
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.values) as T | undefined) ?? null;
  }

  async run(): Promise<unknown> {
    return this.db.prepare(this.query).run(...this.values);
  }
}
