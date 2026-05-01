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
- Generic `HarnessAdapter` interface.
- Public `/v1/harnesses` capability catalog.
- Managed JSONL event log abstraction.
- Experimental Hermes adapter runtime via direct `AIAgent` integration.
- Experimental Codex adapter runtime via `codex app-server`.
- Experimental Claude Agent SDK adapter runtime via `@anthropic-ai/claude-agent-sdk`.
- Limited networking sidecar.
- Subagents as first-class sessions.

Not done yet:

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
```

Local full stack:

```bash
pnpm docker:build
docker compose up --build -d
```

Some runtime internals still use `OPENCLAW_*` names for compatibility with the
OpenClaw adapter and existing deployment scripts. New harness-neutral adapter
protocol pieces use `OMA_*`.

## Strategy Notes

`strategy.md` is intentionally gitignored. It is the local working strategy doc
for this project.
