import type {
  Container,
  NetworkingSpec,
  SpawnOptions,
} from "./container.js";
import type {
  ContainerControlClient,
  ContainerControlPlane,
} from "./control.js";

/**
 * Runtime lease for a managed session.
 *
 * Docker-backed leases are still plain `Container` objects for compatibility.
 * Cloud runtimes do not need to pretend they have a container id, container
 * name, Docker networks, or even an HTTP endpoint. New router code should
 * depend on this lease concept and ask for the specific capability it needs.
 */
export type RuntimeEndpoint = {
  baseUrl: string;
  token: string;
};

export type PlatformRuntimeLease = {
  backend: string;
  sessionId: string;
  harnessId?: string;
  endpoint?: RuntimeEndpoint;
  metadata?: Record<string, unknown>;
};

export type RuntimeLease = Container | PlatformRuntimeLease;

export function runtimeEndpoint(
  lease: RuntimeLease | undefined,
): RuntimeEndpoint | undefined {
  if (!lease) return undefined;
  if ("endpoint" in lease && lease.endpoint) return lease.endpoint;
  if (
    "baseUrl" in lease &&
    "token" in lease &&
    typeof lease.baseUrl === "string" &&
    typeof lease.token === "string"
  ) {
    return { baseUrl: lease.baseUrl, token: lease.token };
  }
  return undefined;
}

export type RuntimeSource = "cold" | "warm" | "limited" | "adopt";

export type AcquireSessionRuntimeArgs = {
  sessionId: string;
  spawnOptions: SpawnOptions;
  controlPlane?: ContainerControlPlane;
  agentId?: string;
  networking?: NetworkingSpec;
  bypassWarmPool?: boolean;
};

export type ActiveSessionRuntimeEntry = {
  spawnedAt: number;
  lastUsedAt: number;
};

export interface ManagedSessionRuntime {
  acquireForSession(args: AcquireSessionRuntimeArgs): Promise<RuntimeLease>;
  warmForAgent(
    agentId: string,
    spawnOptions: SpawnOptions,
    controlPlane?: ContainerControlPlane,
  ): Promise<void>;
  dropWarmForAgent(agentId: string): Promise<void>;
  evictSession(sessionId: string): Promise<void>;
  getControlClient(sessionId: string): ContainerControlClient | undefined;
  /** Legacy Docker/OpenClaw name. Prefer getControlClient in new code. */
  getWsClient?(sessionId: string): ContainerControlClient | undefined;
  getActiveEntry(sessionId: string): ActiveSessionRuntimeEntry | undefined;
  readLogs(
    sessionId: string,
    opts?: { tail?: number },
  ): Promise<string | undefined>;
}
