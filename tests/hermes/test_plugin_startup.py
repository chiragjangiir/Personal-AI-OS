"""Offline production-loader smoke check; also runnable with a provider directory."""
import json
import os
from pathlib import Path
import subprocess
import sys


def production_startup(source):
    from contextlib import contextmanager
    import importlib
    import socket
    from tempfile import TemporaryDirectory
    from types import SimpleNamespace
    from unittest.mock import patch

    with TemporaryDirectory(prefix='paios-plugin-startup-') as folder:
        home = Path(folder)
        os.environ.update(HERMES_HOME=folder, HERMES_ENABLE_PROJECT_PLUGINS='0',
                          PAIOS_PHONE_PROVIDER='mac-android', PAIOS_WORKSHOP_HOST='offline-workshop.invalid')
        (home / 'plugins').mkdir()
        (home / 'plugins/personal_aios').symlink_to(source.resolve(), target_is_directory=True)
        (home / 'unused.key').write_text('synthetic-offline-startup')
        (home / 'config.yaml').write_text(json.dumps({
            'memory': {'provider': 'personal_aios'},
            'plugins': {'allow_deprecated_imports': True,
                        'entries': {'personal_aios': {'allow_tool_override': True}}},
            'mcp_servers': {'owner_mac': {}, 'phone': {}},
            'computer_use': {'backend': 'cua', 'no_overlay': False},
            'personal_aios': {'internal_base_url': 'http://127.0.0.1:9',
                              'internal_key_file': str(home / 'unused.key')},
        }))
        import hermes_constants
        os.environ['PAIOS_HERMES_SOURCE'] = str(Path(hermes_constants.__file__).parent)
        from agent.memory_provider import MemoryProvider
        from gateway.config import Platform
        from gateway.platform_registry import platform_registry
        from hermes_cli.plugins import get_plugin_manager
        from plugins.memory import load_memory_provider
        from tools.registry import registry
        from tools.send_message_tool import send_message_tool

        with patch.object(socket.socket, 'connect', side_effect=AssertionError('Startup must stay offline')) as connect:
            provider = load_memory_provider('personal_aios')
            assert isinstance(provider, MemoryProvider)
            assert provider.name == 'personal_aios' and provider.owner_mac_enabled and provider.is_available()
            namespace = type(provider).__module__
            assert namespace.startswith('_hermes_user_memory.personal_aios__source_')
            assert 'personal_aios' not in sys.modules
            print('MEMORY_PROVIDER', type(provider).__name__, flush=True)
            assert Platform('personal_aios').value == 'personal_aios'
            print('PLATFORM', Platform('personal_aios'), flush=True)

            manager = get_plugin_manager()
            tools = {'paios_background_status', 'computer_use', 'cronjob_manage',
                     'paios_watch_check', 'send_message', 'paios_effect_check', 'skills_hub'}
            assert manager._plugin_tool_names == tools, manager._plugin_tool_names
            for name in tools:
                entry = registry.get_entry(name, scope=manager.scope_key)
                assert entry is not None, name
                if name == 'send_message':
                    assert entry.handler is send_message_tool
                else:
                    assert entry.handler.__module__.startswith(namespace), name
            hooks = {key: [callback.__name__ for callback in callbacks]
                     for key, callbacks in manager._hooks.items() if callbacks}
            assert hooks == {'pre_tool_call': ['bind_self', 'bind']}, hooks
            middleware = {key: len(callbacks) for key, callbacks in manager._middleware.items() if callbacks}
            assert middleware == {'tool_dispatch': 2}, middleware
            assert manager._plugin_platform_names == {'personal_aios'}
            assert platform_registry.get('personal_aios').adapter_factory.__module__ == namespace + '.cron'
            handlers = manager._platform_handler_factories
            assert set(handlers) == {'api_server'}
            assert [(fn.__name__, owner) for fn, owner in handlers['api_server']] == [('http_routes', 'personal_aios')]
            sections = set(manager._system_prompt_sections)
            assert sections == {'personal-aios.reporting', 'personal-aios.experience-review'}, sections

            owner_mac = importlib.import_module(namespace + '.owner_mac')
            cua = importlib.import_module(namespace + '.owner_mac_cua')

            @contextmanager
            def environment(context, device):
                assert context == {'run_id': 'offline'} and device == 'offline-mac'
                yield SimpleNamespace(_build_ssh_command=lambda: ['ssh', 'owner@offline.invalid'])

            with patch.object(owner_mac, 'environment', environment):
                argv = cua.command({'run_id': 'offline'}, 'offline-mac', ['status'])
                assert argv[:6] == ['ssh', '-T', '-o', 'ControlMaster=no', '-o', 'ControlPath=none']
            assert 'personal_aios' not in sys.modules
            connect.assert_not_called()
            print(json.dumps({'namespace': namespace, 'tools': sorted(tools), 'hooks': hooks,
                              'middleware': middleware, 'sections': sorted(sections),
                              'platform': 'personal_aios', 'cua_transport': 'constructed', 'network_calls': 0}))


def test_production_loader_completes_all_registrations(tmp_path):
    from plugins import memory
    source = Path(__file__).parents[2] / 'integrations/hermes/personal_aios'
    env = {**os.environ, 'PYTHONPATH': str(Path(memory.__file__).parents[2]), 'PYTHONDONTWRITEBYTECODE': '1'}
    result = subprocess.run([sys.executable, str(Path(__file__).resolve()), str(source)],
                            cwd=tmp_path, env=env, capture_output=True, text=True, timeout=60)
    print(result.stdout, end='')
    assert result.returncode == 0, result.stdout + result.stderr


if __name__ == '__main__':
    production_startup(Path(sys.argv[1]))
