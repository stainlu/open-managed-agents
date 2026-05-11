import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurableObjectSqlStore,
  type DurableObjectSqlCursorLike,
  type DurableObjectStorageLike,
} from "./durable-object-sql.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "do-sql-store-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("DurableObjectSqlStore", () => {
  it("runs OMA metadata stores over a Cloudflare-style sql.exec surface", () => {
    const backing = new Database(join(tmpDir, "metadata.db"));
    const platform = new FakeDurableObjectStorage(backing);
    const store = new DurableObjectSqlStore(platform);

    const agent = store.agents.create({
      model: "anthropic/claude-haiku-4-5",
      tools: [],
      instructions: "be useful",
      permissionPolicy: { type: "always_allow" },
      callableAgents: [],
      maxSubagentDepth: 0,
    });
    const session = store.sessions.create({
      agentId: agent.agentId,
      harnessId: "flue",
      nativeSessionId: "flue-session",
      nativeMetadata: { flue: { sessionId: "flue-session" } },
    });

    store.sessions.beginRun(session.sessionId);
    store.sessions.markRunning(session.sessionId);
    store.sessions.endRunSuccess(session.sessionId, {
      tokensIn: 3,
      tokensOut: 5,
      costUsd: 0.0002,
    });
    store.queue.enqueue(session.sessionId, { content: "next", enqueuedAt: 1234 });
    store.secrets.set("parent", Buffer.from("secret"));

    expect(store.agents.get(agent.agentId)?.model).toBe("anthropic/claude-haiku-4-5");
    expect(store.sessions.get(session.sessionId)).toMatchObject({
      harnessId: "flue",
      nativeSessionId: "flue-session",
      status: "idle",
      tokensIn: 3,
      tokensOut: 5,
      costUsd: 0.0002,
    });
    expect(store.queue.shift(session.sessionId)).toEqual({
      content: "next",
      enqueuedAt: 1234,
    });
    expect(store.secrets.get("parent")?.toString("utf8")).toBe("secret");

    store.close();
    backing.close();
  });
});

class FakeDurableObjectStorage implements DurableObjectStorageLike {
  readonly sql = {
    exec: (query: string, ...bindings: unknown[]) => this.exec(query, ...bindings),
  };

  constructor(private readonly db: Database.Database) {}

  transactionSync<T>(callback: () => T): T {
    return this.db.transaction(callback)();
  }

  private exec(query: string, ...bindings: unknown[]): DurableObjectSqlCursorLike {
    try {
      const stmt = this.db.prepare(query);
      try {
        return new FakeCursor(stmt.all(...bindings) as Array<Record<string, unknown>>);
      } catch {
        const info = stmt.run(...bindings);
        return new FakeCursor([], info.changes, info.lastInsertRowid);
      }
    } catch (error) {
      if (bindings.length === 0) {
        this.db.exec(query);
        return new FakeCursor([]);
      }
      throw error;
    }
  }
}

class FakeCursor implements DurableObjectSqlCursorLike {
  constructor(
    private readonly rows: Array<Record<string, unknown>>,
    readonly rowsWritten = 0,
    readonly lastInsertRowid?: number | bigint,
  ) {}

  toArray(): Array<Record<string, unknown>> {
    return this.rows;
  }

  one(): Record<string, unknown> | undefined {
    return this.rows[0];
  }

  [Symbol.iterator](): Iterator<Record<string, unknown>> {
    return this.rows[Symbol.iterator]();
  }
}
