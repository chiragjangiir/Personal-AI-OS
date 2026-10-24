"""Real native hook/middleware/approval queues, with an isolated tool sink."""
import json
import threading
from io import BytesIO
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from queue import Queue
from types import SimpleNamespace
from urllib.error import HTTPError

import pytest


@pytest.fixture
def consent(monkeypatch, tmp_path, request):
    import model_tools
    from gateway import session_context
    from hermes_cli import lifecycle, plugins
    from agent.tool_executor import _run_agent_tool_execution_middleware, _ConcurrentToolAuthorizationGate
    from agent.agent_runtime_helpers import invoke_tool
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from tools import approval, approval_context
    from plugins.memory import _load_provider_from_dir

    memory_first = getattr(request, 'param', 'general-first') == 'memory-first'
    source = Path(__file__).parents[2] / 'integrations/hermes/personal_aios/__init__.py'
    token = set_hermes_home_override(tmp_path)
    (tmp_path / 'config.yaml').write_text('plugins:\n  allow_deprecated_imports: true\n  entries:\n    personal_aios:\n      allow_tool_override: true\nsecurity:\n  tirith_enabled: false\n')
    manager = plugins.PluginManager()
    monkeypatch.setattr(plugins, '_delivery_manager', lambda: manager)
    monkeypatch.setattr(plugins, 'get_plugin_manager', lambda: manager)
    cards, records, executions, posts, checks = Queue(), {}, [], [], []

    def request(path, body):
        if path.endswith('/effect-consent'):
            checks.append(json.loads(json.dumps(body)))
            if set(body['effect']) - {'kind', 'recipient', 'task_type', 'requested', 'summary'}:
                raise HTTPError('http://fixture/effect-consent', 400, 'classification', {},
                                BytesIO(b'{"error_code":"EFFECT_CLASSIFICATION_REQUIRED"}'))
            if body['effect']['kind'] == 'read':
                return {'status': 'allowed'}
            effect = body['effect']
            key = (effect['recipient'], effect['task_type'])
            if body.get('approved'):
                records[key] = {**body['confirmation'], 'choice': 'once', 'reused': False}
                return {'status': 'allowed', 'approval': records[key]}
            return ({'status': 'allowed', 'approval': {**records[key], 'reused': True}} if key in records else
                    {'status': 'confirmation_required', 'scope': {'principal_id': 'owner', **effect}})
        assert path.endswith('/phone-task-context') or path.endswith('/schedule-context')
        return {'principal_id': 'owner', 'job_id': 'job-fixture', 'origin_processed_event_id': 'origin-fixture'}

    provider = SimpleNamespace(_request=request)
    def load_memory():
        loaded = _load_provider_from_dir(source.parent)
        assert loaded is not None
        monkeypatch.setattr(type(loaded), '_request', lambda self, path, body: provider._request(path, body))
    if memory_first:
        load_memory()
    manager._load_plugin(plugins.PluginManifest(name='personal_aios', key='personal_aios', source='user', path=str(source.parent)))
    assert manager._plugins['personal_aios'].enabled, manager._plugins['personal_aios'].error
    module = manager._plugins['personal_aios'].module
    monkeypatch.setattr(module.PersonalAIOSProvider, '_request', lambda self, path, body: provider._request(path, body))
    if not memory_first:
        load_memory()
    manager._hooks.setdefault('post_tool_call', []).append(lambda **event: posts.append(event))
    monkeypatch.setattr(plugins, '_resolve_hook_callback_timeout', lambda: 30.0)
    monkeypatch.setattr(lifecycle, 'invoke_hook', manager.invoke_hook)
    monkeypatch.setattr(lifecycle, 'has_hook', lambda name: bool(manager._hooks.get(name)))
    monkeypatch.setattr(approval_context, '_get_approval_timeout', lambda: 120)

    native_dispatch = model_tools.registry.dispatch
    def sink(name, args, **kwargs):
        executions.append((name, args))
        if name in {'execute_code', 'terminal'}:
            return native_dispatch(name, args, **kwargs)
        return json.dumps({'status': 'started' if name.endswith('phone_task') else 'ok'})
    monkeypatch.setattr(model_tools.registry, 'dispatch', sink)

    def call(name, args, session='owner-session', call_id='call-gated', begin=None):
        home_token = set_hermes_home_override(tmp_path)
        tokens = session_context.set_session_vars(platform='api_server', session_id=session, session_key=session)
        approval_token = approval_context.set_current_session_key(session)
        try:
            agent = SimpleNamespace(session_id=session, quiet_mode=True, tool_progress_callback=None, tool_start_callback=None,
                _checkpoint_mgr=SimpleNamespace(enabled=False), _touch_activity=lambda *a: None,
                _memory_manager=None, _context_engine_tool_names=set(), valid_tool_names={'execute_code', 'terminal'},
                _tool_guardrails=SimpleNamespace(before_call=lambda *a: SimpleNamespace(allows_execution=True)))
            agent._invoke_tool = lambda *a, **k: invoke_tool(agent, *a, **k)
            managed = _run_agent_tool_execution_middleware(agent, function_name=name, function_args=args,
                effective_task_id=session, tool_call_id=call_id, begin_execution=begin.advance if begin else None,
                authorization_gate=_ConcurrentToolAuthorizationGate(), execute=lambda final:
                model_tools.handle_function_call(name, final, session_id=session, tool_call_id=call_id,
                    skip_pre_tool_call_hook=True, skip_tool_request_middleware=True, skip_tool_execution_middleware=True))
            return json.loads(managed.result)
        finally:
            approval_context.reset_current_session_key(approval_token)
            session_context.clear_session_vars(tokens)
            reset_hermes_home_override(home_token)

    approval.register_gateway_notify('owner-session', cards.put)
    def confirm(card):
        return approval.resolve_gateway_approval('owner-session', 'once', request_id=card['request_id'],
            confirmation={'confirmation_id': card['request_id'], 'confirmed_by': 'owner',
                          'surface': {'device_id': 'fixture-phone', 'device_type': 'phone'}})
    pool = ThreadPoolExecutor(max_workers=3)
    state = SimpleNamespace(call=call, pool=pool, cards=cards, records=records, executions=executions, checks=checks,
                            manager=manager, approval=approval, provider=provider, confirm=confirm, start_gates=[], posts=posts)
    yield state
    approval.unregister_gateway_notify('owner-session')
    for start in state.start_gates:
        start.abandon()
    pool.shutdown(wait=True)
    manager.unload()
    reset_hermes_home_override(token)


def action(tool):
    effect = {'kind': 'send', 'recipient': 'email:fixture@example.com', 'task_type': 'send_file', 'requested': True}
    return ({'target': 'email:fixture@example.com', 'message': 'fixture', 'requested': True} if tool == 'send_message' else
            {'goal': 'send fixture', 'effect': effect})


@pytest.mark.parametrize('consent', ['general-first', 'memory-first'], indirect=True)
@pytest.mark.parametrize('tool', ['phone_task', 'mcp__phone__phone_task', 'send_message'])
def test_once_approval_dispatches_once_and_remembered_consent_needs_no_card(consent, tool):
    future = consent.pool.submit(consent.call, tool, action(tool))
    card = consent.cards.get(timeout=5)
    assert consent.confirm(card) == 1
    result = future.result(timeout=5)
    assert result.get('status') == ('started' if tool.endswith('phone_task') else 'ok'), result
    assert len(consent.manager._middleware['tool_dispatch']) == 2
    assert result['approval']['choice'] == 'once' and result['approval']['reused'] is False
    assert result['approval']['confirmed_by'] == 'owner'
    assert result['approval']['surface'] == {'device_id': 'fixture-phone', 'device_type': 'phone'}
    assert result['approval']['confirmed_at'].endswith('Z')
    assert len(consent.executions) == 1
    assert len(consent.checks) == 2 and consent.checks[-1]['approved'] is True
    reused = consent.call(tool, action(tool), session='fresh-session', call_id='fresh-call')
    assert reused['approval']['reused'] is True
    assert len(consent.checks) == 3 and len(consent.executions) == 2
    assert consent.cards.empty()


def test_execute_code_terminal_returns_through_native_chain(consent, monkeypatch, tmp_path):
    from agent.tool_executor import _StartOrderGate, _WorkerStartOnce
    from tools import code_execution_tool, code_kernel
    monkeypatch.setenv('TERMINAL_ENV', 'local')
    monkeypatch.setenv('TERMINAL_CWD', str(tmp_path))
    monkeypatch.setattr(code_execution_tool, '_load_config', lambda: {'mode': 'strict', 'timeout': 8})
    start = _StartOrderGate(120)
    consent.start_gates.append(start)
    try:
        future = consent.pool.submit(consent.call, 'execute_code', {
            'code': 'from hermes_tools import terminal\nprint(terminal(command="printf nested-returned")["output"])'},
            'owner-session', 'code-call', _WorkerStartOnce(start, 0, 'execute_code'))
        card = consent.cards.get(timeout=5)
        assert card['pattern_key'] == 'execute_code'
        consent.approval.resolve_gateway_approval('owner-session', 'once', request_id=card['request_id'])
        result = future.result(timeout=12)
        assert result['status'] == 'success', result
        assert 'nested-returned' in result['output']
        assert [name for name, _ in consent.executions] == ['execute_code', 'terminal']
        nested = [event for event in consent.posts if event['tool_name'] == 'terminal']
        assert len(nested) == 1 and nested[0]['tool_call_id'].startswith('nested-')
        assert consent.cards.empty() and consent.checks == []
    finally:
        code_kernel.shutdown_all_kernels()


@pytest.mark.parametrize('tool', ['mcp__phone__phone_task', 'send_message'])
def test_pending_over_30_seconds_keeps_same_and_other_session_tools_running(consent, tool):
    from agent.tool_executor import _StartOrderGate, _WorkerStartOnce
    start = _StartOrderGate(120)
    consent.start_gates.append(start)
    future = consent.pool.submit(consent.call, tool, action(tool), 'owner-session', 'call-gated', _WorkerStartOnce(start, 0, tool))
    card = consent.cards.get(timeout=5)
    # Exercise the real 30-second native hook cliff, without shortening its timeout.
    assert not threading.Event().wait(31.1)
    for session in ('owner-session', 'another-session'):
        begin = _WorkerStartOnce(start, 1, 'read_file') if session == 'owner-session' else None
        read = consent.pool.submit(consent.call, 'read_file', {'path': 'fixture'}, session, 'read-' + session, begin)
        assert read.result(timeout=3) == {'status': 'ok'}
    assert not future.done(), 'an undecided action must still be pending'
    assert consent.records == {}
    assert consent.confirm(card) == 1
    result = future.result(timeout=5)
    assert result['status'] == ('started' if tool.endswith('phone_task') else 'ok')
    assert result['approval']['confirmation_id'] == card['request_id']
    assert [name for name, _ in consent.executions].count(tool) == 1
    assert consent.approval.resolve_gateway_approval('owner-session', 'once', request_id=card['request_id']) == 0
    assert [name for name, _ in consent.executions].count(tool) == 1
    assert not consent.manager._hook_timeout_suppressed_until


@pytest.mark.parametrize('finish', ['deny', 'withdraw', 'teardown', 'interrupt'])
def test_refusal_or_agent_moved_on_never_dispatches_a_late_yes(consent, finish):
    from tools.interrupt import set_interrupt
    thread = Queue()
    def call():
        thread.put(threading.get_ident())
        return consent.call('mcp__phone__phone_task', action('mcp__phone__phone_task'))
    future = consent.pool.submit(call)
    tid = thread.get(timeout=5)
    card = consent.cards.get(timeout=5)
    if finish == 'deny':
        consent.approval.resolve_gateway_approval('owner-session', 'deny', request_id=card['request_id'])
    elif finish == 'withdraw':
        consent.approval.withdraw_gateway_approval('owner-session', card['request_id'], 'session_closed')
    elif finish == 'teardown':
        consent.approval.unregister_gateway_notify('owner-session')
    else:
        set_interrupt(True, tid, reason='parent completed')
    try:
        result = future.result(timeout=5)
    finally:
        set_interrupt(False, tid)
    assert 'error' in result
    assert result['status'] == ('confirmation_denied' if finish == 'deny' else 'confirmation_cancelled')
    assert result['approval_request_id'] == card['request_id']
    assert len(consent.posts) == 1 and consent.posts[0]['tool_call_id'] == 'call-gated'
    assert consent.executions == [] and consent.records == {}
    assert consent.approval.resolve_gateway_approval('owner-session', 'once', request_id=card['request_id']) == 0
    assert consent.executions == []
    assert len(consent.posts) == 1


def test_execution_gate_cannot_fail_open_when_native_middleware_skips_escaping_errors(consent):
    def fail(*args):
        raise RuntimeError('private detail')
    consent.provider._request = fail
    assert consent.call('phone_start', {}) == {'error': 'EFFECT_GATE_FAILED: RuntimeError'}
    assert consent.executions == []


def test_unanswered_card_expiry_is_not_reported_as_an_owner_refusal(consent, monkeypatch):
    from tools import approval_context
    monkeypatch.setattr(approval_context, '_get_approval_timeout', lambda: .05)
    result = consent.call('send_message', action('send_message'))
    assert result['status'] == 'confirmation_expired'
    assert consent.records == {} and consent.executions == []


def test_parent_interrupt_after_yes_before_dispatch_cannot_start_stale_action(consent):
    from tools.interrupt import set_interrupt
    request = consent.provider._request
    def approved(path, body):
        result = request(path, body)
        if body.get('approved'):
            set_interrupt(True, reason='parent completed')
        return result
    consent.provider._request = approved
    def call():
        try:
            return consent.call('mcp__phone__phone_task', action('mcp__phone__phone_task'))
        finally:
            set_interrupt(False)
    future = consent.pool.submit(call)
    card = consent.cards.get(timeout=5)
    consent.confirm(card)
    assert future.result(timeout=5) == {'error': 'EFFECT_EXECUTION_CANCELLED', 'status': 'cancelled'}
    assert consent.executions == []
