"""Isolated provider transport tests; TS owns enabled tools and argument policy."""
import copy
import importlib.util
import json
import os
import socket
import subprocess
import sys
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError, URLError
from unittest.mock import Mock

import pytest
from agent.inline_tool_executors import InlineToolContext, resolve_invoke_tool_executor
from agent.memory_manager import MemoryManager
from gateway.session_context import clear_session_vars, get_api_run_id, set_session_vars
from hermes_constants import reset_hermes_home_override, set_hermes_home_override


@pytest.mark.parametrize('result', [
    *[{'stop': False, 'guests': guests, 'directed': True, 'hangup': False}
      for guests in ('allow', 'revoke', 'unchanged')],
    {'stop': True, 'guests': 'revoke', 'directed': True, 'hangup': False},
    {'stop': False, 'guests': 'unchanged', 'directed': True, 'hangup': True},
    {'stop': False, 'guests': 'unchanged', 'directed': False, 'hangup': True},
    {'stop': 'false', 'guests': 'allow'}, {'stop': False, 'guests': 'allow', 'reason': 'extra'},
])
def test_call_intent_uses_only_current_utterance_and_validates_native_contract(monkeypatch, result):
    import asyncio
    from aiohttp import web
    from agent import auxiliary_client
    source = Path(__file__).parents[2] / 'integrations/hermes/personal_aios/run_api.py'
    spec = importlib.util.spec_from_file_location('isolated_paios_call_intent', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    text = '他说“先把发言权交还给我”，这句话是什么意思？'
    async def classify(**kwargs):
        assert set(kwargs) == {'messages', 'temperature', 'max_tokens', 'timeout', 'reasoning_config'}
        assert kwargs['reasoning_config'] == {'enabled': False}
        assert len(kwargs['messages']) == 2
        assert kwargs['messages'][0]['role'] == 'system'
        assert 'Quoted, reported' in kwargs['messages'][0]['content']
        assert '再见, 拜拜, 退下吧' in kwargs['messages'][0]['content']
        assert kwargs['messages'][1] == {'role': 'user', 'content': text}
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(result)))])
    monkeypatch.setattr(auxiliary_client, 'async_call_llm', classify)
    if type(result['stop']) is bool and len(result) == 4 and (not result['hangup'] or result['directed']):
        assert asyncio.run(module.classify_call_intent(text)) == result
    else:
        with pytest.raises(web.HTTPBadGateway):
            asyncio.run(module.classify_call_intent(text))


@pytest.mark.asyncio
async def test_structured_vision_rejects_transport_that_can_drop_json_mode_and_releases_native_budget(monkeypatch):
    import asyncio
    from aiohttp import web
    from agent import auxiliary_client
    source = Path(__file__).parents[2] / 'integrations/hermes/personal_aios/run_api.py'
    spec = importlib.util.spec_from_file_location('isolated_structured_vision', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    budget = asyncio.BoundedSemaphore(1)
    def resolve(**kwargs):
        assert budget.locked()
        assert kwargs == {'async_mode': True}
        return 'shim', object(), 'configured-vision'
    monkeypatch.setattr(auxiliary_client, 'resolve_vision_provider_client', resolve)
    monkeypatch.setattr(auxiliary_client, '_acquire_async_aux_semaphore', lambda task: budget if task == 'vision' else None)
    with pytest.raises(web.HTTPBadGateway, match='Bad Gateway'):
        await module.analyze_structured_frame('data:image/jpeg;base64,/9j/2Q==', 'Return JSON', {'type': 'object'})
    assert not budget.locked()


@pytest.mark.asyncio
async def test_structured_vision_retries_transient_provider_errors_with_native_policy(monkeypatch):
    import asyncio
    import httpx
    from openai import AsyncOpenAI, InternalServerError
    from agent import auxiliary_client
    source = Path(__file__).parents[2] / 'integrations/hermes/personal_aios/run_api.py'
    spec = importlib.util.spec_from_file_location('isolated_structured_vision_retry', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    client = AsyncOpenAI(api_key='synthetic', base_url='http://127.0.0.1:9/v1', max_retries=0)
    outcomes, calls = [], []
    async def create(**kwargs):
        calls.append(kwargs)
        outcome = outcomes.pop(0)
        if outcome == 500:
            raise InternalServerError('upstream 500', body=None,
                response=httpx.Response(500, request=httpx.Request('POST', 'http://127.0.0.1:9/v1/chat/completions')))
        message = type('M', (), {'content': outcome})()
        return type('R', (), {'choices': [type('C', (), {'message': message})()]})()
    monkeypatch.setattr(client.chat.completions, 'create', create)
    monkeypatch.setattr(auxiliary_client, 'resolve_vision_provider_client', lambda **kwargs: ('custom', client, 'configured-vision'))
    monkeypatch.setattr(auxiliary_client, '_acquire_async_aux_semaphore', lambda task: None)
    monkeypatch.setattr(auxiliary_client, '_transient_retry_count', lambda: 2)
    monkeypatch.setattr(auxiliary_client, '_TRANSIENT_RETRY_BACKOFF_BASE', 0.0)
    schema = {'type': 'object', 'required': ['caption', 'ocr'],
              'properties': {'caption': {'type': 'string'}, 'ocr': {'type': 'string'}}}
    outcomes[:] = [500, '{"caption":"desk","ocr":""}']
    response = await module.analyze_structured_frame('data:image/jpeg;base64,/9j/2Q==', 'Return JSON', schema)
    assert response.status == 200 and json.loads(response.body) == {'caption': 'desk', 'ocr': ''}
    assert len(calls) == 2 and all(call['response_format'] == {'type': 'json_object'} for call in calls)
    from aiohttp import web
    calls.clear()
    outcomes[:] = [500, 500, 500]
    with pytest.raises(web.HTTPBadGateway):
        await module.analyze_structured_frame('data:image/jpeg;base64,/9j/2Q==', 'Return JSON', schema)
    assert len(calls) == 3, 'transient retries are bounded by auxiliary.transient_retries'


@pytest.fixture(scope='session')
def schemas(tmp_path_factory):
    source = Path(os.environ.get('PAIOS_TOOL_SCHEMA_SOURCE',
        str(Path(__file__).parents[2] / '01-product-half-finished/backend/services/'
            'personal-aios-integration/src/tool-contracts.ts')))
    script = ('const {enabledToolSchemas}=await import(process.argv[1]);'
              'process.stdout.write(JSON.stringify(enabledToolSchemas({memory:true,actions:true})));')
    result = subprocess.run(['node', '--input-type=module', '-e', script, source.as_uri()],
                            capture_output=True, text=True, check=True, timeout=15)
    fixture = tmp_path_factory.mktemp('central-tool-schema') / 'tool-contracts.json'
    fixture.write_text(result.stdout)
    return json.loads(fixture.read_text())


@pytest.mark.parametrize('use_env', [False, True])
def test_provider_resolves_profile_configuration_with_native_env_refs(tmp_path, monkeypatch, use_env):
    from integrations.hermes.personal_aios import PersonalAIOSProvider
    key = tmp_path / 'internal.key'
    key.write_text('synthetic-provider-configuration-key')
    base = 'http://127.0.0.1:9'
    monkeypatch.setenv('PAIOS_INTERNAL_KEY_FILE', str(key))
    monkeypatch.setenv('PAIOS_INTERNAL_BASE_URL', base)
    config = {'personal_aios': {
        'internal_base_url': '${PAIOS_INTERNAL_BASE_URL}' if use_env else base,
        'internal_key_file': '${PAIOS_INTERNAL_KEY_FILE}' if use_env else str(key)}}
    (tmp_path / 'config.yaml').write_text(json.dumps(config))
    token = set_hermes_home_override(tmp_path)
    try:
        provider = PersonalAIOSProvider()
    finally:
        reset_hermes_home_override(token)
    assert provider.base_url == base and provider.key_file == str(key)
    assert provider.is_available()


@pytest.fixture
def seam(monkeypatch, tmp_path, schemas):
    source = Path(__file__).parents[2] / 'integrations/hermes/personal_aios/__init__.py'
    spec = importlib.util.spec_from_file_location('isolated_paios_provider_test', source,
                                                submodule_search_locations=[str(source.parent)])
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    token = set_hermes_home_override(tmp_path)
    try:
        provider = module.PersonalAIOSProvider()
    finally:
        reset_hermes_home_override(token)
    key = tmp_path / 'synthetic-internal.key'
    key.write_text('synthetic-isolated-provider-test-key')
    provider.base_url = 'http://127.0.0.1:9'
    provider.key_file = str(key)
    provider.initialize('session-host', agent_context='primary')
    calls = []
    def forbid(*args, **kwargs):
        raise AssertionError('No live network is allowed in isolated provider tests')
    monkeypatch.setattr(socket.socket, 'connect', forbid)
    monkeypatch.setattr(socket.socket, 'connect_ex', forbid)
    def transport(request, timeout):
        if request.data is None:
            return BytesIO(json.dumps(schemas).encode())
        calls.append(json.loads(request.data))
        return BytesIO(b'{"status":"opened"}')
    monkeypatch.setattr(module, 'urlopen', transport)
    return SimpleNamespace(provider=provider, module=module, calls=calls)


def test_host_context_is_separate_from_model_args():
    calls = []
    manager = SimpleNamespace(has_tool=lambda name: True,
        handle_tool_call=lambda name, args, **kwargs: calls.append((name, args, kwargs)))
    agent = SimpleNamespace(session_id='session-host', _memory_manager=manager)
    executor = resolve_invoke_tool_executor(agent, 'paios_open_reply')
    tokens = set_session_vars(platform='api_server', session_id='session-host', session_key='run-host')
    try:
        assert get_api_run_id(agent.session_id) == 'run-host'
        executor(agent, {'run_id': 'model-forged'},
                 InlineToolContext(effective_task_id='session-host', tool_call_id='call-host'))
    finally:
        clear_session_vars(tokens)
    assert calls[0][2] == {'session_id': 'session-host', 'run_id': 'run-host', 'tool_call_id': 'call-host'}
    assert calls[0][1] == {'run_id': 'model-forged'}


@pytest.mark.parametrize('scope', ['guest', 'owner_uncertain', 'care', 'build'])
def test_native_restricted_dispatch_refuses_l3_forget(scope):
    from gateway.run_scope import tool_block
    assert tool_block(SimpleNamespace(_paios_run_scope=scope), 'paios_l3_forget')
    assert tool_block(SimpleNamespace(_paios_run_scope='owner'), 'paios_l3_forget') is None


@pytest.mark.parametrize('context', ['primary', 'cron', 'subagent', 'flush'])
def test_provider_defers_identity_and_scope_to_central_source(seam, monkeypatch, context):
    provider = seam.provider
    provider.initialize('session-host', agent_context=context)
    args = {'assertion': {'scope': {'principal_id': 'foreign-principal'}}}
    def reject(request, timeout):
        seam.calls.append(json.loads(request.data))
        raise HTTPError(request.full_url, 403, 'synthetic central scope rejection', {},
                        BytesIO(b'{"error_code":"L3_SCOPE_DENIED"}'))
    monkeypatch.setattr(seam.module, 'urlopen', reject)
    identities = [{}, {'session_id': 'other-session', 'run_id': 'run-host', 'tool_call_id': 'call-host'},
                  {'session_id': 'session-host', 'run_id': 'run-host', 'tool_call_id': 'call-host'}]
    for identity in identities:
        result = provider.handle_tool_call('paios_l3_commit', args, **identity)
        assert json.loads(result) == {'status': 'rejected', 'error_code': 'L3_SCOPE_DENIED', 'http_status': 403}
    assert seam.calls == [{'context': {key: identity.get(key, '') for key in
        ('session_id', 'run_id', 'tool_call_id')}, 'args': args} for identity in identities]
    # Every initialize label only transports host kwargs. This injected response
    # proves typed-error propagation, not real Admission or scope authorization.


def test_provider_posts_only_trusted_context(seam):
    manager = MemoryManager()
    manager.add_provider(seam.provider)
    agent = SimpleNamespace(session_id='session-host', _memory_manager=manager)
    executor = resolve_invoke_tool_executor(agent, 'paios_open_reply')
    args = {'reply_mode': 'text', 'run_id': 'model-forged'}
    tokens = set_session_vars(platform='api_server', session_id='session-host', session_key='run-host')
    try:
        assert json.loads(executor(agent, args,
            InlineToolContext(effective_task_id='session-host', tool_call_id='call-host')))['status'] == 'opened'
    finally:
        clear_session_vars(tokens)
    assert seam.calls == [{'context': {'session_id': 'session-host', 'run_id': 'run-host',
                                      'tool_call_id': 'call-host'}, 'args': args}]
    # This stub proves identity transport only. Real HTTP/PG tests own argument acceptance.


def test_recap_source_tools_preserve_owner_and_unidentified_speaker_provenance(seam, monkeypatch):
    """Tool-path fixture only: no claim that an LLM composed or accepted the recap."""
    seam.provider.get_tool_schemas()
    archive = {'raw_ref': 'l5:' + 'a' * 64, 'archive_revision': 'b' * 64,
        'observations': [
            {'processed_event_id': 'owner-observation', 'segment_id': 'owner-segment',
             'subject_ref': {'kind': 'known_person', 'id': 'owner'},
             'time_range': {'start_ms': 0, 'end_ms': 1200}, 'text': 'I will send the draft Friday.'},
            {'processed_event_id': 'guest-observation', 'segment_id': 'guest-segment',
             'subject_ref': {'kind': 'speaker_cluster', 'id': 'cluster-2'},
             'time_range': {'start_ms': 1200, 'end_ms': 2400}, 'text': 'Agreed. I will review it Monday.'}]}
    calls = []
    def source(path, body=None, **kwargs):
        calls.append((path, body))
        if path.endswith('/paios_l5_locate'):
            return {'status': 'located', 'raw_ref': archive['raw_ref'],
                    'archive_revision': archive['archive_revision']}
        if path.endswith('/paios_l5_read'):
            assert body['args'] == {key: archive[key] for key in ('raw_ref', 'archive_revision')}
            return archive
        raise AssertionError('Recap retrieval must not invoke a memory writer')
    monkeypatch.setattr(seam.provider, '_request', source)
    manager = MemoryManager()
    manager.add_provider(seam.provider)
    # Avoid transport fixture replacing the schemas: the source-owned contract
    # snapshot was already validated when the provider registered.
    agent = SimpleNamespace(session_id='session-host', _memory_manager=manager)
    tokens = set_session_vars(platform='api_server', session_id='session-host', session_key='run-host')
    try:
        locate = resolve_invoke_tool_executor(agent, 'paios_l5_locate')
        ref = json.loads(locate(agent, {'processed_event_id': 'owner-observation'},
            InlineToolContext(effective_task_id='session-host', tool_call_id='recap-locate')))
        read = resolve_invoke_tool_executor(agent, 'paios_l5_read')
        original = json.loads(read(agent, {key: ref[key] for key in ('raw_ref', 'archive_revision')},
            InlineToolContext(effective_task_id='session-host', tool_call_id='recap-read')))
    finally:
        clear_session_vars(tokens)
    assert original == archive
    assert [row['subject_ref']['kind'] for row in original['observations']] == ['known_person', 'speaker_cluster']
    assert [body['context']['tool_call_id'] for _, body in calls] == ['recap-locate', 'recap-read']
    assert all(body['context']['run_id'] == 'run-host' for _, body in calls)


def test_missing_api_binding_sends_empty_host_run_to_central_rejection(seam, monkeypatch):
    manager = MemoryManager()
    manager.add_provider(seam.provider)
    agent = SimpleNamespace(session_id='session-host', _memory_manager=manager)
    executor = resolve_invoke_tool_executor(agent, 'paios_open_reply')
    args = {'reply_mode': 'text', 'run_id': 'model-forged'}
    monkeypatch.setenv('HERMES_SESSION_KEY', 'environment-forged')
    def reject(request, timeout):
        seam.calls.append(json.loads(request.data))
        raise HTTPError(request.full_url, 400, 'synthetic central identity rejection', {},
                        BytesIO(b'{"error_code":"INVALID_ID"}'))
    monkeypatch.setattr(seam.module, 'urlopen', reject)
    tokens = set_session_vars(platform='', session_id='', session_key='')
    try:
        assert get_api_run_id(agent.session_id) == ''
        result = executor(agent, args, InlineToolContext(effective_task_id='session-host', tool_call_id='call-host'))
    finally:
        clear_session_vars(tokens)
    assert json.loads(result) == {'status': 'rejected', 'error_code': 'INVALID_ID', 'http_status': 400}
    assert seam.calls == [{'context': {'session_id': 'session-host', 'run_id': '', 'tool_call_id': 'call-host'}, 'args': args}]


@pytest.mark.parametrize('code,status', [('UNKNOWN_TOOL_ARGUMENT',400),('TOOL_NOT_ENABLED',404),
                                        ('L3_SCOPE_DENIED',403),('INTERNAL_ERROR',500)])
def test_provider_preserves_source_typed_errors(seam, monkeypatch, code, status):
    def reject(request, timeout):
        raise HTTPError(request.full_url, status, 'synthetic source rejection', {},
                        BytesIO(json.dumps({'error_code': code}).encode()))
    monkeypatch.setattr(seam.module, 'urlopen', reject)
    result = seam.provider.handle_tool_call('paios_open_reply', {}, session_id='session-host',
                                           run_id='run-host', tool_call_id='call-host')
    assert json.loads(result) == {'status': 'rejected', 'error_code': code, 'http_status': status}


def test_schema_is_fetched_from_central_ts_source(seam, schemas):
    assert seam.provider.get_tool_schemas() == schemas
    read = next(schema for schema in schemas if schema['name'] == 'paios_l5_read')
    assert read['parameters']['properties']['archive_revision']['type'] == 'string'


@pytest.mark.parametrize('mutation', ['empty', 'name', 'description', 'parameters', 'properties', 'budget'])
def test_provider_rejects_malformed_transport_snapshot(seam, schemas, monkeypatch, mutation):
    bad = copy.deepcopy(schemas)
    if mutation == 'empty':
        bad = []
    elif mutation == 'name':
        bad[0]['name'] = None
    elif mutation == 'description':
        bad[0]['description'] = []
    elif mutation == 'parameters':
        bad[0]['parameters'] = []
    elif mutation == 'properties':
        bad[0]['parameters']['properties'] = []
    else:
        bad *= 17
    monkeypatch.setattr(seam.provider, '_request', lambda *args, **kwargs: bad)
    with pytest.raises(ValueError, match='invalid_tool_contract_snapshot'):
        seam.provider.get_tool_schemas()


def test_schema_snapshot_is_immutable_to_native_consumers(seam):
    first = seam.provider.get_tool_schemas()
    first[0]['parameters']['properties']['forged_field'] = {'type': 'string'}
    assert 'forged_field' not in seam.provider.get_tool_schemas()[0]['parameters']['properties']


def test_native_manager_owns_name_routing_and_deduplication(seam, schemas, monkeypatch):
    snapshot = copy.deepcopy(schemas)
    snapshot.append(copy.deepcopy(snapshot[0]))
    foreign = copy.deepcopy(snapshot[0])
    foreign['name'] = 'foreign_source_tool'
    snapshot.append(foreign)
    monkeypatch.setattr(seam.provider, '_request', lambda *args, **kwargs: snapshot)
    manager = MemoryManager()
    manager.add_provider(seam.provider)
    assert manager.has_tool('foreign_source_tool')
    names = [schema['name'] for schema in manager.get_all_tool_schemas()]
    assert len(names) == len(set(names))
    assert set(names) == {schema['name'] for schema in snapshot}
    assert 'No memory provider handles' in manager.handle_tool_call('unregistered', {})


@pytest.fixture
def protected_phone_hook(seam, monkeypatch):
    hooks = {}
    # Capture the directive evaluator; the native middleware/queue tests cover its execution wiring.
    monkeypatch.setitem(sys.modules, seam.module.__name__ + '.cron', SimpleNamespace(register=lambda *args: None))
    monkeypatch.setitem(sys.modules, seam.module.__name__ + '.effects', SimpleNamespace(check_effect=lambda *args: None,
        register=lambda *args: None, register_execution_gate=lambda ctx, gate: ctx.register_hook('pre_tool_call', gate)))
    monkeypatch.setattr(seam.module, 'PersonalAIOSProvider', lambda: seam.provider)
    registered_tools = {}
    def register_tool(name, toolset, schema, handler):
        registered_tools[name] = (toolset, schema, handler)
        return name
    ctx = SimpleNamespace(register_system_prompt_section=lambda *a, **kw: None, register_memory_provider=lambda provider: None,
                          register_tool=register_tool,
                          register_hook=lambda name, hook: hooks.__setitem__(name, hook))
    seam.module.register(ctx)
    return hooks['pre_tool_call']


@pytest.mark.parametrize('name', ['phone_status', 'mcp__phone__phone_status', 'phone_control_link', 'mcp__phone__phone_control_link'])
def test_phone_status_identity_is_bound_by_native_run(seam, monkeypatch, protected_phone_hook, name):
    request = Mock(return_value={'principal_id': 'trusted-owner'})
    monkeypatch.setattr(seam.provider, '_request', request)
    tokens = set_session_vars(platform='api_server', session_id='child', session_key='admitted-run')
    try:
        result = protected_phone_hook(name, {'principal_id': 'foreign-owner'},
                                      session_id='child', tool_call_id='status-call')
        assert result == {'action': 'modify', 'args': {'principal_id': 'trusted-owner'}}
        request.assert_called_once_with('/internal/hermes/schedule-context', {'context': {
            'run_id': 'admitted-run', 'session_id': 'child', 'tool_call_id': 'status-call'}})
    finally:
        clear_session_vars(tokens)


@pytest.mark.parametrize('error', [HTTPError('http://127.0.0.1:9', 403, 'forbidden', {}, BytesIO(b'{}')),
                                 URLError('offline'), RuntimeError('resolver failed')])
def test_phone_status_scope_failure_cannot_fall_through(seam, monkeypatch, protected_phone_hook, error):
    monkeypatch.setattr(seam.provider, '_request', Mock(side_effect=error))
    tokens = set_session_vars(platform='api_server', session_id='child', session_key='admitted-run')
    try:
        assert protected_phone_hook('mcp__phone__phone_status', {'principal_id': 'foreign-owner'},
                                     session_id='child', tool_call_id='status-call')['action'] == 'block'
    finally:
        clear_session_vars(tokens)


@pytest.mark.parametrize('mcp', [False, True])
@pytest.mark.parametrize('source', ['owner', 'glasses_nod', 'glasses_no', 'guest', 'care', 'person_observation', 'missing_binding', 'source_failure'])
@pytest.mark.parametrize('operation', ['payment', 'ride'])
@pytest.mark.parametrize('trusted_run', [True, False])
def test_registered_protected_phone_hook_uses_trusted_run_and_source_admission(seam, monkeypatch, protected_phone_hook, mcp, source, operation, trusted_run):
    from tools.mcp_tool_schema import mcp_prefixed_tool_name
    requests = []
    def payment_response(path, body):
        requests.append((path, body))
        if source == 'source_failure':
            raise HTTPError('http://127.0.0.1:9', 503, 'source unavailable', {}, BytesIO(b''))
        bound = (body.get('run_id') if 'run_id' in body else body['context']['run_id']) == 'trusted-admission-run'
        if path.endswith('phone-task-context'):
            return {'principal_id': 'trusted-owner', 'job_id': 'server-job', 'origin_processed_event_id': 'server-origin'} if bound and source in {'owner', 'glasses_nod', 'glasses_no'} else {}
        return {'allowed': bound and source == 'owner' and body.get('intent_id') == 'pi-trusted-intent',
                'ride_allowed': bound and source in {'owner', 'glasses_nod'}}
    monkeypatch.setattr(seam.provider, '_request', payment_response)
    name = mcp_prefixed_tool_name('phone', 'phone_task') if mcp else 'phone_task'
    run = '' if source == 'missing_binding' else ('trusted-admission-run' if trusted_run else 'untrusted-admission-run')
    tokens = set_session_vars(platform='api_server', session_id='session-host', session_key=run)
    try:
        args = {'goal': 'owner task', 'effect': {'kind': 'external', 'task_type': operation, 'requested': True}, 'run_id': 'model-forged', 'job_id': 'model-job', 'origin_processed_event_id': 'model-origin', **(
            {'payment_intent': 'pi-trusted-intent'} if operation == 'payment' else {'ride_ok': True})}
        verdict = protected_phone_hook(name, args, session_id='session-host', run_id='kwargs-forged')
        allowed = trusted_run and bool(run) and (source == 'owner' or operation == 'ride' and source == 'glasses_nod')
        assert (verdict == {'action': 'modify', 'args': {'principal_id': 'trusted-owner', 'job_id': 'server-job', 'origin_processed_event_id': 'server-origin'}}) if allowed else (verdict['action'] == 'block')
        owner_request = ('/internal/hermes/phone-task-context', {'context': {'run_id': run, 'session_id': 'session-host', 'tool_call_id': ''}})
        assert requests == ([] if source == 'missing_binding' else [owner_request,
            *([] if source == 'source_failure' else [('/internal/hermes/payment-source', {'run_id': run, **(
                {'intent_id': 'pi-trusted-intent'} if operation == 'payment' else {})})])])
        # Ordinary phone work binds ownership without requiring payment permission.
        requests.clear()
        ordinary = protected_phone_hook(name, {'goal': 'compare delivery options', 'effect': {'kind': 'read', 'task_type': 'compare_delivery', 'requested': True}, 'principal_id': 'forged'}, session_id='session-host')
        owned = trusted_run and source in {'owner', 'glasses_nod', 'glasses_no'}
        if owned:
            assert ordinary == {'action': 'modify', 'args': {'principal_id': 'trusted-owner', 'job_id': 'server-job', 'origin_processed_event_id': 'server-origin'}}
        else:
            assert ordinary['action'] == 'block'
        assert requests == ([] if source == 'missing_binding' else [owner_request])
    finally:
        clear_session_vars(tokens)


def test_I1_legacy_payment_limit_is_blocked_before_executor_dispatch(seam, monkeypatch, tmp_path, protected_phone_hook):
    token = set_hermes_home_override(tmp_path)
    tokens = set_session_vars(platform='api_server', session_id='session-host', session_key='trusted-admission-run')
    try:
        import model_tools
        from hermes_cli import lifecycle
        executor = Mock(return_value=json.dumps({'status': 'started'}))
        authority = Mock(return_value={"principal_id": "trusted-owner", "job_id": "server-job", "origin_processed_event_id": "server-origin"})
        monkeypatch.setattr(model_tools.registry, 'dispatch', executor)
        monkeypatch.setattr(seam.provider, '_request', authority)
        monkeypatch.setattr(lifecycle, 'invoke_hook', lambda event, **kwargs:
                            [protected_phone_hook(**kwargs)] if event == 'pre_tool_call' else [])
        for name in ('phone_task', 'mcp__phone__phone_task'):
            # Positive control: this spy is the dispatch boundary, not an unrelated mock.
            assert json.loads(model_tools.handle_function_call(name, {'goal': 'compare delivery options', 'effect': {'kind': 'read', 'task_type': 'compare_delivery', 'requested': True}},
                session_id='session-host', skip_tool_request_middleware=True,
                skip_tool_execution_middleware=True)) == {'status': 'started'}
            executor.assert_called_once()
            executor.reset_mock()
            authority.assert_called_once()
            authority.reset_mock()
            for legacy in (None, 0, 30):
                result = model_tools.handle_function_call(name, {'goal': 'owner task', 'pay_limit_yuan': legacy,
                    'payment_intent': 'pi-trusted-intent'}, session_id='session-host',
                    skip_tool_request_middleware=True, skip_tool_execution_middleware=True)
                assert json.loads(result)['error'] == 'pay_limit_yuan 已取消：先调用 paios_payment(action=request)，再传 payment_intent'
                executor.assert_not_called()
        authority.assert_not_called()
        authority.side_effect = RuntimeError('private exception detail')
        result = model_tools.handle_function_call('phone_task', {'goal': 'owner task', 'effect': {'kind': 'external', 'task_type': 'purchase_errand', 'requested': True}},
            session_id='session-host', skip_tool_request_middleware=True, skip_tool_execution_middleware=True)
        assert json.loads(result)['error'] == 'PHONE_SOURCE_CHECK_FAILED: RuntimeError'
        assert 'private exception detail' not in result
        executor.assert_not_called()
    finally:
        clear_session_vars(tokens)
        reset_hermes_home_override(token)


@pytest.mark.parametrize('name', ['phone_task', 'mcp__phone__phone_task'])
@pytest.mark.parametrize('effect_allowed,payment_source', [(False, True), (True, False), (True, 'unavailable'), (True, True)])
def test_I1_typed_effect_gate_never_substitutes_for_payment_intent(seam, monkeypatch, tmp_path, name, effect_allowed, payment_source):
    import model_tools
    from hermes_cli import lifecycle, plugins
    manager = plugins.PluginManager()
    hooks, requests = {}, []
    monkeypatch.setitem(sys.modules, seam.module.__name__ + '.cron', SimpleNamespace(register=lambda *args: None))
    monkeypatch.setattr(seam.module, 'PersonalAIOSProvider', lambda: seam.provider)
    seam.module.register(SimpleNamespace(register_system_prompt_section=lambda *a, **kw: None, register_memory_provider=lambda provider: None,
        register_tool=lambda *args, **kwargs: True,
        register_hook=lambda event, hook: hooks.__setitem__(event, hook),
        register_middleware=lambda event, callback: manager._middleware.setdefault(event, []).append(callback)))
    def authority(path, body):
        requests.append((path, body))
        if path.endswith('/effect-consent'):
            return {'status': 'allowed' if effect_allowed else 'rejected'}
        if path.endswith('/phone-task-context'):
            return {'principal_id': 'trusted-owner', 'job_id': 'server-job', 'origin_processed_event_id': 'server-origin'}
        assert path.endswith('/payment-source')
        assert body == {'run_id': 'trusted-admission-run', 'intent_id': 'pi-request'}
        if payment_source == 'unavailable':
            raise TimeoutError('synthetic source unavailable')
        return {'allowed': payment_source, 'ride_allowed': True}
    monkeypatch.setattr(seam.provider, '_request', authority)
    dispatch = Mock(return_value=json.dumps({'status': 'started'}))
    monkeypatch.setattr(model_tools.registry, 'dispatch', dispatch)
    monkeypatch.setattr(lifecycle, 'invoke_hook', lambda *a, **k: [])
    monkeypatch.setattr(plugins, '_delivery_manager', lambda: manager)
    token = set_hermes_home_override(tmp_path)
    tokens = set_session_vars(platform='api_server', session_id='session-host', session_key='trusted-admission-run')
    try:
        result = json.loads(model_tools.handle_function_call(name, {
            'goal': 'synthetic purchase', 'effect': {'kind': 'external', 'task_type': 'purchase', 'requested': True},
            'payment_intent': 'pi-request', 'ride_ok': True, 'principal_id': 'forged-owner'},
            session_id='session-host', skip_tool_request_middleware=True))
        if effect_allowed and payment_source is True:
            assert result == {'status': 'started'}
            dispatch.assert_called_once()
            assert dispatch.call_args.args[1]['principal_id'] == 'trusted-owner'
        else:
            assert 'error' in result
            dispatch.assert_not_called()
        assert requests[0][0] == '/internal/hermes/effect-consent'
        assert len(requests) == (3 if effect_allowed else 1)
    finally:
        clear_session_vars(tokens)
        reset_hermes_home_override(token)


def test_phone_task_result_reports_the_owner_approval_that_gated_it(seam, monkeypatch, tmp_path):
    import model_tools
    from hermes_cli import lifecycle, plugins
    manager = plugins.PluginManager()
    hooks = {}
    monkeypatch.setitem(sys.modules, seam.module.__name__ + '.cron', SimpleNamespace(register=lambda *args: None))
    monkeypatch.setattr(seam.module, 'PersonalAIOSProvider', lambda: seam.provider)
    seam.module.register(SimpleNamespace(register_system_prompt_section=lambda *a, **kw: None, register_memory_provider=lambda provider: None,
        register_tool=lambda *args, **kwargs: True,
        register_hook=lambda event, hook: hooks.__setitem__(event, hook),
        register_middleware=lambda event, callback: manager._middleware.setdefault(event, []).append(callback)))
    approval = {'confirmation_id': 'a' * 64, 'choice': 'once', 'decided_by': 'trusted-owner',
                'decided_at': '2026-10-21T19:53:21.234Z', 'remembered': True, 'reused': True}
    def authority(path, body):
        if path.endswith('/effect-consent'):
            return {'status': 'allowed', 'approval': approval}
        return {'principal_id': 'trusted-owner', 'job_id': 'server-job', 'origin_processed_event_id': 'server-origin'}
    monkeypatch.setattr(seam.provider, '_request', authority)
    # Native MCP results arrive as {"result": "<server JSON>"}.
    dispatch = Mock(return_value=json.dumps({'result': json.dumps({'status': 'started', 'job_id': 'server-job'})}))
    monkeypatch.setattr(model_tools.registry, 'dispatch', dispatch)
    monkeypatch.setattr(lifecycle, 'has_hook', lambda event: False)
    monkeypatch.setattr(lifecycle, 'invoke_hook', lambda *a, **k: [])
    monkeypatch.setattr(plugins, '_delivery_manager', lambda: manager)
    token = set_hermes_home_override(tmp_path)
    tokens = set_session_vars(platform='api_server', session_id='session-host', session_key='trusted-admission-run')
    try:
        effect = {'kind': 'send', 'recipient': 'wechat:fixture', 'task_type': 'send_file', 'requested': True}
        result = json.loads(model_tools.handle_function_call('mcp__phone__phone_task', {'goal': 'send the file', 'effect': effect},
            session_id='session-host', skip_tool_request_middleware=True))
        assert json.loads(result['result']) == {'status': 'started', 'job_id': 'server-job'}
        assert result['approval'] == approval
        assert dispatch.call_args.args[1]['effect'] == {**effect, 'approval': approval}
    finally:
        clear_session_vars(tokens)
        reset_hermes_home_override(token)


@pytest.mark.asyncio
async def test_native_vision_http_is_raw_and_cache_cleanup_owns_the_profile(tmp_path, monkeypatch):
    """Exercise official vision staging/cleanup, including a competing service and provider error echo."""
    import asyncio
    import base64
    import signal
    import yaml
    from aiohttp import ClientSession, web
    from PIL import Image

    root = Path(__file__).parents[2]
    home = tmp_path / 'native-home'
    (home / 'plugins').mkdir(parents=True)
    (home / 'plugins/personal_aios').symlink_to(root / 'integrations/hermes/personal_aios')
    for relative in ('cache/vision/temp_image_crashed.img', 'temp_vision_images/temp_image_crashed.img'):
        orphan = home / relative
        orphan.parent.mkdir(parents=True)
        orphan.write_bytes(b'synthetic-crash-frame')
    key = 'synthetic-native-vision-test-key'
    (home / 'internal.key').write_text(key)
    entered, release = asyncio.Event(), asyncio.Event()
    calls, formal_captions = [], []

    async def completion(request):
        body = await request.json()
        calls.append(body)
        if 'Echo failure?' in str(body['messages']):
            return web.json_response({'error': {'message': str(body['messages'])}}, status=400)
        if 'Unsupported caption?' in str(body['messages']):
            return web.json_response({'error': {'message': 'response_format json_object unsupported'}}, status=400)
        if 'Read label?' in str(body['messages']):
            await asyncio.sleep(11)
        entered.set()
        await release.wait()
        if 'response_format' in body:
            assert body['response_format'] == {'type': 'json_object'}
            assert body['model'] == 'fixture-vision'
            assert '"additionalProperties": false' in str(body['messages'])
        content = 'Visible label.' if 'Read label?' in str(body['messages']) else '{"caption":"A label","ocr":"HELLO"}'
        if 'Where is the key?' in str(body['messages']):
            content = 'The key is on the white desk.'
        if 'Invalid caption?' in str(body['messages']):
            content = '{"caption":42,"ocr":"HELLO"}'
        if 'Fenced caption?' in str(body['messages']):
            content = '```json\n{"caption":"A label","ocr":"HELLO"}\n```'
        if 'first-person scene' in str(body['messages']):
            formal_captions.append(body)
            content = json.dumps({'caption': '白色桌面上放着钥匙，一位来访者站在旁边', 'ocr': '会议室 301'}
                                 if len(formal_captions) == 1 else {'caption': 42, 'ocr': ''})
        return web.json_response({'id': 'fixture', 'object': 'chat.completion', 'model': 'fixture',
            'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': content}, 'finish_reason': 'stop'}]})

    app = web.Application()
    app.router.add_post('/v1/chat/completions', completion)
    async def tool(request):
        body = await request.json()
        async with ClientSession() as client:
            async with client.post(f'http://127.0.0.1:{native_port}/v1/paios/vision',
                headers={'Authorization': 'Bearer ' + key}, json={'image_url': image, 'prompt': body['args']['question']}) as response:
                assert response.status == 200
                return web.json_response(await response.text())
    app.router.add_post('/internal/hermes/tools/paios_visual_analyze', tool)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    provider_port = site._server.sockets[0].getsockname()[1]
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        native_port = reservation.getsockname()[1]
    (home / 'config.yaml').write_text(yaml.safe_dump({
        'model': {'provider': 'custom', 'default': 'fixture', 'base_url': f'http://127.0.0.1:{provider_port}/v1', 'api_key': 'fixture'},
        'memory': {'provider': 'personal_aios'}, 'plugins': {'enabled': ['personal_aios'], 'entries': {'personal_aios': {'allow_tool_override': True}}},
        'personal_aios': {'internal_base_url': f'http://127.0.0.1:{provider_port}', 'internal_key_file': str(home / 'internal.key')},
        'platforms': {'personal_aios': {'enabled': True}}, 'auxiliary': {'vision': {'provider': 'custom', 'model': 'fixture-vision'}}}))
    env = {**os.environ, 'HERMES_HOME': str(home), 'API_SERVER_KEY': key, 'API_SERVER_HOST': '127.0.0.1',
        'API_SERVER_PORT': str(native_port), 'VISION_TOOLS_DEBUG': 'true', 'OPENAI_LOG': 'debug', 'PYTHONDONTWRITEBYTECODE': '1',
        'PYTHONPATH': str(Path(sys.modules['gateway.session_context'].__file__).parents[1])}
    command = [sys.executable, str(root / 'integrations/hermes/personal_aios/run_api.py')]
    with (home / 'service.log').open('w') as log:
        process = subprocess.Popen(command, env=env, stdout=log, stderr=log)
        try:
            async with ClientSession() as client:
                url = f'http://127.0.0.1:{native_port}'
                # Match Compose's native API startup period before measuring vision requests.
                async with asyncio.timeout(30):
                    while True:
                        assert process.poll() is None, (home / 'service.log').read_text()
                        try:
                            async with client.get(url + '/health') as response:
                                assert response.status == 200
                                break
                        except OSError:
                            await asyncio.sleep(.05)
                assert not any(home.rglob('temp_image_crashed.img'))
                buf = BytesIO()
                Image.new('RGB', (64, 64), 'white').save(buf, format='JPEG')
                image = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()

                schema = {'type': 'object', 'additionalProperties': False, 'required': ['caption', 'ocr'],
                    'properties': {'caption': {'type': 'string', 'pattern': r'\S', 'maxLength': 8000},
                                   'ocr': {'type': 'string', 'maxLength': 16000}}}
                async def analyze(prompt, structured=False):
                    async with client.post(url + '/v1/paios/vision', headers={'Authorization': 'Bearer ' + key},
                                           json={'image_url': image, 'prompt': prompt,
                                                 **({'response_schema': schema} if structured else {})}) as response:
                        return response.status, await response.text()

                work = asyncio.create_task(analyze('Return caption and ocr JSON'))
                await asyncio.wait_for(entered.wait(), 15)
                active = list((home / 'cache/vision').glob('temp_image_*'))
                assert active
                contender = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                output, _ = await asyncio.to_thread(contender.communicate, timeout=15)
                assert contender.returncode != 0 and b'BlockingIOError' in output
                assert all(path.exists() for path in active), 'competing startup must not delete active workers'
                release.set()
                assert await work == (200, '{"caption":"A label","ocr":"HELLO"}')
                status, caption = await analyze('Return caption and ocr JSON', True)
                assert status == 200 and json.loads(caption) == {'caption': 'A label', 'ocr': 'HELLO'}
                assert calls[-1]['response_format'] == {'type': 'json_object'}
                for prompt in ('Invalid caption?', 'Fenced caption?'):
                    assert await analyze(prompt, True) == (502, 'invalid structured visual response')
                before = len(calls)
                assert await analyze('Unsupported caption?', True) == (502, 'structured visual analysis failed')
                assert len(calls) == before + 1, 'unsupported JSON mode cannot retry without the format or switch models'
                assert calls[-1]['response_format'] == {'type': 'json_object'}
                assert await analyze('Invalid caption?') == (200, '{"caption":42,"ocr":"HELLO"}')
                spec = importlib.util.spec_from_file_location('slow_vision_provider', root / 'integrations/hermes/personal_aios/__init__.py')
                module = importlib.util.module_from_spec(spec)
                monkeypatch.setitem(sys.modules, spec.name, module)
                spec.loader.exec_module(module)
                token = set_hermes_home_override(home)
                try:
                    provider = module.PersonalAIOSProvider()
                finally:
                    reset_hermes_home_override(token)
                answer = await asyncio.to_thread(provider.handle_tool_call, 'paios_visual_analyze', {'question': 'Read label?'})
                assert json.loads(answer) == 'Visible label.'
                assert (await analyze('Echo failure?'))[0] == 502
                assert not list((home / 'cache/vision').glob('temp_image_*'))
                assert not list((home / 'logs').glob('vision_tools_debug_*.json'))
                assert not [path for path in home.rglob('*') if path.is_file() and image.encode() in path.read_bytes()]
                assert len(calls) == 8
                # Continuous producer/API -> formal camera -> durable person proof.
                proof = await asyncio.to_thread(subprocess.run,
                    ['node', '--test', '--test-reporter=spec',
                     '01-product-half-finished/backend/services/personal-aios-integration/tests/structured-vision-formal.test.ts'],
                    cwd=root, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1',
                        'PAIOS_VISION_PYTHON': os.environ.get('PAIOS_VISION_PYTHON', sys.executable),
                        'PAIOS_STRUCTURED_VISION_TEST_URL': url, 'PAIOS_STRUCTURED_VISION_TEST_TOKEN': key},
                    capture_output=True, text=True, timeout=45)
                assert proof.returncode == 0, proof.stdout + proof.stderr
                assert len(formal_captions) == 2
                assert all(call['model'] == 'fixture-vision' for call in calls)
        finally:
            release.set()
            process.send_signal(signal.SIGTERM)
            await asyncio.to_thread(process.wait, 20)
            await runner.cleanup()


@pytest.mark.parametrize('stage', ['phone-task-context', 'payment-source'])
@pytest.mark.parametrize('name', ['phone_task', 'mcp__phone__phone_task'])
def test_phone_hook_keeps_typed_server_errors(seam, monkeypatch, protected_phone_hook, stage, name):
    def request(path, body):
        if path.endswith('/' + stage):
            raise HTTPError('http://127.0.0.1', 403, 'private detail', {},
                BytesIO(b'{"error_code":"OWNER_REQUEST_REQUIRED","detail":"private detail"}'))
        return {'principal_id': 'trusted-owner', 'job_id': 'server-job', 'origin_processed_event_id': 'server-origin'}
    monkeypatch.setattr(seam.provider, '_request', request)
    tokens = set_session_vars(platform='api_server', session_id='session-host', session_key='trusted-admission-run')
    try:
        result = protected_phone_hook(name, {'payment_intent': 'pi-request'}, session_id='session-host')
        assert result == {'action': 'block', 'error_code': 'OWNER_REQUEST_REQUIRED',
                          'http_status': 403, 'message': 'OWNER_REQUEST_REQUIRED'}
    finally:
        clear_session_vars(tokens)
