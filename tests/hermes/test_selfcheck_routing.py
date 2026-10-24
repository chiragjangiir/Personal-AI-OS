"""Selfcheck results use the live native inbox and durable absorption receipts."""
import json

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from agent.interrupt_control import InterruptControlMixin
from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter
from gateway.platforms.api_server_run_idempotency import RunIdempotencyStore
from gateway.platforms.api_server_runs import _http_routes
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from tools import delegate_tool_registry as registry


@pytest.fixture
def native(tmp_path, monkeypatch):
    token = set_hermes_home_override(tmp_path)
    monkeypatch.setattr(registry, '_active_subagents', {})
    adapters = []
    def create():
        adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={'key': 'fixture-service'}))
        adapter._run_idempotency_store.close()
        adapter._run_idempotency_store = RunIdempotencyStore(str(tmp_path / 'runs.db'))
        adapters.append(adapter)
        return adapter
    yield create
    for adapter in adapters:
        adapter._run_idempotency_store.close()
    reset_hermes_home_override(token)


def owner(sid, principal='p', marker='failure', depth=1):
    agent = InterruptControlMixin()
    agent._paios_principal_id = principal
    agent._self_check_of = marker
    registry._register_subagent({'subagent_id': sid, 'agent': agent, 'depth': depth})
    return agent


def app_for(adapter):
    app = web.Application()
    for method, path, handler in _http_routes(adapter):
        app.router.add_route(method, path, handler)
    return app


RESULT = {'principal_id': 'p', 'job_id': 'phone-job', 'self_check_of': 'failure', 'answer': 'checked'}
HEADERS = {'Authorization': 'Bearer fixture-service'}
PATH = '/v1/paios/selfcheck-result'


@pytest.mark.asyncio
async def test_shallowest_matching_owner_and_restart_receipt(native):
    wrong = owner('foreign', principal='other', depth=0)
    deep = owner('nested', depth=2)
    shallow = owner('selfcheck', depth=1)
    async with TestClient(TestServer(app_for(native()))) as client:
        response = await client.post(PATH, json={'result': RESULT}, headers=HEADERS)
        assert response.status == 200
        assert await response.json() == {'absorbed': True}
        assert wrong._drain_pending_steer() is None
        assert deep._drain_pending_steer() is None
        pending = registry._close_subagent_steering('selfcheck', shallow)
        assert json.loads(pending)['result'] == RESULT
        from tools.delegate_tool_child_run import _append_missed_steer
        entry = {'error': 'selfcheck completed at final boundary'}
        _append_missed_steer(entry, pending)
        assert json.loads(entry['missed_steer'])['result'] == RESULT
        registry._unregister_subagent('selfcheck', agent=shallow)
        registry._unregister_subagent('nested', agent=deep)
        response = await client.post(PATH, json={'result': RESULT}, headers=HEADERS)
        assert await response.json() == {'absorbed': True}
    async with TestClient(TestServer(app_for(native()))) as client:
        response = await client.post(PATH, json={'result': RESULT}, headers=HEADERS)
        assert await response.json() == {'absorbed': True}
        changed = {**RESULT, 'answer': 'different'}
        response = await client.post(PATH, json={'result': changed}, headers=HEADERS)
        assert response.status == 409


@pytest.mark.asyncio
async def test_no_owner_is_false_but_later_owner_can_absorb(native):
    async with TestClient(TestServer(app_for(native()))) as client:
        response = await client.post(PATH, json={'result': RESULT}, headers=HEADERS)
        assert response.status == 200
        assert await response.json() == {'absorbed': False}
        agent = owner('later')
        response = await client.post(PATH, json={'result': RESULT}, headers=HEADERS)
        assert await response.json() == {'absorbed': True}
        assert json.loads(agent._drain_pending_steer())['result'] == RESULT


@pytest.mark.asyncio
async def test_service_auth_room_denial_and_wire_validation(native):
    agent = owner('selfcheck')
    async with TestClient(TestServer(app_for(native()))) as client:
        for headers in ({}, {'Authorization': 'HermesRoom fixture'}, {'Authorization': 'Bearer wrong'}):
            response = await client.post(PATH, json={'result': RESULT}, headers=headers)
            assert response.status in {401, 403}
        for result in (None, {}, {**RESULT, 'job_id': ''}, {**RESULT, 'self_check_of': {}}):
            response = await client.post(PATH, json={'result': result}, headers=HEADERS)
            assert response.status == 400
        assert agent._drain_pending_steer() is None


@pytest.mark.asyncio
async def test_closed_owner_is_an_error(native):
    agent = owner('selfcheck')
    registry._close_subagent_steering('selfcheck', agent)
    async with TestClient(TestServer(app_for(native()))) as client:
        response = await client.post(PATH, json={'result': RESULT}, headers=HEADERS)
        assert response.status == 409
        registry._unregister_subagent('selfcheck', agent=agent)
        assert agent._drain_pending_steer() is None


@pytest.mark.asyncio
async def test_uncertain_delivery_does_not_fall_back_to_owner_report(native):
    from gateway.platforms.api_run_amendment import amend
    from types import SimpleNamespace
    adapter = native()
    text = json.dumps({'kind': 'selfcheck_result', 'result': RESULT},
                      ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    scope = adapter._run_idempotency_scope(SimpleNamespace(headers=HEADERS))
    def interrupted():
        raise RuntimeError('interrupted after durable intent')
    with pytest.raises(RuntimeError):
        amend(adapter._run_idempotency_store, scope, 'selfcheck:p:failure',
              RESULT['job_id'], text, interrupted)
    agent = owner('selfcheck')
    async with TestClient(TestServer(app_for(adapter))) as client:
        response = await client.post(PATH, json={'result': RESULT}, headers=HEADERS)
        assert response.status == 409
        assert (await response.json())['error']['code'] == 'amendment_delivery_uncertain'
        assert agent._drain_pending_steer() is None
