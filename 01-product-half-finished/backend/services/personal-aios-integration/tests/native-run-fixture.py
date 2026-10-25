"""Real isolated native scope and approval fixture; no model or external effects."""
import aiohttp.web as web
import os, importlib.util
import json
import logging
import sys
from pathlib import Path
from types import SimpleNamespace
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from hermes_state import SessionDB
from agent.inline_tool_executors import InlineToolContext
home = Path(sys.argv[1]).resolve()
home.mkdir(exist_ok=True)
token = set_hermes_home_override(home)
logging.disable(logging.CRITICAL)
db = SessionDB(home / "state.db")
agent = SimpleNamespace(session_id="fixture-session", _memory_manager=None, _session_db=db)
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
                                  tools=[], _memory_manager=None, _session_db=db, _interrupted=False)
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
        from agent.tool_executor import _dispatch_authorized_once, _ManagedToolResult, _ToolCallRef
        def forbidden_execute(args):
            raise AssertionError("Care memory writer reached execution")
        results["memory_write"] = json.loads(_dispatch_authorized_once(agent,
            _ManagedToolResult(None, {}, [], False, False),
            _ToolCallRef("memory", {"action": "add", "content": "forbidden care write"}, request["run_id"], "care-write", []),
            execute=forbidden_execute, scope_block=None, display_index=None, begin_execution=None, authorization_gate=None))
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
                    "care_decision": True})
                assert response.status == 202, await response.text()
                accepted = await response.json()
                await asyncio.gather(*adapter._active_run_tasks.values())
                agent.session_id = accepted["session_id"]
                agent.tools = manager.get_all_tool_schemas()
                restrict_agent(agent, launched[0].agent_kwargs["run_scope"])
                agent._native_run_loop = asyncio.get_running_loop()
                await asyncio.to_thread(api_server_runs._run_agent_sync, adapter, launched[0], agent,
                                        lambda event: None, _api_server=api_server)
                return accepted
    try:
        print("PAIOS_CARE_HTTP_PROBE_READY", file=sys.stderr, flush=True)
        accepted = asyncio.run(admit())
        print(json.dumps({"results": results, "isolation": {
            "session_id": agent.session_id, "conversation_session_id": accepted["conversation_session_id"],
            "hidden": db.get_session(agent.session_id)["hidden"],
            "listed_sessions": [row["id"] for row in db.list_sessions_rich()],
            "memory_unchanged": not (home / "memories/MEMORY.md").exists()}}))
    finally:
        manager.shutdown_all(); db.close(); reset_hermes_home_override(token)
    sys.exit(0)
