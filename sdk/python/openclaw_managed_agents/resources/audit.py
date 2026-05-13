"""Audit log resource methods."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, TypedDict

import httpx

from ..types import AuditEvent


class AuditEventList(TypedDict):
    events: List[AuditEvent]
    count: int


def _parse_audit_event(data: Dict[str, Any]) -> AuditEvent:
    return AuditEvent(
        id=data["id"],
        ts=data["ts"],
        request_id=data.get("request_id"),
        actor=data["actor"],
        action=data["action"],
        target=data.get("target"),
        outcome=data["outcome"],
        metadata=data.get("metadata"),
    )


class Audit:
    def __init__(self, client: httpx.Client) -> None:
        self._client = client

    def query(
        self,
        *,
        since: Optional[int] = None,
        until: Optional[int] = None,
        action: Optional[str] = None,
        target: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> AuditEventList:
        params: Dict[str, Any] = {}
        if since is not None:
            params["since"] = since
        if until is not None:
            params["until"] = until
        if action is not None:
            params["action"] = action
        if target is not None:
            params["target"] = target
        if limit is not None:
            params["limit"] = limit
        resp = self._client.get("/v1/audit", params=params)
        resp.raise_for_status()
        data = resp.json()
        events = [_parse_audit_event(event) for event in data.get("events", [])]
        return {"events": events, "count": data.get("count", len(events))}

    def list(
        self,
        *,
        since: Optional[int] = None,
        until: Optional[int] = None,
        action: Optional[str] = None,
        target: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> List[AuditEvent]:
        return self.query(
            since=since,
            until=until,
            action=action,
            target=target,
            limit=limit,
        )["events"]
