"""Native computer actions retain owner binding, source approval and per-device transport."""
from contextlib import contextmanager
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

ROOT = Path(__file__).parents[2]


@pytest.fixture
def computer(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / 'integrations/hermes'))
    from personal_aios import owner_mac_computer, owner_mac
    from personal_aios import effects
    import gateway.run_scope
    monkeypatch.setattr(gateway.run_scope, 'current_scope', lambda: 'owner')
    monkeypatch.setattr(effects, 'check_effect', Mock(return_value=None))
    monkeypatch.setattr(owner_mac_computer, 'owner_mac', owner_mac, raising=False)
    return owner_mac_computer


def arguments(action='click'):
    return {'action': action, 'coordinate': [12, 34], 'effect': {'kind': 'read', 'task_type': 'inspect', 'requested': True},
            'device_id': 'mac-a', 'context': {'run_id': 'actual-run', 'session_id': 'sid', 'tool_call_id': 'call'}}


def test_native_schema_registration_preserves_original_action_vocabulary(computer):
    ctx = SimpleNamespace(register_tool=Mock(return_value=object()))
    computer.register(ctx, Mock())
    name, toolset, schema, handler = ctx.register_tool.call_args.args
    assert name == 'computer_use' and toolset == 'computer_use'
    assert {'capture', 'click', 'type', 'key', 'focus_app', 'list_apps'} <= set(schema['parameters']['properties']['action']['enum'])
    assert 'effect' in schema['parameters']['required'] and 'device_id' in schema['parameters']['properties']
    assert ctx.register_tool.call_args.kwargs == {'override': True}


def test_source_gate_refusal_never_opens_owner_mac(computer, monkeypatch):
    from personal_aios import effects
    monkeypatch.setattr(effects, 'check_effect', Mock(return_value={'action': 'block', 'message': 'NO_CONSENT'}))
    resolve = Mock()
    monkeypatch.setattr(computer.owner_mac, 'resolve', resolve)
    result = json.loads(computer.handle(arguments(), Mock(), session_id='sid', tool_call_id='call'))
    assert result == {'error': 'NO_CONSENT'}
    resolve.assert_not_called()


def test_remote_native_action_uses_actual_binding_and_original_session(computer, monkeypatch):
    from tools.computer_use import tool, cua_backend
    binding = {'device_id': 'actual-mac', 'home': '/Users/owner'}
    monkeypatch.setattr(computer.owner_mac, 'resolve', Mock(return_value=binding))
    env = Mock()
    env.execute.return_value = {'returncode': 0, 'output': '8.0'}
    @contextmanager
    def environment(context, device_id):
        assert context == arguments()['context'] and device_id == 'actual-mac'
        yield env
    monkeypatch.setattr(computer.owner_mac, 'environment', environment)
    native = Mock(return_value='{"ok":true}')
    monkeypatch.setattr(tool, 'handle_computer_use', native)
    backend = Mock()
    monkeypatch.setattr(cua_backend, 'CuaDriverBackend', backend)
    assert json.loads(computer.handle(arguments(), Mock(), session_id='sid', tool_call_id='call')) == {'ok': True}
    forwarded = native.call_args.args[0]
    options = native.call_args.kwargs
    assert forwarded == {'action': 'click', 'coordinate': [12, 34], 'delivery_mode': 'background'}
    assert options['session_id'] == 'sid'
    assert options['backend_factory'].cache_key == ('actual-run', 'actual-mac', False)
    assert options['approval_gate']('click', {}) is None
    options['backend_factory']('standard')
    transport = backend.call_args.kwargs['driver_transport']
    assert transport['args'][0].endswith('/owner_mac_cua.py')
    assert json.loads(transport['args'][1]) == arguments()['context'] and transport['args'][2] == 'actual-mac'


@pytest.mark.parametrize('idle', ['0.2', '1.99'])
def test_owner_input_blocks_before_native_dispatch(computer, monkeypatch, idle):
    from tools.computer_use import tool
    monkeypatch.setattr(computer.owner_mac, 'resolve', Mock(return_value={'device_id': 'mac-a'}))
    @contextmanager
    def environment(*args):
        yield SimpleNamespace(execute=lambda *a, **k: {'returncode': 0, 'output': idle})
    monkeypatch.setattr(computer.owner_mac, 'environment', environment)
    native = Mock()
    monkeypatch.setattr(tool, 'handle_computer_use', native)
    with pytest.raises(RuntimeError, match='Owner input active'):
        computer.handle(arguments(), Mock(), session_id='sid')
    native.assert_not_called()


@pytest.mark.parametrize('entry', ['module', 'script'])
def test_ssh_wrapper_import_is_inert_and_quotes_driver_verbs(computer, monkeypatch, entry):
    import importlib.util
    import os
    import runpy
    import sys
    source = ROOT / 'integrations/hermes/personal_aios/owner_mac_cua.py'
    original_path = sys.path[:]
    spec = importlib.util.spec_from_file_location(computer.__package__ + '.owner_mac_cua', source)
    wrapper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wrapper)
    assert sys.path == original_path
    @contextmanager
    def environment(context, device):
        assert context == {'run_id': 'run'} and device == 'mac-a'
        yield SimpleNamespace(_build_ssh_command=lambda: ['ssh', '-p', '22001', 'wen@127.0.0.1'])
    monkeypatch.setattr(computer.owner_mac, 'environment', environment)
    arguments = ['call', 'type_text', '{"text":"a;$(false) 中文"}']
    if entry == 'module':
        argv = wrapper.command({'run_id': 'run'}, 'mac-a', arguments)
    else:
        execute = Mock()
        monkeypatch.setattr(os, 'execvp', execute)
        monkeypatch.setattr(sys, 'path', sys.path[:])
        monkeypatch.setattr(sys, 'argv', [str(source), '{"run_id":"run"}', 'mac-a', *arguments])
        runpy.run_path(str(source), run_name='__main__')
        argv = execute.call_args.args[1]
        assert execute.call_args.args[0] == 'ssh'
    import shlex
    assert argv[:6] == ['ssh', '-T', '-o', 'ControlMaster=no', '-o', 'ControlPath=none']
    assert argv[6:-1] == ['-p', '22001', 'wen@127.0.0.1']
    assert shlex.split(argv[-1])[-3:] == ['call', 'type_text', '{"text":"a;$(false) 中文"}']
