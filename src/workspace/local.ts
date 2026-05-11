import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ManagedWorkspace, WorkspaceEntry, WorkspaceWriteResult } from "./types.js";
import { WorkspaceError } from "./types.js";

export class LocalManagedWorkspace implements ManagedWorkspace {
  constructor(private readonly stateRoot: string) {}

  async listFiles(
    agentId: string,
    sessionId: string,
    relPath = "",
  ): Promise<WorkspaceEntry[]> {
    const { fullPath, relNormalized } = this.resolvePath(agentId, sessionId, relPath);
    let entries: Dirent<string>[];
    try {
      entries = await readdir(fullPath, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new WorkspaceError("file_not_found", `workspace path not found: ${relNormalized}`);
      }
      throw err;
    }

    const result: WorkspaceEntry[] = [];
    for (const entry of entries) {
      try {
        const st = await stat(join(fullPath, entry.name));
        result.push({
          name: entry.name,
          path: relNormalized ? `${relNormalized}/${entry.name}` : entry.name,
          type: entry.isDirectory() ? "dir" : "file",
          size: st.size,
          mtime: st.mtimeMs,
        });
      } catch {
        /* broken symlink or permission issue - skip it */
      }
    }
    result.sort((a, b) => (
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
    ));
    return result;
  }

  async readFile(
    agentId: string,
    sessionId: string,
    relPath: string,
    opts: { maxBytes?: number } = {},
  ): Promise<Buffer> {
    const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    const { fullPath, relNormalized } = this.resolvePath(agentId, sessionId, relPath);
    try {
      const st = await stat(fullPath);
      if (!st.isFile()) {
        throw new WorkspaceError("file_not_found", `not a file: ${relNormalized}`);
      }
      const buf = await readFile(fullPath);
      if (buf.length > maxBytes) return buf.subarray(0, maxBytes);
      return buf;
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new WorkspaceError("file_not_found", `file not found: ${relNormalized}`);
      }
      throw err;
    }
  }

  async writeFile(
    agentId: string,
    sessionId: string,
    relPath: string,
    content: Buffer,
  ): Promise<WorkspaceWriteResult> {
    const { fullPath, relNormalized } = this.resolvePath(agentId, sessionId, relPath);
    if (!relNormalized) {
      throw new WorkspaceError("invalid_path", "refusing to write to workspace root");
    }
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
    return { size: content.length, path: relNormalized };
  }

  async deleteFile(agentId: string, sessionId: string, relPath: string): Promise<void> {
    const { fullPath, relNormalized } = this.resolvePath(agentId, sessionId, relPath);
    if (!relNormalized) {
      throw new WorkspaceError("invalid_path", "refusing to delete workspace root");
    }
    try {
      await unlink(fullPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new WorkspaceError("file_not_found", `file not found: ${relNormalized}`);
      }
      if (code === "EISDIR" || code === "EPERM") {
        throw new WorkspaceError("invalid_path", `not a file: ${relNormalized}`);
      }
      throw err;
    }
  }

  private resolvePath(
    agentId: string,
    sessionId: string,
    relPath: string,
  ): { fullPath: string; relNormalized: string } {
    // Normalize + enforce confinement in one place so every file API entry
    // point shares the same rules: strip leading slashes, collapse `.`,
    // reject anything whose resolved path escapes the session workspace.
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
    const sessionRoot = `${this.stateRoot}/${agentId}/sessions/${sessionId}`;
    const fullPath = relNormalized ? `${sessionRoot}/${relNormalized}` : sessionRoot;
    if (!fullPath.startsWith(sessionRoot)) {
      throw new WorkspaceError("invalid_path", "path escapes workspace");
    }
    return { fullPath, relNormalized };
  }
}
