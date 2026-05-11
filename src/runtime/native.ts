import type { SpawnOptions } from "./container.js";
import type { ContainerControlClient, ContainerControlPlane } from "./control.js";
import type {
  AcquireSessionRuntimeArgs,
  ActiveSessionRuntimeEntry,
  ManagedSessionRuntime,
  RuntimeLease,
} from "./session-runtime.js";

export class NativeRuntimeAcquireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeRuntimeAcquireError";
  }
}

/**
 * Runtime implementation for native harness stacks.
 *
 * Native harnesses execute through platform bindings, in-process SDKs, Durable
 * Object stubs, or other non-container mechanisms. They should not acquire a
 * Docker-style runtime endpoint. Keeping this as a real runtime object avoids
 * smuggling Docker assumptions into Cloudflare-oriented composition roots while
 * still failing loudly if a container harness is accidentally registered.
 */
export class NativeOnlySessionRuntime implements ManagedSessionRuntime {
  async acquireForSession(args: AcquireSessionRuntimeArgs): Promise<RuntimeLease> {
    throw new NativeRuntimeAcquireError(
      `native-only runtime cannot acquire an endpoint for session ${args.sessionId}; ` +
        "register only native harnesses or configure a container runtime",
    );
  }

  async warmForAgent(
    _agentId: string,
    _spawnOptions: SpawnOptions,
    _controlPlane?: ContainerControlPlane,
  ): Promise<void> {
    // Native harnesses do not have template-level containers to pre-warm.
  }

  async dropWarmForAgent(_agentId: string): Promise<void> {
    // No warm container state exists in native-only mode.
  }

  async evictSession(_sessionId: string): Promise<void> {
    // Native runtimes own cancellation through their harness adapter, not via
    // container eviction. Session state cleanup stays in the managed layer.
  }

  getControlClient(_sessionId: string): ContainerControlClient | undefined {
    return undefined;
  }

  getActiveEntry(_sessionId: string): ActiveSessionRuntimeEntry | undefined {
    return undefined;
  }

  async readLogs(
    _sessionId: string,
    _opts?: { tail?: number },
  ): Promise<string | undefined> {
    return undefined;
  }
}
