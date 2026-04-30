# Open Managed Agents Strategy

## Thesis

Open Managed Agents is the open managed-agent runtime layer.

Short version:

> OpenRouter for managed agents. Android for agent runtimes.

OpenRouter made model routing open, interchangeable, and price-competitive.
Open Managed Agents should do the same for managed agent execution: session lifecycle, sandboxing, tool policy, credentials, memory, event logs, delegation, observability, and runtime control.

The product is not "another agent framework." It is the managed layer above agent frameworks.

## Core Positioning

Managed-agent products are arriving from every major AI platform:

- Anthropic Claude Managed Agents
- Amazon Bedrock AgentCore / Managed Agents
- OpenAI Symphony / Codex orchestration
- Multica-style workspace agents
- proprietary vertical agent clouds

Their direction is correct: developers do not want to manually build secure agent hosting, persistent sessions, tool approval, isolation, observability, and cost controls.

Their problem is lock-in.

Open Managed Agents exists because developers need the same managed-agent substrate without being trapped inside one model vendor, one agent harness, one cloud, or one pricing curve.

## The Android Analogy

Apple model:

- one vendor controls hardware, OS, app runtime, distribution, and services
- tight integration
- high margins
- great experience
- constrained ecosystem

Android model:

- open runtime
- many hardware vendors
- many distribution channels
- many price points
- broad developer surface
- default path for everyone who cannot or will not live inside Apple's stack

Open Managed Agents should be Android-like:

- open-source
- framework-agnostic
- model-agnostic
- cloud-agnostic
- cheap to self-host
- embeddable by product companies
- opinionated enough to be useful

The goal is not to beat closed platforms on polish on day one.
The goal is to become the open substrate developers trust when they want to build real agent products.

## What We Mean By Managed Agents

A managed-agent runtime owns the operational layer around an agent harness.

It should own:

- durable sessions
- per-session sandbox lifecycle
- event log and replay
- tool execution policy
- human approval flow
- credentials boundary
- egress/network policy
- model routing and pricing
- cancellation/interruption
- background execution
- delegation/subagents
- warm pools and capacity controls
- observability and audit logs
- SDK/API compatibility

The agent harness should be replaceable.

OpenClaw, Codex, Claude Agent SDK, Hermes, Pi, OpenCode, and future frameworks should all become drivers under the same managed runtime contract.

## What This Is Not

Open Managed Agents is not:

- a chat UI
- an issue tracker
- a desktop workspace app
- a prompt queue
- a wrapper around many CLIs
- a new agent harness
- an OpenClaw fork
- a model router only

Those can exist on top.

The platform layer is the runtime substrate.

## First-Principles Definition Of Agent-Agnostic

There are three levels of "agent-agnostic."

### 1. Adapter-Agnostic

Can call many agent CLIs or SDKs through adapters.

This is useful, but shallow.

Example shape:

```text
task -> provider switch -> run claude/codex/openclaw/hermes -> normalize output
```

This is what Multica mostly does.

### 2. Harness-Agnostic Managed Runtime

Same managed-agent API works across different harnesses, while the managed layer still owns:

- lifecycle
- isolation
- event log
- control plane
- credentials
- policy
- cost
- observability

This is the real target.

Example shape:

```text
client -> managed session API -> runtime adapter -> isolated harness container
```

### 3. Semantics-Agnostic

Every harness behaves identically.

This is impossible.

Different harnesses have different capabilities. Some support native tool approvals. Some do not. Some support compaction. Some do not. Some expose rich event streams. Some only expose stdout.

The correct design is capability-gated agnosticism, not fake sameness.

## Multica Assessment

Multica is agent-agnostic as a workspace/task runner.

It detects installed local agent tools, registers a runtime per daemon/tool/workspace, dispatches tasks, prepares a local workdir, runs the selected CLI, and normalizes messages/results.

That is useful.

But it is not the same as agent-agnostic managed-agent infrastructure.

Multica's runtime is:

```text
user machine daemon x one installed AI coding tool
```

It is not a managed sandbox runtime.
It is not a cloud/session substrate.
It does not uniformly own security, session durability, event semantics, approval policy, egress, or credentials isolation across harnesses.

Sharp conclusion:

> Multica is agent-agnostic like Zapier is app-agnostic. It can call many things. It is not agent-agnostic like an OS kernel is hardware-agnostic.

This does not make Multica bad. It means it is playing a different game.

## Relationship To OpenClaw

OpenClaw is the flagship harness.

Open Managed Agents is the runtime layer.

OpenClaw gives:

- personal-agent identity
- broad tools and integrations
- open model/provider support
- strong brand direction: "my Claw"
- practical agent behavior for end-user-facing products

Open Managed Agents gives:

- safety
- durability
- policy
- isolation
- lifecycle
- cost control
- observability
- multi-harness portability

Product logic:

```text
end customers want personal agents
developers want to build personal-agent products
direct agent harnesses are unsafe/expensive to operate
closed managed-agent platforms are safe but locked and expensive
Open Managed Agents gives a safe, cheap, open runtime
OpenClaw is the default personal-agent experience on top
```

OpenClaw remains the wedge.
Open Managed Agents becomes the platform.

## Why Developers Choose This

The target developers are not agent-framework hobbyists.

They are builders of real agent products:

- personal assistant apps
- AI employee products
- vertical workflow agents
- coding/devops agents
- support agents with tools
- research agents
- finance/ops agents
- local-first or privacy-sensitive agents
- agent platforms that need hosted execution

They choose Open Managed Agents when they need:

- managed execution without model lock-in
- cheaper model routing
- OpenClaw/OpenRouter-style provider optionality
- stable per-user agent sessions
- tool safety
- auditability
- self-hosting
- embeddable APIs
- runtime control without building infra from scratch

They do not choose us because we have one more prompt API.
They choose us because operating autonomous agents safely is hard.

## Why Not Direct Agent Harnesses

Direct OpenClaw / Codex / Claude SDK / Hermes is easier at first.

It breaks when the product needs:

- many users
- durable sessions
- background runs
- cancellation
- approval gates
- rate limits
- cost budgets
- sandboxing
- credential boundaries
- observability
- audit logs
- model/provider routing
- warm starts
- deployment repeatability

Direct harness usage is library integration.
Managed agents is product infrastructure.

## Why Not Claude Managed Agents Or Bedrock

Closed managed-agent platforms are safer than direct harnesses.

But they are expensive and strategically constrained:

- tied to vendor models
- tied to vendor cloud/runtime assumptions
- limited framework choice
- weak portability
- pricing controlled by the model/platform owner
- hard to customize deeply
- not ideal for open personal-agent products

OpenAI and Anthropic monetize their model APIs directly.
They are not structurally incentivized to collapse agent execution pricing through open model competition.

Open Managed Agents can route to strong cheaper models, including DeepSeek, Moonshot, Qwen, open-weight providers, OpenRouter-like routers, and future commodity inference.

This is the timing window.

## Competitive Map

| Product | What It Really Is | Strength | Weakness | Our Read |
|---|---|---|---|---|
| Claude Managed Agents | Closed managed runtime for Claude agents | polished, safe, vendor-backed | Anthropic/model lock-in, expensive, narrow harness surface | validates category |
| Amazon Bedrock Managed Agents / AgentCore | AWS managed infra for enterprise agents | cloud primitives, governance, enterprise trust | AWS complexity, Bedrock gravity, not personal-agent-native | validates infra need |
| OpenAI Symphony | orchestration around Codex-style managed coding agents | strong coding workflow and OpenAI ecosystem | OpenAI model/business gravity, likely less open runtime substrate | validates orchestration need |
| Multica | workspace app + local daemon + many agent CLI adapters | practical multi-agent task execution | not a true managed-agent OS layer | useful reference, different game |
| OpenClaw Managed Agents | OpenClaw-specific managed runtime | strong personal-agent wedge, real container/session infra | harness hardcoded to OpenClaw today | starting point |
| Open Managed Agents | open managed runtime for many harnesses | open, cheap, portable, foundational | harder abstraction, must handle capability differences honestly | target platform |

## Technical Architecture

The key abstraction is a harness adapter above container runtime.

```text
Client / SDK / OpenAI-compatible API
        |
Managed Agent API
        |
Agent Router
        |
        |-- Session Store
        |-- Queue Store
        |-- Environment Store
        |-- Vault / Secrets
        |-- Managed Event Log
        |-- Metrics / Audit
        |
Harness Adapter Registry
        |
        |-- OpenClaw Adapter
        |-- Codex Adapter
        |-- Claude Agent SDK Adapter
        |-- Hermes Adapter
        |-- Generic CLI Adapter
        |
Container Runtime
        |
        |-- Docker
        |-- ECS / Fargate
        |-- Cloud Run
        |-- Kubernetes
        |-- Local Worker
```

## Harness Adapter Contract

The adapter is the driver model.

Rough contract:

```ts
interface AgentHarnessAdapter {
  kind: string;

  capabilities(): HarnessCapabilities;

  buildSpawnSpec(ctx: SpawnContext): SpawnOptions;

  startTurn(ctx: TurnContext): Promise<TurnResult>;

  cancel?(ctx: SessionContext): Promise<void>;
  interrupt?(ctx: SessionContext, message: string): Promise<void>;
  compact?(ctx: SessionContext): Promise<void>;
  confirmTool?(
    ctx: SessionContext,
    approvalId: string,
    decision: "allow" | "deny"
  ): Promise<void>;

  listEvents(ctx: SessionContext): Promise<ManagedEvent[]>;
  followEvents?(ctx: SessionContext): AsyncIterable<ManagedEvent>;
}
```

Capabilities must be explicit:

```ts
type HarnessCapabilities = {
  streaming: boolean;
  cancel: boolean;
  interrupt: boolean;
  toolApprovals: boolean;
  mcp: boolean;
  dynamicModelPatch: boolean;
  compaction: boolean;
  nativeSessionResume: boolean;
  usage: boolean;
};
```

No fake uniformity.
Unsupported features fail loudly.

## Managed Event Log

The event log is the spine.

Today OpenClaw Managed Agents reads Pi/OpenClaw JSONL.
That is fine for OpenClaw, but it cannot be the platform contract.

Open Managed Agents needs a harness-neutral event log:

- `user.message`
- `agent.message`
- `agent.thinking`
- `agent.tool_call`
- `agent.tool_result`
- `agent.error`
- `agent.usage`
- `agent.tool_confirmation_request`
- `session.compaction`
- `session.cancelled`
- `session.delegation_started`
- `session.delegation_completed`

Adapters can source events differently:

- OpenClaw adapter: read native Pi JSONL and map it
- Codex adapter: capture JSON-RPC/app-server events and append normalized events
- Claude SDK adapter: capture SDK stream and append normalized events
- Hermes adapter: capture ACP/events and append normalized events
- Generic CLI adapter: parse stdout/stderr with weaker guarantees

Public APIs should read the managed event log, not a harness-native file.

## Internal Runtime Protocol

Each harness image should expose a small common internal API to the orchestrator.

```text
GET  /readyz
POST /sessions/:id/turns
POST /sessions/:id/cancel
POST /sessions/:id/interrupt
POST /sessions/:id/compact
POST /sessions/:id/approvals/:approval_id
GET  /sessions/:id/events
GET  /sessions/:id/outcome
GET  /logs
```

This avoids baking every native harness protocol into the orchestrator.

The orchestrator manages sessions.
The adapter container translates to native harness behavior.

## Runtime Images

Initial images:

- `open-managed-agents/openclaw-runtime`
- `open-managed-agents/codex-runtime`
- `open-managed-agents/hermes-runtime`
- `open-managed-agents/claude-sdk-runtime`
- `open-managed-agents/generic-cli-runtime`

OpenClaw runtime should remain the flagship.

Codex/Hermes should be used to validate that the platform is genuinely harness-pluggable.

Claude SDK support matters, but should not define the architecture.

## Data Model Direction

Agent templates need runtime identity:

```ts
type AgentConfig = {
  agentId: string;
  runtime: {
    kind: "openclaw" | "codex" | "claude_sdk" | "hermes" | "generic_cli";
    image?: string;
    config: Record<string, unknown>;
  };
  model?: string;
  instructions?: string;
  tools?: string[];
  mcpServers?: Record<string, unknown>;
  permissionPolicy?: PermissionPolicy;
  quotas?: Quota;
};
```

Sessions need native runtime metadata:

```ts
type Session = {
  sessionId: string;
  agentId: string;
  runtimeKind: string;
  nativeSessionId?: string;
  status: "idle" | "starting" | "running" | "failed" | "cancelled";
  eventSource: "managed" | "native_openclaw_jsonl";
};
```

## Migration From OpenClaw Managed Agents

Do not throw away the existing project.

Extract it.

Phase 1:

- create new repo
- copy the strategic direction only
- do not mutate current OpenClaw Managed Agents

Phase 2:

- port current infrastructure into new repo
- wrap current OpenClaw-specific logic as `OpenClawHarnessAdapter`
- keep behavior identical

Phase 3:

- introduce `ManagedEventLog`
- keep OpenClaw JSONL read-through as compatibility path
- make router depend on event-log interface

Phase 4:

- add second adapter: Codex or Hermes
- implement harness contract tests
- expose capability matrix

Phase 5:

- add Claude Agent SDK adapter
- add cloud runtime backends
- build hosted control-plane packaging

## The Hard Part

The hard part is not launching different CLIs.

Multica proves that is doable.

The hard part is making different harnesses safe and operationally consistent under one managed layer.

Hard problems:

- common session semantics
- event durability
- cancellation semantics
- approval semantics
- model/cost accounting
- tool policy normalization
- persistent memory differences
- credentials injection
- sandbox escape surface
- MCP compatibility
- subagent delegation
- warm pool behavior

This is why the product is valuable.

## Strategic Rule

Never sell fake sameness.

Sell managed portability.

Correct promise:

> Bring your harness. We manage the runtime.

Incorrect promise:

> Every harness works exactly the same.

## Initial Product Wedge

The first wedge remains personal agents.

OpenClaw gives the brand:

- personal
- open
- tool-rich
- model-flexible
- emotionally ownable: "my Claw"

Open Managed Agents gives the trust layer:

- safe
- private
- cheap
- stable
- observable
- embeddable

The combined message:

> Build personal-agent products without trusting one closed model vendor or rebuilding managed-agent infra yourself.

## Short-Term TODOs

- [ ] Create repo skeleton
- [ ] Define harness adapter interface
- [ ] Define managed event schema
- [ ] Define runtime capability matrix
- [ ] Define OpenClaw adapter extraction plan
- [ ] Decide first non-OpenClaw adapter: Codex or Hermes
- [ ] Write architecture diagram
- [ ] Write comparison doc versus Claude Managed Agents, Bedrock, Symphony, Multica
- [ ] Decide naming: `open-managed-agents` repo, `oma` package/CLI maybe later

## Decision

Build Open Managed Agents as a separate repo.

Keep OpenClaw Managed Agents untouched for now.

Use it as the working reference implementation, not the final architecture boundary.

