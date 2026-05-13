#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "skipped"]);

const opts = parseArgs(process.argv.slice(2));
const phase = opts.phase ?? process.env.OMA_REPLAY_PHASE;
const statePath = opts.state ?? process.env.OMA_REPLAY_STATE_PATH ?? "./replay-state.json";
const token = opts.token ?? process.env.OMA_API_TOKEN;
const model = opts.model ?? process.env.OMA_REPLAY_MODEL ?? "cloudflare/@cf/openai/gpt-oss-20b";
const timeoutMs = positiveInt(opts["timeout-ms"] ?? process.env.OMA_REPLAY_TIMEOUT_MS, 180_000);
const pollMs = positiveInt(opts["poll-ms"] ?? process.env.OMA_REPLAY_POLL_MS, 1_000);
const allowLocalReplay = boolOpt(opts["allow-local-replay"] ?? process.env.OMA_REPLAY_ALLOW_LOCAL);
const keep = boolOpt(opts.keep ?? process.env.OMA_REPLAY_KEEP);
const reportPath = opts.report ?? process.env.OMA_REPLAY_REPORT_PATH;
const restartEvidence = opts["restart-evidence"] ?? process.env.OMA_REPLAY_RESTART_EVIDENCE;
const startedAt = new Date().toISOString();
const checks = [];
const cleanup = [];
let state;
let baseUrl;

main().catch(async (err) => {
  try {
    await writeReport("failed", err);
  } catch (reportErr) {
    console.error(`warn failed to write replay report: ${errorMessage(reportErr)}`);
  }
  console.error(`FAIL ${errorMessage(err)}`);
  process.exitCode = 1;
});

async function main() {
  if (phase !== "seed" && phase !== "verify") {
    throw new Error("usage: pnpm smoke:replay:seed or pnpm smoke:replay:verify");
  }
  if (phase === "verify") {
    state = await readReplayState(statePath);
  }
  const explicitBaseUrl = opts["base-url"] ?? process.env.OMA_CLOUDFLARE_FLUE_BASE_URL;
  baseUrl = normalizeBaseUrl(explicitBaseUrl ?? state?.target ?? "http://127.0.0.1:8787");

  assert(token, "Cloudflare replay smoke requires OMA_API_TOKEN");
  assert(
    allowLocalReplay || isDeployedHttpsUrl(baseUrl),
    "Cloudflare replay smoke must target a deployed https URL; pass --allow-local-replay only for local rehearsal",
  );
  if (state?.target) {
    assert(
      normalizeBaseUrl(state.target) === baseUrl,
      `state target ${state.target} does not match current target ${baseUrl}`,
    );
  }

  console.log(`OMA Cloudflare/Flue replay ${phase} target: ${baseUrl}`);
  if (phase === "seed") {
    await seedReplayState();
  } else {
    await verifyReplayState();
  }
}

async function seedReplayState() {
  const smokeId = `oma-replay-${Date.now().toString(36)}`;
  const created = { agentId: undefined, sessionId: undefined };
  try {
    await checkHealthAndCatalog();
    const agent = await request("POST", "/v1/agents", {
      body: {
        name: smokeId,
        harnessId: "flue",
        model,
        tools: [],
        instructions: `You are a Cloudflare replay smoke test. Include the token ${smokeId} in the final answer.`,
        permissionPolicy: { type: "always_allow" },
        thinkingLevel: "off",
      },
    });
    assertString(agent.agent_id, "agent_id");
    assertNoPlatformIds(agent, "agent response");
    created.agentId = agent.agent_id;
    recordCheck("agent_create", { agent_id: agent.agent_id });

    const run = await startRun(agent.agent_id, `Reply with exactly: ${smokeId}`);
    created.sessionId = run.session_id;
    const terminal = await waitForRun(run.session_id, run.run_id);
    assert(terminal.status === "succeeded", `seed run ended with ${terminal.status}`);
    assertNoPlatformIds(terminal, "run response");
    recordCheck("prompt_run", {
      session_id: run.session_id,
      run_id: run.run_id,
      status: terminal.status,
    });

    const probePath = "replay/probe.txt";
    const probeContent = `replay:${smokeId}`;
    await putFile(agent.agent_id, run.session_id, probePath, probeContent);

    state = {
      schema_version: 1,
      kind: "cloudflare_flue_replay_state",
      target: baseUrl,
      model,
      smoke_id: smokeId,
      seeded_at: new Date().toISOString(),
      agent_id: agent.agent_id,
      session_id: run.session_id,
      run_id: run.run_id,
      probe_path: probePath,
      probe_content: probeContent,
    };
    await readbackState(state);
    await writeState(statePath, state);
    console.log(`PASS replay seed wrote ${statePath}`);
    console.log("Restart/redeploy the Worker or wait for Durable Object hibernation, then run pnpm smoke:replay:verify");
    await writeReport("seeded");
  } catch (err) {
    if (!keep) {
      await cleanupResources(created.agentId, created.sessionId);
    }
    throw err;
  }
}

async function verifyReplayState() {
  let verified = false;
  try {
    await checkHealthAndCatalog();
    await readbackState(state);
    recordCheck("replay_verified", {
      seeded_at: state.seeded_at,
      session_id: state.session_id,
      run_id: state.run_id,
    });
    verified = true;
    console.log(`PASS replay verify for ${state.session_id}`);
  } finally {
    if (keep) {
      cleanup.push({ type: "all", status: "skipped", reason: "keep" });
      console.log("skip cleanup because --keep or OMA_REPLAY_KEEP is set");
    } else {
      await cleanupResources(state?.agent_id, state?.session_id);
    }
    if (verified) {
      await writeReport("passed");
    }
  }
}

async function checkHealthAndCatalog() {
  const health = await request("GET", "/healthz", { auth: false });
  assert(health.ok === true, "/healthz did not return ok=true");
  assertNoPlatformIds(health, "health response");
  recordCheck("health", { version: health.version ?? "unknown" });

  const harnesses = await request("GET", "/v1/harnesses");
  assert(
    Array.isArray(harnesses.harnesses) &&
      harnesses.harnesses.some((harness) => harness.harness_id === "flue"),
    "GET /v1/harnesses does not include flue",
  );
  assertNoPlatformIds(harnesses, "harness catalog response");
  recordCheck("harness_catalog", { harness_id: "flue" });
}

async function readbackState(item) {
  assertReplayState(item);

  const session = await request("GET", `/v1/sessions/${encodeURIComponent(item.session_id)}`);
  assert(session.session_id === item.session_id, "session readback returned the wrong session_id");
  assert(session.agent_id === item.agent_id, "session readback returned the wrong agent_id");
  assert(session.harness_id === "flue", `session readback returned harness ${session.harness_id}`);
  assert(session.status === "idle", `session readback status is ${session.status}`);
  assert(typeof session.turns === "number" && session.turns >= 1, "session readback did not preserve turns");
  assert(
    typeof session.output === "string" && session.output.includes(item.smoke_id),
    "session output did not preserve replay smoke token",
  );
  assertNoPlatformIds(session, "session readback response");

  const run = await request(
    "GET",
    `/v1/sessions/${encodeURIComponent(item.session_id)}/runs/${encodeURIComponent(item.run_id)}`,
  );
  assert(run.run_id === item.run_id, "run readback returned the wrong run_id");
  assert(run.session_id === item.session_id, "run readback returned the wrong session_id");
  assert(run.status === "succeeded", `run readback status is ${run.status}`);
  assertNoPlatformIds(run, "run readback response");

  const events = await request("GET", `/v1/sessions/${encodeURIComponent(item.session_id)}/events`);
  assert(Array.isArray(events.events), "event readback response is missing events[]");
  assert(events.events.some((event) => event.type === "user.message"), "event readback missing user.message");
  assert(events.events.some((event) => event.type === "agent.message"), "event readback missing agent.message");
  assert(events.events.some((event) => event.run_id === item.run_id), `event readback missing run_id ${item.run_id}`);
  assertNoPlatformIds(events, "event readback response");

  const tree = await request("GET", `/v1/sessions/${encodeURIComponent(item.session_id)}/run-tree`);
  const node = findRunNode(tree.runs, item.run_id);
  assert(node?.source?.managed_run === true, "run-tree readback lost managed run linkage");
  assertNoPlatformIds(tree, "run-tree readback response");

  const listPath = dirnamePath(item.probe_path);
  const listing = await request(
    "GET",
    `/v1/agents/${encodeURIComponent(item.agent_id)}/files?session_id=${encodeURIComponent(item.session_id)}&path=${encodeURIComponent(listPath)}`,
  );
  assert(Array.isArray(listing.entries), "workspace listing readback is missing entries[]");
  assert(
    listing.entries.some((entry) => entry?.type === "file" && entry?.path === item.probe_path),
    `workspace listing did not include ${item.probe_path}`,
  );
  assertNoPlatformIds(listing, "workspace listing readback response");

  const fileText = await getFileText(item.agent_id, item.session_id, item.probe_path);
  assert(
    fileText === item.probe_content,
    `workspace file readback mismatch: ${JSON.stringify(fileText)}`,
  );

  recordCheck("state_readback", {
    session_id: item.session_id,
    run_id: item.run_id,
    event_count: events.events.length,
    workspace_path: item.probe_path,
  });
}

async function startRun(agentId, task) {
  const result = await request("POST", `/v1/agents/${encodeURIComponent(agentId)}/run`, {
    body: { task },
  });
  assertString(result.session_id, "session_id");
  assertString(result.run_id, "run_id");
  assertNoPlatformIds(result, "run start response");
  return result;
}

async function waitForRun(sessionId, runId) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() <= deadline) {
    last = await request(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`,
    );
    assertString(last.status, "run status");
    if (TERMINAL_RUN_STATUSES.has(last.status)) return last;
    await sleep(pollMs);
  }
  throw new Error(`run ${runId} did not reach a terminal status before timeout; last=${JSON.stringify(last)}`);
}

async function cleanupResources(agentId, sessionId) {
  if (sessionId) {
    try {
      await request("DELETE", `/v1/sessions/${encodeURIComponent(sessionId)}`);
      cleanup.push({ type: "session", id: sessionId, status: "deleted" });
      console.log(`ok deleted replay session ${sessionId}`);
    } catch (err) {
      cleanup.push({ type: "session", id: sessionId, status: "failed", error: errorMessage(err) });
      console.warn(`warn failed to delete replay session ${sessionId}: ${errorMessage(err)}`);
    }
  }
  if (agentId) {
    try {
      await request("DELETE", `/v1/agents/${encodeURIComponent(agentId)}`);
      cleanup.push({ type: "agent", id: agentId, status: "deleted" });
      console.log(`ok deleted replay agent ${agentId}`);
    } catch (err) {
      cleanup.push({ type: "agent", id: agentId, status: "failed", error: errorMessage(err) });
      console.warn(`warn failed to delete replay agent ${agentId}: ${errorMessage(err)}`);
    }
  }
}

async function request(method, path, options = {}) {
  const headers = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.auth !== false && token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function putFile(agentId, sessionId, path, content) {
  const response = await fetch(
    `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/files/${encodePath(path)}?session_id=${encodeURIComponent(sessionId)}`,
    {
      method: "PUT",
      headers: authHeaders({ "content-type": "application/octet-stream" }),
      body: content,
    },
  );
  const body = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(`PUT file ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  assertNoPlatformIds(body, `put file ${path} response`);
}

async function getFileText(agentId, sessionId, path) {
  const response = await fetch(
    `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/files/${encodePath(path)}?session_id=${encodeURIComponent(sessionId)}`,
    { headers: authHeaders() },
  );
  if (!response.ok) {
    const body = await parseResponseBody(response);
    throw new Error(`GET file ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return await response.text();
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function readReplayState(path) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  assertReplayState(parsed);
  return parsed;
}

function assertReplayState(item) {
  assert(item?.schema_version === 1, "replay state schema_version must be 1");
  assert(item?.kind === "cloudflare_flue_replay_state", "replay state kind is invalid");
  for (const key of [
    "target",
    "model",
    "smoke_id",
    "seeded_at",
    "agent_id",
    "session_id",
    "run_id",
    "probe_path",
    "probe_content",
  ]) {
    assertString(item?.[key], `replay state ${key}`);
  }
}

async function writeState(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeReport(status, err) {
  if (!reportPath) return;
  const report = {
    schema_version: 1,
    kind: "cloudflare_flue_replay_report",
    phase,
    target: baseUrl,
    model,
    smoke_id: state?.smoke_id,
    seeded_at: state?.seeded_at,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status,
    restart_evidence: phase === "verify" ? restartEvidence : undefined,
    checks,
    resources: {
      agent_id: state?.agent_id,
      session_id: state?.session_id,
      run_id: state?.run_id,
    },
    cleanup,
    error: err ? { message: errorMessage(err) } : undefined,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote replay report ${reportPath}`);
}

function recordCheck(name, details = {}) {
  const { status = "passed", ...rest } = details;
  checks.push({
    name,
    status,
    at: new Date().toISOString(),
    ...rest,
  });
}

async function parseResponseBody(response) {
  const text = await response.text();
  try {
    return text.length > 0 ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function encodePath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

function dirnamePath(path) {
  const idx = String(path).lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function findRunNode(nodes, runId) {
  if (!Array.isArray(nodes)) return undefined;
  for (const node of nodes) {
    if (node?.run_id === runId) return node;
    const child = findRunNode(node?.children, runId);
    if (child) return child;
  }
  return undefined;
}

function assertNoPlatformIds(value, label) {
  const bad = findPlatformIdKey(value);
  assert(!bad, `${label} leaks platform id key ${bad}`);
}

function findPlatformIdKey(value, path = "$") {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findPlatformIdKey(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (
      normalized.includes("durable_object") ||
      normalized.includes("workflow_id") ||
      normalized.includes("d1_") ||
      normalized.includes("r2_") ||
      normalized === "cloudflare_id"
    ) {
      return `${path}.${key}`;
    }
    const found = findPlatformIdKey(child, `${path}.${key}`);
    if (found) return found;
  }
  return undefined;
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (!raw?.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq !== -1) {
      parsed[raw.slice(2, eq)] = raw.slice(eq + 1);
      continue;
    }
    const key = raw.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      i++;
    } else {
      parsed[key] = "true";
    }
  }
  return parsed;
}

function boolOpt(value) {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function normalizeBaseUrl(value) {
  return String(value).replace(/\/+$/, "");
}

function isDeployedHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  return !(
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertString(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} must be a non-empty string`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
