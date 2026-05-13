import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./configure-bindings.mjs", import.meta.url));
const cleanEnv = { PATH: process.env.PATH ?? "" };

describe("cloudflare-flue configure-bindings", () => {
  it("writes CI-provided Cloudflare resource bindings into wrangler.toml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oma-cf-bindings-"));
    try {
      const wranglerPath = join(dir, "wrangler.toml");
      await writeFile(wranglerPath, sampleWranglerToml());

      const result = await execFileAsync(process.execPath, [
        scriptPath,
        "--wrangler-toml",
        wranglerPath,
        "--d1-database-id",
        "live-d1-id",
        "--d1-database-name",
        "live-db",
        "--r2-bucket-name",
        "live-workspace",
        "--r2-preview-bucket-name",
        "live-workspace-preview",
      ], { env: cleanEnv });

      expect(result.stdout).toContain("updated Cloudflare bindings");
      const updated = await readFile(wranglerPath, "utf8");
      expect(updated).toContain('database_name = "live-db"');
      expect(updated).toContain('database_id = "live-d1-id"');
      expect(updated).toContain('bucket_name = "live-workspace"');
      expect(updated).toContain('preview_bucket_name = "live-workspace-preview"');
      expect(updated).not.toContain("REPLACE_WITH_D1_DATABASE_ID");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("requires a real D1 database id before mutating the deploy scaffold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oma-cf-bindings-"));
    try {
      const wranglerPath = join(dir, "wrangler.toml");
      await writeFile(wranglerPath, sampleWranglerToml());

      await expect(execFileAsync(process.execPath, [
        scriptPath,
        "--wrangler-toml",
        wranglerPath,
      ], { env: cleanEnv })).rejects.toMatchObject({
        stderr: expect.stringContaining("OMA_CLOUDFLARE_FLUE_D1_DATABASE_ID is required"),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function sampleWranglerToml() {
  return `name = "oma-cloudflare-flue"

[[d1_databases]]
binding = "OMA_DB"
database_name = "oma-cloudflare-flue"
database_id = "REPLACE_WITH_D1_DATABASE_ID"

[[r2_buckets]]
binding = "OMA_WORKSPACE"
bucket_name = "oma-cloudflare-flue-workspace"
preview_bucket_name = "oma-cloudflare-flue-workspace-preview"
`;
}
