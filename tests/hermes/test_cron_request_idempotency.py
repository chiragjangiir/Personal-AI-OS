"""One explicit build request owns one durable native job, including create replays."""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / 'integrations/hermes'))
from personal_aios import cron


@pytest.fixture
def isolated_cron(tmp_path, monkeypatch):
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    monkeypatch.delenv('PAIOS_STAGE', raising=False)
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    token = set_hermes_home_override(tmp_path)
    try:
        yield tmp_path
    finally:
        reset_hermes_home_override(token)


def test_five_native_build_creates_from_one_owner_request_replay_one_job(isolated_cron):
    from cron.jobs import get_job, list_jobs, pause_job
    # The P3 trace used these five distinct names/calls with this same request reference.
    names = ['构建查快递技能 parcel-tracking', '重建查快递技能 parcel-tracking（走 skills_hub）',
             '修复并重发 parcel-track（代码围栏+实测记录）', 'parcel-track v1.1：剥离代码围栏',
             'parcel-track v1.1：代码围栏修复 + 发布（build→test→promote）']
    request = 'd:82f72fcd89288fbc3c91eeba2c0d56642d063f2770a3449bb895af825c45f80e'
    owner = {'principal_id': 'fixture-owner', 'device_id': 'fixture-phone',
             'allow_owner_mutation': True, 'allow_reasoning_create': True,
             'origin_processed_event_id': request, 'build_input_ref': request}
    handlers = {}
    def register(name, toolset, schema, handler, **kwargs):
        handlers[name] = handler
        return True
    ctx = SimpleNamespace(register_tool=register, register_platform=lambda *a, **kw: None,
                          register_platform_handler=lambda *a, **kw: None)
    cron.register(ctx, SimpleNamespace(_request=lambda path, body: owner))
    def create(index):
        return json.loads(handlers['cronjob_manage'](
            {'action': 'create', 'build': True, 'schedule': 'in 1m', 'name': names[index],
             'prompt': names[index], 'create_key': 'untrusted-model-key'},
            session_id=f'delegate-{index}', tool_call_id=f'create-{index}'))
    results = [create(i) for i in range(5)]
    assert all(result['success'] for result in results), results
    assert len(list_jobs(include_disabled=True)) == 1
    job_id = results[0]['job_id']
    assert {result['job_id'] for result in results} == {job_id}
    first = get_job(job_id)
    assert first['name'] == first['prompt'] == names[0]
    assert first['next_run_at'] == results[-1]['next_run_at']
    pause_job(job_id, reason='Owner cancelled the original task')
    assert create(4)['job_id'] == job_id
    assert get_job(job_id)['state'] == 'paused'
    owner.update(build_input_ref='d:next-explicit-request', origin_processed_event_id='d:next-explicit-request')
    assert create(0)['job_id'] != job_id
    owner.update(principal_id='another-owner')
    assert create(0)['job_id'] not in {job_id, results[-1]['job_id']}
    assert len(list_jobs(include_disabled=True)) == 3


def test_native_create_request_key_is_atomic_and_survives_process_restart(isolated_cron):
    from cron.jobs import create_job, list_jobs
    def create(index):
        return create_job(prompt=f'attempt {index}', schedule='in 1m', create_key='owner-request')['id']
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        ids = list(pool.map(create, range(5)))
    assert len(set(ids)) == len(list_jobs(include_disabled=True)) == 1
    command = ('import json; from cron.jobs import create_job; '
               'print(json.dumps(create_job(prompt="after restart", schedule="in 2m", '
               'create_key="owner-request")))')
    replay = json.loads(subprocess.check_output([sys.executable, '-c', command], env=os.environ, text=True))
    assert replay['id'] == ids[0]
    assert replay['prompt'] != 'after restart'
    assert len(list_jobs(include_disabled=True)) == 1


def test_selfcheck_build_origin_comes_from_runtime_not_tool_parameters(isolated_cron):
    from cron.jobs import get_job
    from tools.personal_aios_dispatch import current_tool_call
    marker = {'id': 'failed:0', 'source': 'workshop'}
    origin = {'kind': 'system_selfcheck', 'principal_id': 'owner', 'device_id': 'phone',
              'origin_processed_event_id': 'd:owner', 'failed_card': marker['id'],
              'title': 'Read weather', 'evidence_ref': {'tool': 'session_search', 'session_id': 'failed'}}
    owner = {'principal_id': 'owner', 'device_id': 'phone', 'allow_owner_mutation': True,
             'allow_reasoning_create': True, 'origin_processed_event_id': 'd:owner',
             'build_input_ref': 'd:owner', 'build_origin': origin}
    calls, handlers = [], {}
    def request(path, body):
        calls.append((path, body))
        return owner
    ctx = SimpleNamespace(register_tool=lambda name, toolset, schema, handler, **kw: (handlers.update({name: handler}) or True),
                          register_platform=lambda *a, **kw: None, register_platform_handler=lambda *a, **kw: None)
    cron.register(ctx, SimpleNamespace(_request=request))
    forged = {'id': 'forged', 'evidence_ref': {'secret': 'never authoritative'}}
    from gateway.run_scope import current_selfcheck_origin, runtime_scope
    forged_binding = current_tool_call.set((SimpleNamespace(_self_check_of=marker['id']), 'call', 'cronjob_manage'))
    try:
        with pytest.raises(ValueError, match='native delegation record'):
            current_selfcheck_origin()
    finally:
        current_tool_call.reset(forged_binding)
    from tools.async_delegation import _transaction
    with _transaction() as conn:
        conn.execute("INSERT INTO async_delegations (delegation_id,origin_session,state,dispatched_at,updated_at,task_json) VALUES (?,?,?,?,?,?)",
                     ('selfcheck', 'session', 'running', 1, 1, json.dumps({'self_check_of': marker})))
    binding = current_tool_call.set((SimpleNamespace(_self_check_of=marker['id']), 'call', 'cronjob_manage'))
    try:
        for scope in ('guest', 'owner_uncertain'):
            with runtime_scope(scope), pytest.raises(ValueError, match='confirmed owner scope'):
                current_selfcheck_origin()
        result = json.loads(handlers['cronjob_manage']({'action': 'create', 'build': True,
            'schedule': 'in 1m', 'name': 'Repair observed failure', 'prompt': 'diagnose',
            'build_origin': forged, 'self_check': forged}, session_id='session'))
    finally:
        current_tool_call.reset(binding)
    assert result['success'], result
    assert calls[0][1]['context']['self_check'] == marker
    assert cron.job_owner(get_job(result['job_id']))['build_origin'] == origin
    next_marker = {**marker, 'id': 'second-failed:0'}
    owner['build_origin'] = {**origin, 'failed_card': next_marker['id']}
    with _transaction() as conn:
        conn.execute("UPDATE async_delegations SET task_json=? WHERE delegation_id='selfcheck'",
                     (json.dumps({'self_check_of': next_marker}),))
    binding = current_tool_call.set((SimpleNamespace(_self_check_of=next_marker['id']), 'call-next', 'cronjob_manage'))
    try:
        next_result = json.loads(handlers['cronjob_manage']({'action': 'create', 'build': True,
            'schedule': 'in 1m', 'name': 'Second failure', 'prompt': 'diagnose'}, session_id='session'))
    finally:
        current_tool_call.reset(binding)
    assert next_result['success'] and next_result['job_id'] != result['job_id']


def test_existing_native_selfcheck_marker_recovers_failed_child_evidence(isolated_cron):
    from gateway.run_scope import current_selfcheck_origin
    from tools.async_delegation import _transaction
    from tools.personal_aios_dispatch import current_tool_call
    marker = {'source': 'delegate', 'id': 'failed-child:1'}
    with _transaction() as conn:
        for delegation_id, task, result in (
            ('selfcheck', {'self_check_of': marker}, {}),
            ('failed-child', {'goals': ['First', 'Read weather']},
             {'results': [{'task_index': 1, 'session_id': 'actual-failed-session', 'status': 'failed'}]})):
            conn.execute("INSERT INTO async_delegations (delegation_id,origin_session,state,dispatched_at,updated_at,task_json,result_json) VALUES (?,?,?,?,?,?,?)",
                         (delegation_id, 'owner-session', 'running', 1, 1, json.dumps(task), json.dumps(result)))
    token = current_tool_call.set((SimpleNamespace(_self_check_of=marker['id']), 'call', 'cronjob_manage'))
    try:
        assert current_selfcheck_origin() == {**marker, 'title': 'Read weather',
            'evidence_ref': {'tool': 'session_search', 'session_id': 'actual-failed-session'}}
    finally:
        current_tool_call.reset(token)
