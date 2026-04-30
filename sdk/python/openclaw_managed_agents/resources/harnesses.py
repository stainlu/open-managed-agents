"""Harness catalog resource methods."""

from __future__ import annotations

from typing import Any, Dict, List

import httpx

from ..types import Harness, HarnessCapability, HarnessCatalog


def _parse_capabilities(data: Dict[str, Any]) -> Dict[str, HarnessCapability]:
    capabilities: Dict[str, HarnessCapability] = {}
    for name, value in data.items():
        if isinstance(value, dict):
            capabilities[name] = HarnessCapability(
                support=str(value.get("support", "unsupported")),
                detail=str(value.get("detail", "")),
            )
    return capabilities


def _parse_harness(data: Dict[str, Any]) -> Harness:
    return Harness(
        harness_id=data["harness_id"],
        name=data["name"],
        capabilities=_parse_capabilities(data.get("capabilities", {})),
    )


class Harnesses:
    def __init__(self, client: httpx.Client) -> None:
        self._client = client

    def catalog(self) -> HarnessCatalog:
        resp = self._client.get("/v1/harnesses")
        resp.raise_for_status()
        data = resp.json()
        harnesses = [_parse_harness(h) for h in data.get("harnesses", [])]
        return HarnessCatalog(
            default_harness_id=data["default_harness_id"],
            harnesses=harnesses,
            count=data.get("count", len(harnesses)),
        )

    def list(self) -> List[Harness]:
        return self.catalog().harnesses
