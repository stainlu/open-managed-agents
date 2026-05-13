"""Session resource methods."""

from __future__ import annotations

import json
from typing import Any, Dict, Iterator, List, Optional

import httpx
from httpx_sse import connect_sse

from ..types import (
    Approval,
    CancelTreeResult,
    CancelTreeSessionResult,
    Event,
    ManagedRun,
    Session,
    SessionTree,
    SessionTreeNode,
)


def _parse_session(data: Dict[str, Any]) -> Session:
    return Session(
        session_id=data["session_id"],
        agent_id=data["agent_id"],
        harness_id=data.get("harness_id", "openclaw"),
        status=data["status"],
        tokens=data.get("tokens", {"input": 0, "output": 0}),
        cost_usd=data.get("cost_usd", 0),
        created_at=data["created_at"],
        output=data.get("output"),
        environment_id=data.get("environment_id"),
        error=data.get("error"),
        last_event_at=data.get("last_event_at"),
        turns=data.get("turns", 0),
        boot_ms=data.get("boot_ms"),
        pool_source=data.get("pool_source"),
        container_id=data.get("container_id"),
        container_name=data.get("container_name"),
        parent_session_id=data.get("parent_session_id"),
    )


def _parse_event(data: Dict[str, Any]) -> Event:
    return Event(
        event_id=data["event_id"],
        session_id=data["session_id"],
        type=data["type"],
        content=data["content"],
        created_at=data["created_at"],
        tokens=data.get("tokens"),
        cost_usd=data.get("cost_usd"),
        model=data.get("model"),
        tool_name=data.get("tool_name"),
        tool_call_id=data.get("tool_call_id"),
        tool_arguments=data.get("tool_arguments"),
        is_error=data.get("is_error"),
        approval_id=data.get("approval_id"),
        run_id=data.get("run_id"),
        run_kind=data.get("run_kind"),
        run_status=data.get("run_status"),
        parent_run_id=data.get("parent_run_id"),
        event_index=data.get("event_index"),
    )


def _parse_approval(data: Dict[str, Any]) -> Approval:
    return Approval(
        approval_id=data["approval_id"],
        session_id=data["session_id"],
        tool_name=data["tool_name"],
        description=data["description"],
        arrived_at=data["arrived_at"],
        tool_call_id=data.get("tool_call_id"),
    )


def _parse_managed_run(data: Dict[str, Any]) -> ManagedRun:
    return ManagedRun(
        run_id=data["run_id"],
        session_id=data["session_id"],
        agent_id=data["agent_id"],
        status=data["status"],
        queued=data["queued"],
        created_at=data["created_at"],
        model=data.get("model"),
        thinking_level=data.get("thinking_level"),
        error=data.get("error"),
        started_at=data.get("started_at"),
        completed_at=data.get("completed_at"),
    )


def _parse_session_tree_node(data: Dict[str, Any]) -> SessionTreeNode:
    return SessionTreeNode(
        session=_parse_session(data["session"]),
        children=[_parse_session_tree_node(child) for child in data.get("children", [])],
    )


def _parse_session_tree(data: Dict[str, Any]) -> SessionTree:
    return SessionTree(
        session_id=data["session_id"],
        count=data["count"],
        root=_parse_session_tree_node(data["root"]),
    )


def _parse_cancel_tree_result(data: Dict[str, Any]) -> CancelTreeResult:
    return CancelTreeResult(
        session_id=data["session_id"],
        count=data["count"],
        cancelled_count=data["cancelled_count"],
        skipped_count=data["skipped_count"],
        failed_count=data["failed_count"],
        results=[
            CancelTreeSessionResult(
                session_id=item["session_id"],
                parent_session_id=item.get("parent_session_id"),
                status_before=item["status_before"],
                session_status=item["session_status"],
                cancelled=item["cancelled"],
                skipped=item["skipped"],
                error=item.get("error"),
            )
            for item in data.get("results", [])
        ],
    )


class Sessions:
    def __init__(self, client: httpx.Client) -> None:
        self._client = client

    def create(
        self,
        *,
        agent_id: str,
        environment_id: Optional[str] = None,
        vault_id: Optional[str] = None,
    ) -> Session:
        body: Dict[str, Any] = {"agentId": agent_id}
        if environment_id is not None:
            body["environmentId"] = environment_id
        if vault_id is not None:
            body["vaultId"] = vault_id
        resp = self._client.post("/v1/sessions", json=body)
        resp.raise_for_status()
        return _parse_session(resp.json())

    def get(self, session_id: str) -> Session:
        resp = self._client.get(f"/v1/sessions/{session_id}")
        resp.raise_for_status()
        return _parse_session(resp.json())

    def list(self) -> List[Session]:
        resp = self._client.get("/v1/sessions")
        resp.raise_for_status()
        return [_parse_session(s) for s in resp.json()["sessions"]]

    def children(self, session_id: str) -> List[Session]:
        """List direct managed child sessions."""
        resp = self._client.get(f"/v1/sessions/{session_id}/children")
        resp.raise_for_status()
        return [_parse_session(s) for s in resp.json()["children"]]

    def session_tree(self, session_id: str) -> SessionTree:
        """Read the recursive managed session lineage tree."""
        resp = self._client.get(f"/v1/sessions/{session_id}/session-tree")
        resp.raise_for_status()
        return _parse_session_tree(resp.json())

    def delete(self, session_id: str) -> None:
        resp = self._client.delete(f"/v1/sessions/{session_id}")
        resp.raise_for_status()

    def send(
        self,
        session_id: str,
        *,
        content: str,
        model: Optional[str] = None,
        thinking_level: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Post a user message to a session. Returns session status and queued flag."""
        body: Dict[str, Any] = {"content": content}
        if model is not None:
            body["model"] = model
        if thinking_level is not None:
            body["thinkingLevel"] = thinking_level
        resp = self._client.post(f"/v1/sessions/{session_id}/events", json=body)
        resp.raise_for_status()
        return resp.json()

    def confirm_tool(
        self,
        session_id: str,
        *,
        tool_use_id: str,
        result: str,
        deny_message: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Resolve a pending tool confirmation (always_ask policy)."""
        body: Dict[str, Any] = {
            "type": "user.tool_confirmation",
            "toolUseId": tool_use_id,
            "result": result,
        }
        if deny_message is not None:
            body["denyMessage"] = deny_message
        resp = self._client.post(f"/v1/sessions/{session_id}/events", json=body)
        resp.raise_for_status()
        return resp.json()

    def approvals(self, session_id: str) -> List[Approval]:
        """List currently pending tool approvals for a session."""
        resp = self._client.get(f"/v1/sessions/{session_id}/approvals")
        resp.raise_for_status()
        return [_parse_approval(a) for a in resp.json()["approvals"]]

    def resolve_approval(
        self,
        session_id: str,
        approval_id: str,
        *,
        decision: str,
    ) -> Dict[str, Any]:
        """Resolve a pending approval through the direct managed API."""
        resp = self._client.post(
            f"/v1/sessions/{session_id}/approvals/{approval_id}",
            json={"decision": decision},
        )
        resp.raise_for_status()
        return resp.json()

    def cancel(self, session_id: str) -> Dict[str, Any]:
        """Cancel the in-flight run on a session."""
        resp = self._client.post(f"/v1/sessions/{session_id}/cancel")
        resp.raise_for_status()
        return resp.json()

    def cancel_tree(
        self,
        session_id: str,
        *,
        reason: Optional[str] = None,
    ) -> CancelTreeResult:
        """Cancel in-flight work across a managed session tree."""
        body: Dict[str, Any] = {}
        if reason is not None:
            body["reason"] = reason
        resp = self._client.post(f"/v1/sessions/{session_id}/cancel-tree", json=body)
        resp.raise_for_status()
        return _parse_cancel_tree_result(resp.json())

    def compact(self, session_id: str) -> Dict[str, Any]:
        """Ask OpenClaw to compact context history for a session."""
        resp = self._client.post(f"/v1/sessions/{session_id}/compact")
        resp.raise_for_status()
        return resp.json()

    def runs(self, session_id: str) -> List[ManagedRun]:
        """List managed runs for a session."""
        resp = self._client.get(f"/v1/sessions/{session_id}/runs")
        resp.raise_for_status()
        return [_parse_managed_run(r) for r in resp.json()["runs"]]

    def run(self, session_id: str, run_id: str) -> ManagedRun:
        """Read one managed run by id."""
        resp = self._client.get(f"/v1/sessions/{session_id}/runs/{run_id}")
        resp.raise_for_status()
        return _parse_managed_run(resp.json())

    def abort_run(
        self,
        session_id: str,
        run_id: str,
        *,
        reason: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Abort a queued or active managed run."""
        body: Dict[str, Any] = {}
        if reason is not None:
            body["reason"] = reason
        resp = self._client.post(
            f"/v1/sessions/{session_id}/runs/{run_id}/abort",
            json=body,
        )
        resp.raise_for_status()
        return resp.json()

    def logs(self, session_id: str, *, tail: Optional[int] = None) -> str:
        """Return the live container stdout/stderr snapshot."""
        params: Dict[str, Any] = {}
        if tail is not None:
            params["tail"] = tail
        resp = self._client.get(f"/v1/sessions/{session_id}/logs", params=params)
        resp.raise_for_status()
        return resp.text

    def events(self, session_id: str) -> List[Event]:
        """Get the full event history for a session."""
        resp = self._client.get(f"/v1/sessions/{session_id}/events")
        resp.raise_for_status()
        return [_parse_event(e) for e in resp.json()["events"]]

    def stream(self, session_id: str) -> Iterator[Event]:
        """SSE stream of events. Catches up on existing events then tail-follows.

        Yields Event objects. Automatically skips heartbeat events.
        The iterator ends when the server closes the connection (session
        idle for ~30s after the last event).

        Usage::

            for event in client.sessions.stream(session_id):
                if event.type == "agent.message":
                    print(event.content)
        """
        with connect_sse(
            self._client,
            "GET",
            f"/v1/sessions/{session_id}/events",
            params={"stream": "true"},
        ) as sse:
            for server_event in sse.iter_sse():
                if server_event.event == "heartbeat":
                    continue
                try:
                    data = json.loads(server_event.data)
                except (json.JSONDecodeError, TypeError):
                    continue
                yield _parse_event(data)
