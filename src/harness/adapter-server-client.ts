import type { Container } from "../runtime/container.js";
import type { ContainerControlClient, ContainerControlPlane } from "../runtime/control.js";
import type { Event } from "../orchestrator/types.js";
import { HarnessControlError, HarnessInvocationError, type HarnessStreamingTurn, type HarnessTurnInvocationArgs, type HarnessTurnResult } from "./types.js";
import {
  ADAPTER_SERVER_PROTOCOL_VERSION,
  AdapterServerControlResponseSchema,
  AdapterServerErrorResponseSchema,
  AdapterServerReadyResponseSchema,
  AdapterServerStartTurnResponseSchema,
  AdapterServerStreamFrameSchema,
  type AdapterServerControlResponse,
  type AdapterServerNativeState,
  type AdapterServerStartTurnRequest,
  type AdapterServerStartTurnResponse,
} from "./adapter-server-protocol.js";

export class AdapterServerHttpControlClient implements ContainerControlClient {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
    readonly harnessId?: string,
  ) {}

  async close(): Promise<void> {
    /* HTTP control client has no persistent socket. */
  }

  async postControl(path: string, body: unknown): Promise<AdapterServerControlResponse> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await parseAdapterResponse(res);
    return AdapterServerControlResponseSchema.parse(data);
  }

  async getControl(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });
    return parseAdapterResponse(res);
  }

  headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
      ...(extra ?? {}),
    };
  }
}

export function adapterServerControlPlane(harnessId?: string): ContainerControlPlane {
  return {
    async connect(container: Container): Promise<AdapterServerHttpControlClient> {
      const client = new AdapterServerHttpControlClient(
        container.baseUrl,
        container.token,
        harnessId,
      );
      const res = await fetch(`${container.baseUrl}/readyz`, {
        headers: { Authorization: `Bearer ${container.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const data = await parseAdapterResponse(res);
      const ready = AdapterServerReadyResponseSchema.parse(data);
      if (ready.protocol_version !== ADAPTER_SERVER_PROTOCOL_VERSION) {
        throw new HarnessControlError(
          "protocol_mismatch",
          `adapter server protocol mismatch: ${ready.protocol_version}`,
        );
      }
      if (harnessId && ready.harness_id !== harnessId) {
        throw new HarnessControlError(
          "harness_mismatch",
          `adapter server harness mismatch: expected ${harnessId}, got ${ready.harness_id}`,
        );
      }
      return client;
    },
    async ensureConnected(_container, client): Promise<ContainerControlClient> {
      return client;
    },
    async close(client): Promise<void> {
      await client.close();
    },
  };
}

export async function invokeAdapterServerTurn(
  args: HarnessTurnInvocationArgs,
): Promise<HarnessTurnResult> {
  const request = buildAdapterStartTurnRequest(args, false);
  const res = await fetch(`${args.baseUrl}/sessions/${encodeURIComponent(args.sessionId)}/turns`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  const data = await parseAdapterResponse(res);
  const parsed = AdapterServerStartTurnResponseSchema.parse(data);
  return turnResultFromAdapterResponse(parsed);
}

export async function invokeStreamingAdapterServerTurn(
  args: HarnessTurnInvocationArgs,
): Promise<HarnessStreamingTurn> {
  const request = buildAdapterStartTurnRequest(args, true);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(args.timeoutMs), args.timeoutMs);
  const res = await fetch(`${args.baseUrl}/sessions/${encodeURIComponent(args.sessionId)}/turns`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify(request),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
  if (!res.ok) {
    const data = await parseAdapterResponse(res);
    throw adapterErrorToInvocationError(data, res.status);
  }
  if (!res.body) {
    throw new HarnessInvocationError("adapter server returned an empty stream body");
  }
  const reader = res.body.getReader();
  let closed = false;
  const events: Event[] = [];
  return {
    chunks: decodeAdapterServerSseAsOpenAiChunks(
      reader,
      args.sessionId,
      args.agent?.model ?? args.model ?? "adapter-server",
      events,
      () => {
        closed = true;
      },
    ),
    events,
    abort: async (reason?: string) => {
      if (closed) return;
      await reader.cancel(reason ?? "client disconnected").catch(() => {
        /* stream already closed */
      });
      controller.abort();
    },
  };
}

export function adapterServerControlClient(
  client: unknown,
): AdapterServerHttpControlClient {
  if (client instanceof AdapterServerHttpControlClient) return client;
  throw new HarnessControlError(
    "invalid_control_client",
    "missing adapter-server HTTP control client",
  );
}

function buildAdapterStartTurnRequest(
  args: HarnessTurnInvocationArgs,
  stream: boolean,
): AdapterServerStartTurnRequest {
  if (!args.agent) {
    throw new HarnessInvocationError("adapter-server turn requires agent config");
  }
  const session = args.session;
  const environment = args.environment;
  return {
    protocol_version: ADAPTER_SERVER_PROTOCOL_VERSION,
    session: {
      managed_session_id: args.sessionId,
      native_session_id: session?.nativeSessionId ?? args.sessionId,
      native_thread_id: session?.nativeThreadId ?? null,
      native_metadata: session?.nativeMetadata ?? null,
      remaining_subagent_depth: session?.remainingSubagentDepth ?? 0,
      parent_session_id: session?.parentSessionId ?? null,
    },
    agent: {
      agent_id: args.agent.agentId,
      harness_id: args.agent.harnessId,
      model: args.model ?? args.agent.model,
      instructions: args.agent.instructions,
      tools: args.agent.tools,
      permission_policy: args.agent.permissionPolicy,
      mcp_servers: args.agent.mcpServers,
      thinking_level: args.thinkingLevel ?? args.agent.thinkingLevel,
      callable_agents: args.agent.callableAgents,
      max_subagent_depth: args.agent.maxSubagentDepth,
    },
    environment: {
      environment_id: environment?.environmentId ?? session?.environmentId ?? null,
      packages: environment?.packages ?? null,
      networking: environment?.networking ?? { type: "unrestricted" },
    },
    turn: {
      content: args.content,
      model: args.model,
      thinking_level: args.thinkingLevel,
      timeout_ms: args.timeoutMs,
      stream,
    },
  };
}

function turnResultFromAdapterResponse(
  response: AdapterServerStartTurnResponse,
): HarnessTurnResult {
  return {
    output: response.output,
    tokensIn: response.usage.tokens_in,
    tokensOut: response.usage.tokens_out,
    model: response.usage.model,
    events: response.events.map(adapterEventToManagedEvent),
    native: normalizeNative(response.native),
  };
}

function adapterEventToManagedEvent(event: AdapterServerStartTurnResponse["events"][number]): Event {
  return {
    eventId: event.event_id,
    sessionId: event.session_id,
    type: event.type,
    content: event.content,
    createdAt: event.created_at,
    tokensIn: event.tokens_in,
    tokensOut: event.tokens_out,
    costUsd: event.cost_usd,
    model: event.model,
    toolName: event.tool_name,
    toolCallId: event.tool_call_id,
    toolArguments: event.tool_arguments,
    isError: event.is_error,
    approvalId: event.approval_id,
  };
}

function normalizeNative(
  native: AdapterServerNativeState | undefined,
): HarnessTurnResult["native"] | undefined {
  if (!native) return undefined;
  return {
    nativeSessionId: native.native_session_id,
    nativeThreadId: native.native_thread_id,
    nativeMetadata: native.native_metadata,
  };
}

async function parseAdapterResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  let data: unknown = {};
  if (text.trim().length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new HarnessInvocationError(
        `adapter server returned non-JSON HTTP ${res.status}: ${text.slice(0, 500)}`,
      );
    }
  }
  if (!res.ok) throw adapterErrorToInvocationError(data, res.status);
  return data;
}

function adapterErrorToInvocationError(data: unknown, status: number): Error {
  const parsed = AdapterServerErrorResponseSchema.safeParse(data);
  if (parsed.success) {
    return new HarnessInvocationError(
      `adapter server returned ${status} ${parsed.data.error.code}: ${parsed.data.error.message}`,
    );
  }
  return new HarnessInvocationError(`adapter server returned HTTP ${status}`);
}

async function* decodeAdapterServerSseAsOpenAiChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  sessionId: string,
  model: string,
  events: Event[],
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
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        const parsed = AdapterServerStreamFrameSchema.parse(JSON.parse(data));
        if (parsed.type === "event") {
          events.push(adapterEventToManagedEvent(parsed.event));
        }
        if (parsed.type === "delta") {
          yield JSON.stringify({
            id: `chatcmpl-${sessionId}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: { content: parsed.content },
                finish_reason: null,
              },
            ],
          });
        }
        if (parsed.type === "turn.completed") {
          events.push(...parsed.result.events.map(adapterEventToManagedEvent));
          yield JSON.stringify({
            id: `chatcmpl-${sessionId}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: parsed.result.usage.model ?? model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          });
          yield "[DONE]";
          return;
        }
        if (parsed.type === "state" && parsed.state === "error") {
          throw new HarnessInvocationError(
            parsed.error_message ?? "adapter-server stream failed",
          );
        }
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
