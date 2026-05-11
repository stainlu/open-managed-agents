import { describe, expect, it } from "vitest";

import { NativeOnlySessionRuntime, NativeRuntimeAcquireError } from "./native.js";

describe("NativeOnlySessionRuntime", () => {
  it("fails loudly when endpoint acquisition is requested", async () => {
    const runtime = new NativeOnlySessionRuntime();

    await expect(runtime.acquireForSession({
      sessionId: "ses_container",
      spawnOptions: {
        image: "should-not-run",
        env: {},
        mounts: [],
        containerPort: 18789,
      },
    })).rejects.toThrow(NativeRuntimeAcquireError);
  });

  it("treats warm, evict, logs, and control as no-op native surfaces", async () => {
    const runtime = new NativeOnlySessionRuntime();

    await expect(runtime.warmForAgent("agt_1", {
      image: "unused",
      env: {},
      mounts: [],
      containerPort: 18789,
    })).resolves.toBeUndefined();
    await expect(runtime.dropWarmForAgent("agt_1")).resolves.toBeUndefined();
    await expect(runtime.evictSession("ses_1")).resolves.toBeUndefined();
    await expect(runtime.readLogs("ses_1")).resolves.toBeUndefined();
    expect(runtime.getControlClient("ses_1")).toBeUndefined();
    expect(runtime.getActiveEntry("ses_1")).toBeUndefined();
  });
});
