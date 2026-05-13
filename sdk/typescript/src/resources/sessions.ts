import type { HttpClient } from "../http.js";
import { parseSse } from "../sse.js";
import type {
  AbortRunResult,
  Approval,
  CancelResult,
  CompactResult,
  Event,
  ManagedRun,
  ResolveApprovalResult,
  RunTree,
  SendEventResult,
  Session,
  ThinkingLevel,
} from "../types.js";

export interface CreateSessionParams {
  agentId: string;
  environmentId?: string;
  vaultId?: string;
}

export interface SendParams {
  content: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface ConfirmToolParams {
  toolUseId: string;
  result: "allow" | "deny";
  denyMessage?: string;
}

export interface ResolveApprovalParams {
  decision: "allow" | "deny";
}

export interface AbortRunParams {
  reason?: string;
}

export interface EventQueryParams {
  runId?: string;
  parentRunId?: string;
}

export class Sessions {
  constructor(private readonly http: HttpClient) {}

  create(params: CreateSessionParams): Promise<Session> {
    const body: Record<string, unknown> = { agentId: params.agentId };
    if (params.environmentId !== undefined) body["environmentId"] = params.environmentId;
    if (params.vaultId !== undefined) body["vaultId"] = params.vaultId;
    return this.http.request<Session>("POST", "/v1/sessions", body);
  }

  get(sessionId: string): Promise<Session> {
    return this.http.request<Session>("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  async list(): Promise<Session[]> {
    const resp = await this.http.request<{ sessions: Session[] }>("GET", "/v1/sessions");
    return resp.sessions;
  }

  async delete(sessionId: string): Promise<void> {
    await this.http.request<void>(
      "DELETE",
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  send(sessionId: string, params: SendParams): Promise<SendEventResult> {
    const body: Record<string, unknown> = { content: params.content };
    if (params.model !== undefined) body["model"] = params.model;
    if (params.thinkingLevel !== undefined) body["thinkingLevel"] = params.thinkingLevel;
    return this.http.request<SendEventResult>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      body,
    );
  }

  confirmTool(sessionId: string, params: ConfirmToolParams): Promise<SendEventResult> {
    const body: Record<string, unknown> = {
      type: "user.tool_confirmation",
      toolUseId: params.toolUseId,
      result: params.result,
    };
    if (params.denyMessage !== undefined) body["denyMessage"] = params.denyMessage;
    return this.http.request<SendEventResult>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      body,
    );
  }

  async approvals(sessionId: string): Promise<Approval[]> {
    const resp = await this.http.request<{ approvals: Approval[] }>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/approvals`,
    );
    return resp.approvals;
  }

  resolveApproval(
    sessionId: string,
    approvalId: string,
    params: ResolveApprovalParams,
  ): Promise<ResolveApprovalResult> {
    return this.http.request<ResolveApprovalResult>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      { decision: params.decision },
    );
  }

  cancel(sessionId: string): Promise<CancelResult> {
    return this.http.request<CancelResult>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/cancel`,
    );
  }

  compact(sessionId: string): Promise<CompactResult> {
    return this.http.request<CompactResult>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/compact`,
    );
  }

  async runs(sessionId: string): Promise<ManagedRun[]> {
    const resp = await this.http.request<{ runs: ManagedRun[] }>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/runs`,
    );
    return resp.runs;
  }

  run(sessionId: string, runId: string): Promise<ManagedRun> {
    return this.http.request<ManagedRun>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`,
    );
  }

  abortRun(
    sessionId: string,
    runId: string,
    params: AbortRunParams = {},
  ): Promise<AbortRunResult> {
    const body: Record<string, unknown> = {};
    if (params.reason !== undefined) body["reason"] = params.reason;
    return this.http.request<AbortRunResult>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/abort`,
      body,
    );
  }

  logs(sessionId: string, params: { tail?: number } = {}): Promise<string> {
    const qs = params.tail === undefined ? "" : `?tail=${encodeURIComponent(String(params.tail))}`;
    return this.http.textRequest(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/logs${qs}`,
    );
  }

  async events(sessionId: string, params: EventQueryParams = {}): Promise<Event[]> {
    const resp = await this.http.request<{ events: Event[] }>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/events${eventQuery(params)}`,
    );
    return resp.events;
  }

  runTree(sessionId: string): Promise<RunTree> {
    return this.http.request<RunTree>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/run-tree`,
    );
  }

  /**
   * SSE stream of events. Catches up on existing events, then tail-follows.
   * Skips heartbeats. The iterator ends when the server closes the connection
   * (session has been idle for ~30s with no new events).
   *
   * Example:
   * ```ts
   * for await (const event of client.sessions.stream(sessionId)) {
   *   if (event.type === "agent.message") console.log(event.content);
   * }
   * ```
   */
  async *stream(sessionId: string, params: EventQueryParams = {}): AsyncGenerator<Event> {
    const resp = await this.http.streamRequest(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events${eventQuery(params, true)}`,
    );
    for await (const sse of parseSse(resp)) {
      if (sse.event === "heartbeat") continue;
      if (sse.data.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(sse.data);
      } catch {
        continue;
      }
      yield parsed as Event;
    }
  }
}

function eventQuery(params: EventQueryParams, stream = false): string {
  const query = new URLSearchParams();
  if (stream) query.set("stream", "true");
  if (params.runId !== undefined) query.set("run_id", params.runId);
  if (params.parentRunId !== undefined) query.set("parent_run_id", params.parentRunId);
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}
