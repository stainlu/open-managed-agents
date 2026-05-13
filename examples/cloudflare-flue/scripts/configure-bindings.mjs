#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const opts = parseArgs(process.argv.slice(2));
const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = join(here, "..");
const wranglerTomlPath = opts["wrangler-toml"] ?? join(exampleRoot, "wrangler.toml");

const bindings = {
  d1DatabaseId: opts["d1-database-id"] ?? process.env.OMA_CLOUDFLARE_FLUE_D1_DATABASE_ID,
  d1DatabaseName: opts["d1-database-name"] ?? process.env.OMA_CLOUDFLARE_FLUE_D1_DATABASE_NAME,
  r2BucketName: opts["r2-bucket-name"] ?? process.env.OMA_CLOUDFLARE_FLUE_R2_BUCKET_NAME,
  r2PreviewBucketName: opts["r2-preview-bucket-name"] ??
    process.env.OMA_CLOUDFLARE_FLUE_R2_PREVIEW_BUCKET_NAME,
};

main().catch((err) => {
  console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

async function main() {
  let source = await readFile(wranglerTomlPath, "utf8");
  if (!bindings.d1DatabaseId) {
    throw new Error("OMA_CLOUDFLARE_FLUE_D1_DATABASE_ID is required");
  }
  source = replaceBindingValue(
    source,
    "d1_databases",
    "OMA_DB",
    "database_id",
    bindings.d1DatabaseId,
  );
  if (bindings.d1DatabaseName) {
    source = replaceBindingValue(
      source,
      "d1_databases",
      "OMA_DB",
      "database_name",
      bindings.d1DatabaseName,
    );
  }
  if (bindings.r2BucketName) {
    source = replaceBindingValue(
      source,
      "r2_buckets",
      "OMA_WORKSPACE",
      "bucket_name",
      bindings.r2BucketName,
    );
  }
  if (bindings.r2PreviewBucketName) {
    source = replaceBindingValue(
      source,
      "r2_buckets",
      "OMA_WORKSPACE",
      "preview_bucket_name",
      bindings.r2PreviewBucketName,
    );
  }

  await writeFile(wranglerTomlPath, source);
  console.log(`updated Cloudflare bindings in ${wranglerTomlPath}`);
}

function replaceBindingValue(source, tableName, bindingName, key, value) {
  const sectionPattern = new RegExp(
    `(\\[\\[${escapeRegExp(tableName)}\\]\\][\\s\\S]*?binding\\s*=\\s*"${escapeRegExp(bindingName)}"[\\s\\S]*?${escapeRegExp(key)}\\s*=\\s*")([^"]*)(")`,
  );
  const next = source.replace(sectionPattern, `$1${escapeTomlString(value)}$3`);
  if (next === source) {
    throw new Error(`wrangler.toml is missing ${tableName} binding ${bindingName} ${key}`);
  }
  return next;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeTomlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
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
