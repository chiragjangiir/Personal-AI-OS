"""A real failed configured stdio MCP degrades the original API readiness owner."""
import asyncio
import importlib.util
import json
import os
import socket
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.mark.asyncio
@pytest.mark.parametrize('recovers', [False, True])
async def test_real_failed_mcp_does_not_publish_running(tmp_path, monkeypatch, recovers):
    # MCP cache is process-global; keep the real transport failure out of the suite process.
    if os.environ.get('PAIOS_MCP_READINESS_CHILD') != '1':
        environment = {**os.environ, 'PAIOS_MCP_READINESS_CHILD': '1'}
        result = subprocess.run([sys.executable, '-m', 'pytest',
                                 str(Path(__file__).resolve()) + '::test_real_failed_mcp_does_not_publish_running[' + str(recovers) + ']',
                                 '-q', '-s', '--tb=short'], env=environment,
                                capture_output=True, text=True, timeout=90)
        assert result.returncode == 0, result.stdout + result.stderr
        return
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setenv('HERMES_SAFE_MODE', 'false')
    fixture = 'r2_actual_failed_stdio'
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
    server_config = ({'url': f'http://127.0.0.1:{port}/mcp', 'timeout': 2, 'connect_timeout': 0.2, 'lazy': False}
                     if recovers else {'command': '/usr/bin/false', 'args': [], 'timeout': 2, 'lazy': False})
    server_config['tools'] = {'resources': False, 'prompts': False}
    (tmp_path / 'config.yaml').write_text(json.dumps({'mcp_servers': {fixture: server_config}}))
    from gateway import config, status
    from gateway.platforms import api_server
    from gateway import platform_registry as registry_module
    from gateway.platform_registry import PlatformRegistry, PlatformEntry
    from cron import scheduler_provider
    from hermes_cli import plugins
    from plugins import memory
    from tools import mcp_tool_discovery, mcp_tool_lifecycle
    import hermes_logging

    # Only peripheral API/provider/scheduler plumbing is replaced. Discovery, stdio
    # process, config load, MCP failure cache and runtime status are all original.
    monkeypatch.setattr(plugins, 'discover_plugins', lambda: None)
    monkeypatch.setattr(memory, 'load_memory_provider', lambda name: object())
    monkeypatch.setattr(hermes_logging, 'setup_logging', lambda **kwargs: None)
    repo = Path(__file__).parents[2]
    source = repo / 'integrations/hermes/personal_aios/run_api.py'
    spec = importlib.util.spec_from_file_location('r2_real_failure_runner', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    api_config = SimpleNamespace(enabled=True, extra={'host': '127.0.0.1'})
    facts = {}

    class Adapter:
        def __init__(self, _config):
            pass

        async def connect(self):
            # Reaching connect proves the original discovery returned, not threw.
            facts['discovery_returned'] = True
            facts['mcp'] = [{key: row.get(key) for key in ('name', 'status', 'connected', 'tools')}
                            for row in mcp_tool_discovery.get_mcp_status()]
            status.write_runtime_status(platform='api_server', platform_state='connected')
            return True

        async def disconnect(self):
            pass

    class Scheduler:
        def start(self, stop, **kwargs):
            stop.wait()

    monkeypatch.setattr(api_server, 'APIServerAdapter', Adapter)
    registry = PlatformRegistry()
    registry.register(PlatformEntry('personal_aios', 'Fixture delivery', Adapter, lambda: True))
    monkeypatch.setattr(registry_module, 'platform_registry', registry)
    gateway_config = SimpleNamespace(platforms={config.Platform.API_SERVER: api_config,
                                                config.Platform('personal_aios'): api_config})
    monkeypatch.setattr(config, 'load_gateway_config', lambda: gateway_config)
    monkeypatch.setattr(scheduler_provider, 'InProcessCronScheduler', Scheduler)
    loop = asyncio.get_running_loop()
    recovery = []
    servers = []

    def add_signal_handler(_signal, callback):
        if recovers:
            if recovery:
                return
            script = tmp_path / 'recovered_mcp.py'
            script.write_text('from mcp.server import MCPServer\n'
                              'server=MCPServer("recovered")\n'
                              '@server.tool()\ndef recovered_tool() -> str: return "recovered"\n'
                              f'server.run(transport="streamable-http",host="127.0.0.1",port={port})\n')
            with (tmp_path / 'fixture-server.log').open('w') as log:
                servers.append(subprocess.Popen([sys.executable, str(script)], stdout=log, stderr=subprocess.STDOUT))
            async def observe_recovery():
                facts['initial_state'] = status.read_runtime_status()['gateway_state']
                for _ in range(80):
                    if servers[0].poll() is not None:
                        facts['fixture_server_failure'] = (tmp_path / 'fixture-server.log').read_text()
                        break
                    if status.read_runtime_status()['gateway_state'] == 'running':
                        facts['recovered_mcp'] = [{key: row.get(key) for key in ('name', 'status', 'connected', 'tools')}
                                                  for row in mcp_tool_discovery.get_mcp_status()]
                        break
                    await asyncio.sleep(1)
                facts['ready_gateway_state'] = status.read_runtime_status()['gateway_state']
                callback()
            recovery.append(asyncio.create_task(observe_recovery()))
            return
        def stop():
            facts['ready_gateway_state'] = status.read_runtime_status()['gateway_state']
            callback()
        loop.call_soon(stop)

    monkeypatch.setattr(loop, 'add_signal_handler', add_signal_handler)
    try:
        await module._serve_native_api()
    finally:
        mcp_tool_lifecycle.shutdown_mcp_servers(names={fixture})
        for server in servers:
            server.terminate()
            server.wait(timeout=5)
    print('REAL_MCP_READINESS_FACTS=' + json.dumps(facts, sort_keys=True))
    failed = next((row for row in facts.get('mcp', []) if row['name'] == fixture), None)
    assert facts.get('discovery_returned') is True, 'Original startup discovery did not return'
    assert failed is not None and failed['status'] == 'failed', 'Precondition: actual stdio failure not cached'
    assert status.read_runtime_status()['gateway_state'] == 'stopped'
    if recovers:
        assert facts['initial_state'] == 'degraded', facts
        assert facts['ready_gateway_state'] == 'running', facts
        recovered = next(row for row in facts['recovered_mcp'] if row['name'] == fixture)
        assert recovered['connected'] and recovered['status'] == 'connected' and recovered['tools'] == 1
    else:
        assert facts['ready_gateway_state'] == 'degraded', facts
