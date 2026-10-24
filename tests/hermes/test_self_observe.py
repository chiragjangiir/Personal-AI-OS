"""Bounded own-profile observations through the existing Hermes redactor."""
import importlib.util
from pathlib import Path
from types import ModuleType
import sys
import pytest

SOURCE = Path(__file__).parents[2] / 'integrations/hermes/personal_aios/self_observe.py'
spec = importlib.util.spec_from_file_location('self_observe_test', SOURCE)
observe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observe)


def test_logs_redact_before_line_selection(tmp_path, monkeypatch):
    from agent.redact import redact_sensitive_text
    constants = ModuleType('hermes_constants')
    constants.get_hermes_home = lambda: tmp_path
    constants.display_hermes_home = lambda: str(tmp_path)
    monkeypatch.setitem(sys.modules, 'hermes_constants', constants)
    logs = tmp_path / 'logs'
    logs.mkdir()
    secrets = ['secret-value-12345', 'bearer-value-12345', 'query-value-12345', 'pem-payload-private']
    text = ('password=' + secrets[0] + '\nAuthorization: Bearer ' + secrets[1] +
            '\nhttps://example.test/?token=' + secrets[2] + '\n-----BEGIN PRIVATE KEY-----\n' +
            secrets[3] + '\n-----END PRIVATE KEY-----\nERROR after redaction\n')
    (logs / 'agent.log').write_text(text)
    result = observe.observe({'source': 'hermes_agent', 'limit': 20})
    for secret in secrets:
        assert secret not in str(result)
    assert 'ERROR after redaction' in str(result)
    assert observe.observe({'source': 'hermes_errors'})['status'] == 'unavailable'
    with pytest.raises(ValueError, match='LIMIT'):
        observe.observe({'source': 'hermes_agent', 'limit': 101})


def test_resources_reads_only_fixed_cgroup_files(tmp_path):
    (tmp_path / 'memory.current').write_text('1234\n')
    result = observe.resources(tmp_path)
    assert result['values']['memory.current'] == '1234\n'
    assert result['values']['cpu.stat'] is None


def test_errands_all_states_preserve_producer_trace_and_filter_owner(tmp_path, monkeypatch):
    import json
    monkeypatch.setenv('PAIOS_ERRAND_SPOOL', str(tmp_path))
    trace = {'steps': [{'index': 1, 'started_at': '2026-10-21T00:00:00Z', 'ended_at': None,
                       'elapsed_seconds': 2.5, 'model_wait_seconds': 1.2, 'action': 'click',
                       'target': 'token=private-token', 'tool_result_status': 'pending',
                       'waiting_for': 'app', 'status': 'running', 'screen_text': 'password=private-value'}],
             'in_progress': None, 'truncated_steps': 0}
    states = ['request', 'running', 'done', 'notified', 'delivered', 'delivery-failed', 'invalid', 'parked']
    for index, state in enumerate(states):
        (tmp_path / f'job-{index:012x}.{state}.json').write_text(json.dumps(
            {'principal_id': 'owner', 'job_id': f'job-{index:012x}', 'trace': trace}))
    (tmp_path / 'job-ffffffffffff.done.json').write_text(json.dumps({'principal_id': 'other', 'trace': 'not visible'}))
    result = observe.observe({'source': 'errands'}, 'owner')
    assert {r['spool_state'] for r in result['records']} == set(states)
    assert result['records'][0]['trace']['steps'][0]['model_wait_seconds'] == 1.2
    assert 'private-token' not in str(result) and 'private-value' not in str(result)
    assert 'not visible' not in str(result)


def test_errands_expose_report_stage_and_absorbed_self_check_results(tmp_path, monkeypatch):
    import json
    monkeypatch.setenv('PAIOS_ERRAND_SPOOL', str(tmp_path))
    failure = {'error_code': 'ERRAND_REPORT_NOT_DELIVERED', 'failed_at': '2026-10-22T18:40:55.473Z', 'stage': 'report_run',
               'reason': 'report run run-1 ended failed (reply_phase=failed, reply_mode=none) before recipient selection'}
    facts = {'execution': {'success': True, 'terminal_reason': 'completed'},
             'delivery': {'scope': 'owner_report', 'status': 'body_sent_without_ack', 'body_complete': True},
             'task_retry_allowed': False}
    (tmp_path / 'job-63e081726062.invalid.json').write_text(json.dumps({'principal_id': 'owner', 'job_id': 'job-63e081726062',
        'success': True, 'terminal_reason': 'completed', 'finished_at': '2026-10-22T18:40:46.566Z', 'delivery_failure': failure, **facts}))
    (tmp_path / 'job-237480ca39ea.delivered.json').write_text(json.dumps({'principal_id': 'owner', 'job_id': 'job-237480ca39ea',
        'success': True, 'terminal_reason': 'completed', 'finished_at': '2026-10-22T18:42:43.731Z',
        'self_check_of': 'job-63e081726062:0', 'report_absorbed': True}))
    records = {r['job_id']: r for r in observe.observe({'source': 'errands', 'since': 0}, 'owner')['records']}
    assert records['job-63e081726062']['delivery_failure'] == failure
    assert records['job-63e081726062']['success'] is True
    assert {key: records['job-63e081726062'][key] for key in facts} == facts
    assert not set(facts).intersection(records['job-237480ca39ea'])
    assert records['job-237480ca39ea']['report_absorbed'] is True
    assert records['job-237480ca39ea']['self_check_of'] == 'job-63e081726062:0'


@pytest.mark.parametrize('query', ['job-000000000002', 'COMPOUND'])
def test_errands_text_filters_owner_records_before_limit(tmp_path, monkeypatch, query):
    import json
    monkeypatch.setenv('PAIOS_ERRAND_SPOOL', str(tmp_path))
    for number, owner, title in ((1, 'owner', 'Unrelated task'),
                                 (2, 'owner', 'Send compound.xlsx'),
                                 (3, 'other', 'Send compound.xlsx')):
        job = f'job-{number:012x}'
        (tmp_path / (job + '.done.json')).write_text(json.dumps(
            {'principal_id': owner, 'job_id': job, 'title': title}))
    result = observe.observe({'source': 'errands', 'text': query, 'limit': 1}, 'owner')
    assert [record['job_id'] for record in result['records']] == ['job-000000000002']
    assert observe.observe({'source': 'errands', 'text': 'no match'}, 'owner')['records'] == []


def test_release_reads_only_projection_and_rejects_path_input(tmp_path, monkeypatch):
    import json
    monkeypatch.setenv('PAIOS_RELEASE_SPOOL', str(tmp_path))
    (tmp_path / 'status').mkdir()
    (tmp_path / 'status' / 'abcdef123456.json').write_text(json.dumps(
        {'state': 'awaiting_owner', 'commit': 'abc123', 'secret': 'never-return', 'steps': [{'error': 'token=private-token'}]}))
    (tmp_path / 'status' / 'runtime.json').write_text(json.dumps({'current': {'commit': 'current'}, 'previous': {'commit': 'previous'},
        'health': {'gateway': {'health': 'healthy'}}, 'updated_at': '2026-10-21T01:00:00.000Z',
        'recent': [{'event': 'switch_passed'}], 'requests': [{'state': 'awaiting_owner'}],
        'builder_requests': [{'request_id': 'mine', 'principal_id': 'owner'}, {'request_id': 'not visible', 'principal_id': 'other'}]}))
    result = observe.observe({'source': 'release', 'request_id': 'abcdef123456'}, 'owner')
    assert result['runtime']['current']['commit'] == 'current'
    assert result['runtime']['previous']['commit'] == 'previous'
    assert result['runtime']['health']['gateway']['health'] == 'healthy'
    assert result['runtime']['updated_at'] == '2026-10-21T01:00:00.000Z'
    assert result['runtime']['requests'][0]['state'] == 'awaiting_owner'
    assert [r['request_id'] for r in result['runtime']['builder_requests']] == ['mine']
    assert result['records'][0]['state'] == 'awaiting_owner'
    assert 'never-return' not in str(result) and 'private-token' not in str(result)
    with pytest.raises(ValueError, match='REQUEST_INVALID'):
        observe.observe({'source': 'release', 'request_id': '../secrets'})


def test_release_unpublished_projection_keeps_version_and_rollback_unknown(tmp_path, monkeypatch):
    monkeypatch.setenv('PAIOS_RELEASE_SPOOL', str(tmp_path))
    rollback = tmp_path / 'rollback'
    rollback.mkdir()
    for request in ('000000000001', '000000000002'):
        (rollback / (request + '.json')).write_text('{}')
    result = observe.observe({'source': 'release'})
    assert result['runtime'] is None and result['runtime_status'] == 'not_published'
    assert set(result['pending_rollback_requests']) == {'000000000001', '000000000002'}
    assert result['records'] == []
    assert result['observation_facts'] == {
        'runtime_status_scope': 'runtime_projection_publication',
        'current_version': 'unknown', 'previous_version': 'unknown',
        'rollback_effect': 'unknown', 'rollback_blocking_reason': 'unknown',
        'pending_rollback_requests_scope': 'request_files_only',
        'pending_queue_clear_required': False,
    }


@pytest.mark.parametrize('state,effect', [('waiting_idle', 'unknown'), ('refused', 'unknown'),
                                         ('done', 'recorded_done')])
def test_release_rollback_facts_use_requested_receipt_not_pending_files(tmp_path, monkeypatch, state, effect):
    import json
    monkeypatch.setenv('PAIOS_RELEASE_SPOOL', str(tmp_path))
    status = tmp_path / 'status'
    status.mkdir()
    (status / 'runtime.json').write_text(json.dumps({'current': {'commit': 'new'}, 'previous': None}))
    receipt = {'request_id': 'rollback-000000000001', 'state': state}
    if state == 'done':
        receipt.update({'from': '/releases/new', 'to': '/releases/old', 'undone': 'switch-1'})
    (status / 'rollback-000000000001.json').write_text(json.dumps(receipt))
    result = observe.observe({'source': 'release', 'request_id': 'rollback-000000000001'})
    facts = result['observation_facts']
    assert facts['current_version'] == 'observed' and facts['previous_version'] == 'unknown'
    assert facts['rollback_effect'] == effect
    assert facts['pending_queue_clear_required'] is False
    assert result['records'] == [receipt]


def test_release_pending_files_match_consumer_and_report_truncation(tmp_path, monkeypatch):
    monkeypatch.setenv('PAIOS_RELEASE_SPOOL', str(tmp_path))
    rollback = tmp_path / 'rollback'
    rollback.mkdir()
    for name in ('invalid.json', 'rollback-000000000001.json', '000000000001.json', '000000000002.json'):
        (rollback / name).write_text('{}')
    result = observe.observe({'source': 'release', 'limit': 1})
    assert len(result['pending_rollback_requests']) == 1
    assert result['pending_rollback_requests'][0] in {'000000000001', '000000000002'}
    assert result['truncated'] is True


def test_tail_is_bounded_and_rejects_symlinks(tmp_path):
    path = tmp_path / 'agent.log'
    path.write_text('old\n' * 20000 + 'latest\n')
    text, truncated = observe.tail(path)
    assert truncated and len(text.encode()) <= 65536 and text.endswith('latest\n')
    link = tmp_path / 'linked.log'
    link.symlink_to(path)
    with pytest.raises(OSError):
        observe.tail(link)


def test_source_formats_mask_json_query_and_partial_multiline_keys():
    text = '\n'.join(['{"api_key": "json-secret"}', 'url=https://host/?token=query-secret&x=1',
                       'Authorization: Bearer opaque-secret', '-----BEGIN PRIVATE KEY-----',
                       'short-private-material', '-----END PRIVATE KEY-----'])
    result = observe.scrub(text)
    for secret in ['json-secret', 'query-secret', 'opaque-secret', 'short-private-material']:
        assert secret not in result
    assert 'short-private-material' not in observe.scrub('short-private-material\n-----END PRIVATE KEY-----')


def test_log_filters_use_native_metadata_before_limit(tmp_path, monkeypatch):
    from hermes_constants import get_hermes_home
    constants = sys.modules['hermes_constants']
    monkeypatch.setattr(constants, 'get_hermes_home', lambda: tmp_path)
    logs = tmp_path / 'logs'; logs.mkdir()
    (logs / 'agent.log').write_text('\n'.join([
        '2026-10-21 01:00:00 INFO gateway.run: old message',
        '2026-10-21 02:00:00 ERROR tools.phone: waiting token=synthetic-secret',
        '2026-10-21 03:00:00 INFO tools.phone: later message',
        'unframed output without metadata']))
    import datetime
    since = datetime.datetime(2026, 10, 21, 1, 30).timestamp() * 1000
    until = datetime.datetime(2026, 10, 21, 2, 30).timestamp() * 1000
    result = observe.observe({'source': 'hermes_agent', 'since': since, 'until': until,
                              'service': 'hermes', 'level': 'WARNING', 'text': 'waiting', 'limit': 1})
    assert len(result['records']) == 1 and result['records'][0]['logger'] == 'tools.phone'
    assert result['metadata_unknown'] == 1 and 'synthetic-secret' not in str(result)
    assert observe.observe({'source': 'hermes_agent', 'service': 'gateway'})['records'] == []
