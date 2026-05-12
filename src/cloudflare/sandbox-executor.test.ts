import { describe, expect, it, vi } from "vitest";

import {
  createCloudflareSandboxWorkspaceCommandExecutor,
  type CloudflareSandboxExecOptions,
  type CloudflareSandboxExecResult,
  type CloudflareSandboxLike,
} from "./sandbox-executor.js";
import {
  WorkspaceError,
  type ManagedWorkspace,
  type WorkspaceEntry,
  type WorkspaceWriteResult,
} from "../workspace/types.js";

describe("createCloudflareSandboxWorkspaceCommandExecutor", () => {
  it("mirrors OMA workspace into a Cloudflare Sandbox and syncs command changes back", async () => {
    const workspace = new InMemoryManagedWorkspace({
      "package.json": "{}",
      "src/index.ts": "console.log('hi');",
    });
    const sandbox = new FakeCloudflareSandbox(async (command, options) => {
      expect(command).toBe("npm test");
      expect(options).toMatchObject({
        cwd: "/workspace",
        env: { NODE_ENV: "test" },
        timeout: 7_000,
      });
      expect(sandbox.readBuffer("/workspace/package.json")).toEqual(Buffer.from("{}"));
      expect(sandbox.readBuffer("/workspace/src/index.ts"))
        .toEqual(Buffer.from("console.log('hi');"));
      sandbox.writeBuffer("/workspace/dist/result.txt", Buffer.from("built"));
      sandbox.writeBuffer("/workspace/node_modules/pkg/index.js", Buffer.from("ignored"));
      sandbox.deleteBuffer("/workspace/src/index.ts");
      return { stdout: "done", stderr: "", exitCode: 0 };
    });
    const binding = {};
    const getSandbox = vi.fn(() => sandbox);
    const executor = createCloudflareSandboxWorkspaceCommandExecutor({
      binding,
      getSandbox,
      sandboxIdPrefix: "oma-test",
    });

    const result = await executor.exec({
      workspace,
      agentId: "agt_1",
      sessionId: "ses_1",
      command: "npm test",
      cwd: "/workspace",
      workspaceRoot: "/workspace",
      relCwd: "",
      env: { NODE_ENV: "test" },
      timeoutSeconds: 7,
    });

    expect(result).toEqual({ stdout: "done", stderr: "", exitCode: 0 });
    expect(getSandbox).toHaveBeenCalledWith(
      binding,
      "oma-test-agt_1-ses_1",
      undefined,
    );
    await expect(workspace.readFile("agt_1", "ses_1", "package.json"))
      .resolves.toEqual(Buffer.from("{}"));
    await expect(workspace.readFile("agt_1", "ses_1", "dist/result.txt"))
      .resolves.toEqual(Buffer.from("built"));
    await expect(workspace.readFile("agt_1", "ses_1", "src/index.ts"))
      .rejects.toMatchObject({ code: "file_not_found" });
    await expect(workspace.readFile("agt_1", "ses_1", "node_modules/pkg/index.js"))
      .rejects.toMatchObject({ code: "file_not_found" });
  });

  it("translates Flue workspace cwd to a custom sandbox root", async () => {
    const workspace = new InMemoryManagedWorkspace({
      "subdir/input.txt": "input",
    });
    let commandCwd = "";
    const sandbox = new FakeCloudflareSandbox(async (_command, options) => {
      commandCwd = options?.cwd ?? "";
      sandbox.writeBuffer("/tmp/oma/subdir/output.txt", Buffer.from("output"));
      return { success: true, stdout: "ok" };
    });
    const executor = createCloudflareSandboxWorkspaceCommandExecutor({
      binding: {},
      getSandbox: () => sandbox,
      sandboxRoot: "/tmp/oma",
    });

    await executor.exec({
      workspace,
      agentId: "agt_1",
      sessionId: "ses_1",
      command: "pwd",
      cwd: "/flue/subdir",
      workspaceRoot: "/flue",
      relCwd: "subdir",
    });

    expect(commandCwd).toBe("/tmp/oma/subdir");
    await expect(workspace.readFile("agt_1", "ses_1", "subdir/output.txt"))
      .resolves.toEqual(Buffer.from("output"));
  });

  it("does not sync command-side files back after abort", async () => {
    const workspace = new InMemoryManagedWorkspace();
    const controller = new AbortController();
    const sandbox = new FakeCloudflareSandbox(async () => {
      sandbox.writeBuffer("/workspace/late.txt", Buffer.from("late"));
      controller.abort("stop");
      return { stdout: "late", exitCode: 0 };
    });
    const executor = createCloudflareSandboxWorkspaceCommandExecutor({
      binding: {},
      getSandbox: () => sandbox,
    });

    await expect(executor.exec({
      workspace,
      agentId: "agt_1",
      sessionId: "ses_1",
      command: "sleep 10",
      cwd: "/workspace",
      workspaceRoot: "/workspace",
      relCwd: "",
      signal: controller.signal,
    })).rejects.toMatchObject({
      name: "AbortError",
      cause: "stop",
    });
    await expect(workspace.readFile("agt_1", "ses_1", "late.txt"))
      .rejects.toMatchObject({ code: "file_not_found" });
  });
});

class FakeCloudflareSandbox implements CloudflareSandboxLike {
  private readonly files = new Map<string, Buffer>();

  constructor(
    private readonly runCommand: (
      command: string,
      options?: CloudflareSandboxExecOptions,
    ) => Promise<CloudflareSandboxExecResult>,
  ) {}

  async exec(
    command: string,
    options?: CloudflareSandboxExecOptions,
  ): Promise<CloudflareSandboxExecResult> {
    if (command.includes("find . -type f")) {
      const cwd = options?.cwd ?? "/workspace";
      const prefix = `${cwd.replace(/\/+$/, "")}/`;
      const stdout = [...this.files.keys()]
        .filter((path) => path.startsWith(prefix))
        .map((path) => `./${path.slice(prefix.length)}`)
        .sort()
        .join("\n");
      return { stdout: stdout ? `${stdout}\n` : "", stderr: "", exitCode: 0 };
    }
    return await this.runCommand(command, options);
  }

  async writeFile(
    path: string,
    content: string,
    options?: { encoding?: "utf-8" | "base64" },
  ): Promise<void> {
    this.writeBuffer(
      path,
      options?.encoding === "base64"
        ? Buffer.from(content, "base64")
        : Buffer.from(content),
    );
  }

  async readFile(
    path: string,
    options?: { encoding?: "utf-8" | "base64" },
  ): Promise<{ content: string; encoding?: string }> {
    const content = this.readBuffer(path);
    return options?.encoding === "base64"
      ? { content: content.toString("base64"), encoding: "base64" }
      : { content: content.toString(), encoding: "utf-8" };
  }

  async mkdir(): Promise<void> {}

  writeBuffer(path: string, content: Buffer): void {
    this.files.set(normalizeAbsolutePath(path), Buffer.from(content));
  }

  readBuffer(path: string): Buffer {
    const content = this.files.get(normalizeAbsolutePath(path));
    if (!content) throw new Error(`sandbox file not found: ${path}`);
    return content;
  }

  deleteBuffer(path: string): void {
    this.files.delete(normalizeAbsolutePath(path));
  }
}

class InMemoryManagedWorkspace implements ManagedWorkspace {
  private readonly files = new Map<string, Buffer>();

  constructor(files: Record<string, string | Buffer> = {}) {
    for (const [path, content] of Object.entries(files)) {
      this.files.set(normalizeRelPath(path), Buffer.from(content));
    }
  }

  async listFiles(
    _agentId: string,
    _sessionId: string,
    relPath = "",
  ): Promise<WorkspaceEntry[]> {
    const root = normalizeRelPath(relPath);
    const prefix = root ? `${root}/` : "";
    const entries = new Map<string, WorkspaceEntry>();
    for (const [path, content] of this.files.entries()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest) continue;
      const [name, ...nested] = rest.split("/");
      if (!name) continue;
      const entryPath = root ? `${root}/${name}` : name;
      if (nested.length > 0) {
        entries.set(name, {
          name,
          path: entryPath,
          type: "dir",
          size: 0,
          mtime: 1,
        });
        continue;
      }
      entries.set(name, {
        name,
        path: entryPath,
        type: "file",
        size: content.byteLength,
        mtime: 1,
      });
    }
    return [...entries.values()];
  }

  async readFile(
    _agentId: string,
    _sessionId: string,
    relPath: string,
  ): Promise<Buffer> {
    const content = this.files.get(normalizeRelPath(relPath));
    if (!content) throw new WorkspaceError("file_not_found", `file not found: ${relPath}`);
    return Buffer.from(content);
  }

  async writeFile(
    _agentId: string,
    _sessionId: string,
    relPath: string,
    content: Buffer,
  ): Promise<WorkspaceWriteResult> {
    const path = normalizeRelPath(relPath);
    this.files.set(path, Buffer.from(content));
    return { path, size: content.byteLength };
  }

  async deleteFile(_agentId: string, _sessionId: string, relPath: string): Promise<void> {
    const path = normalizeRelPath(relPath);
    if (!this.files.delete(path)) {
      throw new WorkspaceError("file_not_found", `file not found: ${path}`);
    }
  }
}

function normalizeAbsolutePath(path: string): string {
  return `/${normalizeRelPath(path)}`;
}

function normalizeRelPath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}
