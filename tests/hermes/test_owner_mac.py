"""Pairing selection, native SSH contract and cleanup at the owner Mac boundary."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

ROOT = Path(__file__).parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'integrations/hermes/personal_aios' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_live_device_selection_and_cleanup_after_remote_failure(monkeypatch, tmp_path):
    worker = load('owner_mac')
    context = {'run_id': 'run', 'session_id': 'session', 'tool_call_id': 'call'}
    resolver = Mock(side_effect=[dict(device_id='mac_a', ssh_user='alice', home='/Users/alice', visitor_port=22001),
                                PermissionError('pair revoked')])
    monkeypatch.setattr(worker, 'resolve', resolver)
    monkeypatch.setenv('PAIOS_OWNER_MAC_ROOT', str(tmp_path))
    env = Mock()
    factory = Mock(return_value=env)
    monkeypatch.setattr(worker, 'SSHEnvironment', factory)
    with pytest.raises(RuntimeError, match='remote interrupted'):
        with worker.environment(context, 'mac_a'):
            raise RuntimeError('remote interrupted')
    env.cleanup.assert_called_once()
    options = factory.call_args.kwargs
    assert options['user'] == 'alice' and options['cwd'] == '/Users/alice'
    assert options['terminal_config'] == {
        'ssh_isolated': False, 'ssh_forward_credentials': False, 'ssh_sync': False,
        'ssh_shared_connection': False, 'ssh_known_hosts': str(tmp_path / 'mac_a/known_hosts'),
        'ssh_host_key_alias': 'owner-mac-mac_a'}
    with pytest.raises(PermissionError):
        with worker.environment(context, 'mac_a'):
            pytest.fail('revoked device must never open SSH')
    assert factory.call_count == 1
    assert resolver.call_args.args == (context, 'mac_a')


def test_hook_overwrites_model_identity_and_blocks_unbound_scope(monkeypatch):
    import gateway.run_scope
    import gateway.session_context
    hook_module = load('owner_mac_tools')
    ctx = Mock()
    hook_module.register(ctx)
    hook = ctx.register_hook.call_args.args[1]
    monkeypatch.setattr(gateway.run_scope, 'current_scope', lambda: 'owner')
    monkeypatch.setattr(gateway.session_context, 'get_api_run_id', lambda _: 'actual-run')
    args = {'command': 'pwd', 'device_id': 'selected', 'context': {'run_id': 'spoof'}}
    result = hook('mcp__owner_mac__exec', args, session_id='session', tool_call_id='call')
    assert result['args'] == {**args, 'context': {'run_id': 'actual-run', 'session_id': 'session', 'tool_call_id': 'call'}}
    assert hook('computer_use', args, session_id='session', tool_call_id='call')['args']['context'] == result['args']['context']
    monkeypatch.setattr(gateway.run_scope, 'current_scope', lambda: 'build')
    assert hook('mcp__owner_mac__write', args, session_id='session', tool_call_id='call')['action'] == 'block'
    assert hook('computer_use', args, session_id='session', tool_call_id='call')['action'] == 'block'
    monkeypatch.setattr(gateway.run_scope, 'current_scope', Mock(side_effect=RuntimeError('scope unavailable')))
    assert hook('mcp__owner_mac__exec', args)['action'] == 'block'
    assert hook('mcp__other__exec', args) is None


def test_mac_android_uses_the_same_native_run_binding(monkeypatch):
    import gateway.run_scope
    import gateway.session_context
    hook_module = load('owner_mac_tools')
    ctx = Mock()
    hook_module.register(ctx)
    hook = ctx.register_hook.call_args.args[1]
    monkeypatch.setenv('PAIOS_PHONE_PROVIDER', 'mac-android')
    monkeypatch.setattr(gateway.run_scope, 'current_scope', lambda: 'owner')
    monkeypatch.setattr(gateway.session_context, 'get_api_run_id', lambda _: 'bound-run')
    for name in ('phone_task', 'phone_status', 'phone_start', 'phone_control_link'):
        for tool in (name, 'mcp__phone__' + name):
            result = hook(tool, {'context': {'run_id': 'spoof'}}, session_id='s', tool_call_id='c')
            assert result['args']['context'] == {'run_id': 'bound-run', 'session_id': 's', 'tool_call_id': 'c'}
    monkeypatch.setattr(gateway.run_scope, 'current_scope', lambda: 'build')
    assert hook('mcp__phone__phone_start', {}, session_id='s', tool_call_id='c')['action'] == 'block'
    monkeypatch.setenv('PAIOS_PHONE_PROVIDER', 'off')
    assert hook('mcp__phone__phone_status', {}) is None


@pytest.mark.asyncio
async def test_mcp_server_publishes_invocable_tools(monkeypatch):
    from contextlib import contextmanager
    worker = load('owner_mac')
    env = Mock()
    env.execute.return_value = {'output': '/Users/alice', 'returncode': 0}
    @contextmanager
    def environment(context, device_id):
        assert context == {'run_id': 'bound'} and device_id == 'mac_a'
        yield env
    monkeypatch.setattr(worker, 'environment', environment)
    server = worker.create_server()
    schemas = await server.list_tools()
    assert {t.name for t in schemas} == {'exec', 'read', 'write', 'fetch', 'put'}
    result = await server.call_tool('exec', {'command': 'pwd', 'context': {'run_id': 'bound'}, 'device_id': 'mac_a'})
    assert not result.is_error
    assert json.loads(result.content[0].text) == {'output': '/Users/alice', 'returncode': 0}
    env.execute.assert_called_once_with('pwd', cwd='', timeout=60, bounded_capture=True)


@pytest.mark.asyncio
async def test_files_cross_without_entering_the_conversation(monkeypatch, tmp_path):
    import base64
    from contextlib import contextmanager
    worker = load('owner_mac')
    png = bytes(range(256)) * 40
    env = Mock()
    env.execute.side_effect = [{'output': base64.b64encode(png).decode() + '\n', 'returncode': 0},
                               {'output': '', 'returncode': 1},
                               {'output': f'{len(png)}\n', 'returncode': 0}]
    @contextmanager
    def environment(context, device_id):
        yield env
    monkeypatch.setattr(worker, 'environment', environment)
    monkeypatch.setenv('PAIOS_OWNER_MAC_FILES', str(tmp_path / 'in'))
    files = Mock()
    files.return_value.write_file.return_value = SimpleNamespace(error=None)
    monkeypatch.setattr(worker, 'ShellFileOperations', files)
    server = worker.create_server()
    got = json.loads((await server.call_tool('fetch', {'path': '/tmp/w x.png', 'context': {}})).content[0].text)
    assert Path(got['path']).read_bytes() == png and got['bytes'] == len(png) and got['path'].endswith('-w x.png')
    assert "test -f '/tmp/w x.png'" in env.execute.call_args_list[0].args[0]
    with pytest.raises(Exception):
        await server.call_tool('fetch', {'path': '/tmp/missing.png', 'context': {}})
    source = tmp_path / 'r.xlsx'
    source.write_bytes(png)
    sent = json.loads((await server.call_tool('put', {'source': str(source), 'path': '/Users/a/r.xlsx', 'context': {}})).content[0].text)
    assert sent == {'path': '/Users/a/r.xlsx', 'bytes': len(png)}
    staged, content = files.return_value.write_file.call_args.args
    assert staged.startswith('/Users/a/r.xlsx.') and base64.b64decode(content) == png
