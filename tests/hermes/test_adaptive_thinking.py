"""Exercise the shipped transport patch against a fake OpenAI-compatible provider."""
import importlib.util
import json
from pathlib import Path

import httpx
import pytest
from openai import OpenAI
from providers import get_provider_profile
from gateway.platforms.api_server import _request_reasoning_config


@pytest.fixture
def transport(tmp_path):
    import agent.transports.chat_completions as native
    target = tmp_path / 'agent/transports/chat_completions.py'
    target.parent.mkdir(parents=True)
    target.write_bytes(Path(native.__file__).read_bytes())
    spec = importlib.util.spec_from_file_location('isolated_thinking_transport', target)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.ChatCompletionsTransport()


@pytest.mark.parametrize('profile', [None, get_provider_profile('custom')])
def test_per_request_thinking_overrides_config_without_mutating_provider(transport, profile):
    configured = {'extra_body': {'thinking': {'type': 'disabled'}, 'temperature': 0.2}}
    captured = []
    def respond(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200, json={'id': 'fixture', 'object': 'chat.completion', 'created': 0,
            'model': 'configured-model', 'choices': [{'index': 0, 'finish_reason': 'stop',
            'message': {'role': 'assistant', 'content': 'ok'}}]})
    with OpenAI(api_key='fixture', base_url='https://provider.test/v1',
                http_client=httpx.Client(transport=httpx.MockTransport(respond))) as client:
        for enabled in (True, False, True):
            reasoning = _request_reasoning_config({'reasoning': {'enabled': enabled}})
            kwargs = transport.build_kwargs(model='configured-model',
                messages=[{'role': 'user', 'content': 'fixture task'}], tools=None,
                request_overrides=configured, reasoning_config=reasoning, provider_profile=profile)
            client.chat.completions.create(**kwargs)
    assert [body['thinking']['type'] for body in captured] == ['enabled', 'disabled', 'enabled']
    assert all(body['model'] == 'configured-model' and body['temperature'] == 0.2 for body in captured)
    assert configured['extra_body']['thinking'] == {'type': 'disabled'}


@pytest.mark.asyncio
async def test_front_search_calls_configured_native_tool_without_model(monkeypatch):
    import tools.web_tools
    source = Path(__file__).parents[2] / 'integrations/hermes/personal_aios/run_api.py'
    spec = importlib.util.spec_from_file_location('isolated_front_search', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    result = {'success': True, 'data': {'web': [{'title': 'fixture', 'url': 'https://example.test', 'description': 'public'}]}}
    calls = []
    def search(query):
        calls.append(query)
        return json.dumps(result)
    monkeypatch.setattr(tools.web_tools, 'web_search_tool', search)
    assert await module.search_front_web('public question') == result
    assert calls == ['public question']
    monkeypatch.setattr(tools.web_tools, 'web_search_tool', lambda query: '{"success":false,"error":"missing provider"}')
    from aiohttp import web
    with pytest.raises(web.HTTPBadGateway):
        await module.search_front_web('public question')


@pytest.mark.asyncio
async def test_api_server_binds_tool_metrics_and_forwards_real_native_events(capsys):
    import ast
    import asyncio
    from types import SimpleNamespace
    from aiohttp import web
    from gateway.platforms.api_server import APIServerAdapter
    source = Path(__file__).parents[2] / 'integrations/hermes/personal_aios/run_api.py'
    spec = importlib.util.spec_from_file_location('isolated_tool_metrics', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Load the actual nested production subclass without starting its service/process.
    tree = ast.parse(source.read_text())
    server = next(node for node in ast.walk(tree) if isinstance(node, ast.ClassDef) and node.name == 'PersonalAIOSAPIServer')
    namespace = {**vars(module), 'APIServerAdapter': APIServerAdapter, 'web': web}
    exec(compile(ast.Module(body=[server], type_ignores=[]), str(source), 'exec'), namespace)
    adapter = object.__new__(namespace['PersonalAIOSAPIServer'])
    adapter._run_statuses = {'run-test': {'status': 'running', 'session_id': 'native-session',
        'conversation_session_id': 'conversation'}}
    from gateway.platforms.api_server_runs import _RunStream
    stream = _RunStream()
    queue, _ = stream.attach()
    adapter._run_streams = {'run-test': stream}
    adapter._run_idempotency_ids = {}
    adapter._active_run_agents = {}
    callback = adapter._make_run_event_callback('run-test', asyncio.get_running_loop())
    callback('tool.started', 'web_search', args={'query': 'private-content'}, tool_call_id='search-call')
    callback('reasoning.available', '_thinking', 'private-thinking')
    await asyncio.sleep(0)  # native call_soon_threadsafe queue publications
    _, event = await asyncio.wait_for(queue.get(), 1)
    assert event['event'] == 'tool.started' and event['tool_call_id'] == 'search-call'
    assert queue.empty(), 'reasoning is not a public run event'
    agent = SimpleNamespace(model='configured-model', provider='configured-provider', reasoning_config={'enabled': True},
        tool_progress_callback=callback, session_estimated_cost_usd=0.125, session_cost_status='estimated', session_cost_source='fixture')
    adapter._active_run_agents['run-test'] = agent
    adapter._set_run_status('run-test', 'completed', usage={'input_tokens': 100, 'output_tokens': 20})
    rows = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert rows[0] == {'hermes_stage': 'tool_metrics', 'run_id': 'run-test', 'event': 'tool.started', 'tool': 'web_search'}
    assert rows[1]['tool_event_schema'] == 'hermes.tool-metrics.v1'
    assert rows[1]['usage'] == {'input_tokens': 100, 'output_tokens': 20}
    assert rows[1]['estimated_cost_usd'] == 0.125 and rows[1]['raw_provider_usage'] is None
    assert 'private-content' not in json.dumps(rows) and 'private-thinking' not in json.dumps(rows)
    # A present agent with an unwrapped native callback must never certify instrumentation.
    adapter._active_run_agents['unbound'] = SimpleNamespace(tool_progress_callback=lambda *a, **kw: None)
    adapter._set_run_status('unbound', 'failed')
    assert json.loads(capsys.readouterr().out)['tool_event_schema'] is None
