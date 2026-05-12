import { describe, expect, it, vi } from "vitest";

import { HttpClient } from "../http.js";
import { Sessions } from "./sessions.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Sessions", () => {
  it("filters event snapshots by run lineage", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { events: [] }));
    const http = new HttpClient({ baseUrl: "http://o", timeoutMs: 1000, fetch: fetchFn });
    const sessions = new Sessions(http);

    await sessions.events("ses_1", {
      runId: "run_parent",
      parentRunId: "run_root",
    });

    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "http://o/v1/sessions/ses_1/events?run_id=run_parent&parent_run_id=run_root",
    );
  });

  it("filters event streams by run lineage", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const fetchFn = vi.fn(async () => new Response(body, { status: 200 }));
    const http = new HttpClient({ baseUrl: "http://o", timeoutMs: 1000, fetch: fetchFn });
    const sessions = new Sessions(http);

    for await (const _ of sessions.stream("ses_1", { parentRunId: "run_parent" })) {
      // no-op
    }

    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "http://o/v1/sessions/ses_1/events?stream=true&parent_run_id=run_parent",
    );
  });

  it("reads the session run tree", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, {
      session_id: "ses_1",
      count: 1,
      runs: [
        {
          run_id: "run_parent",
          event_count: 0,
          source: { managed_run: true, event_log: false },
          children: [],
        },
      ],
    }));
    const http = new HttpClient({ baseUrl: "http://o", timeoutMs: 1000, fetch: fetchFn });
    const sessions = new Sessions(http);

    const tree = await sessions.runTree("ses_1");

    expect(fetchFn.mock.calls[0]?.[0]).toBe("http://o/v1/sessions/ses_1/run-tree");
    expect(tree).toMatchObject({
      session_id: "ses_1",
      runs: [{ run_id: "run_parent" }],
    });
  });
});
