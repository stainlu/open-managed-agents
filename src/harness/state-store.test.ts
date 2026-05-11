import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalHarnessStateStore } from "./state-store.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oma-harness-state-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("LocalHarnessStateStore", () => {
  it("persists opaque harness state keys under the managed session root", async () => {
    const root = await tempRoot();
    const store = new LocalHarnessStateStore(root);

    await store.save({
      harnessId: "flue",
      agentId: "agt_1",
      sessionId: "ses_1",
      key: "agent:agt_1:session/task:ses_1:abc",
      value: { version: 2, entries: [{ id: "entry_1" }] },
    });

    await expect(store.load({
      harnessId: "flue",
      agentId: "agt_1",
      sessionId: "ses_1",
      key: "agent:agt_1:session/task:ses_1:abc",
    })).resolves.toEqual({ version: 2, entries: [{ id: "entry_1" }] });

    const raw = await readFile(
      join(root, "agt_1", "sessions", "ses_1", "harness-state", "flue", "YWdlbnQ6YWd0XzE6c2Vzc2lvbi90YXNrOnNlc18xOmFiYw.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual({ version: 2, entries: [{ id: "entry_1" }] });
  });

  it("deletes one key and whole-session state idempotently", async () => {
    const root = await tempRoot();
    const store = new LocalHarnessStateStore(root);
    const base = {
      harnessId: "flue",
      agentId: "agt_1",
      sessionId: "ses_1",
    };

    await store.save({ ...base, key: "a", value: { a: 1 } });
    await store.save({ ...base, key: "b", value: { b: 1 } });

    await store.delete({ ...base, key: "a" });
    await expect(store.load({ ...base, key: "a" })).resolves.toBeNull();
    await expect(store.load({ ...base, key: "b" })).resolves.toEqual({ b: 1 });

    await store.deleteBySession("agt_1", "ses_1");
    await expect(store.load({ ...base, key: "b" })).resolves.toBeNull();
    await store.deleteBySession("agt_1", "ses_1");
  });

  it("rejects path-shaped managed identifiers", async () => {
    const store = new LocalHarnessStateStore(await tempRoot());

    await expect(store.save({
      harnessId: "flue",
      agentId: "../agt",
      sessionId: "ses_1",
      key: "safe",
      value: {},
    })).rejects.toThrow("invalid agentId");
  });
});
