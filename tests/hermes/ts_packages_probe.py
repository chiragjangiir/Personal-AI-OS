"""Scripted Hermes dispatch -> shared platform MCP -> existing runtime.

The hook supplies the gateway's trusted-context interface for this test.
"""
import json
import os
from pathlib import Path
import signal
import sys
import tempfile


def main():
    signal.alarm(40)
    url, run, session = sys.argv[1:]
    source = Path(os.environ['HERMES_SOURCE'])
    sys.path.insert(0, str(source))
    with tempfile.TemporaryDirectory(prefix='ts-native-probe-') as folder:
        os.environ.update(HERMES_HOME=folder, HERMES_DISABLE_LAZY_INSTALLS='1',
                          HERMES_ENABLE_PROJECT_PLUGINS='0', NO_PROXY='127.0.0.1,localhost',
                          no_proxy='127.0.0.1,localhost')
        import yaml
        config = {'plugins': {'enabled': []}, 'tools': {'tool_search': {'enabled': 'off'}},
                  'mcp_servers': {'platform_ts': {'url': url, 'trust': 'full', 'timeout': 10,
                      'headers': {'Authorization': 'Bearer ' + os.environ['TS_PROBE_INTERNAL_KEY']}}}}
        (Path(folder) / 'config.yaml').write_text(yaml.safe_dump(config))
        from model_tools import get_tool_definitions, handle_function_call
        from tools.mcp_tool_discovery import discover_mcp_tools
        from tools.mcp_tool_lifecycle import shutdown_mcp_servers
        from hermes_cli.plugins import PluginContext, PluginManifest, get_plugin_manager
        from gateway.session_context import set_session_vars, clear_session_vars
        from gateway.run_scope import runtime_scope

        def trusted_context_stub(tool_name, args, tool_call_id='', **fields):
            if tool_name.startswith('mcp__platform_ts__'):
                return {'action': 'modify', 'args': {'_context': {
                    'run_id': run, 'session_id': session, 'tool_call_id': tool_call_id}}}

        ctx = PluginContext(PluginManifest(name='ts-context-fixture'), get_plugin_manager())
        ctx.register_hook('pre_tool_call', trusted_context_stub)
        native = set_session_vars(platform='api_server', session_key=run, session_id=session)
        try:
            with runtime_scope('owner'):
                names = discover_mcp_tools()
                target = 'mcp__platform_ts__paios_l5_locate'
                assert target in names
                schemas = get_tool_definitions(enabled_toolsets=['platform_ts'], quiet_mode=True,
                                               skip_tool_search_assembly=True)
                assert target in [tool['function']['name'] for tool in schemas]
                result = json.loads(handle_function_call(target, {'_context': {'run_id': 'forged'}},
                    session_id=session, tool_call_id='native-ts-call', enabled_tools=list(names), enabled_toolsets=['platform_ts']))
                receipt = result.get('structuredContent') or result.get('result')
                assert receipt['receipt'] == 1 and receipt['status']['state'] == 'succeeded', result
                assert json.loads(receipt['content'][0]['text'])['status'] == 'located'
                print(json.dumps({'registered': target, 'receipt': receipt['status']['state'],
                                  'trusted_context_overrode_model': True}))
        finally:
            clear_session_vars(native)
            shutdown_mcp_servers(timeout=3)
    signal.alarm(0)


if __name__ == '__main__':
    main()
