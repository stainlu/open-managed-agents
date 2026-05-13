# Managed Agent Contract

This is the product contract for Open Managed Agents.

`oma.adapter.v1` is the in-container wire protocol. This document is the layer
above it: what the managed-agent system promises to clients, and what a native
agent harness must provide to become a managed harness.

The short version:

```text
Client
  -> Open Managed Agents API
  -> durable Agent / Environment / Session / Event model
  -> HarnessAdapter
  -> runtime substrate
  -> native harness loop
```

Open Managed Agents owns the managed boundary. The harness owns the agent brain.

## Vocabulary

| Term | Meaning | Owner |
|---|---|---|
| Agent | Reusable template: harness id, model, instructions, tools, policy, MCP, channels | OMA |
| Environment | Runtime template: packages, files, networking, storage constraints | OMA |
| Session | Durable managed conversation/run context | OMA |
| Run | One admitted unit of work inside a session: queued, active, terminal, or cancelled | OMA |
| Event | Normalized observable history for the public API | OMA |
| Harness | Native agent loop: OpenClaw, Codex, Claude Agent SDK, Hermes, etc. | Adapter/native harness |
| Adapter | Translation layer from one harness to the managed contract | OMA integration code |
| Runtime | Isolated compute substrate for managed execution: container endpoint, native platform binding, Durable Object, sandbox, or future backend | OMA |

The product is a managed-agent layer, not just a runtime layer. Runtime is one
implementation detail of the contract.

## Managed Guarantees

OMA must provide these guarantees no matter which harness is underneath:

- Stable public API for agents, environments, sessions, runs, events, logs,
  approvals, cancellation, and OpenAI-compatible chat.
- One managed session id for the whole public lifecycle.
- One managed run id for each accepted unit of work inside that session.
- Durable session metadata across orchestrator restarts.
- Durable run metadata across orchestrator restarts.
- Durable event history in normalized managed event shape.
- Isolation of active agent execution from other sessions.
- Explicit capability and runtime-mode reporting at `GET /v1/harnesses`.
- Explicit rejection for unsupported features; no silent fallback to another
  harness or fake implementation.
- Provider credential forwarding only through the configured passthrough/vault
  paths.
- Session status is truthful: failed native turns become failed managed turns.
- Container lifetime is not session lifetime. Containers can restart, be adopted,
  or be replaced while session state remains durable.

## Harness Requirements

A harness can be managed if it can satisfy this minimum shape:

1. Start a user turn from a managed session id.
2. Return or stream final assistant output.
3. Preserve enough native state to continue the same session later.
4. Emit normalized managed events, or expose native events that an adapter can
   normalize.
5. Fail loudly when native execution fails.
6. Declare feature support accurately.
7. Run behind an OMA-managed runtime boundary without requiring direct client
   access to native internals.

If a harness cannot support a feature, that is acceptable. The adapter must mark
the feature unsupported or partial and the router must reject the path before it
mutates state.

## Session Lifecycle

The managed lifecycle is:

```text
POST /v1/agents
POST /v1/environments
POST /v1/sessions
POST /v1/sessions/:id/events
  -> status starting
  -> acquire/spawn/adopt runtime container
  -> invoke harness turn
  -> append managed events
  -> persist native metadata
  -> status idle or failed
```

Rules:

- Session creation is metadata-only. No container is required until work starts.
- The session's `harnessId` is captured at creation and must not change later.
- Child sessions are OMA-managed sessions with `parent_session_id`; they are not
  just harness-local task ids.
- `GET /v1/sessions/:id/children` lists direct managed child sessions.
- `POST /v1/sessions/:id/children` creates a managed child session under the
  parent using the parent agent template's callable-agent allowlist and
  remaining subagent depth.
- `GET /v1/sessions/:id/session-tree` returns the recursive managed session
  lineage for clients, operators, and recovery tools.
- `POST /v1/sessions/:id/cancel-tree` cancels in-flight work across the
  visible managed session tree and returns per-session aggregate results.
- `DELETE /v1/sessions/:id/session-tree` deletes the visible managed session
  tree child-first and returns per-session aggregate cleanup results.
- `X-OpenClaw-Parent-Token` is accepted as a scoped runtime credential on the
  in-container delegation paths only: create a permitted child session, post its
  first event, poll that child, and read its events. It must not grant general
  API, parent-session, sibling-session, or operator access.
- A run against an `idle` session starts immediately.
- A user event posted while the session is `starting` or `running` is queued by
  default.
- Sticky OpenAI-compatible calls may reject busy sessions because one HTTP
  response must map to one assistant answer.
- Native ids are adapter-owned and stored as session metadata:
  `nativeSessionId`, `nativeThreadId`, `nativeMetadata`.
- Native ids are never exposed as identifiers clients must use.

## Run Lifecycle

Runs are the managed control-plane handle for individual turns or scheduled
background work inside a session. They do not replace sessions or events:

- `Session` is the durable execution context.
- `Run` is one admitted unit of work in that context.
- `Event` is the observable history produced by that work.

The run lifecycle is:

```text
accepted
  -> queued | starting
  -> running
  -> succeeded | failed | cancelled | skipped
```

Rules:

- `run_id` is assigned by OMA before queueing, scheduling, Workflow handoff, or
  harness invocation.
- Queued runs remain addressable before they become active.
- `GET /v1/sessions/:id/runs` lists the runs for a session.
- `GET /v1/sessions/:id/runs/:runId` reads one run.
- `GET /v1/sessions/:id/run-tree` derives an inspectable run tree from managed
  run records plus `session.run_start` / `session.run_end` event lineage. This
  is a read model, not a promise that every child node is independently
  abortable or schedulable.
- `GET /v1/sessions/:id/events?run_id=:runId` reads the events attached to a
  specific managed or harness-native run id.
- `GET /v1/sessions/:id/events?parent_run_id=:runId` reads direct child-run
  events, for harnesses that expose nested run lineage.
- `GET /v1/sessions/:id/approvals` lists currently pending tool approvals from
  OMA's managed approval store, so clients can recover approval state after
  reconnecting without depending on a live SSE stream.
- `POST /v1/sessions/:id/approvals/:approvalId` resolves a pending approval
  with `{ "decision": "allow" | "deny" }`. Posting
  `user.tool_confirmation` to `/events` remains supported for event-shaped
  clients.
- `POST /v1/sessions/:id/runs/:runId/abort` cancels a queued run without
  stopping the active session. For the currently active run, it maps to the
  harness/runtime cancellation path and marks non-terminal work cancelled.
- Terminal runs are immutable from the client's point of view.
- Harness-native run ids are adapter metadata. Public clients use OMA
  `run_id`.
- Harness-native run registries, admin APIs, and OpenAPI specs are allowed
  below the adapter boundary. They do not replace OMA's managed run store unless
  the adapter explicitly maps them into OMA run records. For example, Flue can
  expose `/runs/:runId` for direct Flue deployments while OMA still exposes
  session-scoped `/v1/sessions/:id/runs/:runId` as the cross-harness control
  plane.

## Runtime Contract

The runtime substrate must provide isolated compute for one managed session or
one warm agent template.

Current production implementation: Docker endpoint containers.

Native harness stacks can run without acquiring a runtime endpoint. In that
shape, OMA still owns the managed session/run/event lifecycle, while the
adapter invokes the harness through in-process SDKs, platform bindings, Durable
Object composition, or another substrate-specific mechanism. Native mode is not
a shortcut around the managed contract.

Endpoint/container runtime behavior:

- Spawn a container from adapter-provided image, env, mounts, labels, networks,
  and command.
- Wait for adapter readiness before the turn is invoked.
- Stop or detach containers according to pool policy.
- Label containers with managed session/agent/harness identity.
- List managed containers for startup adoption.
- Reattach healthy containers after orchestrator restart when possible.
- Stop true orphan containers.
- Never delete durable session state just because compute was stopped.

Warm containers are optimization only. A correct container adapter must work
without warm pool support.

Native runtime behavior:

- Invoke the harness without requiring a `baseUrl` or bearer token endpoint.
- Preserve enough native state to resume the same managed session.
- Surface cancellation, logs, approvals, and events only where the adapter
  capability matrix says those operations are supported.
- Fail loudly if a container-only harness is registered in a native-only
  composition root.

## Adapter Contract

Each harness adapter implements `HarnessAdapter` in `src/harness/types.ts`.

Adapter responsibilities:

- Build spawn options when it uses a runtime container.
- Invoke non-streaming and streaming turns.
- Map native usage into `tokensIn`, `tokensOut`, `model`, and cost inputs where
  possible.
- Return updated native metadata after each turn.
- Map native logs/events into managed events.
- Implement or reject control operations:
  cancellation, interruption, model/thinking patch, compaction, approval
  resolution, approval listing.
- Report capabilities honestly.

Most non-OpenClaw adapters use the adapter-server protocol documented in
`docs/adapter-server-protocol.md`. OpenClaw currently uses its existing gateway
HTTP, gateway WebSocket, and Pi JSONL directly.

## Event Contract

Managed event history is the public source of truth.

Allowed event types include:

- `user.message`
- `agent.message`
- `agent.error`
- `agent.thinking`
- `agent.tool_use`
- `agent.tool_result`
- `agent.tool_confirmation_request`
- `session.model_change`
- `session.thinking_level_change`
- `session.compaction`
- `session.runtime_notice`
- `session.run_start`
- `session.run_end`

Invariants:

- `session_id` is always the managed session id.
- `event_id` is stable and unique within the managed session.
- `created_at` is Unix milliseconds.
- Event reads are chronological.
- Duplicate event ids are ignored during append/normalization.
- Empty native retry noise should not become public `agent.message` output.
- Native errors should become `agent.error` events when observable and failed
  turns when terminal.

Events may be sourced from native logs, adapter-emitted JSONL, or a composite of
both. The public API must not require clients to know which source was used.

## Capability Contract

Capabilities are runtime behavior, not marketing flags.

Harness catalog entries also include `runtime_mode`:

- `container`: OMA acquires a managed runtime endpoint before invoking the
  harness.
- `native`: the harness runs through the orchestrator or platform runtime; OMA
  must not fake Docker spawn options or container control clients for it.

The managed runtime substrate itself is exposed separately at `GET /v1/runtime`.
That response is sanitized control-plane evidence: platform,
stack, mode, default harness, configured binding booleans, and feature booleans.
It must not contain provider resource ids, host paths, bearer tokens, or
cloud-specific object names. `/healthz` may mirror the same profile for
liveness, but clients should use `/v1/runtime` when they need authenticated
managed-runtime introspection.

Current capability keys:

- `start_turn`
- `streaming`
- `native_session_resume`
- `cancellation`
- `interruption`
- `dynamic_model_patch`
- `compaction`
- `tool_approvals`
- `permission_deny`
- `mcp`
- `managed_event_log`
- `usage`
- `subagents`

Support values:

- `supported`: router may expose the path.
- `partial`: router may expose only the documented subset.
- `unsupported`: router must reject before container acquisition or state
  mutation.

Examples:

- Hermes has partial tool approvals through dangerous terminal commands, but
  does not yet provide arbitrary pre-tool approvals for every Hermes tool.
- Codex does not currently support per-tool deny policy through this adapter.
- Claude Agent SDK supports SDK permission callbacks but not OMA managed
  subagents yet.

## Credentials

Credentials enter runtime environments through only two managed paths:

- passthrough environment keys selected by `collectPassthroughEnv()`;
- vault-bound session credentials mounted/injected by OMA.

Adapters must not scrape arbitrary host environment variables. Adding a provider
credential means updating the allowlist, deployment bridge, docs, and tests.

Credential aliasing must be narrow. Example: mirroring `KIMI_API_KEY` to
`KIMI_CODING_API_KEY` inside the Hermes adapter container is acceptable because
Hermes recognizes both as Kimi credentials. Aliasing unrelated provider names is
not acceptable because it can turn auth errors into misleading harness failures.

## Failure Contract

Fail loudly.

Rules:

- Native auth failures are managed turn failures.
- Native quota failures are managed turn failures.
- Native malformed/empty terminal errors are managed turn failures.
- Adapter protocol errors are managed turn failures.
- Unsupported feature use is a client error before execution starts.
- Cancellation is not failure; it is a deliberate stop.
- No adapter should return a successful empty `agent.message` when native
  execution failed.

The orchestrator may keep the session durable after failure. The failed session
must remain inspectable through session status, logs, and events.

## Restart And Resume

OMA must treat restart as a normal lifecycle event:

- The orchestrator can stop and come back.
- Healthy managed containers can be adopted.
- Unrecoverable in-flight runs become failed.
- Durable queued work remains in the queue store.
- Durable session events remain readable.
- If a container is gone, a later turn can respawn compute and resume from
  native or managed session state when the harness supports it.

This is the difference between a process wrapper and a managed-agent layer.

## Test Obligations

Every adapter must have:

- spawn-option unit tests when it uses a container runtime;
- adapter-server conformance if it uses `oma.adapter.v1`;
- capability and runtime-mode catalog coverage;
- router capability-gate coverage for unsupported features;
- no-key skip path for live scripts;
- provider-backed live two-turn recall before being promoted beyond
  experimental.

Current live proof:

- OpenClaw: production path, full default E2E.
- Codex: provider-backed two-turn recall passed.
- Claude Agent SDK: provider-backed two-turn recall passed.
- Hermes: adapter conformance passed; live two-turn recall is still pending a
  valid `KIMI_API_KEY` or `KIMI_CODING_API_KEY`.

## Promotion Bar

A harness can move from experimental to production only when:

- two-turn live recall passes with a real provider;
- restart/resume behavior is proven;
- container reap/respawn behavior is proven for container-backed harnesses, or
  native lifecycle/replay behavior is proven for native harnesses;
- failure semantics are loud and tested;
- event history is complete enough for public clients;
- capability gaps are documented and rejected correctly;
- strategy.md records current gaps and next work.
