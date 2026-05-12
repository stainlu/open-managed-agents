# Cloudflare + Flue example

This is the first concrete deployment skeleton for the OMA + Flue +
Cloudflare runtime path.

It wires:

- a public Worker router;
- a named Durable Object coordinator;
- Durable Object SQLite for OMA metadata;
- D1-compatible stores for managed events and Flue harness state;
- an R2-compatible workspace binding;
- a Workflow binding for durable run execution;
- OMA's native Flue harness adapter.

This is still an experimental smoke target. It proves the shape of the
Cloudflare composition, but it is not the promoted production backend until we
have live deployment coverage for replay, cancellation, queued turns, Flue
tasks, and sandbox-backed shell/build work.

## Prerequisites

- Node 22.18+ for the current `@flue/sdk` engine requirement
- Wrangler authenticated to a Cloudflare account
- D1 and R2 available on the target account

Install dependencies:

```bash
cd examples/cloudflare-flue
pnpm install
```

## Configure bindings

Create the backing resources:

```bash
pnpm wrangler d1 create oma-cloudflare-flue
pnpm wrangler r2 bucket create oma-cloudflare-flue-workspace
pnpm wrangler r2 bucket create oma-cloudflare-flue-workspace-preview
```

Copy the returned D1 `database_id` into `wrangler.toml`.

Create local secrets for development:

```bash
cp .dev.vars.example .dev.vars
```

For deployed environments, set the same secrets through Wrangler:

```bash
pnpm wrangler secret put OMA_WORKFLOW_INTERNAL_TOKEN
pnpm wrangler secret put OMA_PARENT_TOKEN_SECRET_BASE64
pnpm wrangler secret put OMA_PASSTHROUGH_ENV_JSON
```

Provider keys can either live inside `OMA_PASSTHROUGH_ENV_JSON` or as direct
Worker secrets. Direct secrets are easier to rotate:

```bash
pnpm wrangler secret put ANTHROPIC_API_KEY
pnpm wrangler secret put OPENAI_API_KEY
pnpm wrangler secret put MOONSHOT_API_KEY
```

OMA maps those managed secrets into Flue `configureProvider()` calls at the
harness boundary. That avoids relying on ambient `process.env` and keeps the
same agent JSON portable across Node, Worker, and future managed backends.

Useful Flue model strings from the bundled Pi AI catalog:

- `anthropic/claude-haiku-4-5`
- `anthropic/claude-sonnet-4-6`
- `openai/gpt-5.4-mini`
- `moonshotai/kimi-k2.5`

For non-standard gateways, set `OMA_FLUE_PROVIDER_CONFIG_JSON`:

```json
{
  "openai": {
    "apiKey": "gateway-token",
    "baseUrl": "https://gateway.example.com/openai"
  }
}
```

`OMA_WORKFLOW_INTERNAL_TOKEN` is required when `OMA_RUN_WORKFLOW` is bound.
The Durable Object refuses to boot without it because Workflow re-entry must be
an internal path, not a public API.

## Run locally

```bash
pnpm dev
```

The public API is the same OMA HTTP surface as the Node orchestrator. With
`OMA_API_TOKEN` configured, pass `Authorization: Bearer <token>`.

Minimal local prompt smoke:

```bash
curl -s http://localhost:8787/v1/agents \
  -H 'content-type: application/json' \
  -d '{"harnessId":"flue","model":"anthropic/claude-haiku-4-5","instructions":"One-sentence answers.","tools":[]}'
```

Use the returned `agent_id` with `POST /v1/agents/:agent_id/run`.

## Deploy

Check the bundle and bindings without uploading:

```bash
pnpm dry-run
```

Deploy after the dry-run sees the Durable Object, Workflow, D1, R2, and env
bindings you expect:

```bash
pnpm deploy
```

The `wrangler.toml` uses:

- `compatibility_flags = [ "nodejs_compat" ]` because OMA imports Node builtins
  such as `node:crypto` and `Buffer`;
- `new_sqlite_classes` for the Durable Object metadata backend;
- `[[workflows]]` for scheduled managed runs;
- `[[d1_databases]]` for event and harness state;
- `[[r2_buckets]]` for workspace objects.

## Known gaps

- The example imports OMA from the repo source via `file:../..`; package imports
  can replace this after the Cloudflare backend is published.
- The current Flue adapter is prompt-first. Flue task lineage, shell
  cancellation, MCP, and tool policy parity are intentionally not faked.
- The default Flue engine path still uses Flue's SDK bridge and memory sandbox
  behavior. A production coding-agent stack still needs explicit sandbox
  connector capability gates.
- There is no live CI deployment test yet. Do not treat this as the default
  backend until the promotion checklist in
  `docs/designs/flue-cloudflare-managed-stack.md` is complete.
