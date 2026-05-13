import { describe, expect, it, vi } from "vitest";

import { HttpClient } from "../http.js";
import { Chat } from "./chat.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Chat completions", () => {
  it("creates OpenAI-compatible blocking completions with agent/session headers", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-openclaw-agent-id"]).toBe("agt_123");
      expect(headers["x-openclaw-session-key"]).toBe("thread_123");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "ignored-by-oma",
        messages: [{ role: "user", content: "hi" }],
        user: "thread_from_body",
        temperature: 0.2,
        stream: false,
      });
      return jsonResponse(200, {
        id: "chatcmpl_evt_123",
        object: "chat.completion",
        created: 123,
        model: "openai/gpt-5.5",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });
    });
    const http = new HttpClient({ baseUrl: "http://o", timeoutMs: 1000, fetch: fetchFn });
    const chat = new Chat(http);

    const result = await chat.completions.create({
      agentId: "agt_123",
      sessionKey: "thread_123",
      model: "ignored-by-oma",
      messages: [{ role: "user", content: "hi" }],
      user: "thread_from_body",
      temperature: 0.2,
    });

    expect(fetchFn.mock.calls[0]?.[0]).toBe("http://o/v1/chat/completions");
    expect(result.choices[0]?.message.content).toBe("hello");
    expect(result.usage.total_tokens).toBe(3);
  });

  it("streams OpenAI-compatible chunks until DONE", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.accept).toBe("text/event-stream");
      expect(headers["x-openclaw-agent-id"]).toBe("agt_123");
      expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true });
      return new Response(
        [
          'data: {"id":"chunk_1","choices":[{"index":0,"delta":{"content":"he"}}]}',
          "",
          'data: {"id":"chunk_2","choices":[{"index":0,"delta":{"content":"llo"}}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const http = new HttpClient({ baseUrl: "http://o", timeoutMs: 1000, fetch: fetchFn });
    const chat = new Chat(http);

    const chunks = [];
    for await (const chunk of chat.completions.stream({
      agentId: "agt_123",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.id)).toEqual(["chunk_1", "chunk_2"]);
  });
});
