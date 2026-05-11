export type DurableObjectIdLike = unknown;

export type DurableObjectStubLike = {
  fetch(request: Request): Response | Promise<Response>;
};

export type DurableObjectNamespaceLike = {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
};

export type CloudflareFlueWorkerEnv = {
  OMA_COORDINATOR: DurableObjectNamespaceLike;
  OMA_COORDINATOR_NAME?: string;
};

export type CloudflareFlueWorkerRouter = {
  fetch(request: Request, env: CloudflareFlueWorkerEnv, ctx?: unknown): Response | Promise<Response>;
};

export type CloudflareFlueWorkerRouterOptions = {
  namespace?: DurableObjectNamespaceLike;
  coordinatorName?: string;
};

const DEFAULT_COORDINATOR_NAME = "default";

/**
 * Worker-side router for the Cloudflare/Flue OMA stack.
 *
 * The Worker owns public routing. The Durable Object owns the managed-agent
 * coordinator state. Keeping this tiny boundary explicit prevents every Worker
 * isolate from creating its own metadata store.
 */
export function createCloudflareFlueWorkerRouter(
  opts: CloudflareFlueWorkerRouterOptions = {},
): CloudflareFlueWorkerRouter {
  return {
    fetch(request: Request, env: CloudflareFlueWorkerEnv): Response | Promise<Response> {
      const namespace = opts.namespace ?? env.OMA_COORDINATOR;
      if (!namespace) {
        throw new Error("Cloudflare Flue Worker requires OMA_COORDINATOR Durable Object binding");
      }
      const coordinatorName = opts.coordinatorName ??
        env.OMA_COORDINATOR_NAME ??
        DEFAULT_COORDINATOR_NAME;
      return fetchCloudflareFlueCoordinator(request, namespace, coordinatorName);
    },
  };
}

export function fetchCloudflareFlueCoordinator(
  request: Request,
  namespace: DurableObjectNamespaceLike,
  coordinatorName = DEFAULT_COORDINATOR_NAME,
): Response | Promise<Response> {
  if (!coordinatorName) {
    throw new Error("Cloudflare Flue coordinator name must be non-empty");
  }
  const id = namespace.idFromName(coordinatorName);
  const stub = namespace.get(id);
  return stub.fetch(request);
}
