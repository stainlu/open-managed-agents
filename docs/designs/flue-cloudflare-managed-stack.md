# Flue + Cloudflare Managed Stack

Status: target architecture plus current implementation progress, current as of
2026-05-11.

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
- `ManagedWorkspace` now exists in `src/workspace/types.ts`.
- `LocalManagedWorkspace` preserves the current Docker/OpenClaw workspace
  layout while keeping router workspace CRUD off the event-log `stateRoot`.
- `ManagedEventLog` methods are now awaitable, and router/server call sites
  await event reads, writes, stats, and deletes.
- `CompositeManagedEventLog` can compose sync local JSONL readers with future
  async/cloud stores.
- `D1ManagedEventLog` now exists as a concrete D1-compatible managed event
  backend with append, list, latest, count, stat, delete, and polling follow.
- `D1ManagedHarnessStateStore` now exists as a concrete D1-compatible backend
  for harness-private session state such as Flue's SDK session data.
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
  and tool runtime events, streams Flue text deltas as OpenAI-compatible chat
  chunks, appends normalized managed events while streamed turns are still
  running, cancels active prompt calls with Flue's native `AbortSignal` path,
  persists Flue session data through OMA-managed local harness state, and fails
  loudly for unsupported OMA tool mapping. A D1-compatible store exists for the
  same harness-state contract, but it is not wired into a Cloudflare runtime yet.

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
- The Cloudflare runtime prototype does not exist yet, so the D1-compatible
  event store is not wired into a production Cloudflare runtime path.

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
   - DO-backed session state.
   - Workflow-backed run execution.
   - R2 or Artifacts workspace.
   - No Docker compatibility shims.

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
