import { describe, expect, it, vi } from "vitest";

import type { ManagedRunRequest } from "../runtime/run-scheduler.js";
import {
  CloudflareWorkflowRunScheduler,
  executeManagedRunOnCoordinator,
  MANAGED_RUN_INTERNAL_PATH,
  MANAGED_RUN_INTERNAL_TOKEN_HEADER,
  runCloudflareManagedRunWorkflow,
  type CloudflareWorkflowBindingLike,
  type CloudflareWorkflowStepLike,
} from "./workflow.js";

describe("CloudflareWorkflowRunScheduler", () => {
  it("creates a Workflow instance with the managed run request", async () => {
    const workflow = new FakeWorkflow();
    const run = vi.fn(async () => {});
    const onFailure = vi.fn();
    const request = runRequest();
    const scheduler = new CloudflareWorkflowRunScheduler({ workflow });

    await scheduler.schedule({ request, run, onFailure });

    expect(workflow.created).toEqual([{ id: request.runId, params: request }]);
    expect(run).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("passes an optional Workflow id from the configured factory", async () => {
    const workflow = new FakeWorkflow();
    const scheduler = new CloudflareWorkflowRunScheduler({
      workflow,
      idFactory: (request) => `workflow-${request.runId}`,
    });

    await scheduler.schedule({
      request: runRequest({ runId: "run_custom", sessionId: "ses_custom" }),
      run: async () => {},
      onFailure: () => {},
    });

    expect(workflow.created[0]).toMatchObject({
      id: "workflow-run_custom",
      params: { runId: "run_custom", sessionId: "ses_custom" },
    });
  });

  it("surfaces Workflow creation failures to the router scheduler path", async () => {
    const scheduler = new CloudflareWorkflowRunScheduler({
      workflow: {
        create: async () => {
          throw new Error("workflow unavailable");
        },
      },
    });

    await expect(scheduler.schedule({
      request: runRequest(),
      run: async () => {},
      onFailure: () => {},
    })).rejects.toThrow(/workflow unavailable/);
  });
});

describe("Cloudflare managed run Workflow runner", () => {
  it("executes the Workflow step by posting the managed run request to the coordinator", async () => {
    const request = runRequest({ content: "from workflow" });
    const coordinator = new FakeCoordinator(async (incoming) => {
      expect(new URL(incoming.url).pathname).toBe(MANAGED_RUN_INTERNAL_PATH);
      expect(incoming.headers.get(MANAGED_RUN_INTERNAL_TOKEN_HEADER)).toBe("secret");
      expect(await incoming.json()).toEqual(request);
      return Response.json({ status: "executed" });
    });
    const step = new FakeStep();

    const result = await runCloudflareManagedRunWorkflow(
      { payload: request },
      step,
      {
        OMA_COORDINATOR: coordinator,
        OMA_WORKFLOW_INTERNAL_TOKEN: "secret",
      },
    );

    expect(result).toEqual({ status: "executed" });
    expect(step.calls).toEqual([
      {
        name: "execute managed run",
        config: { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
      },
    ]);
  });

  it("throws on coordinator non-2xx responses so Workflow step retry can apply", async () => {
    const coordinator = new FakeCoordinator(async () =>
      new Response("not ready", { status: 503 }),
    );

    await expect(executeManagedRunOnCoordinator(
      runRequest(),
      {
        OMA_COORDINATOR: coordinator,
        OMA_WORKFLOW_INTERNAL_TOKEN: "secret",
      },
    )).rejects.toThrow(/503 not ready/);
  });
});

function runRequest(patch: Partial<ManagedRunRequest> = {}): ManagedRunRequest {
  return {
    runId: patch.runId ?? "run_1",
    sessionId: patch.sessionId ?? "ses_1",
    agentId: patch.agentId ?? "agt_1",
    content: patch.content ?? "hello",
    model: patch.model,
    thinkingLevel: patch.thinkingLevel,
    queued: patch.queued ?? false,
  };
}

class FakeWorkflow implements CloudflareWorkflowBindingLike {
  readonly created: Array<{ id?: string; params: ManagedRunRequest }> = [];

  create(args: { id?: string; params: ManagedRunRequest }): { id: string } {
    this.created.push(args);
    return { id: args.id ?? `workflow-${this.created.length}` };
  }
}

class FakeStep implements CloudflareWorkflowStepLike {
  readonly calls: Array<{ name: string; config: Record<string, unknown> }> = [];

  async do<T>(
    name: string,
    config: Record<string, unknown>,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    this.calls.push({ name, config });
    return await callback();
  }
}

class FakeCoordinator {
  constructor(private readonly handler: (request: Request) => Response | Promise<Response>) {}

  idFromName(name: string): string {
    return name;
  }

  get(id: string): { fetch: (request: Request) => Response | Promise<Response> } {
    return { fetch: this.handler };
  }
}
