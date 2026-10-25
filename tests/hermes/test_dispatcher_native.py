"""Native dispatcher lifecycle checks against the exported patched producer.

These use deterministic workers. They do not establish real-model task semantics.
"""
import concurrent.futures
import json
import threading
from types import SimpleNamespace

import pytest

from agent.tool_call_budget import ToolCallBudget, claim_tool_call, inject_milestones
from gateway.platforms.api_run_amendment import amend
from gateway.platforms.api_run_delegation import RunDelegation
from gateway.platforms.api_server_run_idempotency import RunIdempotencyStore
from hermes_constants import reset_hermes_home_override, set_hermes_home_override


@pytest.mark.parametrize('arguments', [{'action': 'list'}, {'action': 'create', 'build': True}])
def test_sequential_registry_preserves_host_owned_conversation(monkeypatch, arguments):
    from agent import tool_executor
    from agent.inline_tool_executors import tool_hook_ids
    import model_tools
    child = SimpleNamespace(session_id='child-transcript', _paios_tool_conversation='owner-conversation',
        quiet_mode=False, _context_engine_tool_names=set(), _memory_manager=None, valid_tool_names={'cronjob_manage'},
        enabled_toolsets=['cronjob'], disabled_toolsets=[], _current_turn_id='turn', _current_api_request_id='api')
    received = []
    def registry(name, args, task, **identity):
        received.append((name, args, task, identity))
        return json.dumps({'success': True})
    monkeypatch.setattr(model_tools, 'handle_function_call', registry)
    ref = tool_executor._ToolCallRef('cronjob_manage', arguments, 'task', 'call', [])
    dispatch = tool_executor._resolve_sequential_dispatch(child, ref, [])
    assert json.loads(dispatch.execute(arguments))['success'] is True
    name, args, task, identity = received[0]
    assert (name, args, task) == ('cronjob_manage', arguments, 'task')
    expected = tool_hook_ids(child, 'task', 'call')
    assert {key: identity[key] for key in ('session_id', 'tool_call_id', 'turn_id', 'api_request_id')} == {
        key: expected[key] for key in ('session_id', 'tool_call_id', 'turn_id', 'api_request_id')}
    assert child.session_id == 'child-transcript'


def test_task_tool_invocations_are_atomic_across_nested_tree():
    budget = ToolCallBudget(31, 5)
    agents = [SimpleNamespace(tool_call_budget=budget) for _ in range(4)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(lambda i: claim_tool_call(agents[i % 4]), range(100)))
    assert sum(result is None for result in results) == 31
    assert budget.used == 31
    messages = []
    for agent in agents:
        inject_milestones(agent, messages)
    assert sorted(n for a in agents for n in getattr(a, '_tool_call_milestones', [])) == []
    all_milestones = ''.join(m['content'] for m in messages)
    assert all(str(n) in all_milestones for n in (5, 10, 15, 20, 25, 30))



@pytest.mark.parametrize('background', [False, True])
def test_independent_delegate_tasks_have_fresh_budgets_and_nested_work_shares_them(tmp_path, monkeypatch, background):
    from run_agent import AIAgent
    from tools import delegate_tool as delegate
    import tools.delegate_tool_config as delegate_config
    token = set_hermes_home_override(tmp_path)
    (tmp_path / 'config.yaml').write_text('agent:\n  max_tool_calls: 3\n  tool_call_milestone_interval: 2\n')
    cfg = {'max_spawn_depth': 2, 'max_concurrent_children': 3}
    monkeypatch.setattr(delegate, '_load_config', lambda: cfg)
    monkeypatch.setattr(delegate_config, '_load_config', lambda: cfg)
    from tools import delegation_live_log
    monkeypatch.setattr(delegation_live_log, 'create_live_transcripts', lambda *a, **kw: (None, [], []))
    batches, agents = [], []
    # Capture the actual constructed tasks at the shared sync/async dispatch boundary.
    def dispatch(batch, detached):
        assert detached is background
        batches.append(batch)
        agents.extend(child for _, _, child in batch.children)
        return '{}'
    monkeypatch.setattr(delegate, '_run_batch', dispatch)
    try:
        parent = AIAgent(session_id='budget-owner', api_key='k', base_url='https://openrouter.ai/api/v1',
            provider='openrouter', api_mode='chat_completions', model='anthropic/claude-sonnet-4.6', platform='cli',
            quiet_mode=True, skip_context_files=True, skip_memory=True, save_trajectories=False, enabled_toolsets=['file'])
        agents.append(parent)
        assert (parent.tool_call_budget.maximum, parent.tool_call_budget.interval) == (3, 2)
        assert claim_tool_call(parent) is None
        dispatched = delegate.delegate_task(tasks=[{'goal': 'inspect first artifact'}, {'goal': 'inspect sibling artifact'}], parent_agent=parent, background=background)
        assert batches, dispatched
        first, sibling = (child for _, _, child in batches[0].children)
        assert first.tool_call_budget is not parent.tool_call_budget
        assert sibling.tool_call_budget is not first.tool_call_budget
        assert (first.tool_call_budget.maximum, first.tool_call_budget.interval) == (3, 2)
        assert claim_tool_call(first) is None
        nested = delegate._build_child_agent(task_index=0, goal='nested work', context=None, toolsets=None,
            model=None, max_iterations=4, task_count=1, parent_agent=first)
        agents.append(nested)
        assert nested.tool_call_budget is first.tool_call_budget
        assert [claim_tool_call(nested) for _ in range(3)][-1].startswith('Task tool-call cap reached')
        assert (first.tool_call_budget.used, sibling.tool_call_budget.used, parent.tool_call_budget.used) == (3, 0, 1)
        delegate.delegate_task(goal='later independent task', parent_agent=parent, background=background)
        later = batches[1].children[0][2]
        assert later.tool_call_budget.used == 0 and later.tool_call_budget is not first.tool_call_budget
        assert claim_tool_call(later) is None
        # Continuing/steering the same object cannot replenish the exhausted task.
        assert claim_tool_call(first).startswith('Task tool-call cap reached')
        assert 'depth limit reached' in delegate.delegate_task(goal='too deep', parent_agent=nested)
    finally:
        for agent in reversed(agents):
            agent.close()
        reset_hermes_home_override(token)


def test_completion_uses_native_registry_and_resumes_same_run(tmp_path):
    from tools import async_delegation as native
    token = set_hermes_home_override(tmp_path)
    release = threading.Event()
    agent = SimpleNamespace(_interrupt_requested=False)
    states, synthesized = [], []
    bridge = RunDelegation(agent, states.append)
    try:
        handle = native.dispatch_async_delegation_batch(
            goals=['bounded synthetic work'], context=None, toolsets=None, role='leaf', model=None,
            session_key='native-run', parent_session_id='session', max_async_children=2,
            runner=lambda: (release.wait(5) and {'results': [{'task_index': 0, 'status': 'completed', 'summary': 'worker-evidence'}]}),
            completion_callback=agent._native_delegate_completion)
        assert handle['status'] == 'dispatched'
        assert bridge._live()[0]['delegation_id'] == handle['delegation_id']
        release.set()
        def synthesize(text, history):
            synthesized.append((text, history))
            return {'final_response': 'verified result', 'messages': history}
        result = bridge.resume({'final_response': 'working', 'messages': []}, synthesize)
        assert result['final_response'] == 'verified result'
        assert states[0] is True and states[-1] is False
        assert len(synthesized) == 1 and 'worker-evidence' in synthesized[0][0]
        assert not bridge._live()
        with native._DB_LOCK, native._transaction() as db:
            row = db.execute('SELECT delivery_state FROM async_delegations WHERE delegation_id=?', (handle['delegation_id'],)).fetchone()
        assert row[0] == 'pending'  # An in-memory-only consumer cannot acknowledge durable ingestion.
    finally:
        release.set()
        reset_hermes_home_override(token)


def test_amendment_receipt_survives_restart_and_pending_never_replays(tmp_path):
    path = str(tmp_path / 'native-runs.db')
    store = RunIdempotencyStore(path)
    calls = []
    receipt = {'object': 'hermes.run.steer', 'run_id': 'r', 'accepted': True,
               'amendment_id': 'a', 'delivered_to': 'delegate', 'delegate_task_ids': ['child']}
    assert amend(store, 'owner', 'r', 'a', 'new requirement', lambda: calls.append('a') or receipt) == receipt
    store.close()
    store = RunIdempotencyStore(path)
    assert amend(store, 'owner', 'r', 'a', 'new requirement', lambda: pytest.fail('duplicate delivery')) == receipt
    assert amend(store, 'owner', 'r', 'a', 'different requirement', lambda: None)['error'] == 'amendment_id_conflict'
    def interrupted():
        calls.append('pending')
        raise RuntimeError('transport interrupted after intent')
    with pytest.raises(RuntimeError):
        amend(store, 'owner', 'r', 'pending', 'keep this requirement', interrupted)
    assert amend(store, 'owner', 'r', 'pending', 'keep this requirement', lambda: pytest.fail('uncertain replay'))['error'] == 'amendment_delivery_uncertain'
    assert calls == ['a', 'pending']
    store.close()


def test_definite_pre_delivery_refusal_can_reconcile_without_replaying_uncertainty(tmp_path):
    store = RunIdempotencyStore(str(tmp_path / 'native-runs.db'))
    text = '  preserve the changed requirement\n'
    assert amend(store, 'owner', 'r', 'a', text, lambda: {'error':'run_not_accepting_steer'})['error'] == 'run_not_accepting_steer'
    receipt = {'accepted':True, 'amendment_id':'a', 'delivered_to':'parent_replan'}
    assert amend(store, 'owner', 'r', 'a', text, lambda: receipt) == receipt
    assert amend(store, 'owner', 'r', 'a', text, lambda: pytest.fail('delivered requirement replayed')) == receipt
    store.close()


@pytest.mark.asyncio
async def test_approval_waiting_amendment_preserves_approval_and_exact_run_child(tmp_path, monkeypatch):
    import weakref
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    from gateway.config import PlatformConfig
    from gateway.platforms.api_server import APIServerAdapter
    from tools import delegate_tool_registry as registry
    token = set_hermes_home_override(tmp_path)
    class Agent:
        session_id = 'same-conversation'
        def __init__(self): self.received = []
        def steer(self, text): self.received.append(text); return True
    root, sibling, child, foreign = Agent(), Agent(), Agent(), Agent()
    child._delegate_parent_ref = weakref.ref(root)
    foreign._delegate_parent_ref = weakref.ref(sibling)
    for sid, agent in [('target-child',child),('other-run-child',foreign)]:
        monkeypatch.setitem(registry._active_subagents, sid, {'agent':agent, 'accepting_steer':True,
            'owner_agent_session_id':'same-conversation'})
    adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={}))
    adapter._run_idempotency_store = RunIdempotencyStore(str(tmp_path / 'native-runs.db'))
    adapter._active_run_agents['target-run'] = root
    adapter._run_owners['target-run'] = adapter._run_idempotency_scope(SimpleNamespace(headers={}))
    approval = {'request_id':'approval-1', 'question':'Approve the pending action?', 'expires_at_ms':9999999999999}
    adapter._set_run_status('target-run','waiting_for_approval',approval=approval)
    app = web.Application()
    app.router.add_post('/v1/runs/{run_id}/steer', adapter._handle_steer_run)
    text = '  revised requirement\n'
    try:
        async with TestClient(TestServer(app)) as client:
            response = await client.post('/v1/runs/target-run/steer',json={'text':text,'amendment_id':'a'})
            receipt = await response.json()
            assert response.status == 200, receipt
            assert receipt['delivered_to'] == 'delegate' and receipt['delegate_task_ids'] == ['target-child']
            assert child.received == [text] and foreign.received == [] and root.received == []
            assert adapter._run_statuses['target-run']['status'] == 'waiting_for_approval'
            assert adapter._run_statuses['target-run']['approval'] == approval
            assert adapter._run_statuses['target-run'].get('approval_results',[]) == []
            # A transport retry after native completion still returns its durable success without delivery again.
            adapter._set_run_status('target-run','completed')
            response = await client.post('/v1/runs/target-run/steer',json={'text':text,'amendment_id':'a'})
            assert response.status == 200 and await response.json() == receipt
            assert child.received == [text]
    finally:
        adapter._run_idempotency_store.close()
        reset_hermes_home_override(token)


def test_session_busy_completion_retries_same_run_and_acknowledges_ingestion_once(tmp_path):
    from hermes_state import SessionDB
    from tools import async_delegation as native
    token = set_hermes_home_override(tmp_path)
    db = SessionDB(tmp_path / 'state.db')
    db.create_session('owner', source='api_server')
    budget = ToolCallBudget(10,2)
    budget.consume()
    agent = SimpleNamespace(session_id='owner', _session_db=db, _interrupt_requested=False, tool_call_budget=budget)
    bridge = RunDelegation(agent, lambda waiting: None)
    try:
        handle = native.dispatch_async_delegation_batch(
            goals=['bounded completion'], context=None, toolsets=None, role='leaf', model=None,
            session_key='busy-run', parent_session_id='owner', max_async_children=2,
            runner=lambda: {'results':[{'task_index':0,'status':'completed','summary':'preserve this result'}]},
            completion_callback=agent._native_delegate_completion)
        attempts = []
        def resume(text, history):
            attempts.append(text)
            assert agent.tool_call_budget is budget and budget.used == 1
            assert db._read_one('SELECT delivery_state FROM async_delegations WHERE delegation_id=?',
                                (handle['delegation_id'],))[0] == 'pending'
            if len(attempts) == 1:
                assert db.get_messages('owner') == []
                return {'failed':True, 'completed':False, 'failure_reason':'session_busy', 'messages':history}
            assert len(attempts) == 2
            db.append_message('owner', 'system', text)
            return {'completed':True, 'final_response':'same-run result delivered', 'messages':history}
        result = bridge.resume({'messages':[]}, resume)
        assert result['completed'] is True and result['final_response'] == 'same-run result delivered'
        assert len(attempts) == 2 and attempts[0] == attempts[1]
        assert len(db.get_messages('owner')) == 1
        assert db._read_one('SELECT delivery_state FROM async_delegations WHERE delegation_id=?',
                            (handle['delegation_id'],))[0] == 'delivered'
    finally:
        db.close()
        reset_hermes_home_override(token)


@pytest.mark.parametrize('scope', ['owner', 'guest', 'owner_uncertain', 'care'])
def test_conversation_surface_and_execution_catalog_preserve_scope_and_grants(tmp_path, scope):
    import yaml
    from gateway.run_scope import bind_action_grants, restrict_agent, tool_block
    from tools.delegate_tool_toolsets import _resolve_child_toolsets
    token = set_hermes_home_override(tmp_path)
    config = {'personal_aios': {'delegated_toolsets': ['memory', 'web', 'terminal', 'file', 'messaging', 'cronjob'],
                                'grantable_toolsets': ['terminal', 'file']}}
    (tmp_path / 'config.yaml').write_text(yaml.safe_dump(config))
    names = ['delegate_task', 'skills_list', 'skill_view', 'skill_manage', 'session_search',
             'paios_l3_query', 'paios_open_reply', 'paios_terminal_question', 'paios_health_query',
             'paios_visual_analyze', 'terminal', 'read_file', 'send_message', 'cronjob_manage']
    names.append('paios_background_status')
    def surface(): return [{'type': 'function', 'function': {'name': n}} for n in names]
    parent = SimpleNamespace(platform='api_server', tools=surface(), enabled_toolsets=['memory', 'delegation'],
                             _delegate_depth=0)
    try:
        bind_action_grants(parent, ['file'] if scope == 'owner' else [], config)
        restrict_agent(parent, scope)
        assert 'delegate_task' in parent.valid_tool_names
        assert ('paios_background_status' in parent.valid_tool_names) == (scope == 'owner')
        assert (tool_block(parent, 'paios_background_status') is None) == (scope == 'owner')
        assert not {'terminal', 'read_file', 'send_message', 'cronjob_manage', 'skill_manage',
                    'paios_health_query', 'paios_visual_analyze'} & parent.valid_tool_names
        assert all(tool_block(parent, name) for name in ['terminal', 'read_file', 'send_message', 'paios_visual_analyze'])
        enabled, disabled = _resolve_child_toolsets(parent, None, 'leaf')
        assert {'web', 'terminal', 'file', 'messaging', 'cronjob'} <= set(enabled)
        assert not {'messaging', 'cronjob'} & set(disabled)
        child = SimpleNamespace(platform='subagent', tools=surface(), enabled_toolsets=enabled, _delegate_depth=1,
                                _paios_delegate_toolsets=parent._paios_delegate_toolsets,
                                _paios_action_denied=parent._paios_action_denied,
                                _paios_desktop_denied=parent._paios_desktop_denied)
        restrict_agent(child, getattr(parent, '_paios_run_scope', None))
        if scope == 'owner':
            assert tool_block(child, 'read_file') is None
            assert tool_block(child, 'terminal')
            assert tool_block(child, 'send_message') is None
        else:
            assert tool_block(child, 'read_file') and tool_block(child, 'send_message')
            assert ('paios_health_query' in child.valid_tool_names) == (scope == 'care')
    finally:
        reset_hermes_home_override(token)


def test_api_history_reload_holds_the_native_lease_even_without_waiting(tmp_path):
    from agent.turn_facade_lease import admit_durable_turn_lease
    from hermes_state import SessionDB
    db = SessionDB(tmp_path / 'state.db')
    db.create_session('owner', source='api_server')
    db.append_message('owner', 'user', 'new owner input after caller snapshot')
    db.append_message('owner', 'assistant', 'new owner reply')
    # Admission can succeed immediately after another writer finished. Its old snapshot must be discarded.
    agent = SimpleNamespace(session_id='owner', platform='api_server', _session_db=db,
                            _api_reload_session_history=True, _emit_status=lambda text: None,
                            _liveness_activity_lock=threading.RLock)
    original = db.get_messages_as_conversation
    def read_under_lease(*args, **kwargs):
        assert agent._active_session_turn_lease_holder
        return original(*args, **kwargs)
    db.get_messages_as_conversation = read_under_lease
    admission = None
    try:
        admission = admit_durable_turn_lease(agent, session_id='owner', relay_turn_id='resume',
            task_context={'session_id':'owner', 'platform':'api_server'},
            conversation_history=[{'role':'user', 'content':'old snapshot'}])
        assert admission.early_result is None
        assert [m['content'] for m in admission.conversation_history] == [
            'new owner input after caller snapshot', 'new owner reply']
    finally:
        if admission and admission.lease:
            admission.lease.release()
        db.close()


def test_provider_action_injection_uses_catalog_then_inherited_scope(tmp_path):
    import yaml
    from agent.memory_manager import inject_memory_provider_tools
    from gateway.run_scope import restrict_agent, tool_block
    token = set_hermes_home_override(tmp_path)
    (tmp_path / 'config.yaml').write_text(yaml.safe_dump({'personal_aios': {'delegated_toolsets': ['memory']}}))
    schemas = [{'name': name, 'description': name, 'parameters': {'type': 'object', 'properties': {}}}
               for name in ['paios_open_reply', 'paios_l3_query', 'paios_action_request', 'paios_payment', 'paios_health_query']]
    manager = SimpleNamespace(get_all_tool_schemas=lambda: schemas)
    try:
        for scope in ['owner', 'guest', 'owner_uncertain', 'care']:
            parent = SimpleNamespace(platform='api_server', _memory_manager=manager, tools=[], valid_tool_names=set(),
                                     enabled_toolsets=['memory'], disabled_toolsets=[], _delegate_depth=0)
            inject_memory_provider_tools(parent)
            restrict_agent(parent, scope)
            assert not {'paios_action_request', 'paios_payment', 'paios_health_query'} & parent.valid_tool_names
            child = SimpleNamespace(platform='subagent', _memory_manager=manager, tools=[], valid_tool_names=set(),
                                    enabled_toolsets=['memory'], _delegate_depth=1,
                                    _paios_delegate_toolsets=parent._paios_delegate_toolsets)
            inject_memory_provider_tools(child, inherit_from=parent)
            restrict_agent(child, getattr(parent, '_paios_run_scope', None))
            assert ('paios_payment' in child.valid_tool_names) == (scope == 'owner')
            assert ('paios_action_request' in child.valid_tool_names) == (scope == 'owner')
            assert ('paios_health_query' in child.valid_tool_names) == (scope in ['owner', 'care'])
            if scope != 'owner':
                assert tool_block(child, 'paios_payment')
    finally:
        reset_hermes_home_override(token)


def test_completion_resumes_before_sibling_finishes_and_reports_each_current_ack():
    agent = SimpleNamespace(_interrupt_requested=False)
    snapshots = []
    bridge = RunDelegation(agent, lambda waiting: snapshots.append(bridge.current_result['final_response']) if waiting else None)
    sibling_live = [True]
    bridge._live = lambda: [{'delegation_id': 'sibling'}] if sibling_live[0] else []
    bridge.results.put({'delegation_id':'quick', 'summary':'owner link ready'})
    calls = []
    def resume(text, history):
        calls.append(text)
        if len(calls) == 1:
            assert sibling_live[0] and 'owner link ready' in text
            bridge.results.put({'delegation_id':'sibling', 'summary':'sibling evidence'})
            sibling_live[0] = False
            return {'final_response':'second ack', 'messages':[]}
        assert 'sibling evidence' in text
        return {'final_response':'all complete', 'messages':[]}
    result = bridge.resume({'final_response':'first ack', 'messages':[]}, resume)
    assert snapshots == ['first ack', 'second ack']
    assert result['final_response'] == 'all complete'


def test_native_short_completion_is_delivered_while_long_sibling_is_live(tmp_path):
    from tools import async_delegation as native
    token = set_hermes_home_override(tmp_path)
    release = threading.Event()
    bridge = RunDelegation(SimpleNamespace(_interrupt_requested=False), lambda waiting: None)
    common = dict(context=None, toolsets=None, role='leaf', model=None, session_key='siblings',
                  parent_session_id='owner', max_async_children=3, completion_callback=bridge.callback)
    try:
        long = native.dispatch_async_delegation_batch(goals=['long'], runner=lambda:
            (release.wait(5) and {'results':[{'summary':'long evidence'}]}), **common)
        native.dispatch_async_delegation_batch(goals=['short'], runner=lambda:
            {'results':[{'summary':'https://example.test/owner-step'}]}, **common)
        summaries = []
        def resume(text, history):
            summaries.append(text)
            if len(summaries) == 1:
                assert 'https://example.test/owner-step' in text
                assert any(r['delegation_id'] == long['delegation_id'] for r in bridge._live())
                release.set()
            return {'final_response':'stage received', 'messages':[]}
        bridge.resume({'messages':[]}, resume)
        assert len(summaries) == 2 and 'long evidence' in summaries[-1]
    finally:
        release.set()
        reset_hermes_home_override(token)


def test_native_cancel_interrupts_waiting_children_without_resuming_model(tmp_path):
    from tools import async_delegation as native
    token = set_hermes_home_override(tmp_path)
    release = threading.Event()
    agent = SimpleNamespace(_interrupt_requested=True)
    bridge = RunDelegation(agent, lambda waiting: None)
    try:
        native.dispatch_async_delegation_batch(goals=['cancel me'], context=None, toolsets=None, role='leaf',
            model=None, session_key='cancel', parent_session_id='owner', max_async_children=2,
            runner=lambda: (release.wait(5) and {'results':[{'summary':'interrupted'}]}),
            interrupt_fn=release.set, completion_callback=bridge.callback)
        result = bridge.resume({'messages':[]}, lambda text, history: pytest.fail('cancel resumed model'))
        assert result['interrupted'] is True and release.is_set()
    finally:
        release.set()
        reset_hermes_home_override(token)


def test_native_cron_catalog_cannot_grant_terminal_file_or_desktop(tmp_path):
    import yaml
    from gateway.run_scope import restrict_agent, tool_block, runtime_scope
    from tools.delegate_tool_toolsets import _resolve_child_toolsets
    token = set_hermes_home_override(tmp_path)
    (tmp_path / 'config.yaml').write_text(yaml.safe_dump({'personal_aios': {
        'delegated_toolsets': ['memory', 'terminal', 'file', 'desktop'],
        'grantable_toolsets': ['terminal', 'file', 'desktop']}}))
    names = ['delegate_task', 'terminal', 'read_file', 'mcp__desktop__click']
    def surface(): return [{'type':'function', 'function':{'name':n}} for n in names]
    parent = SimpleNamespace(platform='cron', tools=surface(), enabled_toolsets=['memory', 'delegation'],
                             _delegate_depth=0)
    try:
        # Scheduler constructs no API action grants. The source binds this empty authority before spawning.
        with runtime_scope('owner'):
            restrict_agent(parent, None)
        assert parent._paios_action_denied and parent._paios_desktop_denied
        assert parent.valid_tool_names == {'delegate_task'}
        enabled, _ = _resolve_child_toolsets(parent, None, 'leaf')
        assert {'terminal', 'file', 'desktop'} <= set(enabled)
        child = SimpleNamespace(platform='subagent', tools=surface(), enabled_toolsets=enabled, _delegate_depth=1,
                                _paios_delegate_toolsets=parent._paios_delegate_toolsets,
                                _paios_action_denied=parent._paios_action_denied,
                                _paios_desktop_denied=parent._paios_desktop_denied)
        restrict_agent(child, None)
        assert all(tool_block(child, name) for name in ['terminal', 'read_file', 'mcp__desktop__click'])
    finally:
        reset_hermes_home_override(token)
