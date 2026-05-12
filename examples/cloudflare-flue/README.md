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
- a Workers AI binding for `cloudflare/<model>` Flue models;
- a Cloudflare Sandbox binding for Flue shell/build execution;
- OMA's native Flue harness adapter.

This is still an experimental smoke target. It proves the shape of the
Cloudflare composition, but it is not the promoted production backend until we
have live deployment coverage for replay, active/queued run cancellation,
queued turns, Flue tasks, and sandbox-backed shell/build work.

## Prerequisites

- Node 22.18+ for the current `@flue/sdk` engine requirement
- Wrangler authenticated to a Cloudflare account
- D1, R2, Workers AI, Workflows, and Cloudflare Sandboxes available on the
  target account
- Docker running locally for Wrangler to build the Sandbox container image

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

The example also binds Cloudflare Workers AI as `AI`. That enables Flue's
binding-backed `cloudflare/<model>` prefix without a provider API key:

```json
{ "model": "cloudflare/@cf/openai/gpt-oss-20b" }
```

Provider keys for external models can either live inside
`OMA_PASSTHROUGH_ENV_JSON` or as direct Worker secrets. Direct secrets are
easier to rotate:

```bash
pnpm wrangler secret put ANTHROPIC_API_KEY
pnpm wrangler secret put OPENAI_API_KEY
pnpm wrangler secret put MOONSHOT_API_KEY
```

OMA maps those managed secrets into Flue `configureProvider()` calls at the
harness boundary. That avoids relying on ambient `process.env` and keeps the
same agent JSON portable across Node, Worker, and future managed backends.

The example also binds Cloudflare Sandbox SDK as `Sandbox`. OMA mirrors the
managed R2 workspace into the sandbox before a Flue shell call, executes the
command with Cloudflare's `exec()` API, then syncs changed files back into the
managed workspace. This keeps R2/OMA as the durable source of truth even though
the sandbox container can sleep between requests.

Useful Flue model strings from the bundled Pi AI catalog:

- `cloudflare/@cf/openai/gpt-oss-20b`
- `cloudflare/@cf/moonshotai/kimi-k2.5`
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
  -d '{"harnessId":"flue","model":"cloudflare/@cf/openai/gpt-oss-20b","instructions":"One-sentence answers.","tools":[]}'
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

## Smoke test

Run the basic smoke against local `wrangler dev` or a deployed Worker:

```bash
OMA_CLOUDFLARE_FLUE_BASE_URL=http://127.0.0.1:8787 \
OMA_API_TOKEN=replace-with-token-if-configured \
pnpm smoke
```

For a deployed Worker:

```bash
OMA_CLOUDFLARE_FLUE_BASE_URL=https://oma-cloudflare-flue.<account>.workers.dev \
OMA_API_TOKEN=replace-with-token-if-configured \
pnpm smoke
```

The basic smoke proves:

- `/healthz` is reachable;
- `flue` is present in the harness catalog;
- a Flue agent can be created;
- a managed prompt run reaches `succeeded`;
- `events?run_id=...` returns run-scoped events;
- `run-tree` contains the managed run;
- public responses do not expose Durable Object, Workflow, D1, or R2 ids.

The smoke deletes the agent and sessions it creates. Set `OMA_SMOKE_KEEP=1` or
pass `--keep` if you want to inspect the resources afterward.

Sandbox shell/build smoke is separate because it intentionally executes a
command inside Cloudflare Sandbox. It requires `OMA_API_TOKEN` to be configured
on the Worker and supplied by the smoke client:

```bash
OMA_CLOUDFLARE_FLUE_BASE_URL=https://oma-cloudflare-flue.<account>.workers.dev \
OMA_API_TOKEN=replace-with-worker-token \
pnpm smoke:sandbox
```

That smoke writes source fixtures through OMA's public workspace API, calls the
example-only `/_oma/smoke/sandbox-exec` route, runs a shell command through
real Flue `session.shell()` plus OMA's Flue managed workspace executor, and
verifies that Flue shell operation events, the generated `dist/result.txt`,
and a deleted fixture sync back to the managed R2 workspace. The smoke route
is token-gated and refuses to run when `OMA_API_TOKEN` is not configured.

Promotion-only checks are stricter and intentionally separate because they
require a prompt that remains active long enough to test queueing and aborts:

```bash
OMA_CLOUDFLARE_FLUE_BASE_URL=https://oma-cloudflare-flue.<account>.workers.dev \
OMA_API_TOKEN=replace-with-token-if-configured \
pnpm smoke:promotion
```

If your model answers too quickly, the promotion smoke will fail at the queue
or active-abort gate. That is expected: the script is a promotion verifier, not
a flaky green badge.

The `wrangler.toml` uses:

- `compatibility_flags = [ "nodejs_compat" ]` because OMA imports Node builtins
  such as `node:crypto` and `Buffer`;
- `new_sqlite_classes` for the Durable Object metadata backend;
- `[[workflows]]` for scheduled managed runs;
- `[[d1_databases]]` for event and harness state;
- `[[r2_buckets]]` for workspace objects;
- `[[containers]]` plus a `Sandbox` Durable Object binding for full Linux
  shell/build execution.

## Known gaps

- The example imports OMA from the repo source via `file:../..`; package imports
  can replace this after the Cloudflare backend is published.
- The current Flue adapter is prompt-first, with a direct shell operation path
  for deployment verification. Flue task/operation telemetry is preserved as
  nested managed run events, but first-class child sessions, MCP, and tool
  policy parity are intentionally not faked.
- Sandbox-backed shell execution is wired through OMA's managed workspace
  executor seam, and the example smoke client can now require a deterministic
  shell/build check against real Cloudflare Sandboxes. This still needs to be
  run against a live deployment before the backend is promoted.
- Local Durable Object tests cover active and queued run abort through the
  public run API, but there is no live CI deployment test yet. Do not treat
  this as the default backend until the promotion checklist in
  `docs/designs/flue-cloudflare-managed-stack.md` is complete.
