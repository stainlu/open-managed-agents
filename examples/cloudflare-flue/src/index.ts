import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  getSandbox,
  type Sandbox,
} from "@cloudflare/sandbox";
import {
  CloudflareFlueDurableObject,
  type CloudflareFlueDurableObjectEnv,
} from "../../../src/cloudflare/durable-object.js";
import {
  createCloudflareSandboxWorkspaceCommandExecutor,
  type CloudflareSandboxResolver,
} from "../../../src/cloudflare/sandbox-executor.js";
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

export { Sandbox } from "@cloudflare/sandbox";

export type Env =
  & CloudflareFlueWorkerEnv
  & CloudflareFlueDurableObjectEnv
  & CloudflareManagedRunWorkflowEnv
  & {
    Sandbox: DurableObjectNamespace<Sandbox>;
  };

const router = createCloudflareFlueWorkerRouter();
const resolveSandbox = getSandbox as unknown as CloudflareSandboxResolver;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return router.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

export class OMACoordinator extends CloudflareFlueDurableObject<Env> {
  protected override createWorkspaceCommandExecutor(env: Env) {
    return createCloudflareSandboxWorkspaceCommandExecutor({
      binding: env.Sandbox,
      getSandbox: resolveSandbox,
      sandboxIdPrefix: "oma",
      sandboxOptions: { sleepAfter: "10m" },
    });
  }
}

export class OMARunWorkflow extends WorkflowEntrypoint<Env, ManagedRunRequest> {
  async run(
    event: WorkflowEvent<ManagedRunRequest>,
    step: WorkflowStep,
  ): Promise<ManagedRunExecutionResult> {
    return runCloudflareManagedRunWorkflow(event, step, this.env);
  }
}
