import { describe, expect, it } from "vitest";

import type { ManagedRun } from "../store/types.js";
import type { Event } from "./types.js";
import { buildRunTree } from "./run-tree.js";

describe("buildRunTree", () => {
  it("derives nested run lineage from managed runs and event-log lifecycle", () => {
    const managedRuns: ManagedRun[] = [
      {
        runId: "run_parent",
        sessionId: "ses_1",
        agentId: "agt_1",
        status: "succeeded",
        queued: false,
        model: "anthropic/claude-sonnet-4-6",
        thinkingLevel: "medium",
        error: null,
        createdAt: 1,
        startedAt: 2,
        completedAt: 99,
      },
    ];
    const events: Event[] = [
      {
        eventId: "evt_user",
        sessionId: "ses_1",
        type: "user.message",
        content: "inspect",
        createdAt: 10,
        runId: "run_parent",
      },
      {
        eventId: "evt_parent_start",
        sessionId: "ses_1",
        type: "session.run_start",
        content: "parent",
        createdAt: 11,
        runId: "run_parent",
        runKind: "prompt",
      },
      {
        eventId: "evt_task_start",
        sessionId: "ses_1",
        type: "session.run_start",
        content: "task",
        createdAt: 12,
        runId: "task_1",
        parentRunId: "run_parent",
        runKind: "task",
      },
      {
        eventId: "evt_op_end",
        sessionId: "ses_1",
        type: "session.run_end",
        content: "shell done",
        createdAt: 13,
        runId: "op_shell",
        parentRunId: "task_1",
        runKind: "shell",
        runStatus: "completed",
        tokensIn: 3,
        tokensOut: 5,
        costUsd: 0.001,
      },
      {
        eventId: "evt_task_end",
        sessionId: "ses_1",
        type: "session.run_end",
        content: "task done",
        createdAt: 14,
        runId: "task_1",
        parentRunId: "run_parent",
        runKind: "task",
        runStatus: "completed",
      },
      {
        eventId: "evt_parent_end",
        sessionId: "ses_1",
        type: "session.run_end",
        content: "parent done",
        createdAt: 15,
        runId: "run_parent",
        runKind: "prompt",
        runStatus: "completed",
      },
    ];

    expect(buildRunTree(events, managedRuns)).toMatchObject([
      {
        runId: "run_parent",
        runKind: "prompt",
        status: "completed",
        managedStatus: "succeeded",
        source: { managedRun: true, eventLog: true },
        eventCount: 3,
        children: [
          {
            runId: "task_1",
            parentRunId: "run_parent",
            runKind: "task",
            status: "completed",
            source: { managedRun: false, eventLog: true },
            eventCount: 2,
            children: [
              {
                runId: "op_shell",
                parentRunId: "task_1",
                runKind: "shell",
                status: "completed",
                tokensIn: 3,
                tokensOut: 5,
                costUsd: 0.001,
                eventCount: 1,
              },
            ],
          },
        ],
      },
    ]);
  });

  it("keeps queued managed runs visible even before harness events exist", () => {
    const managedRuns: ManagedRun[] = [
      {
        runId: "run_queued",
        sessionId: "ses_1",
        agentId: "agt_1",
        status: "queued",
        queued: true,
        error: null,
        createdAt: 20,
        startedAt: null,
        completedAt: null,
      },
    ];

    expect(buildRunTree([], managedRuns)).toMatchObject([
      {
        runId: "run_queued",
        status: "queued",
        managedStatus: "queued",
        queued: true,
        source: { managedRun: true, eventLog: false },
        eventCount: 0,
        children: [],
      },
    ]);
  });
});
