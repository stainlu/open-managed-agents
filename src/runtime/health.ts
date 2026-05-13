import type { RuntimeHealth } from "../orchestrator/server.js";
import type { ContainerRuntimeBackend } from "./factory.js";

export type SelfHostedRuntimeHealthOptions = {
  runtimeBackend: ContainerRuntimeBackend;
  storeBackend: "memory" | "sqlite";
  defaultHarnessId: string;
  limitedNetworking: boolean;
  maxWarmContainers: number;
  maxActiveContainers: number;
};

export function selfHostedRuntimeHealth(
  opts: SelfHostedRuntimeHealthOptions,
): RuntimeHealth {
  return {
    platform: "self-hosted",
    stack: `container-${opts.runtimeBackend}`,
    mode: "container",
    default_harness: opts.defaultHarnessId,
    bindings: {
      metadata: opts.storeBackend === "sqlite",
      event_log: true,
      harness_state: true,
      workspace: true,
      container_runtime: true,
      limited_networking: opts.limitedNetworking,
    },
    features: {
      durable_metadata: opts.storeBackend === "sqlite",
      warm_pool: opts.maxWarmContainers > 0,
      active_pool_limit: opts.maxActiveContainers > 0,
      limited_networking: opts.limitedNetworking,
    },
  };
}
