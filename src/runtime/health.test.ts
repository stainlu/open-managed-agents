import { describe, expect, it } from "vitest";

import { selfHostedRuntimeHealth } from "./health.js";

describe("selfHostedRuntimeHealth", () => {
  it("reports the default container runtime without leaking platform ids", () => {
    const health = selfHostedRuntimeHealth({
      runtimeBackend: "docker",
      storeBackend: "sqlite",
      defaultHarnessId: "openclaw",
      limitedNetworking: false,
      maxWarmContainers: 0,
      maxActiveContainers: 5,
    });

    expect(health).toEqual({
      platform: "self-hosted",
      stack: "container-docker",
      mode: "container",
      default_harness: "openclaw",
      bindings: {
        metadata: true,
        event_log: true,
        harness_state: true,
        workspace: true,
        container_runtime: true,
        limited_networking: false,
      },
      features: {
        durable_metadata: true,
        warm_pool: false,
        active_pool_limit: true,
        limited_networking: false,
      },
    });
  });

  it("marks non-durable memory metadata and enabled runtime features explicitly", () => {
    const health = selfHostedRuntimeHealth({
      runtimeBackend: "docker",
      storeBackend: "memory",
      defaultHarnessId: "codex",
      limitedNetworking: true,
      maxWarmContainers: 3,
      maxActiveContainers: 0,
    });

    expect(health.bindings).toMatchObject({
      metadata: false,
      limited_networking: true,
    });
    expect(health.features).toMatchObject({
      durable_metadata: false,
      warm_pool: true,
      active_pool_limit: false,
      limited_networking: true,
    });
  });
});
