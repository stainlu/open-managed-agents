import { describe, expect, it, vi } from "vitest";

import { HttpClient } from "../http.js";
import { Agents } from "./agents.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Agents workspace files", () => {
  it("lists, reads, writes, and deletes session workspace files", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (
        url === "http://o/v1/agents/agt_1/files?session_id=ses_1&path=src" &&
        init?.method === "GET"
      ) {
        return jsonResponse(200, {
          agent_id: "agt_1",
          path: "src",
          entries: [
            {
              name: "index.ts",
              path: "src/index.ts",
              type: "file",
              size: 12,
              mtime: 1234,
            },
          ],
        });
      }
      if (
        url === "http://o/v1/agents/agt_1/files/src/index.ts?session_id=ses_1" &&
        init?.method === "GET"
      ) {
        return new Response("hello", { status: 200 });
      }
      if (
        url === "http://o/v1/agents/agt_1/files/src/index.ts?session_id=ses_1" &&
        init?.method === "PUT"
      ) {
        expect(init.body).toBe("updated");
        expect((init.headers as Record<string, string>)["content-type"]).toBe("text/plain");
        return jsonResponse(200, {
          agent_id: "agt_1",
          path: "src/index.ts",
          size: 7,
        });
      }
      if (
        url === "http://o/v1/agents/agt_1/files/src/index.ts?session_id=ses_1" &&
        init?.method === "DELETE"
      ) {
        return jsonResponse(200, {
          agent_id: "agt_1",
          path: "src/index.ts",
          deleted: true,
        });
      }
      return jsonResponse(404, { error: "not_found" });
    });
    const http = new HttpClient({ baseUrl: "http://o", timeoutMs: 1000, fetch: fetchFn });
    const agents = new Agents(http);

    const listing = await agents.listFiles("agt_1", { sessionId: "ses_1", path: "src" });
    const content = await agents.readFile("agt_1", "src/index.ts", { sessionId: "ses_1" });
    const written = await agents.writeFile("agt_1", "src/index.ts", "updated", {
      sessionId: "ses_1",
      contentType: "text/plain",
    });
    const deleted = await agents.deleteFile("agt_1", "src/index.ts", { sessionId: "ses_1" });

    expect(listing.entries[0]).toMatchObject({ path: "src/index.ts", type: "file" });
    expect(new TextDecoder().decode(content)).toBe("hello");
    expect(written).toMatchObject({ path: "src/index.ts", size: 7 });
    expect(deleted.deleted).toBe(true);
  });

  it("encodes workspace path segments", async () => {
    const fetchFn = vi.fn(async () => new Response("ok", { status: 200 }));
    const http = new HttpClient({ baseUrl: "http://o", timeoutMs: 1000, fetch: fetchFn });
    const agents = new Agents(http);

    await agents.readFile("agt 1", "notes/a b.txt", { sessionId: "ses 1" });

    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "http://o/v1/agents/agt%201/files/notes/a%20b.txt?session_id=ses%201",
    );
  });
});
