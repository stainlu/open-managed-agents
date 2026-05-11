import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1Result,
} from "../events/d1.js";
import {
  DurableObjectSqlStore,
  type DurableObjectSqlCursorLike,
  type DurableObjectStorageLike,
} from "../store/durable-object-sql.js";
import type { Store } from "../store/types.js";
import type {
  R2BucketLike,
  R2ListOptionsLike,
  R2ListResultLike,
  R2ObjectBodyLike,
} from "../workspace/r2.js";
import {
  CloudflareFlueDurableObject,
  createCloudflareFlueDurableObjectHandler,
} from "./durable-object.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "oma-cf-do-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("createCloudflareFlueDurableObjectHandler", () => {
  it("wires DO SQLite metadata with D1 events and an R2 workspace", async () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();
    const r2Bucket = new FakeR2Bucket();

    try {
      const handler = createCloudflareFlueDurableObjectHandler({
        state: { storage: doStorage },
        db,
        r2Bucket,
        flueEngine: {
          prompt: async (args) => ({
            text: `flue:${args.content}`,
            usage: { input: 2, output: 4, cost: { total: 0.0007 } },
            model: args.model ?? args.agent.model,
          }),
        },
      });

      const created = await handler.fetch(new Request("https://oma.example/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          harnessId: "flue",
          model: "test/model",
          instructions: "be useful",
        }),
      }));
      expect(created.status).toBe(200);
      const agentBody = await created.json() as { agent_id: string };

      const agent = handler.stack.store.agents.get(agentBody.agent_id);
      expect(agent).toMatchObject({
        harnessId: "flue",
        model: "test/model",
      });

      const session = handler.stack.router.createSession(agentBody.agent_id);
      await handler.stack.workspace.writeFile(
        agentBody.agent_id,
        session.sessionId,
        "notes.txt",
        Buffer.from("ok"),
      );
      await expect(
        handler.stack.workspace.readFile(agentBody.agent_id, session.sessionId, "notes.txt"),
      ).resolves.toEqual(Buffer.from("ok"));

      await handler.stack.router.runEvent({
        sessionId: session.sessionId,
        content: "hello",
      });
      await waitForSessionToStopRunning(handler.stack.store, session.sessionId);

      const events = await handler.stack.events.listBySession(agentBody.agent_id, session.sessionId);
      expect(events.map((event) => event.type)).toEqual([
        "user.message",
        "agent.message",
      ]);
      expect(events[1]).toMatchObject({
        content: "flue:hello",
        tokensIn: 2,
        tokensOut: 4,
        costUsd: 0.0007,
        model: "test/model",
      });
      expect([...r2Bucket.keys()]).toEqual([
        `oma-workspaces/${agentBody.agent_id}/sessions/${session.sessionId}/workspace/notes.txt`,
      ]);
    } finally {
      close();
      doBacking.close();
    }
  });
});

describe("CloudflareFlueDurableObject", () => {
  it("serves the Worker API with conventional Cloudflare bindings", async () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();
    const r2Bucket = new FakeR2Bucket();

    try {
      const object = new CloudflareFlueDurableObject(
        { storage: doStorage },
        {
          OMA_DB: db,
          OMA_WORKSPACE: r2Bucket,
          OMA_VERSION: "cf-test",
          OMA_COMMIT_SHA: "abc123",
          OMA_RUN_TIMEOUT_MS: "500",
          OMA_PASSTHROUGH_ENV_JSON: "{\"MODEL_API_KEY\":\"secret\"}",
        },
      );

      const health = await object.fetch(new Request("https://oma.example/healthz"));
      await expect(health.json()).resolves.toMatchObject({
        ok: true,
        version: "cf-test",
        commit: "abc123",
      });

      const store = new DurableObjectSqlStore(doStorage);
      expect(store.secrets.get("parent_token_hmac_secret")?.byteLength).toBe(32);
    } finally {
      close();
      doBacking.close();
    }
  });

  it("fails loudly when required platform bindings are missing", async () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();

    try {
      const object = new CloudflareFlueDurableObject(
        { storage: doStorage },
        { OMA_DB: db },
      );

      expect(() => object.fetch(new Request("https://oma.example/healthz")))
        .toThrow(/OMA_WORKSPACE/);
    } finally {
      close();
      doBacking.close();
    }
  });
});

async function waitForSessionToStopRunning(
  store: Store,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const status = store.sessions.get(sessionId)?.status;
    if (status !== "starting" && status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`session ${sessionId} stayed inflight`);
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
        return new FakeSqlCursor(stmt.all(...bindings) as Array<Record<string, unknown>>);
      } catch {
        const info = stmt.run(...bindings);
        return new FakeSqlCursor([], info.changes, info.lastInsertRowid);
      }
    } catch (error) {
      if (bindings.length === 0) {
        this.db.exec(query);
        return new FakeSqlCursor([]);
      }
      throw error;
    }
  }
}

class FakeSqlCursor implements DurableObjectSqlCursorLike {
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

class FakeR2Bucket implements R2BucketLike {
  private readonly objects = new Map<string, Buffer>();

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const body = this.objects.get(key);
    if (!body) return null;
    return {
      key,
      size: body.byteLength,
      uploaded: new Date(),
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    };
  }

  async put(key: string, value: Uint8Array | ArrayBuffer | string): Promise<unknown> {
    this.objects.set(key, Buffer.from(value as Uint8Array));
  }

  async delete(key: string | string[]): Promise<unknown> {
    for (const item of Array.isArray(key) ? key : [key]) {
      this.objects.delete(item);
    }
  }

  async list(opts: R2ListOptionsLike = {}): Promise<R2ListResultLike> {
    const prefix = opts.prefix ?? "";
    return {
      objects: [...this.objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, body]) => ({
          key,
          size: body.byteLength,
          uploaded: new Date(),
        })),
    };
  }

  keys(): Iterable<string> {
    return this.objects.keys();
  }
}
