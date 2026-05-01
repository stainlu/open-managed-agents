#!/usr/bin/env node
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PROTOCOL_VERSION = "oma.adapter.v1";
const HARNESS_ID = "claude-agent-sdk";
const ADAPTER_VERSION = "0.1.0";
const require = createRequire(import.meta.url);

function env(name, fallback = "") {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  return fallback;
}

function nowMs() {
  return Date.now();
}

function eventId(prefix = "evt") {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function jsonDumps(value) {
  return JSON.stringify(value);
}

function stringify(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeJson(value) {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return stringify(value);
  }
}

function normalizeModel(model) {
  const raw = String(model ?? "").trim();
  if (raw.startsWith("anthropic/")) return raw.slice("anthropic/".length);
  return raw;
}

function configureProcess() {
  const stateDir = env("OMA_STATE_DIR", "/workspace");
  const claudeConfigDir = env("OMA_CLAUDE_CONFIG_DIR", join(stateDir, ".claude"));
  mkdirSync(stateDir, { recursive: true, mode: 0o755 });
  mkdirSync(claudeConfigDir, { recursive: true, mode: 0o755 });
  process.env.CLAUDE_CONFIG_DIR ||= claudeConfigDir;
  process.env.OMA_CLAUDE_CWD ||= stateDir;
  process.chdir(stateDir);
}

function sdkPackageInfo() {
  try {
    const entry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const raw = readFileSync(join(dirname(entry), "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: String(parsed.version ?? "unknown"),
      claudeCodeVersion: String(parsed.claudeCodeVersion ?? "unknown"),
    };
  } catch {
    return { version: "unknown", claudeCodeVersion: "unknown" };
  }
}

function errorPayload(code, message, status = 500, retryable = false, details) {
  const error = { code, message, retryable };
  if (details !== undefined) error.details = safeJson(details);
  return [status, { error }];
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value ?? ""),
  );
}

function numberValue(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function nativeState(state) {
  const info = sdkPackageInfo();
  return {
    native_session_id: state.nativeSessionId ?? null,
    native_thread_id: null,
    native_metadata: {
      harness: HARNESS_ID,
      sdk_version: info.version,
      claude_code_version: info.claudeCodeVersion,
      claude_config_dir: process.env.CLAUDE_CONFIG_DIR ?? "",
    },
  };
}

function usagePayload(usage, model) {
  const payload = {
    tokens_in: Math.max(0, Math.trunc(usage?.tokensIn ?? 0)),
    tokens_out: Math.max(0, Math.trunc(usage?.tokensOut ?? 0)),
    model: usage?.model || model || undefined,
  };
  if (usage?.costUsd != null && usage.costUsd >= 0) payload.cost_usd = usage.costUsd;
  return payload;
}

function canonicalToolName(name) {
  const raw = String(name ?? "").trim();
  const lower = raw.toLowerCase();
  const aliases = {
    bash: "bash",
    shell: "bash",
    terminal: "bash",
    command: "bash",
    read: "read",
    file_read: "read",
    grep: "grep",
    glob: "glob",
    write: "write",
    file_write: "write",
    edit: "edit",
    multiedit: "multiedit",
    multi_edit: "multiedit",
    file: "file",
    files: "file",
    filesystem: "file",
    web: "web",
    websearch: "websearch",
    web_search: "websearch",
    webfetch: "webfetch",
    web_fetch: "webfetch",
    todo: "todowrite",
    todowrite: "todowrite",
  };
  const mapped = aliases[lower] ?? lower;
  return mapped.replace(/[^a-z0-9]/g, "");
}

function mappedToolNames(names) {
  const out = [];
  const add = (name) => {
    if (name && !out.includes(name)) out.push(name);
  };
  for (const raw of names ?? []) {
    const canonical = canonicalToolName(raw);
    if (!canonical) continue;
    switch (canonical) {
      case "bash":
        add("Bash");
        break;
      case "read":
        add("Read");
        break;
      case "grep":
        add("Grep");
        break;
      case "glob":
        add("Glob");
        break;
      case "write":
        add("Write");
        break;
      case "edit":
        add("Edit");
        break;
      case "multiedit":
        add("MultiEdit");
        break;
      case "file":
        add("Read");
        add("Write");
        add("Edit");
        add("MultiEdit");
        add("Grep");
        add("Glob");
        break;
      case "web":
        add("WebSearch");
        add("WebFetch");
        break;
      case "websearch":
        add("WebSearch");
        break;
      case "webfetch":
        add("WebFetch");
        break;
      case "todowrite":
        add("TodoWrite");
        break;
      default:
        add(String(raw));
    }
  }
  return out;
}

function policyToolSet(policy) {
  return new Set((policy?.tools ?? []).map(canonicalToolName).filter(Boolean));
}

function toolMatchesPolicy(toolName, policyTools) {
  if (policyTools.size === 0) return true;
  const canonical = canonicalToolName(toolName);
  if (policyTools.has(canonical)) return true;
  if (canonical === "bash" && policyTools.has("shell")) return true;
  if (["read", "write", "edit", "multiedit", "grep", "glob"].includes(canonical)) {
    return policyTools.has("file");
  }
  if (["websearch", "webfetch"].includes(canonical)) return policyTools.has("web");
  return false;
}

function normalizeMcpServers(rawServers) {
  const out = {};
  for (const [name, raw] of Object.entries(rawServers ?? {})) {
    if (!raw || typeof raw !== "object") continue;
    const cfg = { ...raw };
    if (cfg.url && !cfg.type) cfg.type = "http";
    if (cfg.command && !cfg.type) cfg.type = "stdio";
    if (cfg.env && typeof cfg.env === "object") {
      cfg.env = Object.fromEntries(
        Object.entries(cfg.env).map(([key, value]) => [key, String(value)]),
      );
    }
    out[name] = cfg;
  }
  return out;
}

function thinkingOptions(level) {
  const raw = String(level ?? "off").toLowerCase();
  if (raw === "off") return { thinking: { type: "disabled" }, maxThinkingTokens: 0 };
  if (["low", "medium", "high", "xhigh"].includes(raw)) {
    return { thinking: { type: "adaptive" }, effort: raw };
  }
  return {};
}

class AdapterHttpError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message ?? "adapter error");
    this.status = status;
    this.payload = payload;
  }
}

class PendingApproval {
  constructor({ approvalId, managedSessionId, toolName, toolCallId, description, input }) {
    this.approval_id = approvalId;
    this.managed_session_id = managedSessionId;
    this.tool_name = toolName;
    this.tool_call_id = toolCallId;
    this.description = description;
    this.arrived_at = nowMs();
    this.input = safeJson(input);
    this.decision = undefined;
    this.promise = new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  toPayload() {
    return {
      approval_id: this.approval_id,
      managed_session_id: this.managed_session_id,
      tool_name: this.tool_name,
      tool_call_id: this.tool_call_id,
      description: this.description,
      arrived_at: this.arrived_at,
    };
  }

  resolve(decision) {
    if (this.decision) return;
    this.decision = decision === "allow" ? "allow" : "deny";
    this._resolve(this.decision);
  }
}

class ManagedSession {
  constructor(managedSessionId, nativeSessionId = null) {
    this.managedSessionId = managedSessionId;
    this.nativeSessionId = isUuid(nativeSessionId) ? nativeSessionId : null;
    this.model = "";
    this.thinkingLevel = "off";
    this.active = false;
    this.activeQuery = null;
    this.abortController = null;
    this.activeEvents = [];
    this.eventBacklog = [];
    this.pendingApprovals = new Map();
    this.usage = null;
  }
}

class ClaudeAgentSdkAdapterRuntime {
  constructor() {
    this.sessions = new Map();
  }

  ready() {
    const info = sdkPackageInfo();
    return {
      protocol_version: PROTOCOL_VERSION,
      harness_id: HARNESS_ID,
      adapter_version: ADAPTER_VERSION,
      harness_version: `sdk ${info.version}; claude-code ${info.claudeCodeVersion}`,
      capabilities: {
        streaming: true,
        cancel: true,
        interrupt: true,
        tool_approvals: true,
        mcp: true,
        dynamic_model_patch: true,
        compaction: false,
        native_session_resume: true,
        usage: true,
        subagents: false,
      },
    };
  }

  getSession(sessionId, request = null) {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const nativeSessionId = request?.session?.native_session_id;
    const state = new ManagedSession(sessionId, nativeSessionId);
    this.sessions.set(sessionId, state);
    return state;
  }

  appendEvent(state, type, content, fields = {}) {
    const event = {
      event_id: eventId(),
      session_id: state.managedSessionId,
      type,
      content: stringify(content),
      created_at: nowMs(),
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) event[key] = safeJson(value);
    }
    state.activeEvents.push(event);
    state.eventBacklog.push(event);
    return event;
  }

  async startTurn(sessionId, request) {
    const state = this._beginTurn(sessionId, request);
    this.appendEvent(state, "user.message", request.turn.content);
    const output = await this._runTurn(state, request);
    return this._resultPayload(state, output);
  }

  async streamTurn(sessionId, request, writeFrame) {
    let state;
    try {
      state = this._beginTurn(sessionId, request);
    } catch (error) {
      writeFrame({
        type: "state",
        state: "error",
        error_message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const event = this.appendEvent(state, "user.message", request.turn.content);
    writeFrame({ type: "event", event });
    writeFrame({ type: "state", state: "running" });
    try {
      const output = await this._runTurn(state, request, writeFrame);
      writeFrame({ type: "turn.completed", result: this._resultPayload(state, output) });
    } catch (error) {
      writeFrame({
        type: "state",
        state: "error",
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  _beginTurn(sessionId, request) {
    const state = this.getSession(sessionId, request);
    if (state.active) {
      throw new AdapterHttpError(
        ...errorPayload("turn_failed", "session already has an active turn", 409, true),
      );
    }
    state.active = true;
    state.activeEvents = [];
    state.usage = null;
    state.thinkingLevel = request.turn?.thinking_level ?? request.agent?.thinking_level ?? state.thinkingLevel;
    return state;
  }

  _buildOptions(state, request, writeFrame) {
    const agent = request.agent ?? {};
    const turn = request.turn ?? {};
    const policy = agent.permission_policy ?? { type: "always_allow" };
    const model = normalizeModel(turn.model || state.model || agent.model);
    if (!model) throw new Error("agent.model is required");
    state.model = model;

    const tools = mappedToolNames(agent.tools ?? []);
    const deniedTools =
      policy.type === "deny" ? mappedToolNames(policy.tools ?? []) : [];
    const options = {
      cwd: env("OMA_CLAUDE_CWD", env("OMA_STATE_DIR", "/workspace")),
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: env("OMA_CLAUDE_CONFIG_DIR", "/workspace/.claude"),
        CLAUDE_AGENT_SDK_CLIENT_APP: env(
          "CLAUDE_AGENT_SDK_CLIENT_APP",
          "open-managed-agents/0.1",
        ),
      },
      model,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: String(agent.instructions ?? ""),
      },
      tools: tools.length > 0 ? tools : { type: "preset", preset: "claude_code" },
      settingSources: [],
      persistSession: true,
      includePartialMessages: true,
      includeHookEvents: true,
      forwardSubagentText: true,
      onElicitation: async () => ({ action: "decline", content: null }),
      mcpServers: normalizeMcpServers(agent.mcp_servers),
      disallowedTools: deniedTools,
      canUseTool: this._permissionHandler(state, agent, writeFrame),
      abortController: new AbortController(),
      ...thinkingOptions(turn.thinking_level ?? agent.thinking_level),
    };

    const claudeCodeBin = env("OMA_CLAUDE_CODE_BIN");
    if (claudeCodeBin) options.pathToClaudeCodeExecutable = claudeCodeBin;

    if (policy.type === "always_allow") {
      options.permissionMode = "bypassPermissions";
      options.allowDangerouslySkipPermissions = true;
      if (tools.length > 0) options.allowedTools = tools;
    } else {
      options.permissionMode = "default";
    }

    const candidateResume =
      state.nativeSessionId ??
      (request.session?.native_metadata?.harness === HARNESS_ID
        ? request.session?.native_session_id
        : null);
    if (isUuid(candidateResume)) options.resume = candidateResume;
    state.abortController = options.abortController;
    return options;
  }

  _permissionHandler(state, agent, writeFrame) {
    const policy = agent.permission_policy ?? { type: "always_allow" };
    const policyTools = policyToolSet(policy);
    return async (toolName, input, options) => {
      if (policy.type === "deny" && toolMatchesPolicy(toolName, policyTools)) {
        return {
          behavior: "deny",
          message: `tool ${toolName} is denied by Open Managed Agents policy`,
          toolUseID: options?.toolUseID,
        };
      }
      if (policy.type !== "always_ask" || !toolMatchesPolicy(toolName, policyTools)) {
        return {
          behavior: "allow",
          toolUseID: options?.toolUseID,
        };
      }

      const approvalId = options?.toolUseID || eventId("appr");
      const description =
        options?.title ||
        options?.description ||
        options?.displayName ||
        `Claude wants to use ${toolName}`;
      const pending = new PendingApproval({
        approvalId,
        managedSessionId: state.managedSessionId,
        toolName,
        toolCallId: options?.toolUseID,
        description,
        input,
      });
      state.pendingApprovals.set(approvalId, pending);
      const event = this.appendEvent(state, "agent.tool_confirmation_request", description, {
        approval_id: approvalId,
        tool_name: toolName,
        tool_call_id: options?.toolUseID,
        tool_arguments: {
          input: safeJson(input),
          blockedPath: options?.blockedPath,
          decisionReason: options?.decisionReason,
          agentID: options?.agentID,
        },
      });
      if (writeFrame) {
        writeFrame({ type: "event", event });
        writeFrame({ type: "approval.requested", approval: pending.toPayload() });
      }

      const timeoutMs = Number.parseInt(env("OMA_CLAUDE_APPROVAL_TIMEOUT_MS", "300000"), 10);
      const timer = setTimeout(() => pending.resolve("deny"), timeoutMs);
      try {
        const decision = await pending.promise;
        if (writeFrame) {
          writeFrame({ type: "approval.resolved", approval_id: approvalId, decision });
        }
        if (decision === "allow") {
          return {
            behavior: "allow",
            toolUseID: options?.toolUseID,
            decisionClassification: "user_temporary",
          };
        }
        return {
          behavior: "deny",
          message: `tool ${toolName} denied by user`,
          toolUseID: options?.toolUseID,
          decisionClassification: "user_reject",
        };
      } finally {
        clearTimeout(timer);
        state.pendingApprovals.delete(approvalId);
      }
    };
  }

  async _runTurn(state, request, writeFrame) {
    const turn = {
      output: "",
      resultError: null,
      resultMessage: null,
    };
    try {
      const options = this._buildOptions(state, request, writeFrame);
      const prompt = String(request.turn?.content ?? "");
      const q = query({ prompt, options });
      state.activeQuery = q;
      for await (const message of q) {
        this._handleSdkMessage(state, turn, message, writeFrame);
      }
      this._attachUsageToLatestMessage(state);
      if (turn.resultError) {
        throw new AdapterHttpError(
          ...errorPayload("native_harness_error", turn.resultError.message, 502),
        );
      }
      return turn.output;
    } catch (error) {
      if (error instanceof AdapterHttpError) throw error;
      throw new AdapterHttpError(
        ...errorPayload(
          "native_harness_error",
          error instanceof Error ? error.message : String(error),
          502,
        ),
      );
    } finally {
      state.active = false;
      state.activeQuery = null;
      state.abortController = null;
      for (const pending of state.pendingApprovals.values()) pending.resolve("deny");
      state.pendingApprovals.clear();
    }
  }

  _handleSdkMessage(state, turn, message, writeFrame) {
    if (!message || typeof message !== "object") return;
    if (isUuid(message.session_id)) {
      state.nativeSessionId = message.session_id;
    }

    if (message.type === "stream_event") {
      this._handleStreamEvent(state, message.event, writeFrame);
      return;
    }

    if (message.type === "assistant") {
      this._handleAssistantMessage(state, turn, message);
      return;
    }

    if (message.type === "result") {
      this._handleResultMessage(state, turn, message);
      return;
    }

    if (message.type === "tool_progress") {
      this.appendEvent(state, "agent.tool_use", `${message.tool_name} running`, {
        tool_name: message.tool_name,
        tool_call_id: message.tool_use_id,
      });
      return;
    }

    if (message.type === "tool_use_summary") {
      this.appendEvent(state, "agent.tool_result", message.summary, {
        tool_name: "tool_use_summary",
        tool_arguments: { preceding_tool_use_ids: message.preceding_tool_use_ids },
      });
      return;
    }

    if (message.type === "auth_status" && message.error) {
      this.appendEvent(state, "agent.error", message.error, { is_error: true });
      return;
    }

    if (message.type === "system") {
      this._handleSystemMessage(state, message);
    }
  }

  _handleStreamEvent(state, event, writeFrame) {
    if (!event || typeof event !== "object") return;
    if (event.type === "content_block_delta") {
      const delta = event.delta ?? {};
      if (typeof delta.text === "string" && delta.text) {
        if (writeFrame) writeFrame({ type: "delta", content: delta.text });
      }
      const thinking = delta.thinking ?? delta.signature_delta;
      if (typeof thinking === "string" && thinking) {
        this.appendEvent(state, "agent.thinking", thinking);
      }
    }
    if (event.type === "message_delta" && event.usage) {
      state.usage = this._usageFromRaw(event.usage, state.model, state.usage);
    }
  }

  _handleAssistantMessage(state, turn, message) {
    const blocks = Array.isArray(message.message?.content)
      ? message.message.content
      : [{ type: "text", text: message.message?.content }];
    let textOut = "";
    for (const block of blocks) {
      const event = this._eventFromContentBlock(state, block, message);
      if (event?.type === "agent.message") textOut += event.content;
    }
    if (textOut) {
      turn.output = textOut;
    }
  }

  _eventFromContentBlock(state, block, message) {
    if (!block || typeof block !== "object") return null;
    const type = String(block.type ?? "");
    if (type === "text" && block.text) {
      return this.appendEvent(state, "agent.message", block.text, {
        model: message.message?.model || state.model,
      });
    }
    if (type === "thinking" || type === "redacted_thinking") {
      const content = block.thinking ?? block.text ?? block.data ?? "";
      if (!content) return null;
      return this.appendEvent(state, "agent.thinking", content);
    }
    if (type === "tool_use" || type === "server_tool_use") {
      return this.appendEvent(state, "agent.tool_use", stringify(block.input), {
        tool_name: block.name || type,
        tool_call_id: block.id,
        tool_arguments: block.input ?? {},
      });
    }
    if (type === "tool_result" || type.endsWith("_tool_result")) {
      return this.appendEvent(state, "agent.tool_result", stringify(block.content ?? block), {
        tool_name: block.name || type,
        tool_call_id: block.tool_use_id || block.id,
        is_error: Boolean(block.is_error),
        tool_arguments: block,
      });
    }
    return null;
  }

  _handleResultMessage(state, turn, message) {
    turn.resultMessage = message;
    if (message.result) turn.output = String(message.result);
    state.usage = this._usageFromResult(message, state.model);
    if (message.subtype && message.subtype !== "success") {
      const reason = message.errors?.join("\n") || message.stop_reason || message.subtype;
      const event = this.appendEvent(state, "agent.error", reason, { is_error: true });
      turn.resultError = new Error(event.content);
    }
    if (message.session_id && isUuid(message.session_id)) {
      state.nativeSessionId = message.session_id;
    }
  }

  _handleSystemMessage(state, message) {
    if (message.subtype === "init") {
      state.model = normalizeModel(message.model || state.model);
      this.appendEvent(
        state,
        "session.runtime_notice",
        `Claude Agent SDK initialized model ${state.model}`,
        {
          model: state.model,
          tool_arguments: {
            claude_code_version: message.claude_code_version,
            tools: message.tools,
            mcp_servers: message.mcp_servers,
            permissionMode: message.permissionMode,
          },
        },
      );
      return;
    }
    if (message.subtype === "compact_boundary" || message.status === "compacting") {
      this.appendEvent(state, "session.compaction", stringify(message.compact_metadata ?? message));
      return;
    }
    if (message.subtype === "local_command_output") {
      this.appendEvent(state, "agent.tool_result", message.content, {
        tool_name: "local_command",
      });
      return;
    }
    if (message.subtype === "api_retry") {
      this.appendEvent(
        state,
        "session.runtime_notice",
        `Claude API retry ${message.attempt}/${message.max_retries}`,
        { tool_arguments: message },
      );
      return;
    }
    if (message.error) {
      this.appendEvent(state, "agent.error", stringify(message.error), { is_error: true });
    }
  }

  _usageFromResult(message, fallbackModel) {
    const usage = this._usageFromRaw(message.usage, fallbackModel);
    const cost = numberValue(message.total_cost_usd);
    if (cost > 0) usage.costUsd = cost;
    const modelUsage = message.modelUsage ?? {};
    const firstModel = Object.keys(modelUsage)[0];
    if (firstModel) usage.model = firstModel;
    if (!usage.costUsd) {
      const modelCost = Object.values(modelUsage).reduce(
        (sum, item) => sum + numberValue(item?.costUSD, item?.cost_usd),
        0,
      );
      if (modelCost > 0) usage.costUsd = modelCost;
    }
    return usage;
  }

  _usageFromRaw(raw, fallbackModel, previous = null) {
    const input =
      numberValue(raw?.input_tokens, raw?.inputTokens) +
      numberValue(raw?.cache_creation_input_tokens, raw?.cacheCreationInputTokens) +
      numberValue(raw?.cache_read_input_tokens, raw?.cacheReadInputTokens);
    const output = numberValue(raw?.output_tokens, raw?.outputTokens);
    return {
      tokensIn: Math.max(previous?.tokensIn ?? 0, input),
      tokensOut: Math.max(previous?.tokensOut ?? 0, output),
      costUsd: previous?.costUsd,
      model: previous?.model || fallbackModel,
    };
  }

  _attachUsageToLatestMessage(state) {
    if (!state.usage) return;
    for (let i = state.activeEvents.length - 1; i >= 0; i -= 1) {
      const event = state.activeEvents[i];
      if (event.type === "agent.message") {
        event.tokens_in = state.usage.tokensIn;
        event.tokens_out = state.usage.tokensOut;
        if (state.usage.costUsd != null) event.cost_usd = state.usage.costUsd;
        event.model = state.usage.model || state.model;
        return;
      }
    }
  }

  _resultPayload(state, output) {
    return {
      protocol_version: PROTOCOL_VERSION,
      output,
      usage: usagePayload(state.usage, state.model),
      native: nativeState(state),
      events: [...state.activeEvents],
    };
  }

  listApprovals(sessionId) {
    const state = this.getSession(sessionId);
    return [...state.pendingApprovals.values()].map((approval) => approval.toPayload());
  }

  resolveApproval(sessionId, approvalId, decision) {
    const state = this.getSession(sessionId);
    const pending = state.pendingApprovals.get(approvalId);
    if (!pending) {
      throw new AdapterHttpError(
        ...errorPayload("tool_approval_not_found", `approval ${approvalId} does not exist`, 404),
      );
    }
    pending.resolve(decision === "allow" ? "allow" : "deny");
    return {
      protocol_version: PROTOCOL_VERSION,
      accepted: true,
      native: nativeState(state),
    };
  }

  async cancel(sessionId) {
    const state = this.getSession(sessionId);
    if (state.activeQuery?.interrupt) {
      await state.activeQuery.interrupt().catch(() => undefined);
    }
    if (state.abortController && !state.abortController.signal.aborted) {
      state.abortController.abort();
    }
    if (state.activeQuery?.close) state.activeQuery.close();
    for (const pending of state.pendingApprovals.values()) pending.resolve("deny");
    return {
      protocol_version: PROTOCOL_VERSION,
      accepted: true,
      native: nativeState(state),
    };
  }

  async patch(sessionId, request) {
    const state = this.getSession(sessionId);
    if (request.model) state.model = normalizeModel(request.model);
    if (request.thinking_level) {
      state.thinkingLevel = request.thinking_level;
      this.appendEvent(state, "session.thinking_level_change", request.thinking_level);
    }
    if (request.model && state.activeQuery?.setModel) {
      await state.activeQuery.setModel(state.model).catch(() => undefined);
      this.appendEvent(state, "session.model_change", state.model, { model: state.model });
    }
    return {
      protocol_version: PROTOCOL_VERSION,
      accepted: true,
      native: nativeState(state),
    };
  }

  compact(sessionId) {
    const state = this.getSession(sessionId);
    throw new AdapterHttpError(
      ...errorPayload(
        "unsupported_capability",
        "Claude Agent SDK adapter does not expose manual compaction yet",
        501,
        false,
        nativeState(state),
      ),
    );
  }

  listEvents(sessionId) {
    const state = this.getSession(sessionId);
    return {
      protocol_version: PROTOCOL_VERSION,
      events: [...state.eventBacklog],
      native: nativeState(state),
    };
  }
}

const RUNTIME = new ClaudeAgentSdkAdapterRuntime();

function authOk(req) {
  const token = env("OPENCLAW_GATEWAY_TOKEN");
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new AdapterHttpError(...errorPayload("bad_request", `invalid JSON: ${error}`, 400));
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new AdapterHttpError(...errorPayload("bad_request", "JSON body must be an object", 400));
  }
  if (data.protocol_version !== PROTOCOL_VERSION) {
    throw new AdapterHttpError(
      ...errorPayload("bad_request", "protocol_version must be oma.adapter.v1", 400),
    );
  }
  return data;
}

function writeJson(res, status, payload) {
  const body = Buffer.from(jsonDumps(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
  });
  res.end(body);
}

function writeError(res, status, payload) {
  writeJson(res, status, payload);
}

function pathParts(req) {
  const url = new URL(req.url ?? "/", "http://adapter.local");
  return url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

function sessionRoute(req, suffix) {
  const parts = pathParts(req);
  if (parts.length < 3 || parts[0] !== "sessions") return null;
  if (parts.slice(2).join("/") !== suffix) return null;
  return parts[1];
}

function approvalRoute(req) {
  const parts = pathParts(req);
  if (parts.length === 4 && parts[0] === "sessions" && parts[2] === "approvals") {
    return [parts[1], parts[3]];
  }
  return null;
}

function writeSseFrame(res, frame) {
  if (res.writableEnded) return;
  res.write(`data: ${jsonDumps(frame)}\n\n`);
}

async function handle(req, res) {
  try {
    const parts = pathParts(req);
    if (req.method === "GET" && (parts.join("/") === "readyz" || parts.join("/") === "healthz")) {
      writeJson(res, 200, RUNTIME.ready());
      return;
    }

    if (!authOk(req)) {
      writeError(res, ...errorPayload("bad_request", "unauthorized", 401));
      return;
    }

    if (req.method === "GET") {
      const eventsSession = sessionRoute(req, "events");
      if (eventsSession) {
        writeJson(res, 200, RUNTIME.listEvents(eventsSession));
        return;
      }
      const approvalsSession = sessionRoute(req, "approvals");
      if (approvalsSession) {
        const state = RUNTIME.getSession(approvalsSession);
        writeJson(res, 200, {
          protocol_version: PROTOCOL_VERSION,
          approvals: RUNTIME.listApprovals(approvalsSession),
          native: nativeState(state),
        });
        return;
      }
      writeError(res, ...errorPayload("bad_request", "route not found", 404));
      return;
    }

    if (req.method === "POST") {
      const approval = approvalRoute(req);
      if (approval) {
        const body = await readJson(req);
        const [sessionId, approvalId] = approval;
        writeJson(res, 200, RUNTIME.resolveApproval(sessionId, approvalId, body.decision ?? "deny"));
        return;
      }

      const turnSession = sessionRoute(req, "turns");
      if (turnSession) {
        const body = await readJson(req);
        if (body.turn?.stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          await RUNTIME.streamTurn(turnSession, body, (frame) => writeSseFrame(res, frame));
          res.end();
        } else {
          writeJson(res, 200, await RUNTIME.startTurn(turnSession, body));
        }
        return;
      }

      const cancelSession = sessionRoute(req, "cancel");
      if (cancelSession) {
        await readJson(req);
        writeJson(res, 200, await RUNTIME.cancel(cancelSession));
        return;
      }

      const interruptSession = sessionRoute(req, "interrupt");
      if (interruptSession) {
        await readJson(req);
        writeJson(res, 200, await RUNTIME.cancel(interruptSession));
        return;
      }

      const patchSession = sessionRoute(req, "patch");
      if (patchSession) {
        writeJson(res, 200, await RUNTIME.patch(patchSession, await readJson(req)));
        return;
      }

      const compactSession = sessionRoute(req, "compact");
      if (compactSession) {
        await readJson(req);
        writeJson(res, 200, RUNTIME.compact(compactSession));
        return;
      }
    }

    writeError(res, ...errorPayload("bad_request", "route not found", 404));
  } catch (error) {
    if (error instanceof AdapterHttpError) {
      writeError(res, error.status, error.payload);
      return;
    }
    console.error("adapter request failed", error);
    writeError(
      res,
      ...errorPayload(
        "internal_error",
        error instanceof Error ? error.message : String(error),
        500,
      ),
    );
  }
}

function main() {
  configureProcess();
  const port = Number.parseInt(env("OMA_ADAPTER_PORT", env("OPENCLAW_GATEWAY_PORT", "18789")), 10);
  const host = env("OMA_ADAPTER_HOST", "0.0.0.0");
  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  server.listen(port, host, () => {
    console.log(
      `Claude Agent SDK OMA adapter listening on ${host}:${port} protocol=${PROTOCOL_VERSION} sdk=${sdkPackageInfo().version}`,
    );
  });
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
