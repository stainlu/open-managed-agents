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
const devVarsPath = opts["dev-vars-path"] ?? process.env.OMA_PREFLIGHT_DEV_VARS_PATH ?? join(exampleRoot, ".dev.vars");
const skipDocker = boolOpt(opts["skip-docker"] ?? process.env.OMA_PREFLIGHT_SKIP_DOCKER);
const skipSecrets = boolOpt(opts["skip-secrets"] ?? process.env.OMA_PREFLIGHT_SKIP_SECRETS);
const requireSecrets = boolOpt(opts["require-secrets"] ?? process.env.OMA_PREFLIGHT_REQUIRE_SECRETS);
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
  if (skipSecrets) {
    console.log("skip secret check because --skip-secrets or OMA_PREFLIGHT_SKIP_SECRETS is set");
  } else {
    await checkSecrets(failures);
  }

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

async function checkSecrets(failures) {
  const fileEnv = await readDevVars(devVarsPath, failures);
  const env = { ...fileEnv, ...process.env };
  const hasSecretInput = Object.keys(fileEnv).length > 0
    || env.OMA_WORKFLOW_INTERNAL_TOKEN !== undefined
    || env.OMA_PARENT_TOKEN_SECRET_BASE64 !== undefined
    || env.OMA_API_TOKEN !== undefined
    || env.OMA_PASSTHROUGH_ENV_JSON !== undefined
    || env.OMA_FLUE_PROVIDER_CONFIG_JSON !== undefined;

  if (!hasSecretInput && !requireSecrets) {
    console.log("skip secret check because no .dev.vars or secret env vars were found");
    return;
  }

  checkRequiredSecret(env, "OMA_WORKFLOW_INTERNAL_TOKEN", failures);
  checkParentTokenSecret(env.OMA_PARENT_TOKEN_SECRET_BASE64, failures);
  checkOptionalSecret(env, "OMA_API_TOKEN", failures);
  checkOptionalJsonObject(env, "OMA_PASSTHROUGH_ENV_JSON", "string", failures);
  checkOptionalJsonObject(env, "OMA_FLUE_PROVIDER_CONFIG_JSON", "object", failures);

  if (failures.length === 0) {
    console.log("ok Cloudflare local secrets are configured");
  }
}

async function readDevVars(path, failures) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") return {};
    failures.push(`.dev.vars is unreadable at ${path}`);
    return {};
  }

  const parsed = {};
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      failures.push(`.dev.vars:${index + 1} must use KEY=value syntax`);
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = stripOptionalQuotes(line.slice(eq + 1).trim());
    parsed[key] = value;
  }
  console.log(`ok loaded local secrets from ${path}`);
  return parsed;
}

function checkRequiredSecret(env, key, failures) {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    failures.push(`${key} is required`);
    return;
  }
  if (looksLikePlaceholder(value)) {
    failures.push(`${key} still looks like a placeholder`);
  }
}

function checkOptionalSecret(env, key, failures) {
  const value = env[key];
  if (value === undefined || value === "") return;
  if (typeof value !== "string") {
    failures.push(`${key} must be a string`);
    return;
  }
  if (looksLikePlaceholder(value)) {
    failures.push(`${key} still looks like a placeholder`);
  }
}

function checkParentTokenSecret(value, failures) {
  if (typeof value !== "string" || value.length === 0) {
    failures.push("OMA_PARENT_TOKEN_SECRET_BASE64 is required");
    return;
  }
  if (looksLikePlaceholder(value)) {
    failures.push("OMA_PARENT_TOKEN_SECRET_BASE64 still looks like a placeholder");
    return;
  }
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    failures.push("OMA_PARENT_TOKEN_SECRET_BASE64 must be standard padded base64");
    return;
  }
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.toString("base64") !== trimmed) {
    failures.push("OMA_PARENT_TOKEN_SECRET_BASE64 must be canonical base64");
    return;
  }
  if (decoded.byteLength !== 32) {
    failures.push(`OMA_PARENT_TOKEN_SECRET_BASE64 must decode to exactly 32 bytes, got ${decoded.byteLength}`);
  }
}

function checkOptionalJsonObject(env, key, valueKind, failures) {
  const raw = env[key];
  if (raw === undefined || raw === "") return;
  if (typeof raw !== "string") {
    failures.push(`${key} must be a JSON object string`);
    return;
  }
  if (looksLikePlaceholder(raw)) {
    failures.push(`${key} still looks like a placeholder`);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    failures.push(`${key} must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    failures.push(`${key} must be a JSON object`);
    return;
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (valueKind === "string" && typeof value !== "string") {
      failures.push(`${key}.${name} must be a string`);
    }
    if (valueKind === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) {
      failures.push(`${key}.${name} must be an object`);
    }
  }
}

function stripOptionalQuotes(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function looksLikePlaceholder(value) {
  return /replace[-_ ]?with|placeholder/i.test(value);
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
