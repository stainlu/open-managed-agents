import { chownSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import rawModelAliases from "../model-aliases.json" with { type: "json" };
import type { Mount, SpawnOptions } from "../runtime/container.js";
import type { ParentTokenMinter } from "../runtime/parent-token.js";
import type { EnvironmentStore, VaultStore } from "../store/types.js";
import type { AgentConfig, Session } from "../orchestrator/types.js";
import type {
  HarnessAdapter,
  HarnessSessionContext,
  HarnessSpawnOptionsArgs,
  HarnessTurnInvocationArgs,
  HarnessTurnResult,
} from "./types.js";
import { HarnessInvocationError } from "./types.js";

// UID of the non-root `openclaw` user inside the agent runtime image,
// created by `useradd -r` in Dockerfile.runtime. Docker daemon on Linux
// creates bind-mount source directories as root:root, which the openclaw
// user inside the container cannot write to (`/workspace/openclaw.json:
// Permission denied`). Docker Desktop on macOS uses virtiofs UID remapping
// and sidesteps this, but Linux bind mounts preserve host UIDs literally.
const AGENT_CONTAINER_UID = 999;
const modelAliases = rawModelAliases as { zenmux: Record<string, string> };

export function normalizeModelForRuntime(
  model: string,
  passthroughEnv: Record<string, string>,
): string {
  if (!passthroughEnv.ZENMUX_API_KEY) return model;
  const rawModel = model.startsWith("zenmux/") ? model.slice("zenmux/".length) : model;
  const effectiveModel = modelAliases.zenmux[rawModel] ?? rawModel;
  return `zenmux/${effectiveModel}`;
}

export type OpenClawHarnessAdapterConfig = {
  runtimeImage: string;
  hostStateRoot: string;
  stateRoot: string;
  network: string;
  gatewayPort: number;
  passthroughEnv: Record<string, string>;
  orchestratorUrl: string;
  tokenMinter: ParentTokenMinter;
  environments: EnvironmentStore;
  vaults: VaultStore;
};

export class OpenClawHarnessAdapter implements HarnessAdapter {
  readonly id = "openclaw";
  readonly displayName = "OpenClaw";

  constructor(private readonly cfg: OpenClawHarnessAdapterConfig) {}

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
    const { agent, session, sessionId } = args;
    const hostMount: Mount = {
      hostPath: `${this.cfg.hostStateRoot}/${agent.agentId}/sessions/${sessionId}`,
      containerPath: "/workspace",
    };

    this.prepareWorkspace(agent.agentId, sessionId);

    const remainingDepth = session.remainingSubagentDepth;
    const parentToken = this.cfg.tokenMinter.mint({
      parentSessionId: sessionId,
      parentAgentId: agent.agentId,
      allowlist: agent.callableAgents,
      remainingDepth,
    });

    const effectiveInstructions = this.withDelegationHint(
      agent.instructions,
      agent.callableAgents,
      remainingDepth,
    );
    const envConfig = session.environmentId
      ? this.cfg.environments.get(session.environmentId)
      : undefined;

    const runtimeModel = normalizeModelForRuntime(
      args.modelOverride ?? agent.model,
      this.cfg.passthroughEnv,
    );
    const runtimeThinkingLevel = args.thinkingLevel ?? agent.thinkingLevel;
    const env: Record<string, string> = {
      ...this.cfg.passthroughEnv,
      OPENCLAW_AGENT_ID: "main",
      OPENCLAW_MODEL: runtimeModel,
      OPENCLAW_THINKING_LEVEL: runtimeThinkingLevel,
      OPENCLAW_TOOLS: agent.tools.join(","),
      OPENCLAW_INSTRUCTIONS: effectiveInstructions,
      OPENCLAW_STATE_DIR: "/workspace",
      OPENCLAW_GATEWAY_PORT: String(this.cfg.gatewayPort),
      OPENCLAW_ORCHESTRATOR_URL: this.cfg.orchestratorUrl,
      OPENCLAW_ORCHESTRATOR_TOKEN: parentToken,
    };

    if (envConfig?.packages) {
      env.OPENCLAW_PACKAGES_JSON = JSON.stringify(envConfig.packages);
    }
    const effectiveMcpServers = this.injectVaultCredentials(
      agent.mcpServers,
      session.vaultId ?? null,
    );
    if (effectiveMcpServers && Object.keys(effectiveMcpServers).length > 0) {
      env.OPENCLAW_MCP_SERVERS_JSON = JSON.stringify(effectiveMcpServers);
    }
    if (agent.permissionPolicy.type === "deny") {
      env.OPENCLAW_DENIED_TOOLS = agent.permissionPolicy.tools.join(",");
    }
    if (agent.permissionPolicy.type === "always_ask") {
      env.OPENCLAW_CONFIRM_TOOLS = agent.permissionPolicy.tools
        ? agent.permissionPolicy.tools.join(",")
        : "__ALL__";
    }

    return {
      image: this.cfg.runtimeImage,
      env,
      mounts: [hostMount],
      containerPort: this.cfg.gatewayPort,
      network: this.cfg.network,
      labels: {
        "orchestrator-agent-id": agent.agentId,
        "orchestrator-session-id": sessionId,
      },
    };
  }

  async invokeTurn(args: HarnessTurnInvocationArgs): Promise<HarnessTurnResult> {
    const url = `${args.baseUrl}/v1/chat/completions`;
    // OpenClaw's OpenAI-compatible endpoint validates the `model` field against
    // either the literal "openclaw" or the "openclaw/<agentId>" pattern — it is
    // a routing hint, not the inference model. The actual model is selected
    // from the generated OpenClaw config baked at container spawn.
    //
    // Session continuity: use the canonical `agent:<agentId>:<stable-key>`
    // key so OpenClaw's startup migrations do not rewrite it between turns.
    const canonicalSessionKey = `agent:main:${args.sessionId}`;
    const body = {
      model: "openclaw/main",
      user: args.sessionId,
      messages: [{ role: "user", content: args.content }],
      stream: false,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.token}`,
        "x-openclaw-agent-id": "main",
        "x-openclaw-session-key": canonicalSessionKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(args.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HarnessInvocationError(
        `/v1/chat/completions returned ${res.status}: ${text}`,
      );
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const output = data.choices?.[0]?.message?.content ?? "";
    const usage = normalizeChatCompletionUsage(data.usage);
    if (isOpenClawFailureContent(output)) {
      throw new HarnessInvocationError(
        `upstream model call failed: ${output || "<empty reply>"}`,
      );
    }

    return {
      output,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
    };
  }

  private prepareWorkspace(agentId: string, sessionId: string): void {
    const inProcessWorkspace = join(this.cfg.stateRoot, agentId, "sessions", sessionId);
    mkdirSync(inProcessWorkspace, { recursive: true, mode: 0o755 });
    try {
      chownSync(inProcessWorkspace, AGENT_CONTAINER_UID, AGENT_CONTAINER_UID);
    } catch {
      // Non-fatal on macOS/userns; the chown only fixes Linux bind mounts.
    }
  }

  private withDelegationHint(
    instructions: string,
    callableAgents: string[],
    remainingDepth: number,
  ): string {
    if (callableAgents.length === 0 || remainingDepth <= 0) return instructions;
    const hint = [
      "",
      "## Delegation",
      "You can delegate tasks to other agents via the `openclaw-call-agent` CLI.",
      `Allowed target agents: ${callableAgents.join(", ")}.`,
      "Invoke it through your `exec` tool:",
      '  openclaw-call-agent --target <agent_id> --task "<prompt>"',
      "Run `openclaw-call-agent --help` for full usage. The tool returns JSON on stdout with the subagent's final reply and a `subagent_session_id` you can use to inspect the delegated run.",
    ].join("\n");
    return instructions ? `${instructions}\n${hint}` : hint.trimStart();
  }

  /**
   * Merge vault credentials into an agent's MCP server config for a
   * specific session. Pure function over store reads; the router still
   * owns OAuth refresh before calling into the adapter.
   */
  private injectVaultCredentials(
    agentMcpServers: AgentConfig["mcpServers"],
    vaultId: string | null,
  ): AgentConfig["mcpServers"] {
    if (!vaultId) return agentMcpServers;
    if (!agentMcpServers || Object.keys(agentMcpServers).length === 0) {
      return agentMcpServers;
    }
    const creds = this.cfg.vaults.listCredentials(vaultId);
    if (creds.length === 0) return agentMcpServers;
    const out: AgentConfig["mcpServers"] = {};
    for (const [name, server] of Object.entries(agentMcpServers)) {
      const url = typeof server.url === "string" ? server.url : undefined;
      if (!url) {
        out[name] = server;
        continue;
      }
      const match = creds
        .filter((c) => url.startsWith(c.matchUrl))
        .sort((a, b) => b.matchUrl.length - a.matchUrl.length)[0];
      if (!match) {
        out[name] = server;
        continue;
      }
      const bearer = match.type === "mcp_oauth" ? match.accessToken : match.token;
      const existingHeaders = (server.headers ?? {}) as Record<string, string>;
      out[name] = {
        ...server,
        headers: {
          ...existingHeaders,
          Authorization: `Bearer ${bearer}`,
        },
      };
    }
    return out;
  }
}

export function isOpenClawFailureContent(content: string): boolean {
  if (content === "" || content.trim() === "") return true;
  if (content === "No response from OpenClaw.") return true;
  if (content.startsWith("⚠️")) return true;
  return false;
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
};

function normalizeChatCompletionUsage(
  usage: ChatCompletionResponse["usage"] | undefined,
): { tokensIn: number; tokensOut: number } {
  if (!usage) return { tokensIn: 0, tokensOut: 0 };
  return {
    tokensIn:
      asFiniteNumber(usage.prompt_tokens) ??
      asFiniteNumber(usage.input_tokens) ??
      asFiniteNumber(usage.promptTokens) ??
      asFiniteNumber(usage.inputTokens) ??
      0,
    tokensOut:
      asFiniteNumber(usage.completion_tokens) ??
      asFiniteNumber(usage.output_tokens) ??
      asFiniteNumber(usage.completionTokens) ??
      asFiniteNumber(usage.outputTokens) ??
      0,
  };
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
