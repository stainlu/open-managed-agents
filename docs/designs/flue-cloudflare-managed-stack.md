# Flue + Cloudflare Managed Stack

Status: target architecture plus current implementation progress, current as of
2026-05-12.

## Decision

Open Managed Agents should keep its product boundary and add a Cloudflare-native
runtime path instead of replacing the existing architecture.

The winning stack is:

```text
Client / SDK
  -> Open Managed Agents API
  -> Agent / Environment / Session / Event
  -> Flue harness driver
  -> Cloudflare session runtime
       Durable Object session coordinator
       Workflows for durable long-running runs
       DO SQLite for session/event metadata
       Artifacts/R2 for workspace and large files
       Dynamic Workers for fast generated-code tools
       Cloudflare Sandboxes for full Linux hands
       AI Gateway for model routing and model traffic observability
```

Docker stays a supported runtime. Cloudflare becomes the SOTA runtime target for
the Flue harness because it gives the same session / harness / sandbox split as
Claude Managed Agents without closing the stack around one vendor harness.

## Implementation Progress

Done in OMA:

- `ManagedSessionRuntime` now exists in `src/runtime/session-runtime.ts`.
- `SessionContainerPool` implements that boundary while keeping the Docker
  backend behavior intact.
- `AgentRouter` depends on `ManagedSessionRuntime` instead of the concrete pool.
- `RuntimeLease` now accepts platform leases with optional endpoint metadata;
  router invocation asks for an endpoint capability instead of directly
  dereferencing Docker container fields.
- `NativeOnlySessionRuntime` now exists for native harness stacks. It no-ops
  warm/evict/log/control surfaces and fails loudly if an endpoint-backed
  harness tries to acquire a runtime lease.
- `createCloudflareFlueStack` now exists as a Cloudflare-oriented router
  factory. It wires a D1-compatible managed event log, D1-compatible harness
  state, optional R2-compatible workspace, `FlueHarnessAdapter`,
  `NativeOnlySessionRuntime`, and explicit metadata/workspace inputs without
  importing Cloudflare Worker APIs or faking Docker behavior.
- `createCloudflareFlueFetchHandler` now exists as a Worker-style HTTP
  entrypoint helper around that stack. It reuses OMA's existing Hono API
  surface and keeps platform bindings explicit.
- `ManagedWorkspace` now exists in `src/workspace/types.ts`.
- `LocalManagedWorkspace` preserves the current Docker/OpenClaw workspace
  layout while keeping router workspace CRUD off the event-log `stateRoot`.
- `R2ManagedWorkspace` now exists as an R2-compatible managed workspace backend
  for object-store session files.
- `ManagedEventLog` methods are now awaitable, and router/server call sites
  await event reads, writes, stats, and deletes.
- `CompositeManagedEventLog` can compose sync local JSONL readers with future
  async/cloud stores.
- `D1ManagedEventLog` now exists as a concrete D1-compatible managed event
  backend with append, list, latest, count, stat, delete, and polling follow.
- `D1ManagedHarnessStateStore` now exists as a concrete D1-compatible backend
  for harness-private session state such as Flue's SDK session data.
- `DurableObjectSqlStore` now exists as a Cloudflare Durable Object
  SQLite-compatible metadata store. It reuses the existing synchronous
  `Store` contract and SQLite schema/migrations through a small `sql.exec()`
  adapter instead of introducing a parallel cloud-only metadata model.
- `CloudflareFlueDurableObject` now exists as a conventional Durable Object
  composition point. It owns DO SQLite metadata, D1-compatible managed events
  and harness state, an R2-compatible workspace, and the shared Worker-style
  OMA HTTP handler without requiring Docker shims.
- `createCloudflareFlueWorkerRouter` now exists as the public Worker-side
  router. It forwards requests to a named coordinator Durable Object instead
  of letting each Worker isolate create its own metadata store.
- `ManagedRunScheduler` now exists as the router boundary for background run
  kickoff. The default `InlineRunScheduler` preserves the current local
  fire-and-forget behavior.
- `CloudflareWorkflowRunScheduler` now exists as the Cloudflare scheduling
  adapter. A Durable Object with `OMA_RUN_WORKFLOW` configured creates a
  Workflow instance from the managed run request instead of executing the run
  inline inside the HTTP request path.
- `AgentRouter.executeScheduledRun()` now exists as the re-entry point for
  out-of-process schedulers. It executes a previously admitted run without
  calling `beginRun()` or mutating the queue again, and treats repeated
  deliveries after the session leaves `starting`/`running` as idempotent skips.
- The Cloudflare Durable Object now exposes a token-protected internal
  `/_oma/internal/runs/execute` route. Workflow runners can post a
  `ManagedRunRequest` back to the coordinator without exposing Cloudflare ids
  in OMA's public API. Deployments that configure `OMA_RUN_WORKFLOW` must also
  configure `OMA_WORKFLOW_INTERNAL_TOKEN`; otherwise the Durable Object fails
  loudly instead of enqueueing runs that cannot execute.
- `runCloudflareManagedRunWorkflow()` now exists as a type-light Workflow
  runner helper. It wraps coordinator re-entry in a retryable Workflow step
  while letting semantic run failures become managed session failures instead
  of blindly retrying user turns.
- `ConfigurableCloudflareFlueDurableObject` now preserves the same
  token-protected Workflow re-entry route as the conventional Durable Object.
  Custom Flue composition roots can inject their own engine/app without losing
  scheduled-run execution, and local coverage now proves a scheduled Flue prompt
  run through that path.
- The Cloudflare example now starts under `wrangler dev --local` far enough to
  serve `/healthz`, create Flue agents, schedule a Workflow-backed run, and
  reach Flue SDK model resolution. The remaining local failure with the smoke
  `test/model` input is an expected unknown-model error, not a missing SDK or
  Worker boot failure.
- The Flue SDK bridge now maps OMA-managed provider credentials into Flue
  `configureProvider()` calls. `OMA_PASSTHROUGH_ENV_JSON` and direct
  Cloudflare secrets such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and
  `MOONSHOT_API_KEY` are treated as managed harness configuration rather than
  relying on ambient `process.env`. Deployments can also pass
  `OMA_FLUE_PROVIDER_CONFIG_JSON` for gateway/base URL overrides.
- The Cloudflare Flue stack can now register the Workers AI binding with
  Flue's native `cloudflare/<model>` provider prefix. The example declares
  `[ai] binding = "AI"` and passes the binding through OMA instead of relying
  on Flue's generated entrypoint.
- OMA now assigns a stable managed run id at turn admission and preserves it
  through queued turns, Workflow-backed re-entry, HTTP responses, Flue
  `createFlueContext()`, streamed events, and normalized Flue lifecycle event
  mapping. This gives the managed layer a durable control-plane handle before
  run-level abort/status APIs are added.
- `ManagedEventLog.stateRoot` is now optional, so cloud event stores no longer
  need to fake a local filesystem path.
- Harness adapters now declare a runtime mode. Existing adapters remain
  `container` mode, while future native adapters can run turns without
  `buildSpawnOptions`, Docker warm-up, or a `baseUrl`/token endpoint.
- `AgentRouter` can start blocking and streaming turns for native harnesses
  without acquiring a container. Native harnesses must still emit/append managed
  events so the normal OMA session accounting path can prove turn advancement.
- `FlueHarnessAdapter` now exists as an opt-in native prompt driver. It runs
  blocking and streamed Flue prompt turns through an SDK bridge, emits managed
  `user.message` / `agent.message` boundary events, maps selected Flue thinking
  and tool runtime events, preserves Flue `run_start` / `run_end` lifecycle
  events as OMA `session.run_start` / `session.run_end`, streams Flue text
  deltas as OpenAI-compatible chat chunks, appends normalized managed events
  while streamed turns are still running, cancels active prompt calls with
  Flue's native `AbortSignal` path, persists Flue session data through
  OMA-managed harness state, and fails loudly for unsupported OMA tool mapping.
  Local and D1-compatible stores both exist for the same harness-state contract;
  the Cloudflare stack uses the D1-compatible placement.

Started upstream in Flue:

- Task/run telemetry is being shaped as Flue-native runtime behavior, not as an
  OMA-only patch. OMA should keep mapping those events into its normalized
  `Event` model once the Flue surface stabilizes.

Still open:

- `ManagedEventLog.stateRoot` still exists as an optional legacy local-Docker
  escape hatch.
- The Flue harness driver is prompt-only: task/shell cancellation, MCP, tool
  approvals/deny policy, Cloudflare-backed Flue session persistence, and
  first-class OMA child sessions for Flue tasks are not wired yet.
- Cloudflare deployment wiring exists as an experimental example in
  `examples/cloudflare-flue`, but it is not promoted: there is no live
  Workflow deployment test, Flue task run, sandbox-backed shell/build task, or
  replay-after-hibernation proof yet.

## Non-Decision

Do not turn Flue into the managed-agent control plane.

Flue should remain the portable harness framework. OMA should own the managed
contract. Cloudflare should own the default high-scale substrate. Keeping those
layers separate is the whole point of the open "Android" path:

```text
Flue writes the agent.
Cloudflare runs it cheaply at scale.
OMA makes it managed, durable, inspectable, and harness-portable.
```

## Why This Does Not Contradict OMA

The existing OMA product model is already the right shape:

```text
Agent      reusable harness/model/policy template
Environment runtime/workspace/network template
Session    durable managed execution context
Event      normalized public history
Harness    native agent brain behind an adapter
Runtime    execution substrate behind the managed contract
```

The current implementation is too Docker-shaped, not architecturally wrong.

Docker-specific assumptions that must move behind a runtime boundary:

- `SpawnOptions` describes container images, mounts, ports, DNS, labels, and
  Docker networks.
- `Container` assumes `baseUrl` + bearer token invocation.
- `SessionContainerPool` assumes live containers can be warmed, adopted, and
  listed by Docker label.
- legacy local file/event paths assume the orchestrator can read a local
  `stateRoot` filesystem path.
- Limited networking is implemented with Docker bridge networks and an
  egress-proxy sidecar.
- Workspace operations assume host bind mounts.

Those assumptions are correct for the Docker backend. They are not the managed
runtime contract.

## Proper Refactor

Introduce a managed session runtime boundary above Docker containers.

```text
AgentRouter
  -> ManagedSessionRuntime
       acquire(session, harness, environment) -> RuntimeLease
       invoke / stream / cancel / compact through harness driver
       read logs
       release runtime resources
```

The boundary should split four concerns that are currently braided together:

| Concern | Current Docker form | Cloudflare form |
| --- | --- | --- |
| Runtime lifecycle | `SessionContainerPool` + Docker containers | Durable Object + Workflow + optional Sandbox |
| Harness invocation | HTTP/WS to in-container gateway | Flue handler/session/task API inside Worker/DO |
| Workspace state | host bind mount under `stateRoot` | Artifacts/R2/DO SQLite-backed filesystem |
| Event source | Pi/OpenClaw JSONL read-through | OMA normalized event store + Flue run hooks |

The first code step is not to delete `SessionContainerPool`. It is to make it
one implementation of a broader `ManagedSessionRuntime` contract. Docker keeps
passing every existing test while the Cloudflare runtime is built beside it.

## Target Runtime Shape

```ts
type RuntimeLease = {
  backend: "docker" | "cloudflare";
  sessionId: string;
  harnessId: string;
  endpoint?: { baseUrl: string; token: string };
  metadata: Record<string, unknown>;
};

interface ManagedSessionRuntime {
  acquireForSession(args: AcquireSessionRuntimeArgs): Promise<RuntimeLease>;
  warmForAgent?(agentId: string, spec: unknown): Promise<void>;
  dropWarmForAgent?(agentId: string): Promise<void>;
  evictSession(sessionId: string): Promise<void>;
  getControlClient(sessionId: string): unknown | undefined;
  readLogs(sessionId: string, opts?: { tail?: number }): Promise<string | undefined>;
}
```

`RuntimeLease.endpoint` exists for Docker and adapter-server harnesses. A
Cloudflare-native Flue harness can use bindings or Durable Object stubs instead.

## Flue Harness Driver

Flue should be integrated as a harness, not as a fake Docker container.

Correct shape:

```text
FlueHarnessDriver
  -> accepts an OMA session id
  -> creates / resumes a Flue agent session
  -> calls prompt / skill / task / shell / fs
  -> emits normalized OMA events
  -> reports usage and selected model
  -> supports cancellation through AbortSignal where Flue supports it
```

This implies a Flue contribution track. We should contribute upstream where the
harness needs stronger primitives, not where OMA can paper over gaps.

## Flue Discussion / Contribution Track

Bring these to Flue, in this order:

1. **Run lifecycle hooks / event stream**
   - Need: `prompt`, `skill`, `task`, and `shell` should expose structured
     lifecycle events.
   - Why Flue should care: product developers need observability even without
     OMA. This matches Fred's existing direction around task telemetry and
     thinking streams without adding an enterprise control plane.
   - OMA use: map Flue-native events into normalized `Event`.

2. **Task lineage**
   - Need: every `session.task()` should have stable `taskId`, parent session,
     role, cwd, model, usage, start/end/error status.
   - Why Flue should care: tasks are Flue's subagent primitive. They need
     enough structure to debug and account for delegated work.
   - OMA use: preserve parent/child run relationships without inventing a
     separate subagent model.

3. **Pluggable session persistence deltas**
   - Need: persistence hooks that can save append/update/delete deltas without
     forcing full-session replacement on every change.
   - Why Flue should care: durable sessions need efficient stores on DO SQLite,
     Postgres, D1, Redis, and object stores.
   - OMA use: DO SQLite and managed event stores can stay append-oriented.

4. **Abort semantics**
   - Need: `AbortSignal` should be consistently honored across prompt, skill,
     task, shell, and connector paths.
   - Why Flue should care: this is a standards-based primitive, not a custom
     control plane.
   - OMA use: managed cancellation maps cleanly to Flue calls.

5. **Sandbox connector truthfulness**
   - Need: connector docs/tests should state which providers support cwd, env,
     timeout, mid-flight abort, persistent filesystem, and cleanup.
   - Why Flue should care: Fred has already rejected fake parity. This keeps
     the connector ecosystem honest.
   - OMA use: capability gates can be derived from real connector behavior.

Do not ask Flue to add `Agent / Environment / Session / Event` as OMA public
resources. That is OMA's layer.

## Cloudflare Runtime Design

Cloudflare runtime should not imitate Docker.

Recommended shape:

```text
Cloudflare Worker API
  -> OMA route handlers
  -> Durable Object per managed session
       session status, queue, normalized event log, Flue session metadata
  -> Workflow per long-running run
       retries, sleeps, durable background execution
  -> Flue harness
       programmable agent loop
  -> execution hands
       Dynamic Workers for fast JS/TS tool code
       Cloudflare Sandboxes for Linux builds/tests/browser work
  -> workspace
       Artifacts for versioned repo state
       R2 for large blobs
  -> egress/secrets
       Outbound Workers inject credentials outside the sandbox
```

Key rule: Cloudflare backend must preserve OMA's public contract. It must not
leak Durable Object ids, Workflow ids, Sandbox ids, or Cloudflare-specific
workspace ids into the public session identity.

## Migration Plan

1. [x] Name the runtime boundary.
   - Add `ManagedSessionRuntime` types.
   - Make `SessionContainerPool` structurally satisfy the contract.
   - Stop `AgentRouter` from reaching directly into `pool.runtime`.
   - Let runtime leases describe non-Docker platforms without requiring
     container id/name/network fields.
   - Add a native-only runtime implementation for native harness composition
     roots.

2. [x] Make the event/workspace boundary async-friendly.
   - Add `ManagedWorkspace` so workspace file APIs stop reaching through
     `ManagedEventLog.stateRoot`.
   - Keep `OpenClawJsonlEventLog` for Docker/OpenClaw.
   - Add async-friendly managed event log shape for Cloudflare.
   - Migrate router/server call sites to await managed event operations while
     allowing local JSONL readers to stay synchronous internally.
   - Add a D1-compatible managed event backend.

3. [x] Make harness invocation non-container-capable.
   - Add a `container | native` harness runtime mode.
   - Keep Docker spawn options optional at the interface boundary.
   - Require `baseUrl`/token only inside endpoint-backed adapters.
   - Skip container warm/acquire for native blocking and streaming turns.

4. [x] Add Flue harness driver locally.
   - Start with Node execution against Flue's API.
   - Emit normalized events at prompt boundaries first.
   - Add a capability-honest adapter surface that does not fake task/shell
     cancellation, tool policy, MCP, or first-class task sessions.
   - Route OMA prompt cancellation into Flue's native `AbortSignal` path.
   - Persist Flue session data through OMA-managed local harness state instead
     of process memory.
   - Stream Flue prompt text deltas as OpenAI-compatible chat chunks and append
     live OMA events during streamed turns.
   - Add a D1-compatible managed harness-state backend for cloud placement.

5. [ ] Deepen Flue driver parity.
   - Wire Flue session persistence to Cloudflare runtime bindings.
   - Extend cancellation semantics beyond prompt calls.
   - Decide how Flue task lineage maps to OMA child sessions.

6. [ ] Add Cloudflare runtime prototype.
   - [x] Add a router factory that wires D1 event/state stores, Flue, and a
     native-only runtime without Docker compatibility shims.
   - [x] Add an R2-compatible managed workspace backend.
   - [x] Add a Worker-style fetch handler factory around the Cloudflare/Flue
     stack.
   - [x] Add a DO-SQL-compatible metadata store adapter.
   - [x] Add a Durable Object fetch composition class around DO metadata, D1,
     R2, and the shared HTTP handler.
   - [x] Add a Worker-side router that forwards public requests to a named
     coordinator Durable Object.
   - [x] Add a scheduler boundary for background run kickoff.
   - [x] Add a Workflow scheduling adapter for Cloudflare bindings.
   - [x] Add a Workflow execution callback/runner that resumes the scheduled
     run through the coordinator Durable Object.
   - [x] Add token-gated internal coordinator re-entry for scheduled runs.
   - [x] Keep Workflow re-entry available for configurable Cloudflare/Flue
     Durable Object composition roots.
   - [x] Add R2-compatible workspace binding in the Cloudflare deployment
     example.
   - [x] Add experimental `wrangler.toml` deployment wiring.
   - [ ] Promote production `wrangler.toml` only after live Cloudflare smoke
     coverage.
   - [x] No Docker compatibility shims.

7. [ ] Promote Cloudflare runtime only after it proves:
   - durable event replay after restart/hibernation;
   - cancellation path;
   - queued turns;
   - one Flue prompt run;
   - one Flue task run;
   - one sandbox-backed shell/build task;
   - no public Cloudflare ids in API responses.

## Success Criteria

The flagship architecture becomes:

```text
OMA control plane
  + Flue harness
  + Cloudflare session runtime
```

The default self-hosted architecture remains:

```text
OMA control plane
  + OpenClaw/Codex/Hermes/Claude SDK harnesses
  + Docker session runtime
```

Both must satisfy the same public `Agent / Environment / Session / Event`
contract. That is the product.
