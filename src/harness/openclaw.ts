import { chownSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import rawModelAliases from "../model-aliases.json" with { type: "json" };
import type { Mount, SpawnOptions } from "../runtime/container.js";
import { GatewayWsError } from "../runtime/gateway-ws.js";
import type { ParentTokenMinter } from "../runtime/parent-token.js";
import type { EnvironmentStore, VaultStore } from "../store/types.js";
import type { AgentConfig, Session } from "../orchestrator/types.js";
import type {
  HarnessApprovalRequest,
  HarnessApprovalResolution,
  HarnessAdapter,
  HarnessSessionContext,
  HarnessSpawnOptionsArgs,
  HarnessStreamingTurn,
  HarnessStreamingTurnInvocationArgs,
  HarnessTurnStateEvent,
  HarnessTurnInvocationArgs,
  HarnessTurnResult,
} from "./types.js";
import { HarnessControlError, HarnessInvocationError } from "./types.js";

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

type OpenClawControlClient = {
  abort(sessionKey: string): Promise<unknown>;
  patch(sessionKey: string, fields: Record<string, unknown>): Promise<unknown>;
  compact(sessionKey: string): Promise<unknown>;
  approvalResolve(id: string, decision: "allow-once" | "deny"): Promise<unknown>;
  approvalList(): Promise<unknown[]>;
  onEvent(eventName: string, handler: (payload: unknown) => void): () => void;
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
    const res = await this.fetchChatCompletions(args, false);

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

  async invokeStreamingTurn(
    args: HarnessStreamingTurnInvocationArgs,
  ): Promise<HarnessStreamingTurn> {
    const res = await this.fetchChatCompletions(args, true);
    if (!res.body) {
      throw new HarnessInvocationError("/v1/chat/completions returned empty body");
    }

    const reader = res.body.getReader();
    let readerClosed = false;
    const chunks = decodeOpenAiSseChunks(reader, () => {
      readerClosed = true;
    });
    const abort = async (reason?: string): Promise<void> => {
      if (readerClosed) return;
      try {
        await reader.cancel(reason ?? "client disconnected");
      } catch {
        /* reader may already be closed or released */
      }
    };
    return { chunks, abort };
  }

  async patchSession(
    controlClient: unknown,
    sessionId: string,
    fields: { model?: string; thinkingLevel?: string },
  ): Promise<void> {
    const ws = openClawControlClient(controlClient, ["patch"]);
    const patch: Record<string, string> = {};
    if (fields.model) {
      patch.model = normalizeModelForRuntime(fields.model, this.cfg.passthroughEnv);
    }
    if (fields.thinkingLevel) patch.thinkingLevel = fields.thinkingLevel;
    if (Object.keys(patch).length === 0) return;
    await runControl(() => ws.patch(openClawSessionKey(sessionId), patch));
  }

  async abortSession(controlClient: unknown, sessionId: string): Promise<void> {
    const ws = openClawControlClient(controlClient, ["abort"]);
    await runControl(() => ws.abort(openClawSessionKey(sessionId)));
  }

  async compactSession(controlClient: unknown, sessionId: string): Promise<void> {
    const ws = openClawControlClient(controlClient, ["compact"]);
    await runControl(() => ws.compact(openClawSessionKey(sessionId)));
  }

  async resolveApproval(
    controlClient: unknown,
    approvalId: string,
    decision: "allow" | "deny",
  ): Promise<void> {
    const ws = openClawControlClient(controlClient, ["approvalResolve"]);
    const openClawDecision = decision === "allow" ? "allow-once" : "deny";
    await runControl(() => ws.approvalResolve(approvalId, openClawDecision));
  }

  async listApprovals(
    controlClient: unknown,
    sessionId: string,
  ): Promise<HarnessApprovalRequest[]> {
    const ws = openClawControlClient(controlClient, ["approvalList"]);
    const records = await runControlWithResult(() => ws.approvalList());
    return records
      .map((record) => parseOpenClawApproval(sessionId, record))
      .filter((approval): approval is HarnessApprovalRequest => approval !== undefined);
  }

  subscribeApprovalRequested(
    controlClient: unknown,
    sessionId: string,
    handler: (approval: HarnessApprovalRequest) => void,
  ): () => void {
    const ws = openClawControlClient(controlClient, ["onEvent"]);
    return ws.onEvent("plugin.approval.requested", (payload) => {
      const approval = parseOpenClawApproval(sessionId, payload);
      if (approval) handler(approval);
    });
  }

  subscribeApprovalResolved(
    controlClient: unknown,
    handler: (resolution: HarnessApprovalResolution) => void,
  ): () => void {
    const ws = openClawControlClient(controlClient, ["onEvent"]);
    return ws.onEvent("plugin.approval.resolved", (payload) => {
      const resolution = parseOpenClawApprovalResolution(payload);
      if (resolution) handler(resolution);
    });
  }

  subscribeTurnState(
    controlClient: unknown,
    sessionId: string,
    handler: (event: HarnessTurnStateEvent) => void,
  ): () => void {
    const ws = openClawControlClient(controlClient, ["onEvent"]);
    const sessionKey = openClawSessionKey(sessionId);
    return ws.onEvent("chat", (payload) => {
      const event = parseOpenClawTurnState(sessionKey, payload);
      if (event) handler(event);
    });
  }

  private async fetchChatCompletions(
    args: HarnessTurnInvocationArgs,
    stream: boolean,
  ): Promise<Response> {
    const url = `${args.baseUrl}/v1/chat/completions`;
    // OpenClaw's OpenAI-compatible endpoint validates the `model` field against
    // either the literal "openclaw" or the "openclaw/<agentId>" pattern — it is
    // a routing hint, not the inference model. The actual model is selected
    // from the generated OpenClaw config baked at container spawn.
    //
    // Session continuity: use the canonical `agent:<agentId>:<stable-key>`
    // key so OpenClaw's startup migrations do not rewrite it between turns.
    const canonicalSessionKey = openClawSessionKey(args.sessionId);
    const body = {
      model: "openclaw/main",
      user: args.sessionId,
      messages: [{ role: "user", content: args.content }],
      stream,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(stream ? { Accept: "text/event-stream" } : {}),
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
    return res;
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

function openClawSessionKey(sessionId: string): string {
  return `agent:main:${sessionId}`;
}

function openClawControlClient(
  client: unknown,
  required: (keyof OpenClawControlClient)[],
): OpenClawControlClient {
  if (!isRecord(client)) {
    throw new HarnessControlError("invalid_control_client", "missing OpenClaw control client");
  }
  for (const name of required) {
    if (typeof client[name] !== "function") {
      throw new HarnessControlError(
        "invalid_control_client",
        `OpenClaw control client is missing ${name}`,
      );
    }
  }
  return client as OpenClawControlClient;
}

async function runControl(action: () => Promise<unknown>): Promise<void> {
  await runControlWithResult(action);
}

async function runControlWithResult<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    throw mapControlError(err);
  }
}

function mapControlError(err: unknown): HarnessControlError {
  if (err instanceof HarnessControlError) return err;
  if (err instanceof GatewayWsError) {
    return new HarnessControlError(err.code, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new HarnessControlError("control_failed", message);
}

function parseOpenClawApproval(
  sessionId: string,
  payload: unknown,
): HarnessApprovalRequest | undefined {
  const root = isRecord(payload) ? payload : undefined;
  const request = isRecord(root?.request) ? root.request : undefined;
  const approvalId = asNonEmptyString(root?.id);
  if (!approvalId) return undefined;
  return {
    approvalId,
    sessionId,
    toolName:
      asNonEmptyString(request?.toolName) ??
      asNonEmptyString(root?.toolName) ??
      asNonEmptyString(request?.title) ??
      asNonEmptyString(root?.title) ??
      "",
    toolCallId:
      asNonEmptyString(request?.toolCallId) ??
      asNonEmptyString(root?.toolCallId) ??
      undefined,
    description:
      asNonEmptyString(request?.description) ??
      asNonEmptyString(root?.description) ??
      "",
    arrivedAt: asFiniteNumber(root?.createdAtMs) ?? Date.now(),
  };
}

function parseOpenClawApprovalResolution(
  payload: unknown,
): HarnessApprovalResolution | undefined {
  const root = isRecord(payload) ? payload : undefined;
  const approvalId = asNonEmptyString(root?.id);
  if (!approvalId) return undefined;
  return {
    approvalId,
    decision: asNonEmptyString(root?.decision),
  };
}

function parseOpenClawTurnState(
  sessionKey: string,
  payload: unknown,
): HarnessTurnStateEvent | undefined {
  const root = isRecord(payload) ? payload : undefined;
  if (!root || root.sessionKey !== sessionKey) return undefined;
  const state = asNonEmptyString(root.state);
  if (!state) return undefined;
  return {
    state,
    errorMessage: asNonEmptyString(root.errorMessage),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function isOpenClawFailureContent(content: string): boolean {
  if (content === "" || content.trim() === "") return true;
  if (content === "No response from OpenClaw.") return true;
  if (content.startsWith("⚠️")) return true;
  return false;
}

async function* decodeOpenAiSseChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onClosed: () => void,
): AsyncGenerator<string, void, void> {
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      // eslint-disable-next-line no-cond-assign
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
          }
        }
        if (dataLines.length === 0) continue;
        const data = dataLines.join("\n");
        yield data;
        if (data === "[DONE]") return;
      }
    }
  } finally {
    onClosed();
    try {
      reader.releaseLock();
    } catch {
      /* reader already released */
    }
  }
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
