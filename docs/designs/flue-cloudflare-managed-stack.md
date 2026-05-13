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
  `OMA_FLUE_PROVIDER_CONFIG_JSON` for gateway/base URL overrides. The bridge
  loads Flue runtime helpers from `@flue/runtime` when available and falls
  back to legacy `@flue/sdk`. `@flue/runtime` is the post-split package name
  in Flue main; until it is published on npm, OMA's installable examples keep
  the current published `@flue/sdk` dependency while the adapter probes the
  future runtime package first.
- The Flue SDK bridge now has real persistence coverage against Flue itself:
  a prompt turn stores Flue `SessionData` through OMA's
  `ManagedHarnessStateStore`, and a fresh adapter instance reloads the same
  managed session before appending another turn. This proves the bridge is not
  only wrapping the store API; the real Flue session path uses it.
- Local Cloudflare/Flue Durable Object coverage now proves the same Flue
  `SessionData` path through the D1-compatible harness-state binding across a
  simulated Durable Object restart. The restarted handler's next real Flue SDK
  call sees the previous user/assistant messages and then persists a longer
  session history back to D1.
- The Cloudflare Flue stack can now register the Workers AI binding with
  Flue's native `cloudflare/<model>` provider prefix. The example declares
  `[ai] binding = "AI"` and passes the binding through OMA instead of relying
  on Flue's generated entrypoint.
- OMA now assigns a stable managed run id at turn admission and preserves it
  through queued turns, Workflow-backed re-entry, HTTP responses, Flue
  `createFlueContext()`, streamed events, and normalized Flue lifecycle event
  mapping.
- OMA now persists managed run records in the metadata store. Runs carry
  queued/starting/running/terminal status, model/thinking metadata, errors, and
  timestamps, and the HTTP API exposes session-scoped run list/get/abort routes.
  This makes the run id a real control-plane handle rather than just a
  correlation id.
- Session event reads now accept `run_id` and `parent_run_id` filters, so Flue
  nested task and operation telemetry can be inspected without scanning the
  whole managed event log.
- `GET /v1/sessions/:id/run-tree` now derives an inspectable run tree from
  managed run records plus normalized run lineage events. This gives Flue tasks
  and operations a visible parent/child shape without pretending they are
  independently controllable managed child sessions.
- Local Cloudflare/Flue Durable Object coverage now proves the public run abort
  API against both active Flue prompt runs and queued Flue runs. Active abort
  reaches Flue's `AbortSignal`; queued abort removes only the queued run and
  leaves the active prompt running.
- Local Cloudflare/Flue Durable Object coverage now proves queued Flue turns
  drain correctly after the active prompt completes: the queued turn becomes a
  second succeeded managed run and its events remain inspectable by `run_id`.
- Local Cloudflare/Flue Durable Object coverage now proves restart replay over
  the same platform bindings: session metadata and managed run records survive
  in DO SQLite, run events survive in the D1-compatible event log, run-tree
  projection still has both managed-run and event-log sources, and the
  restarted object can continue the same session with another turn.
- Local Cloudflare/Flue Durable Object coverage now proves injected Flue task
  and operation lineage flows through the Cloudflare API shape: task and shell
  operation events appear as run-tree children and remain queryable by
  `parent_run_id`. This proves the managed projection, not yet a live
  sandbox-backed Flue task promotion proof.
- The native Flue SDK bridge can now mount OMA's `ManagedWorkspace` as the
  Flue `SessionEnv`. In the Cloudflare stack, Flue context discovery reads the
  same R2-compatible workspace that OMA exposes over the public workspace API:
  existing `AGENTS.md`, `.agents/skills/`, and project files are visible to
  Flue, and OMA instructions seed `AGENTS.md` only when the workspace does not
  already provide one.
- Local Cloudflare Durable Object coverage now proves the public workspace API
  and Flue SDK context share that filesystem: files written through
  `/v1/agents/:agentId/files/*` are visible to a real Flue prompt's model
  payload via AGENTS.md discovery, skill discovery, and directory listing.
- The managed Flue `SessionEnv` now has an explicit workspace command executor
  seam. Without an executor, shell remains disabled; with one, Flue shell calls
  run against a validated cwd inside the same `ManagedWorkspace` contract and
  the executor must make command-side file mutations visible before it returns.
  The Cloudflare stack factory accepts this executor so deployment code can
  inject a real sandbox backend without bypassing OMA's stack composition.
- The Flue SDK bridge now exposes real Flue `session.shell()` execution
  through OMA's Flue adapter. Shell operations go through Flue's own
  operation/tool event path, map back into normalized OMA run events, and use
  the same managed workspace command executor as model-driven shell calls.
- The Flue SDK bridge now exposes deterministic Flue `session.task()` execution
  through OMA's Flue adapter. This is deliberately a direct task invocation
  plus normalized task lineage, not a claim that Flue tasks are first-class OMA
  child sessions yet.
- Flue adapter cancellation now has explicit coverage beyond prompt turns:
  active direct task and shell operations both receive the same managed
  `AbortSignal` path used by prompt runs.
- `createCloudflareSandboxWorkspaceCommandExecutor` now exists as the first
  concrete backend for that seam. It resolves a Cloudflare Sandbox by stable
  managed session identity, mirrors OMA's managed workspace into the sandbox,
  runs the command through Sandbox `exec()` with millisecond timeout conversion,
  and syncs file changes back into the managed workspace while excluding
  heavyweight runtime directories such as `node_modules` and `.git`.
- The Cloudflare example now exports the Sandbox Durable Object class, binds a
  Sandbox container, and injects the sandbox-backed executor into the OMA
  coordinator. This is still experimental until a live shell/build smoke passes.
- The Cloudflare example smoke client can now require a deterministic
  sandbox-backed shell/build check. The check writes fixtures through OMA's
  public workspace API, calls a token-gated example-only smoke route that runs
  through real Flue `session.shell()` plus the managed workspace command
  executor, and verifies generated output plus deletions sync back to the
  managed R2 workspace. This is still a verifier until it is run against a
  live Cloudflare deployment.
- The Cloudflare example smoke client can also require a deterministic Flue
  task run through a token-gated example-only route. The route invokes real
  Flue `session.task()` through OMA's Flue adapter and checks that task
  lifecycle events survive as normalized OMA run lineage. This is still a
  verifier until it is run against a live Cloudflare deployment.
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
  and tool runtime events, preserves Flue `run_start` / `run_end`,
  `task_start` / `task`, and `operation_start` / `operation` lifecycle events
  as OMA `session.run_start` / `session.run_end`, streams Flue text deltas as
  OpenAI-compatible chat chunks, appends normalized managed events while
  streamed turns are still running, cancels active prompt calls with Flue's
  native `AbortSignal` path, persists Flue session data through OMA-managed
  harness state, connects URL-based MCP servers through Flue's MCP client with
  OMA vault bearer injection, enforces exact deny policy for those Flue MCP
  tool names, enforces exact or approve-all `always_ask` approval gates for
  those Flue MCP tool names, enforces exact deny policy and exact or approve-all
  approval policy for Flue's built-in `bash` tool at OMA's `SessionEnv.exec()`
  boundary, and fails loudly for unsupported OMA tool mapping, stdio MCP, and
  other built-in Flue tool policy.
  Local and D1-compatible stores both exist for the same harness-state contract;
  the Cloudflare stack uses the D1-compatible placement.

Started upstream in Flue:

- Task/run telemetry is being shaped as Flue-native runtime behavior, not as an
  OMA-only patch. OMA should keep mapping those events into its normalized
  `Event` model once the Flue surface stabilizes.
- Flue is adding its own run registry, read-only admin API, OpenAPI document,
  and remote SDK surface. OMA should treat those as harness-local/runtime-local
  capabilities that can make the Flue adapter thinner, not as a replacement for
  OMA-managed `Agent`, `Environment`, `Session`, `Run`, `Event`, queue,
  approval, credential, and recovery state.

OMA stance:

- OMA `run_id` is assigned before queueing, Workflow handoff, or harness
  invocation. It remains the public control-plane handle for abort, queue
  status, replay, and cross-harness event filtering.
- Flue run ids and Flue registry pointers are adapter metadata unless OMA
  explicitly records a mapping. They may enrich event lineage and debugging,
  but public clients should not need to know them.
- Flue's admin/OpenAPI/SDK surface is useful for direct Flue deployments. In an
  OMA deployment, the public API remains OMA's `/v1` managed-agent contract; a
  Flue-native admin route can be exposed only as a harness/runtime inspection
  surface, behind deployment auth, without changing OMA identifiers.
- If Flue gains a stable remote SDK for invoking deployed Flue agents, OMA can
  reuse it inside the Flue adapter. That is an implementation detail beneath
  `HarnessAdapter`, not a new public API layer.

Still open:

- `ManagedEventLog.stateRoot` still exists as an optional legacy local-Docker
  escape hatch.
- The Flue harness driver still does not map stdio MCP, built-in Flue tool
  deny/approval policy beyond OMA-controlled URL MCP tools and `bash`, or
  first-class OMA child sessions for Flue tasks.
  Current Flue task and operation telemetry is preserved as structured nested
  run events, direct Flue task and shell operations can be executed and mapped,
  but Flue tasks are not promoted to managed child sessions yet.
- Cloudflare deployment wiring exists as an experimental example in
  `examples/cloudflare-flue`, but it is not promoted. The OMA-level promotion
  gates live in `docs/cloudflare-backend-promotion.md`; they require live
  Workflow deployment proof, deterministic live active/queued run abort smoke,
  queued turns, Flue task execution, sandbox-backed shell/build execution,
  replay-after-hibernation proof, and no public Cloudflare platform ids.

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
   - Prove the real Flue SDK bridge saves and reloads session data through
     OMA-managed harness state across fresh adapter instances.
   - Stream Flue prompt text deltas as OpenAI-compatible chat chunks and append
     live OMA events during streamed turns.
   - Add a D1-compatible managed harness-state backend for cloud placement.

5. [ ] Deepen Flue driver parity.
   - [x] Wire Flue session persistence to Cloudflare runtime bindings.
   - [x] Extend cancellation semantics beyond prompt calls.
   - [x] Preserve current Flue task/operation/tool/compaction telemetry as
     normalized OMA events.
   - [x] Add a read-only run-tree projection over nested run events.
   - [x] Add local Cloudflare Durable Object coverage for Flue task/operation
     lineage through run-tree and `parent_run_id` event filters.
   - [x] Mount OMA's managed workspace into the real Flue SDK context so
     Cloudflare/R2 workspace files, `AGENTS.md`, and skills are the harness
     filesystem seen by Flue.
   - [x] Add local Cloudflare Durable Object coverage proving public workspace
     writes are visible to a real Flue SDK prompt through that mounted
     filesystem.
   - [x] Add an explicit command-executor seam for managed Flue workspaces so a
     future Cloudflare Sandbox/Dynamic Worker backend can supply real shell
     execution without replacing the Flue adapter or weakening the filesystem
     boundary.
   - [x] Thread that executor seam through the Cloudflare stack factory.
   - [x] Add a Cloudflare Sandbox-backed executor implementation for Flue shell
     calls that mirrors OMA workspace files into the sandbox and syncs command
     mutations back out.
   - [x] Route deterministic shell execution through real Flue
     `session.shell()` so OMA maps Flue's operation/tool events instead of
     bypassing the harness with raw `SessionEnv.exec()`.
   - [x] Route deterministic task execution through real Flue
     `session.task()` so OMA can prove task lineage through the harness without
     prematurely promoting Flue tasks to managed child sessions.
   - [x] Connect URL-based MCP servers through Flue's MCP client, including
     OMA vault bearer credential injection, while rejecting stdio/local MCP
     configs instead of silently ignoring them.
   - [x] Enforce exact deny policy for URL-MCP tools that OMA wires into Flue
     without claiming built-in Flue tool policy or approval parity.
   - [x] Enforce exact `always_ask` approval gates for URL-MCP tools that OMA
     wires into Flue, including native router approval resolution without a
     container control client.
   - [x] Enforce exact deny and `always_ask` approval gates for Flue's built-in
     `bash` tool at OMA's managed `SessionEnv.exec()` boundary.
   - Decide when Flue task lineage should graduate from an observable run tree
     to OMA child sessions with real lifecycle control.

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
   - [x] Add durable managed run records plus session-scoped run list/get/abort
     routes.
   - [x] Add local Durable Object coverage for active and queued Flue run abort
     through the public run API.
   - [x] Add local Durable Object coverage for queued Flue turn execution after
     the active prompt completes.
   - [x] Add local Durable Object restart coverage for session, run, event, and
     run-tree replay over the same DO SQLite, D1-compatible, and R2-compatible
     bindings.
   - [x] Add R2-compatible workspace binding in the Cloudflare deployment
     example.
   - [x] Add experimental `wrangler.toml` deployment wiring.
   - [x] Add experimental Cloudflare Sandbox binding/container wiring to the
     Cloudflare example.
   - [x] Add an example smoke client for local or deployed Worker URLs that
     proves health, harness catalog, Flue prompt run, event filtering, run-tree
     projection, and absence of public Cloudflare ids in OMA responses.
   - [x] Add an opt-in example smoke check for sandbox-backed shell/build
     execution and workspace sync-back.
   - [x] Add an opt-in example smoke check for real Flue task invocation and
     normalized task lineage.
   - [ ] Promote production `wrangler.toml` only after the live Cloudflare
     gates in `docs/cloudflare-backend-promotion.md` pass.
   - [x] No Docker compatibility shims.

7. [ ] Promote Cloudflare runtime only after
   `docs/cloudflare-backend-promotion.md` is complete and it proves:
   - durable event replay after restart/hibernation;
   - live active run cancellation path;
   - live queued run cancellation path;
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
