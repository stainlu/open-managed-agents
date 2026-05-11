import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { LocalManagedWorkspace } from "./local.js";
import { WorkspaceError } from "./types.js";

let root: string | undefined;

async function makeWorkspace(): Promise<LocalManagedWorkspace> {
  root = await mkdtemp(join(tmpdir(), "oma-workspace-"));
  return new LocalManagedWorkspace(root);
}

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

describe("LocalManagedWorkspace", () => {
  it("writes, lists, reads, truncates, and deletes session files", async () => {
    const workspace = await makeWorkspace();

    await workspace.writeFile("agt_1", "ses_1", "notes/a.txt", Buffer.from("abcdef"));
    await workspace.writeFile("agt_1", "ses_1", "z.txt", Buffer.from("z"));

    const rootEntries = await workspace.listFiles("agt_1", "ses_1");
    expect(rootEntries.map((entry) => [entry.type, entry.path])).toEqual([
      ["dir", "notes"],
      ["file", "z.txt"],
    ]);

    await expect(
      workspace.readFile("agt_1", "ses_1", "notes/a.txt", { maxBytes: 3 }),
    ).resolves.toEqual(Buffer.from("abc"));

    await workspace.deleteFile("agt_1", "ses_1", "notes/a.txt");
    await expect(workspace.readFile("agt_1", "ses_1", "notes/a.txt")).rejects.toMatchObject({
      code: "file_not_found",
    });
  });

  it("rejects path traversal and root writes", async () => {
    const workspace = await makeWorkspace();

    await expect(
      workspace.writeFile("agt_1", "ses_1", "../escape.txt", Buffer.from("no")),
    ).rejects.toBeInstanceOf(WorkspaceError);

    await expect(
      workspace.writeFile("agt_1", "ses_1", "", Buffer.from("no")),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });
});
