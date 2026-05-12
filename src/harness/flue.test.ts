import { describe, expect, it, vi } from "vitest";

import type { AgentConfig, Event, Session } from "../orchestrator/types.js";
import { HarnessInvocationError } from "./types.js";
import type { ManagedHarnessStateStore } from "./state-store.js";
import type {
  ManagedWorkspace,
  WorkspaceEntry,
  WorkspaceWriteResult,
} from "../workspace/types.js";
import { WorkspaceError } from "../workspace/types.js";
import {
  deriveFlueProviderConfigFromEnv,
  FlueHarnessAdapter,
  FlueManagedSessionStore,
  mergeFlueProviderConfig,
  type FlueEngine,
} from "./flue.js";

function agent(patch: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agentId: "agt_flue",
    harnessId: "flue",
    model: "anthropic/claude-sonnet-4-6",
    tools: [],
    instructions: "You are concise.",
    permissionPolicy: { type: "always_allow" },
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    version: 1,
    callableAgents: [],
    maxSubagentDepth: 0,
    mcpServers: {},
    thinkingLevel: "medium",
    channels: { telegram: { enabled: false } },
    ...patch,
  };
}

function session(patch: Partial<Session> = {}): Session {
  return {
    sessionId: "ses_flue",
    agentId: "agt_flue",
    harnessId: "flue",
    nativeSessionId: "ses_flue",
    nativeThreadId: null,
    nativeMetadata: null,
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    lastEventAt: null,
    error: null,
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    ephemeral: false,
    environmentId: null,
    vaultId: null,
    parentSessionId: null,
    remainingSubagentDepth: 0,
    userId: null,
    ...patch,
  };
}

describe("FlueHarnessAdapter", () => {
  it("derives Flue provider settings from OMA-managed provider env", () => {
    expect(
      deriveFlueProviderConfigFromEnv({
        ANTHROPIC_API_KEY: "ant",
        OPENAI_API_KEY: "oa",
        MOONSHOT_API_KEY: "moon",
        GEMINI_API_KEY: "gemini",
      }),
    ).toMatchObject({
      anthropic: { apiKey: "ant" },
      openai: { apiKey: "oa" },
      "openai-codex": { apiKey: "oa" },
      moonshotai: { apiKey: "moon" },
      "moonshotai-cn": { apiKey: "moon" },
      google: { apiKey: "gemini" },
    });
  });

  it("lets explicit Flue provider config override derived credentials", () => {
    expect(
      mergeFlueProviderConfig(
        {
          openai: {
            apiKey: "derived",
            headers: { "x-derived": "1" },
          },
        },
        {
          openai: {
            apiKey: "explicit",
            baseUrl: "https://gateway.example.com/openai",
            headers: { "x-explicit": "1" },
          },
          anthropic: {
            apiKey: "ant",
          },
        },
      ),
    ).toEqual({
      openai: {
        apiKey: "explicit",
        baseUrl: "https://gateway.example.com/openai",
        headers: { "x-derived": "1", "x-explicit": "1" },
      },
      anthropic: {
        apiKey: "ant",
      },
    });
  });

  it("registers the Cloudflare AI binding for cloudflare-prefixed Flue models", async () => {
    const run = vi.fn(async () => new Response([
      `data: ${JSON.stringify({
        id: "chatcmpl_fake",
        model: "@cf/openai/gpt-oss-20b",
        choices: [{ delta: { content: "hi" }, finish_reason: null }],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl_fake",
        model: "@cf/openai/gpt-oss-20b",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"), {
      headers: { "content-type": "text/event-stream" },
    }));
    const adapter = new FlueHarnessAdapter({
      cloudflareAiBinding: { run },
      cloudflareAiGateway: { id: "test-gateway" },
    });

    const result = await adapter.invokeTurn({
      content: "hello",
      sessionId: "ses_flue_cf",
      timeoutMs: 60_000,
      agent: agent({ model: "cloudflare/@cf/openai/gpt-oss-20b" }),
    });

    expect(result).toMatchObject({
      output: "hi",
      tokensIn: 3,
      tokensOut: 2,
      model: "@cf/openai/gpt-oss-20b",
    });
    expect(run).toHaveBeenCalledWith(
      "@cf/openai/gpt-oss-20b",
      expect.objectContaining({
        stream: true,
        stream_options: { include_usage: true },
      }),
      expect.objectContaining({
        returnRawResponse: true,
        gateway: { id: "test-gateway" },
      }),
    );
  });

  it("persists real Flue SDK session state through the OMA harness store", async () => {
    const saved = new Map<string, unknown>();
    const loads: Array<Parameters<ManagedHarnessStateStore["load"]>[0]> = [];
    const saves: Array<Parameters<ManagedHarnessStateStore["save"]>[0]> = [];
    const stateStore: ManagedHarnessStateStore = {
      async save(args) {
        saves.push(args);
        saved.set(JSON.stringify({
          harnessId: args.harnessId,
          agentId: args.agentId,
          sessionId: args.sessionId,
          key: args.key,
        }), args.value);
      },
      async load(args) {
        loads.push(args);
        return saved.get(JSON.stringify(args)) ?? null;
      },
      async delete(args) {
        saved.delete(JSON.stringify(args));
      },
      async deleteBySession() {},
    };
    let responseIndex = 0;
    const run = vi.fn(async () => {
      const index = responseIndex++;
      return new Response([
        `data: ${JSON.stringify({
          id: `chatcmpl_fake_${index}`,
          model: "@cf/openai/gpt-oss-20b",
          choices: [{ delta: { content: `hi ${index}` }, finish_reason: null }],
        })}`,
        "",
        `data: ${JSON.stringify({
          id: `chatcmpl_fake_${index}`,
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
    });
    const cfg = agent({ model: "cloudflare-state-test/@cf/openai/gpt-oss-20b" });

    const firstAdapter = new FlueHarnessAdapter({
      cloudflareAiBinding: { run },
      cloudflareAiProviderPrefix: "cloudflare-state-test",
      sessionStateStore: stateStore,
    });
    const first = await firstAdapter.invokeTurn({
      content: "first",
      sessionId: "ses_flue_state",
      timeoutMs: 60_000,
      agent: cfg,
    });
    expect(first.output).toBe("hi 0");
    const firstPersisted = saves.at(-1)?.value;
    expect(sessionEntryCount(firstPersisted)).toBeGreaterThanOrEqual(2);

    const secondAdapter = new FlueHarnessAdapter({
      cloudflareAiBinding: { run },
      cloudflareAiProviderPrefix: "cloudflare-state-test",
      sessionStateStore: stateStore,
    });
    const second = await secondAdapter.invokeTurn({
      content: "second",
      sessionId: "ses_flue_state",
      timeoutMs: 60_000,
      agent: cfg,
    });

    expect(second.output).toBe("hi 1");
    expect(run).toHaveBeenCalledTimes(2);
    expect(loads).toContainEqual(expect.objectContaining({
      harnessId: "flue",
      agentId: "agt_flue",
      sessionId: "ses_flue_state",
    }));
    expect(saves).toContainEqual(expect.objectContaining({
      harnessId: "flue",
      agentId: "agt_flue",
      sessionId: "ses_flue_state",
      key: expect.stringContaining("ses_flue_state"),
    }));
    expect(sessionEntryCount(saves.at(-1)?.value)).toBeGreaterThan(
      sessionEntryCount(firstPersisted),
    );
  });

  it("mounts the OMA managed workspace into the real Flue SDK context", async () => {
    const workspace = new InMemoryManagedWorkspace({
      "AGENTS.md": "Workspace-specific instructions.",
      "README.md": "# Workspace Project",
      ".agents/skills/review/SKILL.md": [
        "---",
        "name: review",
        "description: Review code carefully",
        "---",
        "Review the workspace.",
      ].join("\n"),
    });
    let requestPayload = "";
    const run = vi.fn(async (_model, payload) => {
      requestPayload = JSON.stringify(payload);
      return cloudflareTextResponse("ok");
    });
    const adapter = new FlueHarnessAdapter({
      cloudflareAiBinding: { run },
      cloudflareAiProviderPrefix: "cloudflare-workspace-test",
      workspace,
    });

    await adapter.invokeTurn({
      content: "hello",
      sessionId: "ses_workspace",
      timeoutMs: 60_000,
      agent: agent({
        model: "cloudflare-workspace-test/@cf/openai/gpt-oss-20b",
        instructions: "Fallback OMA instructions.",
      }),
    });

    expect(requestPayload).toContain("Workspace-specific instructions.");
    expect(requestPayload).toContain("README.md");
    expect(requestPayload).toContain("review");
    expect(requestPayload).not.toContain("Fallback OMA instructions.");
    await expect(workspace.readFile("agt_flue", "ses_workspace", "AGENTS.md"))
      .resolves.toEqual(Buffer.from("Workspace-specific instructions."));
  });

  it("seeds OMA instructions into the managed Flue workspace when AGENTS.md is absent", async () => {
    const workspace = new InMemoryManagedWorkspace({
      "README.md": "# Empty Project",
    });
    let requestPayload = "";
    const run = vi.fn(async (_model, payload) => {
      requestPayload = JSON.stringify(payload);
      return cloudflareTextResponse("ok");
    });
    const adapter = new FlueHarnessAdapter({
      cloudflareAiBinding: { run },
      cloudflareAiProviderPrefix: "cloudflare-seeded-workspace-test",
      workspace,
    });

    await adapter.invokeTurn({
      content: "hello",
      sessionId: "ses_seeded_workspace",
      timeoutMs: 60_000,
      agent: agent({
        model: "cloudflare-seeded-workspace-test/@cf/openai/gpt-oss-20b",
        instructions: "OMA managed instructions.",
      }),
    });

    expect(requestPayload).toContain("OMA managed instructions.");
    await expect(workspace.readFile("agt_flue", "ses_seeded_workspace", "AGENTS.md"))
      .resolves.toEqual(Buffer.from("OMA managed instructions."));
  });

  it("runs prompt turns through an injected native Flue engine", async () => {
    const prompt = vi.fn<FlueEngine["prompt"]>(async (args) => ({
      text: `echo: ${args.content}`,
      usage: { input: 11, output: 7, cost: { total: 0.012 } },
      model: { id: args.model ?? args.agent.model },
      events: [
        {
          type: "run_start",
          runId: "run_01",
          kind: "prompt",
          eventIndex: 0,
        },
        {
          type: "thinking_end",
          content: "short plan",
        },
        {
          type: "tool_start",
          toolName: "bash",
          toolCallId: "tool_1",
          args: { command: "pwd" },
        },
        {
          type: "tool_end",
          toolName: "bash",
          toolCallId: "tool_1",
          result: { stdout: "/workspace" },
          isError: false,
        },
        {
          type: "run_end",
          runId: "run_01",
          kind: "prompt",
          status: "completed",
          eventIndex: 3,
        },
      ],
    }));
    const adapter = new FlueHarnessAdapter({ engine: { prompt } });
    const cfg = agent();
    const ses = session();

    const result = await adapter.invokeTurn({
      content: "hello",
      sessionId: ses.sessionId,
      runId: "run_managed_1",
      timeoutMs: 60_000,
      agent: cfg,
      session: ses,
      model: "anthropic/claude-opus-4-7",
      thinkingLevel: "high",
    });

    expect(adapter.runtimeMode).toBe("native");
    expect(prompt).toHaveBeenCalledWith({
      content: "hello",
      sessionId: ses.sessionId,
      runId: "run_managed_1",
      timeoutMs: 60_000,
      signal: expect.any(AbortSignal),
      agent: cfg,
      session: ses,
      model: "anthropic/claude-opus-4-7",
      thinkingLevel: "high",
    });
    expect(result).toMatchObject({
      output: "echo: hello",
      tokensIn: 11,
      tokensOut: 7,
      model: "anthropic/claude-opus-4-7",
    });
    expect(result.native).toMatchObject({
      nativeSessionId: ses.sessionId,
      nativeMetadata: { harness: "flue", runId: "run_managed_1" },
    });
    expect(result.events?.map((event) => event.type)).toEqual([
      "user.message",
      "session.run_start",
      "agent.thinking",
      "agent.tool_use",
      "agent.tool_result",
      "session.run_end",
      "agent.message",
    ]);
    expect(result.events?.find((event) => event.type === "session.run_start")).toMatchObject({
      runId: "run_01",
      runKind: "prompt",
      eventIndex: 0,
    });
    expect(result.events?.find((event) => event.type === "session.run_end")).toMatchObject({
      runId: "run_01",
      runKind: "prompt",
      runStatus: "completed",
      eventIndex: 3,
      isError: false,
    });
    const createdAts = result.events?.map((event) => event.createdAt) ?? [];
    expect(createdAts).toEqual([...createdAts].sort((a, b) => a - b));
    expect(result.events?.at(-1)).toMatchObject({
      type: "agent.message",
      content: "echo: hello",
      runId: "run_managed_1",
      tokensIn: 11,
      tokensOut: 7,
      costUsd: 0.012,
      model: "anthropic/claude-opus-4-7",
    });
  });

  it("maps current Flue task, operation, tool, and compaction events", async () => {
    const adapter = new FlueHarnessAdapter({
      engine: {
        prompt: vi.fn(async () => ({
          text: "done",
          model: "anthropic/claude-sonnet-4-6",
          events: [
            {
              type: "tool_call",
              toolName: "readFile",
              toolCallId: "tool_1",
              result: { ok: true },
              isError: false,
              eventIndex: 0,
            },
            {
              type: "task_start",
              runId: "run_parent",
              taskId: "task_1",
              prompt: "inspect the repo",
              role: "reviewer",
              cwd: "/workspace",
              eventIndex: 1,
            },
            {
              type: "task",
              runId: "run_parent",
              taskId: "task_1",
              result: "repo looks sane",
              durationMs: 42,
              isError: false,
              eventIndex: 2,
            },
            {
              type: "operation_start",
              runId: "run_parent",
              operationId: "op_shell_1",
              operationKind: "shell",
              eventIndex: 3,
            },
            {
              type: "operation",
              runId: "run_parent",
              operationId: "op_shell_1",
              operationKind: "shell",
              durationMs: 12,
              usage: { input: 5, output: 7, cost: { total: 0.002 } },
              isError: false,
              eventIndex: 4,
            },
            {
              type: "compaction",
              messagesBefore: 14,
              messagesAfter: 6,
              durationMs: 9,
              eventIndex: 5,
            },
          ],
        })),
      },
    });

    const result = await adapter.invokeTurn({
      content: "go",
      sessionId: "ses_flue",
      runId: "run_parent",
      timeoutMs: 60_000,
      agent: agent(),
    });

    expect(result.events?.map((event) => event.type)).toEqual([
      "user.message",
      "agent.tool_result",
      "session.run_start",
      "session.run_end",
      "session.run_start",
      "session.run_end",
      "session.compaction",
      "agent.message",
    ]);
    expect(result.events?.find((event) => event.toolCallId === "tool_1")).toMatchObject({
      type: "agent.tool_result",
      content: JSON.stringify({ ok: true }),
      isError: false,
      runId: "run_parent",
      eventIndex: 0,
    });
    expect(result.events?.find((event) => event.runId === "task_1" && event.type === "session.run_start"))
      .toMatchObject({
        runKind: "task",
        parentRunId: "run_parent",
        eventIndex: 1,
        content: expect.stringContaining("inspect the repo"),
      });
    expect(result.events?.find((event) => event.runId === "task_1" && event.type === "session.run_end"))
      .toMatchObject({
        runKind: "task",
        runStatus: "completed",
        parentRunId: "run_parent",
        eventIndex: 2,
        isError: false,
        content: expect.stringContaining("repo looks sane"),
      });
    expect(result.events?.find((event) => event.runId === "op_shell_1" && event.type === "session.run_end"))
      .toMatchObject({
        runKind: "shell",
        runStatus: "completed",
        parentRunId: "run_parent",
        eventIndex: 4,
        tokensIn: 5,
        tokensOut: 7,
        costUsd: 0.002,
      });
    expect(result.events?.find((event) => event.type === "session.compaction")).toMatchObject({
      content: "Flue compaction ended (before=14, after=6, durationMs=9)",
      eventIndex: 5,
    });
  });

  it("fails loudly instead of silently ignoring OMA agent.tools", async () => {
    const adapter = new FlueHarnessAdapter({
      engine: {
        prompt: vi.fn(async () => ({ text: "unused" })),
      },
    });

    await expect(
      adapter.invokeTurn({
        content: "hello",
        sessionId: "ses_flue",
        timeoutMs: 60_000,
        agent: agent({ tools: ["calculator"] }),
      }),
    ).rejects.toThrow(HarnessInvocationError);
  });

  it("aborts active prompt turns through AbortSignal", async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let signal: AbortSignal | undefined;
    const adapter = new FlueHarnessAdapter({
      engine: {
        prompt: vi.fn((args) => {
          signal = args.signal;
          resolveStarted();
          return new Promise<never>((_resolve, reject) => {
            if (!signal) {
              reject(new Error("missing signal"));
              return;
            }
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener("abort", () => reject(signal?.reason), {
              once: true,
            });
          });
        }),
      },
    });

    const turn = adapter.invokeTurn({
      content: "hello",
      sessionId: "ses_flue",
      timeoutMs: 60_000,
      agent: agent(),
    });
    await started;

    await adapter.abortSession(undefined, "ses_flue");

    expect(signal?.aborted).toBe(true);
    await expect(turn).rejects.toThrow("OMA cancelled Flue session ses_flue");
  });

  it("remembers cancellation that arrives before the prompt handle starts", async () => {
    const adapter = new FlueHarnessAdapter({
      engine: {
        prompt: vi.fn((args) => {
          if (args.signal?.aborted) {
            return Promise.reject(args.signal.reason);
          }
          return Promise.resolve({ text: "unused" });
        }),
      },
    });

    await adapter.abortSession(undefined, "ses_flue");

    await expect(
      adapter.invokeTurn({
        content: "hello",
        sessionId: "ses_flue",
        timeoutMs: 60_000,
        agent: agent(),
      }),
    ).rejects.toThrow("OMA cancelled Flue session ses_flue");
  });

  it("streams prompt chunks through an injected native Flue engine", async () => {
    async function* chunks(): AsyncGenerator<string, void, void> {
      yield JSON.stringify({
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
      });
      yield "[DONE]";
    }
    async function* liveEvents(): AsyncGenerator<Event, void, void> {
      yield {
        eventId: "evt_live_user",
        sessionId: "ses_flue",
        type: "user.message",
        content: "hello",
        createdAt: 1,
      };
    }
    const abort = vi.fn(async () => {});
    const result = {
      output: "hi",
      tokensIn: 3,
      tokensOut: 2,
      model: "anthropic/claude-sonnet-4-6",
    };
    const adapter = new FlueHarnessAdapter({
      engine: {
        prompt: vi.fn(async () => ({ text: "unused" })),
        stream: vi.fn(async () => ({
          chunks: chunks(),
          liveEvents: liveEvents(),
          result,
          abort,
        })),
      },
    });

    expect(adapter.capabilities.streaming.support).toBe("partial");
    expect(adapter.capabilities.cancellation.support).toBe("partial");
    const stream = await adapter.invokeStreamingTurn({
      content: "hello",
      sessionId: "ses_flue",
      timeoutMs: 60_000,
      agent: agent(),
    });

    const streamed: string[] = [];
    for await (const chunk of stream.chunks) streamed.push(chunk);
    const events = [];
    for await (const event of stream.liveEvents ?? (async function* () {})()) {
      events.push(event);
    }

    expect(streamed.at(-1)).toBe("[DONE]");
    expect(events).toHaveLength(1);
    expect(stream.result).toBe(result);
  });

  it("fails loudly when an injected Flue engine does not expose streaming", async () => {
    const adapter = new FlueHarnessAdapter({
      engine: {
        prompt: vi.fn(async () => ({ text: "unused" })),
      },
    });

    await expect(
      adapter.invokeStreamingTurn({
        content: "hello",
        sessionId: "ses_flue",
        timeoutMs: 60_000,
        agent: agent(),
      }),
    ).rejects.toThrow("Flue engine does not expose streaming prompt calls");
  });
});

describe("FlueManagedSessionStore", () => {
  it("scopes Flue storage keys under the OMA managed session", async () => {
    const saved = new Map<string, unknown>();
    const stateStore: ManagedHarnessStateStore = {
      async save(args) {
        saved.set(JSON.stringify({
          harnessId: args.harnessId,
          agentId: args.agentId,
          sessionId: args.sessionId,
          key: args.key,
        }), args.value);
      },
      async load(args) {
        return saved.get(JSON.stringify(args)) ?? null;
      },
      async delete(args) {
        saved.delete(JSON.stringify(args));
      },
      async deleteBySession() {},
    };
    const store = new FlueManagedSessionStore(stateStore, "agt_1", "ses_1");

    await store.save("agent:agt_1:task:ses_1:t1", { version: 2 });

    await expect(store.load("agent:agt_1:task:ses_1:t1")).resolves.toEqual({
      version: 2,
    });
    await store.delete("agent:agt_1:task:ses_1:t1");
    await expect(store.load("agent:agt_1:task:ses_1:t1")).resolves.toBeNull();
  });
});

function sessionEntryCount(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const entries = (value as { entries?: unknown }).entries;
  return Array.isArray(entries) ? entries.length : 0;
}

function cloudflareTextResponse(text: string): Response {
  return new Response([
    `data: ${JSON.stringify({
      id: "chatcmpl_fake_workspace",
      model: "@cf/openai/gpt-oss-20b",
      choices: [{ delta: { content: text }, finish_reason: null }],
    })}`,
    "",
    `data: ${JSON.stringify({
      id: "chatcmpl_fake_workspace",
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

class InMemoryManagedWorkspace implements ManagedWorkspace {
  private readonly files = new Map<string, Buffer>();

  constructor(files: Record<string, string | Buffer> = {}) {
    for (const [path, content] of Object.entries(files)) {
      this.files.set(normalizeWorkspacePath(path, { allowRoot: false }), Buffer.from(content));
    }
  }

  async listFiles(
    _agentId: string,
    _sessionId: string,
    relPath = "",
  ): Promise<WorkspaceEntry[]> {
    const root = normalizeWorkspacePath(relPath, { allowRoot: true });
    const prefix = root ? `${root}/` : "";
    const exact = this.files.get(root);
    if (exact && root) {
      throw new WorkspaceError("invalid_path", `not a directory: ${root}`);
    }

    const entries = new Map<string, WorkspaceEntry>();
    for (const [filePath, content] of this.files.entries()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (!rest) continue;
      const [name, ...nested] = rest.split("/");
      if (!name) continue;
      const path = root ? `${root}/${name}` : name;
      if (nested.length > 0) {
        entries.set(name, {
          name,
          path,
          type: "dir",
          size: 0,
          mtime: 1,
        });
        continue;
      }
      if (!entries.has(name)) {
        entries.set(name, {
          name,
          path,
          type: "file",
          size: content.byteLength,
          mtime: 1,
        });
      }
    }
    if (entries.size === 0 && root) {
      throw new WorkspaceError("file_not_found", `workspace path not found: ${root}`);
    }
    return [...entries.values()].sort((a, b) => (
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
    ));
  }

  async readFile(
    _agentId: string,
    _sessionId: string,
    relPath: string,
    opts: { maxBytes?: number } = {},
  ): Promise<Buffer> {
    const normalized = normalizeWorkspacePath(relPath, { allowRoot: false });
    const content = this.files.get(normalized);
    if (!content) throw new WorkspaceError("file_not_found", `file not found: ${normalized}`);
    const maxBytes = opts.maxBytes ?? content.byteLength;
    return content.subarray(0, maxBytes);
  }

  async writeFile(
    _agentId: string,
    _sessionId: string,
    relPath: string,
    content: Buffer,
  ): Promise<WorkspaceWriteResult> {
    const normalized = normalizeWorkspacePath(relPath, { allowRoot: false });
    this.files.set(normalized, Buffer.from(content));
    return { path: normalized, size: content.byteLength };
  }

  async deleteFile(_agentId: string, _sessionId: string, relPath: string): Promise<void> {
    const normalized = normalizeWorkspacePath(relPath, { allowRoot: false });
    if (!this.files.delete(normalized)) {
      throw new WorkspaceError("file_not_found", `file not found: ${normalized}`);
    }
  }
}

function normalizeWorkspacePath(
  path: string,
  opts: { allowRoot: boolean },
): string {
  const parts = path
    .replace(/^\/+/, "")
    .split(/[\\/]+/)
    .filter((part) => part && part !== ".");
  for (const part of parts) {
    if (part === ".." || part.includes("\0")) {
      throw new WorkspaceError("invalid_path", "invalid workspace path");
    }
  }
  const normalized = parts.join("/");
  if (!opts.allowRoot && !normalized) {
    throw new WorkspaceError("invalid_path", "refusing workspace root");
  }
  return normalized;
}
