import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./replay-smoke.mjs", import.meta.url));

let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("replay-smoke", () => {
  it("seeds replay state, verifies it through a fresh process, and cleans up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oma-replay-smoke-"));
    tempDirs.push(dir);
    const statePath = join(dir, "replay-state.json");
    const reportPath = join(dir, "replay-report.json");
    const fakeStatePath = join(dir, "fake-oma-state.json");
    const preloadPath = join(dir, "fake-oma-fetch.mjs");
    await writeFile(fakeStatePath, `${JSON.stringify(initialFakeState(), null, 2)}\n`);
    await writeFile(preloadPath, fakeFetchPreloadSource());

    const seed = await runReplay(preloadPath, fakeStatePath, [
      "--phase",
      "seed",
      "--base-url",
      "https://fake-oma.example",
      "--token",
      "test-token",
      "--state",
      statePath,
    ]);

    expect(seed.stdout).toContain("PASS replay seed");
    let fakeState = JSON.parse(await readFile(fakeStatePath, "utf8"));
    expect(fakeState.deletedSessions).toEqual([]);
    expect(fakeState.deletedAgents).toEqual([]);

    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state).toMatchObject({
      schema_version: 1,
      kind: "cloudflare_flue_replay_state",
      target: "https://fake-oma.example",
      agent_id: "agt_replay",
      session_id: "ses_replay",
      run_id: "run_replay",
      probe_path: "replay/probe.txt",
    });
    expect(state.probe_content).toBe(`replay:${state.smoke_id}`);

    const verify = await runReplay(preloadPath, fakeStatePath, [
      "--phase",
      "verify",
      "--base-url",
      "https://fake-oma.example",
      "--token",
      "test-token",
      "--state",
      statePath,
      "--report",
      reportPath,
      "--restart-evidence",
      "test process restart boundary",
    ]);

    expect(verify.stdout).toContain("PASS replay verify");
    fakeState = JSON.parse(await readFile(fakeStatePath, "utf8"));
    expect(fakeState.deletedSessions).toEqual(["ses_replay"]);
    expect(fakeState.deletedAgents).toEqual(["agt_replay"]);

    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report).toMatchObject({
      schema_version: 1,
      kind: "cloudflare_flue_replay_report",
      phase: "verify",
      target: "https://fake-oma.example",
      status: "passed",
      restart_evidence: "test process restart boundary",
      resources: {
        agent_id: "agt_replay",
        session_id: "ses_replay",
        run_id: "run_replay",
      },
    });
    expect(report.checks.map((check) => check.name)).toEqual([
      "health",
      "harness_catalog",
      "state_readback",
      "replay_verified",
    ]);
    expect(report.cleanup.map((item) => `${item.type}:${item.status}`)).toEqual([
      "session:deleted",
      "agent:deleted",
    ]);
  });
});

function runReplay(preloadPath, fakeStatePath, args) {
  return execFileAsync(
    process.execPath,
    ["--import", preloadPath, scriptPath, ...args],
    {
      env: {
        ...process.env,
        FAKE_OMA_STATE: fakeStatePath,
      },
    },
  );
}

function initialFakeState() {
  return {
    agentId: "agt_replay",
    sessionId: "ses_replay",
    runId: "run_replay",
    smokeId: null,
    probeContent: null,
    deletedSessions: [],
    deletedAgents: [],
  };
}

function fakeFetchPreloadSource() {
  return String.raw`
import { readFile, writeFile } from "node:fs/promises";

const statePath = process.env.FAKE_OMA_STATE;
if (!statePath) throw new Error("FAKE_OMA_STATE is required");

globalThis.fetch = async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = String(init.method ?? "GET").toUpperCase();
  const state = await readState();
  if (url.pathname !== "/healthz" && init.headers?.authorization !== "Bearer test-token") {
    return json({ error: "unauthorized" }, 401);
  }

  if (method === "GET" && url.pathname === "/healthz") {
    return json({ ok: true, version: "test" });
  }
  if (method === "GET" && url.pathname === "/v1/harnesses") {
    return json({ harnesses: [{ harness_id: "flue", capabilities: {} }] });
  }
  if (method === "POST" && url.pathname === "/v1/agents") {
    const body = await readBodyJson(init);
    state.smokeId = body.name;
    await writeState(state);
    return json({ agent_id: state.agentId });
  }
  if (method === "POST" && url.pathname === "/v1/agents/" + state.agentId + "/run") {
    await readBodyJson(init);
    return json({ session_id: state.sessionId, run_id: state.runId });
  }
  if (method === "GET" && url.pathname === "/v1/sessions/" + state.sessionId + "/runs/" + state.runId) {
    return json({
      run_id: state.runId,
      session_id: state.sessionId,
      agent_id: state.agentId,
      status: "succeeded",
    });
  }
  if (method === "GET" && url.pathname === "/v1/sessions/" + state.sessionId) {
    return json({
      session_id: state.sessionId,
      agent_id: state.agentId,
      harness_id: "flue",
      status: "idle",
      output: "done " + state.smokeId,
      turns: 1,
    });
  }
  if (method === "GET" && url.pathname === "/v1/sessions/" + state.sessionId + "/events") {
    return json({
      events: [
        {
          event_id: "evt_user",
          session_id: state.sessionId,
          type: "user.message",
          content: "seed",
          run_id: state.runId,
        },
        {
          event_id: "evt_agent",
          session_id: state.sessionId,
          type: "agent.message",
          content: "done " + state.smokeId,
          run_id: state.runId,
        },
      ],
    });
  }
  if (method === "GET" && url.pathname === "/v1/sessions/" + state.sessionId + "/run-tree") {
    return json({
      session_id: state.sessionId,
      count: 1,
      runs: [{ run_id: state.runId, source: { managed_run: true }, children: [] }],
    });
  }
  if (
    method === "PUT" &&
    url.pathname === "/v1/agents/" + state.agentId + "/files/replay/probe.txt" &&
    url.searchParams.get("session_id") === state.sessionId
  ) {
    state.probeContent = await readBodyText(init);
    await writeState(state);
    return json({
      agent_id: state.agentId,
      path: "replay/probe.txt",
      size: state.probeContent.length,
    });
  }
  if (
    method === "GET" &&
    url.pathname === "/v1/agents/" + state.agentId + "/files" &&
    url.searchParams.get("session_id") === state.sessionId &&
    url.searchParams.get("path") === "replay"
  ) {
    return json({
      agent_id: state.agentId,
      path: "replay",
      entries: [
        {
          name: "probe.txt",
          path: "replay/probe.txt",
          type: "file",
          size: state.probeContent?.length ?? 0,
          mtime: Date.now(),
        },
      ],
    });
  }
  if (
    method === "GET" &&
    url.pathname === "/v1/agents/" + state.agentId + "/files/replay/probe.txt" &&
    url.searchParams.get("session_id") === state.sessionId
  ) {
    return text(state.probeContent ?? "");
  }
  if (method === "DELETE" && url.pathname === "/v1/sessions/" + state.sessionId) {
    state.deletedSessions.push(state.sessionId);
    await writeState(state);
    return json({ deleted: true });
  }
  if (method === "DELETE" && url.pathname === "/v1/agents/" + state.agentId) {
    state.deletedAgents.push(state.agentId);
    await writeState(state);
    return json({ deleted: true });
  }
  return json({ error: "not_found", method, path: url.pathname }, 404);
};

async function readState() {
  return JSON.parse(await readFile(statePath, "utf8"));
}

async function writeState(state) {
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
}

async function readBodyJson(init) {
  const raw = await readBodyText(init);
  return raw ? JSON.parse(raw) : {};
}

async function readBodyText(init) {
  if (typeof init.body === "string") return init.body;
  if (init.body instanceof Uint8Array) return Buffer.from(init.body).toString("utf8");
  if (init.body instanceof ArrayBuffer) return Buffer.from(init.body).toString("utf8");
  return "";
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}
`;
}
