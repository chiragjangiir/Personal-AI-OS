"""Opt-in real-model, real-native delegated child, package MCP and production gateway hooks."""
import json
import os
from pathlib import Path
import sys

from capability_model import configure, brain


def main(request):
    root, home = Path(request["root"]), Path(request["home"]) / "native-home"
    config = configure(home, request["model_key_file"], {
        "plugins": {"enabled": ["yimi-gateway"]},
        "personal_aios": {**request["config"], "delegated_toolsets": ["mcp-mijia"]},
        "mcp_servers": {"mijia": {"command": sys.executable,
            "args": [str(root / "capability/packages/mijia/fake/server.py")],
            "env": {"HERMES_HOME": str(home), "PAIOS_FAKE_MIJIA_LOG": str(home / "fake.jsonl")},
            "timeout": 30, "trust": "full"}},
        "platform_toolsets": {"api_server": ["delegation", "mcp-mijia"]},
    })
    (home / "plugins").mkdir()
    (home / "plugins/yimi_gateway").symlink_to(root / "integrations/hermes/yimi_gateway", target_is_directory=True)
    from hermes_cli.plugins import get_plugin_manager
    manager = get_plugin_manager()
    manager.discover_and_load()
    assert {"pre_tool_call", "transform_tool_result", "post_tool_call"} <= {name for name, hooks in manager._hooks.items() if hooks}
    from tools.mcp_tool_discovery import discover_mcp_tools
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers
    discover_mcp_tools()
    captured = []
    def capture(**fields):
        if fields["tool_name"].startswith("mcp__mijia__"):
            captured.append(fields)
    manager._hooks.setdefault("post_tool_call", []).append(capture)
    from gateway.session_context import set_session_vars, clear_session_vars, bind_api_run_conversation, reset_api_run_conversation
    from gateway.run_scope import restrict_agent
    from tools.delegate_tool import delegate_task
    tokens = set_session_vars(platform="api_server", session_id=request["session"], session_key=request["run"])
    policy = bind_api_run_conversation(request["run"], request["session"])
    parent = brain(config, tools=["delegation", "mcp-mijia"], session=request["session"], max_tokens=None)
    parent._paios_tool_conversation = request["session"]
    restrict_agent(parent, "owner")
    try:
        result = json.loads(delegate_task(goal="请用米家工具发现设备，然后只读取空调的真实状态并报告数值。所有设备都是隔离的假设备。不要控制设备，不要修改任何文件，不要调用其他工具。",
            background=False, parent_agent=parent))
        reads = [row for row in captured if row["tool_name"] == "mcp__mijia__read_device"]
        assert reads, {"result": result, "tools": [row["tool_name"] for row in captured]}
        native_result = reads[-1]["result"]
        try:
            raw = json.loads(native_result)
        except json.JSONDecodeError:
            raw = json.loads(native_result.rsplit("\n", 1)[-1])
        raw = raw.get("structuredContent", raw.get("result", raw))
        if isinstance(raw, str):
            raw = json.loads(raw)
        assert raw["receipt"] == 1 and raw["values"]
        print(json.dumps({"receipt": raw, "view": json.dumps(result, ensure_ascii=False),
            "tools": [row["tool_name"] for row in captured], "task_ids": [row["task_id"] for row in captured],
            "native_tree": "77a0d12ae462786ffdeb88dbdee18de2239277ed",
            "model": config["model"]}, ensure_ascii=False))
    finally:
        parent.close()
        shutdown_mcp_servers()
        reset_api_run_conversation(policy)
        clear_session_vars(tokens)


if __name__ == "__main__":
    main(json.loads(Path(sys.argv[1]).read_text()))
