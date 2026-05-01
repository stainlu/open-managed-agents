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

function assertControlResponse(response, route) {
  assertProtocolEnvelope(response, route);
  assert(typeof response.data.accepted === "boolean", `${route} accepted must be boolean`);
  assertNativeMaybe(response.data.native, route);
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
  assert(Array.isArray(events.data.events), "events must be an array");
  assertNativeMaybe(events.data.native, "GET /events");

  const approvals = await requestJson(
    baseUrl,
    "GET",
    `/sessions/${encodeURIComponent(sessionId)}/approvals`,
    token,
  );
  assertProtocolEnvelope(approvals, "GET /approvals");
  assert(Array.isArray(approvals.data.approvals), "approvals must be an array");
  assertNativeMaybe(approvals.data.native, "GET /approvals");

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
