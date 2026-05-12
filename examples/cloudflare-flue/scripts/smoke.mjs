#!/usr/bin/env node

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "skipped"]);

const opts = parseArgs(process.argv.slice(2));
const baseUrl = normalizeBaseUrl(
  opts["base-url"] ?? process.env.OMA_CLOUDFLARE_FLUE_BASE_URL ?? "http://127.0.0.1:8787",
);
const token = opts.token ?? process.env.OMA_API_TOKEN;
const model = opts.model ?? process.env.OMA_SMOKE_MODEL ?? "cloudflare/@cf/openai/gpt-oss-20b";
const timeoutMs = positiveInt(opts["timeout-ms"] ?? process.env.OMA_SMOKE_TIMEOUT_MS, 180_000);
const pollMs = positiveInt(opts["poll-ms"] ?? process.env.OMA_SMOKE_POLL_MS, 1_000);
const checkQueueAbort = boolOpt(opts["check-queue-abort"] ?? process.env.OMA_SMOKE_CHECK_QUEUE_ABORT);
const checkActiveAbort = boolOpt(opts["check-active-abort"] ?? process.env.OMA_SMOKE_CHECK_ACTIVE_ABORT);
const checkSandboxExec = boolOpt(opts["check-sandbox-exec"] ?? process.env.OMA_SMOKE_CHECK_SANDBOX_EXEC);
const keep = boolOpt(opts.keep ?? process.env.OMA_SMOKE_KEEP);
const smokeId = `oma-smoke-${Date.now().toString(36)}`;
const createdAgentIds = new Set();
const createdSessionIds = new Set();

main().catch((err) => {
  console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

async function main() {
  console.log(`OMA Cloudflare/Flue smoke target: ${baseUrl}`);

  try {
    const health = await request("GET", "/healthz", { auth: false });
    assert(health.ok === true, "/healthz did not return ok=true");
    console.log(`ok health version=${health.version ?? "unknown"}`);

    const harnesses = await request("GET", "/v1/harnesses");
    assert(
      Array.isArray(harnesses.harnesses)
        && harnesses.harnesses.some((harness) => harness.harness_id === "flue"),
      "GET /v1/harnesses does not include flue",
    );
    console.log("ok harness catalog includes flue");

    const agent = await request("POST", "/v1/agents", {
      body: {
        name: smokeId,
        harnessId: "flue",
        model,
        tools: [],
        instructions: `You are a deployment smoke test. Include the token ${smokeId} in the final answer.`,
        permissionPolicy: { type: "always_allow" },
        thinkingLevel: "off",
      },
    });
    assertString(agent.agent_id, "agent_id");
    createdAgentIds.add(agent.agent_id);
    assertNoPlatformIds(agent, "agent response");
    console.log(`ok created flue agent ${agent.agent_id}`);

    const promptRun = await startRun(agent.agent_id, `Reply with exactly: ${smokeId}`);
    const terminalRun = await waitForRun(promptRun.session_id, promptRun.run_id);
    assert(terminalRun.status === "succeeded", `prompt run ended with ${terminalRun.status}`);
    assertNoPlatformIds(terminalRun, "run response");
    console.log(`ok prompt run ${promptRun.run_id} succeeded`);

    const runEvents = await request(
      "GET",
      `/v1/sessions/${encodeURIComponent(promptRun.session_id)}/events?run_id=${encodeURIComponent(promptRun.run_id)}`,
    );
    assert(Array.isArray(runEvents.events), "run event response is missing events[]");
    assert(runEvents.events.length > 0, "run event response is empty");
    assertNoPlatformIds(runEvents, "filtered events response");
    console.log(`ok run event filter returned ${runEvents.events.length} event(s)`);

    const tree = await request(
      "GET",
      `/v1/sessions/${encodeURIComponent(promptRun.session_id)}/run-tree`,
    );
    const treeNode = findRunNode(tree.runs, promptRun.run_id);
    assert(treeNode, `run tree did not include ${promptRun.run_id}`);
    assert(treeNode.source?.managed_run === true, "run tree node is not linked to managed run record");
    assertNoPlatformIds(tree, "run tree response");
    console.log(`ok run tree includes managed run ${promptRun.run_id}`);

    if (checkSandboxExec) {
      await runSandboxExecSmoke(agent.agent_id, promptRun.session_id);
    } else {
      console.log("skip sandbox exec smoke; pass --check-sandbox-exec to require it");
    }

    if (checkQueueAbort) {
      await runQueueAbortSmoke(agent.agent_id);
    } else {
      console.log("skip queued abort smoke; pass --check-queue-abort to require it");
    }

    if (checkActiveAbort) {
      await runActiveAbortSmoke(agent.agent_id);
    } else {
      console.log("skip active abort smoke; pass --check-active-abort to require it");
    }

    console.log("PASS Cloudflare/Flue smoke");
  } finally {
    await cleanupCreated();
  }
}

async function runQueueAbortSmoke(agentId) {
  const first = await startRun(
    agentId,
    `Keep this run busy long enough for a queued smoke turn. Token: ${smokeId}`,
  );
  const queued = await request(
    "POST",
    `/v1/sessions/${encodeURIComponent(first.session_id)}/events`,
    {
      body: {
        type: "user.message",
        content: `This turn should be queued and then aborted. Token: ${smokeId}`,
      },
    },
  );
  assert(queued.queued === true, "second turn did not enter the managed queue");
  assertString(queued.run_id, "queued run_id");

  const aborted = await request(
    "POST",
    `/v1/sessions/${encodeURIComponent(first.session_id)}/runs/${encodeURIComponent(queued.run_id)}/abort`,
    { body: { reason: "Cloudflare smoke queued-abort check" } },
  );
  assert(aborted.aborted === true, "queued run abort did not report aborted=true");
  assert(aborted.run?.status === "cancelled", `queued run status is ${aborted.run?.status}`);
  console.log(`ok queued run ${queued.run_id} cancelled`);

  await waitForRun(first.session_id, first.run_id);
}

async function runActiveAbortSmoke(agentId) {
  const active = await startRun(
    agentId,
    `Stay active until cancelled if possible. Token: ${smokeId}`,
  );
  const aborted = await request(
    "POST",
    `/v1/sessions/${encodeURIComponent(active.session_id)}/runs/${encodeURIComponent(active.run_id)}/abort`,
    { body: { reason: "Cloudflare smoke active-abort check" } },
  );
  assert(aborted.aborted === true, "active run abort did not report aborted=true");
  const terminal = await waitForRun(active.session_id, active.run_id);
  assert(
    terminal.status === "cancelled" || terminal.status === "failed" || terminal.status === "skipped",
    `active run abort left terminal status ${terminal.status}`,
  );
  console.log(`ok active run ${active.run_id} abort reached terminal status ${terminal.status}`);
}

async function runSandboxExecSmoke(agentId, sessionId) {
  if (!token) {
    throw new Error("sandbox exec smoke requires OMA_API_TOKEN because it can execute commands");
  }
  await putFile(agentId, sessionId, "src/input.txt", smokeId);
  await putFile(agentId, sessionId, "obsolete.txt", "delete me");

  const command = [
    "sh",
    "-lc",
    "'mkdir -p dist && printf built: > dist/result.txt && cat src/input.txt >> dist/result.txt && rm obsolete.txt'",
  ].join(" ");
  const result = await request("POST", "/_oma/smoke/sandbox-exec", {
    body: {
      agent_id: agentId,
      session_id: sessionId,
      command,
      cwd: ".",
      timeout_seconds: 30,
    },
  });
  assert(result.exit_code === 0, `sandbox exec exited ${result.exit_code}: ${result.stderr ?? ""}`);
  assert(
    Array.isArray(result.event_types) &&
      result.event_types.includes("agent.tool_use") &&
      result.event_types.includes("agent.tool_result") &&
      result.event_types.includes("session.run_start") &&
      result.event_types.includes("session.run_end"),
    `sandbox exec did not report Flue shell operation events: ${JSON.stringify(result.event_types)}`,
  );
  assert(
    Array.isArray(result.run_kinds) && result.run_kinds.includes("shell"),
    `sandbox exec did not expose shell run kind: ${JSON.stringify(result.run_kinds)}`,
  );
  assertNoPlatformIds(result, "sandbox exec smoke response");

  const output = await getFileText(agentId, sessionId, "dist/result.txt");
  assert(output === `built:${smokeId}`, `sandbox output mismatch: ${JSON.stringify(output)}`);
  assert(!await fileExists(agentId, sessionId, "obsolete.txt"), "sandbox deletion did not sync back");
  console.log("ok sandbox exec wrote dist/result.txt and synced deletion");
}

async function startRun(agentId, task) {
  const result = await request("POST", `/v1/agents/${encodeURIComponent(agentId)}/run`, {
    body: { task },
  });
  assertString(result.session_id, "session_id");
  assertString(result.run_id, "run_id");
  createdSessionIds.add(result.session_id);
  assertNoPlatformIds(result, "run start response");
  return result;
}

async function cleanupCreated() {
  if (keep) {
    console.log("skip cleanup because --keep or OMA_SMOKE_KEEP is set");
    return;
  }
  for (const sessionId of Array.from(createdSessionIds).reverse()) {
    try {
      await request("DELETE", `/v1/sessions/${encodeURIComponent(sessionId)}`);
      console.log(`ok deleted smoke session ${sessionId}`);
    } catch (err) {
      console.warn(`warn failed to delete smoke session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const agentId of Array.from(createdAgentIds).reverse()) {
    try {
      await request("DELETE", `/v1/agents/${encodeURIComponent(agentId)}`);
      console.log(`ok deleted smoke agent ${agentId}`);
    } catch (err) {
      console.warn(`warn failed to delete smoke agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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

async function fileExists(agentId, sessionId, path) {
  const response = await fetch(
    `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/files/${encodePath(path)}?session_id=${encodeURIComponent(sessionId)}`,
    { headers: authHeaders() },
  );
  if (response.status === 404) return false;
  if (!response.ok) {
    const body = await parseResponseBody(response);
    throw new Error(`GET file ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  await response.arrayBuffer();
  return true;
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
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
      normalized.includes("durable_object")
      || normalized.includes("workflow_id")
      || normalized.includes("d1_")
      || normalized.includes("r2_")
      || normalized === "cloudflare_id"
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertString(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} must be a non-empty string`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
