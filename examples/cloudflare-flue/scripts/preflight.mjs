#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const opts = parseArgs(process.argv.slice(2));
const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = join(here, "..");
const wranglerTomlPath = join(exampleRoot, "wrangler.toml");
const dockerfilePath = join(exampleRoot, "Dockerfile");
const skipDocker = boolOpt(opts["skip-docker"] ?? process.env.OMA_PREFLIGHT_SKIP_DOCKER);
const allowPlaceholderD1 = boolOpt(
  opts["allow-placeholder-d1"] ?? process.env.OMA_PREFLIGHT_ALLOW_PLACEHOLDER_D1,
);
const dockerTimeoutMs = positiveInt(
  opts["docker-timeout-ms"] ?? process.env.OMA_PREFLIGHT_DOCKER_TIMEOUT_MS,
  8_000,
);

main().catch((err) => {
  console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

async function main() {
  const failures = [];

  checkNodeVersion(failures);
  await checkFile(dockerfilePath, "Dockerfile", failures);
  await checkWranglerToml(failures);

  if (skipDocker) {
    console.log("skip Docker check because --skip-docker or OMA_PREFLIGHT_SKIP_DOCKER is set");
  } else {
    await checkDocker(failures);
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`fail ${failure}`);
    throw new Error(`Cloudflare preflight failed with ${failures.length} issue(s)`);
  }

  console.log("PASS Cloudflare example preflight");
}

function checkNodeVersion(failures) {
  const version = process.versions.node;
  const [major, minor] = version.split(".").map((part) => Number(part));
  if (major < 22 || (major === 22 && minor < 18)) {
    failures.push(`Node ${version} is too old; use Node 22.18+`);
    return;
  }
  console.log(`ok Node ${version}`);
}

async function checkFile(path, label, failures) {
  try {
    await access(path, constants.R_OK);
    console.log(`ok ${label} is readable`);
  } catch {
    failures.push(`${label} is missing or unreadable at ${path}`);
  }
}

async function checkWranglerToml(failures) {
  let source;
  try {
    source = await readFile(wranglerTomlPath, "utf8");
  } catch {
    failures.push(`wrangler.toml is missing or unreadable at ${wranglerTomlPath}`);
    return;
  }

  if (source.includes("REPLACE_WITH_D1_DATABASE_ID") && !allowPlaceholderD1) {
    failures.push("wrangler.toml still contains REPLACE_WITH_D1_DATABASE_ID");
  } else if (source.includes("REPLACE_WITH_D1_DATABASE_ID")) {
    console.log("ok wrangler.toml placeholder D1 id allowed for local rehearsal");
  } else {
    console.log("ok wrangler.toml D1 database_id is configured");
  }

  for (const required of [
    "[ai]",
    "[[containers]]",
    "[[durable_objects.bindings]]",
    "[[workflows]]",
    "[[d1_databases]]",
    "[[r2_buckets]]",
  ]) {
    if (!source.includes(required)) failures.push(`wrangler.toml is missing ${required}`);
  }
}

async function checkDocker(failures) {
  const dockerBin = process.env.WRANGLER_DOCKER_BIN || "docker";
  const result = await runWithTimeout(dockerBin, ["info"], dockerTimeoutMs);
  if (result.ok) {
    console.log(`ok Docker CLI responded via ${dockerBin}`);
    return;
  }
  failures.push(result.message);
}

function runWithTimeout(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({
        ok: false,
        message: `${command} ${args.join(" ")} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, message: `${command} could not be launched: ${err.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      const output = `${stderr}\n${stdout}`.trim();
      resolve({
        ok: false,
        message: `${command} ${args.join(" ")} exited ${code}${output ? `: ${firstLine(output)}` : ""}`,
      });
    });
  });
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

function firstLine(value) {
  return value.split(/\r?\n/, 1)[0];
}
