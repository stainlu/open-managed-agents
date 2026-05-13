# Cloudflare Backend Promotion

Status: not promoted.

OMA already has a real Cloudflare path, but it is not finished enough to call
the Cloudflare suite a production backend. The current code proves the
architecture locally and provides an experimental deployment scaffold. The next
step is live promotion evidence.

## Positioning

Cloudflare is a runtime substrate for OMA, not OMA's product boundary.

```text
client / SDK
  -> OMA managed-agent API
       Agent / Environment / Session / Run / Event
       queues, policy, credentials, recovery, cancellation, observability
  -> harness adapter
       Flue first for the Cloudflare-native path
  -> Cloudflare runtime substrate
       Worker, Durable Object, Workflow, D1, R2, Workers AI, Sandbox
```

Flue is the first AI-native harness for this substrate. It should make the
Cloudflare path feel natural, but the public contract remains OMA's managed
contract. Public responses must expose OMA ids and OMA lifecycle states, not
Durable Object ids, Workflow ids, D1 table details, R2 keys, or Sandbox ids.

## Current Coverage

Implemented:

- Worker public router forwarding traffic to a named coordinator Durable
  Object.
- Durable Object composition around OMA metadata, D1-compatible event/state
  stores, R2 workspace, Flue harness, and native-only runtime.
- Durable Object SQLite adapter for OMA's existing `Store` contract.
- D1-compatible managed event log.
- D1-compatible Flue harness-state store.
- R2-compatible managed workspace backend.
- Workflow-backed run scheduling and token-gated coordinator re-entry.
- Workers AI binding registration for `cloudflare/<model>` Flue models.
- Cloudflare Sandbox-backed workspace command executor for Flue shell/build
  calls.
- Experimental `examples/cloudflare-flue` Wrangler deployment scaffold.
- Local Durable Object tests for replay, queued turns, active/queued run abort,
  run-tree projection, task/shell lineage, R2 workspace visibility, and absence
  of public platform ids.
- Smoke client for deployed or local Worker targets.

Not yet promoted:

- No checked-in live deployment evidence for the full promotion suite.
- No CI job that provisions or targets a real Cloudflare deployment.
- No live restart/hibernation replay proof against Cloudflare's actual Durable
  Object runtime.
- No live proof that queueing and active cancellation remain reliable under
  real Workflow re-entry and provider latency.

## Promotion Evidence

A Cloudflare backend can be promoted only after these checks pass against a
real deployed Worker URL:

1. Dry-run binding check.

   ```bash
   cd examples/cloudflare-flue
   pnpm preflight
   pnpm dry-run
   ```

   Evidence must show preflight passed and the Worker bundle sees the
   coordinator Durable Object, Workflow, D1 database, R2 workspace bucket,
   Workers AI binding, and Sandbox binding.

2. Basic live smoke.

   ```bash
   OMA_CLOUDFLARE_FLUE_BASE_URL=https://oma-cloudflare-flue.<account>.workers.dev \
   OMA_API_TOKEN=replace-with-worker-token \
   pnpm smoke
   ```

   This proves health, harness catalog, Flue agent creation, prompt run,
   run-scoped event filtering, run-tree projection, cleanup, and no leaked
   Cloudflare platform ids.

3. Full promotion smoke.

   ```bash
   OMA_CLOUDFLARE_FLUE_BASE_URL=https://oma-cloudflare-flue.<account>.workers.dev \
   OMA_API_TOKEN=replace-with-worker-token \
   pnpm smoke:promotion
   ```

   This runs smoke promotion mode. Promotion mode requires `OMA_API_TOKEN`,
   rejects localhost by default, and adds sandbox-backed shell/build execution,
   real Flue task execution, queued-run cancellation, and active-run
   cancellation. `-- --allow-local-promotion` is only for local rehearsal; it
   cannot be used as promotion evidence.

4. Live replay proof.

   The same deployed state must survive a coordinator restart or hibernation
   and still replay:

   - session metadata;
   - managed run records;
   - event history;
   - run-tree projection;
   - workspace files.

   Local fake-Durable-Object tests do not count for this gate.

5. Failure semantics proof.

   Missing required bindings or credentials must fail loudly at startup or at
   the relevant capability boundary. OMA must not silently fall back to local
   memory, local files, fake Docker behavior, or skipped policy enforcement.

6. Security proof.

   Deployed smoke routes that can run code must require `OMA_API_TOKEN`.
   Workflow re-entry must require `OMA_WORKFLOW_INTERNAL_TOKEN`. Parent-token
   signing must use `OMA_PARENT_TOKEN_SECRET_BASE64`. Provider credentials must
   enter through managed secret mapping, not ambient assumptions.

## What Does Not Count

- Passing unit tests only.
- Passing `wrangler dev` only.
- Passing `pnpm smoke` without sandbox/task/cancellation checks.
- A successful deploy with no replay/cancellation evidence.
- Flue-native admin/run APIs working independently of OMA's public API.

## Promotion Decision

When the gates pass, Cloudflare can become the preferred high-scale runtime
target for OMA's AI-native stack:

```text
OMA control plane
  + Flue harness adapter
  + Cloudflare Worker / Durable Object / Workflow / D1 / R2 / Sandbox
```

Docker remains the default self-hosted backend until Cloudflare has this live
promotion record. The goal is not to imitate Docker on Cloudflare; the goal is
to preserve OMA's managed-agent contract on Cloudflare-native primitives.
