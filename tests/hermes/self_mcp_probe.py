"""Deterministic decision fixture -> native Hermes dispatch -> loopback self MCP.

Usage: python self_mcp_probe.py MCP_URL BASE_URL OWNER_RUN SESSION
Requires HERMES_SOURCE and PAIOS_SELF_PROBE_TOKEN. All Hermes state is temporary.
This exercises a scripted model response, not an inference or live-model acceptance.
"""
import json
import os
from pathlib import Path
import signal
import sys
import tempfile


def main():
    signal.alarm(60)
    mcp_url, base_url, run_id, session_id = sys.argv[1:]
    source = Path(os.environ["HERMES_SOURCE"])
    token = os.environ["PAIOS_SELF_PROBE_TOKEN"]
    sys.path[:0] = [str(source), str(Path(__file__).parents[2] / "integrations/hermes")]
    with tempfile.TemporaryDirectory(prefix="paios-self-probe-") as directory:
        home = Path(directory)
        os.environ.update(HERMES_HOME=directory, HERMES_DISABLE_LAZY_INSTALLS="1",
                          HERMES_ENABLE_PROJECT_PLUGINS="0", NO_PROXY="127.0.0.1,localhost")
        os.environ["no_proxy"] = os.environ["NO_PROXY"]
        key = home / "internal.key"
        key.write_text(token)
        key.chmod(0o600)
        import yaml
        config = {"personal_aios": {"internal_base_url": base_url, "internal_key_file": str(key),
                                    "timeout_seconds": 10},
                  "plugins": {"enabled": []}, "tools": {"tool_search": {"enabled": "off"}},
                  "platform_toolsets": {"api_server": ["session_search"]},
                  "mcp_servers": {"self": {"url": mcp_url, "headers": {"Authorization": "Bearer " + token},
                                             "trust": "full", "timeout": 10, "connect_timeout": 10}}}
        (home / "config.yaml").write_text(yaml.safe_dump(config))
        from model_tools import get_tool_definitions, handle_function_call
        from tools.mcp_tool_discovery import discover_mcp_tools
        from tools.mcp_tool_lifecycle import shutdown_mcp_servers
        from hermes_cli.plugins import PluginContext, PluginManifest, get_plugin_manager
        from hermes_cli.tools_config import _get_platform_tools
        from gateway.session_context import set_session_vars, clear_session_vars
        from gateway.run_scope import runtime_scope
        from personal_aios import PersonalAIOSProvider
        from personal_aios.self_tools import register

        provider = PersonalAIOSProvider()
        manager = get_plugin_manager()
        register(PluginContext(PluginManifest(name="self-probe"), manager), provider)
        native = set_session_vars(platform="api_server", session_key=run_id, session_id=session_id)
        try:
            with runtime_scope("owner"):
                discovered = discover_mcp_tools()
                required = {"mcp__self__runtime_query", "mcp__self__runtime_status"}
                assert required <= set(discovered), "self MCP discovery failed"
                toolsets = sorted(_get_platform_tools(config, "api_server"))
                assert "self" in toolsets, "configured MCP was not included in API toolsets"
                catalog = get_tool_definitions(enabled_toolsets=toolsets, quiet_mode=True,
                                               skip_tool_search_assembly=True)
                names = [tool["function"]["name"] for tool in catalog]
                assert required <= set(names), "self tools absent from model catalog"
                # Explicit deterministic model response. The host hook replaces forged claims.
                fixture = {"question": "接了几次通话、多少轮？声纹相似度和记忆数量是多少？",
                           "tool_calls": [{"id": "fixture-query", "function": {
                               "name": "mcp__self__runtime_query", "arguments": json.dumps({
                                   "_context": {"run_id": "forged", "session_id": "forged", "tool_call_id": "forged"}})}},
                               {"id": "fixture-status", "function": {
                                   "name": "mcp__self__runtime_status", "arguments": "{}"}}]}
                results = []
                for call in fixture["tool_calls"]:
                    fn = call["function"]
                    wire = json.loads(handle_function_call(fn["name"], json.loads(fn["arguments"]),
                                      session_id=session_id, tool_call_id=call["id"],
                                      enabled_tools=names, enabled_toolsets=toolsets))
                    assert "error" not in wire, wire
                    value = wire["result"]
                    results.append(json.loads(value) if isinstance(value, str) else value)
                query, status = results
                assert query["schema"] == "paios.self.metrics.v1"
                assert status["schema"] == "paios.self.status.v1"
                assert query["calls"] >= 1 and query["turns"] >= 1
                scores = {channel: data["scores"]["mean"] for channel, data in query["speakers"].items()
                          if data["scores"]["samples"] > 0}
                assert scores, "seed at least one speaker verdict with a similarity score"
                answer = (f"保留事件内通话 {query['calls']} 次，{query['turns']} 轮；"
                          f"声纹相似度均值 {json.dumps(scores, ensure_ascii=False)}；"
                          f"L4 最近可见会话 {status['l4']['sessions']} 个，统计未覆盖全部会话。没有人工标注，无法计算准确率。")
                assert "无法计算准确率" in answer
                print(json.dumps({"fixture": "deterministic model tool decision; no inference", "discovered": sorted(required),
                                  "api_toolset_includes_self": True, "query": query, "status": status,
                                  "answer": answer}, ensure_ascii=False))
        finally:
            clear_session_vars(native)
            shutdown_mcp_servers(timeout=3)
    signal.alarm(0)


if __name__ == "__main__":
    main()
