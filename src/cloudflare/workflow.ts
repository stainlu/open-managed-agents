import type {
  ManagedRunRequest,
  ManagedRunScheduler,
  ScheduleManagedRunArgs,
} from "../runtime/run-scheduler.js";

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

export class CloudflareWorkflowRunScheduler implements ManagedRunScheduler {
  constructor(private readonly opts: CloudflareWorkflowRunSchedulerOptions) {}

  async schedule(args: ScheduleManagedRunArgs): Promise<void> {
    await this.opts.workflow.create({
      id: this.opts.idFactory?.(args.request),
      params: args.request,
    });
  }
}
