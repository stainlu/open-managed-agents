import { z } from "zod";
import {
  McpServerConfigSchema,
  NetworkingSchema,
  PackagesSchema,
  PermissionPolicySchema,
  ThinkingLevelSchema,
} from "../orchestrator/types.js";

export const ADAPTER_SERVER_PROTOCOL_VERSION = "oma.adapter.v1" as const;

export const AdapterServerRoutes = {
  ready: "/readyz",
  startTurn: "/sessions/:session_id/turns",
  cancel: "/sessions/:session_id/cancel",
  interrupt: "/sessions/:session_id/interrupt",
  patch: "/sessions/:session_id/patch",
  compact: "/sessions/:session_id/compact",
  resolveApproval: "/sessions/:session_id/approvals/:approval_id",
  listEvents: "/sessions/:session_id/events",
  outcome: "/sessions/:session_id/outcome",
  logs: "/logs",
} as const;

export const AdapterServerCapabilitySchema = z
  .object({
    streaming: z.boolean(),
    cancel: z.boolean(),
    interrupt: z.boolean(),
    tool_approvals: z.boolean(),
    mcp: z.boolean(),
    dynamic_model_patch: z.boolean(),
    compaction: z.boolean(),
    native_session_resume: z.boolean(),
    usage: z.boolean(),
    subagents: z.boolean(),
  })
  .strict();

export type AdapterServerCapabilities = z.infer<typeof AdapterServerCapabilitySchema>;

export const AdapterServerReadyResponseSchema = z
  .object({
    protocol_version: z.literal(ADAPTER_SERVER_PROTOCOL_VERSION),
    harness_id: z.string().min(1),
    adapter_version: z.string().min(1).optional(),
    harness_version: z.string().min(1).optional(),
    capabilities: AdapterServerCapabilitySchema,
  })
  .strict();

export type AdapterServerReadyResponse = z.infer<typeof AdapterServerReadyResponseSchema>;

const NativeMetadataSchema = z.record(z.string(), z.unknown());

export const AdapterServerNativeStateSchema = z
  .object({
    native_session_id: z.string().min(1).nullable().optional(),
    native_thread_id: z.string().min(1).nullable().optional(),
    native_metadata: NativeMetadataSchema.nullable().optional(),
  })
  .strict();

export type AdapterServerNativeState = z.infer<typeof AdapterServerNativeStateSchema>;

export const AdapterServerSessionRefSchema = z
  .object({
    managed_session_id: z.string().min(1),
    native_session_id: z.string().min(1).nullable().optional(),
    native_thread_id: z.string().min(1).nullable().optional(),
    native_metadata: NativeMetadataSchema.nullable().optional(),
    remaining_subagent_depth: z.number().int().min(0).default(0),
    parent_session_id: z.string().min(1).nullable().optional(),
  })
  .strict();

export type AdapterServerSessionRef = z.infer<typeof AdapterServerSessionRefSchema>;

export const AdapterServerAgentSpecSchema = z
  .object({
    agent_id: z.string().min(1),
    harness_id: z.string().min(1),
    model: z.string().min(1),
    instructions: z.string(),
    tools: z.array(z.string()),
    permission_policy: PermissionPolicySchema,
    mcp_servers: z.record(z.string(), McpServerConfigSchema).default({}),
    thinking_level: ThinkingLevelSchema.default("off"),
    callable_agents: z.array(z.string()).default([]),
    max_subagent_depth: z.number().int().min(0).default(0),
  })
  .strict();

export type AdapterServerAgentSpec = z.infer<typeof AdapterServerAgentSpecSchema>;

export const AdapterServerEnvironmentSpecSchema = z
  .object({
    environment_id: z.string().min(1).nullable().optional(),
    packages: PackagesSchema.nullable().optional(),
    networking: NetworkingSchema.optional(),
    runtime_image: z.string().min(1).optional(),
  })
  .strict();

export type AdapterServerEnvironmentSpec = z.infer<typeof AdapterServerEnvironmentSpecSchema>;

export const AdapterServerTurnSchema = z
  .object({
    content: z.string().min(1),
    model: z.string().min(1).optional(),
    thinking_level: ThinkingLevelSchema.optional(),
    timeout_ms: z.number().int().positive().optional(),
    stream: z.boolean().default(false),
  })
  .strict();

export type AdapterServerTurn = z.infer<typeof AdapterServerTurnSchema>;

export const AdapterServerStartTurnRequestSchema = z
  .object({
    protocol_version: z.literal(ADAPTER_SERVER_PROTOCOL_VERSION),
    session: AdapterServerSessionRefSchema,
    agent: AdapterServerAgentSpecSchema,
    environment: AdapterServerEnvironmentSpecSchema.optional(),
    turn: AdapterServerTurnSchema,
  })
  .strict();

export type AdapterServerStartTurnRequest = z.infer<typeof AdapterServerStartTurnRequestSchema>;

export const AdapterServerUsageSchema = z
  .object({
    tokens_in: z.number().int().min(0).default(0),
    tokens_out: z.number().int().min(0).default(0),
    cost_usd: z.number().min(0).optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

export type AdapterServerUsage = z.infer<typeof AdapterServerUsageSchema>;

export const AdapterServerEventTypeSchema = z.enum([
  "user.message",
  "agent.message",
  "agent.error",
  "agent.tool_use",
  "agent.tool_result",
  "agent.thinking",
  "agent.tool_confirmation_request",
  "session.model_change",
  "session.thinking_level_change",
  "session.compaction",
  "session.runtime_notice",
]);

export const AdapterServerManagedEventSchema = z
  .object({
    event_id: z.string().min(1),
    session_id: z.string().min(1),
    type: AdapterServerEventTypeSchema,
    content: z.string(),
    created_at: z.number().int().nonnegative(),
    tokens_in: z.number().int().min(0).optional(),
    tokens_out: z.number().int().min(0).optional(),
    cost_usd: z.number().min(0).optional(),
    model: z.string().min(1).optional(),
    tool_name: z.string().min(1).optional(),
    tool_call_id: z.string().min(1).optional(),
    tool_arguments: z.record(z.string(), z.unknown()).optional(),
    is_error: z.boolean().optional(),
    approval_id: z.string().min(1).optional(),
  })
  .strict();

export type AdapterServerManagedEvent = z.infer<typeof AdapterServerManagedEventSchema>;

export const AdapterServerStartTurnResponseSchema = z
  .object({
    protocol_version: z.literal(ADAPTER_SERVER_PROTOCOL_VERSION),
    output: z.string().default(""),
    usage: AdapterServerUsageSchema.default({}),
    native: AdapterServerNativeStateSchema.optional(),
    events: z.array(AdapterServerManagedEventSchema).default([]),
  })
  .strict();

export type AdapterServerStartTurnResponse = z.infer<typeof AdapterServerStartTurnResponseSchema>;

export const AdapterServerApprovalRequestSchema = z
  .object({
    approval_id: z.string().min(1),
    managed_session_id: z.string().min(1),
    tool_name: z.string().min(1),
    tool_call_id: z.string().min(1).optional(),
    description: z.string(),
    arrived_at: z.number().int().nonnegative(),
  })
  .strict();

export type AdapterServerApprovalRequest = z.infer<typeof AdapterServerApprovalRequestSchema>;

export const AdapterServerControlRequestSchema = z
  .object({
    protocol_version: z.literal(ADAPTER_SERVER_PROTOCOL_VERSION),
    session: AdapterServerSessionRefSchema,
    reason: z.string().optional(),
  })
  .strict();

export type AdapterServerControlRequest = z.infer<typeof AdapterServerControlRequestSchema>;

export const AdapterServerInterruptRequestSchema = AdapterServerControlRequestSchema.extend({
  message: z.string().min(1),
}).strict();

export type AdapterServerInterruptRequest = z.infer<typeof AdapterServerInterruptRequestSchema>;

export const AdapterServerPatchRequestSchema = z
  .object({
    protocol_version: z.literal(ADAPTER_SERVER_PROTOCOL_VERSION),
    session: AdapterServerSessionRefSchema,
    model: z.string().min(1).optional(),
    thinking_level: ThinkingLevelSchema.optional(),
  })
  .strict();

export type AdapterServerPatchRequest = z.infer<typeof AdapterServerPatchRequestSchema>;

export const AdapterServerResolveApprovalRequestSchema = z
  .object({
    protocol_version: z.literal(ADAPTER_SERVER_PROTOCOL_VERSION),
    session: AdapterServerSessionRefSchema,
    approval_id: z.string().min(1),
    decision: z.enum(["allow", "deny"]),
  })
  .strict();

export type AdapterServerResolveApprovalRequest = z.infer<
  typeof AdapterServerResolveApprovalRequestSchema
>;

export const AdapterServerControlResponseSchema = z
  .object({
    protocol_version: z.literal(ADAPTER_SERVER_PROTOCOL_VERSION),
    accepted: z.boolean(),
    native: AdapterServerNativeStateSchema.optional(),
  })
  .strict();

export type AdapterServerControlResponse = z.infer<typeof AdapterServerControlResponseSchema>;

export const AdapterServerListEventsResponseSchema = z
  .object({
    protocol_version: z.literal(ADAPTER_SERVER_PROTOCOL_VERSION),
    events: z.array(AdapterServerManagedEventSchema),
    native: AdapterServerNativeStateSchema.optional(),
  })
  .strict();

export type AdapterServerListEventsResponse = z.infer<
  typeof AdapterServerListEventsResponseSchema
>;

export const AdapterServerOutcomeResponseSchema = z
  .object({
    protocol_version: z.literal(ADAPTER_SERVER_PROTOCOL_VERSION),
    status: z.enum(["idle", "starting", "running", "failed"]),
    output: z.string().optional(),
    usage: AdapterServerUsageSchema.optional(),
    error_message: z.string().optional(),
    native: AdapterServerNativeStateSchema.optional(),
  })
  .strict();

export type AdapterServerOutcomeResponse = z.infer<typeof AdapterServerOutcomeResponseSchema>;

export const AdapterServerStreamFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("delta"),
      content: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("event"),
      event: AdapterServerManagedEventSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("approval.requested"),
      approval: AdapterServerApprovalRequestSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("approval.resolved"),
      approval_id: z.string().min(1),
      decision: z.enum(["allow", "deny"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("state"),
      state: z.enum(["starting", "running", "final", "error"]),
      error_message: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("turn.completed"),
      result: AdapterServerStartTurnResponseSchema,
    })
    .strict(),
]);

export type AdapterServerStreamFrame = z.infer<typeof AdapterServerStreamFrameSchema>;

export const AdapterServerErrorCodeSchema = z.enum([
  "bad_request",
  "unsupported_capability",
  "native_session_not_found",
  "native_harness_error",
  "tool_approval_not_found",
  "cancel_failed",
  "interrupt_failed",
  "patch_failed",
  "compact_failed",
  "turn_failed",
  "internal_error",
]);

export const AdapterServerErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: AdapterServerErrorCodeSchema,
        message: z.string().min(1),
        retryable: z.boolean().default(false),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();

export type AdapterServerErrorResponse = z.infer<typeof AdapterServerErrorResponseSchema>;
