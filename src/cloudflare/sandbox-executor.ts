import type {
  FlueManagedWorkspaceCommandExecutor,
  FlueManagedWorkspaceCommandInvocation,
  FlueShellResult,
} from "../harness/flue.js";
import type { ManagedWorkspace } from "../workspace/types.js";

export type CloudflareSandboxBindingLike = unknown;

export type CloudflareSandboxExecOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeout?: number;
  stdin?: string;
};

export type CloudflareSandboxExecResult = {
  success?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

export type CloudflareSandboxFileInfo = {
  content: string;
  encoding?: string;
};

export type CloudflareSandboxLike = {
  exec(
    command: string,
    options?: CloudflareSandboxExecOptions,
  ): Promise<CloudflareSandboxExecResult>;
  writeFile(
    path: string,
    content: string,
    options?: { encoding?: "utf-8" | "base64" },
  ): Promise<void>;
  readFile(
    path: string,
    options?: { encoding?: "utf-8" | "base64" },
  ): Promise<CloudflareSandboxFileInfo>;
  mkdir?(path: string, options?: { recursive?: boolean }): Promise<void>;
};

export type CloudflareSandboxResolver = (
  binding: CloudflareSandboxBindingLike,
  sandboxId: string,
  options?: Record<string, unknown>,
) => CloudflareSandboxLike;

export type CloudflareSandboxWorkspaceCommandExecutorOptions = {
  binding: CloudflareSandboxBindingLike;
  getSandbox: CloudflareSandboxResolver;
  sandboxIdPrefix?: string;
  sandboxOptions?: Record<string, unknown>;
  sandboxRoot?: string;
  /**
   * Path prefixes or exact paths that are intentionally not mirrored back into
   * OMA's durable workspace. Prefixes end with `/`.
   */
  syncExcludes?: string[];
  syncListTimeoutMs?: number;
};

const DEFAULT_SYNC_EXCLUDES = [".git/", "node_modules/", ".DS_Store"];

export function createCloudflareSandboxWorkspaceCommandExecutor(
  opts: CloudflareSandboxWorkspaceCommandExecutorOptions,
): FlueManagedWorkspaceCommandExecutor {
  return {
    exec: async (invocation) => {
      const sandboxId = stableSandboxId(
        opts.sandboxIdPrefix ?? "oma",
        invocation.agentId,
        invocation.sessionId,
      );
      const sandbox = opts.getSandbox(opts.binding, sandboxId, opts.sandboxOptions);
      const executor = new CloudflareSandboxWorkspaceCommandExecutor(
        sandbox,
        opts,
      );
      return await executor.exec(invocation);
    },
  };
}

class CloudflareSandboxWorkspaceCommandExecutor {
  private readonly syncExcludes: string[];

  constructor(
    private readonly sandbox: CloudflareSandboxLike,
    private readonly opts: CloudflareSandboxWorkspaceCommandExecutorOptions,
  ) {
    this.syncExcludes = opts.syncExcludes ?? DEFAULT_SYNC_EXCLUDES;
  }

  async exec(invocation: FlueManagedWorkspaceCommandInvocation): Promise<FlueShellResult> {
    throwIfAborted(invocation.signal);
    const sandboxRoot = normalizeAbsolutePath(
      this.opts.sandboxRoot ?? invocation.workspaceRoot,
    );
    const sandboxCwd = joinSandboxPath(sandboxRoot, invocation.relCwd);
    const before = new Set(await listWorkspaceFilePaths(
      invocation.workspace,
      invocation.agentId,
      invocation.sessionId,
      this.syncExcludes,
    ));

    await this.ensureDir(sandboxRoot);
    await this.mirrorWorkspaceToSandbox(invocation, sandboxRoot);
    throwIfAborted(invocation.signal);

    const result = await this.sandbox.exec(invocation.command, {
      cwd: sandboxCwd,
      env: invocation.env,
      timeout: timeoutSecondsToMs(invocation.timeoutSeconds),
    });
    throwIfAborted(invocation.signal);

    const after = await this.syncSandboxToWorkspace(invocation, sandboxRoot);
    for (const relPath of before) {
      if (after.has(relPath) || shouldExclude(relPath, this.syncExcludes)) continue;
      await invocation.workspace.deleteFile(
        invocation.agentId,
        invocation.sessionId,
        relPath,
      ).catch((err: unknown) => {
        if (!isWorkspaceFileNotFound(err)) throw err;
      });
    }
    throwIfAborted(invocation.signal);

    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: exitCodeFor(result),
    };
  }

  private async mirrorWorkspaceToSandbox(
    invocation: FlueManagedWorkspaceCommandInvocation,
    sandboxRoot: string,
  ): Promise<void> {
    const files = await listWorkspaceFiles(
      invocation.workspace,
      invocation.agentId,
      invocation.sessionId,
      this.syncExcludes,
    );
    for (const file of files) {
      const parent = dirname(joinSandboxPath(sandboxRoot, file.path));
      await this.ensureDir(parent);
      await this.sandbox.writeFile(
        joinSandboxPath(sandboxRoot, file.path),
        file.content.toString("base64"),
        { encoding: "base64" },
      );
    }
  }

  private async syncSandboxToWorkspace(
    invocation: FlueManagedWorkspaceCommandInvocation,
    sandboxRoot: string,
  ): Promise<Set<string>> {
    const relPaths = await this.listSandboxFiles(sandboxRoot);
    for (const relPath of relPaths) {
      if (shouldExclude(relPath, this.syncExcludes)) continue;
      const file = await this.sandbox.readFile(
        joinSandboxPath(sandboxRoot, relPath),
        { encoding: "base64" },
      );
      await invocation.workspace.writeFile(
        invocation.agentId,
        invocation.sessionId,
        relPath,
        decodeSandboxFile(file),
      );
    }
    return relPaths;
  }

  private async listSandboxFiles(sandboxRoot: string): Promise<Set<string>> {
    const result = await this.sandbox.exec(findCommand(sandboxRoot, this.syncExcludes), {
      cwd: sandboxRoot,
      timeout: this.opts.syncListTimeoutMs ?? 60_000,
    });
    if (exitCodeFor(result) !== 0) {
      throw new Error(
        `Cloudflare Sandbox workspace listing failed: ${result.stderr ?? result.stdout ?? ""}`,
      );
    }
    const files = new Set<string>();
    for (const line of (result.stdout ?? "").split("\n")) {
      const relPath = normalizeFindOutput(line);
      if (relPath && !shouldExclude(relPath, this.syncExcludes)) files.add(relPath);
    }
    return files;
  }

  private async ensureDir(path: string): Promise<void> {
    if (this.sandbox.mkdir) {
      await this.sandbox.mkdir(path, { recursive: true });
      return;
    }
    await this.sandbox.exec(`mkdir -p ${shellQuote(path)}`);
  }
}

async function listWorkspaceFiles(
  workspace: ManagedWorkspace,
  agentId: string,
  sessionId: string,
  syncExcludes: string[],
  relPath = "",
): Promise<Array<{ path: string; content: Buffer }>> {
  const entries = await workspace.listFiles(agentId, sessionId, relPath);
  const files: Array<{ path: string; content: Buffer }> = [];
  for (const entry of entries) {
    if (shouldExclude(entry.path, syncExcludes)) continue;
    if (entry.type === "dir") {
      files.push(...await listWorkspaceFiles(
        workspace,
        agentId,
        sessionId,
        syncExcludes,
        entry.path,
      ));
      continue;
    }
    files.push({
      path: entry.path,
      content: await workspace.readFile(agentId, sessionId, entry.path),
    });
  }
  return files;
}

async function listWorkspaceFilePaths(
  workspace: ManagedWorkspace,
  agentId: string,
  sessionId: string,
  syncExcludes: string[],
): Promise<string[]> {
  return (await listWorkspaceFiles(workspace, agentId, sessionId, syncExcludes))
    .map((file) => file.path);
}

function decodeSandboxFile(file: CloudflareSandboxFileInfo): Buffer {
  if (file.encoding === "base64") return Buffer.from(file.content, "base64");
  return Buffer.from(file.content);
}

function timeoutSecondsToMs(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value * 1_000))
    : undefined;
}

function exitCodeFor(result: CloudflareSandboxExecResult): number {
  if (typeof result.exitCode === "number" && Number.isFinite(result.exitCode)) {
    return Math.trunc(result.exitCode);
  }
  return result.success === false ? 1 : 0;
}

function findCommand(sandboxRoot: string, excludes: string[]): string {
  const predicates: string[] = [];
  for (const exclude of excludes) {
    const rel = normalizeRelPath(exclude);
    if (!rel) continue;
    if (exclude.endsWith("/")) {
      predicates.push("!", "-path", shellQuote(`./${rel}/*`));
    } else {
      predicates.push("!", "-path", shellQuote(`./${rel}`));
    }
  }
  return [
    "cd",
    shellQuote(sandboxRoot),
    "&&",
    "find",
    ".",
    "-type",
    "f",
    ...predicates,
    "-print",
  ].join(" ");
}

function normalizeFindOutput(line: string): string {
  return normalizeRelPath(line.trim().replace(/^\.\//, ""));
}

function shouldExclude(relPath: string, excludes: string[]): boolean {
  const normalized = normalizeRelPath(relPath);
  return excludes.some((exclude) => {
    const rel = normalizeRelPath(exclude);
    if (!rel) return false;
    return exclude.endsWith("/")
      ? normalized === rel || normalized.startsWith(`${rel}/`)
      : normalized === rel;
  });
}

function stableSandboxId(prefix: string, agentId: string, sessionId: string): string {
  const normalized = `${prefix}-${agentId}-${sessionId}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 120) : "oma-session";
}

function joinSandboxPath(root: string, relPath: string): string {
  const rel = normalizeRelPath(relPath);
  return rel ? `${normalizeAbsolutePath(root)}/${rel}` : normalizeAbsolutePath(root);
}

function normalizeAbsolutePath(path: string): string {
  const normalized = normalizePath(path);
  return normalized === "/" ? "/workspace" : normalized;
}

function normalizeRelPath(path: string): string {
  return normalizePath(`/${path.replace(/^\/+/, "")}`).replace(/^\//, "");
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const raw of path.split("/")) {
    const part = raw;
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function dirname(path: string): string {
  const normalized = normalizeAbsolutePath(path);
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "/" : normalized.slice(0, idx);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const err = new DOMException("This operation was aborted", "AbortError") as DOMException & {
    cause?: unknown;
  };
  err.cause = signal.reason;
  throw err;
}

function isWorkspaceFileNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "file_not_found"
  );
}
