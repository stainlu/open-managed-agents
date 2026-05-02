import { describe, expect, it } from "vitest";
import { DockerContainerRuntime } from "./docker.js";
import {
  buildContainerRuntime,
  containerRuntimeBackendFromEnv,
  normalizeContainerRuntimeBackend,
} from "./factory.js";

describe("container runtime factory", () => {
  it("defaults to Docker", () => {
    const result = buildContainerRuntime();
    expect(result.backend).toBe("docker");
    expect(result.runtime).toBeInstanceOf(DockerContainerRuntime);
  });

  it("accepts the canonical Docker backend spelling", () => {
    expect(normalizeContainerRuntimeBackend("docker")).toBe("docker");
    expect(normalizeContainerRuntimeBackend(" Docker ")).toBe("docker");
    expect(normalizeContainerRuntimeBackend("")).toBe("docker");
  });

  it("rejects unimplemented backend names loudly", () => {
    expect(() => normalizeContainerRuntimeBackend("cloud-run")).toThrow(
      /expected "docker"/,
    );
  });

  it("reads OMA_CONTAINER_RUNTIME before the legacy env name", () => {
    expect(
      containerRuntimeBackendFromEnv({
        OMA_CONTAINER_RUNTIME: "docker",
        OPENCLAW_CONTAINER_RUNTIME: "cloud-run",
      }),
    ).toBe("docker");
  });

  it("falls back to OPENCLAW_CONTAINER_RUNTIME for compatibility", () => {
    expect(
      containerRuntimeBackendFromEnv({
        OPENCLAW_CONTAINER_RUNTIME: "docker",
      }),
    ).toBe("docker");
  });
});
