#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const REQUIRED_CHECKS = [
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

const opts = parseArgs(process.argv.slice(2));
const reportPath = opts._[0] ?? opts.report ?? process.env.OMA_SMOKE_REPORT_PATH;

main().catch((err) => {
  console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

async function main() {
  if (!reportPath) {
    throw new Error("usage: pnpm smoke:verify-report -- ./promotion-report.json");
  }

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const failures = [];

  if (report.schema_version !== 1) failures.push("schema_version must be 1");
  if (report.mode !== "promotion") failures.push("mode must be promotion");
  if (report.status !== "passed") failures.push("status must be passed");
  if (!isDeployedHttpsUrl(report.target)) {
    failures.push("target must be a deployed https URL, not localhost");
  }
  if (!nonEmptyString(report.model)) failures.push("model must be a non-empty string");
  if (!nonEmptyString(report.smoke_id)) failures.push("smoke_id must be a non-empty string");
  if (!nonEmptyString(report.started_at)) failures.push("started_at must be present");
  if (!nonEmptyString(report.finished_at)) failures.push("finished_at must be present");

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
  requireCloudflareRuntimeEvidence(checksByName.get("health"), failures);

  const resources = report.resources ?? {};
  if (!Array.isArray(resources.agent_ids) || resources.agent_ids.length < 1) {
    failures.push("resources.agent_ids must contain at least one agent id");
  }
  if (!Array.isArray(resources.session_ids) || resources.session_ids.length < 1) {
    failures.push("resources.session_ids must contain at least one session id");
  }
  if (!Array.isArray(resources.run_ids) || resources.run_ids.length < 1) {
    failures.push("resources.run_ids must contain at least one run id");
  }

  const cleanup = Array.isArray(report.cleanup) ? report.cleanup : [];
  if (cleanup.length < 1) {
    failures.push("cleanup must include deleted smoke resources");
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
    throw new Error(`promotion report verification failed with ${failures.length} issue(s)`);
  }

  console.log(`PASS promotion report ${reportPath}`);
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

function requireCloudflareRuntimeEvidence(healthCheck, failures) {
  const runtime = healthCheck?.runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    failures.push("health check must include runtime evidence");
    return;
  }
  if (runtime.platform !== "cloudflare") {
    failures.push(`health runtime platform must be cloudflare, got ${runtime.platform}`);
  }
  if (runtime.stack !== "cloudflare-flue") {
    failures.push(`health runtime stack must be cloudflare-flue, got ${runtime.stack}`);
  }
  if (runtime.mode !== "native") {
    failures.push(`health runtime mode must be native, got ${runtime.mode}`);
  }
  if (runtime.default_harness !== "flue") {
    failures.push(`health runtime default_harness must be flue, got ${runtime.default_harness}`);
  }
  const bindings = runtime.bindings && typeof runtime.bindings === "object"
    ? runtime.bindings
    : {};
  for (const name of ["metadata", "database", "workspace", "workflow", "workers_ai", "sandbox"]) {
    if (bindings[name] !== true) {
      failures.push(`health runtime binding ${name} must be configured`);
    }
  }
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
