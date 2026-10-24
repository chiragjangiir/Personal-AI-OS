"""The standalone native API owns the readiness state of its adapter lifecycle."""
import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.mark.asyncio
@pytest.mark.parametrize("connects,discovery_fails", [(True, False), (False, False), (True, True)])
async def test_native_api_readiness_follows_connected_lifecycle(tmp_path, monkeypatch, connects, discovery_fails):
    from gateway import config, status, run
    from gateway.platforms import api_server
    from gateway import platform_registry as registry_module
    from gateway.platform_registry import PlatformRegistry, PlatformEntry
    from cron import scheduler_provider
    from hermes_cli import plugins
    from plugins import memory
    import hermes_logging

    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setattr(plugins, 'discover_plugins', lambda: None)
    monkeypatch.setattr(memory, 'load_memory_provider', lambda name: object())
    monkeypatch.setattr(hermes_logging, 'setup_logging', lambda **kwargs: None)
    source = Path(__file__).parents[2] / 'integrations/hermes/personal_aios/run_api.py'
    spec = importlib.util.spec_from_file_location('native_readiness_lifecycle', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    api_config = SimpleNamespace(enabled=True, extra={'host': '127.0.0.1'})
    monkeypatch.setattr(config, 'load_gateway_config', lambda: SimpleNamespace(platforms={
        config.Platform.API_SERVER: api_config, config.Platform('personal_aios'): api_config}))
    states = []

    async def discover(_config):
        if discovery_fails:
            raise RuntimeError("synthetic MCP discovery failure")

    class Adapter:
        def __init__(self, _config):
            pass

        async def connect(self):
            status.write_runtime_status(platform='api_server', platform_state='connected')
            states.append(('connecting', status.read_runtime_status()['gateway_state']))
            return connects

        async def disconnect(self):
            states.append(('disconnecting', status.read_runtime_status()['gateway_state']))

    class Scheduler:
        def start(self, stop, **kwargs):
            stop.wait()

    from tools import mcp_tool_discovery
    monkeypatch.setattr(mcp_tool_discovery, 'get_mcp_status', lambda: [])
    monkeypatch.setattr(run, '_discover_gateway_mcp_tools', discover)
    monkeypatch.setattr(api_server, 'APIServerAdapter', Adapter)
    registry = PlatformRegistry()
    registry.register(PlatformEntry('personal_aios', 'Fixture delivery', Adapter, lambda: True))
    monkeypatch.setattr(registry_module, 'platform_registry', registry)
    monkeypatch.setattr(scheduler_provider, 'InProcessCronScheduler', Scheduler)
    loop = asyncio.get_running_loop()

    def add_signal_handler(_signal, callback):
        def stop():
            states.append(('ready', status.read_runtime_status()['gateway_state']))
            callback()
        loop.call_soon(stop)

    monkeypatch.setattr(loop, 'add_signal_handler', add_signal_handler)
    if not connects:
        with pytest.raises(RuntimeError, match='did not start'):
            await module._serve_native_api()
        assert status.read_runtime_status()['gateway_state'] == 'starting'
        return
    await module._serve_native_api()
    assert all(state == 'starting' for phase, state in states if phase == 'connecting')
    expected = 'degraded' if discovery_fails else 'running'
    assert all(state == expected for phase, state in states if phase == 'ready')
    assert status.read_runtime_status()['gateway_state'] == 'stopped'
