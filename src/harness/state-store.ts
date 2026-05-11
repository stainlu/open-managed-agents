import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type HarnessStateKey = {
  harnessId: string;
  agentId: string;
  sessionId: string;
  key: string;
};

export type ManagedHarnessStateStore = {
  save(args: HarnessStateKey & { value: unknown }): Promise<void>;
  load(args: HarnessStateKey): Promise<unknown | null>;
  delete(args: HarnessStateKey): Promise<void>;
  deleteBySession(agentId: string, sessionId: string): Promise<void>;
};

export class LocalHarnessStateStore implements ManagedHarnessStateStore {
  constructor(private readonly stateRoot: string) {}

  async save(args: HarnessStateKey & { value: unknown }): Promise<void> {
    const raw = JSON.stringify(args.value);
    if (raw === undefined) {
      throw new Error("harness state value must be JSON-serializable");
    }
    const path = this.path(args);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, raw, "utf8");
    await rename(tmp, path);
  }

  async load(args: HarnessStateKey): Promise<unknown | null> {
    let raw: string;
    try {
      raw = await readFile(this.path(args), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return JSON.parse(raw) as unknown;
  }

  async delete(args: HarnessStateKey): Promise<void> {
    try {
      await unlink(this.path(args));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  async deleteBySession(agentId: string, sessionId: string): Promise<void> {
    await rm(this.sessionRoot(agentId, sessionId), { recursive: true, force: true });
  }

  private path(args: HarnessStateKey): string {
    return join(
      this.sessionRoot(args.agentId, args.sessionId),
      safeSegment(args.harnessId, "harnessId"),
      `${opaqueKey(args.key)}.json`,
    );
  }

  private sessionRoot(agentId: string, sessionId: string): string {
    return join(
      this.stateRoot,
      safeSegment(agentId, "agentId"),
      "sessions",
      safeSegment(sessionId, "sessionId"),
      "harness-state",
    );
  }
}

function safeSegment(value: string, label: string): string {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return value;
}

function opaqueKey(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
