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

`OMA_WORKFLOW_INTERNAL_TOKEN` is required when `OMA_RUN_WORKFLOW` is bound.
The Durable Object refuses to boot without it because Workflow re-entry must be
an internal path, not a public API.

## Run locally

```bash
pnpm dev
```

The public API is the same OMA HTTP surface as the Node orchestrator. With
`OMA_API_TOKEN` configured, pass `Authorization: Bearer <token>`.

## Deploy

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
