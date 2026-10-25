"""The Mac packages reuse native scopes, transports and the receipt contract offline."""
import importlib.util
import json
import os
from pathlib import Path
import select
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import jsonschema
import pytest

ROOT = Path(__file__).parents[2]
PACKAGE = ROOT / 'capability/packages/owner-mac'
spec = importlib.util.spec_from_file_location('tested_mac_package', PACKAGE / 'server/__init__.py',
    submodule_search_locations=[str(PACKAGE / 'server')])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from tested_mac_package.receipts import POLICIES, convert, exception_result, mcp_result
from tested_mac_package.package_server import create_server, selected_server

CASES = json.loads((PACKAGE / 'tests/contract.yaml').read_text())['cases']
SCHEMA = json.loads((ROOT / 'capability/contracts/receipt.v1.schema.json').read_text())
validate = jsonschema.Draft202012Validator(SCHEMA, format_checker=jsonschema.FormatChecker()).validate


@pytest.mark.parametrize('item', CASES, ids=lambda item: item['id'])
def test_owner_mac_result_mapping(item):
    body = convert(item['tool'], item['args'], item['raw'], at='2026-10-24T00:00:00Z')
    validate(body)
    assert body['status']['state'] == item['expect']['state']
    assert body['next']['retry'] == item['expect']['retry']
    if 'verification' in item['expect']:
        assert body['effects'][0]['verification'] == item['expect']['verification']
    if body['status']['state'] == 'unknown':
        assert body['next']['check_with']
    result = mcp_result(item['tool'], item['args'], item['raw'])
    assert len(result['content']) == 1 and result['content'][0]['type'] == 'text'


@pytest.mark.parametrize('error,state', [(TimeoutError('secret'), 'unknown'), (ConnectionError('secret'), 'unknown'),
    (RuntimeError('secret'), 'unknown'), (PermissionError('secret'), 'failed'), (ValueError('secret'), 'failed')])
def test_exception_does_not_claim_failure_or_expose_diagnostics(error, state):
    result = exception_result('put', error)
    validate(result['structuredContent'])
    assert result['structuredContent']['status']['state'] == state
    assert 'secret' not in json.dumps(result)


@pytest.mark.asyncio
async def test_real_package_wraps_original_mcp_server_without_network(monkeypatch):
    from contextlib import contextmanager
    from integrations.hermes.personal_aios import owner_mac
    env = Mock()
    env.execute.return_value = {'output': '/Users/owner', 'returncode': 0}
    @contextmanager
    def environment(context, device):
        assert context == CASES[0]['args']['context'] and device == ''
        yield env
    monkeypatch.setattr(owner_mac, 'environment', environment)
    server = create_server()
    tools = await server.list_tools()
    assert {tool.name for tool in tools} == set(POLICIES)
    for tool in tools:
        assert 'effect' not in tool.input_schema['properties']
        assert 'owner_requested' in tool.input_schema['properties']
    result = await server.call_tool('exec', {**CASES[0]['args'], 'owner_requested': True})
    validate(result.structured_content)
    assert result.structured_content['status']['state'] == 'succeeded'
    env.execute.assert_called_once_with('pwd', cwd='', timeout=60, bounded_capture=True)


@pytest.mark.asyncio
async def test_native_computer_transport_gets_bound_context_and_no_model_effect():
    from integrations.hermes.personal_aios.owner_mac import create_server as legacy_server
    computer = Mock(return_value={'ok': True, 'verified': False})
    server = create_server(legacy=legacy_server(), computer=computer)
    args = {**CASES[5]['args'], 'action': 'click', 'owner_requested': True}
    result = await server.call_tool('computer_use', args)
    assert result.structured_content['status']['state'] == 'unknown'
    assert 'effect' not in computer.call_args.args[0] and 'owner_requested' not in computer.call_args.args[0]
    assert computer.call_args.kwargs == {'session_id': 'session', 'tool_call_id': 'call'}
    computer.reset_mock()
    denied = await server.call_tool('computer_use', {**args, 'effect': {'kind': 'payment'}})
    assert denied.structured_content['status']['state'] == 'failed'
    computer.assert_not_called()


def test_multimodal_cua_keeps_image_and_exactly_one_text_content():
    result = mcp_result('computer_use', CASES[5]['args'], {'_multimodal': True, 'text_summary': 'screen',
        'meta': {'width': 8, 'height': 8}, 'content': [{'type': 'text', 'text': 'screen'},
        {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,AAAA'}}]})
    assert result['content'][1] == {'type': 'image', 'mimeType': 'image/png', 'data': 'AAAA'}
    assert [item['type'] for item in result['content']].count('text') == 1
    validate(result['structuredContent'])


@pytest.mark.parametrize('admission,scope,grants', [('owner', 'owner', ['desktop']), ('owner-ungranted', 'owner', []),
    ('guest', 'guest', []), ('care', 'care', []), ('background', 'owner', []), ('cron', 'owner', ['desktop'])])
def test_desktop_manifest_identities_retain_the_native_admission_table(admission, scope, grants):
    from gateway.run_scope import bind_action_grants, tool_block
    manifest = json.loads((ROOT / 'capability/packages/desktop/plugin.json').read_text())['extensions']['ai.yimi.capability']
    old = SimpleNamespace(_paios_run_scope=scope if scope in {'guest', 'care'} else None)
    new = SimpleNamespace(**old.__dict__)
    config = {'personal_aios': {'grantable_toolsets': ['desktop']}}
    bind_action_grants(old, grants, config);bind_action_grants(new, grants, config)
    wire = json.loads((ROOT / 'integrations/contracts/desktop-tools.v1.json').read_text())['tools']
    assert set(manifest['tools']) == {tool['name'] for tool in wire}
    for tool in wire:
        before = tool_block(old, 'mcp__desktop__' + tool['name'])
        after = tool_block(new, 'mcp__' + manifest['runtime']['server'] + '__' + tool['name'])
        assert after == before


@pytest.mark.parametrize('admission,scope', [('owner', 'owner'), ('guest', 'guest'), ('care', 'care'),
    ('background', 'owner'), ('cron', 'owner')])
def test_owner_mac_binding_equivalence_for_every_package_tool(monkeypatch, admission, scope):
    from integrations.hermes.personal_aios import owner_mac_tools
    import gateway.run_scope
    import gateway.session_context
    monkeypatch.setattr(gateway.run_scope, 'current_scope', lambda: scope)
    monkeypatch.setattr(gateway.session_context, 'get_api_run_id', lambda session: 'actual-run')
    ctx = Mock()
    owner_mac_tools.register(ctx)
    bind = ctx.register_hook.call_args.args[1]
    args = {'context': {'run_id': 'spoof'}}
    for name in POLICIES:
        old = 'computer_use' if name == 'computer_use' else 'mcp__owner_mac__' + name
        new = 'mcp__owner_mac__' + name
        before = bind(old, args, session_id='session', tool_call_id='call')
        after = bind(new, args, session_id='session', tool_call_id='call')
        assert after == before
        assert after['action'] == ('modify' if scope == 'owner' else 'block')


def test_catalog_enabled_computer_package_closes_the_legacy_bypass():
    from integrations.hermes.personal_aios import owner_mac_tools
    ctx = Mock()
    provider = SimpleNamespace(owner_mac_enabled=True, capability_tools={'mcp__owner_mac__computer_use'})
    owner_mac_tools.register(ctx, provider)
    assert not ctx.register_tool.called
    hook = ctx.register_hook.call_args.args[1]
    assert hook('computer_use', {})['action'] == 'block'


@pytest.mark.asyncio
async def test_owner_mac_catalog_off_keeps_the_original_five_tools_and_raw_result(monkeypatch):
    from contextlib import contextmanager
    from integrations.hermes.personal_aios import owner_mac
    @contextmanager
    def environment(context, device):
        yield SimpleNamespace(execute=lambda *args, **kwargs: {'returncode': 0, 'output': '/Users/owner'})
    monkeypatch.setattr(owner_mac, 'environment', environment)
    old = selected_server(set())
    assert {tool.name for tool in await old.list_tools()} == set(POLICIES) - {'computer_use'}
    result = await old.call_tool('exec', CASES[0]['args'])
    assert json.loads(result.content[0].text) == {'returncode': 0, 'output': '/Users/owner'}
    current = selected_server({'mcp__owner_mac__computer_use'})
    assert {tool.name for tool in await current.list_tools()} == set(POLICIES)
    assert (await current.call_tool('exec', CASES[0]['args'])).structured_content['receipt'] == 1


def test_package_imports_work_under_hermes_nonstandard_provider_namespace(monkeypatch):
    from integrations.hermes.personal_aios import owner_mac_computer
    assert owner_mac_computer.execute.__module__.endswith('personal_aios.owner_mac_computer')
    assert {item['tool'] for item in CASES} == set(POLICIES)


@pytest.mark.parametrize('name,server', [('desktop', 'desktop'), ('owner-mac', 'owner_mac')])
def test_native_portable_loader_discovers_skills_and_mcp_without_diagnostics(tmp_path, name, server):
    from hermes_cli.agent_plugins import load_agent_plugin
    package = load_agent_plugin(ROOT / 'capability/packages' / name, tmp_path / name)
    assert not package.diagnostics
    assert set(package.mcp_servers) == {server}
    assert len(package.skills) == 1
    if name == 'owner-mac':
        assert package.mcp_servers[server]['args'] == [str(PACKAGE / 'server/main.py')]


@pytest.mark.parametrize('name,command', [('desktop', [sys.executable, 'fake/server.py']),
    ('owner-mac', [sys.executable, 'fake/server.py'])])
def test_fake_stdio_package_has_the_same_tools_and_valid_receipts(name, command):
    directory = ROOT / 'capability/packages' / name
    cases = json.loads((directory / 'tests/contract.yaml').read_text())['cases']
    env = {key: item for key, item in os.environ.items() if key != 'NODE_OPTIONS'}
    child = subprocess.Popen(command, cwd=directory, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True)
    records = []
    def request(method, params, number):
        child.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': number, 'method': method, 'params': params}) + '\n')
        child.stdin.flush()
        assert select.select([child.stdout], [], [], 30)[0], 'MCP server did not respond'
        line = child.stdout.readline()
        assert line, child.stderr.read()
        result = json.loads(line)
        assert result.get('id') == number and 'error' not in result, result
        return result['result']
    try:
        request('initialize', {'protocolVersion': '2025-11-25', 'capabilities': {},
                              'clientInfo': {'name': 'offline-contract', 'version': '1'}}, 0)
        child.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n');child.stdin.flush()
        tools = request('tools/list', {}, 1)['tools']
        assert {tool['name'] for tool in tools} == {item['tool'] for item in cases}
        for number, tool in enumerate(tools, 2):
            fixture = next(item for item in cases if item['tool'] == tool['name'])
            result = request('tools/call', {'name': tool['name'], 'arguments': fixture['args']}, number)
            validate(result['structuredContent'])
            assert result['structuredContent']['status']['state'] == 'succeeded'
            assert len(result['content']) == 1 and result['content'][0]['type'] == 'text'
            records.append({'fixture': fixture['id'], 'tool': tool['name'], 'args': fixture['args'], 'result': result})
        if os.environ.get('PAIOS_MAC_RECORDINGS'):
            (Path(os.environ['PAIOS_MAC_RECORDINGS']) / (name + '-stdio-records.json')).write_text(json.dumps(records, ensure_ascii=False, indent=2))
    finally:
        child.stdin.close()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.terminate();child.wait(timeout=10)
        child.stdout.close();child.stderr.close()
