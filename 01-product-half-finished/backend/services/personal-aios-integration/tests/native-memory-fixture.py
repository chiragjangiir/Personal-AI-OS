"""Real isolated native MemoryStore/SessionDB fixture; no model or live profile."""
import hashlib
import aiohttp.web as web
import os, importlib.util
import json
import logging
import sys
from pathlib import Path
from types import SimpleNamespace

contract_root = Path(os.environ.get("PAIOS_NATIVE_CONTRACT_SOURCE_ROOT", os.environ["PYTHONPATH"]))
sys.path.insert(0, str(contract_root))
def load_contract(name, rel):
    file = contract_root / rel
    if not file.exists(): return
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec);sys.modules[name] = module;spec.loader.exec_module(module)
load_contract('gateway.session_context','gateway/session_context.py')
load_contract('hermes_state_memory_outcomes','hermes_state_memory_outcomes.py')
load_contract('tools.memory_tool_outcomes','tools/memory_tool_outcomes.py')
load_contract('tools.memory_tool_store','tools/memory_tool_store.py')
from gateway.platforms.api_server_runs import native_run_response

from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from hermes_state import SessionDB
from tools.memory_tool import MemoryStore
from tools import write_approval as wa
from agent.inline_tool_executors import InlineToolContext, _memory
from hermes_cli.write_approval_commands import handle_pending_subcommand
from gateway.session_context import set_session_vars, clear_session_vars


home = Path(sys.argv[1]).resolve()
home.mkdir(exist_ok=True)
token = set_hermes_home_override(home)
logging.disable(logging.CRITICAL)
db = SessionDB(home / "state.db")
wa.write_approval_enabled = lambda _: False
store = MemoryStore()
store.load_from_disk()
current_run_id = "native-fixture-run"
agent = SimpleNamespace(_memory_effect_db=db,
                        session_id="fixture-session", _memory_store=store, _memory_manager=None)


def call(call_id, content):
    tokens = set_session_vars(platform="api_server", session_id=agent.session_id, session_key=current_run_id)
    try:
        return json.loads(_memory(agent, {"action": "add", "content": content},
                                  InlineToolContext(agent.session_id, call_id)))
    finally:
        clear_session_vars(tokens)


def snapshot():
    return json.loads(native_run_response({"run_id": current_run_id, "session_id": agent.session_id, "conversation_session_id": "fixture-session",
            "status": "completed", "output": "sealed final fixture",
            **db.read_memory_effects(current_run_id, agent.session_id)}, "hermes.run.v2").body)


if "--approval-http" in sys.argv:
    # Only the model turn/tool effect is synthetic. Admission, HTTP, approval wait,
    # timeout and settlement remain native owners.
    import asyncio, signal, uuid
    from gateway.config import PlatformConfig
    from gateway.platforms.api_server import APIServerAdapter
    from tools.approval import request_tool_approval
    from gateway.run_scope import tool_block, restrict_agent, bind_action_grants
    from gateway.run import _load_gateway_config
    settings = json.loads(Path(sys.argv[3]).read_text())
    if "approval_clock" in settings:
        # Only this probe's approval expiry/deadline clock is controlled; native waiting and settlement stay intact.
        from tools import approval_gateway_wait
        clock_file = Path(settings["approval_clock"])
        clock_origin = float(clock_file.read_text()) / 1000
        def approval_time():
            return float(clock_file.read_text()) / 1000
        def approval_monotonic():
            elapsed = approval_time() - clock_origin
            print(json.dumps({"approval_wait_observed": True}), flush=True)
            return elapsed
        approval_gateway_wait.time = SimpleNamespace(time=approval_time, monotonic=approval_monotonic)
    adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={"key": settings["key"], "host": "127.0.0.1", "port": settings["port"]}))
    adapter._ensure_session_db = lambda: db
    def model_agent(**kwargs):
        current = SimpleNamespace(session_id=kwargs["session_id"], session_prompt_tokens=0,
                                  session_completion_tokens=0, session_total_tokens=0,
                                  tools=[], _memory_manager=None, _interrupted=False)
        current._ensure_db_session = lambda: db.ensure_session(current.session_id, "api_server")
        current.interrupt = lambda *a, **k: setattr(current, "_interrupted", True)
        restrict_agent(current, kwargs.get("run_scope"))
        bind_action_grants(current, kwargs.get("granted_toolsets", []), _load_gateway_config())
        def turn(user_message, task_id, **kw):
            action = json.loads(user_message)
            if "content" in action:
                content = action["content"]
                action = (json.loads(content["app_event"]["prompt"])
                          if content.get("app_event", {}).get("kind") == "scheduled_task"
                          else json.loads(content["text"]))
            if tool_block(current, "terminal") is not None:
                return {"final_response": "scope denied"}
            result = request_tool_approval('simulated_product_action', action['question'],
                                           rule_key=f'fixture:{uuid.uuid4().hex}')
            # The approved effect is only a returned fixture value, never an external action.
            result = {'approved': result['approved'], 'simulated_effect': result['approved']}
            return {"final_response": json.dumps(result)}
        current.run_conversation = turn
        return current
    adapter._create_agent = model_agent
    async def serve_approval():
        assert await adapter.connect(), "native approval fixture failed to bind"
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        loop.add_signal_handler(signal.SIGTERM, stop.set)
        print(json.dumps({"ready": True}), flush=True)
        try:
            await stop.wait()
        finally:
            await adapter.disconnect()
    try:
        asyncio.run(serve_approval())
    finally:
        db.close(); reset_hermes_home_override(token)
    sys.exit(0)

if "--care-http" in sys.argv:
    import asyncio
    from unittest.mock import patch
    from aiohttp.test_utils import TestClient, TestServer
    from agent.inline_tool_executors import resolve_invoke_tool_executor
    from agent.memory_manager import MemoryManager
    from gateway.config import PlatformConfig
    from gateway.platforms import api_server, api_server_runs
    from gateway.run_scope import restrict_agent, tool_block
    request = json.loads(Path(sys.argv[3]).read_text())
    spec = importlib.util.spec_from_file_location("care_http_provider", Path(request["repo_root"]) / "integrations/hermes/personal_aios/__init__.py")
    provider_module = importlib.util.module_from_spec(spec); sys.modules[spec.name] = provider_module; spec.loader.exec_module(provider_module)
    provider = provider_module.PersonalAIOSProvider()
    provider.base_url, provider.key_file = request["url"], request["key_file"]
    manager = MemoryManager(); manager.add_provider(provider)
    adapter = api_server.APIServerAdapter(PlatformConfig(enabled=True, extra={"key": "care-fixture-key"}))
    adapter._ensure_session_db = lambda: db
    agent._memory_manager = manager
    results = {}
    def turn(**kwargs):
        for name in ["session_search", "paios_ambient_journal_search", "paios_l5_read", "paios_l5_locate",
                     "paios_l3_query", "paios_l3_inspect", "paios_visual_recall", "paios_people"]:
            assert tool_block(agent, name) is not None, name
            # A caller bypassing the native dispatcher must still be denied by the real host authority.
            if name != "session_search":
                results[name] = json.loads(provider.handle_tool_call(name, {},
                    run_id=request["run_id"], session_id=request["conversation_session_id"], tool_call_id=name))
        for name, args in [("paios_health_query", {"metric": "overview"}),
                           ("paios_open_reply", {"reply_mode": "text"})]:
            assert tool_block(agent, name) is None, name
            executor = resolve_invoke_tool_executor(agent, name)
            assert executor is not None, name
            results[name] = json.loads(executor(agent, args, InlineToolContext(request["run_id"], name)))
        results["memory_write"] = json.loads(_memory(agent, {"action": "add", "content": "forbidden care write"},
                                                      InlineToolContext(request["run_id"], "care-write")))
        return {"final_response": "isolated native care dispatcher fixture"}
    agent.run_conversation = turn
    agent._ensure_db_session = lambda: db.ensure_session(agent.session_id, "api_server")
    agent.session_prompt_tokens = agent.session_completion_tokens = agent.session_total_tokens = 0
    launched = []
    async def capture(adapter, run, **kwargs):
        launched.append(run)
    async def admit():
        app = web.Application(); app.router.add_post("/v1/runs", adapter._handle_runs)
        with patch.object(api_server_runs, "_execute_run", capture), \
             patch.object(api_server_runs.uuid, "uuid4", return_value=SimpleNamespace(hex=request["run_id"].removeprefix("run_"))):
            async with TestClient(TestServer(app)) as client:
                response = await client.post("/v1/runs", headers={"Authorization": "Bearer care-fixture-key", "X-Hermes-Run-Contract": "hermes.run.v2"}, json={
                    "input": json.dumps(request["input"]), "session_id": request["conversation_session_id"],
                    "care_decision": True, "memory_write": False})
                assert response.status == 202, await response.text()
                accepted = await response.json()
                await asyncio.gather(*adapter._active_run_tasks.values())
                return accepted
    try:
        print("PAIOS_CARE_HTTP_PROBE_READY", file=sys.stderr, flush=True)
        accepted = asyncio.run(admit())
        agent.session_id = accepted["session_id"]
        agent.tools = manager.get_all_tool_schemas()
        restrict_agent(agent, launched[0].agent_kwargs["run_scope"])
        api_server_runs._run_agent_sync(adapter, launched[0], agent, lambda event: None, _api_server=api_server)
        print(json.dumps({"results": results, "isolation": {
            "session_id": agent.session_id, "conversation_session_id": accepted["conversation_session_id"],
            "memory_write": accepted["memory_write"], "hidden": db.get_session(agent.session_id)["hidden"],
            "listed_sessions": [row["id"] for row in db.list_sessions_rich()],
            "memory_unchanged": not (home / "memories/MEMORY.md").exists()}}))
    finally:
        manager.shutdown_all(); db.close(); reset_hermes_home_override(token)
    sys.exit(0)

try:
    db.begin_memory_effect_run(current_run_id, agent.session_id)
    assert call("commit", "actual temporary native memory")["changed"] is True
    assert call("noop", "actual temporary native memory")["changed"] is False
    wa.evaluate_gate = lambda *a, **k: wa.GateDecision(stage=True)
    staged = call("stage", "approved temporary native memory")
    pending = snapshot()
    assert "Approved 1" in handle_pending_subcommand("memory", ["approve", staged["pending_id"]], memory_store=store)
    approved = snapshot()
    rejected_request = call("stage-reject", "rejected temporary native memory")
    assert "Rejected pending" in handle_pending_subcommand("memory", ["reject", rejected_request["pending_id"]])
    partial = snapshot()  # Known immutable settlements, coverage still unfinished.
    memory = home / "memories" / "MEMORY.md"
    before = memory.stat()
    memory_hash = hashlib.sha256(memory.read_bytes()).hexdigest()
    db.finish_memory_effect_run(current_run_id)
    complete = snapshot()
    after = memory.stat()
    assert (before.st_ino, before.st_mtime_ns) == (after.st_ino, after.st_mtime_ns)
    assert hashlib.sha256(memory.read_bytes()).hexdigest() == memory_hash
    # Actual file commit with a lost settlement remains an unknown attempt. Never repair from content.
    current_run_id = "native-gap-run"
    db.begin_memory_effect_run(current_run_id, agent.session_id)
    wa.evaluate_gate = lambda *a, **k: wa.GateDecision(allow=True)
    assert call("known", "known before gap")["changed"]
    original_settle = db.settle_memory_effect
    def lost_settlement(*a, **k):
        raise OSError("injected receipt persistence loss")
    db.settle_memory_effect = lost_settlement
    assert call("gap", "real file commit without receipt")["changed"]
    db.settle_memory_effect = original_settle
    db.finish_memory_effect_run(current_run_id)
    gap = snapshot()
    print(json.dumps({"profile_home": str(home), "pending": pending, "approved": approved,
                      "partial": partial, "complete": complete, "gap": gap,
                      "memory_sha256": memory_hash, "completion_preserved_file": True}))
finally:
    db.close()
    reset_hermes_home_override(token)
