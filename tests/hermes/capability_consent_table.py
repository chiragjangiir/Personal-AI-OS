"""Independent legacy Python dispatch oracle, with TS effectConsent's real responses as input."""
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from gateway.run_scope import tool_block

source = Path(__file__).parents[2] / 'integrations/hermes/personal_aios/effects.py'
spec = importlib.util.spec_from_file_location('legacy_effects', source)
effects = importlib.util.module_from_spec(spec)
spec.loader.exec_module(effects)


def scope_allowed(tool, scope):
    agent = SimpleNamespace(_paios_run_scope=scope if scope not in {'background', 'cron', 'owner_observation', 'background_unattributed'} else 'owner')
    return tool_block(agent, tool) is None


if sys.argv[1] == 'scopes':
    tools = ['send_message', 'phone_task', 'computer_use', 'paios_effect_check']
    print(json.dumps([{'tool': tool, 'scope': scope, 'allowed': scope_allowed(tool, scope)}
        for tool in tools for scope in ['owner', 'owner_observation', 'guest', 'care', 'background', 'background_unattributed', 'cron', 'owner_uncertain', 'build']]))
elif sys.argv[1] == 'batch':
    import model_tools
    from hermes_cli import lifecycle, plugins
    directive = json.load(sys.stdin)
    manager = plugins.PluginManager()
    manager._hooks['pre_tool_call'] = [lambda tool_name, **kw: directive if tool_name == 'pending' else None]
    with patch.object(plugins, '_delivery_manager', return_value=manager), \
         patch.object(lifecycle, 'has_hook', side_effect=lambda name: name == 'pre_tool_call'), \
         patch.object(lifecycle, 'invoke_hook', side_effect=manager.invoke_hook), \
         patch.object(model_tools.registry, 'dispatch', return_value='{"completed":true}'):
        first = json.loads(model_tools.handle_function_call('pending', {}, session_id='session', tool_call_id='pending'))
        second = json.loads(model_tools.handle_function_call('independent', {}, session_id='session', tool_call_id='independent'))
    print(json.dumps({'first': first, 'second': second}))
else:
    result = []
    for case in json.load(sys.stdin):
        if not case['scope_allowed'] or case.get('error'):
            result.append('block')
            continue
        waited = []
        with patch('gateway.session_context.get_api_run_id', return_value=case['context']['run_id']), \
             patch('tools.approval_context.get_current_session_key', return_value='session'), \
             patch('tools.approval._gateway_notify_cb', return_value=None if case['scope'] == 'cron' else lambda value: None), \
             patch('tools.approval_gateway_wait._await_gateway_decision', side_effect=lambda *args: waited.append(True) or {'resolved': False}):
            gate = effects.check_effect(SimpleNamespace(_request=lambda *args: case['legacy']), case['tool'],
                {'effect': case['effect']}, case['context']['session_id'], case['context']['tool_call_id'])
        result.append('approve' if waited else 'block' if effects.blocked(gate) else 'allow')
    print(json.dumps(result))
