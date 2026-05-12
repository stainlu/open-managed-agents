import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1Result,
} from "../events/d1.js";
import type {
  FlueEngine,
  FlueManagedWorkspaceCommandExecutor,
} from "../harness/flue.js";
import { NativeOnlySessionRuntime } from "../runtime/native.js";
import { InMemoryStore } from "../store/memory.js";
import type {
  R2BucketLike,
  R2ListOptionsLike,
  R2ListResultLike,
  R2ObjectBodyLike,
} from "../workspace/r2.js";
import {
  WorkspaceError,
  type ManagedWorkspace,
  type WorkspaceEntry,
  type WorkspaceWriteResult,
} from "../workspace/types.js";
import { createCloudflareFlueStack } from "./flue-stack.js";

describe("createCloudflareFlueStack", () => {
  it("wires D1 events, D1 harness state, Flue, and native runtime", async () => {
    const { db, close } = sqliteD1();
    const store = new InMemoryStore();
    const workspace = new EmptyWorkspace();
    const engine: FlueEngine = {
      prompt: async (args) => ({
        text: `flue:${args.content}`,
        usage: { input: 3, output: 5, cost: { total: 0.001 } },
        model: args.model ?? args.agent.model,
      }),
    };

    try {
      const stack = createCloudflareFlueStack({
        db,
        store,
        workspace,
        flueEngine: engine,
        runTimeoutMs: 1_000,
      });
      expect(stack.harnesses.defaultId).toBe("flue");
      expect(stack.flueHarness.runtimeMode).toBe("native");
      expect(stack.runtime).toBeInstanceOf(NativeOnlySessionRuntime);

      await stack.harnessState.save({
        harnessId: "flue",
        agentId: "agt_state",
        sessionId: "ses_state",
        key: "session",
        value: { ok: true },
      });
      await expect(stack.harnessState.load({
        harnessId: "flue",
        agentId: "agt_state",
        sessionId: "ses_state",
        key: "session",
      })).resolves.toEqual({ ok: true });

      const agent = store.agents.create({
        harnessId: "flue",
        model: "test-model",
        tools: [],
        instructions: "",
        permissionPolicy: { type: "always_allow" },
        callableAgents: [],
        maxSubagentDepth: 0,
      });
      const session = stack.router.createSession(agent.agentId);
      await stack.router.runEvent({
        sessionId: session.sessionId,
        content: "hello",
      });
      await waitForSessionToStopRunning(store, session.sessionId);

      const events = await stack.events.listBySession(agent.agentId, session.sessionId);
      expect(events.map((event) => event.type)).toEqual([
        "user.message",
        "agent.message",
      ]);
      expect(events[1]).toMatchObject({
        content: "flue:hello",
        tokensIn: 3,
        tokensOut: 5,
        costUsd: 0.001,
        model: "test-model",
      });
    } finally {
      close();
      store.close();
    }
  });

  it("does not silently accept non-Flue default agent templates", async () => {
    const { db, close } = sqliteD1();
    const store = new InMemoryStore();
    try {
      const stack = createCloudflareFlueStack({
        db,
        store,
        workspace: new EmptyWorkspace(),
        flueEngine: {
          prompt: async () => ({ text: "unused" }),
        },
      });
      const agent = store.agents.create({
        model: "test-model",
        tools: [],
        instructions: "",
        permissionPolicy: { type: "always_allow" },
        callableAgents: [],
        maxSubagentDepth: 0,
      });

      expect(() => stack.router.createSession(agent.agentId))
        .toThrow(/uses unsupported harness openclaw/);
    } finally {
      close();
      store.close();
    }
  });

  it("passes a managed workspace command executor into the Flue harness", () => {
    const { db, close } = sqliteD1();
    const store = new InMemoryStore();
    const workspace = new EmptyWorkspace();
    const workspaceCommandExecutor: FlueManagedWorkspaceCommandExecutor = {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    };

    try {
      const stack = createCloudflareFlueStack({
        db,
        store,
        workspace,
        workspaceCommandExecutor,
        flueEngine: {
          prompt: async () => ({ text: "unused" }),
        },
      });
      const harness = stack.flueHarness as unknown as {
        cfg?: { workspaceCommandExecutor?: FlueManagedWorkspaceCommandExecutor };
      };
      expect(harness.cfg?.workspaceCommandExecutor).toBe(workspaceCommandExecutor);
    } finally {
      close();
      store.close();
    }
  });

  it("can construct the workspace from an R2-compatible bucket", async () => {
    const { db, close } = sqliteD1();
    const store = new InMemoryStore();
    try {
      const stack = createCloudflareFlueStack({
        db,
        store,
        r2Bucket: new FakeR2Bucket(),
        flueEngine: {
          prompt: async () => ({ text: "unused" }),
        },
      });

      await stack.workspace.writeFile("agt_1", "ses_1", "artifact.txt", Buffer.from("ok"));
      await expect(stack.workspace.readFile("agt_1", "ses_1", "artifact.txt"))
        .resolves.toEqual(Buffer.from("ok"));
    } finally {
      close();
      store.close();
    }
  });
});

async function waitForSessionToStopRunning(
  store: InMemoryStore,
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

class EmptyWorkspace implements ManagedWorkspace {
  async listFiles(): Promise<WorkspaceEntry[]> {
    return [];
  }

  async readFile(): Promise<Buffer> {
    throw new WorkspaceError("file_not_found", "workspace backend is not configured");
  }

  async writeFile(
    _agentId: string,
    _sessionId: string,
    relPath: string,
    content: Buffer,
  ): Promise<WorkspaceWriteResult> {
    return { path: relPath, size: content.byteLength };
  }

  async deleteFile(): Promise<void> {}
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
}
