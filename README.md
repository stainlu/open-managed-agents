# Open Managed Agents

Open Managed Agents is the open managed-agent layer for multiple agent
harnesses.

It targets the Claude Managed Agents product shape: `Agent`, `Environment`,
`Session`, and `Event` primitives; durable sessions; isolated execution;
streaming event history; tool policy; cancellation; recovery; and observability.

The current implementation is a baseline port of `openclaw-managed-agents`
with the first harness boundary extracted. OpenClaw is the production adapter.
Hermes, Codex, and Claude Agent SDK are wired as experimental adapters.

## Positioning

```text
Claude Managed Agents:
  closed managed-agent platform for Claude

Open Managed Agents:
  open managed-agent layer for OpenClaw, Hermes, Codex, Claude Agent SDK,
  and future harnesses
```

OpenRouter made model providers interchangeable behind one API.

Open Managed Agents aims to make managed agent harnesses interchangeable behind
one operational boundary.

Layering rule:

```text
client / SDK
  -> Open Managed Agents managed layer
       Agent / Environment / Session / Run / Event
       queues, policy, credentials, cancellation, recovery, observability
  -> harness layer
       Flue, OpenClaw, Hermes, Codex, Claude Agent SDK
  -> runtime / cloud substrate
       Docker, Cloudflare Workers/DO/Workflows/Sandboxes/R2/D1, future clouds
```

Flue is a preferred AI-native harness/runtime path, not a replacement for the
managed-agent control plane. OMA keeps the cross-harness public contract while
Flue owns its native agent loop, sessions, tasks, shell, MCP, and runtime
events.

## Current Status

This repo is in the baseline-port phase.

Working today:

- Hono/TypeScript orchestrator.
- SQLite metadata store.
- OpenClaw per-session container runtime.
- Active and warm container pools.
- Session queueing.
- SSE event streaming.
- OpenAI-compatible `/v1/chat/completions` shim.
- Tool permission policies and approvals for the OpenClaw adapter.
- Pending tool approval records are owned by the managed store, with SQLite
  durability across orchestrator restarts, direct public list/resolve APIs, and
  in-memory behavior for tests.
- Generic `HarnessAdapter` interface.
- Public `/v1/harnesses` capability catalog.
- Managed JSONL event log abstraction.
- Managed session runtime boundary over the Docker pool.
- Managed workspace boundary separated from event-log storage.
- R2-compatible managed workspace backend for object-store session files.
- Awaitable managed event-log contract used by the router and HTTP API.
- Optional event-log `stateRoot` so cloud stores do not fake local paths.
- D1-compatible managed event-log backend for cloud stores.
- D1-compatible managed harness-state backend for cloud stores.
- Harness runtime mode boundary: container adapters still use managed runtime
  endpoints, while native adapters can run turns without Docker spawn options.
- Runtime leases can represent non-Docker platforms with endpoint metadata
  instead of requiring Docker container fields.
- Native-only managed session runtime for stacks that run through native
  harnesses instead of endpoint-backed containers.
- Cloudflare/Flue router factory that wires D1-compatible event/state stores,
  optional R2-compatible workspace, the Flue harness, and native-only runtime
  behind OMA boundaries.
- Cloudflare/Flue Worker-style fetch handler factory that reuses the same OMA
  Hono API surface with explicit platform bindings.
- Cloudflare/Flue Durable Object composition class for DO SQLite metadata, D1
  events/state, R2 workspace, and Workflow-backed run kickoff.
- Cloudflare/Flue Worker router, Workflow runner helper, and experimental
  `examples/cloudflare-flue` deployment scaffold.
- The Cloudflare/Flue example includes an opt-in, token-gated Sandbox
  shell/build smoke that verifies workspace fixture writes, sandbox execution,
  generated artifacts, and deletion sync-back through the managed workspace
  executor.
- The Cloudflare/Flue example also includes an opt-in, token-gated Flue task
  smoke route that invokes real Flue `session.task()` through the OMA Flue
  adapter and verifies normalized task lineage.
- The Cloudflare/Flue promotion smoke requires OMA state readback through the
  public API: session metadata, managed run records, event history, run-tree
  projection, workspace listings, and workspace file content.
- Cloudflare/Flue health now exposes a sanitized runtime-readiness block, and
  promotion/replay verifiers require the Cloudflare/Flue native stack plus
  metadata, database, workspace, Workflow, Workers AI, and Sandbox bindings to
  be configured without leaking platform ids.
- The Cloudflare/Flue example includes a two-phase live replay smoke so a real
  deployment can seed OMA state before an operator/CI-triggered restart or
  Durable Object hibernation, then verify the same public state afterward. A
  replay-report verifier requires the real restart/hibernation action to be
  recorded before the report can count as promotion evidence.
- OMA-managed run ids are assigned when a turn is accepted and preserved
  through session queues, Workflow-backed re-entry, server responses, and Flue
  run/event mapping.
- Managed runs are now durable control-plane records. OMA records queued,
  starting, running, terminal, and cancelled run status in the metadata store
  and exposes session-scoped run list/get/abort APIs and SDK methods.
- Managed subagent/session lineage is now inspectable through direct child
  listing and recursive session-tree APIs. This is OMA-owned session topology,
  separate from harness-local task/run lineage.
- Managed session trees can be cancelled explicitly, with aggregate per-session
  results for cancelled, skipped, and failed descendants.
- Managed session trees can be deleted explicitly, with child-first aggregate
  cleanup results instead of orphaning known descendants.
- `/healthz` exposes sanitized runtime readiness for both the default
  self-hosted container path and the Cloudflare/Flue path, so operators can see
  the active substrate without exposing platform ids or secrets.
- Experimental Flue native harness driver, opt-in via
  `OMA_ENABLE_FLUE_HARNESS=1`, including prompt turns, real Flue
  `session.task()` and `session.shell()` operations over OMA-managed
  workspaces, AbortSignal cancellation for active prompt/task/shell calls,
  OpenAI-compatible prompt
  streaming, live managed-event append, OMA-managed local Flue session
  persistence, and OMA-managed provider secret mapping into Flue provider
  configuration, including Cloudflare Workers AI binding registration for
  `cloudflare/<model>`. URL-based MCP servers are connected through Flue's
  MCP client, including OMA vault bearer injection, exact deny filtering, and
  exact or approve-all `always_ask` approval gates for Flue MCP tool names.
  OMA also enforces exact deny policy and exact or approve-all approval policy
  for Flue's built-in `bash` tool at the `SessionEnv.exec()` boundary; stdio
  MCP and other built-in Flue tool policy are still rejected. The
  bridge prefers Flue's runtime package name `@flue/runtime` and falls back to
  legacy `@flue/sdk`. As of 2026-05-13, `@flue/runtime` exists in Flue main
  after the package split but is not published on npm yet, so installable
  examples still pin the current published `@flue/sdk` package.
- Experimental Hermes adapter runtime via direct `AIAgent` integration.
- Experimental Codex adapter runtime via `codex app-server`.
- Experimental Claude Agent SDK adapter runtime via `@anthropic-ai/claude-agent-sdk`.
- Limited networking sidecar.
- Subagents as first-class sessions.

Not done yet:

- Full Flue parity: stdio MCP, built-in Flue tool deny/approval policy beyond
  OMA-controlled URL MCP tools and `bash`, and OMA first-class child sessions
  for Flue tasks.
- Promoted production Cloudflare backend. The Durable Object, Worker router,
  Workflow runner, DO SQLite metadata store, D1 stores, R2 workspace backend,
  and example Wrangler wiring exist, but live deployment promotion is still
  gated on replay, run cancellation, queued turns, Flue task runs, and
  sandbox-backed shell/build work against a real deployment.
- Full Hermes parity: arbitrary pre-tool approvals, MCP, compaction, subagents.
- Full Codex parity: MCP, managed subagents, and per-tool deny policy.
- Full Claude Agent SDK parity: managed subagents, manual compaction, and complete MCP
  elicitation handling.

## Architecture Direction

```text
Client / SDK
  -> Open Managed Agents API
  -> managed-agent layer
       agents, environments, sessions, events, queues, policy, credentials
  -> harness adapter
       OpenClaw production, Hermes/Codex/Claude Agent SDK experimental
  -> runtime substrate
       Docker first, cloud backends later
  -> native harness
       OpenClaw, Hermes, Codex, Claude Agent SDK, ...
```

Adapter rule:

> Public API reads managed concepts. Native harness concepts stay adapter
> metadata.

## Development

Package manager: `pnpm`.

Node: `>=22.14.0`.

```bash
pnpm install
pnpm build
pnpm test
pnpm test:adapter-conformance
```

Local full stack:

```bash
pnpm docker:build
docker compose up --build -d
```

If another local stack already owns port 8080:

```bash
OPENCLAW_HOST_PORT=8081 docker compose up --build -d
BASE_URL=http://localhost:8081 pnpm test:e2e-harnesses
```

Live non-OpenClaw harness E2E:

```bash
pnpm test:e2e-harnesses
```

This checks Codex and Claude Agent SDK through the managed API. Hermes is
available as an opt-in live harness:

```bash
OMA_LIVE_HARNESSES=hermes pnpm test:e2e-harnesses
```

Hermes expects `KIMI_API_KEY` by default. If you only have a legacy Moonshot
key, export it as `KIMI_API_KEY` before starting compose. The script skips
harnesses whose provider key is not present; set `OMA_LIVE_REQUIRE=1` to run
anyway when the compose/orchestrator process already has server-side credentials.

Broader provider-backed feature matrix:

```bash
pnpm test:e2e-feature-matrix
OMA_FEATURE_TEST_APPROVAL=1 pnpm test:e2e-feature-matrix
```

The default matrix checks catalog enforcement, session lifecycle, streaming,
OpenAI-compatible named-session resume, and compaction behavior. The approval
flag enables live non-OpenClaw tool-approval checks, which are opt-in because
they depend on the native model choosing the requested tool call.

Some runtime internals still use `OPENCLAW_*` names for compatibility with the
OpenClaw adapter and existing deployment scripts. New harness-neutral adapter
protocol pieces use `OMA_*`.

Key docs:

- `docs/architecture.md`
- `docs/cloudflare-backend-promotion.md`
- `docs/managed-agent-contract.md`
- `docs/openclaw-migration-checklist.md`
- `docs/runtime-backend-positioning.md`

## Strategy Notes

`strategy.md` is intentionally gitignored. It is the local working strategy doc
for this project.
