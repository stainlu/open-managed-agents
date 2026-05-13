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

  it("lists and resolves pending approvals", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/sessions/ses_1/approvals") && init?.method === "GET") {
        return jsonResponse(200, {
          approvals: [
            {
              approval_id: "appr_1",
              session_id: "ses_1",
              tool_name: "bash",
              description: "approve bash",
              arrived_at: 1234,
            },
          ],
        });
      }
      if (url.endsWith("/v1/sessions/ses_1/approvals/appr_1") && init?.method === "POST") {
        return jsonResponse(200, {
          session_id: "ses_1",
          approval_id: "appr_1",
          decision: "allow",
          resolved: true,
        });
      }
      return jsonResponse(404, { error: "not_found" });
    });
    const http = new HttpClient({ baseUrl: "http://o", timeoutMs: 1000, fetch: fetchFn });
    const sessions = new Sessions(http);

    const approvals = await sessions.approvals("ses_1");
    const resolved = await sessions.resolveApproval("ses_1", "appr_1", {
      decision: "allow",
    });

    expect(approvals).toEqual([
      {
        approval_id: "appr_1",
        session_id: "ses_1",
        tool_name: "bash",
        description: "approve bash",
        arrived_at: 1234,
      },
    ]);
    expect(resolved).toEqual({
      session_id: "ses_1",
      approval_id: "appr_1",
      decision: "allow",
      resolved: true,
    });
    expect(fetchFn.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ decision: "allow" }));
  });

  it("lists, reads, and aborts managed runs", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/sessions/ses_1/runs") && init?.method === "GET") {
        return jsonResponse(200, {
          runs: [
            {
              run_id: "run_1",
              session_id: "ses_1",
              agent_id: "agt_1",
              status: "running",
              queued: false,
              model: "openai/gpt-5.5",
              thinking_level: "high",
              error: null,
              created_at: 1234,
              started_at: 1235,
              completed_at: null,
            },
          ],
        });
      }
      if (url.endsWith("/v1/sessions/ses_1/runs/run_1") && init?.method === "GET") {
        return jsonResponse(200, {
          run_id: "run_1",
          session_id: "ses_1",
          agent_id: "agt_1",
          status: "running",
          queued: false,
          error: null,
          created_at: 1234,
          started_at: 1235,
          completed_at: null,
        });
      }
      if (url.endsWith("/v1/sessions/ses_1/runs/run_1/abort") && init?.method === "POST") {
        return jsonResponse(200, {
          session_id: "ses_1",
          session_status: "idle",
          aborted: true,
          removed_queued: false,
          run: {
            run_id: "run_1",
            session_id: "ses_1",
            agent_id: "agt_1",
            status: "cancelled",
            queued: false,
            error: "user changed direction",
            created_at: 1234,
            started_at: 1235,
            completed_at: 1240,
          },
        });
      }
      return jsonResponse(404, { error: "not_found" });
    });
    const http = new HttpClient({ baseUrl: "http://o", timeoutMs: 1000, fetch: fetchFn });
    const sessions = new Sessions(http);

    const runs = await sessions.runs("ses_1");
    const run = await sessions.run("ses_1", "run_1");
    const aborted = await sessions.abortRun("ses_1", "run_1", {
      reason: "user changed direction",
    });

    expect(runs[0]).toMatchObject({ run_id: "run_1", status: "running" });
    expect(run).toMatchObject({ run_id: "run_1", status: "running" });
    expect(aborted).toMatchObject({
      session_id: "ses_1",
      aborted: true,
      run: { run_id: "run_1", status: "cancelled" },
    });
    expect(fetchFn.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({ reason: "user changed direction" }),
    );
  });
});
