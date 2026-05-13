import { buildApp, type RuntimeHealth } from "../orchestrator/server.js";
import { ParentTokenMinter } from "../runtime/parent-token.js";
import type { Store } from "../store/types.js";
import {
  createCloudflareFlueStack,
  type CloudflareFlueStack,
  type CloudflareFlueStackOptions,
} from "./flue-stack.js";

const PARENT_TOKEN_SECRET_KEY = "parent_token_hmac_secret";

export type CloudflareFlueFetchHandlerOptions = CloudflareFlueStackOptions & {
  apiToken?: string;
  rateLimitRpm?: number;
  tokenMinter?: ParentTokenMinter;
  parentTokenSecret?: Buffer | Uint8Array;
  parentTokenSecretBase64?: string;
  version?: string;
  startTs?: number;
  commitSha?: string;
  maxWarmContainers?: number;
  maxActiveContainers?: number;
  runtimeHealth?: RuntimeHealth;
};

export type CloudflareFlueFetchHandler = {
  stack: CloudflareFlueStack;
  fetch(request: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>;
};

/**
 * Cloudflare-oriented HTTP entrypoint for the Flue-native OMA stack.
 *
 * This is deliberately a dependency-injected fetch handler, not a Durable
 * Object class. The caller still owns the real platform bindings: Store
 * implementation, D1-compatible event/state DB, R2-compatible workspace, and
 * Flue engine. That keeps this helper honest while letting Worker entrypoints
 * reuse the same Hono API surface as the Node server.
 */
export function createCloudflareFlueFetchHandler(
  opts: CloudflareFlueFetchHandlerOptions,
): CloudflareFlueFetchHandler {
  const stack = createCloudflareFlueStack(opts);
  const tokenMinter = opts.tokenMinter ?? createPersistentParentTokenMinter(
    stack.store,
    opts.parentTokenSecret,
    opts.parentTokenSecretBase64,
  );
  const app = buildApp({
    agents: stack.store.agents,
    environments: stack.store.environments,
    sessions: stack.store.sessions,
    events: stack.events,
    harnessState: stack.harnessState,
    audit: stack.store.audit,
    vaults: stack.store.vaults,
    router: stack.router,
    harnesses: stack.harnesses,
    apiToken: opts.apiToken,
    users: stack.store.users,
    rateLimitRpm: opts.rateLimitRpm,
    tokenMinter,
    version: opts.version ?? "0.0.0-cloudflare",
    sessionContainers: stack.store.sessionContainers,
    startTs: opts.startTs ?? Date.now(),
    commitSha: opts.commitSha,
    maxWarmContainers: opts.maxWarmContainers ?? 0,
    maxActiveContainers: opts.maxActiveContainers ?? 0,
    passthroughEnv: opts.passthroughEnv,
    runtimeHealth: opts.runtimeHealth ?? cloudflareFlueRuntimeHealth(opts),
  });

  return {
    stack,
    fetch: (request, env, ctx) => app.fetch(request, env, ctx as Parameters<typeof app.fetch>[2]),
  };
}

function cloudflareFlueRuntimeHealth(opts: CloudflareFlueFetchHandlerOptions): RuntimeHealth {
  const hasWorkspace = Boolean(opts.workspace ?? opts.r2Bucket);
  const hasWorkflow = Boolean(opts.runScheduler);
  const hasWorkersAi = Boolean(opts.cloudflareAiBinding);
  const hasSandbox = Boolean(opts.workspaceCommandExecutor);
  return {
    platform: "cloudflare",
    stack: "cloudflare-flue",
    mode: "native",
    default_harness: "flue",
    bindings: {
      metadata: true,
      database: true,
      workspace: hasWorkspace,
      workflow: hasWorkflow,
      workers_ai: hasWorkersAi,
      sandbox: hasSandbox,
    },
    features: {
      workflow_runs: hasWorkflow,
      cloudflare_models: hasWorkersAi,
      sandbox_shell: hasSandbox,
    },
  };
}

function createPersistentParentTokenMinter(
  store: Store,
  providedSecret: Buffer | Uint8Array | undefined,
  providedSecretBase64: string | undefined,
): ParentTokenMinter {
  if (providedSecret !== undefined && providedSecretBase64 !== undefined) {
    throw new Error("pass parentTokenSecret or parentTokenSecretBase64, not both");
  }
  if (providedSecret !== undefined) {
    return new ParentTokenMinter(secretToBuffer(providedSecret));
  }
  if (providedSecretBase64 !== undefined) {
    return new ParentTokenMinter(decodeParentTokenSecretBase64(providedSecretBase64));
  }
  let secret = store.secrets.get(PARENT_TOKEN_SECRET_KEY);
  if (!secret) {
    secret = randomSecret();
    store.secrets.set(PARENT_TOKEN_SECRET_KEY, secret);
  }
  return new ParentTokenMinter(secret);
}

function secretToBuffer(secret: Buffer | Uint8Array): Buffer {
  return Buffer.from(secret);
}

function decodeParentTokenSecretBase64(secret: string): Buffer {
  const trimmed = secret.trim();
  if (trimmed.length === 0) {
    throw new Error("parentTokenSecretBase64 must be a non-empty base64 string");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new Error("parentTokenSecretBase64 must be standard padded base64");
  }
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.toString("base64") !== trimmed) {
    throw new Error("parentTokenSecretBase64 must be canonical base64");
  }
  if (decoded.byteLength !== 32) {
    throw new Error(
      `parentTokenSecretBase64 must decode to exactly 32 bytes, got ${decoded.byteLength}`,
    );
  }
  return decoded;
}

function randomSecret(): Buffer {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes);
}
