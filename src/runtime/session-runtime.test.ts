import { describe, expect, it } from "vitest";

import { runtimeEndpoint, type RuntimeLease } from "./session-runtime.js";

describe("runtimeEndpoint", () => {
  it("reads endpoint-backed platform leases without Docker fields", () => {
    const lease: RuntimeLease = {
      backend: "cloudflare",
      sessionId: "ses_1",
      harnessId: "flue",
      endpoint: {
        baseUrl: "https://session.example",
        token: "tok_cloud",
      },
      metadata: {
        durableObject: "internal-only",
      },
    };

    expect(runtimeEndpoint(lease)).toEqual({
      baseUrl: "https://session.example",
      token: "tok_cloud",
    });
  });

  it("preserves legacy Docker container leases", () => {
    expect(runtimeEndpoint({
      id: "cnt_1",
      name: "oma-ses-1",
      baseUrl: "http://container.test",
      token: "tok_docker",
    })).toEqual({
      baseUrl: "http://container.test",
      token: "tok_docker",
    });
  });

  it("returns undefined for platform leases without HTTP endpoints", () => {
    expect(runtimeEndpoint({
      backend: "cloudflare",
      sessionId: "ses_native",
      harnessId: "flue",
      metadata: { invocation: "binding" },
    })).toBeUndefined();
  });
});
