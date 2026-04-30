# AGENTS.md

Open Managed Agents is the harness-agnostic managed-agent layer extracted from
`openclaw-managed-agents`.

## Current Implementation State

This repo starts as a baseline port of `openclaw-managed-agents`. The first
working adapter is still OpenClaw, so many runtime environment variables and
container internals intentionally remain `OPENCLAW_*`.

Do not rename those adapter-level variables to `OMA_*` until the harness adapter
boundary exists.

## Product Target

Open Managed Agents is the open implementation of Claude Managed Agents-style
primitives for multiple agent harnesses:

- `Agent`
- `Environment`
- `Session`
- `Event`

The managed layer owns sessions, environments, event logs, isolation, queues,
policy, credentials, recovery, observability, and public API shape.

The harness owns the agent loop.

## Architecture Direction

Keep the working OpenClaw behavior behind an adapter:

- OpenClaw spawn env/config construction
- OpenClaw gateway HTTP turn invocation
- OpenClaw gateway WebSocket control client
- Pi/OpenClaw JSONL event reader
- OpenClaw confirm-tools approval implementation

Hermes is the second adapter. The production boundary is a small in-container
`oma.adapter.v1` HTTP/SSE server that imports Hermes `AIAgent` directly.

Do not integrate Hermes by scraping CLI output. Do not treat Hermes ACP as the
managed-agent control plane. ACP is useful reference code for persistence and
cancellation, but direct `AIAgent` gives the adapter the real session DB,
callbacks, interrupt path, model/runtime resolver, and usage payload without
nesting another protocol.

Current Hermes limitations should stay explicit:

- permission `deny` maps to Hermes disabled toolsets;
- permission `always_ask` is only backed by Hermes terminal dangerous-command
  approval today, not arbitrary pre-tool approval for every Hermes tool;
- MCP, compaction, and subagent delegation are not wired for Hermes yet.

## Editing Rules

- Keep `/Users/stainlu/claude-project/openclaw-managed-agents` untouched unless
  the user explicitly asks to edit it.
- `strategy.md` is local-only and must remain gitignored.
- Avoid generic abstractions that fake parity across harnesses. Add capability
  gates and fail loudly for unsupported operations.
- Preserve the current tests during the baseline port before doing deeper
  extraction.
