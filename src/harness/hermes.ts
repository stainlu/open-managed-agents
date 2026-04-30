import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Mount, SpawnOptions } from "../runtime/container.js";
import type { EnvironmentStore } from "../store/types.js";
import type { AgentConfig, Session } from "../orchestrator/types.js";
import { AdapterServerListApprovalsResponseSchema } from "./adapter-server-protocol.js";
import {
  adapterServerControlClient,
  adapterServerControlPlane,
  invokeAdapterServerTurn,
  invokeStreamingAdapterServerTurn,
} from "./adapter-server-client.js";
import {
  type HarnessAdapter,
  type HarnessApprovalRequest,
  type HarnessApprovalResolution,
  type HarnessSpawnOptionsArgs,
  type HarnessStreamingTurn,
  type HarnessStreamingTurnInvocationArgs,
  type HarnessTurnStateEvent,
  type HarnessTurnInvocationArgs,
  type HarnessTurnResult,
} from "./types.js";

export type HermesHarnessAdapterConfig = {
  runtimeImage: string;
  hostStateRoot: string;
  stateRoot: string;
  network: string;
  gatewayPort: number;
  passthroughEnv: Record<string, string>;
  environments: EnvironmentStore;
};

export class HermesHarnessAdapter implements HarnessAdapter {
  readonly id = "hermes";
  readonly displayName = "Hermes";
  readonly controlPlane = adapterServerControlPlane(this.id);

  constructor(private readonly cfg: HermesHarnessAdapterConfig) {}

  modelForUsage(model: string): string {
    return model;
  }

  isFailureOutput(_output: string): boolean {
    return false;
  }

  shouldBypassWarmPool(
    session: Pick<Session, "environmentId" | "vaultId"> | undefined,
  ): boolean {
    if (!session) return false;
    if (session.vaultId) return true;
    if (!session.environmentId) return false;
    const env = this.cfg.environments.get(session.environmentId);
    if (env?.networking.type === "limited") return true;
    if (!env?.packages) return false;
    return Object.values(env.packages).some(
      (pkgs) => Array.isArray(pkgs) && pkgs.length > 0,
    );
  }

  buildSpawnOptions(args: HarnessSpawnOptionsArgs): SpawnOptions {
    const { agent, sessionId } = args;
    const hostMount: Mount = {
      hostPath: `${this.cfg.hostStateRoot}/${agent.agentId}/sessions/${sessionId}`,
      containerPath: "/workspace",
    };
    this.prepareWorkspace(agent.agentId, sessionId);

    const env: Record<string, string> = {
      ...this.cfg.passthroughEnv,
      OMA_ADAPTER_PROTOCOL: "oma.adapter.v1",
      OMA_ADAPTER_HARNESS_ID: this.id,
      OMA_ADAPTER_PORT: String(this.cfg.gatewayPort),
      OPENCLAW_GATEWAY_PORT: String(this.cfg.gatewayPort),
      OMA_MANAGED_SESSION_ID: sessionId,
      OMA_AGENT_ID: agent.agentId,
      OMA_STATE_DIR: "/workspace",
      HERMES_HOME: "/workspace/.hermes",
      TERMINAL_CWD: "/workspace",
      TERMINAL_ENV: "local",
      HERMES_INTERACTIVE: agent.permissionPolicy.type === "always_ask" ? "1" : "0",
    };

    return {
      image: this.cfg.runtimeImage,
      env,
      mounts: [hostMount],
      containerPort: this.cfg.gatewayPort,
      network: this.cfg.network,
      labels: {
        "orchestrator-agent-id": agent.agentId,
        "orchestrator-session-id": sessionId,
        "orchestrator-harness-id": this.id,
      },
    };
  }

  async invokeTurn(args: HarnessTurnInvocationArgs): Promise<HarnessTurnResult> {
    return invokeAdapterServerTurn(args);
  }

  async invokeStreamingTurn(
    args: HarnessStreamingTurnInvocationArgs,
  ): Promise<HarnessStreamingTurn> {
    return invokeStreamingAdapterServerTurn(args);
  }

  async patchSession(
    controlClient: unknown,
    sessionId: string,
    fields: { model?: string; thinkingLevel?: AgentConfig["thinkingLevel"] },
  ): Promise<void> {
    const client = adapterServerControlClient(controlClient);
    await client.postControl(`/sessions/${encodeURIComponent(sessionId)}/patch`, {
      protocol_version: "oma.adapter.v1",
      session: { managed_session_id: sessionId },
      model: fields.model,
      thinking_level: fields.thinkingLevel,
    });
  }

  async abortSession(controlClient: unknown, sessionId: string): Promise<void> {
    const client = adapterServerControlClient(controlClient);
    await client.postControl(`/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      protocol_version: "oma.adapter.v1",
      session: { managed_session_id: sessionId },
    });
  }

  async compactSession(controlClient: unknown, sessionId: string): Promise<void> {
    const client = adapterServerControlClient(controlClient);
    await client.postControl(`/sessions/${encodeURIComponent(sessionId)}/compact`, {
      protocol_version: "oma.adapter.v1",
      session: { managed_session_id: sessionId },
    });
  }

  async resolveApproval(
    controlClient: unknown,
    sessionId: string,
    approvalId: string,
    decision: "allow" | "deny",
  ): Promise<void> {
    const client = adapterServerControlClient(controlClient);
    await client.postControl(
      `/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      {
        protocol_version: "oma.adapter.v1",
        session: { managed_session_id: sessionId },
        approval_id: approvalId,
        decision,
      },
    );
  }

  async listApprovals(
    controlClient: unknown,
    sessionId: string,
  ): Promise<HarnessApprovalRequest[]> {
    const client = adapterServerControlClient(controlClient);
    const data = await client.getControl(
      `/sessions/${encodeURIComponent(sessionId)}/approvals`,
    );
    const parsed = AdapterServerListApprovalsResponseSchema.parse(data);
    return parsed.approvals.map((approval) => ({
      approvalId: approval.approval_id,
      sessionId: approval.managed_session_id,
      toolName: approval.tool_name,
      toolCallId: approval.tool_call_id,
      description: approval.description,
      arrivedAt: approval.arrived_at,
    }));
  }

  subscribeApprovalRequested(
    controlClient: unknown,
    sessionId: string,
    handler: (approval: HarnessApprovalRequest) => void,
  ): () => void {
    const seen = new Set<string>();
    const poll = async (): Promise<void> => {
      const approvals = await this.listApprovals(controlClient, sessionId);
      for (const approval of approvals) {
        if (seen.has(approval.approvalId)) continue;
        seen.add(approval.approvalId);
        handler(approval);
      }
    };
    void poll().catch(() => {
      /* transient adapter startup/race */
    });
    const timer = setInterval(() => {
      void poll().catch(() => {
        /* best-effort polling subscription */
      });
    }, 500);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  subscribeApprovalResolved(
    _controlClient: unknown,
    _handler: (resolution: HarnessApprovalResolution) => void,
  ): () => void {
    return () => {};
  }

  subscribeTurnState(
    _controlClient: unknown,
    _sessionId: string,
    _handler: (event: HarnessTurnStateEvent) => void,
  ): () => void {
    return () => {};
  }

  private prepareWorkspace(agentId: string, sessionId: string): void {
    const inProcessWorkspace = join(this.cfg.stateRoot, agentId, "sessions", sessionId);
    mkdirSync(inProcessWorkspace, { recursive: true, mode: 0o755 });
  }
}
