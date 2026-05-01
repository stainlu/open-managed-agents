#!/usr/bin/env python3
"""Codex adapter server for Open Managed Agents.

This is the in-container boundary for the Codex harness. It speaks
``oma.adapter.v1`` to the TypeScript orchestrator and drives Codex through its
app-server JSON-RPC protocol instead of shelling through the interactive CLI.
"""

from __future__ import annotations

import importlib.metadata
import json
import logging
import os
import queue
import subprocess
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

PROTOCOL_VERSION = "oma.adapter.v1"
HARNESS_ID = "codex"
ADAPTER_VERSION = "0.1.0"


def _env(name: str, default: str = "") -> str:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    return value


def _is_conformance_turn(request: dict[str, Any]) -> bool:
    if _env("OMA_ADAPTER_CONFORMANCE") != "1":
        return False
    agent = request.get("agent") or {}
    turn = request.get("turn") or {}
    model = str(turn.get("model") or agent.get("model") or "").strip()
    return model == "conformance/model"


def _codex_child_env() -> dict[str, str]:
    env = {
        "CODEX_HOME": _env("CODEX_HOME", _env("OMA_CODEX_HOME", "/workspace/.codex")),
    }
    default_keys = [
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_ORG_ID",
        "OPENAI_ORGANIZATION",
        "OPENAI_PROJECT",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
    ]
    extra_keys = []
    for raw in (_env("OMA_CODEX_PASSTHROUGH_ENV"), _env("OPENCLAW_PASSTHROUGH_ENV")):
        extra_keys.extend(k.strip() for k in raw.split(",") if k.strip())
    for key in dict.fromkeys([*default_keys, *extra_keys]):
        value = os.environ.get(key)
        if value:
            env[key] = value
    if "CODEX_API_KEY" not in env and env.get("OPENAI_API_KEY"):
        env["CODEX_API_KEY"] = env["OPENAI_API_KEY"]
    if "OPENAI_API_KEY" not in env and env.get("CODEX_API_KEY"):
        env["OPENAI_API_KEY"] = env["CODEX_API_KEY"]
    return env


def _codex_api_key() -> str:
    return _env("CODEX_API_KEY") or _env("OPENAI_API_KEY")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _event_id(prefix: str = "evt") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:24]}"


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except TypeError:
        return str(value)


def _safe_json(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except TypeError:
        return _stringify(value)


def _enum_value(value: Any) -> str:
    raw = getattr(value, "value", value)
    return str(raw)


def _model_dump(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(by_alias=True, exclude_none=True, mode="json")
    return _safe_json(value)


def _codex_sdk_version() -> str:
    try:
        return importlib.metadata.version("openai-codex-app-server-sdk")
    except Exception:
        return "0.0.0"


def _codex_cli_version() -> str:
    binary = _env("OMA_CODEX_BIN", "codex")
    try:
        out = subprocess.run(
            [binary, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
        )
        return (out.stdout or out.stderr or "").strip() or "unknown"
    except Exception:
        return "unknown"


def _configure_process() -> None:
    state_dir = Path(_env("OMA_STATE_DIR", "/workspace"))
    codex_home = Path(_env("OMA_CODEX_HOME", str(state_dir / ".codex")))
    state_dir.mkdir(parents=True, exist_ok=True)
    codex_home.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("CODEX_HOME", str(codex_home))
    os.environ.setdefault("OMA_CODEX_CWD", str(state_dir))
    os.chdir(str(state_dir))


def _normalize_model(model: str) -> str:
    raw = (model or "").strip()
    if raw.startswith("openai/"):
        return raw.split("/", 1)[1]
    return raw


def _reasoning_effort(level: str | None) -> str | None:
    level = (level or "off").strip().lower()
    if level == "off":
        return "none"
    if level in {"low", "medium", "high", "xhigh"}:
        return level
    return None


def _approval_policy(agent: dict[str, Any]) -> str:
    policy = agent.get("permission_policy") or {}
    if policy.get("type") == "always_ask":
        return "on-request"
    return "never"


def _sandbox(agent: dict[str, Any], environment: dict[str, Any] | None) -> str:
    # The container remains the hard isolation boundary. Codex's native sandbox
    # is additive, so the adapter keeps it in workspace-write by default.
    _ = agent
    _ = environment
    return "workspace-write"


def _native_state(state: "ManagedSession") -> dict[str, Any]:
    return {
        "native_session_id": state.native_thread_id,
        "native_thread_id": state.native_thread_id,
        "native_metadata": {
            "harness": HARNESS_ID,
            "codex_home": os.environ.get("CODEX_HOME", ""),
            "sdk_version": _codex_sdk_version(),
        },
    }


def _usage_payload(usage: dict[str, int] | None, model: str) -> dict[str, Any]:
    usage = usage or {}
    return {
        "tokens_in": int(usage.get("tokens_in") or 0),
        "tokens_out": int(usage.get("tokens_out") or 0),
        "model": model,
    }


def _error_payload(code: str, message: str, status: int, retryable: bool = False) -> tuple[int, dict[str, Any]]:
    return status, {
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
        }
    }


@dataclass
class PendingApproval:
    approval_id: str
    managed_session_id: str
    tool_name: str
    tool_call_id: str | None
    description: str
    arrived_at: int
    condition: threading.Condition = field(default_factory=threading.Condition)
    decision: str | None = None


@dataclass
class ManagedSession:
    managed_session_id: str
    native_thread_id: str | None = None
    thread_loaded: bool = False
    client: Any = None
    active_turn_id: str | None = None
    model: str = ""
    approval_enabled: bool = False
    lock: threading.RLock = field(default_factory=threading.RLock)
    active_thread: threading.Thread | None = None
    active_events: list[dict[str, Any]] = field(default_factory=list)
    event_backlog: list[dict[str, Any]] = field(default_factory=list)
    pending_approvals: dict[str, PendingApproval] = field(default_factory=dict)
    usage: dict[str, int] | None = None


class CodexAdapterRuntime:
    def __init__(self) -> None:
        self.sessions: dict[str, ManagedSession] = {}
        self.thread_to_session: dict[str, str] = {}
        self.lock = threading.RLock()
        self.logger = logging.getLogger("oma.codex")

    def ready(self) -> dict[str, Any]:
        return {
            "protocol_version": PROTOCOL_VERSION,
            "harness_id": HARNESS_ID,
            "adapter_version": ADAPTER_VERSION,
            "harness_version": _codex_cli_version(),
            "capabilities": {
                "streaming": True,
                "cancel": True,
                "interrupt": True,
                "tool_approvals": True,
                "mcp": False,
                "dynamic_model_patch": True,
                "compaction": True,
                "native_session_resume": True,
                "usage": True,
                "subagents": False,
            },
        }

    def get_session(self, session_id: str, request: dict[str, Any] | None = None) -> ManagedSession:
        with self.lock:
            current = self.sessions.get(session_id)
            if current is not None:
                return current
            native_thread_id = None
            if request:
                native_thread_id = request.get("session", {}).get("native_thread_id")
            state = ManagedSession(
                managed_session_id=session_id,
                native_thread_id=native_thread_id,
            )
            self.sessions[session_id] = state
            if native_thread_id:
                self.thread_to_session[native_thread_id] = session_id
            return state

    def _ensure_client(self, state: ManagedSession) -> Any:
        if state.client is not None:
            return state.client
        from codex_app_server.client import AppServerClient, AppServerConfig

        codex_bin = _env("OMA_CODEX_BIN", "/usr/local/bin/codex")
        config = AppServerConfig(
            codex_bin=codex_bin,
            cwd=_env("OMA_CODEX_CWD", _env("OMA_STATE_DIR", "/workspace")),
            env=_codex_child_env(),
            client_name="open_managed_agents_codex_adapter",
            client_title="Open Managed Agents Codex Adapter",
            client_version=ADAPTER_VERSION,
            experimental_api=True,
        )
        client = AppServerClient(
            config=config,
            approval_handler=lambda method, params: self._approval_handler(state, method, params),
        )
        client.start()
        client.initialize()
        self._login_with_api_key_if_present(client)
        state.client = client
        return client

    def _login_with_api_key_if_present(self, client: Any) -> None:
        api_key = _codex_api_key()
        if not api_key:
            return
        # Production `codex app-server` intentionally does not honor API-key env
        # auth directly. Login through the app-server account protocol so the
        # native OpenAI transport has a real auth snapshot before the first turn.
        result = client._request_raw(
            "account/login/start",
            {"type": "apiKey", "apiKey": api_key},
        )
        if not isinstance(result, dict) or result.get("type") != "apiKey":
            raise RuntimeError("Codex app-server rejected API-key login")

    def _thread_params(self, request: dict[str, Any]) -> dict[str, Any]:
        agent = request["agent"]
        environment = request.get("environment") or {}
        turn = request["turn"]
        model = _normalize_model(str(turn.get("model") or agent.get("model") or "").strip())
        if not model:
            raise ValueError("agent.model is required")
        return {
            "cwd": _env("OMA_CODEX_CWD", _env("OMA_STATE_DIR", "/workspace")),
            "model": model,
            "developerInstructions": agent.get("instructions") or None,
            "approvalPolicy": _approval_policy(agent),
            "sandbox": _sandbox(agent, environment),
            "ephemeral": False,
            "serviceName": "open-managed-agents",
        }

    def _turn_params(self, request: dict[str, Any], state: ManagedSession) -> dict[str, Any]:
        agent = request["agent"]
        turn = request["turn"]
        model = _normalize_model(str(turn.get("model") or state.model or agent.get("model") or "").strip())
        thinking = _reasoning_effort(turn.get("thinking_level") or agent.get("thinking_level"))
        params: dict[str, Any] = {
            "cwd": _env("OMA_CODEX_CWD", _env("OMA_STATE_DIR", "/workspace")),
            "model": model,
            "approvalPolicy": _approval_policy(agent),
        }
        if thinking:
            params["effort"] = thinking
        return params

    def _ensure_thread(self, state: ManagedSession, request: dict[str, Any]) -> str:
        client = self._ensure_client(state)
        params = self._thread_params(request)
        state.model = str(params["model"])
        state.approval_enabled = request["agent"].get("permission_policy", {}).get("type") == "always_ask"

        if state.native_thread_id:
            if not state.thread_loaded:
                client.thread_resume(state.native_thread_id, params)
                state.thread_loaded = True
            self.thread_to_session[state.native_thread_id] = state.managed_session_id
            return state.native_thread_id

        started = client.thread_start(params)
        thread_id = started.thread.id
        state.native_thread_id = thread_id
        state.thread_loaded = True
        self.thread_to_session[thread_id] = state.managed_session_id
        return thread_id

    def _append_event(
        self,
        state: ManagedSession,
        event_type: str,
        content: str,
        **fields: Any,
    ) -> dict[str, Any]:
        event = {
            "event_id": _event_id(),
            "session_id": state.managed_session_id,
            "type": event_type,
            "content": content,
            "created_at": _now_ms(),
        }
        for key, value in fields.items():
            if value is not None:
                event[key] = _safe_json(value)
        state.active_events.append(event)
        state.event_backlog.append(event)
        return event

    def _approval_handler(self, state: ManagedSession, method: str, params: dict[str, Any] | None) -> dict[str, Any]:
        params = params or {}
        if method not in {
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
        }:
            if method == "mcpServer/elicitation/request":
                return {"action": "decline", "content": None}
            if method == "item/permissions/requestApproval":
                return {"decision": "decline"}
            return {}

        if not state.approval_enabled:
            return {"decision": "accept"}

        approval_id = str(params.get("approvalId") or params.get("itemId") or _event_id("appr"))
        item_id = str(params.get("itemId") or approval_id)
        is_command = method == "item/commandExecution/requestApproval"
        command = params.get("command")
        cwd = params.get("cwd")
        tool_name = "shell" if is_command else "file_change"
        description = str(
            command
            or params.get("reason")
            or ("approve file changes" if not is_command else "approve command")
        )

        pending = PendingApproval(
            approval_id=approval_id,
            managed_session_id=state.managed_session_id,
            tool_name=tool_name,
            tool_call_id=item_id,
            description=description,
            arrived_at=_now_ms(),
        )
        with state.lock:
            state.pending_approvals[approval_id] = pending
            self._append_event(
                state,
                "agent.tool_confirmation_request",
                description,
                approval_id=approval_id,
                tool_name=tool_name,
                tool_call_id=item_id,
                tool_arguments={
                    "method": method,
                    "command": command,
                    "cwd": cwd,
                    "params": params,
                },
            )

        deadline = time.time() + int(_env("OMA_CODEX_APPROVAL_TIMEOUT_SECONDS", "300"))
        with pending.condition:
            while pending.decision is None:
                remaining = deadline - time.time()
                if remaining <= 0:
                    break
                pending.condition.wait(timeout=min(1.0, remaining))

        with state.lock:
            state.pending_approvals.pop(approval_id, None)
        if pending.decision == "allow":
            return {"decision": "accept"}
        return {"decision": "decline"}

    def list_approvals(self, session_id: str) -> list[dict[str, Any]]:
        state = self.get_session(session_id)
        with state.lock:
            return [
                {
                    "approval_id": p.approval_id,
                    "managed_session_id": p.managed_session_id,
                    "tool_name": p.tool_name,
                    "tool_call_id": p.tool_call_id,
                    "description": p.description,
                    "arrived_at": p.arrived_at,
                }
                for p in state.pending_approvals.values()
            ]

    def resolve_approval(self, session_id: str, approval_id: str, decision: str) -> dict[str, Any]:
        state = self.get_session(session_id)
        with state.lock:
            pending = state.pending_approvals.get(approval_id)
        if pending is None:
            status, payload = _error_payload(
                "tool_approval_not_found",
                f"approval {approval_id} does not exist",
                HTTPStatus.NOT_FOUND,
            )
            raise AdapterHttpError(status, payload)
        with pending.condition:
            pending.decision = "allow" if decision == "allow" else "deny"
            pending.condition.notify_all()
        return {
            "protocol_version": PROTOCOL_VERSION,
            "accepted": True,
            "native": _native_state(state),
        }

    def start_turn(self, session_id: str, request: dict[str, Any]) -> dict[str, Any]:
        state = self.get_session(session_id, request)
        with state.lock:
            if state.active_thread and state.active_thread.is_alive():
                status, payload = _error_payload(
                    "turn_failed",
                    "session already has an active turn",
                    HTTPStatus.CONFLICT,
                    retryable=True,
                )
                raise AdapterHttpError(status, payload)
            state.active_events = []
            state.usage = None
            self._append_event(state, "user.message", request["turn"]["content"])

        output = self._run_turn(state, request)
        return self._result_payload(state, output)

    def stream_turn(self, session_id: str, request: dict[str, Any]) -> queue.Queue:
        state = self.get_session(session_id, request)
        out: queue.Queue = queue.Queue()

        with state.lock:
            if state.active_thread and state.active_thread.is_alive():
                status, payload = _error_payload(
                    "turn_failed",
                    "session already has an active turn",
                    HTTPStatus.CONFLICT,
                    retryable=True,
                )
                raise AdapterHttpError(status, payload)
            state.active_events = []
            state.usage = None
            event = self._append_event(state, "user.message", request["turn"]["content"])
            out.put({"type": "event", "event": event})

        def runner() -> None:
            try:
                output = self._run_turn(state, request, out)
                out.put({"type": "turn.completed", "result": self._result_payload(state, output)})
            except Exception as exc:
                self.logger.error("stream turn failed: %s", exc, exc_info=True)
                out.put({"type": "state", "state": "error", "error_message": str(exc)})
            finally:
                out.put(None)

        thread = threading.Thread(target=runner, name=f"oma-codex-{session_id}", daemon=True)
        state.active_thread = thread
        thread.start()
        return out

    def _run_turn(
        self,
        state: ManagedSession,
        request: dict[str, Any],
        stream_queue: queue.Queue | None = None,
    ) -> str:
        if _is_conformance_turn(request):
            return self._run_conformance_turn(state, request, stream_queue)

        client = self._ensure_client(state)
        thread_id = self._ensure_thread(state, request)
        turn_params = self._turn_params(request, state)
        turn_content = request["turn"]["content"]
        started = client.turn_start(thread_id, turn_content, params=turn_params)
        turn_id = started.turn.id
        state.active_turn_id = turn_id
        output = ""
        completed = False

        def emit_event(event: dict[str, Any]) -> None:
            if stream_queue is not None:
                stream_queue.put({"type": "event", "event": event})

        try:
            client.acquire_turn_consumer(turn_id)
            while True:
                notification = client.next_notification()
                payload = notification.payload
                method = notification.method
                payload_turn_id = getattr(payload, "turn_id", None)
                if payload_turn_id is not None and payload_turn_id != turn_id:
                    continue

                if method == "item/agentMessage/delta":
                    delta = str(getattr(payload, "delta", ""))
                    if delta and stream_queue is not None:
                        stream_queue.put({"type": "delta", "content": delta})
                    continue

                if method in {
                    "item/reasoning/textDelta",
                    "item/reasoning/summaryTextDelta",
                }:
                    delta = str(getattr(payload, "delta", ""))
                    if delta:
                        with state.lock:
                            event = self._append_event(state, "agent.thinking", delta)
                        emit_event(event)
                    continue

                if method == "thread/tokenUsage/updated":
                    usage = getattr(payload, "token_usage", None)
                    if usage is not None:
                        state.usage = self._usage_from_codex_usage(usage)
                    continue

                if method == "item/started":
                    event = self._event_from_item(state, getattr(payload, "item", None), started=True)
                    if event:
                        emit_event(event)
                    continue

                if method == "item/completed":
                    event = self._event_from_item(state, getattr(payload, "item", None), started=False)
                    if event:
                        emit_event(event)
                        if event["type"] == "agent.message":
                            output = event["content"]
                    continue

                if method == "turn/completed":
                    turn = getattr(payload, "turn", None)
                    status = _enum_value(getattr(turn, "status", "completed"))
                    if status == "failed":
                        error = getattr(turn, "error", None)
                        message = getattr(error, "message", None) or "Codex turn failed"
                        raise RuntimeError(str(message))
                    completed = True
                    break

            if not completed:
                raise RuntimeError("turn completed event not received")
            self._attach_usage_to_latest_message(state)
            return output
        finally:
            client.release_turn_consumer(turn_id)
            state.active_turn_id = None

    def _run_conformance_turn(
        self,
        state: ManagedSession,
        request: dict[str, Any],
        stream_queue: queue.Queue | None,
    ) -> str:
        output = _stringify(request["turn"]["content"])
        state.model = "conformance/model"
        state.usage = {"tokens_in": 1, "tokens_out": 1}
        if stream_queue is not None:
            stream_queue.put({"type": "delta", "content": output})
        with state.lock:
            event = self._append_event(
                state,
                "agent.message",
                output,
                tokens_in=1,
                tokens_out=1,
                model=state.model,
            )
        if stream_queue is not None:
            stream_queue.put({"type": "event", "event": event})
        return output

    def _usage_from_codex_usage(self, usage: Any) -> dict[str, int]:
        last = getattr(usage, "last", None)
        if last is None:
            return {"tokens_in": 0, "tokens_out": 0}
        return {
            "tokens_in": int(getattr(last, "input_tokens", 0) or 0),
            "tokens_out": int(getattr(last, "output_tokens", 0) or 0),
        }

    def _attach_usage_to_latest_message(self, state: ManagedSession) -> None:
        if not state.usage:
            return
        with state.lock:
            for event in reversed(state.active_events):
                if event["type"] == "agent.message":
                    event["tokens_in"] = state.usage["tokens_in"]
                    event["tokens_out"] = state.usage["tokens_out"]
                    event["model"] = state.model
                    break

    def _event_from_item(
        self,
        state: ManagedSession,
        item: Any,
        *,
        started: bool,
    ) -> dict[str, Any] | None:
        if item is None:
            return None
        root = getattr(item, "root", item)
        item_type = _enum_value(getattr(root, "type", ""))

        with state.lock:
            if item_type == "agentMessage" and not started:
                phase = _enum_value(getattr(root, "phase", ""))
                text = str(getattr(root, "text", ""))
                if phase not in {"final_answer", "None", ""}:
                    return None
                if not text:
                    return None
                return self._append_event(
                    state,
                    "agent.message",
                    text,
                    model=state.model,
                )

            if item_type == "reasoning" and not started:
                content = getattr(root, "content", None) or getattr(root, "summary", None) or []
                text = "\n".join(str(v) for v in content if str(v))
                if not text:
                    return None
                return self._append_event(state, "agent.thinking", text)

            if item_type == "commandExecution":
                command = str(getattr(root, "command", ""))
                tool_call_id = str(getattr(root, "id", _event_id("tool")))
                args = {
                    "command": command,
                    "cwd": str(getattr(root, "cwd", "")),
                    "status": _enum_value(getattr(root, "status", "")),
                }
                if started:
                    return self._append_event(
                        state,
                        "agent.tool_use",
                        command,
                        tool_name="shell",
                        tool_call_id=tool_call_id,
                        tool_arguments=args,
                    )
                output = str(getattr(root, "aggregated_output", "") or "")
                exit_code = getattr(root, "exit_code", None)
                return self._append_event(
                    state,
                    "agent.tool_result",
                    output,
                    tool_name="shell",
                    tool_call_id=tool_call_id,
                    tool_arguments={**args, "exit_code": exit_code},
                    is_error=exit_code not in {None, 0},
                )

            if item_type == "fileChange":
                tool_call_id = str(getattr(root, "id", _event_id("file")))
                details = _model_dump(root)
                return self._append_event(
                    state,
                    "agent.tool_result" if not started else "agent.tool_use",
                    _stringify(details),
                    tool_name="file_change",
                    tool_call_id=tool_call_id,
                    tool_arguments={"item": details},
                )

            if item_type == "mcpToolCall":
                tool_call_id = str(getattr(root, "id", _event_id("mcp")))
                tool_name = str(getattr(root, "tool", "mcp"))
                details = _model_dump(root)
                return self._append_event(
                    state,
                    "agent.tool_result" if not started else "agent.tool_use",
                    _stringify(details),
                    tool_name=tool_name,
                    tool_call_id=tool_call_id,
                    tool_arguments={"item": details},
                    is_error=_enum_value(getattr(root, "status", "")) == "failed",
                )

        return None

    def _result_payload(self, state: ManagedSession, output: str) -> dict[str, Any]:
        return {
            "protocol_version": PROTOCOL_VERSION,
            "output": output,
            "usage": _usage_payload(state.usage, state.model),
            "native": _native_state(state),
            "events": list(state.active_events),
        }

    def cancel(self, session_id: str) -> dict[str, Any]:
        state = self.get_session(session_id)
        if state.client is not None and state.native_thread_id and state.active_turn_id:
            state.client.turn_interrupt(state.native_thread_id, state.active_turn_id)
        with state.lock:
            for pending in state.pending_approvals.values():
                with pending.condition:
                    pending.decision = "deny"
                    pending.condition.notify_all()
        return {
            "protocol_version": PROTOCOL_VERSION,
            "accepted": True,
            "native": _native_state(state),
        }

    def patch(self, session_id: str, request: dict[str, Any]) -> dict[str, Any]:
        state = self.get_session(session_id)
        with state.lock:
            if request.get("model"):
                state.model = _normalize_model(str(request["model"]))
            if request.get("thinking_level"):
                self._append_event(
                    state,
                    "session.thinking_level_change",
                    str(request["thinking_level"]),
                )
        return {
            "protocol_version": PROTOCOL_VERSION,
            "accepted": True,
            "native": _native_state(state),
        }

    def compact(self, session_id: str) -> dict[str, Any]:
        state = self.get_session(session_id)
        if state.client is None or not state.native_thread_id:
            status, payload = _error_payload(
                "native_session_not_found",
                "Codex thread has not been created yet",
                HTTPStatus.NOT_FOUND,
            )
            raise AdapterHttpError(status, payload)
        state.client.thread_compact(state.native_thread_id)
        with state.lock:
            self._append_event(state, "session.compaction", "Codex app-server compaction requested")
        return {
            "protocol_version": PROTOCOL_VERSION,
            "accepted": True,
            "native": _native_state(state),
        }

    def list_events(self, session_id: str) -> dict[str, Any]:
        state = self.get_session(session_id)
        with state.lock:
            events = list(state.event_backlog)
        return {
            "protocol_version": PROTOCOL_VERSION,
            "events": events,
            "native": _native_state(state),
        }


class AdapterHttpError(Exception):
    def __init__(self, status: int, payload: dict[str, Any]) -> None:
        super().__init__(payload.get("error", {}).get("message", "adapter error"))
        self.status = status
        self.payload = payload


RUNTIME = CodexAdapterRuntime()


class Handler(BaseHTTPRequestHandler):
    server_version = "oma-codex-adapter/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        logging.getLogger("oma.codex.http").info(fmt, *args)

    def _auth_ok(self) -> bool:
        token = _env("OPENCLAW_GATEWAY_TOKEN")
        if not token:
            return True
        auth = self.headers.get("Authorization", "")
        return auth == f"Bearer {token}"

    def _read_json(self) -> dict[str, Any]:
        raw_len = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(raw_len) if raw_len > 0 else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise AdapterHttpError(*_error_payload("bad_request", f"invalid JSON: {exc}", HTTPStatus.BAD_REQUEST))
        if not isinstance(data, dict):
            raise AdapterHttpError(*_error_payload("bad_request", "JSON body must be an object", HTTPStatus.BAD_REQUEST))
        if data.get("protocol_version") != PROTOCOL_VERSION:
            raise AdapterHttpError(
                *_error_payload("bad_request", "protocol_version must be oma.adapter.v1", HTTPStatus.BAD_REQUEST)
            )
        return data

    def _write_json(self, status: int, payload: dict[str, Any]) -> None:
        body = _json_dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _write_error(self, status: int, payload: dict[str, Any]) -> None:
        self._write_json(status, payload)

    def _session_id_from_path(self, suffix: str) -> str | None:
        path = urlparse(self.path).path
        parts = [p for p in path.split("/") if p]
        if len(parts) < 3 or parts[0] != "sessions":
            return None
        if "/".join(parts[2:]) != suffix:
            return None
        return parts[1]

    def _approval_ids_from_path(self) -> tuple[str, str] | None:
        path = urlparse(self.path).path
        parts = [p for p in path.split("/") if p]
        if len(parts) == 4 and parts[0] == "sessions" and parts[2] == "approvals":
            return parts[1], parts[3]
        return None

    def do_GET(self) -> None:
        try:
            path = urlparse(self.path).path
            if path in {"/healthz", "/readyz"}:
                self._write_json(HTTPStatus.OK, RUNTIME.ready())
                return
            if not self._auth_ok():
                self._write_error(*_error_payload("bad_request", "unauthorized", HTTPStatus.UNAUTHORIZED))
                return
            session_id = self._session_id_from_path("events")
            if session_id:
                self._write_json(HTTPStatus.OK, RUNTIME.list_events(session_id))
                return
            session_id = self._session_id_from_path("approvals")
            if session_id:
                state = RUNTIME.get_session(session_id)
                self._write_json(
                    HTTPStatus.OK,
                    {
                        "protocol_version": PROTOCOL_VERSION,
                        "approvals": RUNTIME.list_approvals(session_id),
                        "native": _native_state(state),
                    },
                )
                return
            self._write_error(*_error_payload("bad_request", "route not found", HTTPStatus.NOT_FOUND))
        except AdapterHttpError as exc:
            self._write_error(exc.status, exc.payload)
        except Exception as exc:
            logging.getLogger("oma.codex").error("GET failed: %s", exc, exc_info=True)
            self._write_error(*_error_payload("internal_error", str(exc), HTTPStatus.INTERNAL_SERVER_ERROR))

    def do_POST(self) -> None:
        try:
            if not self._auth_ok():
                self._write_error(*_error_payload("bad_request", "unauthorized", HTTPStatus.UNAUTHORIZED))
                return

            approval_path = self._approval_ids_from_path()
            if approval_path:
                request = self._read_json()
                session_id, approval_id = approval_path
                self._write_json(
                    HTTPStatus.OK,
                    RUNTIME.resolve_approval(session_id, approval_id, request.get("decision", "deny")),
                )
                return

            session_id = self._session_id_from_path("turns")
            if session_id:
                request = self._read_json()
                if request.get("turn", {}).get("stream"):
                    self._write_sse(RUNTIME.stream_turn(session_id, request))
                else:
                    self._write_json(HTTPStatus.OK, RUNTIME.start_turn(session_id, request))
                return

            session_id = self._session_id_from_path("cancel")
            if session_id:
                self._read_json()
                self._write_json(HTTPStatus.OK, RUNTIME.cancel(session_id))
                return

            session_id = self._session_id_from_path("interrupt")
            if session_id:
                self._read_json()
                self._write_json(HTTPStatus.OK, RUNTIME.cancel(session_id))
                return

            session_id = self._session_id_from_path("patch")
            if session_id:
                self._write_json(HTTPStatus.OK, RUNTIME.patch(session_id, self._read_json()))
                return

            session_id = self._session_id_from_path("compact")
            if session_id:
                self._read_json()
                self._write_json(HTTPStatus.OK, RUNTIME.compact(session_id))
                return

            self._write_error(*_error_payload("bad_request", "route not found", HTTPStatus.NOT_FOUND))
        except AdapterHttpError as exc:
            self._write_error(exc.status, exc.payload)
        except Exception as exc:
            logging.getLogger("oma.codex").error("POST failed: %s", exc, exc_info=True)
            traceback.print_exc()
            self._write_error(*_error_payload("internal_error", str(exc), HTTPStatus.INTERNAL_SERVER_ERROR))

    def _write_sse(self, frames: queue.Queue) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        while True:
            frame = frames.get()
            if frame is None:
                break
            payload = f"data: {_json_dumps(frame)}\n\n".encode("utf-8")
            self.wfile.write(payload)
            self.wfile.flush()


def main() -> None:
    _configure_process()
    logging.basicConfig(
        level=os.getenv("OMA_CODEX_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    port = int(_env("OMA_ADAPTER_PORT", _env("OPENCLAW_GATEWAY_PORT", "18789")))
    host = _env("OMA_ADAPTER_HOST", "0.0.0.0")
    server = ThreadingHTTPServer((host, port), Handler)
    logging.getLogger("oma.codex").info(
        "Codex OMA adapter listening on %s:%s protocol=%s codex=%s sdk=%s",
        host,
        port,
        PROTOCOL_VERSION,
        _codex_cli_version(),
        _codex_sdk_version(),
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
