import { describe, expect, it } from "vitest";

import {
  ADAPTER_SERVER_PROTOCOL_VERSION,
  AdapterServerReadyResponseSchema,
  AdapterServerRoutes,
  AdapterServerStartTurnRequestSchema,
  AdapterServerStartTurnResponseSchema,
  AdapterServerStreamFrameSchema,
} from "./adapter-server-protocol.js";

const capabilities = {
  streaming: true,
  cancel: true,
  interrupt: false,
  tool_approvals: true,
  mcp: true,
  dynamic_model_patch: false,
  compaction: true,
  native_session_resume: true,
  usage: true,
  subagents: false,
};

describe("adapter-server protocol", () => {
  it("declares stable internal route templates", () => {
    expect(AdapterServerRoutes.ready).toBe("/readyz");
    expect(AdapterServerRoutes.startTurn).toBe("/sessions/:session_id/turns");
    expect(AdapterServerRoutes.resolveApproval).toBe(
      "/sessions/:session_id/approvals/:approval_id",
    );
    expect(AdapterServerRoutes.listApprovals).toBe(
      "/sessions/:session_id/approvals",
    );
  });

  it("validates ready responses with explicit capabilities", () => {
    const parsed = AdapterServerReadyResponseSchema.parse({
      protocol_version: ADAPTER_SERVER_PROTOCOL_VERSION,
      harness_id: "hermes",
      adapter_version: "0.1.0",
      capabilities,
    });

    expect(parsed.harness_id).toBe("hermes");
    expect(parsed.capabilities.native_session_resume).toBe(true);
  });

  it("rejects protocol-version mismatches", () => {
    expect(() =>
      AdapterServerReadyResponseSchema.parse({
        protocol_version: "oma.adapter.v0",
        harness_id: "hermes",
        capabilities,
      }),
    ).toThrow();
  });

  it("validates a turn request and applies safe defaults", () => {
    const parsed = AdapterServerStartTurnRequestSchema.parse({
      protocol_version: ADAPTER_SERVER_PROTOCOL_VERSION,
      session: {
        managed_session_id: "ses_123",
        native_metadata: { checkpoint: 3 },
      },
      agent: {
        agent_id: "agt_123",
        harness_id: "hermes",
        model: "deepseek/deepseek-v4-pro",
        instructions: "Be concise.",
        tools: ["shell"],
        permission_policy: { type: "always_ask" },
      },
      turn: {
        content: "Summarize the repository.",
      },
    });

    expect(parsed.session.remaining_subagent_depth).toBe(0);
    expect(parsed.agent.mcp_servers).toEqual({});
    expect(parsed.agent.thinking_level).toBe("off");
    expect(parsed.turn.stream).toBe(false);
  });

  it("validates turn responses with native ids and normalized events", () => {
    const parsed = AdapterServerStartTurnResponseSchema.parse({
      protocol_version: ADAPTER_SERVER_PROTOCOL_VERSION,
      output: "done",
      usage: {
        tokens_in: 11,
        tokens_out: 7,
        cost_usd: 0.001,
        model: "deepseek/deepseek-v4-pro",
      },
      native: {
        native_session_id: "hermes-session",
        native_thread_id: "thread-1",
        native_metadata: { resumable: true },
      },
      events: [{
        event_id: "evt_1",
        session_id: "ses_123",
        type: "agent.message",
        content: "done",
        created_at: 1_777_000_000_000,
        tokens_in: 11,
        tokens_out: 7,
        cost_usd: 0.001,
      }],
    });

    expect(parsed.native?.native_thread_id).toBe("thread-1");
    expect(parsed.events[0]?.type).toBe("agent.message");
  });

  it("validates stream frames for deltas, approvals, state, and completion", () => {
    expect(AdapterServerStreamFrameSchema.parse({
      type: "delta",
      content: "he",
    }).content).toBe("he");

    expect(AdapterServerStreamFrameSchema.parse({
      type: "approval.requested",
      approval: {
        approval_id: "ap_1",
        managed_session_id: "ses_123",
        tool_name: "shell",
        description: "Run command?",
        arrived_at: 1,
      },
    }).type).toBe("approval.requested");

    expect(AdapterServerStreamFrameSchema.parse({
      type: "state",
      state: "final",
    }).type).toBe("state");

    expect(AdapterServerStreamFrameSchema.parse({
      type: "turn.completed",
      result: {
        protocol_version: ADAPTER_SERVER_PROTOCOL_VERSION,
        output: "done",
      },
    }).type).toBe("turn.completed");
  });
});
