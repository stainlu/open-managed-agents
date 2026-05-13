import { describe, expect, it, vi } from "vitest";

import { HttpClient } from "../http.js";
import { Audit } from "./audit.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Audit", () => {
  it("queries audit events with filters and exposes list convenience", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (
        url ===
          "http://o/v1/audit?since=10&until=20&action=session.create&target=ses_123&limit=5" &&
        init?.method === "GET"
      ) {
        return jsonResponse(200, {
          events: [
            {
              id: 1,
              ts: 12,
              request_id: "req_123",
              actor: "token:abcdef12",
              action: "session.create",
              target: "ses_123",
              outcome: "ok",
              metadata: { agent_id: "agt_123" },
            },
          ],
          count: 1,
        });
      }
      if (url === "http://o/v1/audit?action=agent.delete" && init?.method === "GET") {
        return jsonResponse(200, {
          events: [
            {
              id: 2,
              ts: 30,
              request_id: null,
              actor: "anonymous",
              action: "agent.delete",
              target: "agt_123",
              outcome: "ok",
              metadata: null,
            },
          ],
          count: 1,
        });
      }
      return jsonResponse(404, { error: "not_found" });
    });
    const http = new HttpClient({ baseUrl: "http://o", timeoutMs: 1000, fetch: fetchFn });
    const audit = new Audit(http);

    const result = await audit.query({
      since: 10,
      until: 20,
      action: "session.create",
      target: "ses_123",
      limit: 5,
    });
    const events = await audit.list({ action: "agent.delete" });

    expect(result.count).toBe(1);
    expect(result.events[0]).toMatchObject({
      actor: "token:abcdef12",
      action: "session.create",
      metadata: { agent_id: "agt_123" },
    });
    expect(events[0]).toMatchObject({ action: "agent.delete", target: "agt_123" });
  });
});
