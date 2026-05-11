import type { Event } from "../orchestrator/types.js";
import {
  mergeManagedEventsForSession,
  normalizeManagedEventBatch,
} from "./normalize.js";
import type { ManagedEventLog, ManagedEventLogFollowOptions } from "./types.js";

export type D1Result<T = unknown> = {
  results?: T[];
};

export type D1PreparedStatementLike = {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = unknown>(): Promise<D1Result<T>>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
};

export type D1DatabaseLike = {
  prepare(query: string): D1PreparedStatementLike;
  batch?(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
};

export type D1ManagedEventLogOptions = {
  /**
   * Legacy compatibility with ManagedEventLog. D1-backed stores do not use a
   * local state root, so callers should not treat this as a filesystem path.
   */
  stateRoot?: string;
  tableName?: string;
  autoEnsureSchema?: boolean;
};

type EventRow = {
  event_json?: string;
};

type CountRow = {
  count?: number;
  bytes?: number;
};

export class D1ManagedEventLog implements ManagedEventLog {
  public readonly stateRoot: string | undefined;
  private readonly tableName: string;
  private readonly autoEnsureSchema: boolean;
  private schemaPromise: Promise<void> | undefined;

  constructor(
    private readonly db: D1DatabaseLike,
    opts: D1ManagedEventLogOptions = {},
  ) {
    this.stateRoot = opts.stateRoot;
    this.tableName = sqlIdentifier(opts.tableName ?? "managed_events");
    this.autoEnsureSchema = opts.autoEnsureSchema ?? true;
  }

  async ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.createSchema();
    }
    await this.schemaPromise;
  }

  async appendEvents(agentId: string, sessionId: string, events: Event[]): Promise<void> {
    await this.ensureReady();
    const normalized = normalizeManagedEventBatch(sessionId, events);
    if (normalized.length === 0) return;

    const statements = normalized.map((event) =>
      this.db.prepare(`
        INSERT OR IGNORE INTO ${this.tableName}
          (agent_id, session_id, event_id, event_type, created_at, event_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        agentId,
        sessionId,
        event.eventId,
        event.type,
        event.createdAt,
        JSON.stringify(event),
      )
    );

    if (this.db.batch) {
      await this.db.batch(statements);
      return;
    }
    for (const statement of statements) {
      await statement.run();
    }
  }

  async listBySession(agentId: string, sessionId: string): Promise<Event[]> {
    await this.ensureReady();
    const rows = await this.db.prepare(`
      SELECT event_json
      FROM ${this.tableName}
      WHERE agent_id = ? AND session_id = ?
      ORDER BY created_at ASC, id ASC
    `).bind(agentId, sessionId).all<EventRow>();

    return mergeManagedEventsForSession(
      sessionId,
      (rows.results ?? []).flatMap((row) => parseEventRow(row)),
    );
  }

  async latestAgentMessage(agentId: string, sessionId: string): Promise<Event | undefined> {
    return await this.latestByType(agentId, sessionId, ["agent.message"]);
  }

  async latestAgentOutcome(agentId: string, sessionId: string): Promise<Event | undefined> {
    return await this.latestByType(agentId, sessionId, ["agent.message", "agent.tool_result"]);
  }

  async countUserTurns(agentId: string, sessionId: string): Promise<number> {
    await this.ensureReady();
    const row = await this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM ${this.tableName}
      WHERE agent_id = ? AND session_id = ? AND event_type = 'user.message'
    `).bind(agentId, sessionId).first<CountRow>();
    return numberValue(row?.count);
  }

  async statSessionLog(agentId: string, sessionId: string): Promise<{ bytes: number } | undefined> {
    await this.ensureReady();
    const row = await this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(event_json) + 1), 0) AS bytes
      FROM ${this.tableName}
      WHERE agent_id = ? AND session_id = ?
    `).bind(agentId, sessionId).first<CountRow>();
    if (numberValue(row?.count) === 0) return undefined;
    return { bytes: numberValue(row?.bytes) };
  }

  async deleteBySession(agentId: string, sessionId: string): Promise<void> {
    await this.ensureReady();
    await this.db.prepare(`
      DELETE FROM ${this.tableName}
      WHERE agent_id = ? AND session_id = ?
    `).bind(agentId, sessionId).run();
  }

  async *follow(
    agentId: string,
    sessionId: string,
    opts: ManagedEventLogFollowOptions = {},
  ): AsyncGenerator<Event> {
    const pollMs = opts.pollIntervalMs ?? 100;
    const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
    const seen = new Set<string>();
    const catchUp = await this.listBySession(agentId, sessionId);
    let cursorSeen = opts.afterEventId === undefined;
    if (opts.afterEventId && !catchUp.some((event) => event.eventId === opts.afterEventId)) {
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
      for (const event of await this.listBySession(agentId, sessionId)) {
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

  private async latestByType(
    agentId: string,
    sessionId: string,
    types: string[],
  ): Promise<Event | undefined> {
    await this.ensureReady();
    const placeholders = types.map(() => "?").join(", ");
    const row = await this.db.prepare(`
      SELECT event_json
      FROM ${this.tableName}
      WHERE agent_id = ? AND session_id = ? AND event_type IN (${placeholders})
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).bind(agentId, sessionId, ...types).first<EventRow>();
    return parseEventRow(row)[0];
  }

  private async ensureReady(): Promise<void> {
    if (this.autoEnsureSchema) {
      await this.ensureSchema();
    }
  }

  private async createSchema(): Promise<void> {
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        UNIQUE(agent_id, session_id, event_id)
      )
    `).run();
    await this.db.prepare(`
      CREATE INDEX IF NOT EXISTS ${this.tableName}_session_idx
      ON ${this.tableName} (agent_id, session_id, created_at, id)
    `).run();
    await this.db.prepare(`
      CREATE INDEX IF NOT EXISTS ${this.tableName}_latest_idx
      ON ${this.tableName} (agent_id, session_id, event_type, created_at, id)
    `).run();
  }
}

function sqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`invalid SQL identifier: ${value}`);
  }
  return value;
}

function parseEventRow(row: EventRow | null | undefined): Event[] {
  if (!row?.event_json) return [];
  try {
    return [JSON.parse(row.event_json) as Event];
  } catch {
    return [];
  }
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
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
