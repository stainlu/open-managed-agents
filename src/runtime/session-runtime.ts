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
 * Today this is backed by a Docker container, so it is structurally identical
 * to `Container`. The name is intentionally broader: Cloudflare-native
 * execution will not necessarily have a process/container id, DNS name, or
 * bearer-token HTTP endpoint. Keep new router code depending on the lease
 * concept rather than Docker-specific fields whenever possible.
 */
export type RuntimeLease = Container;

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
