"""Author helpers; platform admission, rather than the helper, qualifies claims."""
from __future__ import annotations

from copy import deepcopy
from typing import Any


def receipt(state: str, *, status=None, effects=(), values=(), content=(),
            unknowns=(), next=None, job=None) -> dict[str, Any]:
    body = {
        "receipt": 1, "status": {**(status or {}), "state": state},
        "effects": list(effects), "values": list(values),
        "content": list(content), "unknowns": list(unknowns),
        "next": {"retry": "after_check" if state == "unknown" else "forbidden",
                 "waiting_on": "none", **(next or {})},
    }
    if job is not None:
        body["job"] = dict(job)
    return body


def succeeded(**fields):
    return receipt("succeeded", **fields)


def partial(**fields):
    return receipt("partial", **fields)


def failed(**fields):
    return receipt("failed", **fields)


def unknown(**fields):
    return receipt("unknown", **fields)


def running(**fields):
    return receipt("running", **fields)


def accepted(**fields):
    return receipt("accepted", **fields)


def waiting(**fields):
    return receipt("waiting", **fields)


def cancelled(**fields):
    return receipt("cancelled", **fields)


def rejected(**fields):
    """Platform only; package-written rejected receipts fail platform admission."""
    return receipt("rejected", **fields)


def effect(kind: str, target: str, action: str, verification: str,
           evidence: str, ref: str | None = None) -> dict[str, Any]:
    return dict(kind=kind, target=target, action=action, verification=verification,
                evidence=evidence, ref=ref)


def value(key: str, value, unit: str, provenance: str, source: str,
          as_of: str) -> dict[str, Any]:
    return dict(key=key, value=value, unit=unit, provenance=provenance,
                source=source, as_of=as_of)


def unknown_fact(about: str, why: str) -> dict[str, str]:
    return dict(about=about, why=why)


def to_mcp_result(body: dict[str, Any], summary: str | None = None) -> dict[str, Any]:
    if summary is None:
        parts = [body["status"]["state"]]
        if body["status"].get("reason_code"):
            parts.append(body["status"]["reason_code"])
        if progress := body["status"].get("progress"):
            parts.append(f'{progress["done"]}/{progress["total"]} {progress["unit"]}')
        summary = " ".join(parts)
    return {"content": [{"type": "text", "text": " ".join(summary.split())}],
            "structuredContent": deepcopy(body)}
