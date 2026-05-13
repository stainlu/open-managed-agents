#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const promotionVerifier = join(here, "verify-promotion-report.mjs");
const replayVerifier = join(here, "verify-replay-report.mjs");

const opts = parseArgs(process.argv.slice(2));
const promotionReportPath = opts.promotion ?? opts._[0] ?? process.env.OMA_PROMOTION_REPORT_PATH;
const replayReportPath = opts.replay ?? opts._[1] ?? process.env.OMA_REPLAY_REPORT_PATH;

main().catch((err) => {
  console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

async function main() {
  if (!promotionReportPath || !replayReportPath) {
    throw new Error(
      "usage: pnpm smoke:verify-evidence -- --promotion ./promotion-report.json --replay ./replay-report.json",
    );
  }

  await runVerifier(promotionVerifier, promotionReportPath);
  await runVerifier(replayVerifier, replayReportPath);

  const promotion = JSON.parse(await readFile(promotionReportPath, "utf8"));
  const replay = JSON.parse(await readFile(replayReportPath, "utf8"));
  const failures = [];

  if (normalizeUrl(promotion.target) !== normalizeUrl(replay.target)) {
    failures.push(`target mismatch: promotion=${promotion.target} replay=${replay.target}`);
  }
  if (promotion.mode !== "promotion") failures.push("promotion report mode must be promotion");
  if (replay.phase !== "verify") failures.push("replay report phase must be verify");

  if (failures.length > 0) {
    for (const failure of failures) console.error(`fail ${failure}`);
    throw new Error(`promotion evidence verification failed with ${failures.length} issue(s)`);
  }

  console.log(`PASS Cloudflare promotion evidence for ${promotion.target}`);
}

function runVerifier(script, reportPath) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, reportPath], (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) {
        reject(new Error(`${script} failed for ${reportPath}`));
        return;
      }
      resolve();
    });
  });
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

function normalizeUrl(value) {
  return String(value ?? "").replace(/\/+$/, "");
}
