import type { Container } from "./container.js";

export type ContainerControlClient = {
  close(): Promise<void>;
};

export type ContainerControlPlane = {
  connect(container: Container): Promise<ContainerControlClient>;
  ensureConnected?(
    container: Container,
    client: ContainerControlClient,
  ): Promise<ContainerControlClient>;
  close(client: ContainerControlClient): Promise<void>;
};

