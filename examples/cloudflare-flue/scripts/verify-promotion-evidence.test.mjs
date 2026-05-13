import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./verify-promotion-evidence.mjs", import.meta.url));
const promotionChecks = [
  "health",
  "harness_catalog",
  "agent_create",
  "prompt_run",
  "event_filter",
  "run_tree",
  "state_readback",
  "sandbox_exec",
  "flue_task",
  "queued_abort",
  "active_abort",
];
const replayChecks = [
  "health",
  "harness_catalog",
  "state_readback",
  "replay_verified",
];

let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("verify-promotion-evidence", () => {
  it("accepts promotion and replay reports for the same deployed target", async () => {
    const { promotionReportPath, replayReportPath } = await writeReports();

    const result = await execFileAsync(process.execPath, [
      scriptPath,
      "--promotion",
      promotionReportPath,
      "--replay",
      replayReportPath,
    ]);

    expect(result.stdout).toContain("PASS Cloudflare promotion evidence");
  });

  it("rejects report bundles from different targets", async () => {
    const { promotionReportPath, replayReportPath } = await writeReports({
      replay: { target: "https://different.example.workers.dev" },
    });

    await expect(execFileAsync(process.execPath, [
      scriptPath,
      "--promotion",
      promotionReportPath,
      "--replay",
      replayReportPath,
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("target mismatch"),
    });
  });
});

async function writeReports(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "oma-promotion-evidence-"));
  tempDirs.push(dir);
  const promotionReportPath = join(dir, "promotion-report.json");
  const replayReportPath = join(dir, "replay-report.json");
  await writeFile(
    promotionReportPath,
    `${JSON.stringify({ ...promotionReport(), ...(overrides.promotion ?? {}) }, null, 2)}\n`,
  );
  await writeFile(
    replayReportPath,
    `${JSON.stringify({ ...replayReport(), ...(overrides.replay ?? {}) }, null, 2)}\n`,
  );
  return { promotionReportPath, replayReportPath };
}

function promotionReport() {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    mode: "promotion",
    target: "https://oma-cloudflare-flue.example.workers.dev",
    model: "cloudflare/@cf/openai/gpt-oss-20b",
    smoke_id: "oma-smoke-test",
    started_at: now,
    finished_at: now,
    status: "passed",
    checks: promotionChecks.map((name) =>
      name === "health"
        ? cloudflareHealthCheck(now)
        : { name, status: "passed", at: now }
    ),
    resources: {
      agent_ids: ["agt_test"],
      session_ids: ["ses_test"],
      run_ids: ["run_test"],
    },
    cleanup: [
      { type: "session", id: "ses_test", status: "deleted" },
      { type: "agent", id: "agt_test", status: "deleted" },
    ],
  };
}

function replayReport() {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    kind: "cloudflare_flue_replay_report",
    phase: "verify",
    target: "https://oma-cloudflare-flue.example.workers.dev",
    model: "cloudflare/@cf/openai/gpt-oss-20b",
    smoke_id: "oma-replay-test",
    seeded_at: now,
    started_at: now,
    finished_at: now,
    status: "passed",
    restart_evidence: "wrangler deploy completed at 2026-05-14T00:00:00.000Z",
    checks: replayChecks.map((name) =>
      name === "health"
        ? cloudflareHealthCheck(now)
        : { name, status: "passed", at: now }
    ),
    resources: {
      agent_id: "agt_replay",
      session_id: "ses_replay",
      run_id: "run_replay",
    },
    cleanup: [
      { type: "session", id: "ses_replay", status: "deleted" },
      { type: "agent", id: "agt_replay", status: "deleted" },
    ],
  };
}

function cloudflareHealthCheck(now) {
  return {
    name: "health",
    status: "passed",
    at: now,
    runtime: {
      platform: "cloudflare",
      stack: "cloudflare-flue",
      mode: "native",
      default_harness: "flue",
      bindings: {
        metadata: true,
        database: true,
        workspace: true,
        workflow: true,
        workers_ai: true,
        sandbox: true,
      },
    },
  };
}
