import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1Result,
} from "../events/d1.js";
import {
  D1ManagedHarnessStateStore,
  LocalHarnessStateStore,
} from "./state-store.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oma-harness-state-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("LocalHarnessStateStore", () => {
  it("persists opaque harness state keys under the managed session root", async () => {
    const root = await tempRoot();
    const store = new LocalHarnessStateStore(root);

    await store.save({
      harnessId: "flue",
      agentId: "agt_1",
      sessionId: "ses_1",
      key: "agent:agt_1:session/task:ses_1:abc",
      value: { version: 2, entries: [{ id: "entry_1" }] },
    });

    await expect(store.load({
      harnessId: "flue",
      agentId: "agt_1",
      sessionId: "ses_1",
      key: "agent:agt_1:session/task:ses_1:abc",
    })).resolves.toEqual({ version: 2, entries: [{ id: "entry_1" }] });

    const raw = await readFile(
      join(root, "agt_1", "sessions", "ses_1", "harness-state", "flue", "YWdlbnQ6YWd0XzE6c2Vzc2lvbi90YXNrOnNlc18xOmFiYw.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual({ version: 2, entries: [{ id: "entry_1" }] });
  });

  it("deletes one key and whole-session state idempotently", async () => {
    const root = await tempRoot();
    const store = new LocalHarnessStateStore(root);
    const base = {
      harnessId: "flue",
      agentId: "agt_1",
      sessionId: "ses_1",
    };

    await store.save({ ...base, key: "a", value: { a: 1 } });
    await store.save({ ...base, key: "b", value: { b: 1 } });

    await store.delete({ ...base, key: "a" });
    await expect(store.load({ ...base, key: "a" })).resolves.toBeNull();
    await expect(store.load({ ...base, key: "b" })).resolves.toEqual({ b: 1 });

    await store.deleteBySession("agt_1", "ses_1");
    await expect(store.load({ ...base, key: "b" })).resolves.toBeNull();
    await store.deleteBySession("agt_1", "ses_1");
  });

  it("rejects path-shaped managed identifiers", async () => {
    const store = new LocalHarnessStateStore(await tempRoot());

    await expect(store.save({
      harnessId: "flue",
      agentId: "../agt",
      sessionId: "ses_1",
      key: "safe",
      value: {},
    })).rejects.toThrow("invalid agentId");
  });
});

describe("D1ManagedHarnessStateStore", () => {
  it("saves, overwrites, loads, and deletes opaque harness state", async () => {
    const { db, close } = sqliteD1();
    try {
      const store = new D1ManagedHarnessStateStore(db);
      const key = {
        harnessId: "flue",
        agentId: "agt_1",
        sessionId: "ses_1",
        key: "agent:agt_1:session/task:ses_1:abc",
      };

      await store.save({ ...key, value: { version: 1 } });
      await expect(store.load(key)).resolves.toEqual({ version: 1 });

      await store.save({ ...key, value: { version: 2, entries: [{ id: "entry_1" }] } });
      await expect(store.load(key)).resolves.toEqual({
        version: 2,
        entries: [{ id: "entry_1" }],
      });

      await store.delete(key);
      await expect(store.load(key)).resolves.toBeNull();
      await store.delete(key);
    } finally {
      close();
    }
  });

  it("deletes all harness state for one managed session only", async () => {
    const { db, close } = sqliteD1();
    try {
      const store = new D1ManagedHarnessStateStore(db);
      await store.save({
        harnessId: "flue",
        agentId: "agt_1",
        sessionId: "ses_1",
        key: "a",
        value: { a: 1 },
      });
      await store.save({
        harnessId: "codex",
        agentId: "agt_1",
        sessionId: "ses_1",
        key: "b",
        value: { b: 1 },
      });
      await store.save({
        harnessId: "flue",
        agentId: "agt_1",
        sessionId: "ses_2",
        key: "a",
        value: { other: true },
      });

      await store.deleteBySession("agt_1", "ses_1");

      await expect(store.load({
        harnessId: "flue",
        agentId: "agt_1",
        sessionId: "ses_1",
        key: "a",
      })).resolves.toBeNull();
      await expect(store.load({
        harnessId: "codex",
        agentId: "agt_1",
        sessionId: "ses_1",
        key: "b",
      })).resolves.toBeNull();
      await expect(store.load({
        harnessId: "flue",
        agentId: "agt_1",
        sessionId: "ses_2",
        key: "a",
      })).resolves.toEqual({ other: true });
    } finally {
      close();
    }
  });

  it("rejects dynamic table names that are not SQL identifiers", () => {
    const { db, close } = sqliteD1();
    try {
      expect(() =>
        new D1ManagedHarnessStateStore(db, {
          tableName: "managed_harness_state; drop table x",
        })
      ).toThrow(/invalid SQL identifier/);
    } finally {
      close();
    }
  });
});

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
    const tx = this.db.transaction(() => {
      for (const statement of statements) {
        results.push((statement as SqliteD1PreparedStatement).runSync());
      }
    });
    tx();
    return results;
  }
}

class SqliteD1PreparedStatement implements D1PreparedStatementLike {
  private values: unknown[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    const clone = new SqliteD1PreparedStatement(this.db, this.query);
    clone.values = values;
    return clone;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return { results: this.db.prepare(this.query).all(...this.values) as T[] };
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.values) as T | undefined) ?? null;
  }

  async run(): Promise<unknown> {
    return this.runSync();
  }

  runSync(): unknown {
    return this.db.prepare(this.query).run(...this.values);
  }
}
