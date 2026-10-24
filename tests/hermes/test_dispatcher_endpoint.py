"""Native HTTP/AIAgent integration with a deterministic loopback model, no live API."""
import asyncio
import json
import sys
import threading

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer


@pytest.mark.asyncio
@pytest.mark.parametrize("maximum,rejection", [(15, None), (15, "approval"), (3, None), (3, "denied"), (2, "unknown")])
async def test_detached_native_run_accepts_next_owner_turn_then_synthesizes(tmp_path, monkeypatch, maximum, rejection):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    token = set_hermes_home_override(tmp_path)
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setenv('HERMES_MODEL', 'dispatcher-fixture')
    (tmp_path / 'config.yaml').write_text('tools:\n  tool_search:\n    enabled: off\nmodel:\n  context_length: 131072\nagent:\n  max_tool_calls: 15\n  tool_call_milestone_interval: 2\npersonal_aios:\n  delegated_toolsets: [delegation, dispatcher_fixture, memory]\ndelegation:\n  max_concurrent_children: 2\n  max_spawn_depth: 2\n  worktree_isolation: false\n')
    from gateway.config import PlatformConfig
    from gateway.platforms.api_server import APIServerAdapter
    from run_agent import AIAgent
    from tools.registry import registry
    from agent.tool_call_budget import ToolCallBudget
    from agent.memory_provider import MemoryProvider
    from agent.memory_manager import MemoryManager, inject_memory_provider_tools
    if rejection == 'denied':
        from hermes_cli import plugins
        original_pre_tool = plugins._dispatch_pre_tool_call_hooks
        def deny_wait(name, args, **kwargs):
            return ('Fixture owner refused this action', args) if name == 'dispatcher_wait' else original_pre_tool(name, args, **kwargs)
        monkeypatch.setattr(plugins, '_dispatch_pre_tool_call_hooks', deny_wait)
    started, release = threading.Event(), threading.Event()
    observed, agents, identities = [], [], []
    def worker_tool(args, **kwargs):
        started.set()
        if rejection == 'approval':
            from types import SimpleNamespace
            from integrations.hermes.personal_aios.effects import _check_effect
            requests = []
            def consent(path, body):
                requests.append(body)
                return {'status':'allowed', 'approval':body['confirmation']} if body.get('approved') else {
                    'status':'confirmation_required',
                    'scope':{'kind':'send', 'task_type':'send_message:email:send', 'recipient':'email:fixture@example.com'}}
            blocked = _check_effect(SimpleNamespace(_request=consent),
                {'effect':{'kind':'send','task_type':'send_message:email:send','recipient':'email:fixture@example.com',
                           'requested':True}}, 'owner-fixture', 'first-send')
            assert blocked['confirmation_id'] == 'fixture' and requests[-1].get('approved') is True
            assert blocked['confirmed_by'] == 'owner-fixture' and blocked['confirmed_at'].endswith('Z')
        assert release.wait(15), 'test did not release native child'
        from tools.personal_aios_dispatch import dispatch_nested_tool
        return dispatch_nested_tool('dispatcher_provider_probe', {})
    registry.register(name='dispatcher_wait', toolset='dispatcher_fixture',
        schema={'name': 'dispatcher_wait', 'description': 'Wait for the bounded fixture signal.',
                'parameters': {'type': 'object', 'properties': {}}}, handler=worker_tool)
    def probe_tool(args, **kwargs):
        from gateway.session_context import get_api_run_id
        identities.append(get_api_run_id(kwargs.get('session_id', '')))
        return json.dumps({'evidence': 'native-child-tool-output'})
    registry.register(name='dispatcher_probe', toolset='dispatcher_fixture',
        schema={'name': 'dispatcher_probe', 'description': 'Return fixture evidence.',
                'parameters': {'type': 'object', 'properties': {}}}, handler=probe_tool)
    class ProbeProvider(MemoryProvider):
        name = 'dispatcher-provider-fixture'
        def is_available(self): return True
        def initialize(self, session_id, **kwargs): pass
        def get_tool_schemas(self):
            return [{'name':'dispatcher_provider_probe', 'description':'Return native provider evidence.',
                     'parameters':{'type':'object', 'properties':{}}}]
        def handle_tool_call(self, name, args, **kwargs):
            from gateway.session_context import get_api_run_id
            assert kwargs['session_id'] == 'owner-fixture'
            assert get_api_run_id(kwargs['session_id']) == kwargs['run_id']
            from tools.personal_aios_dispatch import dispatch_nested_tool
            return dispatch_nested_tool('dispatcher_probe', {})
    manager = MemoryManager()
    manager.add_provider(ProbeProvider())
    async def complete(request):
        body = await request.json()
        messages = body['messages']
        turn_index = max(i for i, message in enumerate(messages) if message['role'] == 'user'
                         or (message['role'] == 'system' and str(message.get('content')).startswith('Native delegated work completed')))
        last = messages[turn_index]['content']
        after = messages[turn_index+1:]
        name = None
        from agent.context_compressor import MAX_ITERATIONS_SUMMARY_REQUEST
        if MAX_ITERATIONS_SUMMARY_REQUEST in str(last) or not body.get('tools'):
            text = 'shared-cap-stop'
        elif 'fixture_rejected' in str(last):
            name, args, text = ('missing_fixture_tool' if rejection == 'unknown' else 'dispatcher_wait'), {}, None
        elif 'Native delegated work completed' in str(last):
            assert 'native-child-tool-output' in str(last)
            assert any(m.get('content') == 'quick-owner-answer' for m in messages)
            text = 'synthesized-native-result'
        elif 'fixture_quick' in str(last):
            text = 'quick-owner-answer'
        elif 'fixture_worker' in str(last):
            if any(m['role'] == 'tool' for m in after):
                text = json.dumps({'outcome':'succeeded','reason':'',
                    'summary':'worker-result: ' + json.dumps([m.get('content') for m in after if m['role'] == 'tool'])})
            else:
                name, args = 'dispatcher_wait', {}
                text = None
        elif any(m['role'] == 'tool' for m in after):
            text = 'working-in-background'
        else:
            name, args = 'delegate_task', {'goal': 'fixture_worker'}
            text = None
        observed.append((str(last), name))
        message = {'role':'assistant', 'content': text}
        if name:
            message['tool_calls'] = [{'id': f'call-{len(observed)}', 'type':'function',
                                     'function': {'name':name, 'arguments':json.dumps(args)}}]
        reason = 'tool_calls' if name else 'stop'
        payload = {'id':'fixture', 'object':'chat.completion', 'model':'dispatcher-fixture',
                   'choices':[{'index':0, 'message':message, 'finish_reason':reason}],
                   'usage':{'prompt_tokens':10, 'completion_tokens':10, 'total_tokens':20}}
        if not body.get('stream'):
            return web.json_response(payload)
        response = web.StreamResponse(headers={'Content-Type':'text/event-stream'})
        await response.prepare(request)
        if name:
            message['tool_calls'][0]['index'] = 0
        payload['choices'] = [{'index':0, 'delta':message, 'finish_reason':None}]
        await response.write(('data: '+json.dumps(payload)+'\n\n').encode())
        payload['choices'] = [{'index':0, 'delta':{}, 'finish_reason':reason}]
        await response.write(('data: '+json.dumps(payload)+'\n\ndata: [DONE]\n\n').encode())
        return response
    model_app = web.Application()
    model_app.router.add_post('/v1/chat/completions', complete)
    adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={}))
    adapter._max_concurrent_runs = 1
    api_app = web.Application()
    api_app.router.add_post('/v1/runs', adapter._handle_runs)
    api_app.router.add_get('/v1/runs/{run_id}', adapter._handle_get_run)
    api_app.router.add_post('/v1/runs/{run_id}/approval', adapter._handle_run_approval)
    async def poll(client, run_id, predicate):
        for _ in range(300):
            result = await (await client.get('/v1/runs/'+run_id)).json()
            if predicate(result):
                return result
            await asyncio.sleep(.02)
        pytest.fail(str(result))
    try:
        async with TestServer(model_app) as model, TestClient(TestServer(api_app)) as client:
            def create(**kwargs):
                agent = AIAgent(model='dispatcher-fixture', provider='custom', api_key='synthetic-fixture',
                    base_url=str(model.make_url('/v1')), max_iterations=sys.maxsize, quiet_mode=True,
                    enabled_toolsets=['delegation','memory'], platform='api_server', skip_context_files=True, skip_memory=True,
                    load_soul_identity=False, session_db=adapter._ensure_session_db(), session_id=kwargs.get('session_id'),
                    tool_progress_callback=kwargs.get('tool_progress_callback'),
                    stream_delta_callback=kwargs.get('stream_delta_callback'))
                agent.tool_call_budget = ToolCallBudget(maximum,2)
                agent._memory_manager = manager
                inject_memory_provider_tools(agent)
                agents.append(agent)
                return agent
            monkeypatch.setattr(adapter, '_create_agent', create)
            response = await client.post('/v1/runs', json={'input':'fixture_rejected' if rejection in {'denied', 'unknown'} else 'fixture_start_parent', 'session_id':'owner-fixture'})
            assert response.status == 202, await response.text()
            first = (await response.json())['run_id']
            if rejection in {'denied', 'unknown'}:
                done = await poll(client, first, lambda r: r['status'] in {'completed','failed'})
                assert done['status'] == 'failed' and done['turn_exit_reason'] == 'tool_call_cap_reached', done
                assert agents[0].tool_call_budget.used == maximum
                assert sum(name is not None for _, name in observed) == maximum
                assert not started.is_set() and identities == []
                return
            waiting = await poll(client, first, lambda r: r.get('turn_exit_reason') == 'delegation_waiting')
            for _ in range(200):
                if started.is_set():
                    break
                await asyncio.sleep(.02)
            assert waiting['status'] in {'running', 'waiting_for_approval'} and started.is_set()
            assert waiting['output'] == 'working-in-background'
            assert 'native_final_response' not in waiting
            assert adapter.active_agent_work_count() == 0
            response = await client.post('/v1/runs', json={'input':'fixture_quick', 'session_id':'owner-fixture'})
            assert response.status == 202, await response.text()
            second = (await response.json())['run_id']
            quick = await poll(client, second, lambda r: r['status'] in {'completed','failed'})
            assert quick['status'] == 'completed' and quick['output'] == 'quick-owner-answer'
            if rejection == 'approval':
                pending = await poll(client, first, lambda r: r['status'] == 'waiting_for_approval')
                assert pending['approval']['request_id']
                approved = await client.post('/v1/runs/'+first+'/approval', json={
                    'choice':'once', 'request_id':pending['approval']['request_id'],
                    'confirmation': {'confirmation_id':'fixture', 'confirmed_by':'owner-fixture',
                                     'surface':{'device_id':'fixture-phone', 'device_type':'phone'}}})
                assert approved.status == 200, await approved.text()
            release.set()
            done = await poll(client, first, lambda r: r['status'] in {'completed','failed'})
            persisted = adapter._ensure_session_db().get_messages_as_conversation('owner-fixture')
            contents = [str(m.get('content')) for m in persisted]
            quick_input = next(i for i, c in enumerate(contents) if c == 'fixture_quick')
            quick_reply = next(i for i, c in enumerate(contents) if c == 'quick-owner-answer')
            completion = next(i for i, c in enumerate(contents) if c.startswith('Native delegated work completed'))
            assert quick_input < quick_reply < completion
            completions = [message for message in persisted if str(message.get('content')).startswith('Native delegated work completed')]
            assert len(completions) == (1 if maximum == 15 else 2)
            assert all(message['role'] == 'system' for message in completions)
            assert not any(m.get('role') == 'user' and 'Native delegated work completed' in str(m.get('content')) for m in persisted)
            if maximum == 15:
                assert done['status'] == 'completed' and done['output'] == 'synthesized-native-result', done
                completed_children = [event for event in done['activity_events'] if event['event'] == 'subagent.complete']
                assert len(completed_children) == 1 and completed_children[0]['outcome'] == 'succeeded'
                assert completed_children[0]['outcome_reason'] == ''
                assert agents[0].tool_call_budget.used == 4
                assert identities == [first]
            else:
                assert done['status'] == 'failed' and done['turn_exit_reason'] == 'tool_call_cap_reached', done
                assert agents[0].tool_call_budget.used == 3
                assert identities == []
                assert 'native_final_response' not in done
                selfcheck_cards = [event for event in done['activity_events']
                    if event['event'] == 'subagent.start' and event.get('goal', '').startswith('自检：')]
                assert len(selfcheck_cards) == 1 and selfcheck_cards[0]['goal'] == '自检：fixture_worker'
                assert any('self_check_of' in str(message['content']) for message in completions)
            assert any(name == 'dispatcher_wait' for _,name in observed)
            from tools import async_delegation as native
            with native._DB_LOCK, native._transaction() as db:
                rows = db.execute('SELECT delivery_state,task_json,result_json FROM async_delegations WHERE origin_session=?', (first,)).fetchall()
                assert rows and all(row[0] == 'delivered' for row in rows)
                selfchecks = [row for row in rows if json.loads(row[1]).get('self_check_of')]
                assert len(selfchecks) == (0 if maximum == 15 else 1)
                if selfchecks:
                    assert json.loads(selfchecks[0][2])['results'][0]['status'] == 'failed'
    finally:
        release.set()
        for agent in agents:
            agent._interrupt_requested = True
        reset_hermes_home_override(token)
