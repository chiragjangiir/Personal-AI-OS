"""Failure isolation and trusted lineage at the pinned native hook boundary."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).parents[2]
spec = importlib.util.spec_from_file_location("yimi_gateway_test", ROOT / "integrations/hermes/yimi_gateway/__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
TOOL = "mcp__mijia__control_device"


@pytest.fixture
def gateway(monkeypatch):
    monkeypatch.setattr(plugin, "_binding", lambda task, session: ("root-session", "root-run"))
    return plugin.Gateway({"capability_tools": [TOOL]})


@pytest.mark.parametrize("error", [TimeoutError(), OSError(), ValueError()])
def test_decide_and_catalog_errors_block_and_receipt_errors_never_return_raw(gateway, monkeypatch, error):
    def unavailable(*args):
        raise error
    monkeypatch.setattr(gateway, "rpc", unavailable)
    assert gateway.pre(TOOL, {})["action"] == "block"
    view = gateway.transform(TOOL, {}, result="raw secret-shaped result")
    assert "raw secret-shaped result" not in view
    receipt = json.loads(view.split("\n", 1)[1])
    assert receipt["status"] == {"state": "unknown", "reason_code": "gateway_unavailable"}
    assert receipt["next"]["retry"] == "after_check"
    gateway.post(TOOL, {}, result="raw result")


def test_decide_rpc_failure_is_caught_after_successful_catalog(gateway, monkeypatch):
    def request(operation, body=None):
        if operation == "catalog":
            return {"tools": [TOOL]}
        raise TimeoutError()
    monkeypatch.setattr(gateway, "rpc", request)
    assert gateway.pre(TOOL, {})["action"] == "block"
    assert "gateway_unavailable" in gateway.transform(TOOL, {}, result="raw")


@pytest.mark.parametrize("decision,expected", [
    ({"action": "approve", "message": "请确认：现实操作；对象：客厅灯", "rule_key": "{\"kind\":\"external\"}"}, "approve"),
    ({"action": "approve", "message": "请确认", "rule_key": ""}, "block"),
    ({"action": "approve", "rule_key": "scope"}, "block")])
def test_a_complete_approve_decision_reaches_the_native_approval_gate(gateway, monkeypatch, decision, expected):
    monkeypatch.setattr(gateway, "rpc", lambda operation, body=None: {"tools": [TOOL]} if operation == "catalog" else decision)
    result = gateway.pre(TOOL, {"device": "客厅灯", "owner_requested": False})
    assert result["action"] == expected
    assert result == decision if expected == "approve" else result["message"] == "能力判定服务暂时不可用，本次未执行。"


@pytest.mark.parametrize("view", [None, {}, ""])
def test_malformed_receipt_response_cannot_fail_open(gateway, monkeypatch, view):
    monkeypatch.setattr(gateway, "rpc", lambda operation, body=None: {"tools": [TOOL]} if operation == "catalog" else {"model_view": view})
    assert "gateway_unavailable" in gateway.transform(TOOL, {}, result="raw")


def test_nonpackage_and_disabled_family_pass_through(gateway, monkeypatch):
    operations = []
    def catalog(operation, body=None):
        operations.append(operation)
        assert operation == "catalog"
        return {"tools": [TOOL]}
    monkeypatch.setattr(gateway, "rpc", catalog)
    assert gateway.pre("read_file", {}) is None
    assert gateway.transform("read_file", {}, result="original") is None
    gateway.post("read_file", {})
    assert operations == ["catalog", "catalog", "catalog"]
    monkeypatch.setattr(gateway, "rpc", lambda *args: {"tools": []})
    assert gateway.pre(TOOL, {}) is None
    assert gateway.transform(TOOL, {}, result="original") is None


@pytest.mark.parametrize("depth", [1, 2])
def test_task_id_walks_the_existing_native_lineage_table(depth):
    from gateway.session_context import set_session_vars, bind_api_run_conversation, clear_session_vars, reset_api_run_conversation
    from tools.delegate_tool_registry import _register_subagent, _unregister_subagent
    tokens = set_session_vars(platform="api_server", session_id="root-session", session_key="root-run")
    policy = bind_api_run_conversation("root-run", "root-session")
    try:
        for index in range(depth):
            _register_subagent({"subagent_id": f"child-{index}", "parent_id": f"child-{index-1}" if index else None,
                "owner_agent_session_id": "intermediate-session" if index else "root-session"})
        assert plugin._binding(f"child-{depth-1}", "root-session") == ("root-session", "root-run")
    finally:
        for index in range(depth):
            _unregister_subagent(f"child-{index}")
        reset_api_run_conversation(policy)
        clear_session_vars(tokens)


def test_envelopes_match_the_fixed_gateway_schemas(gateway):
    import jsonschema
    schemas = json.loads((ROOT / "capability/contracts/gateway-api.v1.json").read_text())["components"]["schemas"]
    fields = {"task_id": "child", "session_id": "root-session", "tool_call_id": "call", "turn_id": "turn", "result": {},
              "status": "success", "duration_ms": 1, "error_type": None, "error_message": None}
    for name, flags in [("PreToolCall", {}), ("TransformToolResult", {"result": True}), ("PostToolCall", {"result": True, "post": True})]:
        jsonschema.validate(gateway.envelope(TOOL, {}, fields, **flags), schemas[name])


def test_escaping_native_pre_hook_exception_is_measured_at_the_pin(monkeypatch):
    from hermes_cli import plugins
    from hermes_cli.lifecycle import invoke_hook
    manager = plugins.get_plugin_manager()
    def broken(**kwargs):
        raise RuntimeError("synthetic pre hook failure")
    monkeypatch.setattr(manager, "_discovered", True)
    monkeypatch.setitem(manager._hooks, "pre_tool_call", [broken])
    result = invoke_hook("pre_tool_call", tool_name="synthetic", args={})
    assert len(result) == 1 and result[0]["action"] == "block"
