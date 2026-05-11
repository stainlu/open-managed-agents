import { describe, expect, it } from "vitest";

import {
  createCloudflareFlueWorkerRouter,
  fetchCloudflareFlueCoordinator,
  type DurableObjectIdLike,
  type DurableObjectNamespaceLike,
  type DurableObjectStubLike,
} from "./worker.js";

describe("createCloudflareFlueWorkerRouter", () => {
  it("routes requests to the configured coordinator Durable Object", async () => {
    const namespace = new FakeNamespace();
    const router = createCloudflareFlueWorkerRouter();

    const response = await router.fetch(
      new Request("https://oma.example/v1/agents"),
      {
        OMA_COORDINATOR: namespace,
        OMA_COORDINATOR_NAME: "tenant-a",
      },
    );

    await expect(response.json()).resolves.toEqual({
      name: "tenant-a",
      url: "https://oma.example/v1/agents",
    });
    expect(namespace.names).toEqual(["tenant-a"]);
  });

  it("can pin the coordinator name from router options", async () => {
    const namespace = new FakeNamespace();
    const router = createCloudflareFlueWorkerRouter({
      namespace,
      coordinatorName: "pinned",
    });

    const response = await router.fetch(
      new Request("https://oma.example/healthz"),
      {
        OMA_COORDINATOR: new FakeNamespace(),
        OMA_COORDINATOR_NAME: "ignored",
      },
    );

    await expect(response.json()).resolves.toMatchObject({ name: "pinned" });
    expect(namespace.names).toEqual(["pinned"]);
  });

  it("fails loudly without a coordinator namespace", () => {
    const router = createCloudflareFlueWorkerRouter();

    expect(() => router.fetch(
      new Request("https://oma.example/healthz"),
      {} as Parameters<typeof router.fetch>[1],
    )).toThrow(/OMA_COORDINATOR/);
  });
});

describe("fetchCloudflareFlueCoordinator", () => {
  it("uses the default coordinator name when none is provided", async () => {
    const namespace = new FakeNamespace();

    const response = await fetchCloudflareFlueCoordinator(
      new Request("https://oma.example/healthz"),
      namespace,
    );

    await expect(response.json()).resolves.toMatchObject({ name: "default" });
  });

  it("rejects empty coordinator names", () => {
    expect(() => fetchCloudflareFlueCoordinator(
      new Request("https://oma.example/healthz"),
      new FakeNamespace(),
      "",
    )).toThrow(/non-empty/);
  });
});

class FakeNamespace implements DurableObjectNamespaceLike {
  readonly names: string[] = [];

  idFromName(name: string): DurableObjectIdLike {
    this.names.push(name);
    return name;
  }

  get(id: DurableObjectIdLike): DurableObjectStubLike {
    return new FakeStub(String(id));
  }
}

class FakeStub implements DurableObjectStubLike {
  constructor(private readonly name: string) {}

  fetch(request: Request): Response {
    return Response.json({
      name: this.name,
      url: request.url,
    });
  }
}
