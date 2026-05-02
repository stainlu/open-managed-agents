import { DockerContainerRuntime } from "./docker.js";

export type ContainerRuntimeBackend = "docker";

export type ContainerRuntimeFactoryOptions = {
  backend?: string;
  docker?: {
    socketPath?: string;
    network?: string;
    spawnTimeoutMs?: number;
  };
};

export type ContainerRuntimeFactoryResult = {
  backend: ContainerRuntimeBackend;
  runtime: DockerContainerRuntime;
};

export function containerRuntimeBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ContainerRuntimeBackend {
  const explicit = env.OMA_CONTAINER_RUNTIME?.trim();
  if (explicit) return normalizeContainerRuntimeBackend(explicit);

  const legacy = env.OPENCLAW_CONTAINER_RUNTIME?.trim();
  if (legacy) return normalizeContainerRuntimeBackend(legacy);

  return "docker";
}

export function buildContainerRuntime(
  opts: ContainerRuntimeFactoryOptions = {},
): ContainerRuntimeFactoryResult {
  const backend = normalizeContainerRuntimeBackend(opts.backend);

  switch (backend) {
    case "docker":
      return {
        backend,
        runtime: new DockerContainerRuntime(opts.docker),
      };
  }
}

export function normalizeContainerRuntimeBackend(
  raw: string | undefined,
): ContainerRuntimeBackend {
  const value = (raw ?? "docker").trim().toLowerCase();
  if (value === "" || value === "docker") return "docker";
  throw new Error(
    `invalid container runtime backend ${JSON.stringify(raw)}, expected "docker"`,
  );
}
