import type {
  ManagedRunExecutionResult,
  ManagedRunRequest,
  ManagedRunScheduler,
  ScheduleManagedRunArgs,
} from "../runtime/run-scheduler.js";
import {
  fetchCloudflareFlueCoordinator,
  type DurableObjectNamespaceLike,
} from "./worker.js";

export const MANAGED_RUN_INTERNAL_PATH = "/_oma/internal/runs/execute";
export const MANAGED_RUN_INTERNAL_TOKEN_HEADER = "x-oma-internal-token";

export type CloudflareWorkflowInstanceLike = {
  id?: string;
};

export type CloudflareWorkflowBindingLike = {
  create(args: {
    id?: string;
    params: ManagedRunRequest;
  }): Promise<CloudflareWorkflowInstanceLike> | CloudflareWorkflowInstanceLike;
};

export type CloudflareWorkflowRunSchedulerOptions = {
  workflow: CloudflareWorkflowBindingLike;
  idFactory?: (request: ManagedRunRequest) => string | undefined;
};

export type CloudflareManagedRunWorkflowEnv = {
  OMA_COORDINATOR: DurableObjectNamespaceLike;
  OMA_COORDINATOR_NAME?: string;
  OMA_WORKFLOW_INTERNAL_TOKEN: string;
};

export type CloudflareWorkflowEventLike<Payload> = {
  payload: Payload;
};

export type CloudflareWorkflowStepConfigLike = Record<string, unknown>;

export type CloudflareWorkflowStepLike = {
  do<T>(
    name: string,
    config: CloudflareWorkflowStepConfigLike,
    callback: () => T | Promise<T>,
  ): Promise<T>;
};

export type CloudflareManagedRunWorkflowOptions = {
  namespace?: DurableObjectNamespaceLike;
  coordinatorName?: string;
  internalToken?: string;
  requestUrl?: string;
  stepName?: string;
  stepConfig?: CloudflareWorkflowStepConfigLike;
};

const DEFAULT_WORKFLOW_STEP_CONFIG: CloudflareWorkflowStepConfigLike = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
};

export class CloudflareWorkflowRunScheduler implements ManagedRunScheduler {
  constructor(private readonly opts: CloudflareWorkflowRunSchedulerOptions) {}

  async schedule(args: ScheduleManagedRunArgs): Promise<void> {
    await this.opts.workflow.create({
      id: this.opts.idFactory?.(args.request) ?? args.request.runId,
      params: args.request,
    });
  }
}

export async function runCloudflareManagedRunWorkflow(
  event: CloudflareWorkflowEventLike<ManagedRunRequest>,
  step: CloudflareWorkflowStepLike,
  env: CloudflareManagedRunWorkflowEnv,
  opts: CloudflareManagedRunWorkflowOptions = {},
): Promise<ManagedRunExecutionResult> {
  return step.do(
    opts.stepName ?? "execute managed run",
    opts.stepConfig ?? DEFAULT_WORKFLOW_STEP_CONFIG,
    () => executeManagedRunOnCoordinator(event.payload, env, opts),
  );
}

export async function executeManagedRunOnCoordinator(
  request: ManagedRunRequest,
  env: CloudflareManagedRunWorkflowEnv,
  opts: CloudflareManagedRunWorkflowOptions = {},
): Promise<ManagedRunExecutionResult> {
  const namespace = opts.namespace ?? env.OMA_COORDINATOR;
  if (!namespace) {
    throw new Error("Cloudflare managed run workflow requires OMA_COORDINATOR binding");
  }
  const internalToken = opts.internalToken ?? env.OMA_WORKFLOW_INTERNAL_TOKEN;
  if (!internalToken) {
    throw new Error("Cloudflare managed run workflow requires OMA_WORKFLOW_INTERNAL_TOKEN");
  }
  const requestUrl = opts.requestUrl ?? `https://oma.internal${MANAGED_RUN_INTERNAL_PATH}`;
  const response = await fetchCloudflareFlueCoordinator(
    new Request(requestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [MANAGED_RUN_INTERNAL_TOKEN_HEADER]: internalToken,
      },
      body: JSON.stringify(request),
    }),
    namespace,
    opts.coordinatorName ?? env.OMA_COORDINATOR_NAME,
  );
  if (!response.ok) {
    throw new Error(
      `coordinator managed run execution failed: ${response.status} ${await response.text()}`,
    );
  }
  return await response.json() as ManagedRunExecutionResult;
}
