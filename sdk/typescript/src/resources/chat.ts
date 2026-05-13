import type { HttpClient } from "../http.js";
import { parseSse } from "../sse.js";
import type {
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
} from "../types.js";

export interface ChatCompletionCreateParams {
  agentId: string;
  sessionKey?: string;
  model?: string;
  messages: OpenAIChatMessage[];
  user?: string;
  stream?: false;
  [key: string]: unknown;
}

export interface ChatCompletionStreamParams {
  agentId: string;
  sessionKey?: string;
  model?: string;
  messages: OpenAIChatMessage[];
  user?: string;
  stream?: true;
  [key: string]: unknown;
}

export class Chat {
  readonly completions: ChatCompletions;

  constructor(http: HttpClient) {
    this.completions = new ChatCompletions(http);
  }
}

export class ChatCompletions {
  constructor(private readonly http: HttpClient) {}

  create(params: ChatCompletionCreateParams): Promise<OpenAIChatCompletion> {
    return this.http.request<OpenAIChatCompletion>(
      "POST",
      "/v1/chat/completions",
      chatBody(params, false),
      chatHeaders(params),
    );
  }

  async *stream(
    params: ChatCompletionStreamParams,
  ): AsyncGenerator<OpenAIChatCompletionChunk> {
    const resp = await this.http.streamRequest("/v1/chat/completions", {
      method: "POST",
      body: chatBody(params, true),
      headers: chatHeaders(params),
    });
    for await (const event of parseSse(resp)) {
      if (event.data === "[DONE]") break;
      if (event.event === "error") throw new Error(errorMessage(event.data));
      if (event.data.length === 0) continue;
      yield JSON.parse(event.data) as OpenAIChatCompletionChunk;
    }
  }
}

function chatBody(
  params: ChatCompletionCreateParams | ChatCompletionStreamParams,
  stream: boolean,
): OpenAIChatCompletionRequest {
  const { agentId: _agentId, sessionKey: _sessionKey, stream: _stream, ...body } = params;
  return { ...body, messages: params.messages, stream };
}

function chatHeaders(
  params: ChatCompletionCreateParams | ChatCompletionStreamParams,
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-openclaw-agent-id": params.agentId,
  };
  if (params.sessionKey !== undefined) headers["x-openclaw-session-key"] = params.sessionKey;
  return headers;
}

function errorMessage(data: string): string {
  try {
    const parsed = JSON.parse(data) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
    // fall through to raw data
  }
  return data;
}
