import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "./memory.js";
import { SqliteStore } from "./sqlite.js";
import type { PendingApprovalStore } from "./types.js";

function sharedApprovalSuite(label: string, build: () => PendingApprovalStore) {
  describe(`${label} — shared semantics`, () => {
    it("starts empty", () => {
      const approvals = build();
      expect(approvals.listBySession("ses_missing")).toEqual([]);
      expect(approvals.deleteBySession("ses_missing")).toBe(0);
    });

    it("upserts and lists pending approvals in arrival order", () => {
      const approvals = build();
      approvals.upsert({
        approvalId: "ap_b",
        sessionId: "ses_a",
        toolName: "write",
        description: "write?",
        arrivedAt: 20,
      });
      approvals.upsert({
        approvalId: "ap_a",
        sessionId: "ses_a",
        toolName: "read",
        toolCallId: "call_a",
        description: "read?",
        arrivedAt: 10,
      });

      expect(approvals.listBySession("ses_a")).toEqual([
        {
          approvalId: "ap_a",
          sessionId: "ses_a",
          toolName: "read",
          toolCallId: "call_a",
          description: "read?",
          arrivedAt: 10,
        },
        {
          approvalId: "ap_b",
          sessionId: "ses_a",
          toolName: "write",
          description: "write?",
          arrivedAt: 20,
        },
      ]);
    });

    it("deduplicates by approval id on replace", () => {
      const approvals = build();
      approvals.replaceForSession("ses_a", [
        {
          approvalId: "ap_same",
          sessionId: "ses_a",
          toolName: "write",
          description: "first",
          arrivedAt: 1,
        },
        {
          approvalId: "ap_same",
          sessionId: "ses_a",
          toolName: "write",
          toolCallId: "call_2",
          description: "second",
          arrivedAt: 2,
        },
      ]);

      expect(approvals.listBySession("ses_a")).toEqual([
        {
          approvalId: "ap_same",
          sessionId: "ses_a",
          toolName: "write",
          toolCallId: "call_2",
          description: "second",
          arrivedAt: 2,
        },
      ]);
    });

    it("replaces one session without touching another", () => {
      const approvals = build();
      approvals.upsert({
        approvalId: "ap_a",
        sessionId: "ses_a",
        toolName: "write",
        description: "a",
        arrivedAt: 1,
      });
      approvals.upsert({
        approvalId: "ap_b",
        sessionId: "ses_b",
        toolName: "write",
        description: "b",
        arrivedAt: 2,
      });
      approvals.replaceForSession("ses_a", []);

      expect(approvals.listBySession("ses_a")).toEqual([]);
      expect(approvals.listBySession("ses_b")).toHaveLength(1);
    });

    it("scopes approval ids by session", () => {
      const approvals = build();
      approvals.upsert({
        approvalId: "ap_same",
        sessionId: "ses_a",
        toolName: "write",
        description: "a",
        arrivedAt: 1,
      });
      approvals.upsert({
        approvalId: "ap_same",
        sessionId: "ses_b",
        toolName: "write",
        description: "b",
        arrivedAt: 2,
      });

      expect(approvals.listBySession("ses_a")).toEqual([
        {
          approvalId: "ap_same",
          sessionId: "ses_a",
          toolName: "write",
          description: "a",
          arrivedAt: 1,
        },
      ]);
      expect(approvals.listBySession("ses_b")).toEqual([
        {
          approvalId: "ap_same",
          sessionId: "ses_b",
          toolName: "write",
          description: "b",
          arrivedAt: 2,
        },
      ]);
    });

    it("removes individual approvals and whole sessions idempotently", () => {
      const approvals = build();
      approvals.upsert({
        approvalId: "ap_a",
        sessionId: "ses_a",
        toolName: "write",
        description: "a",
        arrivedAt: 1,
      });
      approvals.upsert({
        approvalId: "ap_b",
        sessionId: "ses_a",
        toolName: "read",
        description: "b",
        arrivedAt: 2,
      });

      approvals.delete("ses_a", "ap_a");
      approvals.delete("ses_a", "ap_missing");
      expect(approvals.listBySession("ses_a").map((approval) => approval.approvalId))
        .toEqual(["ap_b"]);
      expect(approvals.deleteBySession("ses_a")).toBe(1);
      expect(approvals.deleteBySession("ses_a")).toBe(0);
    });
  });
}

sharedApprovalSuite("InMemoryPendingApprovalStore", () => new InMemoryStore().approvals);

let tmpDir: string;
let sqliteCase = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "approval-store-"));
  sqliteCase = 0;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function createSqliteSession(store: SqliteStore, sessionId = "ses_a"): string {
  const agent = store.agents.create({
    model: "m",
    tools: [],
    instructions: "",
    permissionPolicy: { type: "always_allow" },
    callableAgents: [],
    maxSubagentDepth: 0,
  });
  return store.sessions.create({ agentId: agent.agentId, sessionId }).sessionId;
}

sharedApprovalSuite("SqlitePendingApprovalStore", () => {
  const store = new SqliteStore(join(tmpDir, `shared-${sqliteCase++}.db`));
  createSqliteSession(store, "ses_a");
  createSqliteSession(store, "ses_b");
  return store.approvals;
});

describe("SqlitePendingApprovalStore — durability", () => {
  it("round-trips observed approvals across close+reopen", () => {
    const path = join(tmpDir, "durable.db");
    const first = new SqliteStore(path);
    const sessionId = createSqliteSession(first);
    first.approvals.upsert({
      approvalId: "ap_restart",
      sessionId,
      toolName: "mcp__repo__write",
      toolCallId: "call_restart",
      description: "write after restart?",
      arrivedAt: 1234,
    });
    first.close();

    const second = new SqliteStore(path);
    expect(second.approvals.listBySession(sessionId)).toEqual([
      {
        approvalId: "ap_restart",
        sessionId,
        toolName: "mcp__repo__write",
        toolCallId: "call_restart",
        description: "write after restart?",
        arrivedAt: 1234,
      },
    ]);
    second.close();
  });

  it("cascades approvals when a session is deleted", () => {
    const store = new SqliteStore(join(tmpDir, "cascade.db"));
    const sessionId = createSqliteSession(store);
    store.approvals.upsert({
      approvalId: "ap_delete",
      sessionId,
      toolName: "write",
      description: "delete me",
      arrivedAt: 1,
    });

    expect(store.sessions.delete(sessionId)).toBe(true);
    expect(store.approvals.listBySession(sessionId)).toEqual([]);
    store.close();
  });
});
