#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = "oma.adapter.v1";
const TOKEN = "oma-conformance-token";
const CAPABILITY_KEYS = [
  "streaming",
  "cancel",
  "interrupt",
  "tool_approvals",
  "mcp",
  "dynamic_model_patch",
  "compaction",
  "native_session_resume",
  "usage",
  "subagents",
];

const MANAGED_EVENT_TYPES = new Set([
  "user.message",
  "agent.message",
  "agent.error",
  "agent.tool_use",
  "agent.tool_result",
  "agent.thinking",
  "agent.tool_confirmation_request",
  "session.model_change",
  "session.thinking_level_change",
  "session.compaction",
  "session.runtime_notice",
]);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ADAPTERS = {
  hermes: {
    harnessId: "hermes",
    command: process.env.PYTHON ?? "python3",
    args: [path.join(repoRoot, "docker/hermes-adapter/oma_hermes_adapter.py")],
    env(tempDir) {
      return {
        OMA_STATE_DIR: path.join(tempDir, "workspace"),
        HERMES_HOME: path.join(tempDir, "workspace/.hermes"),
        TERMINAL_CWD: path.join(tempDir, "workspace"),
      };
    },
  },
  codex: {
    harnessId: "codex",
    command: process.env.PYTHON ?? "python3",
    args: [path.join(repoRoot, "docker/codex-adapter/oma_codex_adapter.py")],
    env(tempDir) {
      return {
        OMA_STATE_DIR: path.join(tempDir, "workspace"),
        OMA_CODEX_HOME: path.join(tempDir, "workspace/.codex"),
        CODEX_HOME: path.join(tempDir, "workspace/.codex"),
        OMA_CODEX_CWD: path.join(tempDir, "workspace"),
      };
    },
  },
  "claude-agent-sdk": {
    harnessId: "claude-agent-sdk",
    command: process.execPath,
    args: [path.join(
      repoRoot,
      "docker/claude-agent-sdk-adapter/oma_claude_agent_sdk_adapter.mjs",
    )],
    env(tempDir) {
      return {
        OMA_STATE_DIR: path.join(tempDir, "workspace"),
        OMA_CLAUDE_CWD: path.join(tempDir, "workspace"),
        OMA_CLAUDE_CONFIG_DIR: path.join(tempDir, "workspace/.claude"),
        CLAUDE_CONFIG_DIR: path.join(tempDir, "workspace/.claude"),
      };
    },
  },
};

function usage() {
  console.error(`Usage:
  node scripts/check-adapter-server.mjs --all
  node scripts/check-adapter-server.mjs --adapter hermes|codex|claude-agent-sdk
  node scripts/check-adapter-server.mjs --base-url http://127.0.0.1:18789 --harness-id hermes [--token TOKEN]`);
}

function parseArgs(argv) {
  const out = { token: TOKEN };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--all") out.all = true;
    else if (arg === "--adapter") out.adapter = argv[++i];
    else if (arg === "--base-url") out.baseUrl = argv[++i];
    else if (arg === "--harness-id") out.harnessId = argv[++i];
    else if (arg === "--token") out.token = argv[++i];
    else {
      usage();
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  assert(address && typeof address === "object", "failed to allocate local port");
  return address.port;
}

async function readJsonResponse(res) {
  const text = await res.text();
  let data = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(`HTTP ${res.status} returned non-JSON body: ${text.slice(0, 300)}`);
    }
  }
  return { status: res.status, ok: res.ok, data };
}

function headers(token) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function requestJson(baseUrl, method, route, token, body, includeAuth = true) {
  const init = {
    method,
    headers: includeAuth ? headers(token) : { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(5_000),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${route}`, init);
  return readJsonResponse(res);
}

function assertErrorEnvelope(response, code) {
  assert(!response.ok, `expected error ${code}, got HTTP ${response.status}`);
  assert(response.data && typeof response.data === "object", "error body must be object");
  assert(response.data.error && typeof response.data.error === "object", "missing error envelope");
  assert(response.data.error.code === code, `expected error code ${code}, got ${response.data.error.code}`);
  assert(typeof response.data.error.message === "string", "error message must be string");
  assert(typeof response.data.error.retryable === "boolean", "error retryable must be boolean");
}

function assertProtocolEnvelope(response, route) {
  assert(response.ok, `${route} returned HTTP ${response.status}: ${JSON.stringify(response.data)}`);
  assert(response.data.protocol_version === PROTOCOL_VERSION, `${route} protocol_version mismatch`);
}

function assertNativeMaybe(native, route) {
  if (native === undefined || native === null) return;
  assert(typeof native === "object" && !Array.isArray(native), `${route} native must be object`);
  if (native.native_session_id !== undefined && native.native_session_id !== null) {
    assert(typeof native.native_session_id === "string", `${route} native_session_id must be string/null`);
  }
  if (native.native_thread_id !== undefined && native.native_thread_id !== null) {
    assert(typeof native.native_thread_id === "string", `${route} native_thread_id must be string/null`);
  }
  if (native.native_metadata !== undefined && native.native_metadata !== null) {
    assert(typeof native.native_metadata === "object", `${route} native_metadata must be object/null`);
    assert(!Array.isArray(native.native_metadata), `${route} native_metadata must not be array`);
  }
}

function assertPlainObject(value, route, name) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${route} ${name} must be object`);
}

function assertNonnegativeInteger(value, route, name) {
  assert(Number.isInteger(value) && value >= 0, `${route} ${name} must be nonnegative integer`);
}

function assertUsageMaybe(usage, route) {
  if (usage === undefined || usage === null) return;
  assertPlainObject(usage, route, "usage");
  assertNonnegativeInteger(usage.tokens_in, route, "usage.tokens_in");
  assertNonnegativeInteger(usage.tokens_out, route, "usage.tokens_out");
  if (usage.cost_usd !== undefined) {
    assert(typeof usage.cost_usd === "number" && usage.cost_usd >= 0, `${route} usage.cost_usd must be nonnegative number`);
  }
  if (usage.model !== undefined) {
    assert(typeof usage.model === "string" && usage.model.length > 0, `${route} usage.model must be nonempty string`);
  }
}

function assertManagedEvent(event, route, expectedSessionId) {
  assertPlainObject(event, route, "event");
  assert(typeof event.event_id === "string" && event.event_id.length > 0, `${route} event_id must be nonempty string`);
  assert(typeof event.session_id === "string" && event.session_id.length > 0, `${route} session_id must be nonempty string`);
  if (expectedSessionId !== undefined) {
    assert(event.session_id === expectedSessionId, `${route} event session mismatch: expected ${expectedSessionId}, got ${event.session_id}`);
  }
  assert(MANAGED_EVENT_TYPES.has(event.type), `${route} unsupported event type ${event.type}`);
  assert(typeof event.content === "string", `${route} event.content must be string`);
  assertNonnegativeInteger(event.created_at, route, "event.created_at");

  for (const key of ["tokens_in", "tokens_out"]) {
    if (event[key] !== undefined) assertNonnegativeInteger(event[key], route, `event.${key}`);
  }
  if (event.cost_usd !== undefined) {
    assert(typeof event.cost_usd === "number" && event.cost_usd >= 0, `${route} event.cost_usd must be nonnegative number`);
  }
  for (const key of ["model", "tool_name", "tool_call_id", "approval_id"]) {
    if (event[key] !== undefined) {
      assert(typeof event[key] === "string" && event[key].length > 0, `${route} event.${key} must be nonempty string`);
    }
  }
  if (event.tool_arguments !== undefined) {
    assertPlainObject(event.tool_arguments, route, "event.tool_arguments");
  }
  if (event.is_error !== undefined) {
    assert(typeof event.is_error === "boolean", `${route} event.is_error must be boolean`);
  }
}

function assertEventList(events, route, expectedSessionId) {
  assert(Array.isArray(events), `${route} events must be an array`);
  let previousCreatedAt = -1;
  const seenIds = new Set();
  for (const event of events) {
    assertManagedEvent(event, route, expectedSessionId);
    assert(!seenIds.has(event.event_id), `${route} duplicate event_id ${event.event_id}`);
    seenIds.add(event.event_id);
    assert(event.created_at >= previousCreatedAt, `${route} events must be chronological`);
    previousCreatedAt = event.created_at;
  }
}

function assertTurnResult(result, route, expectedSessionId) {
  assertPlainObject(result, route, "turn result");
  assert(result.protocol_version === PROTOCOL_VERSION, `${route} turn result protocol_version mismatch`);
  assert(typeof result.output === "string", `${route} turn result output must be string`);
  assertUsageMaybe(result.usage, route);
  assertNativeMaybe(result.native, route);
  assertEventList(result.events, route, expectedSessionId);
}

function assertControlResponse(response, route) {
  assertProtocolEnvelope(response, route);
  assert(typeof response.data.accepted === "boolean", `${route} accepted must be boolean`);
  assertNativeMaybe(response.data.native, route);
}

function turnRequest(sessionId, harnessId, turn) {
  return {
    protocol_version: PROTOCOL_VERSION,
    session: { managed_session_id: sessionId },
    agent: {
      agent_id: `agt_conformance_${harnessId.replaceAll("-", "_")}`,
      harness_id: harnessId,
      model: "conformance/model",
      instructions: "Echo the marker exactly.",
      tools: [],
      permission_policy: { type: "always_allow" },
      mcp_servers: {},
      thinking_level: "off",
      callable_agents: [],
      max_subagent_depth: 0,
    },
    environment: { networking: { type: "unrestricted" } },
    turn: {
      content: turn.content,
      stream: turn.stream,
      timeout_ms: 5_000,
    },
  };
}

function streamTurnRequest(sessionId, harnessId) {
  return turnRequest(sessionId, harnessId, {
    content: `stream-conformance-${harnessId}`,
    stream: true,
  });
}

function parseSseFrame(rawFrame, route) {
  const dataLines = rawFrame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n");
  if (data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch (error) {
    throw new Error(`${route} returned invalid SSE JSON: ${data.slice(0, 300)}`);
  }
}

async function readSseFramesUntilCompleted(res, route) {
  assert(res.body, `${route} response is missing a readable body`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) break;
        const rawFrame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const frame = parseSseFrame(rawFrame, route);
        if (!frame) continue;
        frames.push(frame);
        if (frame.type === "turn.completed") return frames;
      }
    }

    buffer += decoder.decode();
    const frame = parseSseFrame(buffer, route);
    if (frame) frames.push(frame);
    return frames;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function assertStreamFrame(frame, route, expectedSessionId) {
  assertPlainObject(frame, route, "stream frame");
  assert(typeof frame.type === "string" && frame.type.length > 0, `${route} frame.type must be string`);
  if (frame.type === "delta") {
    assert(typeof frame.content === "string", `${route} delta.content must be string`);
    return;
  }
  if (frame.type === "event") {
    assertManagedEvent(frame.event, route, expectedSessionId);
    return;
  }
  if (frame.type === "approval.requested") {
    assertPlainObject(frame.approval, route, "approval");
    assert(typeof frame.approval.approval_id === "string" && frame.approval.approval_id.length > 0, `${route} approval_id must be string`);
    assert(frame.approval.managed_session_id === expectedSessionId, `${route} approval session mismatch`);
    assert(typeof frame.approval.tool_name === "string" && frame.approval.tool_name.length > 0, `${route} approval tool_name must be string`);
    assert(typeof frame.approval.description === "string", `${route} approval description must be string`);
    assertNonnegativeInteger(frame.approval.arrived_at, route, "approval.arrived_at");
    return;
  }
  if (frame.type === "approval.resolved") {
    assert(typeof frame.approval_id === "string" && frame.approval_id.length > 0, `${route} approval_id must be string`);
    if (frame.decision !== undefined) assert(["allow", "deny"].includes(frame.decision), `${route} invalid approval decision`);
    return;
  }
  if (frame.type === "state") {
    assert(["starting", "running", "final", "error"].includes(frame.state), `${route} invalid state ${frame.state}`);
    if (frame.error_message !== undefined) assert(typeof frame.error_message === "string", `${route} error_message must be string`);
    return;
  }
  if (frame.type === "turn.completed") {
    assertTurnResult(frame.result, route, expectedSessionId);
    return;
  }
  throw new Error(`${route} unknown stream frame type ${frame.type}`);
}

async function assertStreamingTurn(baseUrl, token, sessionId, harnessId) {
  const route = `POST /sessions/${sessionId}/turns stream`;
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/turns`, {
    method: "POST",
    headers: {
      ...headers(token),
      Accept: "text/event-stream",
    },
    body: JSON.stringify(streamTurnRequest(sessionId, harnessId)),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    assert(false, `${route} returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  assert(contentType.includes("text/event-stream"), `${route} content-type must be text/event-stream, got ${contentType}`);

  const frames = await readSseFramesUntilCompleted(res, route);
  assert(frames.length > 0, `${route} returned no SSE data frames`);
  for (const frame of frames) assertStreamFrame(frame, route, sessionId);

  const errors = frames.filter((frame) => frame.type === "state" && frame.state === "error");
  assert(errors.length === 0, `${route} returned error state: ${errors.map((frame) => frame.error_message ?? "").join("; ")}`);

  const eventFrames = frames.filter((frame) => frame.type === "event");
  assert(eventFrames.length > 0, `${route} must emit at least one managed event frame`);
  assert(eventFrames.some((frame) => frame.event.type === "user.message"), `${route} must emit the user.message event`);

  const completed = frames.filter((frame) => frame.type === "turn.completed");
  assert(completed.length === 1, `${route} must emit exactly one turn.completed frame`);
  assert(completed[0].result.events.length > 0, `${route} turn.completed result must include managed events`);
}

function assertOutcomeResponse(response, route) {
  assertProtocolEnvelope(response, route);
  assert(["idle", "starting", "running", "failed"].includes(response.data.status), `${route} invalid status ${response.data.status}`);
  if (response.data.output !== undefined) assert(typeof response.data.output === "string", `${route} output must be string`);
  assertUsageMaybe(response.data.usage, route);
  if (response.data.error_message !== undefined) assert(typeof response.data.error_message === "string", `${route} error_message must be string`);
  assertNativeMaybe(response.data.native, route);
}

async function assertNonStreamingTurn(baseUrl, token, sessionId, harnessId) {
  const marker = `turn-conformance-${harnessId}`;
  const route = `POST /sessions/${sessionId}/turns`;
  const turn = await requestJson(
    baseUrl,
    "POST",
    `/sessions/${encodeURIComponent(sessionId)}/turns`,
    token,
    turnRequest(sessionId, harnessId, {
      content: marker,
      stream: false,
    }),
  );
  assertProtocolEnvelope(turn, route);
  assertTurnResult(turn.data, route, sessionId);
  assert(turn.data.output === marker, `${route} output mismatch: expected ${marker}, got ${turn.data.output}`);
  assert(turn.data.events.some((event) => event.type === "user.message" && event.content === marker), `${route} must include user.message`);
  assert(turn.data.events.some((event) => event.type === "agent.message" && event.content === marker), `${route} must include agent.message`);

  const events = await requestJson(
    baseUrl,
    "GET",
    `/sessions/${encodeURIComponent(sessionId)}/events`,
    token,
  );
  assertProtocolEnvelope(events, "GET /events after turn");
  assertEventList(events.data.events, "GET /events after turn", sessionId);
  assert(events.data.events.some((event) => event.type === "user.message" && event.content === marker), "GET /events after turn must include user.message");
  assert(events.data.events.some((event) => event.type === "agent.message" && event.content === marker), "GET /events after turn must include agent.message");

  const outcome = await requestJson(
    baseUrl,
    "GET",
    `/sessions/${encodeURIComponent(sessionId)}/outcome`,
    token,
  );
  assertOutcomeResponse(outcome, "GET /outcome after turn");
  assert(outcome.data.status === "idle", `GET /outcome after turn status should be idle, got ${outcome.data.status}`);
  assert(outcome.data.output === marker, `GET /outcome after turn output mismatch: expected ${marker}, got ${outcome.data.output}`);
}

async function waitForReady(baseUrl, processState) {
  const deadline = Date.now() + 10_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (processState?.exited) {
      throw new Error(`adapter exited before readyz\n${processState.output()}`);
    }
    try {
      const response = await requestJson(baseUrl, "GET", "/readyz", TOKEN, undefined, false);
      if (response.ok) return response;
      lastError = `HTTP ${response.status} ${JSON.stringify(response.data)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`adapter did not become ready: ${lastError}\n${processState?.output?.() ?? ""}`);
}

async function runChecks({ baseUrl, harnessId, token, readyResponse }) {
  const ready = readyResponse ?? await requestJson(baseUrl, "GET", "/readyz", token, undefined, false);
  assertProtocolEnvelope(ready, "GET /readyz");
  assert(ready.data.harness_id === harnessId, `readyz harness_id mismatch: expected ${harnessId}, got ${ready.data.harness_id}`);
  assert(ready.data.capabilities && typeof ready.data.capabilities === "object", "readyz missing capabilities");
  for (const key of CAPABILITY_KEYS) {
    assert(typeof ready.data.capabilities[key] === "boolean", `readyz capability ${key} must be boolean`);
  }

  const sessionId = `ses_conformance_${harnessId.replaceAll("-", "_")}`;

  const unauthenticated = await requestJson(
    baseUrl,
    "GET",
    `/sessions/${encodeURIComponent(sessionId)}/events`,
    token,
    undefined,
    false,
  );
  assertErrorEnvelope(unauthenticated, "bad_request");
  assert(unauthenticated.status === 401, `unauthenticated events should return 401, got ${unauthenticated.status}`);

  const badTurn = await requestJson(
    baseUrl,
    "POST",
    `/sessions/${encodeURIComponent(sessionId)}/turns`,
    token,
    { protocol_version: "oma.adapter.bad" },
  );
  assertErrorEnvelope(badTurn, "bad_request");

  const events = await requestJson(
    baseUrl,
    "GET",
    `/sessions/${encodeURIComponent(sessionId)}/events`,
    token,
  );
  assertProtocolEnvelope(events, "GET /events");
  assertEventList(events.data.events, "GET /events", sessionId);
  assertNativeMaybe(events.data.native, "GET /events");

  const initialOutcome = await requestJson(
    baseUrl,
    "GET",
    `/sessions/${encodeURIComponent(sessionId)}/outcome`,
    token,
  );
  assertOutcomeResponse(initialOutcome, "GET /outcome");

  const approvals = await requestJson(
    baseUrl,
    "GET",
    `/sessions/${encodeURIComponent(sessionId)}/approvals`,
    token,
  );
  assertProtocolEnvelope(approvals, "GET /approvals");
  assert(Array.isArray(approvals.data.approvals), "approvals must be an array");
  assertNativeMaybe(approvals.data.native, "GET /approvals");

  await assertNonStreamingTurn(baseUrl, token, sessionId, harnessId);

  if (ready.data.capabilities.streaming === true) {
    await assertStreamingTurn(baseUrl, token, `${sessionId}_stream`, harnessId);
  }

  const controlBody = {
    protocol_version: PROTOCOL_VERSION,
    session: { managed_session_id: sessionId },
  };

  assertControlResponse(
    await requestJson(baseUrl, "POST", `/sessions/${encodeURIComponent(sessionId)}/cancel`, token, controlBody),
    "POST /cancel",
  );
  assertControlResponse(
    await requestJson(baseUrl, "POST", `/sessions/${encodeURIComponent(sessionId)}/interrupt`, token, {
      ...controlBody,
      message: "stop",
    }),
    "POST /interrupt",
  );
  assertControlResponse(
    await requestJson(baseUrl, "POST", `/sessions/${encodeURIComponent(sessionId)}/patch`, token, {
      ...controlBody,
      model: "conformance/model",
      thinking_level: "off",
    }),
    "POST /patch",
  );

  const missingApproval = await requestJson(
    baseUrl,
    "POST",
    `/sessions/${encodeURIComponent(sessionId)}/approvals/ap_missing`,
    token,
    {
      ...controlBody,
      approval_id: "ap_missing",
      decision: "deny",
    },
  );
  assertErrorEnvelope(missingApproval, "tool_approval_not_found");
  assert(missingApproval.status === 404, `missing approval should return 404, got ${missingApproval.status}`);

  if (ready.data.capabilities.compaction === false) {
    const compact = await requestJson(
      baseUrl,
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/compact`,
      token,
      controlBody,
    );
    assertErrorEnvelope(compact, "unsupported_capability");
  }

  console.log(`ok ${harnessId} ${baseUrl}`);
}

async function runSpawnedAdapter(adapterName) {
  const def = ADAPTERS[adapterName];
  assert(def, `unknown adapter ${adapterName}`);
  const port = await getFreePort();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `oma-${adapterName}-`));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(def.command, def.args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...def.env(tempDir),
      OMA_ADAPTER_CONFORMANCE: "1",
      OMA_ADAPTER_HOST: "127.0.0.1",
      OMA_ADAPTER_PORT: String(port),
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_GATEWAY_TOKEN: TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  const processState = {
    exited: false,
    output() {
      return [
        stdout.length ? `stdout:\n${stdout.join("")}` : "",
        stderr.length ? `stderr:\n${stderr.join("")}` : "",
      ].filter(Boolean).join("\n");
    },
  };
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  child.on("exit", () => {
    processState.exited = true;
  });

  try {
    const readyResponse = await waitForReady(baseUrl, processState);
    await runChecks({
      baseUrl,
      harnessId: def.harnessId,
      token: TOKEN,
      readyResponse,
    });
  } finally {
    if (!processState.exited) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.all) {
    for (const name of Object.keys(ADAPTERS)) {
      await runSpawnedAdapter(name);
    }
    return;
  }
  if (args.adapter) {
    await runSpawnedAdapter(args.adapter);
    return;
  }
  if (args.baseUrl && args.harnessId) {
    await runChecks({
      baseUrl: args.baseUrl.replace(/\/+$/, ""),
      harnessId: args.harnessId,
      token: args.token,
    });
    return;
  }
  usage();
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
