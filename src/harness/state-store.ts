import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { D1DatabaseLike } from "../events/d1.js";

export type HarnessStateKey = {
  harnessId: string;
  agentId: string;
  sessionId: string;
  key: string;
};

export type ManagedHarnessStateStore = {
  save(args: HarnessStateKey & { value: unknown }): Promise<void>;
  load(args: HarnessStateKey): Promise<unknown | null>;
  delete(args: HarnessStateKey): Promise<void>;
  deleteBySession(agentId: string, sessionId: string): Promise<void>;
};

export class LocalHarnessStateStore implements ManagedHarnessStateStore {
  constructor(private readonly stateRoot: string) {}

  async save(args: HarnessStateKey & { value: unknown }): Promise<void> {
    const raw = JSON.stringify(args.value);
    if (raw === undefined) {
      throw new Error("harness state value must be JSON-serializable");
    }
    const path = this.path(args);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, raw, "utf8");
    await rename(tmp, path);
  }

  async load(args: HarnessStateKey): Promise<unknown | null> {
    let raw: string;
    try {
      raw = await readFile(this.path(args), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return JSON.parse(raw) as unknown;
  }

  async delete(args: HarnessStateKey): Promise<void> {
    try {
      await unlink(this.path(args));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  async deleteBySession(agentId: string, sessionId: string): Promise<void> {
    await rm(this.sessionRoot(agentId, sessionId), { recursive: true, force: true });
  }

  private path(args: HarnessStateKey): string {
    return join(
      this.sessionRoot(args.agentId, args.sessionId),
      safeSegment(args.harnessId, "harnessId"),
      `${opaqueKey(args.key)}.json`,
    );
  }

  private sessionRoot(agentId: string, sessionId: string): string {
    return join(
      this.stateRoot,
      safeSegment(agentId, "agentId"),
      "sessions",
      safeSegment(sessionId, "sessionId"),
      "harness-state",
    );
  }
}

export type D1ManagedHarnessStateStoreOptions = {
  tableName?: string;
  autoEnsureSchema?: boolean;
};

type HarnessStateRow = {
  state_json?: string;
};

export class D1ManagedHarnessStateStore implements ManagedHarnessStateStore {
  private readonly tableName: string;
  private readonly autoEnsureSchema: boolean;
  private schemaPromise: Promise<void> | undefined;

  constructor(
    private readonly db: D1DatabaseLike,
    opts: D1ManagedHarnessStateStoreOptions = {},
  ) {
    this.tableName = sqlIdentifier(opts.tableName ?? "managed_harness_state");
    this.autoEnsureSchema = opts.autoEnsureSchema ?? true;
  }

  async ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.createSchema();
    }
    await this.schemaPromise;
  }

  async save(args: HarnessStateKey & { value: unknown }): Promise<void> {
    await this.ensureReady();
    const raw = JSON.stringify(args.value);
    if (raw === undefined) {
      throw new Error("harness state value must be JSON-serializable");
    }
    await this.db.prepare(`
      INSERT INTO ${this.tableName}
        (harness_id, agent_id, session_id, state_key, state_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(harness_id, agent_id, session_id, state_key)
      DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
    `).bind(
      args.harnessId,
      args.agentId,
      args.sessionId,
      args.key,
      raw,
      Date.now(),
    ).run();
  }

  async load(args: HarnessStateKey): Promise<unknown | null> {
    await this.ensureReady();
    const row = await this.db.prepare(`
      SELECT state_json
      FROM ${this.tableName}
      WHERE harness_id = ? AND agent_id = ? AND session_id = ? AND state_key = ?
      LIMIT 1
    `).bind(
      args.harnessId,
      args.agentId,
      args.sessionId,
      args.key,
    ).first<HarnessStateRow>();
    if (!row?.state_json) return null;
    return JSON.parse(row.state_json) as unknown;
  }

  async delete(args: HarnessStateKey): Promise<void> {
    await this.ensureReady();
    await this.db.prepare(`
      DELETE FROM ${this.tableName}
      WHERE harness_id = ? AND agent_id = ? AND session_id = ? AND state_key = ?
    `).bind(
      args.harnessId,
      args.agentId,
      args.sessionId,
      args.key,
    ).run();
  }

  async deleteBySession(agentId: string, sessionId: string): Promise<void> {
    await this.ensureReady();
    await this.db.prepare(`
      DELETE FROM ${this.tableName}
      WHERE agent_id = ? AND session_id = ?
    `).bind(agentId, sessionId).run();
  }

  private async ensureReady(): Promise<void> {
    if (this.autoEnsureSchema) {
      await this.ensureSchema();
    }
  }

  private async createSchema(): Promise<void> {
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        harness_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state_key TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (harness_id, agent_id, session_id, state_key)
      )
    `).run();
    await this.db.prepare(`
      CREATE INDEX IF NOT EXISTS ${this.tableName}_session_idx
      ON ${this.tableName} (agent_id, session_id)
    `).run();
  }
}

function safeSegment(value: string, label: string): string {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return value;
}

function opaqueKey(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`invalid SQL identifier: ${value}`);
  }
  return value;
}
