import { describe, expect, it } from "vitest";

import {
  R2ManagedWorkspace,
  type R2BucketLike,
  type R2ListOptionsLike,
  type R2ListResultLike,
  type R2ObjectBodyLike,
} from "./r2.js";
import { WorkspaceError } from "./types.js";

describe("R2ManagedWorkspace", () => {
  it("writes, lists, reads, truncates, and deletes session files", async () => {
    const bucket = new FakeR2Bucket();
    const workspace = new R2ManagedWorkspace(bucket);

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

  it("synthesizes nested directory entries from object prefixes", async () => {
    const workspace = new R2ManagedWorkspace(new FakeR2Bucket());

    await workspace.writeFile("agt_1", "ses_1", "notes/a.txt", Buffer.from("a"));
    await workspace.writeFile("agt_1", "ses_1", "notes/deep/b.txt", Buffer.from("b"));
    await workspace.writeFile("agt_1", "ses_1", "notes/c.txt", Buffer.from("c"));

    const entries = await workspace.listFiles("agt_1", "ses_1", "notes");
    expect(entries.map((entry) => [entry.type, entry.path])).toEqual([
      ["dir", "notes/deep"],
      ["file", "notes/a.txt"],
      ["file", "notes/c.txt"],
    ]);
  });

  it("keeps agent sessions isolated under the configured prefix", async () => {
    const bucket = new FakeR2Bucket();
    const workspace = new R2ManagedWorkspace(bucket, { keyPrefix: "/tenant-a/" });

    await workspace.writeFile("agt_1", "ses_1", "same.txt", Buffer.from("one"));
    await workspace.writeFile("agt_1", "ses_2", "same.txt", Buffer.from("two"));
    await workspace.writeFile("agt_2", "ses_1", "same.txt", Buffer.from("three"));

    await expect(workspace.readFile("agt_1", "ses_1", "same.txt")).resolves.toEqual(
      Buffer.from("one"),
    );
    expect([...bucket.keys()].sort()).toEqual([
      "tenant-a/agt_1/sessions/ses_1/workspace/same.txt",
      "tenant-a/agt_1/sessions/ses_2/workspace/same.txt",
      "tenant-a/agt_2/sessions/ses_1/workspace/same.txt",
    ]);
  });

  it("rejects path traversal, root writes, and directory deletes", async () => {
    const workspace = new R2ManagedWorkspace(new FakeR2Bucket());

    await expect(
      workspace.writeFile("agt_1", "ses_1", "../escape.txt", Buffer.from("no")),
    ).rejects.toBeInstanceOf(WorkspaceError);

    await expect(
      workspace.writeFile("agt_1", "ses_1", "", Buffer.from("no")),
    ).rejects.toMatchObject({ code: "invalid_path" });

    await workspace.writeFile("agt_1", "ses_1", "dir/file.txt", Buffer.from("x"));
    await expect(workspace.deleteFile("agt_1", "ses_1", "dir")).rejects.toMatchObject({
      code: "invalid_path",
    });
  });

  it("returns an empty root listing for sessions without objects", async () => {
    const workspace = new R2ManagedWorkspace(new FakeR2Bucket());

    await expect(workspace.listFiles("agt_1", "ses_empty")).resolves.toEqual([]);
    await expect(workspace.listFiles("agt_1", "ses_empty", "missing")).rejects.toMatchObject({
      code: "file_not_found",
    });
  });
});

type StoredObject = {
  body: Buffer;
  uploaded: Date;
};

class FakeR2Bucket implements R2BucketLike {
  private readonly objects = new Map<string, StoredObject>();

  async get(
    key: string,
    opts?: { range?: { offset: number; length: number } },
  ): Promise<R2ObjectBodyLike | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    const body = opts?.range
      ? object.body.subarray(opts.range.offset, opts.range.offset + opts.range.length)
      : object.body;
    return {
      key,
      size: object.body.byteLength,
      uploaded: object.uploaded,
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  }

  async put(key: string, value: Uint8Array | ArrayBuffer | string): Promise<unknown> {
    this.objects.set(key, {
      body: Buffer.from(value as Uint8Array),
      uploaded: new Date(Date.now() + this.objects.size),
    });
  }

  async delete(key: string | string[]): Promise<unknown> {
    for (const item of Array.isArray(key) ? key : [key]) {
      this.objects.delete(item);
    }
  }

  async list(opts: R2ListOptionsLike = {}): Promise<R2ListResultLike> {
    const prefix = opts.prefix ?? "";
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    const offset = opts.cursor ? Number(opts.cursor) : 0;
    const matching = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b));
    const page = matching.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      objects: page.map(([key, object]) => ({
        key,
        size: object.body.byteLength,
        uploaded: object.uploaded,
      })),
      truncated: nextOffset < matching.length,
      cursor: nextOffset < matching.length ? String(nextOffset) : undefined,
    };
  }

  keys(): Iterable<string> {
    return this.objects.keys();
  }
}
