import type { D1DatabaseLike } from "../events/d1.js";
import { DurableObjectSqlStore, type DurableObjectStorageLike } from "../store/durable-object-sql.js";
import type { R2BucketLike } from "../workspace/r2.js";
import type { ManagedWorkspace } from "../workspace/types.js";
import {
  createCloudflareFlueFetchHandler,
  type CloudflareFlueFetchHandler,
  type CloudflareFlueFetchHandlerOptions,
} from "./fetch-handler.js";

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
  OMA_RUN_TIMEOUT_MS?: string | number;
  OMA_RATE_LIMIT_RPM?: string | number;
  OMA_VERSION?: string;
  OMA_COMMIT_SHA?: string;
  OMA_PASSTHROUGH_ENV_JSON?: string | Record<string, string>;
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
 * workspace, and the shared Worker-style OMA HTTP handler. Run execution still
 * goes through the Flue native harness path; Workflow-backed long-running runs
 * are a separate runtime step.
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
    return this.getHandler().fetch(request, this.env, undefined);
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
    return createCloudflareFlueDurableObjectHandler({
      state: this.state,
      db: this.env.OMA_DB,
      r2Bucket: this.env.OMA_WORKSPACE,
      apiToken: this.env.OMA_API_TOKEN,
      parentTokenSecretBase64: this.env.OMA_PARENT_TOKEN_SECRET_BASE64,
      runTimeoutMs: optionalNumber("OMA_RUN_TIMEOUT_MS", this.env.OMA_RUN_TIMEOUT_MS),
      rateLimitRpm: optionalNumber("OMA_RATE_LIMIT_RPM", this.env.OMA_RATE_LIMIT_RPM),
      version: this.env.OMA_VERSION,
      commitSha: this.env.OMA_COMMIT_SHA,
      passthroughEnv: optionalStringRecord(
        "OMA_PASSTHROUGH_ENV_JSON",
        this.env.OMA_PASSTHROUGH_ENV_JSON,
      ),
    });
  }
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
    return this.getHandler().fetch(request, this.env, undefined);
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
