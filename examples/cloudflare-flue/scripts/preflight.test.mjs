import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./preflight.mjs", import.meta.url));

describe("cloudflare-flue preflight", () => {
  it("passes local rehearsal when placeholder D1 and Docker are explicitly skipped", async () => {
    const result = await execFileAsync(process.execPath, [
      scriptPath,
      "--allow-placeholder-d1",
      "--skip-docker",
    ]);

    expect(result.stdout).toContain("PASS Cloudflare example preflight");
  });

  it("rejects the placeholder D1 id by default", async () => {
    await expect(execFileAsync(process.execPath, [scriptPath, "--skip-docker"]))
      .rejects.toMatchObject({
        stderr: expect.stringContaining("wrangler.toml still contains REPLACE_WITH_D1_DATABASE_ID"),
      });
  });
});
