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

## Near-Term Architecture Direction

Keep the working OpenClaw behavior while extracting these behind an adapter:

- OpenClaw spawn env/config construction
- OpenClaw gateway HTTP turn invocation
- OpenClaw gateway WebSocket control client
- Pi/OpenClaw JSONL event reader
- OpenClaw confirm-tools approval implementation

The next real adapter is Hermes, preferably through Hermes ACP, not CLI scraping.

## Editing Rules

- Keep `/Users/stainlu/claude-project/openclaw-managed-agents` untouched unless
  the user explicitly asks to edit it.
- `strategy.md` is local-only and must remain gitignored.
- Avoid generic abstractions that fake parity across harnesses. Add capability
  gates and fail loudly for unsupported operations.
- Preserve the current tests during the baseline port before doing deeper
  extraction.
