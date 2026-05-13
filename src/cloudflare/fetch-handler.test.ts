import { describe, expect, it } from "vitest";

import type { ManagedEventLog } from "../events/types.js";
import type { ManagedHarnessStateStore } from "../harness/state-store.js";
import type { Event } from "../orchestrator/types.js";
import { ParentTokenMinter } from "../runtime/parent-token.js";
import { InMemoryStore } from "../store/memory.js";
import type { ManagedWorkspace, WorkspaceEntry, WorkspaceWriteResult } from "../workspace/types.js";
import { createCloudflareFlueFetchHandler } from "./fetch-handler.js";
import type { D1DatabaseLike } from "../events/d1.js";

describe("createCloudflareFlueFetchHandler", () => {
  it("serves the OMA HTTP app through a Worker-style fetch function", async () => {
    const store = new InMemoryStore();
    const handler = createCloudflareFlueFetchHandler({
      db: unusedD1(),
      store,
      workspace: new EmptyWorkspace(),
      eventLog: new EmptyEventLog(),
      harnessState: new MemoryHarnessState(),
      flueEngine: {
        prompt: async () => ({ text: "unused" }),
      },
      tokenMinter: new ParentTokenMinter(Buffer.from("0123456789abcdef")),
      version: "test-version",
      startTs: 1000,
      commitSha: "abc123",
      maxWarmContainers: 0,
      maxActiveContainers: 0,
    });

    const health = await handler.fetch(new Request("https://oma.example/healthz"));
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      version: "test-version",
      commit: "abc123",
      start_ts: 1000,
      max_warm: 0,
      max_active: 0,
      runtime: {
        platform: "cloudflare",
        stack: "cloudflare-flue",
        mode: "native",
        default_harness: "flue",
        bindings: {
          metadata: true,
          database: true,
          workspace: true,
          workflow: false,
          workers_ai: false,
          sandbox: false,
        },
      },
    });

    const runtime = await handler.fetch(new Request("https://oma.example/v1/runtime"));
    await expect(runtime.json()).resolves.toMatchObject({
      runtime: {
        platform: "cloudflare",
        stack: "cloudflare-flue",
        mode: "native",
        default_harness: "flue",
        bindings: {
          metadata: true,
          database: true,
          workspace: true,
        },
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
    await expect(created.json()).resolves.toMatchObject({
      harness_id: "flue",
      model: "test/model",
      instructions: "be useful",
    });
  });

  it("persists a generated parent-token secret into the supplied store", () => {
    const store = new InMemoryStore();
    createCloudflareFlueFetchHandler({
      db: unusedD1(),
      store,
      workspace: new EmptyWorkspace(),
      eventLog: new EmptyEventLog(),
      harnessState: new MemoryHarnessState(),
      flueEngine: {
        prompt: async () => ({ text: "unused" }),
      },
    });

    expect(store.secrets.get("parent_token_hmac_secret")?.byteLength).toBe(32);
  });

  it("rejects ambiguous parent-token secret configuration", () => {
    expect(() => createCloudflareFlueFetchHandler({
      db: unusedD1(),
      store: new InMemoryStore(),
      workspace: new EmptyWorkspace(),
      eventLog: new EmptyEventLog(),
      harnessState: new MemoryHarnessState(),
      flueEngine: {
        prompt: async () => ({ text: "unused" }),
      },
      parentTokenSecret: Buffer.from("0123456789abcdef"),
      parentTokenSecretBase64: Buffer.from("0123456789abcdef").toString("base64"),
    })).toThrow(/parentTokenSecret/);
  });

  it("uses an explicit 32-byte base64 parent-token secret without persisting a generated one", () => {
    const store = new InMemoryStore();
    createCloudflareFlueFetchHandler({
      db: unusedD1(),
      store,
      workspace: new EmptyWorkspace(),
      eventLog: new EmptyEventLog(),
      harnessState: new MemoryHarnessState(),
      flueEngine: {
        prompt: async () => ({ text: "unused" }),
      },
      parentTokenSecretBase64: Buffer.alloc(32, 7).toString("base64"),
    });

    expect(store.secrets.get("parent_token_hmac_secret")).toBeUndefined();
  });

  it("rejects placeholder-looking parent-token base64 secrets", () => {
    expect(() => createCloudflareFlueFetchHandler({
      db: unusedD1(),
      store: new InMemoryStore(),
      workspace: new EmptyWorkspace(),
      eventLog: new EmptyEventLog(),
      harnessState: new MemoryHarnessState(),
      flueEngine: {
        prompt: async () => ({ text: "unused" }),
      },
      parentTokenSecretBase64: "replace-with-32-random-bytes-base64",
    })).toThrow(/base64|32 bytes/);
  });

  it("rejects short decoded parent-token base64 secrets", () => {
    expect(() => createCloudflareFlueFetchHandler({
      db: unusedD1(),
      store: new InMemoryStore(),
      workspace: new EmptyWorkspace(),
      eventLog: new EmptyEventLog(),
      harnessState: new MemoryHarnessState(),
      flueEngine: {
        prompt: async () => ({ text: "unused" }),
      },
      parentTokenSecretBase64: Buffer.from("0123456789abcdef").toString("base64"),
    })).toThrow(/32 bytes/);
  });
});

function unusedD1(): D1DatabaseLike {
  return {
    prepare() {
      throw new Error("D1 should not be used when eventLog and harnessState are injected");
    },
  };
}

class EmptyEventLog implements ManagedEventLog {
  async listBySession(): Promise<Event[]> {
    return [];
  }

  async latestAgentMessage(): Promise<Event | undefined> {
    return undefined;
  }

  async latestAgentOutcome(): Promise<Event | undefined> {
    return undefined;
  }

  async countUserTurns(): Promise<number> {
    return 0;
  }

  async statSessionLog(): Promise<{ bytes: number } | undefined> {
    return undefined;
  }

  async deleteBySession(): Promise<void> {}

  async *follow(): AsyncGenerator<Event> {}
}

class MemoryHarnessState implements ManagedHarnessStateStore {
  private readonly values = new Map<string, unknown>();

  async save(args: Parameters<ManagedHarnessStateStore["save"]>[0]): Promise<void> {
    this.values.set(this.key(args), args.value);
  }

  async load(args: Parameters<ManagedHarnessStateStore["load"]>[0]): Promise<unknown | null> {
    return this.values.get(this.key(args)) ?? null;
  }

  async delete(args: Parameters<ManagedHarnessStateStore["delete"]>[0]): Promise<void> {
    this.values.delete(this.key(args));
  }

  async deleteBySession(agentId: string, sessionId: string): Promise<void> {
    const prefix = `${agentId}:${sessionId}:`;
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) this.values.delete(key);
    }
  }

  private key(args: { agentId: string; sessionId: string; harnessId: string; key: string }): string {
    return `${args.agentId}:${args.sessionId}:${args.harnessId}:${args.key}`;
  }
}

class EmptyWorkspace implements ManagedWorkspace {
  async listFiles(): Promise<WorkspaceEntry[]> {
    return [];
  }

  async readFile(): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  async writeFile(_agentId: string, _sessionId: string, relPath: string, content: Buffer): Promise<WorkspaceWriteResult> {
    return { path: relPath, size: content.byteLength };
  }

  async deleteFile(): Promise<void> {}
}
