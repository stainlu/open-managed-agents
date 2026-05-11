import { SqliteStore, type SqlRunResultLike, type SqlStatementLike, type SyncSqlDatabaseLike } from "./sqlite.js";

export type DurableObjectSqlCursorLike = {
  next?(): IteratorResult<Record<string, unknown>>;
  toArray?(): Array<Record<string, unknown>>;
  one?(): Record<string, unknown> | undefined;
  rowsWritten?: number;
  rowsRead?: number;
  lastRowId?: number | bigint;
  lastInsertRowid?: number | bigint;
  [Symbol.iterator]?: () => Iterator<Record<string, unknown>>;
};

export type DurableObjectSqlStorageLike = {
  exec(query: string, ...bindings: unknown[]): DurableObjectSqlCursorLike;
};

export type DurableObjectStorageLike = {
  sql: DurableObjectSqlStorageLike;
  transactionSync<T>(callback: () => T): T;
};

export class DurableObjectSqlStore extends SqliteStore {
  constructor(
    storage: DurableObjectSqlStorageLike | DurableObjectStorageLike,
    opts?: { vaultKeyEnv?: string },
  ) {
    super(createDurableObjectSqlDatabase(storage), opts);
  }
}

export function createDurableObjectSqlDatabase(
  storage: DurableObjectSqlStorageLike | DurableObjectStorageLike,
): SyncSqlDatabaseLike {
  const sql = isStorageContainer(storage) ? storage.sql : storage;
  const transactionSync = isStorageContainer(storage) ? storage.transactionSync.bind(storage) : undefined;
  return new DurableObjectSqlDatabase(sql, transactionSync);
}

class DurableObjectSqlDatabase implements SyncSqlDatabaseLike {
  constructor(
    private readonly sql: DurableObjectSqlStorageLike,
    private readonly transactionSync: (<T>(callback: () => T) => T) | undefined,
  ) {}

  prepare(source: string): SqlStatementLike {
    return new DurableObjectSqlStatement(this.sql, source);
  }

  exec(source: string): unknown {
    return this.sql.exec(source);
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    const normalized = source.trim();
    if (normalized === "foreign_keys" && options?.simple) {
      return firstColumnValue(this.sql.exec(`PRAGMA ${normalized}`)) ?? 1;
    }
    if (normalized === "foreign_key_check") {
      return cursorToArray(this.sql.exec(`PRAGMA ${normalized}`));
    }
    if (normalized.startsWith("table_info(")) {
      return cursorToArray(this.sql.exec(`PRAGMA ${normalized}`));
    }
    try {
      const cursor = this.sql.exec(`PRAGMA ${normalized}`);
      return options?.simple ? firstColumnValue(cursor) : cursorToArray(cursor);
    } catch (error) {
      if (isBestEffortPragma(normalized)) return options?.simple ? 1 : [];
      throw error;
    }
  }

  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    const wrapped = ((...args: unknown[]) => {
      if (this.transactionSync) {
        return this.transactionSync(() => fn(...args));
      }
      throw new Error(
        "DurableObjectSqlStore transactions require ctx.storage.transactionSync; pass ctx.storage instead of ctx.storage.sql",
      );
    }) as T;
    return wrapped;
  }

  close(): void {
    // Durable Object SQL is owned by the platform runtime.
  }
}

class DurableObjectSqlStatement implements SqlStatementLike {
  private readonly compiled: CompiledSql;

  constructor(
    private readonly sql: DurableObjectSqlStorageLike,
    source: string,
  ) {
    this.compiled = compileNamedParameters(source);
  }

  run(...params: unknown[]): SqlRunResultLike {
    const cursor = this.execute(params);
    return {
      changes: Number(cursor.rowsWritten ?? 0),
      lastInsertRowid: cursor.lastInsertRowid ?? cursor.lastRowId,
    };
  }

  get(...params: unknown[]): unknown {
    return cursorToArray(this.execute(params))[0];
  }

  all(...params: unknown[]): unknown[] {
    return cursorToArray(this.execute(params));
  }

  private execute(params: unknown[]): DurableObjectSqlCursorLike {
    return this.sql.exec(this.compiled.sql, ...bindParams(this.compiled.names, params));
  }
}

type CompiledSql = {
  sql: string;
  names: string[];
};

function compileNamedParameters(sql: string): CompiledSql {
  const names: string[] = [];
  return {
    sql: sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
      names.push(name);
      return "?";
    }),
    names,
  };
}

function bindParams(names: string[], params: unknown[]): unknown[] {
  if (names.length === 0) return params;
  if (params.length === 1 && isRecord(params[0])) {
    const record = params[0];
    return names.map((name) => record[name]);
  }
  if (params.length === names.length) return params;
  throw new Error(
    `SQL statement expected named params [${names.join(", ")}] but received ${params.length} positional params`,
  );
}

function cursorToArray(cursor: DurableObjectSqlCursorLike): Array<Record<string, unknown>> {
  if (typeof cursor.toArray === "function") return cursor.toArray();
  const iterator = cursor[Symbol.iterator]?.();
  if (iterator) {
    const rows: Array<Record<string, unknown>> = [];
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      rows.push(next.value);
    }
    return rows;
  }
  if (typeof cursor.next === "function") {
    const rows: Array<Record<string, unknown>> = [];
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      rows.push(next.value);
    }
    return rows;
  }
  const first = cursor.one?.();
  return first ? [first] : [];
}

function firstColumnValue(cursor: DurableObjectSqlCursorLike): unknown {
  const row = cursorToArray(cursor)[0];
  if (!row) return undefined;
  return Object.values(row)[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStorageContainer(
  storage: DurableObjectSqlStorageLike | DurableObjectStorageLike,
): storage is DurableObjectStorageLike {
  return "sql" in storage;
}

function isBestEffortPragma(source: string): boolean {
  return source === "journal_mode = WAL" ||
    source === "synchronous = NORMAL" ||
    source === "foreign_keys = ON" ||
    source === "foreign_keys = OFF";
}
