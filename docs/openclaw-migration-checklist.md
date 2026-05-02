# OpenClaw Migration Checklist

This checklist defines what we keep from `openclaw-managed-agents`, what we
generalize, and what we stop treating as product-core while turning the codebase
into Open Managed Agents.

The rule:

> Keep managed-agent infrastructure. Generalize harness-specific assumptions.

## Keep As Product Core

These pieces are not OpenClaw-specific. They are the managed-agent layer.

| Area | Keep | Reason |
|---|---|---|
| Public API shape | Agents, environments, sessions, events, logs, cancel, approvals, OpenAI-compatible chat | This matches the Claude Managed Agents product surface |
| Durable session metadata | SQLite-backed agent/session/environment/queue state | Needed for restart, adoption, and SDK stability |
| Session queue | Per-session durable FIFO for events posted during active runs | Managed sessions must serialize work consistently |
| Runtime pool | Active containers, warm containers, cap/eviction, adoption, idle reap | This is the core managed runtime machinery |
| Container runtime interface | `ContainerRuntime` seam plus Docker implementation | Docker is default; cloud backends should plug in here |
| Managed event API | Normalized event listing and SSE stream | Clients need one event model across harnesses |
| Capability catalog | `GET /v1/harnesses` | Clients must know what a harness can actually do |
| Capability gates | Router rejects unsupported features before mutation | Prevents fake parity and accidental silent fallback |
| Auth/rate limit | Shared bearer token, rate limiting, health/metrics bypasses | Deployment boundary remains useful across harnesses |
| Metrics/logging | Structured logs, request/session/agent context, Prometheus metrics | Managed agents need operational visibility |
| Credential allowlist | Explicit passthrough env keys and vault path | Credential injection must stay controlled |
| SDKs | Python and TypeScript clients over the public API | SDKs should not depend on the native harness |

## Keep As OpenClaw Adapter

These are valuable, but they belong behind the `openclaw` adapter boundary.

| Area | Keep Behind Adapter | Adapter Responsibility |
|---|---|---|
| OpenClaw runtime image | `Dockerfile.runtime`, entrypoint, provider config scripts | Build one OpenClaw session container |
| OpenClaw HTTP turn call | Container `/v1/chat/completions` | Implement OpenClaw `invokeTurn` |
| Gateway WebSocket | cancel, patch, approval list/resolve, event subscription | Implement OpenClaw control plane |
| Pi/OpenClaw JSONL parsing | `OpenClawJsonlEventLog` | Normalize native events into managed events |
| Confirm-tools plugin | OpenClaw `always_ask` implementation | One approval backend, not the approval contract itself |
| `openclaw-call-agent` CLI | OpenClaw-specific subagent tool | One implementation of managed subagents |
| OpenClaw model/provider config | OpenClaw env/config file generation | Adapter-local provider setup |

## Generalize

These came from the OpenClaw port but should be harness-agnostic.

| Old Assumption | New Shape | Status |
|---|---|---|
| Session uses OpenClaw/Pi session key | Session stores `harnessId` plus adapter-owned native metadata | Done |
| Router directly knows OpenClaw gateway WS | Router asks the harness adapter/control client | Done |
| Events are only Pi JSONL | Events flow through `ManagedEventLog` | Done |
| Agent container is always OpenClaw | `HarnessAdapter.buildSpawnOptions()` chooses image/env/mounts | Done |
| Provider env keys are OpenClaw-only | `collectPassthroughEnv()` supports multiple harnesses/providers | In progress |
| Approvals mean OpenClaw plugin approvals | `agent.tool_confirmation_request` is the public event contract | In progress |
| Subagents mean OpenClaw CLI tool | Subagents are managed sessions; harness adapter supplies tool bridge | In progress |
| Runtime env names are `OPENCLAW_*` | New protocol pieces use `OMA_*`; legacy names remain for compatibility | In progress |
| Warm pool applies to every agent | Adapter/session config decides whether warm pool is safe | Done |
| Usage comes from OpenClaw transcript | Adapter returns usage or managed fallback records it | In progress |

## Replace Or Remove

These should not remain product-core in Open Managed Agents.

| Pattern | Replacement |
|---|---|
| Hard-coded OpenClaw adapter construction in router/index | `HarnessRegistry` and adapter factories |
| Public docs implying OpenClaw is the only agent harness | Harness-neutral docs with OpenClaw as production adapter |
| Silent fallback from one harness/provider to another | Loud failure with capability/error detail |
| Unscoped provider env scraping | Explicit passthrough allowlist and vault credentials |
| Treating native session ids as public ids | Managed session id is public; native ids are metadata |
| Treating runtime as the product | Product is managed-agent layer; runtime is substrate |

## Current Adapter Promotion State

| Harness | Current State | Promotion Blockers |
|---|---|---|
| OpenClaw | Production/default | Keep improving restart/approval live coverage |
| Codex | Experimental but live two-turn recall passed previously | Live feature-matrix rerun needs OpenAI key in compose env |
| Claude Agent SDK | Experimental but live two-turn recall passed previously | Live feature-matrix rerun needs Anthropic key in compose env |
| Hermes | Experimental; conformance passes | Needs valid Kimi credential for live two-turn recall; arbitrary approval/MCP/compaction/subagent parity incomplete |

## Done Criteria For Migration

Open Managed Agents is no longer just a renamed OpenClaw runtime when:

1. The default OpenClaw path still passes production E2E.
2. At least two non-OpenClaw harnesses pass provider-backed two-turn recall.
3. Capability gates prevent fake parity for every adapter.
4. Restart/resume and respawn checks pass for at least one adapter-server
   harness.
5. Docs describe the managed-agent contract, not only OpenClaw internals.
6. New adapter work starts from `HarnessAdapter` and `oma.adapter.v1`, not from
   router-specific special cases.
7. Strategy records remaining harness-specific gaps honestly.

## Next Migration Work

- Restart compose with `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`, then rerun
  `pnpm test:e2e-feature-matrix`.
- Add `KIMI_API_KEY` or `KIMI_CODING_API_KEY`, then run Hermes live two-turn
  recall.
- Extend restart/respawn E2E to default to an adapter-server harness once live
  credentials are available.
- Decide whether non-OpenClaw approval live tests should be separate harness
  tests or part of the feature matrix.
- Keep cloud backend work behind `ContainerRuntime`; do not let it leak into
  harness adapters.
