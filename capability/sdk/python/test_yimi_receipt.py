"""Public author helpers: states, source facts, and MCP serialization."""
import json
from pathlib import Path

import pytest

from capability.sdk.python import yimi_receipt as sdk


@pytest.mark.parametrize("state", ["succeeded", "partial", "failed", "unknown", "running",
                                   "accepted", "waiting", "cancelled", "rejected"])
def test_state_has_the_five_fact_containers(state):
    body = getattr(sdk, state)()
    assert body["receipt"] == 1
    assert body["status"]["state"] == state
    assert set(body) == {"receipt", "status", "effects", "values", "content", "unknowns", "next"}
    assert body["next"] == {"retry": "after_check" if state == "unknown" else "forbidden", "waiting_on": "none"}


def test_worked_pdf_receipt_round_trips_through_helpers():
    fixture = Path(__file__).parents[2] / "contracts/examples/receipts/pdf-batch.partial.json"
    expected = json.loads(fixture.read_text())
    fields = {key: value for key, value in expected.items() if key not in {"receipt", "status"}}
    fields["status"] = {key: value for key, value in expected["status"].items() if key != "state"}
    fields["effects"] = [sdk.effect(**item) for item in expected["effects"]]
    fields["values"] = [sdk.value(**item) for item in expected["values"]]
    fields["unknowns"] = [sdk.unknown_fact(**item) for item in expected["unknowns"]]
    body = sdk.partial(**fields)
    result = sdk.to_mcp_result(body)
    assert result["structuredContent"] == expected
    assert result["content"] == [{"type": "text", "text": "partial 47/50 份"}]
    assert json.loads(json.dumps(result, ensure_ascii=False)) == result


def test_unit_is_explicit_and_atomic_values_keep_precision():
    with pytest.raises(TypeError):
        sdk.value(key="count", value=47, provenance="observed", source="fixture", as_of="2026-10-24T13:03:12Z")
    assert sdk.value("ratio", 0.123456789, "none", "computed", "fixture", "2026-10-24T13:03:12Z")["value"] == 0.123456789


def test_summary_is_one_text_block_and_serialization_captures_a_snapshot():
    body = sdk.unknown(unknowns=[sdk.unknown_fact("device", "No acknowledgement.")])
    result = sdk.to_mcp_result(body, "unknown\ncheck\tfirst")
    body["unknowns"][0]["why"] = "changed later"
    assert result["content"] == [{"type": "text", "text": "unknown check first"}]
    assert result["structuredContent"]["unknowns"][0]["why"] == "No acknowledgement."
