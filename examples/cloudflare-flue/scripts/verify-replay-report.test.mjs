import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./verify-replay-report.mjs", import.meta.url));
const requiredChecks = [
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

describe("verify-replay-report", () => {
  it("accepts a complete replay report", async () => {
    const reportPath = await writeReport(passingReport());

    const result = await execFileAsync(process.execPath, [scriptPath, reportPath]);

    expect(result.stdout).toContain("PASS replay report");
  });

  it("rejects reports without restart evidence", async () => {
    const report = passingReport();
    delete report.restart_evidence;
    const reportPath = await writeReport(report);

    await expect(execFileAsync(process.execPath, [scriptPath, reportPath]))
      .rejects.toMatchObject({
        stderr: expect.stringContaining("restart_evidence must record"),
      });
  });

  it("rejects failed localhost reports", async () => {
    const reportPath = await writeReport({
      ...passingReport(),
      status: "failed",
      target: "http://127.0.0.1:8787",
      checks: [],
      cleanup: [],
    });

    await expect(execFileAsync(process.execPath, [scriptPath, reportPath]))
      .rejects.toMatchObject({
        stderr: expect.stringContaining("target must be a deployed https URL"),
      });
  });

  it("rejects reports without OMA state readback evidence", async () => {
    const report = passingReport();
    report.checks = report.checks.filter((check) => check.name !== "state_readback");
    const reportPath = await writeReport(report);

    await expect(execFileAsync(process.execPath, [scriptPath, reportPath]))
      .rejects.toMatchObject({
        stderr: expect.stringContaining("missing required check state_readback"),
      });
  });

  it("rejects leaked platform ids and bearer-looking values", async () => {
    const reportPath = await writeReport({
      ...passingReport(),
      workflow_id: "platform-id",
      note: "Bearer secret-token",
    });

    await expect(execFileAsync(process.execPath, [scriptPath, reportPath]))
      .rejects.toMatchObject({
        stderr: expect.stringContaining("report leaks platform id key"),
      });
  });
});

function passingReport() {
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
    checks: requiredChecks.map((name) => ({ name, status: "passed", at: now })),
    resources: {
      agent_id: "agt_test",
      session_id: "ses_test",
      run_id: "run_test",
    },
    cleanup: [
      { type: "session", id: "ses_test", status: "deleted" },
      { type: "agent", id: "agt_test", status: "deleted" },
    ],
  };
}

async function writeReport(report) {
  const dir = await mkdtemp(join(tmpdir(), "oma-replay-report-"));
  tempDirs.push(dir);
  const reportPath = join(dir, "replay-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}
