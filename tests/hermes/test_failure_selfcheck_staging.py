"""Synthetic staging stall exercises durable executor status without a phone or model."""
import asyncio
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]


@pytest.fixture
def fake(tmp_path, monkeypatch):
    monkeypatch.setenv('PAIOS_FAKE_PHONE_LOG', str(tmp_path / 'phone.jsonl'))
    monkeypatch.setenv('PAIOS_ERRAND_SPOOL', str(tmp_path / 'spool'))
    monkeypatch.setenv('PAIOS_FAKE_PHONE_STALL_ONCE', '1')
    spec = importlib.util.spec_from_file_location('selfcheck_fake_phone',
        ROOT / 'integrations/hermes/personal_aios/staging/fake_phone.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_stall_once_persists_real_async_wait_and_exact_owner_query(fake):
    async def run():
        args = dict(goal='读取店铺', title='查询店铺', app='千问', principal_id='owner',
                    effect={'kind': 'read', 'task_type': 'query', 'requested': True})
        first = await fake.phone_task(**args, context={}, job_id='job-aaaaaaaaaaaa',
                                      origin_processed_event_id='event-1')
        assert first['status'] == 'started'
        task = fake._jobs[first['job_id']]['task']
        await asyncio.sleep(0)
        running = await fake.phone_status(principal_id='owner', job_id=first['job_id'])
        assert running['jobs'][0]['trace']['in_progress']['waiting_for'] == 'model'
        await task
        status = await fake.phone_status(principal_id='owner', job_id=first['job_id'])
        job = status['jobs'][0]
        assert job['terminal_reason'] == 'timed_out' and job['success'] is False
        assert job['title'] == '查询店铺'
        assert job['evidence_ref'] == {'tool': 'phone_status', 'job_id': first['job_id']}
        step = job['trace']['in_progress']
        assert step['index'] == 1 and step['waiting_for'] == 'model'
        assert 0.05 <= step['model_wait_seconds'] < 2
        assert step['status'] == 'stalled'
        persisted = json.loads((Path(fake.os.environ['PAIOS_ERRAND_SPOOL']) / (first['job_id'] + '.done.json')).read_text())
        assert persisted['origin_processed_event_id'] == 'event-1'
        assert not (await fake.phone_status(principal_id='other', job_id=first['job_id']))['jobs']
        second = await fake.phone_task(**args, self_check_of=first['job_id'])
        await fake._jobs[second['job_id']]['task']
        done = (await fake.phone_status(principal_id='owner', job_id=second['job_id']))['jobs'][0]
        assert done['terminal_reason'] == 'completed' and done['success'] is True
        assert done['self_check_of'] == first['job_id']
        assert (await fake.phone_status(principal_id='owner', job_id=first['job_id']))['jobs'][0]['success'] is False
    asyncio.run(run())


@pytest.mark.parametrize('kind', ['send', 'external', 'read_only'])
def test_non_read_effect_does_not_consume_fixture(fake, kind):
    async def run():
        result = await fake.phone_task(goal='existing branch', principal_id='owner',
            effect={'kind': kind, 'task_type': 'fixture', 'requested': True})
        await fake._jobs[result['job_id']]['task']
        assert fake._stall_once_used is False
        job = (await fake.phone_status(principal_id='owner', job_id=result['job_id']))['jobs'][0]
        assert 'trace' not in job
    asyncio.run(run())


def test_payment_keeps_cashier_branch_without_consuming_stall(fake, tmp_path, monkeypatch):
    async def run():
        fixture = tmp_path / 'cashier.json'
        fixture.write_text(json.dumps({'amount_fen': 100, 'items': ['fixture'], 'payee': 'fixture'}))
        monkeypatch.setenv('PAIOS_FAKE_CASHIER', str(fixture))
        calls = []
        async def cashier(job_id, job, scenario):
            calls.append(job['payment_intent'])
        monkeypatch.setattr(fake, '_cashier_job', cashier)
        result = await fake.phone_task(goal='payment branch', principal_id='owner', app='淘宝',
            payment_intent='intent-1', effect={'kind': 'read', 'task_type': 'fixture', 'requested': True})
        await fake._jobs[result['job_id']]['task']
        assert calls == ['intent-1'] and fake._stall_once_used is False
        assert not list(Path(fake.os.environ['PAIOS_ERRAND_SPOOL']).glob('*.done.json'))
    asyncio.run(run())
