"""OpenAI-compatible chat completions resource methods."""

from __future__ import annotations

import json
from typing import Any, Dict, Iterator, List, Optional

import httpx
from httpx_sse import connect_sse


class Chat:
    def __init__(self, client: httpx.Client) -> None:
        self.completions = ChatCompletions(client)


class ChatCompletions:
    def __init__(self, client: httpx.Client) -> None:
        self._client = client

    def create(
        self,
        *,
        agent_id: str,
        messages: List[Dict[str, Any]],
        session_key: Optional[str] = None,
        model: Optional[str] = None,
        user: Optional[str] = None,
        **extra: Any,
    ) -> Dict[str, Any]:
        body = _chat_body(
            messages=messages,
            model=model,
            user=user,
            stream=False,
            extra=extra,
        )
        resp = self._client.post(
            "/v1/chat/completions",
            json=body,
            headers=_chat_headers(agent_id=agent_id, session_key=session_key),
        )
        resp.raise_for_status()
        return resp.json()

    def stream(
        self,
        *,
        agent_id: str,
        messages: List[Dict[str, Any]],
        session_key: Optional[str] = None,
        model: Optional[str] = None,
        user: Optional[str] = None,
        **extra: Any,
    ) -> Iterator[Dict[str, Any]]:
        body = _chat_body(
            messages=messages,
            model=model,
            user=user,
            stream=True,
            extra=extra,
        )
        with connect_sse(
            self._client,
            "POST",
            "/v1/chat/completions",
            json=body,
            headers=_chat_headers(agent_id=agent_id, session_key=session_key),
        ) as sse:
            for event in sse.iter_sse():
                if event.data == "[DONE]":
                    return
                if event.event == "error":
                    raise RuntimeError(_error_message(event.data))
                if not event.data:
                    continue
                yield json.loads(event.data)


def _chat_body(
    *,
    messages: List[Dict[str, Any]],
    model: Optional[str],
    user: Optional[str],
    stream: bool,
    extra: Dict[str, Any],
) -> Dict[str, Any]:
    body: Dict[str, Any] = {**extra, "messages": messages, "stream": stream}
    if model is not None:
        body["model"] = model
    if user is not None:
        body["user"] = user
    return body


def _chat_headers(*, agent_id: str, session_key: Optional[str]) -> Dict[str, str]:
    headers = {"x-openclaw-agent-id": agent_id}
    if session_key is not None:
        headers["x-openclaw-session-key"] = session_key
    return headers


def _error_message(data: str) -> str:
    try:
        parsed = json.loads(data)
        message = parsed.get("error", {}).get("message")
        if isinstance(message, str):
            return message
    except json.JSONDecodeError:
        pass
    return data
