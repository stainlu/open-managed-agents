# Adapter Server Protocol

This is the internal HTTP/SSE protocol a harness runtime container exposes to
Open Managed Agents.

Public clients do not call this protocol. Public clients call the managed-agent
API. The orchestrator calls this protocol inside the runtime substrate.

Version: `oma.adapter.v1`

## Purpose

`HarnessAdapter` is the in-process TypeScript boundary.

The adapter server protocol is the in-container boundary.

```text
AgentRouter
  -> HarnessAdapter
  -> ContainerRuntime
  -> adapter server inside container
  -> native harness
```

Why this exists:

- the orchestrator should not speak Hermes ACP, Codex JSON-RPC, Claude SDK
  streams, and OpenClaw gateway protocols directly;
- each runtime image can translate one native harness into one managed shape;
- the managed session id stays stable while adapters persist native session,
  thread, checkpoint, or resume metadata separately;
- unsupported behavior is declared in capabilities instead of faked.

## Transport

- HTTP JSON for request/response endpoints.
- Server-Sent Events for streaming turn output.
- Bearer auth with the per-container gateway token.
- `/healthz` and `/readyz` may bypass auth for container health checks.
- JSON keys are snake_case.
- Unknown fields should be rejected for control messages.

All request and response schemas live in
`src/harness/adapter-server-protocol.ts`.

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/readyz` | Adapter server is booted and declares protocol/capabilities |
| `POST` | `/sessions/:session_id/turns` | Start one user turn, optionally streaming |
| `POST` | `/sessions/:session_id/cancel` | Cancel the active turn |
| `POST` | `/sessions/:session_id/interrupt` | Interrupt or steer the active turn with a message |
| `POST` | `/sessions/:session_id/patch` | Patch session-scoped model/thinking config |
| `POST` | `/sessions/:session_id/compact` | Compact native session context |
| `POST` | `/sessions/:session_id/approvals/:approval_id` | Resolve a pending approval |
| `GET` | `/sessions/:session_id/approvals` | Return pending approvals for polling/recovery |
| `GET` | `/sessions/:session_id/events` | Return normalized managed events |
| `GET` | `/sessions/:session_id/outcome` | Return latest turn/session outcome |
| `GET` | `/logs` | Return adapter/native harness logs |

`session_id` in the URL is the managed session id.

Native ids live in the JSON body:

- `native_session_id`
- `native_thread_id`
- `native_metadata`

## Readiness

`GET /readyz` returns:

```json
{
  "protocol_version": "oma.adapter.v1",
  "harness_id": "hermes",
  "adapter_version": "0.1.0",
  "harness_version": "0.0.0",
  "capabilities": {
    "streaming": true,
    "cancel": true,
    "interrupt": true,
    "tool_approvals": true,
    "mcp": true,
    "dynamic_model_patch": false,
    "compaction": true,
    "native_session_resume": true,
    "usage": true,
    "subagents": false
  }
}
```

The orchestrator must fail loudly on protocol-version mismatch.

## Turn Request

`POST /sessions/:session_id/turns`

```json
{
  "protocol_version": "oma.adapter.v1",
  "session": {
    "managed_session_id": "ses_123",
    "native_session_id": "hermes-session-1",
    "native_thread_id": "thread-1",
    "native_metadata": {
      "checkpoint": 3
    },
    "remaining_subagent_depth": 0,
    "parent_session_id": null
  },
  "agent": {
    "agent_id": "agt_123",
    "harness_id": "hermes",
    "model": "deepseek/deepseek-v4-pro",
    "instructions": "Be concise.",
    "tools": ["shell"],
    "permission_policy": { "type": "always_ask" },
    "mcp_servers": {},
    "thinking_level": "off",
    "callable_agents": [],
    "max_subagent_depth": 0
  },
  "environment": {
    "environment_id": "env_123",
    "packages": null,
    "networking": { "type": "unrestricted" }
  },
  "turn": {
    "content": "Summarize this repository.",
    "model": "deepseek/deepseek-v4-pro",
    "thinking_level": "off",
    "timeout_ms": 60000,
    "stream": false
  }
}
```

Adapters must treat the managed session id as stable and durable. Native ids are
adapter-owned and may be absent on the first turn.

## Turn Response

Non-streaming response:

```json
{
  "protocol_version": "oma.adapter.v1",
  "output": "Done.",
  "usage": {
    "tokens_in": 11,
    "tokens_out": 7,
    "cost_usd": 0.001,
    "model": "deepseek/deepseek-v4-pro"
  },
  "native": {
    "native_session_id": "hermes-session-1",
    "native_thread_id": "thread-1",
    "native_metadata": {
      "checkpoint": 4
    }
  },
  "events": []
}
```

`native` is how an adapter returns newly allocated or updated native ids. The
orchestrator persists those fields on the managed session.

## Streaming

If `turn.stream = true`, the same route returns SSE frames. Each SSE `data`
payload is one `AdapterServerStreamFrame`.

Frame types:

- `delta` - incremental display text.
- `event` - normalized managed event.
- `approval.requested` - tool approval gate.
- `approval.resolved` - approval was resolved.
- `state` - `starting`, `running`, `final`, or `error`.
- `turn.completed` - final result with usage/native metadata.

Example:

```json
{ "type": "delta", "content": "hel" }
```

```json
{
  "type": "turn.completed",
  "result": {
    "protocol_version": "oma.adapter.v1",
    "output": "hello",
    "usage": { "tokens_in": 2, "tokens_out": 1 }
  }
}
```

## Events

Adapters must emit normalized managed events. Native logs can be preserved under
adapter-owned storage, but the public API reads managed events.

Supported event types:

- `user.message`
- `agent.message`
- `agent.error`
- `agent.tool_use`
- `agent.tool_result`
- `agent.thinking`
- `agent.tool_confirmation_request`
- `session.model_change`
- `session.thinking_level_change`
- `session.compaction`
- `session.runtime_notice`

## Errors

Error responses use:

```json
{
  "error": {
    "code": "turn_failed",
    "message": "native harness returned an error",
    "retryable": false,
    "details": {}
  }
}
```

Error codes are intentionally adapter-neutral:

- `bad_request`
- `unsupported_capability`
- `native_session_not_found`
- `native_harness_error`
- `tool_approval_not_found`
- `cancel_failed`
- `interrupt_failed`
- `patch_failed`
- `compact_failed`
- `turn_failed`
- `internal_error`

## Adapter Rules

Adapters must:

- return `protocol_version = "oma.adapter.v1"` on every JSON response;
- declare capabilities truthfully;
- use managed session ids for public event/session identity;
- return native ids through `native`, not by rewriting managed ids;
- append or expose normalized managed events;
- fail loudly on unsupported capabilities;
- preserve native logs separately when useful.

Adapters must not:

- expose provider/API secrets in events, metadata, or logs;
- silently downgrade denied capabilities;
- invent successful usage/cost numbers when the native harness does not provide
  them;
- require public clients to know native session ids.
