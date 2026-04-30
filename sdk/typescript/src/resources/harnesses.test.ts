import { describe, expect, it, vi } from "vitest";

import { HttpClient } from "../http.js";
import { Harnesses } from "./harnesses.js";

describe("Harnesses", () => {
  it("fetches the harness catalog and exposes the list", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          default_harness_id: "openclaw",
          count: 2,
          harnesses: [
            {
              harness_id: "openclaw",
              name: "OpenClaw",
              capabilities: {
                start_turn: { support: "supported", detail: "native OpenAI-compatible turn API" },
                streaming: { support: "supported", detail: "native SSE" },
                native_session_resume: { support: "supported", detail: "Pi JSONL resume" },
                cancellation: { support: "supported", detail: "gateway abort" },
                interruption: { support: "supported", detail: "gateway steer" },
                dynamic_model_patch: { support: "supported", detail: "gateway patch" },
                compaction: { support: "supported", detail: "gateway compact" },
                tool_approvals: { support: "supported", detail: "confirm-tools plugin" },
                permission_deny: { support: "supported", detail: "OpenClaw tools.deny" },
                mcp: { support: "supported", detail: "openclaw.json mcp.servers" },
                managed_event_log: { support: "supported", detail: "Pi JSONL reader" },
                usage: { support: "supported", detail: "provider usage" },
                subagents: { support: "supported", detail: "openclaw-call-agent" },
              },
            },
            {
              harness_id: "hermes",
              name: "Hermes",
              capabilities: {
                start_turn: { support: "supported", detail: "adapter server turn API" },
                streaming: { support: "supported", detail: "adapter server SSE" },
                native_session_resume: { support: "supported", detail: "Hermes SessionDB" },
                cancellation: { support: "supported", detail: "Hermes interrupt" },
                interruption: { support: "supported", detail: "Hermes interrupt" },
                dynamic_model_patch: { support: "supported", detail: "adapter config" },
                compaction: { support: "unsupported", detail: "not wired" },
                tool_approvals: { support: "partial", detail: "terminal approval only" },
                permission_deny: { support: "partial", detail: "disabled toolsets" },
                mcp: { support: "unsupported", detail: "not wired" },
                managed_event_log: { support: "supported", detail: "adapter JSONL" },
                usage: { support: "partial", detail: "when native result has usage" },
                subagents: { support: "unsupported", detail: "not injected" },
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const http = new HttpClient({ baseUrl: "http://o", timeoutMs: 1000, fetch: fetchFn });
    const harnesses = new Harnesses(http);

    await expect(harnesses.catalog()).resolves.toMatchObject({
      default_harness_id: "openclaw",
      count: 2,
    });
    await expect(harnesses.list()).resolves.toHaveLength(2);
    expect(fetchFn.mock.calls.map((call) => call[0])).toEqual([
      "http://o/v1/harnesses",
      "http://o/v1/harnesses",
    ]);
  });
});
