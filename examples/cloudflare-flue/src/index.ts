import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  CloudflareFlueDurableObject,
  type CloudflareFlueDurableObjectEnv,
} from "../../../src/cloudflare/durable-object.js";
import {
  createCloudflareFlueWorkerRouter,
  type CloudflareFlueWorkerEnv,
} from "../../../src/cloudflare/worker.js";
import {
  runCloudflareManagedRunWorkflow,
  type CloudflareManagedRunWorkflowEnv,
} from "../../../src/cloudflare/workflow.js";
import type {
  ManagedRunExecutionResult,
  ManagedRunRequest,
} from "../../../src/runtime/run-scheduler.js";

export type Env =
  & CloudflareFlueWorkerEnv
  & CloudflareFlueDurableObjectEnv
  & CloudflareManagedRunWorkflowEnv;

const router = createCloudflareFlueWorkerRouter();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return router.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

export class OMACoordinator extends CloudflareFlueDurableObject<Env> {}

export class OMARunWorkflow extends WorkflowEntrypoint<Env, ManagedRunRequest> {
  async run(
    event: WorkflowEvent<ManagedRunRequest>,
    step: WorkflowStep,
  ): Promise<ManagedRunExecutionResult> {
    return runCloudflareManagedRunWorkflow(event, step, this.env);
  }
}
