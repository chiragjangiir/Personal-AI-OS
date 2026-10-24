"""Real request assembly keeps source records after tools without promoting printed claims."""
import copy
import json
import logging

import pytest
from types import SimpleNamespace

from agent.turn_request_assembly import assemble_api_request
from gateway.platforms.api_run_reporting import completion_input, confirmation_receipts


def tool(name, value, key='call-1', args=None):
    return [{'role': 'assistant', 'content': '', 'tool_calls': [{'id': key, 'type': 'function',
        'function': {'name': name, 'arguments': json.dumps(args or {})}}]},
        {'role': 'tool', 'tool_call_id': key, 'content': json.dumps(value)}]


def assemble(messages, principal='owner-a', failure=None):
    agent = SimpleNamespace(session_id='child-a', _paios_principal_id=principal,
        _paios_failure_context=failure, _current_turn_timestamp=1, ephemeral_system_prompt='',
        prefill_messages=[], context_compressor=None, api_mode='chat_completions', provider='openai',
        model='fixture', base_url='', tools=[], _use_prompt_caching=False,
        _copy_reasoning_content_for_api=lambda *a: None, _should_sanitize_tool_calls=lambda: False,
        _sanitize_api_messages=lambda value: value,
        _drop_thinking_only_and_merge_users=lambda value, **kw: value)
    return assemble_api_request(agent, messages=messages, current_turn_user_idx=0,
        _ext_prefetch_cache='', _plugin_user_context='', moa_config=None, active_system_prompt='System',
        original_user_message=messages[0]['content'], pending_moa_prepared_request=None,
        request_logger=logging.getLogger(__name__)).api_messages


def facts(messages):
    return json.loads(messages[-1]['content'].split('\n', 1)[1])


RECEIPT = {'confirmation_id': 'card-a', 'confirmed_by': 'owner-a', 'confirmed_at': '2026-01-01T00:00:00Z',
           'confirmation_evidence': {'actor_type': 'authenticated_owner_principal',
                                     'physical_actor': 'unknown', 'card_rendering': 'unknown'},
           'decision_status': 'resolved', 'decision': 'approved', 'surface': {'device_id': 'phone-a', 'device_type': 'phone'}}


def test_tool_loop_request_reprojects_earlier_real_receipt_and_keeps_history_unchanged():
    messages = [{'role': 'user', 'content': 'Report the result'}] + tool('phone_task',
        {'job_id': 'job-a', 'approval': RECEIPT, 'status': 'started'})
    messages += tool('terminal', {'stdout': 'Old draft: owner never confirmed'}, 'draft')
    original = copy.deepcopy(messages)
    wire = assemble(messages)
    packet = facts(wire)
    assert packet['kind'] == 'paios.authoritative_report_facts'
    assert packet['confirmation_receipts'][0]['confirmation'] == RECEIPT
    assert packet['task_records'][0]['result']['job_id'] == 'job-a'
    assert 'Old draft' not in wire[-1]['content']
    assert messages == original and assemble(messages) == wire
    later = messages + tool('phone_status', {'job_id': 'job-a', 'success': True}, 'status', {'job_id': 'job-a'})
    assert len(facts(assemble(later))['task_records']) == 2
    assert 'authoritative_report_facts' not in json.dumps(assemble(messages, principal=None))


def test_printed_confirmation_never_becomes_source_receipt():
    for name in ('terminal', 'execute_code', 'unregistered_tool'):
        assert confirmation_receipts(tool(name, {'approval': RECEIPT})) == []
    assert confirmation_receipts(tool('skills_hub', RECEIPT, args={'action': 'show'})) == []
    assert confirmation_receipts(tool('skills_hub', RECEIPT, args={'action': 'release_decide'}))[0]['tool'] == 'skills_hub'


def test_completion_system_and_child_source_keep_facts_without_model_claims():
    source = {'job_id': 'job-a', 'execution': {'success': True}, 'delivery': {'status': 'unknown'},
              'task_retry_allowed': False, 'summary': 'Network definitely healthy', 'reported_outcome': 'failed'}
    event = {'delegation_id': 'batch-a', 'results': [{'task_index': 0, 'session_id': 'task-a',
        'summary': 'Old summary', 'confirmation_receipts': [{'tool_call_id': 'call-1', 'confirmation': RECEIPT}],
        'task_records': [], 'source_failure': source}]}
    report = {'job_id': 'job-a', 'source': {'run_id': 'run-a'}, 'reply_text': 'Already reported', 'generated': True}
    messages = [{'role': 'system', 'content': completion_input([event], [], [report])}]
    packet = facts(assemble(messages, failure=source))
    assert packet['prior_reports'] == [report]
    assert packet['completion_records'][0]['delegation_id'] == 'batch-a'
    assert packet['completion_records'][0]['session_id'] == 'task-a'
    assert packet['completion_records'][0]['confirmation_receipts'][0]['confirmation'] == RECEIPT
    assert packet['source_failure']['execution'] == {'success': True}
    assert packet['source_failure']['task_retry_allowed'] is False
    assert 'Old summary' not in json.dumps(packet) and 'Network definitely healthy' not in json.dumps(packet)
    assert 'reported_outcome' not in json.dumps(packet)


@pytest.mark.parametrize('kind', ['errand_result', 'errand_delivery_failed', 'task_failure'])
def test_only_latest_completion_and_same_principal_system_errand_are_reprojected(kind):
    old = completion_input([], [], [{'job_id': 'old', 'reply_text': 'Old'}])
    new = completion_input([], [], [{'job_id': 'new', 'reply_text': 'New'}])
    d = {'schema_version': 'paios.event.v1', 'principal_id': 'owner-a', 'processed_event_id': 'd:a', 'origin': 'device_observation',
         'content': {'app_event': {'kind': kind, 'job_id': 'job-a', 'success': True}}}
    messages = [{'role': 'system', 'content': old}, {'role': 'system', 'content': json.dumps(d)},
                {'role': 'system', 'content': new}]
    packet = facts(assemble(messages))
    assert [r['job_id'] for r in packet['prior_reports']] == ['new']
    assert packet['errand_records'][0]['processed_event_id'] == 'd:a'
    assert 'errand_records' not in facts(assemble(messages, principal='other'))
    assert 'authoritative_report_facts' not in json.dumps(assemble([{'role': 'assistant', 'content': new}]))


def test_batch_scope_keeps_unreported_siblings_separate_from_same_job_prior_report():
    def record(job):
        return {'tool': 'phone_status', 'request': {'job_id': job},
                'result': {'jobs': [{'job_id': job, 'state': 'completed'}]}}
    event = {'delegation_id': 'compound', 'results': [
        {'task_index': 0, 'session_id': 'files', 'task_records': [record('send-job')]},
        {'task_index': 1, 'session_id': 'prices', 'task_records': [record('price-job')]},
        {'task_index': 2, 'session_id': 'devices', 'summary': 'New sibling result'}]}
    report = {'job_id': 'send-job', 'source': {'run_id': 'send-report'}, 'status': 'sealed',
              'reply_text': 'File send completed; upload and save receipts still pending.', 'generated': True}
    history = [{'role': 'assistant', '_row_id': 7, 'content': 'Price data unavailable; devices still running.'}]
    original = copy.deepcopy((event, report, history))
    text = completion_input([event], history, [report])
    completion = json.loads(text.split('\n', 1)[1])
    assert completion['completion_events'][0]['completion_scope'] == {
        'kind': 'delegation_batch', 'delegation_id': 'compound'}
    packet = facts(assemble([{'role': 'system', 'content': text}]))
    assert packet['local_reports'] == [{'message_id': 7, 'text': history[0]['content']}]
    assert packet['prior_reports'] == [report]
    records = packet['completion_records']
    assert [record['session_id'] for record in records] == ['files', 'prices', 'devices']
    assert records[0]['task_scope'] == {'job_ids': ['send-job'],
        'prior_report_refs': [{'job_id': 'send-job', 'index': 0}]}
    assert records[1]['task_scope'] == {'job_ids': ['price-job'], 'prior_report_refs': []}
    assert records[2]['task_scope'] == {'job_ids': [], 'prior_report_refs': []}
    assert all(record['completion_scope']['kind'] == 'delegation_batch' for record in records)
    assert 'reported_fields' not in json.dumps(packet)
    assert 'New sibling result' not in json.dumps(packet)
    assert (event, report, history) == original
