import type {
  ManagedWorkspace,
  WorkspaceEntry,
  WorkspaceWriteResult,
} from "./types.js";
import { WorkspaceError } from "./types.js";

export type R2ObjectLike = {
  key: string;
  size?: number;
  uploaded?: Date | number | string;
};

export type R2ObjectBodyLike = R2ObjectLike & {
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type R2ListOptionsLike = {
  prefix?: string;
  cursor?: string;
  limit?: number;
};

export type R2ListResultLike = {
  objects: R2ObjectLike[];
  truncated?: boolean;
  cursor?: string;
};

export type R2BucketLike = {
  get(
    key: string,
    opts?: { range?: { offset: number; length: number } },
  ): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: Uint8Array | ArrayBuffer | string): Promise<unknown>;
  delete(key: string | string[]): Promise<unknown>;
  list(opts?: R2ListOptionsLike): Promise<R2ListResultLike>;
};

export type R2ManagedWorkspaceOptions = {
  keyPrefix?: string;
  listLimit?: number;
};

type ChildAccumulator = {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  mtime: number;
};

export class R2ManagedWorkspace implements ManagedWorkspace {
  private readonly keyPrefix: string;
  private readonly listLimit: number | undefined;

  constructor(
    private readonly bucket: R2BucketLike,
    opts: R2ManagedWorkspaceOptions = {},
  ) {
    this.keyPrefix = normalizeKeyPrefix(opts.keyPrefix ?? "oma-workspaces");
    this.listLimit = opts.listLimit;
  }

  async listFiles(
    agentId: string,
    sessionId: string,
    relPath = "",
  ): Promise<WorkspaceEntry[]> {
    const { relNormalized } = resolveWorkspacePath(relPath, { allowRoot: true });
    const prefix = this.objectPrefix(agentId, sessionId, relNormalized);
    const objects = await this.listAll(prefix);
    if (objects.length === 0 && relNormalized) {
      throw new WorkspaceError("file_not_found", `workspace path not found: ${relNormalized}`);
    }

    const entries = new Map<string, ChildAccumulator>();
    for (const object of objects) {
      const rest = object.key.slice(prefix.length);
      if (!rest) continue;
      const [name, ...nested] = rest.split("/");
      if (!name) continue;
      const path = relNormalized ? `${relNormalized}/${name}` : name;
      const mtime = uploadedMs(object.uploaded);
      const existing = entries.get(name);
      if (nested.length > 0) {
        entries.set(name, {
          name,
          path,
          type: "dir",
          size: 0,
          mtime: Math.max(existing?.mtime ?? 0, mtime),
        });
        continue;
      }
      if (existing?.type === "dir") {
        existing.mtime = Math.max(existing.mtime, mtime);
        continue;
      }
      entries.set(name, {
        name,
        path,
        type: "file",
        size: object.size ?? 0,
        mtime,
      });
    }

    return [...entries.values()].sort((a, b) => (
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
    ));
  }

  async readFile(
    agentId: string,
    sessionId: string,
    relPath: string,
    opts: { maxBytes?: number } = {},
  ): Promise<Buffer> {
    const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    const { relNormalized } = resolveWorkspacePath(relPath, { allowRoot: false });
    const object = await this.bucket.get(
      this.objectKey(agentId, sessionId, relNormalized),
      { range: { offset: 0, length: maxBytes } },
    );
    if (!object) {
      throw new WorkspaceError("file_not_found", `file not found: ${relNormalized}`);
    }
    const buf = Buffer.from(await object.arrayBuffer());
    return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  }

  async writeFile(
    agentId: string,
    sessionId: string,
    relPath: string,
    content: Buffer,
  ): Promise<WorkspaceWriteResult> {
    const { relNormalized } = resolveWorkspacePath(relPath, { allowRoot: false });
    await this.bucket.put(
      this.objectKey(agentId, sessionId, relNormalized),
      new Uint8Array(content.buffer, content.byteOffset, content.byteLength),
    );
    return { size: content.byteLength, path: relNormalized };
  }

  async deleteFile(agentId: string, sessionId: string, relPath: string): Promise<void> {
    const { relNormalized } = resolveWorkspacePath(relPath, { allowRoot: false });
    const key = this.objectKey(agentId, sessionId, relNormalized);
    const object = await this.bucket.get(key);
    if (!object) {
      const children = await this.listAll(`${key}/`, 1);
      if (children.length > 0) {
        throw new WorkspaceError("invalid_path", `not a file: ${relNormalized}`);
      }
      throw new WorkspaceError("file_not_found", `file not found: ${relNormalized}`);
    }
    await this.bucket.delete(key);
  }

  private objectKey(agentId: string, sessionId: string, relNormalized: string): string {
    return `${this.workspaceRoot(agentId, sessionId)}${relNormalized}`;
  }

  private objectPrefix(agentId: string, sessionId: string, relNormalized: string): string {
    const root = this.workspaceRoot(agentId, sessionId);
    return relNormalized ? `${root}${relNormalized}/` : root;
  }

  private workspaceRoot(agentId: string, sessionId: string): string {
    return `${this.keyPrefix}${safeKeySegment(agentId, "agentId")}/sessions/${safeKeySegment(sessionId, "sessionId")}/workspace/`;
  }

  private async listAll(prefix: string, maxObjects = Number.POSITIVE_INFINITY): Promise<R2ObjectLike[]> {
    const objects: R2ObjectLike[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({
        prefix,
        cursor,
        limit: this.listLimit,
      });
      for (const object of page.objects) {
        objects.push(object);
        if (objects.length >= maxObjects) return objects;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return objects;
  }
}

function normalizeKeyPrefix(prefix: string): string {
  if (prefix.includes("\0")) {
    throw new WorkspaceError("invalid_path", "invalid workspace key prefix");
  }
  const cleaned = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  return cleaned ? `${cleaned}/` : "";
}

function resolveWorkspacePath(
  relPath: string,
  opts: { allowRoot: boolean },
): { relNormalized: string } {
  const cleaned = (relPath || "")
    .replace(/^\/+/, "")
    .split(/[\\/]+/)
    .filter((seg) => seg !== "" && seg !== ".");
  for (const seg of cleaned) {
    if (seg === "..") {
      throw new WorkspaceError("invalid_path", "path traversal not allowed");
    }
    if (seg.includes("\0")) {
      throw new WorkspaceError("invalid_path", "invalid character in path");
    }
  }
  const relNormalized = cleaned.join("/");
  if (!opts.allowRoot && !relNormalized) {
    throw new WorkspaceError("invalid_path", "refusing to target workspace root");
  }
  return { relNormalized };
}

function safeKeySegment(value: string, label: string): string {
  if (value.length === 0 || value.includes("/") || value.includes("\\")) {
    throw new WorkspaceError("invalid_path", `invalid ${label}`);
  }
  if (value.includes("\0")) {
    throw new WorkspaceError("invalid_path", `invalid ${label}`);
  }
  return value;
}

function uploadedMs(value: Date | number | string | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
