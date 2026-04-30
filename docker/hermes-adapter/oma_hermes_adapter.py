#!/usr/bin/env python3
"""Hermes adapter server for Open Managed Agents.

This is the in-container boundary for the Hermes harness. It speaks
``oma.adapter.v1`` to the TypeScript orchestrator and imports Hermes internals
directly instead of driving the CLI, ACP stdio process, or OpenAI-compatible
API server.
"""

from __future__ import annotations

import importlib.metadata
import json
import logging
import os
import queue
import sys
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
HARNESS_ID = "hermes"
ADAPTER_VERSION = "0.1.0"


def _env(name: str, default: str = "") -> str:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    return value


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


def _hermes_version() -> str:
    try:
        return importlib.metadata.version("hermes-agent")
    except Exception:
        return "0.0.0"


def _configure_process() -> None:
    state_dir = Path(_env("OMA_STATE_DIR", "/workspace"))
    hermes_home = Path(_env("HERMES_HOME", str(state_dir / ".hermes")))
    hermes_home.mkdir(parents=True, exist_ok=True)
    state_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HERMES_HOME", str(hermes_home))
    os.environ.setdefault("TERMINAL_CWD", str(state_dir))
    os.environ.setdefault("TERMINAL_ENV", "local")
    os.environ.setdefault("HERMES_SESSION_SOURCE", "oma")
    os.chdir(str(state_dir))


def _thinking_config(level: str | None) -> dict[str, Any] | None:
    level = (level or "off").strip().lower()
    if level == "off":
        return {"enabled": False}
    if level == "low":
        return {"enabled": True, "effort": "low"}
    if level == "medium":
        return {"enabled": True, "effort": "medium"}
    if level in {"high", "xhigh"}:
        return {"enabled": True, "effort": "high"}
    return None


def _toolsets_for_agent(agent: dict[str, Any]) -> list[str]:
    raw_tools = [str(v).strip() for v in agent.get("tools") or [] if str(v).strip()]
    if not raw_tools:
        return ["hermes-api-server"]
    toolsets: list[str] = []
    for name in raw_tools:
        mapped = _toolset_name(name)
        if mapped not in toolsets:
            toolsets.append(mapped)
    return toolsets or ["hermes-api-server"]


def _toolset_name(name: str) -> str:
    aliases = {
        "shell": "terminal",
        "bash": "terminal",
        "terminal": "terminal",
        "file": "file",
        "files": "file",
        "filesystem": "file",
        "web": "web",
        "web_search": "search",
        "browser": "browser",
        "vision": "vision",
        "image": "image_gen",
        "image_gen": "image_gen",
        "skills": "skills",
        "todo": "todo",
        "memory": "memory",
        "code": "code_execution",
        "execute_code": "code_execution",
        "delegation": "delegation",
    }
    return aliases.get(name, name)


def _disabled_toolsets_for_agent(agent: dict[str, Any]) -> list[str]:
    policy = agent.get("permission_policy") or {}
    if policy.get("type") != "deny":
        return []
    disabled: list[str] = []
    for name in policy.get("tools") or []:
        mapped = _toolset_name(str(name).strip())
        if mapped and mapped not in disabled:
            disabled.append(mapped)
    return disabled


def _provider_from_model(model: str) -> str | None:
    explicit = _env("OMA_HERMES_PROVIDER") or _env("HERMES_PROVIDER")
    if explicit:
        return explicit
    raw = (model or "").strip()
    if ":" in raw:
        maybe_provider, _rest = raw.split(":", 1)
        if maybe_provider:
            return maybe_provider
    if "/" not in raw:
        return None
    prefix = raw.split("/", 1)[0].strip().lower()
    direct = {
        "anthropic": "anthropic",
        "deepseek": "deepseek",
        "google": "gemini",
        "gemini": "gemini",
        "z-ai": "zai",
        "zai": "zai",
        "x-ai": "xai",
        "xai": "xai",
        "moonshot": "kimi-coding",
        "moonshotai": "kimi-coding",
        "qwen": "alibaba",
        "alibaba": "alibaba",
        "minimax": "minimax",
        "nvidia": "nvidia",
        "arcee-ai": "arcee",
        "arcee": "arcee",
        "huggingface": "huggingface",
        "mistral": "openrouter",
        "meta-llama": "openrouter",
        "openai": "openrouter",
    }.get(prefix)
    if direct:
        return direct
    return None


def _resolve_runtime(model: str) -> tuple[str, dict[str, Any]]:
    from hermes_cli.model_normalize import normalize_model_for_provider
    from hermes_cli.runtime_provider import resolve_runtime_provider

    provider_request = _provider_from_model(model)
    runtime = resolve_runtime_provider(
        requested=provider_request,
        target_model=model,
    )
    provider = runtime.get("provider") or provider_request or "openrouter"
    normalized = normalize_model_for_provider(model, provider)
    return normalized, runtime


def _native_state(session_id: str, state: "ManagedSession") -> dict[str, Any]:
    meta: dict[str, Any] = {
        "harness": HARNESS_ID,
        "provider": state.provider,
        "api_mode": state.api_mode,
    }
    return {
        "native_session_id": state.native_session_id,
        "native_thread_id": None,
        "native_metadata": meta,
    }


def _usage_from_result(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "tokens_in": int(result.get("input_tokens") or result.get("prompt_tokens") or 0),
        "tokens_out": int(result.get("output_tokens") or result.get("completion_tokens") or 0),
        "cost_usd": float(result.get("estimated_cost_usd") or 0.0),
        "model": str(result.get("model") or ""),
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
    command: str
    condition: threading.Condition = field(default_factory=threading.Condition)
    decision: str | None = None


@dataclass
class ManagedSession:
    managed_session_id: str
    native_session_id: str
    history: list[dict[str, Any]] = field(default_factory=list)
    agent: Any = None
    requested_model: str = ""
    model: str = ""
    provider: str = ""
    api_mode: str = ""
    db: Any = None
    lock: threading.RLock = field(default_factory=threading.RLock)
    active_thread: threading.Thread | None = None
    active_events: list[dict[str, Any]] = field(default_factory=list)
    event_backlog: list[dict[str, Any]] = field(default_factory=list)
    pending_approvals: dict[str, PendingApproval] = field(default_factory=dict)


class HermesAdapterRuntime:
    def __init__(self) -> None:
        self.sessions: dict[str, ManagedSession] = {}
        self.lock = threading.RLock()
        self.logger = logging.getLogger("oma.hermes")
        self._db = None

    def ready(self) -> dict[str, Any]:
        return {
            "protocol_version": PROTOCOL_VERSION,
            "harness_id": HARNESS_ID,
            "adapter_version": ADAPTER_VERSION,
            "harness_version": _hermes_version(),
            "capabilities": {
                "streaming": True,
                "cancel": True,
                "interrupt": True,
                "tool_approvals": True,
                "mcp": False,
                "dynamic_model_patch": True,
                "compaction": False,
                "native_session_resume": True,
                "usage": True,
                "subagents": False,
            },
        }

    def _session_db(self) -> Any:
        if self._db is not None:
            return self._db
        from hermes_state import SessionDB

        home = Path(os.environ["HERMES_HOME"])
        self._db = SessionDB(db_path=home / "state.db")
        return self._db

    def get_session(self, session_id: str, request: dict[str, Any] | None = None) -> ManagedSession:
        with self.lock:
            current = self.sessions.get(session_id)
            if current is not None:
                return current

            native = session_id
            if request:
                native = (
                    request.get("session", {}).get("native_session_id")
                    or request.get("session", {}).get("managed_session_id")
                    or session_id
                )
            db = self._session_db()
            history: list[dict[str, Any]] = []
            try:
                row = db.get_session(native)
                if row is not None:
                    history = db.get_messages_as_conversation(native)
            except Exception:
                self.logger.debug("could not restore Hermes session %s", native, exc_info=True)

            state = ManagedSession(
                managed_session_id=session_id,
                native_session_id=native,
                history=history,
                db=db,
            )
            self.sessions[session_id] = state
            return state

    def _make_agent(self, state: ManagedSession, request: dict[str, Any]) -> Any:
        from run_agent import AIAgent

        agent_spec = request["agent"]
        turn = request["turn"]
        requested_model = str(turn.get("model") or agent_spec.get("model") or "").strip()
        if not requested_model:
            raise ValueError("agent.model is required")
        model, runtime = _resolve_runtime(requested_model)
        state.requested_model = requested_model
        state.model = model
        state.provider = str(runtime.get("provider") or "")
        state.api_mode = str(runtime.get("api_mode") or "")

        kwargs = {
            "platform": "oma",
            "enabled_toolsets": _toolsets_for_agent(agent_spec),
            "disabled_toolsets": _disabled_toolsets_for_agent(agent_spec),
            "quiet_mode": True,
            "session_id": state.native_session_id,
            "model": model,
            "provider": runtime.get("provider"),
            "api_mode": runtime.get("api_mode"),
            "base_url": runtime.get("base_url"),
            "api_key": runtime.get("api_key"),
            "command": runtime.get("command"),
            "args": list(runtime.get("args") or []),
            "session_db": state.db,
            "reasoning_config": _thinking_config(turn.get("thinking_level") or agent_spec.get("thinking_level")),
            "skip_context_files": False,
            "skip_memory": False,
        }
        created = AIAgent(**kwargs)
        def _stderr_print(*args: Any, **kwargs: Any) -> None:
            kwargs = dict(kwargs)
            kwargs["file"] = sys.stderr
            print(*args, **kwargs)

        created._print_fn = _stderr_print
        return created

    def _ensure_agent(self, state: ManagedSession, request: dict[str, Any]) -> Any:
        requested_model = str(request["turn"].get("model") or request["agent"].get("model") or "")
        thinking = request["turn"].get("thinking_level") or request["agent"].get("thinking_level")
        if state.agent is None:
            state.agent = self._make_agent(state, request)
            return state.agent
        if requested_model and requested_model != state.requested_model:
            state.agent = self._make_agent(state, request)
            return state.agent
        if thinking:
            state.agent.reasoning_config = _thinking_config(thinking)
        return state.agent

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

    def _approval_callback(self, state: ManagedSession):
        def approve(command: str, description: str, *, allow_permanent: bool = True) -> str:
            approval_id = _event_id("appr")
            pending = PendingApproval(
                approval_id=approval_id,
                managed_session_id=state.managed_session_id,
                tool_name="terminal",
                tool_call_id=None,
                description=description,
                arrived_at=_now_ms(),
                command=command,
            )
            with state.lock:
                state.pending_approvals[approval_id] = pending
                self._append_event(
                    state,
                    "agent.tool_confirmation_request",
                    description,
                    approval_id=approval_id,
                    tool_name="terminal",
                    tool_arguments={"command": command, "allow_permanent": allow_permanent},
                )

            deadline = time.time() + int(_env("OMA_HERMES_APPROVAL_TIMEOUT_SECONDS", "300"))
            with pending.condition:
                while pending.decision is None:
                    remaining = deadline - time.time()
                    if remaining <= 0:
                        break
                    pending.condition.wait(timeout=min(1.0, remaining))

            with state.lock:
                state.pending_approvals.pop(approval_id, None)
            if pending.decision == "allow":
                return "once"
            return "deny"

        return approve

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
            "native": _native_state(session_id, state),
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
            self._append_event(state, "user.message", request["turn"]["content"])

        result = self._run_turn(state, request)
        return self._result_payload(session_id, state, result)

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
            event = self._append_event(state, "user.message", request["turn"]["content"])
            out.put({"type": "event", "event": event})

        def runner() -> None:
            try:
                result = self._run_turn(state, request, out)
                out.put({"type": "turn.completed", "result": self._result_payload(session_id, state, result)})
            except Exception as exc:
                self.logger.error("stream turn failed: %s", exc, exc_info=True)
                out.put({"type": "state", "state": "error", "error_message": str(exc)})
            finally:
                out.put(None)

        thread = threading.Thread(target=runner, name=f"oma-hermes-{session_id}", daemon=True)
        state.active_thread = thread
        thread.start()
        return out

    def _run_turn(
        self,
        state: ManagedSession,
        request: dict[str, Any],
        stream_queue: queue.Queue | None = None,
    ) -> dict[str, Any]:
        agent = self._ensure_agent(state, request)
        turn = request["turn"]
        agent_spec = request["agent"]

        def emit_event(event: dict[str, Any]) -> None:
            if stream_queue is not None:
                stream_queue.put({"type": "event", "event": event})

        def stream_delta(text: str | None) -> None:
            if not text:
                return
            if stream_queue is not None:
                stream_queue.put({"type": "delta", "content": text})

        def reasoning_delta(text: str | None) -> None:
            if not text:
                return
            with state.lock:
                event = self._append_event(state, "agent.thinking", text)
            emit_event(event)

        def tool_start(tool_call_id: str, name: str, args: Any) -> None:
            with state.lock:
                event = self._append_event(
                    state,
                    "agent.tool_use",
                    _stringify(args),
                    tool_name=name,
                    tool_call_id=tool_call_id,
                    tool_arguments=args if isinstance(args, dict) else {"raw": _stringify(args)},
                )
            emit_event(event)

        def tool_complete(tool_call_id: str, name: str, args: Any, result: Any) -> None:
            with state.lock:
                event = self._append_event(
                    state,
                    "agent.tool_result",
                    _stringify(result),
                    tool_name=name,
                    tool_call_id=tool_call_id,
                    tool_arguments=args if isinstance(args, dict) else {"raw": _stringify(args)},
                )
            emit_event(event)

        agent.stream_delta_callback = stream_delta
        agent.reasoning_callback = reasoning_delta
        agent.tool_start_callback = tool_start
        agent.tool_complete_callback = tool_complete

        previous_interactive = os.environ.get("HERMES_INTERACTIVE")
        previous_exec_ask = os.environ.get("HERMES_EXEC_ASK")
        previous_callback = None
        approval_enabled = agent_spec.get("permission_policy", {}).get("type") == "always_ask"

        try:
            if approval_enabled:
                from tools import terminal_tool as _terminal_tool

                previous_callback = _terminal_tool._get_approval_callback()
                _terminal_tool.set_approval_callback(self._approval_callback(state))
                os.environ["HERMES_INTERACTIVE"] = "1"
                os.environ.pop("HERMES_EXEC_ASK", None)

            result = agent.run_conversation(
                user_message=turn["content"],
                system_message=agent_spec.get("instructions") or None,
                conversation_history=state.history,
                task_id=state.native_session_id,
                stream_callback=None,
            )
            if result.get("messages"):
                state.history = result["messages"]
            final_response = _stringify(result.get("final_response"))
            with state.lock:
                final_event = self._append_event(
                    state,
                    "agent.message",
                    final_response,
                    tokens_in=int(result.get("input_tokens") or result.get("prompt_tokens") or 0),
                    tokens_out=int(result.get("output_tokens") or result.get("completion_tokens") or 0),
                    cost_usd=float(result.get("estimated_cost_usd") or 0.0),
                    model=str(result.get("model") or state.model or ""),
                )
            emit_event(final_event)
            return result
        finally:
            if approval_enabled:
                try:
                    from tools import terminal_tool as _terminal_tool

                    _terminal_tool.set_approval_callback(previous_callback)
                except Exception:
                    self.logger.debug("failed to restore Hermes approval callback", exc_info=True)
            if previous_interactive is None:
                os.environ.pop("HERMES_INTERACTIVE", None)
            else:
                os.environ["HERMES_INTERACTIVE"] = previous_interactive
            if previous_exec_ask is None:
                os.environ.pop("HERMES_EXEC_ASK", None)
            else:
                os.environ["HERMES_EXEC_ASK"] = previous_exec_ask

    def _result_payload(
        self,
        session_id: str,
        state: ManagedSession,
        result: dict[str, Any],
    ) -> dict[str, Any]:
        usage = _usage_from_result(result)
        if not usage.get("model"):
            usage["model"] = state.model
        return {
            "protocol_version": PROTOCOL_VERSION,
            "output": _stringify(result.get("final_response")),
            "usage": usage,
            "native": _native_state(session_id, state),
            "events": list(state.active_events),
        }

    def cancel(self, session_id: str) -> dict[str, Any]:
        state = self.get_session(session_id)
        with state.lock:
            agent = state.agent
        if agent is not None:
            agent.interrupt("cancelled by managed runtime")
        return {
            "protocol_version": PROTOCOL_VERSION,
            "accepted": True,
            "native": _native_state(session_id, state),
        }

    def patch(self, session_id: str, request: dict[str, Any]) -> dict[str, Any]:
        state = self.get_session(session_id)
        with state.lock:
            model = request.get("model")
            if model and state.agent is not None:
                resolved_model, runtime = _resolve_runtime(str(model))
                state.agent.model = resolved_model
                state.agent.provider = runtime.get("provider")
                state.agent.api_mode = runtime.get("api_mode")
                state.agent.base_url = runtime.get("base_url")
                state.requested_model = str(model)
                state.model = resolved_model
                state.provider = str(runtime.get("provider") or "")
                state.api_mode = str(runtime.get("api_mode") or "")
            if request.get("thinking_level") and state.agent is not None:
                state.agent.reasoning_config = _thinking_config(request.get("thinking_level"))
        return {
            "protocol_version": PROTOCOL_VERSION,
            "accepted": True,
            "native": _native_state(session_id, state),
        }

    def list_events(self, session_id: str) -> dict[str, Any]:
        state = self.get_session(session_id)
        with state.lock:
            events = list(state.event_backlog)
        return {
            "protocol_version": PROTOCOL_VERSION,
            "events": events,
            "native": _native_state(session_id, state),
        }


class AdapterHttpError(Exception):
    def __init__(self, status: int, payload: dict[str, Any]) -> None:
        super().__init__(payload.get("error", {}).get("message", "adapter error"))
        self.status = status
        self.payload = payload


RUNTIME = HermesAdapterRuntime()


class Handler(BaseHTTPRequestHandler):
    server_version = "oma-hermes-adapter/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        logging.getLogger("oma.hermes.http").info(fmt, *args)

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
                        "native": _native_state(session_id, state),
                    },
                )
                return
            self._write_error(*_error_payload("bad_request", "route not found", HTTPStatus.NOT_FOUND))
        except AdapterHttpError as exc:
            self._write_error(exc.status, exc.payload)
        except Exception as exc:
            logging.getLogger("oma.hermes").error("GET failed: %s", exc, exc_info=True)
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
                self._write_error(
                    *_error_payload("unsupported_capability", "Hermes compaction is not wired yet", HTTPStatus.BAD_REQUEST)
                )
                return

            self._write_error(*_error_payload("bad_request", "route not found", HTTPStatus.NOT_FOUND))
        except AdapterHttpError as exc:
            self._write_error(exc.status, exc.payload)
        except Exception as exc:
            logging.getLogger("oma.hermes").error("POST failed: %s", exc, exc_info=True)
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
        level=os.getenv("OMA_HERMES_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    port = int(_env("OMA_ADAPTER_PORT", _env("OPENCLAW_GATEWAY_PORT", "18789")))
    host = _env("OMA_ADAPTER_HOST", "0.0.0.0")
    server = ThreadingHTTPServer((host, port), Handler)
    logging.getLogger("oma.hermes").info(
        "Hermes OMA adapter listening on %s:%s protocol=%s hermes=%s",
        host,
        port,
        PROTOCOL_VERSION,
        _hermes_version(),
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
