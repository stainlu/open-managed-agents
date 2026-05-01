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
  type HarnessCapabilities,
  type HarnessApprovalRequest,
  type HarnessApprovalResolution,
  type HarnessSpawnOptionsArgs,
  type HarnessStreamingTurn,
  type HarnessStreamingTurnInvocationArgs,
  type HarnessTurnStateEvent,
  type HarnessTurnInvocationArgs,
  type HarnessTurnResult,
} from "./types.js";

export type CodexHarnessAdapterConfig = {
  runtimeImage: string;
  hostStateRoot: string;
  stateRoot: string;
  network: string;
  gatewayPort: number;
  passthroughEnv: Record<string, string>;
  environments: EnvironmentStore;
};

function codexPassthroughEnv(env: Record<string, string>): Record<string, string> {
  const next = { ...env };
  if (!next.CODEX_API_KEY && next.OPENAI_API_KEY) {
    next.CODEX_API_KEY = next.OPENAI_API_KEY;
  }
  if (!next.OPENAI_API_KEY && next.CODEX_API_KEY) {
    next.OPENAI_API_KEY = next.CODEX_API_KEY;
  }
  return next;
}

export class CodexHarnessAdapter implements HarnessAdapter {
  readonly id = "codex";
  readonly displayName = "Codex";
  readonly capabilities = {
    start_turn: {
      support: "supported",
      detail: "Adapter server drives codex app-server turn/start.",
    },
    streaming: {
      support: "supported",
      detail: "Adapter server maps app-server agentMessage deltas to managed SSE.",
    },
    native_session_resume: {
      support: "supported",
      detail: "Codex thread ids are persisted as managed native metadata and resumed.",
    },
    cancellation: {
      support: "supported",
      detail: "Adapter server calls app-server turn/interrupt for the active turn.",
    },
    interruption: {
      support: "partial",
      detail: "Cancel/interrupt is wired; steer/send is not public on the managed API yet.",
    },
    dynamic_model_patch: {
      support: "partial",
      detail: "Patch changes the model used by future turns; active turn mutation is not exposed.",
    },
    compaction: {
      support: "supported",
      detail: "Adapter server calls app-server thread/compact/start.",
    },
    tool_approvals: {
      support: "partial",
      detail: "Command and file-change approvals are bridged; MCP elicitations and permission requests are not.",
    },
    permission_deny: {
      support: "unsupported",
      detail: "Codex does not expose OMA's per-tool deny policy as a stable app-server control.",
    },
    mcp: {
      support: "unsupported",
      detail: "MCP server config is not passed through to Codex app-server yet.",
    },
    managed_event_log: {
      support: "partial",
      detail: "Adapter emits normalized user, message, reasoning, command, file-change, and MCP events.",
    },
    usage: {
      support: "supported",
      detail: "Adapter maps app-server thread/tokenUsage updates.",
    },
    subagents: {
      support: "unsupported",
      detail: "Managed subagent delegation is not injected into Codex yet.",
    },
  } satisfies HarnessCapabilities;
  readonly controlPlane = adapterServerControlPlane(this.id);

  constructor(private readonly cfg: CodexHarnessAdapterConfig) {}

  modelForUsage(model: string): string {
    if (model.startsWith("openai/")) return model.slice("openai/".length);
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
      ...codexPassthroughEnv(this.cfg.passthroughEnv),
      OMA_ADAPTER_PROTOCOL: "oma.adapter.v1",
      OMA_ADAPTER_HARNESS_ID: this.id,
      OMA_ADAPTER_PORT: String(this.cfg.gatewayPort),
      OPENCLAW_GATEWAY_PORT: String(this.cfg.gatewayPort),
      OMA_MANAGED_SESSION_ID: sessionId,
      OMA_AGENT_ID: agent.agentId,
      OMA_STATE_DIR: "/workspace",
      CODEX_HOME: "/workspace/.codex",
      OMA_CODEX_HOME: "/workspace/.codex",
      OMA_CODEX_CWD: "/workspace",
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
