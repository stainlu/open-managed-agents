import { describe, expect, it, vi } from "vitest";

import { HttpClient } from "../http.js";
import { Runtime } from "./runtime.js";

describe("Runtime", () => {
  it("fetches the managed runtime substrate profile", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          runtime: {
            platform: "cloudflare",
            stack: "cloudflare-flue",
            mode: "native",
            default_harness: "flue",
            bindings: {
              metadata: true,
              database: true,
              workspace: true,
            },
            features: {
              workflow_runs: true,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const http = new HttpClient({ baseUrl: "http://o", timeoutMs: 1000, fetch: fetchFn });
    const runtime = new Runtime(http);

    await expect(runtime.profile()).resolves.toMatchObject({
      runtime: {
        platform: "cloudflare",
        stack: "cloudflare-flue",
        mode: "native",
        default_harness: "flue",
        bindings: {
          workspace: true,
        },
      },
    });
    expect(fetchFn.mock.calls.map((call) => call[0])).toEqual([
      "http://o/v1/runtime",
    ]);
  });
});
