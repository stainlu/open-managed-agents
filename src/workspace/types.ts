export type WorkspaceEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  mtime: number;
};

export type WorkspaceWriteResult = {
  size: number;
  path: string;
};

export type WorkspaceErrorCode = "file_not_found" | "invalid_path";

export class WorkspaceError extends Error {
  constructor(
    public readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export interface ManagedWorkspace {
  listFiles(
    agentId: string,
    sessionId: string,
    relPath?: string,
  ): Promise<WorkspaceEntry[]>;
  readFile(
    agentId: string,
    sessionId: string,
    relPath: string,
    opts?: { maxBytes?: number },
  ): Promise<Buffer>;
  writeFile(
    agentId: string,
    sessionId: string,
    relPath: string,
    content: Buffer,
  ): Promise<WorkspaceWriteResult>;
  deleteFile(agentId: string, sessionId: string, relPath: string): Promise<void>;
}
