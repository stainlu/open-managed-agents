#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const REQUIRED_CHECKS = [
  "health",
  "harness_catalog",
  "state_readback",
  "replay_verified",
];

const opts = parseArgs(process.argv.slice(2));
const reportPath = opts._[0] ?? opts.report ?? process.env.OMA_REPLAY_REPORT_PATH;

main().catch((err) => {
  console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

async function main() {
  if (!reportPath) {
    throw new Error("usage: pnpm smoke:verify-replay-report -- ./replay-report.json");
  }

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const failures = [];

  if (report.schema_version !== 1) failures.push("schema_version must be 1");
  if (report.kind !== "cloudflare_flue_replay_report") {
    failures.push("kind must be cloudflare_flue_replay_report");
  }
  if (report.phase !== "verify") failures.push("phase must be verify");
  if (report.status !== "passed") failures.push("status must be passed");
  if (!isDeployedHttpsUrl(report.target)) {
    failures.push("target must be a deployed https URL, not localhost");
  }
  if (!nonEmptyString(report.model)) failures.push("model must be a non-empty string");
  if (!nonEmptyString(report.smoke_id)) failures.push("smoke_id must be a non-empty string");
  if (!nonEmptyString(report.seeded_at)) failures.push("seeded_at must be present");
  if (!nonEmptyString(report.started_at)) failures.push("started_at must be present");
  if (!nonEmptyString(report.finished_at)) failures.push("finished_at must be present");
  if (!nonEmptyString(report.restart_evidence)) {
    failures.push("restart_evidence must record the redeploy/restart/hibernation action");
  }

  const checks = Array.isArray(report.checks) ? report.checks : [];
  const checksByName = new Map(checks.map((check) => [check?.name, check]));
  for (const name of REQUIRED_CHECKS) {
    const check = checksByName.get(name);
    if (!check) {
      failures.push(`missing required check ${name}`);
    } else if (check.status !== "passed") {
      failures.push(`required check ${name} has status ${check.status}`);
    }
  }
  for (const check of checks) {
    if (check?.status === "skipped") failures.push(`check ${check.name} was skipped`);
  }

  const resources = report.resources ?? {};
  if (!nonEmptyString(resources.agent_id)) failures.push("resources.agent_id must be present");
  if (!nonEmptyString(resources.session_id)) failures.push("resources.session_id must be present");
  if (!nonEmptyString(resources.run_id)) failures.push("resources.run_id must be present");

  const cleanup = Array.isArray(report.cleanup) ? report.cleanup : [];
  const cleanupByType = new Map(cleanup.map((item) => [item?.type, item]));
  for (const type of ["session", "agent"]) {
    const item = cleanupByType.get(type);
    if (!item) {
      failures.push(`cleanup must include deleted ${type}`);
    } else if (item.status !== "deleted") {
      failures.push(`cleanup item ${type}:${item?.id ?? "unknown"} has status ${item.status}`);
    }
  }
  for (const item of cleanup) {
    if (item?.status !== "deleted") {
      failures.push(`cleanup item ${item?.type ?? "unknown"}:${item?.id ?? "unknown"} has status ${item?.status}`);
    }
  }

  const leakedPlatformKey = findPlatformIdKey(report);
  if (leakedPlatformKey) {
    failures.push(`report leaks platform id key ${leakedPlatformKey}`);
  }
  if (findBearerLikeValue(report)) {
    failures.push("report appears to contain a bearer token");
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`fail ${failure}`);
    throw new Error(`replay report verification failed with ${failures.length} issue(s)`);
  }

  console.log(`PASS replay report ${reportPath}`);
}

function parseArgs(args) {
  const parsed = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (raw === "--") {
      parsed._.push(...args.slice(i + 1));
      break;
    }
    if (!raw?.startsWith("--")) {
      parsed._.push(raw);
      continue;
    }
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

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
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

function findBearerLikeValue(value) {
  if (Array.isArray(value)) return value.some((item) => findBearerLikeValue(item));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && /bearer\s+[a-z0-9._~+/=-]+/i.test(value);
  }
  return Object.values(value).some((item) => findBearerLikeValue(item));
}
