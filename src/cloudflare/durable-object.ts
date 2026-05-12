import type { D1DatabaseLike } from "../events/d1.js";
import {
  FLUE_PROVIDER_ENV_KEYS,
  type FlueProviderConfig,
  type FlueProviderSettings,
} from "../harness/flue.js";
import { isManagedRunRequest } from "../runtime/run-scheduler.js";
import {
  DurableObjectSqlStore,
  type DurableObjectStorageLike,
} from "../store/durable-object-sql.js";
import type { R2BucketLike } from "../workspace/r2.js";
import type { ManagedWorkspace } from "../workspace/types.js";
import {
  createCloudflareFlueFetchHandler,
  type CloudflareFlueFetchHandler,
  type CloudflareFlueFetchHandlerOptions,
} from "./fetch-handler.js";
import {
  CloudflareWorkflowRunScheduler,
  MANAGED_RUN_INTERNAL_PATH,
  MANAGED_RUN_INTERNAL_TOKEN_HEADER,
  type CloudflareWorkflowBindingLike,
} from "./workflow.js";

export type CloudflareDurableObjectStateLike = {
  storage: DurableObjectStorageLike;
  waitUntil?(promise: Promise<unknown>): void;
};

export type CloudflareFlueDurableObjectHandlerOptions = Omit<
  CloudflareFlueFetchHandlerOptions,
  "db" | "store" | "workspace" | "r2Bucket"
> & {
  state: CloudflareDurableObjectStateLike;
  db: D1DatabaseLike;
  workspace?: ManagedWorkspace;
  r2Bucket?: R2BucketLike;
  metadataStoreOptions?: { vaultKeyEnv?: string };
};

export type CloudflareFlueDurableObjectEnv = {
  OMA_DB: D1DatabaseLike;
  OMA_WORKSPACE?: R2BucketLike;
  OMA_API_TOKEN?: string;
  OMA_PARENT_TOKEN_SECRET_BASE64?: string;
  OMA_RUN_WORKFLOW?: CloudflareWorkflowBindingLike;
  OMA_WORKFLOW_INTERNAL_TOKEN?: string;
  OMA_RUN_TIMEOUT_MS?: string | number;
  OMA_RATE_LIMIT_RPM?: string | number;
  OMA_VERSION?: string;
  OMA_COMMIT_SHA?: string;
  OMA_PASSTHROUGH_ENV_JSON?: string | Record<string, string>;
  OMA_FLUE_PROVIDER_CONFIG_JSON?: string | FlueProviderConfig;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_OAUTH_TOKEN?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  GROQ_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
  XAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  ZAI_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  MINIMAX_API_KEY?: string;
  MINIMAX_CN_API_KEY?: string;
  MOONSHOT_API_KEY?: string;
  HF_TOKEN?: string;
  FIREWORKS_API_KEY?: string;
  KIMI_API_KEY?: string;
  CLOUDFLARE_API_KEY?: string;
};

export function createCloudflareFlueDurableObjectHandler(
  opts: CloudflareFlueDurableObjectHandlerOptions,
): CloudflareFlueFetchHandler {
  const { state, metadataStoreOptions, ...handlerOptions } = opts;
  const store = new DurableObjectSqlStore(state.storage, metadataStoreOptions);
  return createCloudflareFlueFetchHandler({
    ...handlerOptions,
    store,
  });
}

/**
 * Conventional Durable Object entrypoint for the Cloudflare/Flue OMA stack.
 *
 * This class owns only the Cloudflare composition boundary: Durable Object
 * SQLite for managed metadata, D1-compatible event/harness state, R2-compatible
 * workspace, and the shared Worker-style OMA HTTP handler. When a Workflow
 * binding is provided, run kickoff is scheduled out of band; the Workflow
 * runner resumes execution through the token-protected internal route.
 */
export class CloudflareFlueDurableObject<
  Env extends CloudflareFlueDurableObjectEnv = CloudflareFlueDurableObjectEnv,
> {
  private handler: CloudflareFlueFetchHandler | undefined;

  constructor(
    protected readonly state: CloudflareDurableObjectStateLike,
    protected readonly env: Env,
  ) {}

  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === MANAGED_RUN_INTERNAL_PATH) {
      return this.executeInternalManagedRun(request);
    }
    return this.getHandler().fetch(request, this.env, undefined);
  }

  protected async executeInternalManagedRun(request: Request): Promise<Response> {
    return executeInternalManagedRunRequest(
      request,
      this.resolveWorkflowInternalToken(this.env),
      () => this.getHandler(),
    );
  }

  protected resolveWorkflowInternalToken(env: Env): string | undefined {
    return env.OMA_WORKFLOW_INTERNAL_TOKEN;
  }

  protected getHandler(): CloudflareFlueFetchHandler {
    if (!this.handler) {
      this.handler = this.createHandler();
    }
    return this.handler;
  }

  protected createHandler(): CloudflareFlueFetchHandler {
    if (!this.env.OMA_DB) {
      throw new Error("CloudflareFlueDurableObject requires OMA_DB D1 binding");
    }
    if (!this.env.OMA_WORKSPACE) {
      throw new Error("CloudflareFlueDurableObject requires OMA_WORKSPACE R2 binding");
    }
    if (this.env.OMA_RUN_WORKFLOW && !this.env.OMA_WORKFLOW_INTERNAL_TOKEN) {
      throw new Error(
        "CloudflareFlueDurableObject requires OMA_WORKFLOW_INTERNAL_TOKEN when OMA_RUN_WORKFLOW is configured",
      );
    }
    return createCloudflareFlueDurableObjectHandler({
      state: this.state,
      db: this.env.OMA_DB,
      r2Bucket: this.env.OMA_WORKSPACE,
      apiToken: this.env.OMA_API_TOKEN,
      parentTokenSecretBase64: this.env.OMA_PARENT_TOKEN_SECRET_BASE64,
      runScheduler: this.env.OMA_RUN_WORKFLOW
        ? new CloudflareWorkflowRunScheduler({ workflow: this.env.OMA_RUN_WORKFLOW })
        : undefined,
      runTimeoutMs: optionalNumber("OMA_RUN_TIMEOUT_MS", this.env.OMA_RUN_TIMEOUT_MS),
      rateLimitRpm: optionalNumber("OMA_RATE_LIMIT_RPM", this.env.OMA_RATE_LIMIT_RPM),
      version: this.env.OMA_VERSION,
      commitSha: this.env.OMA_COMMIT_SHA,
      passthroughEnv: resolveCloudflareFluePassthroughEnv(this.env),
      flueProviderConfig: optionalFlueProviderConfig(
        "OMA_FLUE_PROVIDER_CONFIG_JSON",
        this.env.OMA_FLUE_PROVIDER_CONFIG_JSON,
      ),
    });
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function executeInternalManagedRunRequest(
  request: Request,
  expectedToken: string | undefined,
  getHandler: () => CloudflareFlueFetchHandler,
): Promise<Response> {
  const providedToken = request.headers.get(MANAGED_RUN_INTERNAL_TOKEN_HEADER);
  if (!expectedToken || providedToken !== expectedToken) {
    return jsonResponse({ error: "forbidden" }, 403);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  if (!isManagedRunRequest(payload)) {
    return jsonResponse({ error: "invalid_managed_run_request" }, 400);
  }

  const result = await getHandler().stack.router.executeScheduledRun(payload);
  return jsonResponse(result, 200);
}

export abstract class ConfigurableCloudflareFlueDurableObject<
  Env extends object = Record<string, unknown>,
> {
  private handler: CloudflareFlueFetchHandler | undefined;

  constructor(
    protected readonly state: CloudflareDurableObjectStateLike,
    protected readonly env: Env,
  ) {}

  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === MANAGED_RUN_INTERNAL_PATH) {
      return this.executeInternalManagedRun(request);
    }
    return this.getHandler().fetch(request, this.env, undefined);
  }

  protected async executeInternalManagedRun(request: Request): Promise<Response> {
    return executeInternalManagedRunRequest(
      request,
      this.resolveWorkflowInternalToken(this.env),
      () => this.getHandler(),
    );
  }

  protected getHandler(): CloudflareFlueFetchHandler {
    if (!this.handler) {
      this.handler = createCloudflareFlueDurableObjectHandler({
        state: this.state,
        ...this.resolveOptions(this.env),
      });
    }
    return this.handler;
  }

  protected abstract resolveOptions(
    env: Env,
  ): Omit<CloudflareFlueDurableObjectHandlerOptions, "state">;

  protected resolveWorkflowInternalToken(_env: Env): string | undefined {
    return undefined;
  }
}

export function cloudflareStringEnv(
  env: Record<string, unknown>,
  keys: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function optionalNumber(name: string, value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }
  return parsed;
}

function optionalStringRecord(
  name: string,
  value: string | Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "string"
    ? parseJsonRecord(name, value)
    : value;
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== "string") {
      throw new Error(`${name}.${key} must be a string`);
    }
  }
  return parsed as Record<string, string>;
}

function resolveCloudflareFluePassthroughEnv(
  env: CloudflareFlueDurableObjectEnv,
): Record<string, string> | undefined {
  const directSecrets = cloudflareStringEnv(env as Record<string, unknown>, FLUE_PROVIDER_ENV_KEYS);
  const jsonSecrets = optionalStringRecord(
    "OMA_PASSTHROUGH_ENV_JSON",
    env.OMA_PASSTHROUGH_ENV_JSON,
  ) ?? {};
  const merged = { ...directSecrets, ...jsonSecrets };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function optionalFlueProviderConfig(
  name: string,
  value: string | FlueProviderConfig | undefined,
): FlueProviderConfig | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "string"
    ? parseJsonRecord(name, value)
    : value;
  const result: FlueProviderConfig = {};
  for (const [provider, item] of Object.entries(parsed)) {
    if (!isRecord(item)) {
      throw new Error(`${name}.${provider} must be an object`);
    }
    result[provider] = parseFlueProviderSettings(`${name}.${provider}`, item);
  }
  return result;
}

function parseFlueProviderSettings(
  name: string,
  item: Record<string, unknown>,
): FlueProviderSettings {
  const result: FlueProviderSettings = {};
  for (const [key, value] of Object.entries(item)) {
    if (key === "apiKey" || key === "baseUrl") {
      if (value !== undefined && typeof value !== "string") {
        throw new Error(`${name}.${key} must be a string`);
      }
      if (value !== undefined) result[key] = value;
      continue;
    }
    if (key === "storeResponses") {
      if (value !== undefined && typeof value !== "boolean") {
        throw new Error(`${name}.storeResponses must be a boolean`);
      }
      if (value !== undefined) result.storeResponses = value;
      continue;
    }
    if (key === "headers") {
      if (!isRecord(value)) {
        throw new Error(`${name}.headers must be an object`);
      }
      const headers: Record<string, string> = {};
      for (const [header, headerValue] of Object.entries(value)) {
        if (typeof headerValue !== "string") {
          throw new Error(`${name}.headers.${header} must be a string`);
        }
        headers[header] = headerValue;
      }
      result.headers = headers;
      continue;
    }
    throw new Error(`${name}.${key} is not supported`);
  }
  return result;
}

function parseJsonRecord(name: string, value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} must be valid JSON: ${message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
