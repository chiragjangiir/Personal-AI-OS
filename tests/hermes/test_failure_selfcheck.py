"""Exercise native failure ingress and dispatch without model or device calls."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from gateway.platforms.api_run_delegation import RunDelegation
from agent.turn_context import _stage_turn_user_message

ROOT = Path(__file__).parents[2]


@pytest.fixture(autouse=True)
def isolated_native_home(tmp_path):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    token = set_hermes_home_override(tmp_path)
    try:
        yield
    finally:
        reset_hermes_home_override(token)


def test_system_ingress_has_real_role():
    row, _ = _stage_turn_user_message(SimpleNamespace(), 'native evidence', None, None, None, None, None,
                                     message_role='system')
    assert row['role'] == 'system'


@pytest.mark.parametrize('prior', [{}, {'turn_exit_reason': ''}])
def test_native_failure_reason_retains_the_actual_error(prior):
    from gateway.platforms.api_server_runs import _native_run_body
    body = _native_run_body({'run_id': 'failed', 'status': 'failed', 'error': 'model step 1 provider disconnected', **prior},
                            'hermes.run.v2')
    assert body['turn_exit_reason'] == 'model step 1 provider disconnected'


def test_delivery_failure_uses_the_same_system_selfcheck(monkeypatch):
    from tools import delegate_tool
    calls, roles = [], []
    monkeypatch.setattr(delegate_tool, 'delegate_task', lambda **kw: calls.append(kw) or '{"status":"dispatched"}')
    bridge = RunDelegation(SimpleNamespace(_paios_delegate_toolsets=['file']), lambda waiting: None)
    app = {'kind': 'errand_delivery_failed', 'job_id': 'job-report', 'title': '查询店铺', 'task': '完整只读查询',
           'terminal_reason': 'failed', 'error_code': 'FORMAL_TEXT_OUTPUT_INVALID',
           'evidence_ref': {'tool': 'phone_status', 'job_id': 'job-report'}}
    d = {'origin': 'device_observation', 'content': {'app_event': app}}
    bridge.initial(json.dumps(d), [], lambda text, history, message_role: roles.append(message_role) or {})
    assert roles == ['system'] and len(calls) == 1
    assert calls[0]['goal'] == '自检：查询店铺'
    assert 'FORMAL_TEXT_OUTPUT_INVALID' in calls[0]['context'] and '完整只读查询' in calls[0]['context']
    app['self_check_of'] = 'original:0'
    bridge.initial(json.dumps(d), [], lambda text, history, message_role: {})
    assert len(calls) == 1


@pytest.mark.parametrize('status', ['failed', 'error', 'timeout', 'timed_out', 'interrupted'])
def test_failure_dispatches_one_async_selfcheck(monkeypatch, status):
    from tools import delegate_tool
    calls = []
    monkeypatch.setattr(delegate_tool, 'delegate_task', lambda **kw: calls.append(kw) or json.dumps({'status': 'dispatched'}))
    agent = SimpleNamespace(_paios_delegate_toolsets=['file'], _interrupt_requested=False)
    bridge = RunDelegation(agent, lambda waiting: None)
    event = {'delegation_id': 'original', 'goals': ['read shop cards'], 'status': 'completed',
             'is_batch': True, 'results': [{'task_index': 0, 'status': status, 'error': 'real failure'}]}
    bridge._start_failure_selfchecks([event])
    assert len(calls) == 1
    assert calls[0]['background'] is True
    assert calls[0]['goal'] == '自检：read shop cards'
    assert calls[0]['self_check_of'] == {'source': 'delegate', 'id': 'original:0'}
    assert 'skill_view' in calls[0]['context']


def test_selfcheck_and_cancel_do_not_recurse(monkeypatch):
    from tools import delegate_tool
    monkeypatch.setattr(delegate_tool, 'delegate_task', lambda **kw: pytest.fail('must not spawn'))
    bridge = RunDelegation(SimpleNamespace(_paios_delegate_toolsets=['file']), lambda waiting: None)
    bridge._start_failure_selfchecks([{'delegation_id': 'check', 'self_check_of': {'id': 'original'}, 'status': 'failed'}])
    bridge.agent._interrupt_requested = True
    bridge._start_failure_selfchecks([{'delegation_id': 'stopped', 'status': 'failed'}])


def test_phone_result_system_ingress_and_no_recursion(monkeypatch):
    from tools import delegate_tool
    calls, roles = [], []
    monkeypatch.setattr(delegate_tool, 'delegate_task', lambda **kw: calls.append(kw) or '{"status":"dispatched"}')
    bridge = RunDelegation(SimpleNamespace(_paios_delegate_toolsets=['file']), lambda waiting: None)
    d = {'origin': 'device_observation', 'content': {'app_event': {'kind': 'errand_result', 'job_id': 'job-1',
         'title': '查店铺', 'terminal_reason': 'timed_out', 'evidence_ref': {'tool': 'phone_status', 'job_id': 'job-1'}}}}
    def run(text, history, message_role):
        roles.append(message_role)
        return {'completed': True}
    bridge.initial(json.dumps(d), [], run)
    assert roles == ['system'] and len(calls) == 1
    assert calls[0]['goal'] == '自检：查店铺'
    assert 'phone_status' in calls[0]['context']
    d['content']['app_event']['self_check_of'] = 'original:0'
    bridge.initial(json.dumps(d), [], run)
    assert len(calls) == 1


def test_system_completion_busy_retry_and_durable_dedup(tmp_path, monkeypatch):
    from hermes_state import SessionDB
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from tools import async_delegation as native, delegate_tool
    from agent.tool_call_budget import ToolCallBudget
    token = set_hermes_home_override(tmp_path)
    db = SessionDB(tmp_path / 'state.db')
    db.create_session('owner', source='api_server')
    agent = SimpleNamespace(session_id='owner', _session_db=db, _interrupt_requested=False,
                            _paios_delegate_toolsets=['file'], tool_call_budget=ToolCallBudget(30, 5))
    bridge = RunDelegation(agent, lambda waiting: None)
    calls, attempts = [], []
    monkeypatch.setattr(delegate_tool, 'delegate_task', lambda **kw: calls.append(kw) or '{"status":"dispatched"}')
    try:
        handle = native.dispatch_async_delegation_batch(goals=['task'], context=None, toolsets=None,
            role='leaf', model=None, session_key='owner', parent_session_id='owner',
            runner=lambda: {'results': [{'task_index': 0, 'status': 'failed', 'error': 'evidence', 'session_id': 'child'}]},
            completion_callback=bridge.callback)
        def resume(text, history):
            attempts.append(text)
            if len(attempts) == 1:
                return {'failure_reason': 'session_busy', 'messages': history}
            assert calls == []
            db.append_message('owner', 'system', text)
            return {'completed': True, 'messages': history}
        bridge.resume({'messages': []}, resume)
        assert len(attempts) == 2 and len(calls) == 1
        assert 'session_search' in attempts[0] and 'child' in attempts[0]
        assert db._read_one('SELECT delivery_state FROM async_delegations WHERE delegation_id=?', (handle['delegation_id'],))[0] == 'delivered'
        bridge.callback({'type': 'async_delegation', 'delegation_id': handle['delegation_id']})
        bridge.resume({'messages': []}, lambda *_: pytest.fail('duplicate must not enter'))
        assert len(calls) == 1
    finally:
        db.close()
        reset_hermes_home_override(token)


def test_async_selfcheck_wait_does_not_hold_conversation_lease(tmp_path, monkeypatch):
    import threading
    from agent.turn_facade_lease import admit_durable_turn_lease
    from hermes_state import SessionDB
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from tools import async_delegation as native, delegate_tool
    token = set_hermes_home_override(tmp_path)
    db = SessionDB(tmp_path / 'state.db')
    db.create_session('owner', source='api_server')
    agent = SimpleNamespace(session_id='owner', platform='api_server', _session_db=db,
        _paios_delegate_toolsets=['file'], _api_reload_session_history=True,
        _emit_status=lambda text: None, _liveness_activity_lock=threading.RLock)
    bridge = RunDelegation(agent, lambda waiting: None)
    release = threading.Event()
    handles = []
    def dispatch(**kw):
        assert kw['background'] is True
        handle = native.dispatch_async_delegation_batch(goals=[kw['goal']], context=kw['context'],
            role='leaf', toolsets=None, model=None, session_key='owner', parent_session_id='owner',
            runner=lambda: (release.wait(5) and {'results': [{'task_index': 0, 'status': 'failed'}]}),
            self_check_of=kw['self_check_of'], completion_callback=bridge.callback)
        handles.append(handle)
        return json.dumps(handle)
    monkeypatch.setattr(delegate_tool, 'delegate_task', dispatch)
    admission = None
    try:
        bridge._start_failure_selfchecks([{'delegation_id': 'failed-task', 'status': 'failed', 'goal': 'shop query'}])
        assert handles[0]['status'] == 'dispatched' and bridge._live()
        admission = admit_durable_turn_lease(agent, session_id='owner', relay_turn_id='new-owner-turn',
            task_context={'session_id': 'owner', 'platform': 'api_server'}, conversation_history=[])
        assert admission.early_result is None and admission.lease is not None
        with native._DB_LOCK, native._transaction() as conn:
            payload = json.loads(conn.execute('SELECT task_json FROM async_delegations WHERE delegation_id=?',
                                             (handles[0]['delegation_id'],)).fetchone()[0])
        assert payload['self_check_of']['id'] == 'failed-task:0'
        admission.lease.release()
        admission = None
        release.set()
        event = bridge.results.get(timeout=5)
        assert event['self_check_of']['id'] == 'failed-task:0'
        bridge._start_failure_selfchecks([event])
        assert len(handles) == 1
    finally:
        release.set()
        if admission and admission.lease:
            admission.lease.release()
        db.close()
        reset_hermes_home_override(token)


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_name", ["phone_task", "phone_start", "phone_restore_apps", "phone_save_apps", "phone_close"])
async def test_phone_mcp_marker_comes_from_native_child(tool_name):
    from tools.mcp_tool_handlers import _call_tool_racing_stdio_death
    from tools.personal_aios_dispatch import current_tool_call
    seen = []
    class Session:
        async def call_tool(self, name, arguments, **kw):
            seen.append((name, arguments))
            return 'ok'
    child = SimpleNamespace(_self_check_of='original:0', tool_progress_callback=None)
    server = SimpleNamespace(session=Session())
    token = current_tool_call.set((child, 'call', 'mcp_phone_task'))
    try:
        assert await _call_tool_racing_stdio_death(server, 'phone', tool_name, {'task': 'query'}) == 'ok'
        assert seen == [(tool_name, {'task': 'query', 'self_check_of': 'original:0'})]
    finally:
        current_tool_call.reset(token)


@pytest.mark.asyncio
async def test_nested_phone_retains_selfcheck_origin(monkeypatch):
    from run_agent import AIAgent
    from tools import delegate_tool
    import tools.delegate_tool_config as delegate_config
    from tools.mcp_tool_handlers import _call_tool_racing_stdio_death
    from tools.personal_aios_dispatch import current_tool_call
    cfg = yaml.safe_load((ROOT / 'deploy/cloud/hermes-product-config.yaml').read_text())['delegation']
    assert cfg['max_spawn_depth'] == 2
    monkeypatch.setattr(delegate_tool, '_load_config', lambda: cfg)
    monkeypatch.setattr(delegate_config, '_load_config', lambda: cfg)
    seen = []
    class Session:
        async def call_tool(self, name, arguments, **kw):
            seen.append((name, arguments))
            return 'ok'
    parent = AIAgent(session_id='owner', api_key='k', base_url='https://openrouter.ai/api/v1', provider='openrouter',
                     api_mode='chat_completions', model='anthropic/claude-sonnet-4.6', platform='cli', quiet_mode=True,
                     skip_context_files=True, skip_memory=True, save_trajectories=False, enabled_toolsets=['file'])
    agents = [parent]
    try:
        child = delegate_tool._build_child_agent(task_index=0, goal='自检', context=None, toolsets=['file'], model=None,
                                                 max_iterations=4, task_count=1, parent_agent=parent)
        agents.append(child)
        child._self_check_of = 'original:0'
        grandchild = delegate_tool._build_child_agent(task_index=0, goal='只读复跑', context=None, toolsets=['file'],
                                                      model=None, max_iterations=4, task_count=1, parent_agent=child)
        agents.append(grandchild)
        assert grandchild._delegate_depth == 2
        token = current_tool_call.set((grandchild, 'call', 'mcp_phone_task'))
        try:
            assert await _call_tool_racing_stdio_death(SimpleNamespace(session=Session()), 'phone', 'phone_task',
                                                       {'task': 'query'}) == 'ok'
        finally:
            current_tool_call.reset(token)
        assert seen == [('phone_task', {'task': 'query', 'self_check_of': 'original:0'})]
    finally:
        for agent in reversed(agents):
            agent.close()


@pytest.mark.parametrize('source', ['cron', 'workshop'])
def test_task_failure_uses_same_system_selfcheck_path(monkeypatch, source):
    from tools import delegate_tool
    calls = []
    monkeypatch.setattr(delegate_tool, 'delegate_task', lambda **kw: calls.append(kw) or '{"status":"dispatched"}')
    bridge = RunDelegation(SimpleNamespace(_paios_delegate_toolsets=['file']), lambda waiting: None)
    app = {'kind': 'task_failure', 'failure_source': source, 'job_id': 'job:occurrence', 'title': 'repair task',
           'terminal_reason': 'failed', 'evidence_ref': {'tool': 'session_search', 'session_id': 'actual-child'}}
    def run(text, history, message_role):
        assert message_role == 'system'
        return {'completed': True}
    bridge.initial(json.dumps({'origin': 'device_observation', 'content': {'app_event': app}}), [], run)
    assert calls[0]['self_check_of']['source'] == source
    assert 'actual-child' in calls[0]['context']
    app['terminal_reason'] = 'cancelled'
    bridge.initial(json.dumps({'origin': 'device_observation', 'content': {'app_event': app}}), [], run)
    assert len(calls) == 1


def test_selfcheck_rejection_is_explicit_system_completion(monkeypatch):
    from tools import delegate_tool
    monkeypatch.setattr(delegate_tool, 'delegate_task', lambda **kw: '{"status":"rejected","error":"native capacity"}')
    bridge = RunDelegation(SimpleNamespace(_paios_delegate_toolsets=['file']), lambda waiting: None)
    bridge._start_failure_selfchecks([{'delegation_id': 'original', 'goal': 'task', 'status': 'failed'}])
    report = bridge.results.get_nowait()
    assert report['self_check_of'] == 'original:0'
    assert report['status'] == 'error' and report['error'] == 'native capacity'
    bridge._start_failure_selfchecks([report])
    assert bridge.results.empty()


def test_system_input_keeps_role_through_compaction_and_interrupted_admission():
    from agent.turn_context import reanchor_current_turn_user_idx
    from agent.conversation_loop import _restore_user_after_reference_handoff
    from agent.turn_facade_lease import carry_unadmitted_user_message
    messages = [{'role': 'user', 'content': 'owner speech'}, {'role': 'system', 'content': 'failure evidence'}]
    assert reanchor_current_turn_user_idx(messages, 'failure evidence', message_role='system') == 1
    assert reanchor_current_turn_user_idx(messages, 'rewritten system evidence', message_role='system') == -1
    assert _restore_user_after_reference_handoff(messages, 'failure evidence', message_role='system') is False
    assert _restore_user_after_reference_handoff(messages, 'restored failure', message_role='system') is True
    assert messages[-1]['role'] == 'system'
    early = {'interrupted': True, 'messages': []}
    carry_unadmitted_user_message(early, 'failure evidence', None, timestamp=None, display_kind=None,
        display_metadata=None, platform_id=None, message_role='system')
    assert early['messages'][0]['role'] == 'system'


def test_interim_uses_api_callback_without_acknowledging_final(tmp_path, monkeypatch):
    from hermes_state import SessionDB
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from tools import async_delegation as native
    import threading
    token = set_hermes_home_override(tmp_path)
    db = SessionDB(tmp_path / 'state.db')
    db.create_session('owner', source='api_server')
    agent = SimpleNamespace(session_id='owner', _session_db=db)
    bridge = RunDelegation(agent, lambda waiting: None)
    release = threading.Event()
    try:
        handle = native.dispatch_async_delegation_batch(goals=['fails', 'long sibling'], context=None,
            toolsets=None, role='leaf', model=None, session_key='owner', parent_session_id='owner',
            runner=lambda: (release.wait(5) and {'results': []}), completion_callback=bridge.callback)
        native.push_task_failure_notice(handle['delegation_id'], {'task_index': 0, 'status': 'failed'}, n_tasks=2)
        interim = bridge.results.get_nowait()
        assert interim['task_failure_notice'] is True
        monkeypatch.setattr(bridge, '_live', lambda: [])
        def ingest(text, history):
            db.append_message('owner', 'system', text)
            return {'messages': history}
        bridge.results.put(interim)
        bridge.resume({'messages': []}, ingest)
        assert db._read_one('SELECT delivery_state FROM async_delegations WHERE delegation_id=?',
                           (handle['delegation_id'],))[0] == 'pending'
    finally:
        release.set()
        db.close()
        reset_hermes_home_override(token)


def test_user_stopped_child_does_not_selfcheck(monkeypatch):
    from tools import delegate_tool
    monkeypatch.setattr(delegate_tool, 'delegate_task', lambda **kw: pytest.fail('user stopped child'))
    bridge = RunDelegation(SimpleNamespace(_paios_delegate_toolsets=['file']), lambda waiting: None)
    bridge._start_failure_selfchecks([{'delegation_id': 'original', 'status': 'interrupted',
                                      'goal': 'task', 'cancelled_by_user': True}])


def test_interim_and_final_reuse_admitted_native_selfcheck_identity(tmp_path, monkeypatch):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from tools import async_delegation as native, delegate_tool
    import threading
    token = set_hermes_home_override(tmp_path)
    release = threading.Event()
    bridge = RunDelegation(SimpleNamespace(_paios_delegate_toolsets=['file']), lambda waiting: None)
    handles = []
    def dispatch(**kw):
        handle = native.dispatch_async_delegation_batch(goals=[kw['goal']], context=kw['context'],
            toolsets=None, role='leaf', model=None, session_key='owner', self_check_of=kw['self_check_of'],
            runner=lambda: (release.wait(5) and {'results': []}), completion_callback=bridge.callback)
        handles.append(handle)
        return json.dumps(handle)
    monkeypatch.setattr(delegate_tool, 'delegate_task', dispatch)
    event = {'delegation_id': 'original-batch', 'goals': ['short failure', 'long sibling'],
             'results': [{'task_index': 0, 'status': 'failed'}], 'task_failure_notice': True}
    try:
        bridge._start_failure_selfchecks([event])
        assert handles[0]['status'] == 'dispatched'
        assert native.selfcheck_dispatched('original-batch:0')
        event['task_failure_notice'] = False
        event['results'].append({'task_index': 1, 'status': 'completed'})
        bridge._start_failure_selfchecks([event])
        assert len(handles) == 1
    finally:
        release.set()
        bridge.results.get(timeout=5)
        reset_hermes_home_override(token)


@pytest.mark.parametrize('reason,is_user', [('explicit stop requested', True), ('watchdog timeout', False)])
def test_child_interrupt_attribution_uses_native_authority(reason, is_user):
    from tools.delegate_tool_child_run import _build_result_entry, _SchemaOutcome
    entry = _build_result_entry(SimpleNamespace(_tool_interrupt_reason=reason),
        {'interrupted': True, 'final_response': 'Operation interrupted.'}, 0, 1.0, _SchemaOutcome(None, None, [], 0))
    assert entry['cancelled_by_user'] is is_user and entry['interrupt_reason'] == reason
