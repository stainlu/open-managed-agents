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
import type {
  FlueEngine,
  FlueManagedWorkspaceCommandExecutor,
} from "../harness/flue.js";
import {
  DurableObjectSqlStore,
  type DurableObjectSqlCursorLike,
  type DurableObjectStorageLike,
} from "../store/durable-object-sql.js";
import type { Store } from "../store/types.js";
import type { ManagedRunRequest } from "../runtime/run-scheduler.js";
import type {
  R2BucketLike,
  R2ListOptionsLike,
  R2ListResultLike,
  R2ObjectBodyLike,
} from "../workspace/r2.js";
import {
  CloudflareFlueDurableObject,
  ConfigurableCloudflareFlueDurableObject,
  createCloudflareFlueDurableObjectHandler,
  type CloudflareFlueDurableObjectEnv,
  type CloudflareFlueDurableObjectHandlerOptions,
} from "./durable-object.js";
import {
  CloudflareWorkflowRunScheduler,
  MANAGED_RUN_INTERNAL_PATH,
  MANAGED_RUN_INTERNAL_TOKEN_HEADER,
  type CloudflareWorkflowBindingLike,
} from "./workflow.js";

let tmpDir: string;
const TEST_PARENT_TOKEN_SECRET_BASE64 = Buffer.from(
  "0123456789abcdef0123456789abcdef",
).toString("base64");

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

  it("presents public R2 workspace writes to the real Flue SDK context", async () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();
    const r2Bucket = new FakeR2Bucket();
    let flueRequestPayload = "";
    const aiRun = async (_model: unknown, payload: unknown): Promise<Response> => {
      flueRequestPayload = JSON.stringify(payload);
      return cloudflareTextResponse("workspace visible");
    };

    try {
      const handler = createCloudflareFlueDurableObjectHandler({
        state: { storage: doStorage },
        db,
        r2Bucket,
        cloudflareAiBinding: { run: aiRun },
        cloudflareAiProviderPrefix: "cloudflare-do-workspace-test",
      });

      const created = await handler.fetch(new Request("https://oma.example/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          harnessId: "flue",
          model: "cloudflare-do-workspace-test/@cf/openai/gpt-oss-20b",
          instructions: "fallback OMA instructions",
        }),
      }));
      expect(created.status).toBe(200);
      const agent = await created.json() as { agent_id: string };

      const sessionResponse = await handler.fetch(new Request("https://oma.example/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: agent.agent_id }),
      }));
      expect(sessionResponse.status).toBe(200);
      const session = await sessionResponse.json() as { session_id: string };

      for (const [path, content] of Object.entries({
        "AGENTS.md": "Workspace AGENTS from the public API.",
        "README.md": "# Public Workspace",
        ".agents/skills/review/SKILL.md": [
          "---",
          "name: review",
          "description: Review code from the shared workspace",
          "---",
          "Review the files.",
        ].join("\n"),
      })) {
        const write = await handler.fetch(new Request(
          `https://oma.example/v1/agents/${agent.agent_id}/files/${path}?session_id=${session.session_id}`,
          { method: "PUT", body: content },
        ));
        expect(write.status).toBe(200);
      }

      const event = await handler.fetch(new Request(
        `https://oma.example/v1/sessions/${session.session_id}/events`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "user.message", content: "inspect workspace" }),
        },
      ));
      expect(event.status).toBe(200);
      await waitForSessionToStopRunning(handler.stack.store, session.session_id);

      expect(flueRequestPayload).toContain("Workspace AGENTS from the public API.");
      expect(flueRequestPayload).toContain("README.md");
      expect(flueRequestPayload).toContain("review");
      expect(flueRequestPayload).not.toContain("fallback OMA instructions");

      const events = await handler.stack.events.listBySession(agent.agent_id, session.session_id);
      expect(events.find((entry) => entry.type === "agent.message")).toMatchObject({
        type: "agent.message",
        content: "workspace visible",
      });
    } finally {
      close();
      doBacking.close();
    }
  });

  it("persists real Flue SDK session state through D1 across Durable Object restart", async () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();
    const r2Bucket = new FakeR2Bucket();
    const payloads: string[] = [];
    let responseIndex = 0;
    const aiRun = async (_model: unknown, payload: unknown): Promise<Response> => {
      payloads.push(JSON.stringify(payload));
      const text = `state ${responseIndex}`;
      responseIndex++;
      return cloudflareTextResponse(text);
    };

    try {
      const firstHandler = createCloudflareFlueDurableObjectHandler({
        state: { storage: doStorage },
        db,
        r2Bucket,
        cloudflareAiBinding: { run: aiRun },
        cloudflareAiProviderPrefix: "cloudflare-do-state-test",
      });

      const created = await firstHandler.fetch(new Request("https://oma.example/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          harnessId: "flue",
          model: "cloudflare-do-state-test/@cf/openai/gpt-oss-20b",
          instructions: "persist Flue state through D1",
        }),
      }));
      expect(created.status).toBe(200);
      const agent = await created.json() as { agent_id: string };

      const firstRun = await firstHandler.fetch(new Request(
        `https://oma.example/v1/agents/${agent.agent_id}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: "first durable Flue turn" }),
        },
      ));
      expect(firstRun.status).toBe(200);
      const firstRunBody = await firstRun.json() as { session_id: string; run_id: string };
      await waitForSessionToStopRunning(firstHandler.stack.store, firstRunBody.session_id);

      const firstStateRows = await flueHarnessStateRows(db, agent.agent_id, firstRunBody.session_id);
      expect(firstStateRows).toHaveLength(1);
      const firstEntryCount = sessionEntryCountFromJson(firstStateRows[0]?.state_json);
      expect(firstEntryCount).toBeGreaterThanOrEqual(2);

      const restartedHandler = createCloudflareFlueDurableObjectHandler({
        state: { storage: doStorage },
        db,
        r2Bucket,
        cloudflareAiBinding: { run: aiRun },
        cloudflareAiProviderPrefix: "cloudflare-do-state-test",
      });

      const secondRun = await restartedHandler.fetch(new Request(
        `https://oma.example/v1/sessions/${firstRunBody.session_id}/events`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "user.message", content: "second durable Flue turn" }),
        },
      ));
      expect(secondRun.status).toBe(200);
      await waitForSessionToStopRunning(restartedHandler.stack.store, firstRunBody.session_id);

      expect(payloads).toHaveLength(2);
      expect(payloads[1]).toContain("first durable Flue turn");
      expect(payloads[1]).toContain("state 0");
      expect(payloads[1]).toContain("second durable Flue turn");

      const secondStateRows = await flueHarnessStateRows(db, agent.agent_id, firstRunBody.session_id);
      expect(secondStateRows).toHaveLength(1);
      expect(sessionEntryCountFromJson(secondStateRows[0]?.state_json)).toBeGreaterThan(firstEntryCount);

      const session = await restartedHandler.fetch(new Request(
        `https://oma.example/v1/sessions/${firstRunBody.session_id}`,
      ));
      await expect(session.json()).resolves.toMatchObject({
        session_id: firstRunBody.session_id,
        status: "idle",
        turns: 2,
      });
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
          OMA_PARENT_TOKEN_SECRET_BASE64: TEST_PARENT_TOKEN_SECRET_BASE64,
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

      const store = new DurableObjectSqlStore(doStorage);
      expect(store.secrets.get("parent_token_hmac_secret")).toBeUndefined();
    } finally {
      close();
      doBacking.close();
    }
  });

  it("lets subclasses inject a managed workspace command executor", () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();
    const commandExecutor: FlueManagedWorkspaceCommandExecutor = {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    };

    class TestSandboxFlueObject extends CloudflareFlueDurableObject {
      protected override createWorkspaceCommandExecutor() {
        return commandExecutor;
      }

      handlerForTest() {
        return this.getHandler();
      }
    }

    try {
      const object = new TestSandboxFlueObject(
        { storage: doStorage },
        {
          OMA_DB: db,
          OMA_WORKSPACE: new FakeR2Bucket(),
          OMA_PARENT_TOKEN_SECRET_BASE64: TEST_PARENT_TOKEN_SECRET_BASE64,
        },
      );
      const harness = object.handlerForTest().stack.flueHarness as unknown as {
        cfg?: { workspaceCommandExecutor?: FlueManagedWorkspaceCommandExecutor };
      };
      expect(harness.cfg?.workspaceCommandExecutor).toBe(commandExecutor);
    } finally {
      close();
      doBacking.close();
    }
  });

  it("uses the Workflow binding as the background run scheduler when configured", async () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();
    const workflow = new FakeWorkflow();

    try {
      const object = new CloudflareFlueDurableObject(
        { storage: doStorage },
        {
          OMA_DB: db,
          OMA_WORKSPACE: new FakeR2Bucket(),
          OMA_PARENT_TOKEN_SECRET_BASE64: TEST_PARENT_TOKEN_SECRET_BASE64,
          OMA_RUN_WORKFLOW: workflow,
          OMA_WORKFLOW_INTERNAL_TOKEN: "secret",
        },
      );

      const created = await object.fetch(new Request("https://oma.example/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          harnessId: "flue",
          model: "test/model",
          instructions: "be useful",
        }),
      }));
      expect(created.status).toBe(200);
      const agent = await created.json() as { agent_id: string };

      const run = await object.fetch(new Request(
        `https://oma.example/v1/agents/${agent.agent_id}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: "hello workflow" }),
        },
      ));
      expect(run.status).toBe(200);
      const body = await run.json() as { session_id: string; run_id: string; status: string };

      expect(body.status).toBe("starting");
      expect(workflow.created).toHaveLength(1);
      expect(workflow.created[0]?.params).toMatchObject({
        runId: body.run_id,
        sessionId: body.session_id,
        agentId: agent.agent_id,
        content: "hello workflow",
        queued: false,
      });
    } finally {
      close();
      doBacking.close();
    }
  });

  it("executes token-protected internal Workflow run requests through the router", async () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();

    try {
      const object = new CloudflareFlueDurableObject(
        { storage: doStorage },
        {
          OMA_DB: db,
          OMA_WORKSPACE: new FakeR2Bucket(),
          OMA_PARENT_TOKEN_SECRET_BASE64: TEST_PARENT_TOKEN_SECRET_BASE64,
          OMA_WORKFLOW_INTERNAL_TOKEN: "secret",
        },
      );

      const response = await object.fetch(new Request(
        `https://oma.example${MANAGED_RUN_INTERNAL_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [MANAGED_RUN_INTERNAL_TOKEN_HEADER]: "secret",
          },
          body: JSON.stringify({
            runId: "run_missing",
            sessionId: "ses_missing",
            agentId: "agt_missing",
            content: "hello",
            queued: false,
          }),
        },
      ));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        status: "skipped",
        reason: "session_not_found",
      });
    } finally {
      close();
      doBacking.close();
    }
  });

  it("rejects internal Workflow run requests without the shared token", async () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();

    try {
      const object = new CloudflareFlueDurableObject(
        { storage: doStorage },
        {
          OMA_DB: db,
          OMA_WORKSPACE: new FakeR2Bucket(),
          OMA_PARENT_TOKEN_SECRET_BASE64: TEST_PARENT_TOKEN_SECRET_BASE64,
          OMA_WORKFLOW_INTERNAL_TOKEN: "secret",
        },
      );

      const response = await object.fetch(new Request(
        `https://oma.example${MANAGED_RUN_INTERNAL_PATH}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            runId: "run_missing",
            sessionId: "ses_missing",
            agentId: "agt_missing",
            content: "hello",
            queued: false,
          }),
        },
      ));

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "forbidden" });
    } finally {
      close();
      doBacking.close();
    }
  });

  it("rejects malformed internal Workflow run payloads", async () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();

    try {
      const object = new CloudflareFlueDurableObject(
        { storage: doStorage },
        {
          OMA_DB: db,
          OMA_WORKSPACE: new FakeR2Bucket(),
          OMA_PARENT_TOKEN_SECRET_BASE64: TEST_PARENT_TOKEN_SECRET_BASE64,
          OMA_WORKFLOW_INTERNAL_TOKEN: "secret",
        },
      );

      const response = await object.fetch(new Request(
        `https://oma.example${MANAGED_RUN_INTERNAL_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [MANAGED_RUN_INTERNAL_TOKEN_HEADER]: "secret",
          },
          body: JSON.stringify({ sessionId: "ses_missing" }),
        },
      ));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_managed_run_request",
      });
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

  it("fails loudly when the metadata D1 binding is missing", () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);

    try {
      const object = new CloudflareFlueDurableObject(
        { storage: doStorage },
        {
          OMA_WORKSPACE: new FakeR2Bucket(),
          OMA_PARENT_TOKEN_SECRET_BASE64: TEST_PARENT_TOKEN_SECRET_BASE64,
        } as CloudflareFlueDurableObjectEnv,
      );

      expect(() => object.fetch(new Request("https://oma.example/healthz")))
        .toThrow(/OMA_DB/);
    } finally {
      doBacking.close();
    }
  });

  it("fails loudly when the parent-token signing secret is missing", () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();

    try {
      const object = new CloudflareFlueDurableObject(
        { storage: doStorage },
        {
          OMA_DB: db,
          OMA_WORKSPACE: new FakeR2Bucket(),
        },
      );

      expect(() => object.fetch(new Request("https://oma.example/healthz")))
        .toThrow(/OMA_PARENT_TOKEN_SECRET_BASE64/);
    } finally {
      close();
      doBacking.close();
    }
  });

  it("fails loudly when Workflow scheduling lacks an internal re-entry token", async () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();

    try {
      const object = new CloudflareFlueDurableObject(
        { storage: doStorage },
        {
          OMA_DB: db,
          OMA_WORKSPACE: new FakeR2Bucket(),
          OMA_PARENT_TOKEN_SECRET_BASE64: TEST_PARENT_TOKEN_SECRET_BASE64,
          OMA_RUN_WORKFLOW: new FakeWorkflow(),
        },
      );

      expect(() => object.fetch(new Request("https://oma.example/healthz")))
        .toThrow(/OMA_WORKFLOW_INTERNAL_TOKEN/);
    } finally {
      close();
      doBacking.close();
    }
  });
});

describe("ConfigurableCloudflareFlueDurableObject", () => {
  it("aborts an active Flue prompt run through the managed run API", async () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();
    const promptStarted = deferred<void>();
    let promptSignal: AbortSignal | undefined;

    try {
      const object = new TestConfigurableFlueObject(
        { storage: doStorage },
        {
          db,
          workspace: new FakeR2Bucket(),
          internalToken: "secret",
          prompt: (args) => {
            promptSignal = args.signal;
            promptStarted.resolve();
            return new Promise<Awaited<ReturnType<FlueEngine["prompt"]>>>((_resolve, reject) => {
              args.signal?.addEventListener("abort", () => reject(args.signal?.reason), {
                once: true,
              });
              if (args.signal?.aborted) {
                reject(args.signal.reason);
                return;
              }
              // Keep the prompt active until the managed abort path fires.
            });
          },
        },
      );

      const created = await object.fetch(new Request("https://oma.example/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          harnessId: "flue",
          model: "test/model",
          instructions: "be useful",
        }),
      }));
      expect(created.status).toBe(200);
      const agent = await created.json() as { agent_id: string };

      const run = await object.fetch(new Request(
        `https://oma.example/v1/agents/${agent.agent_id}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: "keep working" }),
        },
      ));
      expect(run.status).toBe(200);
      const runBody = await run.json() as {
        session_id: string;
        run_id: string;
        status: string;
      };
      expect(runBody.status).toBe("starting");

      await promptStarted.promise;
      const aborted = await object.fetch(new Request(
        `https://oma.example/v1/sessions/${runBody.session_id}/runs/${runBody.run_id}/abort`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "stop active prompt" }),
        },
      ));

      expect(aborted.status).toBe(200);
      await expect(aborted.json()).resolves.toMatchObject({
        session_id: runBody.session_id,
        session_status: "idle",
        aborted: true,
        removed_queued: false,
        run: {
          run_id: runBody.run_id,
          status: "cancelled",
          error: "stop active prompt",
        },
      });
      expect(promptSignal?.aborted).toBe(true);

      const readRun = await object.fetch(new Request(
        `https://oma.example/v1/sessions/${runBody.session_id}/runs/${runBody.run_id}`,
      ));
      await expect(readRun.json()).resolves.toMatchObject({
        run_id: runBody.run_id,
        status: "cancelled",
        error: "stop active prompt",
      });
    } finally {
      close();
      doBacking.close();
    }
  });

  it("aborts a queued Flue run without cancelling the active prompt", async () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();
    const promptStarted = deferred<void>();
    const finishActivePrompt = deferred<Awaited<ReturnType<FlueEngine["prompt"]>>>();
    let promptSignal: AbortSignal | undefined;
    let promptCalls = 0;

    try {
      const object = new TestConfigurableFlueObject(
        { storage: doStorage },
        {
          db,
          workspace: new FakeR2Bucket(),
          internalToken: "secret",
          prompt: (args) => {
            promptCalls += 1;
            promptSignal = args.signal;
            promptStarted.resolve();
            return finishActivePrompt.promise;
          },
        },
      );

      const created = await object.fetch(new Request("https://oma.example/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          harnessId: "flue",
          model: "test/model",
          instructions: "be useful",
        }),
      }));
      expect(created.status).toBe(200);
      const agent = await created.json() as { agent_id: string };

      const run = await object.fetch(new Request(
        `https://oma.example/v1/agents/${agent.agent_id}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: "active work" }),
        },
      ));
      expect(run.status).toBe(200);
      const active = await run.json() as { session_id: string; run_id: string };
      await promptStarted.promise;

      const queued = await object.fetch(new Request(
        `https://oma.example/v1/sessions/${active.session_id}/events`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "user.message", content: "queued work" }),
        },
      ));
      expect(queued.status).toBe(200);
      const queuedBody = await queued.json() as { run_id: string; queued: boolean };
      expect(queuedBody.queued).toBe(true);

      const aborted = await object.fetch(new Request(
        `https://oma.example/v1/sessions/${active.session_id}/runs/${queuedBody.run_id}/abort`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "drop queued work" }),
        },
      ));

      expect(aborted.status).toBe(200);
      await expect(aborted.json()).resolves.toMatchObject({
        session_id: active.session_id,
        aborted: true,
        removed_queued: true,
        run: {
          run_id: queuedBody.run_id,
          status: "cancelled",
          error: "drop queued work",
        },
      });
      expect(promptSignal?.aborted).toBe(false);

      finishActivePrompt.resolve({
        text: "active done",
        usage: { input: 2, output: 3 },
        model: "test/model",
      });
      await waitForSessionHttpToStopRunning(object, active.session_id);

      const runs = await object.fetch(new Request(
        `https://oma.example/v1/sessions/${active.session_id}/runs`,
      ));
      const runsBody = await runs.json() as {
        runs: Array<{ run_id: string; status: string }>;
      };
      expect(runsBody.runs).toEqual(expect.arrayContaining([
        expect.objectContaining({ run_id: active.run_id, status: "succeeded" }),
        expect.objectContaining({ run_id: queuedBody.run_id, status: "cancelled" }),
      ]));
      expect(promptCalls).toBe(1);
    } finally {
      close();
      doBacking.close();
    }
  });

  it("drains queued Flue runs after the active prompt completes", async () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();
    const promptStarted = deferred<void>();
    const finishActivePrompt = deferred<Awaited<ReturnType<FlueEngine["prompt"]>>>();
    let promptCalls = 0;

    try {
      const object = new TestConfigurableFlueObject(
        { storage: doStorage },
        {
          db,
          workspace: new FakeR2Bucket(),
          internalToken: "secret",
          prompt: (args) => {
            promptCalls += 1;
            if (promptCalls === 1) {
              promptStarted.resolve();
              return finishActivePrompt.promise;
            }
            return Promise.resolve({
              text: `queued:${args.content}`,
              usage: { input: 4, output: 6 },
              model: args.model ?? args.agent.model,
            });
          },
        },
      );

      const created = await object.fetch(new Request("https://oma.example/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          harnessId: "flue",
          model: "test/model",
          instructions: "be useful",
        }),
      }));
      expect(created.status).toBe(200);
      const agent = await created.json() as { agent_id: string };

      const run = await object.fetch(new Request(
        `https://oma.example/v1/agents/${agent.agent_id}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: "active work" }),
        },
      ));
      expect(run.status).toBe(200);
      const active = await run.json() as { session_id: string; run_id: string };
      await promptStarted.promise;

      const queued = await object.fetch(new Request(
        `https://oma.example/v1/sessions/${active.session_id}/events`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "user.message", content: "queued work" }),
        },
      ));
      expect(queued.status).toBe(200);
      const queuedBody = await queued.json() as { run_id: string; queued: boolean };
      expect(queuedBody.queued).toBe(true);

      finishActivePrompt.resolve({
        text: "active done",
        usage: { input: 2, output: 3 },
        model: "test/model",
      });
      await waitForSessionTurns(object, active.session_id, 2);

      expect(promptCalls).toBe(2);
      const runs = await object.fetch(new Request(
        `https://oma.example/v1/sessions/${active.session_id}/runs`,
      ));
      await expect(runs.json()).resolves.toMatchObject({
        runs: [
          { run_id: active.run_id, status: "succeeded" },
          { run_id: queuedBody.run_id, status: "succeeded" },
        ],
      });

      const queuedEvents = await object.fetch(new Request(
        `https://oma.example/v1/sessions/${active.session_id}/events?run_id=${queuedBody.run_id}`,
      ));
      await expect(queuedEvents.json()).resolves.toMatchObject({
        count: 2,
        events: [
          { type: "user.message", content: "queued work", run_id: queuedBody.run_id },
          { type: "agent.message", content: "queued:queued work", run_id: queuedBody.run_id },
        ],
      });
    } finally {
      close();
      doBacking.close();
    }
  });

  it("exposes Flue task and operation lineage through run-tree and event filters", async () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();

    try {
      const object = new TestConfigurableFlueObject(
        { storage: doStorage },
        {
          db,
          workspace: new FakeR2Bucket(),
          internalToken: "secret",
          prompt: (args) => Promise.resolve({
            text: "parent done",
            usage: { input: 8, output: 13 },
            model: args.model ?? args.agent.model,
            events: [
              {
                type: "task_start",
                runId: args.runId,
                taskId: "task_review",
                prompt: "inspect the workspace",
                role: "reviewer",
                cwd: "/workspace",
                eventIndex: 0,
              },
              {
                type: "operation_start",
                runId: "task_review",
                operationId: "op_shell",
                operationKind: "shell",
                eventIndex: 1,
              },
              {
                type: "operation",
                runId: "task_review",
                operationId: "op_shell",
                operationKind: "shell",
                result: "tests passed",
                durationMs: 12,
                usage: { input: 5, output: 7, cost: { total: 0.002 } },
                isError: false,
                eventIndex: 2,
              },
              {
                type: "task",
                runId: args.runId,
                taskId: "task_review",
                result: "workspace looks sane",
                durationMs: 42,
                isError: false,
                eventIndex: 3,
              },
            ],
          }),
        },
      );

      const created = await object.fetch(new Request("https://oma.example/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          harnessId: "flue",
          model: "test/model",
          instructions: "be useful",
        }),
      }));
      expect(created.status).toBe(200);
      const agent = await created.json() as { agent_id: string };

      const run = await object.fetch(new Request(
        `https://oma.example/v1/agents/${agent.agent_id}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: "review workspace" }),
        },
      ));
      expect(run.status).toBe(200);
      const runBody = await run.json() as { session_id: string; run_id: string };
      await waitForSessionHttpToStopRunning(object, runBody.session_id);

      const tree = await object.fetch(new Request(
        `https://oma.example/v1/sessions/${runBody.session_id}/run-tree`,
      ));
      expect(tree.status).toBe(200);
      await expect(tree.json()).resolves.toMatchObject({
        session_id: runBody.session_id,
        count: 3,
        runs: [
          {
            run_id: runBody.run_id,
            source: { managed_run: true, event_log: true },
            children: [
              {
                run_id: "task_review",
                parent_run_id: runBody.run_id,
                run_kind: "task",
                status: "completed",
                source: { managed_run: false, event_log: true },
                children: [
                  {
                    run_id: "op_shell",
                    parent_run_id: "task_review",
                    run_kind: "shell",
                    status: "completed",
                    tokens: { input: 5, output: 7 },
                    cost_usd: 0.002,
                    source: { managed_run: false, event_log: true },
                  },
                ],
              },
            ],
          },
        ],
      });

      const taskEvents = await object.fetch(new Request(
        `https://oma.example/v1/sessions/${runBody.session_id}/events?parent_run_id=${runBody.run_id}`,
      ));
      expect(taskEvents.status).toBe(200);
      await expect(taskEvents.json()).resolves.toMatchObject({
        count: 2,
        events: [
          {
            type: "session.run_start",
            run_id: "task_review",
            parent_run_id: runBody.run_id,
            run_kind: "task",
          },
          {
            type: "session.run_end",
            run_id: "task_review",
            parent_run_id: runBody.run_id,
            run_kind: "task",
            run_status: "completed",
          },
        ],
      });

      const operationEvents = await object.fetch(new Request(
        `https://oma.example/v1/sessions/${runBody.session_id}/events?parent_run_id=task_review`,
      ));
      expect(operationEvents.status).toBe(200);
      await expect(operationEvents.json()).resolves.toMatchObject({
        count: 2,
        events: [
          {
            type: "session.run_start",
            run_id: "op_shell",
            parent_run_id: "task_review",
            run_kind: "shell",
          },
          {
            type: "session.run_end",
            run_id: "op_shell",
            parent_run_id: "task_review",
            run_kind: "shell",
            run_status: "completed",
            tokens: { input: 5, output: 7 },
            cost_usd: 0.002,
          },
        ],
      });
    } finally {
      close();
      doBacking.close();
    }
  });

  it("keeps Workflow re-entry available for custom Flue composition", async () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();
    const workflow = new FakeWorkflow();

    try {
      const object = new TestConfigurableFlueObject(
        { storage: doStorage },
        {
          db,
          workspace: new FakeR2Bucket(),
          workflow,
          internalToken: "secret",
        },
      );

      const created = await object.fetch(new Request("https://oma.example/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          harnessId: "flue",
          model: "test/model",
          instructions: "be useful",
        }),
      }));
      expect(created.status).toBe(200);
      const agent = await created.json() as { agent_id: string };

      const run = await object.fetch(new Request(
        `https://oma.example/v1/agents/${agent.agent_id}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: "custom flue run" }),
        },
      ));
      expect(run.status).toBe(200);
      const runBody = await run.json() as {
        session_id: string;
        status: string;
        workflow_id?: string;
      };

      expect(runBody).toMatchObject({
        status: "starting",
      });
      expect(runBody.workflow_id).toBeUndefined();
      expect(workflow.created).toHaveLength(1);

      const internal = await object.fetch(new Request(
        `https://oma.example${MANAGED_RUN_INTERNAL_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [MANAGED_RUN_INTERNAL_TOKEN_HEADER]: "secret",
          },
          body: JSON.stringify(workflow.created[0]?.params),
        },
      ));

      expect(internal.status).toBe(200);
      await expect(internal.json()).resolves.toEqual({ status: "executed" });

      const session = await object.fetch(new Request(
        `https://oma.example/v1/sessions/${runBody.session_id}`,
      ));
      await expect(session.json()).resolves.toMatchObject({
        session_id: runBody.session_id,
        status: "idle",
        turns: 1,
      });

      const events = await object.fetch(new Request(
        `https://oma.example/v1/sessions/${runBody.session_id}/events`,
      ));
      await expect(events.json()).resolves.toMatchObject({
        session_id: runBody.session_id,
        count: 2,
        events: [
          { type: "user.message", content: "custom flue run" },
          { type: "agent.message", content: "custom:custom flue run" },
        ],
      });
    } finally {
      close();
      doBacking.close();
    }
  });

  it("replays sessions, runs, and events after a Durable Object restart", async () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();
    const workspace = new FakeR2Bucket();

    try {
      const firstObject = new TestConfigurableFlueObject(
        { storage: doStorage },
        {
          db,
          workspace,
          internalToken: "secret",
        },
      );

      const created = await firstObject.fetch(new Request("https://oma.example/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          harnessId: "flue",
          model: "test/model",
          instructions: "be useful",
        }),
      }));
      expect(created.status).toBe(200);
      const agent = await created.json() as { agent_id: string };

      const firstRun = await firstObject.fetch(new Request(
        `https://oma.example/v1/agents/${agent.agent_id}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: "before restart" }),
        },
      ));
      expect(firstRun.status).toBe(200);
      const firstRunBody = await firstRun.json() as { session_id: string; run_id: string };
      await waitForSessionHttpToStopRunning(firstObject, firstRunBody.session_id);

      const restartedObject = new TestConfigurableFlueObject(
        { storage: doStorage },
        {
          db,
          workspace,
          internalToken: "secret",
        },
      );

      const replayedSession = await restartedObject.fetch(new Request(
        `https://oma.example/v1/sessions/${firstRunBody.session_id}`,
      ));
      expect(replayedSession.status).toBe(200);
      await expect(replayedSession.json()).resolves.toMatchObject({
        session_id: firstRunBody.session_id,
        status: "idle",
        turns: 1,
      });

      const replayedRuns = await restartedObject.fetch(new Request(
        `https://oma.example/v1/sessions/${firstRunBody.session_id}/runs`,
      ));
      expect(replayedRuns.status).toBe(200);
      await expect(replayedRuns.json()).resolves.toMatchObject({
        runs: [
          { run_id: firstRunBody.run_id, status: "succeeded" },
        ],
      });

      const replayedEvents = await restartedObject.fetch(new Request(
        `https://oma.example/v1/sessions/${firstRunBody.session_id}/events?run_id=${firstRunBody.run_id}`,
      ));
      expect(replayedEvents.status).toBe(200);
      await expect(replayedEvents.json()).resolves.toMatchObject({
        session_id: firstRunBody.session_id,
        count: 2,
        events: [
          { type: "user.message", content: "before restart", run_id: firstRunBody.run_id },
          { type: "agent.message", content: "custom:before restart", run_id: firstRunBody.run_id },
        ],
      });

      const replayedTree = await restartedObject.fetch(new Request(
        `https://oma.example/v1/sessions/${firstRunBody.session_id}/run-tree`,
      ));
      expect(replayedTree.status).toBe(200);
      await expect(replayedTree.json()).resolves.toMatchObject({
        session_id: firstRunBody.session_id,
        count: 1,
        runs: [
          {
            run_id: firstRunBody.run_id,
            source: { managed_run: true, event_log: true },
          },
        ],
      });

      const secondRun = await restartedObject.fetch(new Request(
        `https://oma.example/v1/sessions/${firstRunBody.session_id}/events`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "user.message", content: "after restart" }),
        },
      ));
      expect(secondRun.status).toBe(200);
      const secondRunBody = await secondRun.json() as { run_id: string; queued: boolean };
      expect(secondRunBody.queued).toBe(false);
      await waitForSessionHttpToStopRunning(restartedObject, firstRunBody.session_id);

      const finalSession = await restartedObject.fetch(new Request(
        `https://oma.example/v1/sessions/${firstRunBody.session_id}`,
      ));
      await expect(finalSession.json()).resolves.toMatchObject({
        session_id: firstRunBody.session_id,
        status: "idle",
        turns: 2,
      });

      const finalRuns = await restartedObject.fetch(new Request(
        `https://oma.example/v1/sessions/${firstRunBody.session_id}/runs`,
      ));
      await expect(finalRuns.json()).resolves.toMatchObject({
        runs: [
          { run_id: firstRunBody.run_id, status: "succeeded" },
          { run_id: secondRunBody.run_id, status: "succeeded" },
        ],
      });
    } finally {
      close();
      doBacking.close();
    }
  });

  it("keeps the custom internal re-entry route token-protected", async () => {
    const doBacking = new Database(join(tmpDir, "metadata.db"));
    const doStorage = new FakeDurableObjectStorage(doBacking);
    const { db, close } = sqliteD1();

    try {
      const object = new TestConfigurableFlueObject(
        { storage: doStorage },
        {
          db,
          workspace: new FakeR2Bucket(),
          workflow: new FakeWorkflow(),
          internalToken: "secret",
        },
      );

      const response = await object.fetch(new Request(
        `https://oma.example${MANAGED_RUN_INTERNAL_PATH}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            runId: "run_missing",
            sessionId: "ses_missing",
            agentId: "agt_missing",
            content: "hello",
            queued: false,
          }),
        },
      ));

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "forbidden" });
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
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = store.sessions.get(sessionId)?.status;
    if (status !== "starting" && status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`session ${sessionId} stayed inflight`);
}

async function waitForSessionHttpToStopRunning(
  object: { fetch(request: Request): Response | Promise<Response> },
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await object.fetch(new Request(
      `https://oma.example/v1/sessions/${sessionId}`,
    ));
    const body = await response.json() as { status?: string };
    if (body.status !== "starting" && body.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`session ${sessionId} stayed inflight`);
}

async function waitForSessionTurns(
  object: { fetch(request: Request): Response | Promise<Response> },
  sessionId: string,
  turns: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  let last: unknown;
  while (Date.now() < deadline) {
    const response = await object.fetch(new Request(
      `https://oma.example/v1/sessions/${sessionId}`,
    ));
    const body = await response.json() as { turns?: number; status?: string };
    last = body;
    if (body.turns === turns && body.status !== "starting" && body.status !== "running") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`session ${sessionId} did not reach ${turns} turns; last=${JSON.stringify(last)}`);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function cloudflareTextResponse(text: string): Response {
  return new Response([
    `data: ${JSON.stringify({
      id: "chatcmpl_fake_do_workspace",
      model: "@cf/openai/gpt-oss-20b",
      choices: [{ delta: { content: text }, finish_reason: null }],
    })}`,
    "",
    `data: ${JSON.stringify({
      id: "chatcmpl_fake_do_workspace",
      model: "@cf/openai/gpt-oss-20b",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n"), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function flueHarnessStateRows(
  db: D1DatabaseLike,
  agentId: string,
  sessionId: string,
): Promise<Array<{ state_json: string }>> {
  const result = await db.prepare(`
    SELECT state_json
    FROM managed_harness_state
    WHERE harness_id = ? AND agent_id = ? AND session_id = ?
    ORDER BY state_key
  `).bind("flue", agentId, sessionId).all<{ state_json: string }>();
  return result.results ?? [];
}

function sessionEntryCountFromJson(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = JSON.parse(raw) as { entries?: unknown };
  return Array.isArray(parsed.entries) ? parsed.entries.length : 0;
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

class FakeWorkflow implements CloudflareWorkflowBindingLike {
  readonly created: Array<{ id?: string; params: ManagedRunRequest }> = [];

  create(args: Parameters<CloudflareWorkflowBindingLike["create"]>[0]): { id: string } {
    this.created.push(args);
    return { id: args.id ?? `workflow-${this.created.length}` };
  }
}

type TestConfigurableEnv = {
  db: D1DatabaseLike;
  workspace: R2BucketLike;
  workflow?: CloudflareWorkflowBindingLike;
  internalToken: string;
  prompt?: FlueEngine["prompt"];
};

class TestConfigurableFlueObject
  extends ConfigurableCloudflareFlueDurableObject<TestConfigurableEnv> {
  protected resolveOptions(
    env: TestConfigurableEnv,
  ): Omit<CloudflareFlueDurableObjectHandlerOptions, "state"> {
    return {
      db: env.db,
      r2Bucket: env.workspace,
      flueEngine: {
        prompt: env.prompt ?? (async (args) => ({
          text: `custom:${args.content}`,
          usage: { input: 3, output: 5 },
          model: args.model ?? args.agent.model,
        })),
      },
      runScheduler: env.workflow
        ? new CloudflareWorkflowRunScheduler({ workflow: env.workflow })
        : undefined,
    };
  }

  protected override resolveWorkflowInternalToken(env: TestConfigurableEnv): string | undefined {
    return env.internalToken;
  }
}
