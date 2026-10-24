"""Fixture chain: native cron -> admission -> native tool -> durable watch -> delivery."""
import asyncio
import importlib
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


def exercise(home, *, mcp=False, message="包裹到了"):
    from cron.jobs import claim_job_for_fire, get_job
    from cron.scheduler import run_one_job
    from gateway.config import Platform, PlatformConfig
    from gateway.platform_registry import PlatformEntry, platform_registry
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from tools.registry import registry
    from personal_aios import cron
    from run_agent import AIAgent

    owner = {"principal_id": "owner", "device_id": "phone", "allow_owner_mutation": True,
             "allow_reasoning_create": True, "origin_processed_event_id": "d:watch-owner"}
    current = dict(owner)
    calls, tasks, attempts, handlers = [], [], [], {}
    state = ["pending"]
    lose_ack = [True]
    query_name = 'mcp__phone__parcel_status' if mcp else 'fixture_parcel_query'
    if mcp:
        from mcp.server import MCPServer
        from tools.mcp_tool_handlers import _render_call_tool_result
        server = MCPServer('phone')
        @server.tool()
        def parcel_status() -> dict:
            return {'status': state[0]}

    def request(path, body):
        if path.endswith("schedule-context"):
            return current
        if path.endswith("scheduled-task"):
            tasks.append(body)
            current.update(scheduled_job_id=body["job_id"], scheduled_occurrence_id=body["occurrence_id"],
                           scheduled_captured_at=body["captured_at"], allow_owner_mutation=False,
                           allow_reasoning_create=False)
            return {"status": "admitted"}
        if path.endswith("scheduled-delivery"):
            attempts.append(body)
            if lose_ack[0]:
                lose_ack[0] = False
                raise OSError("fixture lost delivery ACK after downstream acceptance")
            return {"status": "delivered"}
        return {"status": "synced"}

    def register_tool(name, toolset, schema, handler, **kw):
        handlers[name] = handler
        registry.register(name=name, toolset=toolset, schema=schema, handler=handler)
        return True

    def query(args, **kwargs):
        calls.append(args)
        if mcp:
            return _render_call_tool_result(asyncio.run(server.call_tool('parcel_status', {})), 'phone')
        return json.dumps({"status": state[0]})

    ctx = SimpleNamespace(register_tool=register_tool,
        register_platform=lambda name, label, factory, check, **kw: platform_registry.register(
            PlatformEntry(name=name, label=label, adapter_factory=factory, check_fn=check, **kw)),
        register_platform_handler=lambda *a, **kw: None)
    token = set_hermes_home_override(Path(home))
    try:
        cron.register(ctx, SimpleNamespace(_request=request))
        schema = {"name": query_name, "description": "Synthetic query", "parameters": {"type": "object", "properties": {}}}
        register_tool(query_name, "cronjob", schema, query)
        definitions = [{"type": "function", "function": registry.get_schema(name)} for name in ("paios_watch_check", query_name)]
        with patch("model_tools.get_tool_definitions", return_value=definitions), patch("model_tools.check_toolset_requirements", return_value={}), patch("agent.process_bootstrap.OpenAI"):
            agent = AIAgent(api_key="fixture-unused-key", base_url="https://fixture.invalid/v1", quiet_mode=True,
                            skip_context_files=True, skip_memory=True)
        prompt, skills = "Run paios_watch_check for the saved watch", ["fixture-watch"]
        created = json.loads(handlers["cronjob_manage"]({"action": "create", "schedule": "every 5m",
            "prompt": prompt, "skills": skills,
            "standing_watch": {"query_tool": query_name, "query_args": {"tracking_id": "fixture"},
                               "status_field": "status", "from_status": "pending", "to_status": "arrived", "message": message}}))
        assert created["success"], created
        job_id = created["job_id"]
        Path(home, "config.yaml").write_text('cron: {wrap_response: false}\nplatforms: {personal_aios: {enabled: true}}\n')

        async def fire():
            adapter = platform_registry.create_adapter("personal_aios", PlatformConfig(enabled=True))
            claimed = claim_job_for_fire(job_id, manual=True, return_job=True)
            assert await asyncio.to_thread(run_one_job, claimed, adapters={Platform("personal_aios"): adapter}, loop=asyncio.get_running_loop())
            from agent.tool_executor import _run_agent_tool_execution_middleware
            outcome = await asyncio.to_thread(_run_agent_tool_execution_middleware, agent, function_name="paios_watch_check", function_args={},
                effective_task_id=agent.session_id, tool_call_id="watch-check", execute=lambda args:
                    agent._invoke_tool("paios_watch_check", args, agent.session_id, tool_call_id="watch-check",
                        pre_tool_block_checked=True, skip_tool_request_middleware=True, skip_tool_execution_middleware=True))
            return json.loads(outcome.result)

        observed = asyncio.run(fire())
        assert observed.get("status") == "silent", observed
        assert asyncio.run(fire())["status"] == "silent"
        state[0] = "arrived"
        failed = asyncio.run(fire())
        assert failed.get("error"), failed
        assert get_job(job_id)["standing_watch"]["pending"] == attempts[0]
        # Reload adapter and native job reads; only the durable pending observation survives.
        import personal_aios.watch as watch
        importlib.reload(watch)
        cron.register(ctx, SimpleNamespace(_request=request))
        assert asyncio.run(fire())["status"] == "delivered"
        assert asyncio.run(fire())["status"] == "silent"
        assert attempts[0] == attempts[1] and len(attempts) == 2
        assert len(calls) == 4 and get_job(job_id)["standing_watch"]["delivered_sequence"] == 1
        # A standing watch keeps observing after delivery; the next transition gets its own receipt.
        state[0] = "pending"
        assert asyncio.run(fire())["status"] == "silent"
        state[0] = "arrived"
        assert asyncio.run(fire())["status"] == "delivered"
        assert asyncio.run(fire())["status"] == "silent"
        assert len(calls) == 7 and len(attempts) == 3
        assert attempts[2]["id"] != attempts[0]["id"]
        assert get_job(job_id)["standing_watch"]["delivered_sequence"] == 2
        assert len(tasks) == len({task["occurrence_id"] for task in tasks}) == 8
        assert all(task["prompt"] == prompt and task["skills"] == skills for task in tasks)
        return {"tasks": tasks, "deliveries": attempts, "query_calls": len(calls), "restarted": True,
                "state": get_job(job_id)["standing_watch"]}
    finally:
        platform_registry.unregister("personal_aios")
        reset_hermes_home_override(token)


if __name__ == "__main__":
    import sys
    print("WATCH_RESULT=" + json.dumps(exercise(sys.argv[1]), ensure_ascii=False))
