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
- Sanitized `/healthz` runtime-readiness evidence for the Cloudflare/Flue
  native stack. Promotion and replay report verifiers require metadata,
  database, workspace, Workflow, Workers AI, and Sandbox bindings to be
  configured without exposing Durable Object, Workflow, D1, R2, or Sandbox ids.
- Smoke client for deployed or local Worker targets, including promotion-mode
  public OMA state readback across sessions, runs, events, run trees, and
  workspace files.
- Two-phase replay smoke that can seed deployed OMA state before a real
  operator/CI restart or Durable Object hibernation, then verify that same
  state afterward. The replay report verifier requires the restart/hibernation
  action to be recorded before the report can count as evidence.
- Manual GitHub Actions promotion workflow
  (`.github/workflows/cloudflare-promotion.yaml`) that runs the live promotion
  smoke, verifies the report, optionally seeds/verifies replay, and uploads the
  evidence bundle for a deployed Worker target.

Not yet promoted:

- No checked-in live deployment evidence for the full promotion suite.
- No checked-in successful run of the manual Cloudflare promotion workflow.
- No checked-in replay report showing the two-phase smoke passing across
  Cloudflare's actual Durable Object restart/hibernation boundary.
- No live proof that queueing and active cancellation remain reliable under
  real Workflow re-entry and provider latency.

## Promotion Evidence

A Cloudflare backend can be promoted only after these checks pass against a
real deployed Worker URL:

1. Dry-run binding check.

   ```bash
   cd examples/cloudflare-flue
   pnpm preflight
   pnpm preflight:secrets
   pnpm dry-run
   ```

   Evidence must show preflight passed and the Worker bundle sees the
   coordinator Durable Object, Workflow, D1 database, R2 workspace bucket,
   Workers AI binding, and Sandbox binding. Secret preflight must show
   `OMA_WORKFLOW_INTERNAL_TOKEN` and a canonical 32-byte
   `OMA_PARENT_TOKEN_SECRET_BASE64` were validated from local promotion inputs
   or the shell environment before those values are pushed to Wrangler.

2. Basic live smoke.

   ```bash
   OMA_CLOUDFLARE_FLUE_BASE_URL=https://oma-cloudflare-flue.<account>.workers.dev \
   OMA_API_TOKEN=replace-with-worker-token \
   pnpm smoke
   ```

   This proves health, the authenticated `/v1/runtime` substrate profile,
   harness catalog with `flue` as a native harness, Flue agent creation,
   prompt run, run-scoped event filtering, run-tree projection, cleanup, and no
   leaked Cloudflare platform ids. In promotion mode, health and `/v1/runtime`
   must both prove the native `cloudflare-flue` runtime and configured
   metadata, database, workspace, Workflow, Workers AI, and Sandbox bindings.

3. Full promotion smoke.

   ```bash
   OMA_CLOUDFLARE_FLUE_BASE_URL=https://oma-cloudflare-flue.<account>.workers.dev \
   OMA_API_TOKEN=replace-with-worker-token \
   pnpm smoke:promotion -- --report ./promotion-report.json
   pnpm smoke:verify-report -- ./promotion-report.json
   ```

   This runs smoke promotion mode. Promotion mode requires `OMA_API_TOKEN`,
   rejects localhost by default, and adds OMA state readback, sandbox-backed
   shell/build execution, real Flue task execution, queued-run cancellation,
   and active-run cancellation. `-- --allow-local-promotion` is only for local
   rehearsal; it cannot be used as promotion evidence. The JSON report records
   target, mode, model, smoke id, check names, resource ids, cleanup status,
   and failure message if any. It does not record the bearer token. The
   verifier rejects failed reports, localhost targets, skipped required checks,
   missing Cloudflare runtime-readiness evidence, incomplete cleanup, public
   Cloudflare platform-id keys, and bearer-token-looking values.

   The state-readback check rereads session metadata, managed run records,
   event history, run-tree projection, workspace listings, and workspace file
   content through the public OMA API after the prompt run succeeds. It does
   not replace the hibernation/restart gate below; it prevents a deployed
   smoke from counting when only the one-shot prompt response works.

4. Live replay proof.

   The same deployed state must survive a coordinator restart or hibernation
   and still replay:

   - session metadata;
   - managed run records;
   - event history;
   - run-tree projection;
   - workspace files.

   Use the two-phase replay smoke so the restart/hibernation happens between
   seed and verify:

   ```bash
   OMA_CLOUDFLARE_FLUE_BASE_URL=https://oma-cloudflare-flue.<account>.workers.dev \
   OMA_API_TOKEN=replace-with-worker-token \
   pnpm smoke:replay:seed -- --state ./replay-state.json
   ```

   Then redeploy/restart the Worker or wait for the coordinator Durable Object
   to hibernate. Verify the same public OMA state afterward:

   ```bash
   OMA_CLOUDFLARE_FLUE_BASE_URL=https://oma-cloudflare-flue.<account>.workers.dev \
   OMA_API_TOKEN=replace-with-worker-token \
   pnpm smoke:replay:verify -- --state ./replay-state.json --report ./replay-report.json \
     --restart-evidence "wrangler deploy completed at 2026-05-14T00:00:00Z"
   pnpm smoke:verify-replay-report -- ./replay-report.json
   pnpm smoke:verify-evidence -- --promotion ./promotion-report.json --replay ./replay-report.json
   ```

   The seed state and verify report are promotion evidence only if the operator
   or CI records the actual restart/hibernation action between those commands.
   The replay report verifier requires that recorded action as
   `restart_evidence`. The bundle verifier requires the promotion and replay
   reports to target the same deployed Worker URL. Running seed and verify
   back-to-back is only a rehearsal.

   Local fake-Durable-Object tests do not count for this gate.

   The same sequence can be run from GitHub Actions with the manual
   `cloudflare promotion` workflow. Configure:

   - `OMA_CLOUDFLARE_FLUE_API_TOKEN` as the deployed Worker's `OMA_API_TOKEN`.
   - `OMA_CLOUDFLARE_FLUE_WORKFLOW_INTERNAL_TOKEN` as the deployed Worker's
     `OMA_WORKFLOW_INTERNAL_TOKEN`.
   - `OMA_CLOUDFLARE_FLUE_PARENT_TOKEN_SECRET_BASE64` as the deployed Worker's
     `OMA_PARENT_TOKEN_SECRET_BASE64`. It must be canonical padded base64 that
     decodes to exactly 32 bytes.
   - Optional `OMA_CLOUDFLARE_FLUE_PASSTHROUGH_ENV_JSON` and
     `OMA_CLOUDFLARE_FLUE_PROVIDER_CONFIG_JSON` if the deployed Worker uses
     those managed provider inputs.
   - `CLOUDFLARE_API_TOKEN` and, when your Wrangler account setup requires it,
     `CLOUDFLARE_ACCOUNT_ID` if `redeploy_for_replay=true`.
   - `OMA_CLOUDFLARE_FLUE_D1_DATABASE_ID` if `redeploy_for_replay=true`, so
     the workflow can patch the checked-in example `wrangler.toml` before
     dry-run/deploy. Optional resource-name overrides are
     `OMA_CLOUDFLARE_FLUE_D1_DATABASE_NAME`,
     `OMA_CLOUDFLARE_FLUE_R2_BUCKET_NAME`, and
     `OMA_CLOUDFLARE_FLUE_R2_PREVIEW_BUCKET_NAME`.
   - `target_url` as the deployed Worker URL.

   If `redeploy_for_replay=false`, provide `restart_evidence` describing the
   operator action that happened between replay seed and verify. If
   `redeploy_for_replay=true`, the workflow runs `pnpm deploy` between seed and
   verify and records that deploy as the restart evidence.

5. Failure semantics proof.

   Missing required bindings or credentials must fail loudly at startup or at
   the relevant capability boundary. OMA must not silently fall back to local
   memory, local files, fake Docker behavior, or skipped policy enforcement.

6. Security proof.

   Deployed smoke routes that can run code must require `OMA_API_TOKEN`.
   Workflow re-entry must require `OMA_WORKFLOW_INTERNAL_TOKEN`. Parent-token
   signing must use a canonical 32-byte `OMA_PARENT_TOKEN_SECRET_BASE64`
   value. Provider credentials must enter through managed secret mapping, not
   ambient assumptions.

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
