"""Real local MCP progress and durable native run recovery; no model or device calls."""
import asyncio
import json
import sys
from types import SimpleNamespace

import pytest

SERVER = '''
import asyncio
from mcp import types
from mcp.server import Server
from mcp.server.stdio import stdio_server

async def call(ctx, params):
    for n in (1, 2):
        await ctx.session.send_progress_notification(ctx.params["_meta"]["progressToken"], n, 2,
            message="private /tmp/secret https://private.invalid token=hidden")
        await asyncio.sleep(0.01)
    return types.CallToolResult(content=[types.TextContent(type="text", text=params.arguments["label"])])

async def list_tools(ctx, params):
    return types.ListToolsResult(tools=[types.Tool(name="progress", inputSchema={"type":"object"})])

async def main():
    server = Server("activity-progress-fixture", on_call_tool=call, on_list_tools=list_tools)
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())
asyncio.run(main())
'''


@pytest.mark.asyncio
async def test_real_stdio_mcp_progress_retains_parallel_call_identity(tmp_path, monkeypatch, native_run):
    import threading
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from agent.tool_executor import _dispatch_authorized_once, _ManagedToolResult, _ToolCallRef
    from agent.tool_guardrails import ToolCallGuardrailController
    from tools import mcp_tool
    from tools.mcp_tool_loop import _run_on_mcp_loop
    from tools.mcp_tool_handlers import _call_tool_racing_stdio_death
    from tools.personal_aios_dispatch import current_tool_call

    script = tmp_path / 'progress_server.py'
    script.write_text(SERVER)
    adapter = native_run()
    reserve(adapter)
    public = adapter._make_run_event_callback('run', asyncio.get_running_loop())
    emitted = []
    loop = asyncio.new_event_loop()
    ready = threading.Event()
    thread = threading.Thread(target=loop.run_forever, name='synthetic-mcp-loop')
    thread.start()
    loop.call_soon_threadsafe(ready.set)
    assert ready.wait(3)
    monkeypatch.setattr(mcp_tool, '_mcp_loop', loop)

    def invoke(label):
        def receive(event, tool, preview=None, args=None, **fields):
            if event == 'tool.progress':
                emitted.append({'event': event, 'tool': tool, **fields})
            public(event, tool, preview, args, **fields)
        agent = SimpleNamespace(quiet_mode=True, tool_start_callback=None,
            tool_progress_callback=receive, _checkpoint_mgr=SimpleNamespace(enabled=False),
            _touch_activity=lambda *_: None, _tool_guardrails=ToolCallGuardrailController(),
            _public_tool_intents={'call-' + label: '检查进度'})

        async def call():
            assert threading.current_thread() is thread
            assert current_tool_call.get() == (agent, 'call-' + label, 'mcp_progress')
            params = StdioServerParameters(command=sys.executable, args=['-B', str(script)])
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await _call_tool_racing_stdio_death(
                        SimpleNamespace(session=session), 'synthetic', 'progress', {'label': label})
                    return result.content[0].text

        ref = _ToolCallRef('mcp_progress', {}, 'task', 'call-' + label, [])
        result = _dispatch_authorized_once(agent, _ManagedToolResult(None, {}, [], False, False),
            ref, execute=lambda _: _run_on_mcp_loop(call, timeout=10), scope_block=None,
            display_index=None, begin_execution=None, authorization_gate=None)
        assert result == label and current_tool_call.get() is None

    try:
        await asyncio.wait_for(asyncio.gather(asyncio.to_thread(invoke, 'a'),
                                              asyncio.to_thread(invoke, 'b')), 15)
        await asyncio.sleep(0)
        for call_id in ('call-a', 'call-b'):
            events = [event for event in emitted if event['tool_call_id'] == call_id]
            assert [event['progress'] for event in events] == [1, 2]
            assert all(event['total'] == 2 for event in events)
        assert len(emitted) == 4 and 'private' not in json.dumps(emitted)
        activity = adapter._run_statuses['run']['activity_events']
        assert {event['tool_call_id'] for event in activity if event['event'] == 'tool.progress'} == {'call-a', 'call-b'}
        assert all(event['progress'] == 2 for event in activity if event['event'] == 'tool.progress')
        assert 'private' not in json.dumps(activity)
        scope = adapter._run_idempotency_scope(SimpleNamespace(headers={}))
        stored = adapter._run_idempotency_store.status_for_run(scope, 'run')
        assert stored['status']['activity_events'] == activity
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(3)
        assert not thread.is_alive()
        loop.close()


@pytest.fixture
def native_run(tmp_path):
    from gateway.config import PlatformConfig
    from gateway.platforms.api_server import APIServerAdapter
    from gateway.platforms.api_server_run_idempotency import RunIdempotencyStore
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    token = set_hermes_home_override(tmp_path)
    adapters = []

    def create():
        adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={}))
        adapter._run_idempotency_store.close()
        adapter._run_idempotency_store = RunIdempotencyStore(str(tmp_path / 'runs.db'))
        adapters.append(adapter)
        return adapter
    yield create
    for adapter in adapters:
        adapter._run_idempotency_store.close()
    reset_hermes_home_override(token)


async def frame(response):
    while True:
        line = await asyncio.wait_for(response.content.readline(), 3)
        assert line, 'Native SSE ended before its authoritative snapshot'
        if line.startswith(b'data: '):
            return json.loads(line[6:])


def reserve(adapter, status='running', **fields):
    scope = adapter._run_idempotency_scope(SimpleNamespace(headers={}))
    initial = adapter._set_run_status('run', status, **fields)
    adapter._run_idempotency_store.reserve(scope, 'request', 'fingerprint', 'run', initial)
    adapter._run_idempotency_ids.add('run')
    adapter._run_owners['run'] = scope


@pytest.mark.asyncio
async def test_native_snapshots_recover_parallel_activity_and_offline_terminal(native_run):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    adapter = native_run()
    reserve(adapter)
    callback = adapter._make_run_event_callback('run', asyncio.get_running_loop())
    for name in ('a', 'b'):
        callback('tool.started', 'mcp_progress', 'private preview', {'secret': 'hidden'},
                 tool_call_id='call-' + name, public_intent='检查进度')
        callback('subagent.start', goal='检查资料', subagent_id='child-' + name)
        callback('subagent_progress', subagent_id='child-' + name, tool_count=2,
                 output_tail='/tmp/private https://private.invalid')
    await asyncio.sleep(0)
    app = web.Application()
    app.router.add_get('/v1/runs/{run_id}/events', adapter._handle_run_events)
    async with TestClient(TestServer(app)) as client:
        first = await client.get('/v1/runs/run/events?after_seq=0')
        second = await client.get('/v1/runs/run/events?after_seq=99999')
        a, b = await frame(first), await frame(second)
        assert a['event'] == b['event'] == 'run.snapshot'
        assert a['seq'] == b['seq'] > 0
        assert a['activity_events'] == b['activity_events']
        assert {e['subagent_id'] for e in a['activity_events'] if e['event'] == 'subagent.progress'} == {'child-a', 'child-b'}
        assert 'private' not in json.dumps(a['activity_events'])
        callback('tool.progress', 'mcp_progress', tool_call_id='call-b', progress=1, total=2)
        x, y = await frame(first), await frame(second)
        assert x == y and x['seq'] > a['seq'] and x['tool_call_id'] == 'call-b'
        first.close()
        second.close()
        terminal = adapter._set_run_status('run', 'completed', output='durable result')
        terminal_updated_at = terminal['updated_at']
    # A new adapter has no live stream, task or agent. The same durable authority must settle it.
    restarted = native_run()
    app = web.Application()
    app.router.add_get('/v1/runs/{run_id}/events', restarted._handle_run_events)
    async with TestClient(TestServer(app)) as client:
        response = await client.get('/v1/runs/run/events?after_seq=0')
        snapshot = await frame(response)
        assert snapshot['run']['status'] == 'completed'
        assert snapshot['run']['output'] == 'durable result'
        assert snapshot['run']['updated_at'] == terminal_updated_at
        assert snapshot['seq'] > x['seq']
        assert (await response.content.read()).replace(b': stream closed\n\n',b'') == b'\n'


@pytest.mark.asyncio
async def test_native_restart_denies_orphaned_approval_without_replaying_action(native_run):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    adapter = native_run()
    reserve(adapter, 'waiting_for_approval', approval={'request_id': 'approval', 'question': 'Allow action?'})
    restarted = native_run()
    app = web.Application()
    app.router.add_get('/v1/runs/{run_id}/events', restarted._handle_run_events)
    async with TestClient(TestServer(app)) as client:
        snapshots = []
        for cursor in (0, 99999):
            async with client.get('/v1/runs/run/events?after_seq=' + str(cursor)) as response:
                snapshots.append(await frame(response))
        one, two = snapshots
        assert one['run']['status'] == two['run']['status'] == 'interrupted'
        assert one['seq'] == two['seq']
        assert one['run']['approval_results'] == [
            {'request_id': 'approval', 'question': 'Allow action?', 'choice': 'deny', 'reason': 'interrupted'}]
        assert 'approval' not in one['run']
        assert not restarted._active_run_agents and not restarted._active_run_tasks


def test_native_dispatch_binds_same_name_intent_to_exact_call_and_resets_on_error():
    from agent.tool_executor import _dispatch_authorized_once, _ManagedToolResult, _ToolCallRef
    from agent.tool_guardrails import ToolCallGuardrailController
    from tools.personal_aios_dispatch import current_tool_call
    observed = []
    agent = SimpleNamespace(quiet_mode=True, tool_start_callback=None,
        tool_progress_callback=lambda *args, **kw: observed.append((args, kw)),
        _checkpoint_mgr=SimpleNamespace(enabled=False), _touch_activity=lambda *_: None,
        _tool_guardrails=ToolCallGuardrailController(),
        _public_tool_intents={'call-a': '检查第一份资料', 'call-b': '检查第二份资料'})
    for call_id in ('call-a', 'call-b'):
        ref = _ToolCallRef('mcp_progress', {}, 'task', call_id, [])
        def execute(_):
            assert current_tool_call.get() == (agent, call_id, 'mcp_progress')
            if call_id == 'call-b':
                raise RuntimeError('synthetic tool failure')
            return 'completed'
        def dispatch():
            return _dispatch_authorized_once(agent, _ManagedToolResult(None, {}, [], False, False),
                ref, execute=execute, scope_block=None, display_index=None,
                begin_execution=None, authorization_gate=None)
        if call_id == 'call-b':
            with pytest.raises(RuntimeError, match='synthetic tool failure'):
                dispatch()
        else:
            assert dispatch() == 'completed'
        assert current_tool_call.get() is None
    assert [(kw['tool_call_id'], kw['public_intent']) for _, kw in observed] == [
        ('call-a', '检查第一份资料'), ('call-b', '检查第二份资料')]


def test_detached_native_completion_resumes_once_without_repeating_work(tmp_path):
    import threading
    from gateway.platforms.api_run_delegation import RunDelegation
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from tools import async_delegation
    token = set_hermes_home_override(tmp_path)
    release = threading.Event()
    executions, resumes, waiting = [], [], []
    agent = SimpleNamespace(_interrupt_requested=False)
    bridge = RunDelegation(agent, waiting.append)

    def work():
        release.wait(3)
        executions.append('one local action')
        return {'results': [{'task_index': 0, 'status': 'completed', 'summary': 'detached evidence'}]}

    def resume(text, history):
        resumes.append(text)
        return {'final_response': 'final detached result', 'messages': history}

    try:
        receipt = async_delegation.dispatch_async_delegation_batch(
            goals=['synthetic detached errand'], context=None, toolsets=None, role='leaf', model=None,
            session_key='activity-detached', parent_session_id='owner', max_async_children=2,
            runner=work, completion_callback=agent._native_delegate_completion)
        assert receipt['status'] == 'dispatched'
        assert bridge._live()[0]['delegation_id'] == receipt['delegation_id']
        release.set()
        result = bridge.resume({'final_response': 'working', 'messages': []}, resume)
        assert result['final_response'] == 'final detached result'
        assert executions == ['one local action'] and len(resumes) == 1
        assert waiting[0] is True and waiting[-1] is False
        assert not bridge._live()
        assert bridge.resume(result, resume) == result
        assert len(executions) == len(resumes) == 1
    finally:
        release.set()
        reset_hermes_home_override(token)
