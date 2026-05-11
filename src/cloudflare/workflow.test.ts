import { describe, expect, it, vi } from "vitest";

import type { ManagedRunRequest } from "../runtime/run-scheduler.js";
import {
  CloudflareWorkflowRunScheduler,
  type CloudflareWorkflowBindingLike,
} from "./workflow.js";

describe("CloudflareWorkflowRunScheduler", () => {
  it("creates a Workflow instance with the managed run request", async () => {
    const workflow = new FakeWorkflow();
    const run = vi.fn(async () => {});
    const onFailure = vi.fn();
    const request = runRequest();
    const scheduler = new CloudflareWorkflowRunScheduler({ workflow });

    await scheduler.schedule({ request, run, onFailure });

    expect(workflow.created).toEqual([{ params: request }]);
    expect(run).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("passes an optional Workflow id from the configured factory", async () => {
    const workflow = new FakeWorkflow();
    const scheduler = new CloudflareWorkflowRunScheduler({
      workflow,
      idFactory: (request) => `run-${request.sessionId}`,
    });

    await scheduler.schedule({
      request: runRequest({ sessionId: "ses_custom" }),
      run: async () => {},
      onFailure: () => {},
    });

    expect(workflow.created[0]).toMatchObject({
      id: "run-ses_custom",
      params: { sessionId: "ses_custom" },
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

function runRequest(patch: Partial<ManagedRunRequest> = {}): ManagedRunRequest {
  return {
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
