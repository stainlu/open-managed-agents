# Open Managed Agents

Open Managed Agents is the open managed-agent layer for multiple agent
harnesses.

It targets the Claude Managed Agents product shape: `Agent`, `Environment`,
`Session`, and `Event` primitives; durable sessions; isolated execution;
streaming event history; tool policy; cancellation; recovery; and observability.

The current implementation is a baseline port of `openclaw-managed-agents`.
OpenClaw is the first working harness adapter. Hermes is the next target adapter.

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
- Limited networking sidecar.
- Subagents as first-class sessions.

Not done yet:

- Generic `HarnessAdapter` interface.
- Managed JSONL event log abstraction.
- Hermes adapter.
- Codex adapter.
- Claude Agent SDK adapter.

## Architecture Direction

```text
Client / SDK
  -> Open Managed Agents API
  -> managed-agent layer
       agents, environments, sessions, events, queues, policy, credentials
  -> harness adapter
       OpenClaw first, Hermes next
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

The baseline still uses `OPENCLAW_*` environment variables internally because
the only working adapter is OpenClaw. Those names should move behind the adapter
boundary before adding `OMA_*` platform-level configuration.

## Strategy Notes

`strategy.md` is intentionally gitignored. It is the local working strategy doc
for this project.
