import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./preflight.mjs", import.meta.url));
const cleanEnv = { PATH: process.env.PATH ?? "" };

describe("cloudflare-flue preflight", () => {
  it("passes local rehearsal when placeholder D1 and Docker are explicitly skipped", async () => {
    const result = await runPreflight([
      scriptPath,
      "--allow-placeholder-d1",
      "--skip-docker",
    ]);

    expect(result.stdout).toContain("PASS Cloudflare example preflight");
  });

  it("rejects the placeholder D1 id by default", async () => {
    await expect(runPreflight([scriptPath, "--skip-docker"]))
      .rejects.toMatchObject({
        stderr: expect.stringContaining("wrangler.toml still contains REPLACE_WITH_D1_DATABASE_ID"),
      });
  });

  it("rejects placeholder local secrets when a dev vars file is supplied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oma-cf-preflight-"));
    try {
      const devVarsPath = join(dir, ".dev.vars");
      await writeFile(devVarsPath, [
        "OMA_WORKFLOW_INTERNAL_TOKEN=replace-with-a-random-shared-token",
        "OMA_PARENT_TOKEN_SECRET_BASE64=replace-with-the-generated-32-byte-base64-secret",
      ].join("\n"));

      await expect(runPreflight([
        scriptPath,
        "--allow-placeholder-d1",
        "--skip-docker",
        "--dev-vars-path",
        devVarsPath,
      ])).rejects.toMatchObject({
        stderr: expect.stringContaining("OMA_PARENT_TOKEN_SECRET_BASE64 still looks like a placeholder"),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes required secret preflight from supplied dev vars", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oma-cf-preflight-"));
    try {
      const devVarsPath = join(dir, ".dev.vars");
      await writeFile(devVarsPath, [
        "OMA_WORKFLOW_INTERNAL_TOKEN=workflow-secret",
        `OMA_PARENT_TOKEN_SECRET_BASE64=${Buffer.alloc(32, 7).toString("base64")}`,
        "OMA_API_TOKEN=api-secret",
        "OMA_PASSTHROUGH_ENV_JSON={\"ANTHROPIC_API_KEY\":\"sk-test\"}",
        "OMA_FLUE_PROVIDER_CONFIG_JSON={\"openai\":{\"baseUrl\":\"https://gateway.example/openai\"}}",
      ].join("\n"));

      const result = await runPreflight([
        scriptPath,
        "--allow-placeholder-d1",
        "--skip-docker",
        "--require-secrets",
        "--dev-vars-path",
        devVarsPath,
      ]);

      expect(result.stdout).toContain("ok Cloudflare local secrets are configured");
      expect(result.stdout).toContain("PASS Cloudflare example preflight");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("requires secrets when requested", async () => {
    const missingPath = join(tmpdir(), `oma-missing-${Date.now()}`, ".dev.vars");

    await expect(runPreflight([
      scriptPath,
      "--allow-placeholder-d1",
      "--skip-docker",
      "--require-secrets",
      "--dev-vars-path",
      missingPath,
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("OMA_WORKFLOW_INTERNAL_TOKEN is required"),
    });
  });

  it("requires the public OMA API token during required secret preflight", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oma-cf-preflight-"));
    try {
      const devVarsPath = join(dir, ".dev.vars");
      await writeFile(devVarsPath, [
        "OMA_WORKFLOW_INTERNAL_TOKEN=workflow-secret",
        `OMA_PARENT_TOKEN_SECRET_BASE64=${Buffer.alloc(32, 7).toString("base64")}`,
      ].join("\n"));

      await expect(runPreflight([
        scriptPath,
        "--allow-placeholder-d1",
        "--skip-docker",
        "--require-secrets",
        "--dev-vars-path",
        devVarsPath,
      ])).rejects.toMatchObject({
        stderr: expect.stringContaining("OMA_API_TOKEN is required"),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function runPreflight(args) {
  return execFileAsync(process.execPath, args, { env: cleanEnv });
}
