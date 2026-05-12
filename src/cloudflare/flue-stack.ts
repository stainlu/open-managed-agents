import {
  D1ManagedEventLog,
  type D1DatabaseLike,
  type D1ManagedEventLogOptions,
} from "../events/d1.js";
import type { ManagedEventLog } from "../events/types.js";
import {
  FlueHarnessAdapter,
  type FlueEngine,
  type FlueProviderConfig,
} from "../harness/flue.js";
import { HarnessRegistry } from "../harness/registry.js";
import {
  D1ManagedHarnessStateStore,
  type D1ManagedHarnessStateStoreOptions,
  type ManagedHarnessStateStore,
} from "../harness/state-store.js";
import type { HarnessAdapter } from "../harness/types.js";
import { AgentRouter, type RouterConfig } from "../orchestrator/router.js";
import { NativeOnlySessionRuntime } from "../runtime/native.js";
import type { ManagedRunScheduler } from "../runtime/run-scheduler.js";
import type { ManagedSessionRuntime } from "../runtime/session-runtime.js";
import type { Store } from "../store/types.js";
import {
  R2ManagedWorkspace,
  type R2BucketLike,
  type R2ManagedWorkspaceOptions,
} from "../workspace/r2.js";
import type { ManagedWorkspace } from "../workspace/types.js";

export type CloudflareFlueStackOptions = {
  db: D1DatabaseLike;
  store: Store;
  workspace?: ManagedWorkspace;
  r2Bucket?: R2BucketLike;
  workspaceOptions?: R2ManagedWorkspaceOptions;
  passthroughEnv?: Record<string, string>;
  flueProviderConfig?: FlueProviderConfig;
  runTimeoutMs?: number;
  eventLog?: ManagedEventLog;
  eventLogOptions?: D1ManagedEventLogOptions;
  harnessState?: ManagedHarnessStateStore;
  harnessStateOptions?: D1ManagedHarnessStateStoreOptions;
  flueEngine?: FlueEngine;
  loadFlueEngine?: () => Promise<FlueEngine>;
  runtime?: ManagedSessionRuntime;
  runScheduler?: ManagedRunScheduler;
};

export type CloudflareFlueStack = {
  router: AgentRouter;
  store: Store;
  events: ManagedEventLog;
  harnessState: ManagedHarnessStateStore;
  runtime: ManagedSessionRuntime;
  workspace: ManagedWorkspace;
  harnesses: HarnessRegistry;
  flueHarness: HarnessAdapter;
  routerConfig: RouterConfig;
};

/**
 * Cloudflare-oriented OMA composition for native Flue sessions.
 *
 * This is intentionally a router/dependency factory, not a production Worker
 * entrypoint. The Cloudflare-specific metadata store, workspace backend, and
 * HTTP handler ownership still belong to the deployment layer. This factory
 * wires the pieces OMA already owns today: D1-compatible event/state stores,
 * native Flue harness invocation, and a native-only runtime that does not fake
 * Docker container behavior.
 */
export function createCloudflareFlueStack(
  opts: CloudflareFlueStackOptions,
): CloudflareFlueStack {
  const passthroughEnv = opts.passthroughEnv ?? {};
  const events = opts.eventLog ?? new D1ManagedEventLog(opts.db, opts.eventLogOptions);
  const harnessState = opts.harnessState ??
    new D1ManagedHarnessStateStore(opts.db, opts.harnessStateOptions);
  const runtime = opts.runtime ?? new NativeOnlySessionRuntime();
  const workspace = opts.workspace ??
    (opts.r2Bucket ? new R2ManagedWorkspace(opts.r2Bucket, opts.workspaceOptions) : undefined);
  if (!workspace) {
    throw new Error("Cloudflare Flue stack requires workspace or r2Bucket");
  }
  const flueHarness = new FlueHarnessAdapter({
    passthroughEnv,
    providerConfig: opts.flueProviderConfig,
    sessionStateStore: harnessState,
    engine: opts.flueEngine,
    loadEngine: opts.loadFlueEngine,
  });
  const harnesses = new HarnessRegistry({
    adapters: [flueHarness],
    defaultId: "flue",
  });
  const routerConfig: RouterConfig = {
    passthroughEnv,
    runTimeoutMs: opts.runTimeoutMs ?? 10 * 60_000,
    harnesses,
    runScheduler: opts.runScheduler,
  };
  const router = new AgentRouter(
    opts.store.agents,
    opts.store.environments,
    opts.store.sessions,
    events,
    workspace,
    runtime,
    opts.store.queue,
    opts.store.vaults,
    routerConfig,
  );
  return {
    router,
    store: opts.store,
    events,
    harnessState,
    runtime,
    workspace,
    harnesses,
    flueHarness,
    routerConfig,
  };
}
