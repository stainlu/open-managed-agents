"""Managed runtime substrate resource methods."""

from __future__ import annotations

from typing import Any, Dict

import httpx

from ..types import RuntimeHealth, RuntimeProfile


def _bool_map(value: Any) -> Dict[str, bool]:
    if not isinstance(value, dict):
        return {}
    return {str(key): bool(child) for key, child in value.items()}


def _parse_runtime_health(data: Dict[str, Any]) -> RuntimeHealth:
    return RuntimeHealth(
        platform=str(data.get("platform", "unknown")),
        stack=str(data["stack"]) if data.get("stack") is not None else None,
        mode=str(data["mode"]) if data.get("mode") is not None else None,
        default_harness=str(data["default_harness"]) if data.get("default_harness") is not None else None,
        bindings=_bool_map(data.get("bindings")),
        features=_bool_map(data.get("features")),
    )


class Runtime:
    def __init__(self, client: httpx.Client) -> None:
        self._client = client

    def profile(self) -> RuntimeProfile:
        resp = self._client.get("/v1/runtime")
        resp.raise_for_status()
        data = resp.json()
        return RuntimeProfile(runtime=_parse_runtime_health(data.get("runtime", {})))
