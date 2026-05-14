import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "./memory.js";
import { SqliteStore } from "./sqlite.js";
import type { Store } from "./types.js";

function seedSessions(store: Store): void {
  const agent = store.agents.create({
    model: "m",
    tools: [],
    instructions: "",
    permissionPolicy: { type: "always_allow" },
    callableAgents: [],
    maxSubagentDepth: 0,
  });
  store.sessions.create({ sessionId: "ses_a", agentId: agent.agentId });
  store.sessions.create({ sessionId: "ses_b", agentId: agent.agentId });
}

function sharedRunSuite(label: string, build: () => Store) {
  describe(`${label} - shared semantics`, () => {
    it("creates, lists, and reads managed runs by session", () => {
      const store = build();
      seedSessions(store);
      const runs = store.runs;
      const first = runs.create({
        runId: "run_first",
        sessionId: "ses_a",
        agentId: "agt_1",
        status: "queued",
        queued: true,
        model: "anthropic/claude-sonnet-4-6",
        thinkingLevel: "high",
        createdAt: 10,
      });
      runs.create({
        runId: "run_second",
        sessionId: "ses_a",
        agentId: "agt_1",
        status: "starting",
        queued: false,
        createdAt: 20,
      });
      runs.create({
        runId: "run_other",
        sessionId: "ses_b",
        agentId: "agt_1",
        status: "queued",
        queued: true,
        createdAt: 15,
      });

      expect(first).toMatchObject({
        runId: "run_first",
        status: "queued",
        queued: true,
        model: "anthropic/claude-sonnet-4-6",
        thinkingLevel: "high",
      });
      expect(runs.getForSession("ses_a", "run_other")).toBeUndefined();
      expect(runs.listBySession("ses_a").map((run) => run.runId)).toEqual([
        "run_first",
        "run_second",
      ]);
    });

    it("transitions running and terminal timestamps consistently", () => {
      const store = build();
      seedSessions(store);
      const runs = store.runs;
      runs.create({
        runId: "run_lifecycle",
        sessionId: "ses_a",
        agentId: "agt_1",
        status: "starting",
        queued: false,
        createdAt: 100,
      });

      const running = runs.updateStatus("run_lifecycle", "running", { now: 150 });
      expect(running).toMatchObject({
        status: "running",
        startedAt: 150,
        completedAt: null,
      });

      const done = runs.updateStatus("run_lifecycle", "succeeded", { now: 200 });
      expect(done).toMatchObject({
        status: "succeeded",
        startedAt: 150,
        completedAt: 200,
        error: null,
      });
    });

    it("keeps creation idempotent for restart paths", () => {
      const store = build();
      seedSessions(store);
      const runs = store.runs;
      const first = runs.create({
        runId: "run_restart",
        sessionId: "ses_a",
        agentId: "agt_1",
        status: "queued",
        queued: true,
        createdAt: 1,
      });
      const second = runs.create({
        runId: "run_restart",
        sessionId: "ses_a",
        agentId: "agt_1",
        status: "starting",
        queued: false,
        createdAt: 2,
      });

      expect(second).toEqual(first);
      expect(runs.listBySession("ses_a")).toHaveLength(1);
    });

    it("keeps admission order when run timestamps collide", () => {
      const store = build();
      seedSessions(store);
      const runs = store.runs;

      runs.create({
        runId: "run_z",
        sessionId: "ses_a",
        agentId: "agt_1",
        status: "running",
        queued: false,
        createdAt: 100,
      });
      runs.create({
        runId: "run_a",
        sessionId: "ses_a",
        agentId: "agt_1",
        status: "queued",
        queued: true,
        createdAt: 100,
      });

      expect(runs.listBySession("ses_a").map((run) => run.runId)).toEqual([
        "run_z",
        "run_a",
      ]);
    });

    it("does not rewrite terminal runs on duplicate delivery paths", () => {
      const store = build();
      seedSessions(store);
      const runs = store.runs;
      runs.create({
        runId: "run_terminal",
        sessionId: "ses_a",
        agentId: "agt_1",
        status: "running",
        queued: false,
        createdAt: 100,
      });
      const succeeded = runs.updateStatus("run_terminal", "succeeded", {
        now: 200,
      });
      const retried = runs.updateStatus("run_terminal", "skipped", {
        error: "session_not_inflight",
        now: 300,
      });

      expect(retried).toEqual(succeeded);
      expect(runs.get("run_terminal")).toMatchObject({
        status: "succeeded",
        error: null,
        completedAt: 200,
      });
    });
  });
}

sharedRunSuite("InMemoryManagedRunStore", () => new InMemoryStore());

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "managed-runs-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

sharedRunSuite("SqliteManagedRunStore", () => {
  const path = join(tmpDir, "runs.db");
  return new SqliteStore(path);
});
