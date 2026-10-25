"""Real stdio fake + native MCP serialization + documented plugin hooks, against the HTTP gateway."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys

from mcp import ClientSession, StdioServerParameters, stdio_client


async def main(request):
    root = Path(request["root"])
    spec = importlib.util.spec_from_file_location("capability_gateway_plugin", root / "integrations/hermes/yimi_gateway/__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    gateway = plugin.Gateway(request["config"])
    from gateway.session_context import set_session_vars, bind_api_run_conversation, reset_api_run_conversation, clear_session_vars
    from tools.delegate_tool_registry import _register_subagent, _unregister_subagent
    from tools.mcp_tool_handlers import _render_call_tool_result
    from mcp.types import CallToolResult
    tokens = set_session_vars(platform="api_server", session_id=request["session"], session_key=request["run"])
    policy = bind_api_run_conversation(request["run"], request["session"])
    for index, task in enumerate(["fixture-child", "fixture-grandchild"]):
        _register_subagent({"subagent_id": task, "parent_id": "fixture-child" if index else None,
            "owner_agent_session_id": "nested-conversation" if index else request["session"]})
    try:
        if request.get("decide_only"):
            # The gate alone, through the same plugin, HTTP route and admission binding as an executed call.
            fields = {"task_id": "fixture-grandchild", "session_id": request["session"], "tool_call_id": request["call"],
                      "turn_id": "turn-fixture", "api_request_id": ""}
            print(json.dumps({"decision": gateway.pre("mcp__mijia__" + request["tool"], request["args"], **fields)}, ensure_ascii=False))
            return
        params = StdioServerParameters(command=sys.executable,
            args=[str(root / "capability/packages/mijia/fake/server.py")],
            env={**os.environ, "HERMES_HOME": request["home"], "PAIOS_FAKE_MIJIA_LOG": request["home"] + "/calls.jsonl",
                 "PAIOS_FAKE_MIJIA_OUTCOME": request["outcome"]})
        async with stdio_client(params) as (read, write), ClientSession(read, write) as client:
            await client.initialize()
            # Discovery is precondition setup; every fixture's measured tool crosses all production boundaries.
            if request["outcome"] != "login_required":
                await client.call_tool("refresh_devices", {})
            name, args = request["tool"], request["args"]
            identity = "mcp__mijia__" + name
            fields = {"task_id": "fixture-grandchild", "session_id": request["session"],
                "tool_call_id": "call-" + request["outcome"], "turn_id": "turn-fixture", "api_request_id": ""}
            decision = gateway.pre(identity, args, **fields)
            assert decision is None, decision
            raw = await client.call_tool(name, args)
            native = _render_call_tool_result(raw, "mijia")
            fields.update(result=native, status="success", duration_ms=1, error_type=None, error_message=None)
            view = gateway.transform(identity, args, **fields)
            gateway.post(identity, args, **fields)
            assert "gateway_unavailable" not in view, view
            print(json.dumps({"receipt": raw.structured_content, "view": view, "native": native}, ensure_ascii=False))
    finally:
        for task in ["fixture-grandchild", "fixture-child"]:
            _unregister_subagent(task)
        reset_api_run_conversation(policy)
        clear_session_vars(tokens)


if __name__ == "__main__":
    asyncio.run(main(json.loads(Path(sys.argv[1]).read_text())))
