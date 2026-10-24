"""Owner identity and bounded native browse at the MCP trust boundary."""
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace

import pytest

SOURCE = Path(__file__).parents[2] / "integrations/hermes/personal_aios/self_tools.py"
spec = importlib.util.spec_from_file_location("self_tools_under_test", SOURCE)
self_tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(self_tools)


@pytest.fixture
def harness(monkeypatch):
    state = SimpleNamespace(scope="owner", run="native-run", allowed=True, calls=[], browse=[])
    monkeypatch.setattr(self_tools, "runtime_identity", lambda: {"hermes_version": "fixture", "provider": "configured", "model": "configured"})
    def module(name, **values):
        result = ModuleType(name)
        result.__dict__.update(values)
        monkeypatch.setitem(sys.modules, name, result)
    module("gateway", __path__=[])
    module("gateway.run_scope", current_scope=lambda: state.scope)
    module("gateway.session_context", get_api_run_id=lambda session: state.run)
    module("tools", __path__=[])
    def browse(**kwargs):
        state.browse.append(kwargs)
        return json.dumps({"success": True, "mode": "browse", "count": 4,
                           "results": [{"preview": "private transcript"}]})
    module("tools.session_search_tool", session_search=browse)
    def request(path, body):
        state.calls.append((path, body))
        return {"principal_id": "owner", "allow_owner_mutation": state.allowed}
    def register_hook(name, callback):
        assert name == "pre_tool_call"
        state.hook = callback
    self_tools.register(SimpleNamespace(register_hook=register_hook, register_tool=lambda *args: args[0]), SimpleNamespace(_request=request))
    return state


@pytest.mark.parametrize("scope", ["guest", "owner_uncertain", "care", "build"])
def test_restricted_runs_never_read_owner_state(harness, scope):
    harness.scope = scope
    assert harness.hook("mcp__self__runtime_status", {}, session_id="session", tool_call_id="call")["action"] == "block"
    assert harness.calls == harness.browse == []


@pytest.mark.parametrize("missing", ["run", "session", "call"])
def test_unbound_runs_block(harness, missing):
    if missing == "run":
        harness.run = ""
    result = harness.hook("mcp__self__runtime_query", {},
                          session_id="" if missing == "session" else "session",
                          tool_call_id="" if missing == "call" else "call")
    assert result["action"] == "block"
    assert harness.calls == []


def test_background_owner_cannot_use_self(harness):
    harness.allowed = False
    assert harness.hook("mcp__self__runtime_status", {}, session_id="session", tool_call_id="call")["action"] == "block"
    assert harness.browse == []


def test_overwrites_spoofed_claims_and_drops_history(harness):
    args = {"_context": {"run_id": "spoof"}, "_l4": {"sessions": 999, "complete": True}}
    result = harness.hook("mcp__self__runtime_status", args, session_id="session", tool_call_id="call")
    assert result == {"action": "modify", "args": {
        "_context": {"run_id": "native-run", "session_id": "session", "tool_call_id": "call"},
        "_l4": {"sessions": 4, "complete": False},
        "_identity": {"hermes_version": "fixture", "provider": "configured", "model": "configured"}, "_local": None}}
    assert harness.browse == [{"query": "", "limit": 10, "current_session_id": "session"}]
    assert "private transcript" not in json.dumps(result)


def test_query_clears_spoofed_l4_without_browsing(harness):
    result = harness.hook("mcp__self__runtime_query", {"_l4": {"sessions": 999}}, session_id="session", tool_call_id="call")
    assert result["args"]["_l4"] is None and harness.browse == []
    assert result["args"]["_identity"] is None


@pytest.mark.parametrize("model", ["configured-model", {"default": "configured-model", "provider": "configured-provider", "api_key": "never return"}])
def test_runtime_identity_reads_only_configured_model_names(monkeypatch, model):
    from hermes_cli import config
    monkeypatch.setattr(config, "load_config_readonly", lambda: {"model": model, "api_key": "never return"})
    identity = self_tools.runtime_identity()
    assert identity["model"] == "configured-model"
    assert set(identity) == {"hermes_version", "provider", "model"}
    assert "never return" not in json.dumps(identity)


def test_unrelated_tool_is_untouched(harness):
    assert harness.hook("mcp__other__runtime_status", {}) is None
    assert harness.calls == []


def test_browse_failure_blocks_instead_of_escaping(harness, monkeypatch):
    def unavailable(**kwargs):
        raise RuntimeError("secret detail")
    monkeypatch.setattr(sys.modules["tools.session_search_tool"], "session_search", unavailable)
    result = harness.hook("mcp__self__runtime_status", {}, session_id="session", tool_call_id="call")
    assert result == {"action": "block", "message": "SELF_CONTEXT_FAILED:RuntimeError"}


@pytest.mark.parametrize("count", [True, -1, 11, "4"])
def test_native_browse_contract_errors_block(harness, monkeypatch, count):
    monkeypatch.setattr(sys.modules["tools.session_search_tool"], "session_search",
                        lambda **kwargs: json.dumps({"success": True, "mode": "browse", "count": count}))
    assert harness.hook("mcp__self__runtime_status", {}, session_id="session", tool_call_id="call")["action"] == "block"


def test_native_dispatcher_merges_claims_and_stops_restricted_runs(harness, monkeypatch):
    source = os.environ.get("HERMES_SOURCE")
    if not source:
        pytest.skip("Set HERMES_SOURCE to the pinned Hermes source fork")
    monkeypatch.syspath_prepend(source)
    from hermes_cli import plugins
    monkeypatch.setattr(plugins, "invoke_hook", lambda name, **kwargs: [harness.hook(**kwargs)])
    for question, tool in [("你能访问什么？", "runtime_query"), ("你记住多少会话？", "runtime_status")]:
        block, modified = plugins._dispatch_pre_tool_call_hooks(
            "mcp__self__" + tool, {"question": question, "_context": {"run_id": "spoof"}},
            session_id="session", tool_call_id="call")
        assert block is None and modified["question"] == question
        assert modified["_context"]["run_id"] == "native-run"
        harness.scope = "guest"
        block, _ = plugins._dispatch_pre_tool_call_hooks(
            "mcp__self__" + tool, {}, session_id="session", tool_call_id="call")
        assert block == "SELF_OWNER_REQUIRED"
        harness.scope = "owner"


def test_local_observation_uses_admitted_principal_and_replaces_model_data(harness, monkeypatch):
    module = ModuleType('self_fixture.self_observe')
    seen = []
    module.observe = lambda args, principal: seen.append(principal) or {'source': 'hermes_agent', 'lines': ['redacted']}
    monkeypatch.setitem(sys.modules, 'self_fixture.self_observe', module)
    monkeypatch.setattr(self_tools, '__package__', 'self_fixture')
    monkeypatch.setattr(self_tools, '__spec__', importlib.util.spec_from_file_location('self_fixture.self_tools', SOURCE))
    result = harness.hook('mcp__self__runtime_query', {'source': 'hermes_agent', '_local': {'lines': ['spoof']}},
                          session_id='delegated-child', tool_call_id='call')
    assert result['args']['_local']['lines'] == ['redacted']
    assert seen == ['owner']
    harness.scope = 'owner_uncertain'
    assert harness.hook('mcp__self__runtime_query', {'source': 'hermes_agent'}, session_id='child', tool_call_id='call')['action'] == 'block'
    assert seen == ['owner']
