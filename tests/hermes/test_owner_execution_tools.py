"""Shipped execution skills must agree with the native delegated tool authority."""
import json
import re
import subprocess
from types import SimpleNamespace

import pytest

from test_cloud_init import INTEGRATION, PRODUCT_CONFIG, cloud, home, load
from test_effect_gate import effects, gate


@pytest.fixture(scope='module')
def schemas():
    source = INTEGRATION.parents[2] / '01-product-half-finished/backend/services/personal-aios-integration/src/tool-contracts.ts'
    script = ('const {enabledToolSchemas}=await import(process.argv[1]);'
              'process.stdout.write(JSON.stringify(enabledToolSchemas({memory:true,actions:true,ambient:true,'
              'visual:true,voiceprint:true,health:true,contacts:true,places:true,movement:true,desktop_queue:true})));')
    result = subprocess.run(['node', '--input-type=module', '-e', script, source.as_uri()],
                            capture_output=True, text=True, check=True, timeout=15)
    return json.loads(result.stdout)


@pytest.fixture(params=['production', 'staging'])
def execution(request, home, monkeypatch, schemas, gate):
    from agent.memory_manager import inject_memory_provider_tools
    from gateway.run_scope import restrict_agent
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from tools.delegate_tool_toolsets import _resolve_child_toolsets
    from tools.registry import registry
    from toolsets import TOOLSETS, resolve_toolset

    if request.param == 'staging':
        monkeypatch.setenv('PAIOS_STAGE', 'staging')
    (cloud.SECRETS / 'agentbay.key').write_text('synthetic-no-network')
    cloud.initialize(home, INTEGRATION, PRODUCT_CONFIG)
    config = load(home)
    token = set_hermes_home_override(home)
    monkeypatch.syspath_prepend(str(INTEGRATION.parent))
    registrations = []

    def register_tool(name, toolset, schema, handler, **kwargs):
        previous = registry.snapshot_registration(name)
        registry.register(name=name, toolset=toolset, schema=schema, handler=handler, override=True)
        registrations.append((name, registry.snapshot_registration(name), previous))
        return registrations[-1][1]

    try:
        effects.register(SimpleNamespace(register_tool=register_tool, register_hook=lambda *args: None,
                                         register_middleware=lambda *args: None), gate.provider)
        from personal_aios.owner_mac_tools import register as register_owner_mac
        monkeypatch.setattr(gate.provider, 'owner_mac_enabled', 'owner_mac' in config['mcp_servers'], raising=False)
        register_owner_mac(SimpleNamespace(register_tool=register_tool, register_hook=lambda *args: None), gate.provider)
        parent = SimpleNamespace(_paios_delegate_toolsets=config['personal_aios']['delegated_toolsets'],
            enabled_toolsets=config['platform_toolsets']['api_server'],
            disabled_toolsets=config['agent'].get('disabled_toolsets', []))
        enabled, disabled = _resolve_child_toolsets(parent, None, 'leaf')
        names = {name for toolset in enabled for name in resolve_toolset(toolset)}
        names -= {name for toolset in disabled for name in resolve_toolset(toolset)}
        child = SimpleNamespace(platform='subagent', _delegate_depth=1, enabled_toolsets=enabled,
            disabled_toolsets=disabled, _paios_delegate_toolsets=parent._paios_delegate_toolsets,
            _paios_tool_conversation='owner-fixture', tools=[{'type': 'function', 'function': {'name': name}}
                                                         for name in names],
            _memory_manager=SimpleNamespace(get_all_tool_schemas=lambda: schemas))
        inject_memory_provider_tools(child, inherit_from=parent)
        restrict_agent(child, 'owner')
        native_names = {name for toolset in TOOLSETS for name in resolve_toolset(toolset)}
        yield SimpleNamespace(config=config, enabled=enabled, disabled=disabled, child=child,
            native_names=native_names | {schema['name'] for schema in schemas}, registry=registry, parent=parent)
    finally:
        for registration in reversed(registrations):
            assert registry.restore_registration(*registration)
        reset_hermes_home_override(token)


def test_every_execution_skill_has_its_required_tools(execution):
    # Shared-memory writes and backlog/delegation management belong to the main agent.
    # send_message is an optional channel transport; the Mac route requires the explicit gate.
    main_or_optional = {'memory', 'delegate_task', 'clarify', 'send_message',
                        'kanban_create', 'kanban_list', 'kanban_show'}
    skills = [*INTEGRATION.glob('errands/*/SKILL.md'), *INTEGRATION.glob('shared-skills/*/SKILL.md')]
    missing = {}
    for path in skills:
        text = path.read_text()
        words = set(re.findall(r'\b[a-z][a-z0-9_]*\b', text))
        required = (words & execution.native_names) | set(re.findall(r'\bpaios_[a-z_]+\b', text))
        if path.parent.name == 'code-batch-operation':
            required.add('todo_list')  # The skill uses the native toolset name "todo".
        absent = required - main_or_optional - execution.child.valid_tool_names
        if absent:
            missing[str(path.relative_to(INTEGRATION))] = sorted(absent)
        for server, mentioned in [('owner_mac', 'owner_mac' in text), ('desktop', 'mcp__desktop__' in text),
                                  ('phone', any(word.startswith('phone_') for word in words)),
                                  ('mijia', path.parent.name == 'mijia')]:
            if mentioned:
                assert server in execution.config['mcp_servers'], (path, server)
                assert server in execution.enabled and server not in execution.disabled, (path, server)
    assert not missing
    assert 'memory' not in execution.child.valid_tool_names
    assert 'paios_effect_check' in execution.child.valid_tool_names
    assert ('send_message' in execution.child.valid_tool_names) == ('messaging' in execution.enabled
                                                                  and 'messaging' not in execution.disabled)


def test_wechat_execution_child_uses_the_existing_consent_authority(execution, gate):
    from tools.delegate_tool_toolsets import _resolve_child_toolsets
    from toolsets import resolve_toolset
    enabled, disabled = _resolve_child_toolsets(execution.parent, ['owner_mac', 'skills', 'vision', 'effects'], 'leaf')
    narrowed = {name for toolset in enabled for name in resolve_toolset(toolset)}
    narrowed -= {name for toolset in disabled for name in resolve_toolset(toolset)}
    assert 'paios_effect_check' in narrowed and 'memory' not in narrowed
    assert 'paios_effect_check' in execution.child.valid_tool_names
    handler = execution.registry.get_entry('paios_effect_check').handler
    effect = {'kind': 'send', 'recipient': 'wechat:fixture_account', 'task_type': 'wechat_send_file',
              'requested': True, 'summary': 'fixture.xlsx'}
    first = json.loads(handler({'effect': effect}, session_id='child-one', tool_call_id='send-file-one'))
    assert first['allowed'] is True and first['approval']['reused'] is False
    assert gate.calls[-1]['context'] == {'run_id': 'run-one', 'session_id': 'child-one',
                                        'tool_call_id': 'send-file-one'}
    assert gate.calls[-1]['effect'] == effect
    gate.run = 'run-two'
    again = json.loads(handler({'effect': effect}, session_id='child-two', tool_call_id='send-file-two'))
    assert again == {'allowed': True, 'approval': {**first['approval'], 'reused': True}}
    assert len(gate.prompts) == len(gate.records) == 1
    for changed in ({'recipient': 'wechat:another_fixture'}, {'task_type': 'wechat_send_text'}):
        assert json.loads(handler({'effect': {**effect, **changed}}, session_id='child-two'))['allowed'] is True
    assert len(gate.prompts) == len(gate.records) == 3


@pytest.mark.parametrize('refusal', ['denied', 'unavailable', 'unverified_owner'])
def test_wechat_child_cannot_obtain_consent_after_refusal(execution, gate, monkeypatch, refusal):
    from tools import approval_gateway_wait
    if refusal == 'denied':
        monkeypatch.setattr(approval_gateway_wait, '_await_gateway_decision',
                            lambda *args: {'resolved': True, 'choice': 'deny'})
    elif refusal == 'unavailable':
        gate.provider._request.side_effect = ConnectionError('synthetic unavailable')
    else:
        gate.owner = False
    handler = execution.registry.get_entry('paios_effect_check').handler
    result = json.loads(handler({'effect': {'kind': 'send', 'recipient': 'wechat:fixture_account',
        'task_type': 'wechat_send_file', 'requested': True}}, session_id='child-one', tool_call_id='send-file'))
    assert result['allowed'] is False
    assert not gate.records


@pytest.mark.parametrize('scope', ['guest', 'owner_uncertain', 'care', 'build'])
def test_effect_tool_visibility_preserves_admitted_scope(execution, scope):
    from gateway.run_scope import restrict_agent, tool_block
    restrict_agent(execution.child, scope)
    assert 'paios_effect_check' not in execution.child.valid_tool_names
    assert tool_block(execution.child, 'paios_effect_check')
