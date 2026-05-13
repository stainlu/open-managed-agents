import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./verify-promotion-report.mjs", import.meta.url));
const requiredChecks = [
  "health",
  "runtime_profile",
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

let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("verify-promotion-report", () => {
  it("accepts a complete promotion report", async () => {
    const reportPath = await writeReport(passingReport());

    const result = await execFileAsync(process.execPath, [scriptPath, reportPath]);

    expect(result.stdout).toContain("PASS promotion report");
  });

  it("rejects failed localhost reports", async () => {
    const reportPath = await writeReport({
      ...passingReport(),
      status: "failed",
      target: "http://127.0.0.1:8787",
      checks: [],
      resources: { agent_ids: [], session_ids: [], run_ids: [] },
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

  it("rejects reports without native Flue harness evidence", async () => {
    const report = passingReport();
    const harness = report.checks.find((check) => check.name === "harness_catalog");
    harness.runtime_mode = "container";
    const reportPath = await writeReport(report);

    await expect(execFileAsync(process.execPath, [scriptPath, reportPath]))
      .rejects.toMatchObject({
        stderr: expect.stringContaining("harness_catalog runtime_mode must be native"),
      });
  });

  it("rejects leaked platform ids and bearer-looking values", async () => {
    const reportPath = await writeReport({
      ...passingReport(),
      cloudflare_id: "platform-id",
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
    mode: "promotion",
    target: "https://oma-cloudflare-flue.example.workers.dev",
    model: "cloudflare/@cf/openai/gpt-oss-20b",
    smoke_id: "oma-smoke-test",
    started_at: now,
    finished_at: now,
    status: "passed",
    checks: requiredChecks.map((name) => passedCheck(name, now)),
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

function passedCheck(name, now) {
  if (name === "health") return cloudflareHealthCheck(now);
  if (name === "runtime_profile") return cloudflareRuntimeProfileCheck(now);
  if (name === "harness_catalog") {
    return {
      name,
      status: "passed",
      at: now,
      harness_id: "flue",
      runtime_mode: "native",
    };
  }
  return { name, status: "passed", at: now };
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

function cloudflareRuntimeProfileCheck(now) {
  return {
    ...cloudflareHealthCheck(now),
    name: "runtime_profile",
  };
}

async function writeReport(report) {
  const dir = await mkdtemp(join(tmpdir(), "oma-promotion-report-"));
  tempDirs.push(dir);
  const reportPath = join(dir, "promotion-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}
