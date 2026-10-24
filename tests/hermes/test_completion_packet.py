"""Completion packets separate source reports from history without copying child summaries."""
import json
from types import SimpleNamespace

import pytest

from gateway.platforms.api_run_delegation import RunDelegation


def resume_entries(entries):
    bridge = RunDelegation(SimpleNamespace(_interrupt_requested=False), lambda _: None)
    bridge.results.put({'delegation_id': 'batch', 'goals': ['Check evidence'] * len(entries), 'results': entries})
    packets = []
    bridge.resume({'messages': []}, lambda text, history: packets.append(json.loads(text.split('\n', 1)[1])) or {'messages': history})
    return packets[0]


def test_successful_completion_keeps_summary_once_and_preserves_source_failure():
    source = {'execution': {'success': True}, 'delivery': {'status': 'unknown'}}
    packet = resume_entries([{'task_index': 0, 'status': 'completed', 'outcome': 'succeeded',
        'exit_reason': 'completed', 'summary': 'New file verification and confirmation facts.', 'source_failure': source}])
    entry = packet['completion_events'][0]['results'][0]
    assert 'failure_context' not in entry
    assert entry['source_failure'] == source
    assert 'summary' not in entry and 'outcome' not in entry
    assert packet['agent_reports'][0]['summary'] == 'New file verification and confirmation facts.'
    assert packet['agent_reports'][0]['kind'] == 'model_claims'


@pytest.mark.parametrize('entry', [
    {'status': 'error', 'error': 'Provider unavailable'},
    {'status': 'completed', 'outcome': 'failed', 'outcome_reason': 'No verified result', 'exit_reason': 'completed'},
    {'status': 'completed', 'outcome': 'partial', 'outcome_reason': 'Navigation blocked; purifier changed', 'exit_reason': 'completed'},
    {'status': 'completed', 'exit_reason': 'max_iterations', 'truncated': True},
])
def test_native_failure_and_partial_business_outcome_keep_context_without_repeating_summary(entry):
    packet = resume_entries([{**entry, 'task_index': 0, 'summary': 'Exact child evidence'}])
    result = packet['completion_events'][0]['results'][0]
    context = result['failure_context']
    assert 'summary' not in context
    assert packet['agent_reports'][0]['summary'] == 'Exact child evidence'
    assert 'summary' not in result
    assert context['terminal_reason'] == entry.get('exit_reason', entry['status'])
    if 'outcome_reason' in entry:
        assert packet['agent_reports'][0]['failure_context']['reported_outcome'] == {
            'outcome': entry['outcome'], 'reason': entry['outcome_reason']}
        assert 'reported_outcome' not in context


def test_job_bound_report_is_not_duplicated_in_local_assistant_history():
    report = {'job_id': 'job-a', 'source': {'session_id': 'conversation-a', 'run_id': 'run-a', 'processed_event_id': 'd:a'},
        'status': 'sealed', 'reply_text': 'Exact original generated report.', 'generated': True,
        'publication': {'published_text_through_seq': 0}, 'delivery_status': 'unknown'}
    history = [{'role': 'assistant', 'content': report['reply_text'], '_row_id': 5},
               {'role': 'assistant', 'content': 'I will collect the final result.', '_row_id': 6}]
    text = RunDelegation.completion_input([], history, [report])
    packet = json.loads(text.split('\n', 1)[1])
    assert packet['prior_reports'] == [report]
    assert packet['local_reports'] == [{'message_id': 6, 'text': history[1]['content']}]
    assert text.count(report['reply_text']) == 1
    assert packet['prior_reports'][0]['delivery_status'] == 'unknown'


def test_local_reports_are_read_from_only_the_current_session(tmp_path):
    from hermes_state import SessionDB
    db = SessionDB(tmp_path / 'state.db')
    db.create_session('local', source='api_server');db.create_session('foreign', source='api_server')
    db.append_message('local', 'assistant', 'Local reply')
    db.append_message('foreign', 'assistant', 'Foreign reply')
    bridge = RunDelegation(SimpleNamespace(session_id='local', _session_db=db, _interrupt_requested=False), lambda _: None)
    bridge.results.put({'delegation_id': 'local-completion', 'goal': 'Read local history', 'status': 'completed'})
    packets = []
    try:
        bridge.resume({'messages': []}, lambda text, history: packets.append(json.loads(text.split('\n', 1)[1])) or {'messages': history})
    finally:
        db.close()
    assert [row['text'] for row in packets[0]['local_reports']] == ['Local reply']


def test_claim_projection_preserves_raw_event_and_all_reports_without_promoting_notes():
    from copy import deepcopy
    source={'execution':{'success':True},'delivery':{'status':'unknown'},'summary':'Earlier model causal guess'}
    child={'task_index':2,'session_id':'child-session','status':'completed','exit_reason':'completed','schema_valid':True,
        'summary':'Current model summary','result':{'kanban':{'body':'Saved model cause claim'},'new_artifact':'first result'},
        'outcome':'partial','outcome_reason':'Model explanation','source_failure':source,
        'confirmation_receipts':[{'confirmation':{'choice':'once'}}], 'task_records':[{'request':{},'result':{'runtime_status':'not_published'}}]}
    events=[{'delegation_id':'original-batch','results':[child]}];original=deepcopy(events)
    packet=json.loads(RunDelegation.completion_input(events,[]).split('\n',1)[1])
    assert events==original
    assert list(packet)==['prior_reports','local_reports','agent_reports','completion_events']
    report=packet['agent_reports'][0]
    assert report=={'kind':'model_claims','delegation_id':'original-batch','task_index':2,'session_id':'child-session',
        'summary':child['summary'],'result':child['result'],'outcome':'partial','outcome_reason':'Model explanation',
        'source_failure':{'summary':'Earlier model causal guess'}}
    fact=packet['completion_events'][0]['results'][0]
    assert fact['status']=='completed' and fact['schema_valid'] is True
    assert fact['confirmation_receipts']==child['confirmation_receipts'] and fact['task_records']==child['task_records']
    assert fact['source_failure']=={'execution':{'success':True},'delivery':{'status':'unknown'}}
    assert all(name not in fact for name in ('summary','result','outcome','outcome_reason'))


def test_nonbatch_completion_also_keeps_claims_and_runtime_separate():
    event={'delegation_id':'single','status':'error','error':'Transport failed','summary':'Model explanation'}
    packet=json.loads(RunDelegation.completion_input([event],[]).split('\n',1)[1])
    assert packet['completion_events']==[{'delegation_id':'single','status':'error','error':'Transport failed',
        'task_scope':{'job_ids':[],'prior_report_refs':[]},
        'completion_scope':{'kind':'delegated_task','delegation_id':'single'}}]
    assert packet['agent_reports'][0]['summary']=='Model explanation'
    assert event['summary']=='Model explanation'
