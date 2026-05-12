import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  getSandbox,
  type Sandbox,
} from "@cloudflare/sandbox";
import {
  CloudflareFlueDurableObject,
  type CloudflareFlueDurableObjectEnv,
} from "../../../src/cloudflare/durable-object.js";
import {
  createCloudflareSandboxWorkspaceCommandExecutor,
  type CloudflareSandboxResolver,
} from "../../../src/cloudflare/sandbox-executor.js";
import {
  FlueHarnessAdapter,
} from "../../../src/harness/flue.js";
import type {
  AgentConfig,
} from "../../../src/orchestrator/types.js";
import {
  createCloudflareFlueWorkerRouter,
  type CloudflareFlueWorkerEnv,
} from "../../../src/cloudflare/worker.js";
import {
  runCloudflareManagedRunWorkflow,
  type CloudflareManagedRunWorkflowEnv,
} from "../../../src/cloudflare/workflow.js";
import type {
  ManagedRunExecutionResult,
  ManagedRunRequest,
} from "../../../src/runtime/run-scheduler.js";
import {
  R2ManagedWorkspace,
} from "../../../src/workspace/r2.js";

export { Sandbox } from "@cloudflare/sandbox";

export type Env =
  & CloudflareFlueWorkerEnv
  & CloudflareFlueDurableObjectEnv
  & CloudflareManagedRunWorkflowEnv
  & {
    Sandbox: DurableObjectNamespace<Sandbox>;
    OMA_API_TOKEN?: string;
  };

const router = createCloudflareFlueWorkerRouter();
const resolveSandbox = getSandbox as unknown as CloudflareSandboxResolver;
const SMOKE_SANDBOX_EXEC_PATH = "/_oma/smoke/sandbox-exec";
const SMOKE_FLUE_TASK_PATH = "/_oma/smoke/flue-task";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === SMOKE_SANDBOX_EXEC_PATH) {
      return handleSandboxExecSmoke(request, env);
    }
    if (url.pathname === SMOKE_FLUE_TASK_PATH) {
      return handleFlueTaskSmoke(request, env);
    }
    return router.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

export class OMACoordinator extends CloudflareFlueDurableObject<Env> {
  protected override createWorkspaceCommandExecutor(env: Env) {
    return createExampleWorkspaceCommandExecutor(env);
  }
}

async function handleSandboxExecSmoke(request: Request, env: Env): Promise<Response> {
  const gate = requireSmokeRequest(request, env);
  if (gate) return gate;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  const parsed = parseSandboxExecSmokePayload(payload);
  if (!parsed.ok) return jsonResponse({ error: "invalid_request", message: parsed.message }, 400);

  const workspaceBinding = env.OMA_WORKSPACE;
  if (!workspaceBinding) {
    return jsonResponse({ error: "missing_workspace_binding" }, 500);
  }
  const workspace = new R2ManagedWorkspace(workspaceBinding);
  const commandExecutor = createExampleWorkspaceCommandExecutor(env);
  const harness = new FlueHarnessAdapter({
    workspace,
    workspaceCommandExecutor: commandExecutor,
  });
  const result = await harness.invokeShell({
    agent: smokeAgent(parsed.value.agentId),
    sessionId: parsed.value.sessionId,
    runId: `run_smoke_shell_${crypto.randomUUID()}`,
    command: parsed.value.command,
    cwd: parsed.value.cwd ?? ".",
    timeoutMs: Math.trunc((parsed.value.timeoutSeconds ?? 30) * 1_000),
  });
  return jsonResponse({
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.exitCode,
    event_types: result.events?.map((event) => event.type) ?? [],
    run_kinds: result.events
      ?.map((event) => event.runKind)
      .filter((kind): kind is string => typeof kind === "string") ?? [],
  }, 200);
}

async function handleFlueTaskSmoke(request: Request, env: Env): Promise<Response> {
  const gate = requireSmokeRequest(request, env);
  if (gate) return gate;
  if (!env.AI) {
    return jsonResponse({ error: "missing_ai_binding" }, 500);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  const parsed = parseFlueTaskSmokePayload(payload);
  if (!parsed.ok) return jsonResponse({ error: "invalid_request", message: parsed.message }, 400);

  const workspaceBinding = env.OMA_WORKSPACE;
  if (!workspaceBinding) {
    return jsonResponse({ error: "missing_workspace_binding" }, 500);
  }
  const workspace = new R2ManagedWorkspace(workspaceBinding);
  const harness = new FlueHarnessAdapter({
    workspace,
    workspaceCommandExecutor: createExampleWorkspaceCommandExecutor(env),
    cloudflareAiBinding: env.AI,
    cloudflareAiGateway: { id: env.OMA_CLOUDFLARE_AI_GATEWAY_ID ?? "default" },
  });
  const model = parsed.value.model ?? "cloudflare/@cf/openai/gpt-oss-20b";
  const result = await harness.invokeTask({
    agent: smokeAgent(
      parsed.value.agentId,
      model,
      "Run only the requested deterministic smoke task.",
    ),
    sessionId: parsed.value.sessionId,
    runId: `run_smoke_task_${crypto.randomUUID()}`,
    task: parsed.value.task,
    cwd: parsed.value.cwd,
    timeoutMs: Math.trunc((parsed.value.timeoutSeconds ?? 60) * 1_000),
    model,
    thinkingLevel: "off",
  });
  return jsonResponse({
    text: result.output,
    tokens_in: result.tokensIn,
    tokens_out: result.tokensOut,
    model: result.model,
    event_types: result.events?.map((event) => event.type) ?? [],
    run_kinds: result.events
      ?.map((event) => event.runKind)
      .filter((kind): kind is string => typeof kind === "string") ?? [],
  }, 200);
}

function requireSmokeRequest(request: Request, env: Env): Response | undefined {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  if (!env.OMA_API_TOKEN) {
    return jsonResponse({ error: "smoke_route_requires_oma_api_token" }, 403);
  }
  if (request.headers.get("authorization") !== `Bearer ${env.OMA_API_TOKEN}`) {
    return jsonResponse({ error: "forbidden" }, 403);
  }
  if (!env.OMA_WORKSPACE) {
    return jsonResponse({ error: "missing_workspace_binding" }, 500);
  }
  return undefined;
}

function createExampleWorkspaceCommandExecutor(env: Env) {
  return createCloudflareSandboxWorkspaceCommandExecutor({
    binding: env.Sandbox,
    getSandbox: resolveSandbox,
    sandboxIdPrefix: "oma",
    sandboxOptions: { sleepAfter: "10m" },
  });
}

function smokeAgent(
  agentId: string,
  model = "cloudflare/@cf/openai/gpt-oss-20b",
  instructions = "Run only the requested deterministic sandbox smoke command.",
): AgentConfig {
  return {
    agentId,
    harnessId: "flue",
    model,
    tools: [],
    instructions,
    permissionPolicy: { type: "always_allow" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null,
    version: 1,
    callableAgents: [],
    maxSubagentDepth: 0,
    mcpServers: {},
    thinkingLevel: "off",
    channels: { telegram: { enabled: false } },
  };
}

type SandboxExecSmokePayload = {
  agentId: string;
  sessionId: string;
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
};

type FlueTaskSmokePayload = {
  agentId: string;
  sessionId: string;
  task: string;
  cwd?: string;
  model?: string;
  timeoutSeconds?: number;
};

function parseSandboxExecSmokePayload(
  payload: unknown,
): { ok: true; value: SandboxExecSmokePayload } | { ok: false; message: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, message: "body must be an object" };
  }
  const record = payload as Record<string, unknown>;
  const agentId = record.agent_id;
  const sessionId = record.session_id;
  const command = record.command;
  const cwd = record.cwd;
  const timeoutSeconds = record.timeout_seconds;
  if (typeof agentId !== "string" || agentId.length === 0) {
    return { ok: false, message: "agent_id must be a non-empty string" };
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return { ok: false, message: "session_id must be a non-empty string" };
  }
  if (typeof command !== "string" || command.length === 0) {
    return { ok: false, message: "command must be a non-empty string" };
  }
  if (cwd !== undefined && typeof cwd !== "string") {
    return { ok: false, message: "cwd must be a string when provided" };
  }
  if (
    timeoutSeconds !== undefined &&
    (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
  ) {
    return { ok: false, message: "timeout_seconds must be a positive number when provided" };
  }
  return {
    ok: true,
    value: {
      agentId,
      sessionId,
      command,
      cwd,
      timeoutSeconds: typeof timeoutSeconds === "number" ? timeoutSeconds : undefined,
    },
  };
}

function parseFlueTaskSmokePayload(
  payload: unknown,
): { ok: true; value: FlueTaskSmokePayload } | { ok: false; message: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, message: "body must be an object" };
  }
  const record = payload as Record<string, unknown>;
  const agentId = record.agent_id;
  const sessionId = record.session_id;
  const task = record.task;
  const cwd = record.cwd;
  const model = record.model;
  const timeoutSeconds = record.timeout_seconds;
  if (typeof agentId !== "string" || agentId.length === 0) {
    return { ok: false, message: "agent_id must be a non-empty string" };
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return { ok: false, message: "session_id must be a non-empty string" };
  }
  if (typeof task !== "string" || task.length === 0) {
    return { ok: false, message: "task must be a non-empty string" };
  }
  if (cwd !== undefined && typeof cwd !== "string") {
    return { ok: false, message: "cwd must be a string when provided" };
  }
  if (model !== undefined && (typeof model !== "string" || model.length === 0)) {
    return { ok: false, message: "model must be a non-empty string when provided" };
  }
  if (
    timeoutSeconds !== undefined &&
    (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
  ) {
    return { ok: false, message: "timeout_seconds must be a positive number when provided" };
  }
  return {
    ok: true,
    value: {
      agentId,
      sessionId,
      task,
      cwd,
      model: typeof model === "string" ? model : undefined,
      timeoutSeconds: typeof timeoutSeconds === "number" ? timeoutSeconds : undefined,
    },
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class OMARunWorkflow extends WorkflowEntrypoint<Env, ManagedRunRequest> {
  async run(
    event: WorkflowEvent<ManagedRunRequest>,
    step: WorkflowStep,
  ): Promise<ManagedRunExecutionResult> {
    return runCloudflareManagedRunWorkflow(event, step, this.env);
  }
}
