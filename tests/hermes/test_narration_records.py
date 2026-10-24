"""Reports receive durable records independently of a child's interpretation."""
import json
from types import SimpleNamespace

from gateway.platforms.api_run_delegation import RunDelegation


def test_native_decision_preserves_the_authenticated_confirmation(monkeypatch):
    from tools import approval
    from tools.approval_gateway_wait import _await_gateway_decision
    actor = {'confirmation_id': 'card', 'confirmed_by': 'owner',
             'surface': {'device_id': 'phone', 'device_type': 'iphone'}}
    def notify(card):
        assert approval.resolve_gateway_approval('narration', 'once', request_id=card['request_id'],
                                                 confirmation=actor) == 1
    result = _await_gateway_decision('narration', notify, {'description': 'fixture'})
    assert result['resolved'] and result['choice'] == 'once'
    assert {k: result['confirmation'][k] for k in actor} == actor
    assert result['confirmation']['confirmed_at'].endswith('Z')


def test_child_completion_preserves_tool_confirmation_even_when_summary_denies_it():
    from tools.delegate_tool_child_run import _build_result_entry, _SchemaOutcome
    from agent.tool_dispatch_helpers import make_tool_result_message
    approval = {'confirmation_id': 'card', 'confirmed_by': 'owner',
                'surface': {'device_id': 'phone', 'device_type': 'iphone'},
                'confirmed_at': '2026-10-23T00:00:00Z', 'choice': 'once', 'reused': False}
    messages = [{'role': 'assistant', 'tool_calls': [{'id': 'send', 'function': {'name': 'phone_task', 'arguments': '{}'}}]},
                make_tool_result_message('phone_task', json.dumps({
                    'result': json.dumps({'status': 'started', 'job_id': 'job-1'}), 'approval': approval}), 'send')]
    result = _build_result_entry(SimpleNamespace(), {'completed': True, 'messages': messages,
        'final_response': 'No confirmation card was shown.'}, 0, 1, _SchemaOutcome(None, None, [], 0))
    assert result['confirmation_receipts'] == [{'tool_call_id': 'send', 'tool': 'phone_task',
        'job_id': 'job-1', 'confirmation': approval}]


def test_later_completion_contains_exact_prior_report_and_its_message_identity():
    history = [{'role': 'user', 'content': 'send fixture'},
               {'role': 'assistant', 'tool_calls': [{'id': 'd'}], 'content': 'I will send it.'},
               {'role': 'assistant', 'content': 'The file was sent.', '_row_id': 12}]
    body = RunDelegation.completion_input([{'delegation_id': 'd', 'status': 'completed'}], history)
    facts = json.loads(body.split('\n', 1)[1])
    assert facts['prior_reports'] == []
    assert facts['local_reports'] == [{'message_id': 12, 'text': 'The file was sent.'}]
    assert facts['completion_events'][0]['delegation_id'] == 'd'


def test_completion_keeps_job_bound_out_reports_and_local_history_separately():
    report = {'job_id': 'job-a', 'source': {'session_id': 'other-conversation', 'run_id': 'run-a'},
              'status': 'sealed', 'reply_text': 'Sent already.', 'generated': True,
              'publication': {'published_text_through_seq': 1}, 'delivery_status': 'unknown'}
    history = [{'role': 'assistant', 'content': 'I will collect the last result.', '_row_id': 17}]
    body = RunDelegation.completion_input([{'delegation_id': 'delegate-a'}], history, [report])
    facts = json.loads(body.split('\n', 1)[1])
    assert facts['prior_reports'] == [report]
    assert facts['local_reports'] == [{'message_id': 17, 'text': history[0]['content']}]
    assert facts['prior_reports'][0]['delivery_status'] == 'unknown'


def test_release_confirmation_keeps_the_actual_denial_with_its_provenance():
    from gateway.platforms.api_run_reporting import confirmation_receipts
    decision = {'request_id': 'fixture', 'approved': False, 'confirmation_id': 'card',
                'confirmed_by': 'owner', 'surface': {'device_id': 'mac', 'device_type': 'mac'},
                'confirmed_at': '2026-10-23T00:00:00Z'}
    records = confirmation_receipts([{'role': 'assistant', 'tool_calls': [{'id': 'decide',
        'function': {'name': 'skills_hub', 'arguments': json.dumps({'action': 'release_decide'})}}]},
        {'role': 'tool', 'tool_name': 'skills_hub', 'tool_call_id': 'decide', 'content': json.dumps(decision)}])
    assert records == [{'tool': 'skills_hub', 'tool_call_id': 'decide',
        'request_id': 'fixture', 'approved': False, 'confirmation': {k: decision[k]
            for k in ('confirmation_id', 'confirmed_by', 'surface', 'confirmed_at')}}]


def test_child_keeps_recorded_release_decision_when_legacy_confirmation_id_is_unknown():
    from tools.delegate_tool_child_run import _build_result_entry, _SchemaOutcome
    from agent.tool_dispatch_helpers import make_tool_result_message
    decision = {'request_id': 'a' * 12, 'base': 'baseline', 'commit': 'candidate',
                'approved': True, 'principal_id': 'owner', 'decided_at': 1792713600,
                'confirmed_by': 'owner', 'confirmed_at': '2026-10-23T00:00:00+00:00',
                'confirmation_id': None, 'surface': None}
    request = {'action': 'release_decide', 'value': decision['request_id']}
    messages = [{'role': 'assistant', 'tool_calls': [{'id': 'decision', 'function': {
        'name': 'skills_hub', 'arguments': json.dumps(request)}}]},
        make_tool_result_message('skills_hub', json.dumps({**decision, 'secret': 'must-not-project'}), 'decision')]
    result = _build_result_entry(SimpleNamespace(), {'completed': True, 'messages': messages,
        'final_response': 'Cannot prove owner confirmed.'}, 0, 1, _SchemaOutcome(None, None, [], 0))
    assert result['confirmation_receipts'] == []
    assert result['task_records'] == [{'tool_call_id': 'decision', 'tool': 'skills_hub',
                                      'request': request, 'result': decision}]


def test_delivery_selfcheck_keeps_execution_and_transport_facts(monkeypatch):
    from tools import delegate_tool
    calls = []
    monkeypatch.setattr(delegate_tool, 'delegate_task', lambda **kw: calls.append(kw) or '{"status":"dispatched"}')
    app = {'kind': 'errand_delivery_failed', 'job_id': 'job-1', 'terminal_reason': 'failed',
           'execution': {'success': True, 'terminal_reason': 'completed'}, 'task_retry_allowed': False,
           'delivery': {'status': 'body_sent_without_ack', 'stage': None, 'reason': None}}
    bridge = RunDelegation(SimpleNamespace(_paios_delegate_toolsets=['file']), lambda _: None)
    bridge.initial(json.dumps({'origin': 'device_observation', 'content': {'app_event': app}}), [], lambda *a, **kw: {})
    facts = json.loads(calls[0]['context'].split('Failure evidence:\n')[1])
    assert facts['execution'] == app['execution'] and facts['task_retry_allowed'] is False
    assert facts['delivery'] == app['delivery']
    assert facts['kind'] == 'errand_delivery_failed'
    assert facts['job_id'] == app['job_id']
    assert facts['terminal_reason'] == 'failed'
    assert facts['id'] == 'job-1:0'


def test_child_task_records_preserve_request_fields_and_exact_timing_without_secrets():
    from tools.delegate_tool_child_run import _build_result_entry, _SchemaOutcome
    from agent.tool_dispatch_helpers import make_tool_result_message
    request = {'goal': 'Send one fixture email; body is sample-text.', 'app': 'fixture',
               'effect': {'kind': 'send', 'recipient': 'email:fixture@example.test',
                          'task_type': 'fixture-mail'}, 'token': 'must-not-project'}
    calls = [{'id': 'dispatch', 'function': {'name': 'mcp__phone__phone_task', 'arguments': json.dumps(request)}},
             {'id': 'status', 'function': {'name': 'mcp__phone__phone_status', 'arguments': '{"job_id":"job-1"}'}}]
    job = {'job_id': 'job-1', 'success': False, 'terminal_reason': 'timed_out',
           'answer': 'fixture timeout', 'subject': 'recorded subject', 'trace': {'steps': [], 'in_progress': {
               'elapsed_seconds': 0.101, 'model_wait_seconds': 0.101, 'waiting_for': 'model',
               'status': 'stalled', 'secret': 'must-not-project'}}, 'token': 'must-not-project'}
    messages = [{'role': 'assistant', 'tool_calls': calls},
                make_tool_result_message('mcp__phone__phone_status', json.dumps({'result': json.dumps({'jobs': [job]})}), 'status'),
                make_tool_result_message('mcp__phone__phone_task', json.dumps({'result': '{"status":"started","job_id":"job-1"}'}), 'dispatch')]
    result = _build_result_entry(SimpleNamespace(), {'completed': True, 'messages': messages,
        'final_response': 'Invented subject; 10 milliseconds.'}, 0, 1, _SchemaOutcome(None, None, [], 0))
    status, dispatch = result['task_records']
    assert status['tool_call_id'] == 'status' and dispatch['tool_call_id'] == 'dispatch'
    assert dispatch['request'] == {k: request[k] for k in ('goal', 'app', 'effect')}
    assert 'subject' not in dispatch['request'] and 'subject' not in dispatch['result']
    assert status['result']['jobs'][0]['subject'] == 'recorded subject'
    assert status['result']['jobs'][0]['trace']['in_progress']['elapsed_seconds'] == 0.101
    assert status['result']['jobs'][0]['trace']['in_progress']['model_wait_seconds'] == 0.101
    assert 'must-not-project' not in json.dumps(result['task_records'])


def test_child_task_records_include_retained_errand_timestamps_without_other_runtime_data():
    from gateway.platforms.api_run_reporting import task_records
    record = {'job_id': 'job-1', 'started_at': '2026-10-22T22:47:49.998Z',
              'finished_at': '2026-10-22T22:47:50.106Z', 'step': 0, 'max_steps': 40,
              'token': 'must-not-project'}
    messages = [{'role': 'assistant', 'tool_calls': [{'id': 'retained', 'function': {
        'name': 'mcp__self__runtime_query', 'arguments': '{"source":"errands"}'}}]},
        {'role': 'tool', 'tool_call_id': 'retained', 'content': json.dumps({'result': json.dumps({
            'source': 'errands', 'hermes': {'records': [record], 'secret': 'must-not-project'}})})}]
    facts = task_records(messages)
    assert facts[0]['result']['records'] == [{k: v for k, v in record.items() if k != 'token'}]
    assert 'must-not-project' not in json.dumps(facts)
    assert task_records([{'role': 'tool', 'tool_call_id': 'missing', 'content': '{"jobs":[]}'}]) == []


def test_child_completion_keeps_release_observation_and_delivery_failure_as_source_facts():
    from tools.delegate_tool_child_run import _build_result_entry, _SchemaOutcome
    from agent.tool_dispatch_helpers import make_tool_result_message
    release = {'runtime': None, 'runtime_status': 'not_published', 'records': [],
               'pending_rollback_requests': ['a' * 12], 'observation_facts': {
                   'current_version': 'unknown', 'rollback_effect': 'unknown',
                   'pending_queue_clear_required': False}, 'token': 'must-not-project'}
    failure = {'error_code': 'REPORT_FAILED', 'failed_at': '2026-10-23T00:00:00Z',
               'stage': 'report_run', 'reason': 'empty report', 'token': 'must-not-project'}
    calls = [{'id': 'release', 'function': {'name': 'mcp__self__runtime_query',
              'arguments': '{"source":"release","request_id":"rollback-aaaaaaaaaaaa"}'}},
             {'id': 'errands', 'function': {'name': 'mcp__self__runtime_query',
              'arguments': '{"source":"errands","text":"job-a"}'}}]
    messages = [{'role': 'assistant', 'tool_calls': calls},
        make_tool_result_message('mcp__self__runtime_query', json.dumps({'source': 'release',
            'as_of': 1792713600000, 'hermes': release}), 'release'),
        make_tool_result_message('mcp__self__runtime_query', json.dumps({'source': 'errands',
            'as_of': 1792713600000, 'hermes': {'records': [{'job_id': 'job-a', 'success': True,
                'spool_state': 'delivery-failed', 'delivery_failure': failure}]}}), 'errands')]
    entry = _build_result_entry(SimpleNamespace(), {'completed': True, 'messages': messages,
        'final_response': 'Version unchanged; clear the queue first.'}, 0, 1, _SchemaOutcome(None, None, [], 0))
    release_fact, errand_fact = entry['task_records']
    assert release_fact['request'] == {'source': 'release', 'request_id': 'rollback-aaaaaaaaaaaa'}
    assert release_fact['result'] == {'source': 'release', 'as_of': 1792713600000,
                                     **{k: v for k, v in release.items() if k != 'token'}}
    assert errand_fact['result']['as_of'] == 1792713600000
    record = errand_fact['result']['records'][0]
    assert record['success'] is True and record['spool_state'] == 'delivery-failed'
    assert record['delivery_failure'] == {k: v for k, v in failure.items() if k != 'token'}
    assert 'must-not-project' not in json.dumps(entry['task_records'])


def test_child_preserves_unavailable_observation_without_inventing_empty_records():
    from gateway.platforms.api_run_reporting import task_records
    for source in ('errands', 'release'):
        messages = [{'role': 'assistant', 'tool_calls': [{'id': 'observe', 'function': {
            'name': 'mcp__self__runtime_query', 'arguments': json.dumps({'source': source})}}]},
            {'role': 'tool', 'tool_call_id': 'observe', 'content': json.dumps({
                'source': source, 'hermes': {'source': source, 'status': 'unavailable'}})}]
        assert task_records(messages)[0]['result'] == {'source': source, 'status': 'unavailable'}


def test_replay_uses_native_resume_for_completed_failed_and_prior_reports(tmp_path, monkeypatch):
    from pathlib import Path
    monkeypatch.syspath_prepend(str(Path(__file__).parents[2] / 'deploy/cloud/staging'))
    monkeypatch.syspath_prepend(str(Path(__file__).parents[2] / 'integrations/hermes'))
    import sys
    import personal_aios
    monkeypatch.setitem(sys.modules, 'narration_product', personal_aios)
    from narration_inputs import adapt
    events = [{'delegation_id': 'job-a', 'source': 'errand', 'status': 'completed',
               'results': [{'status': 'completed', 'summary': 'Completed child claim.'}]},
              {'delegation_id': 'delegate-b', 'goal': 'failed task', 'status': 'failed',
               'results': [{'status': 'failed', 'summary': 'Failed child claim.'}]}]
    content = 'Native delegated work completed.\n' + json.dumps(events)
    prefix = [{'role': 'assistant', 'content': 'Local earlier statement.'}, {'role': 'system', 'content': content}]
    rows = [dict(id=i, session_id='owner', **message) for i, message in enumerate(prefix, 1)]
    rows.append({'id': 3, 'session_id': 'owner', 'role': 'assistant', 'content': 'Original failing output.'})
    fixture = tmp_path / 'native.json'
    fixture.write_text(json.dumps({'trace': {'messages': rows}}))
    report = {'job_id': 'job-a', 'reply_text': 'Exact prior OUT report.', 'status': 'sealed'}
    result = adapt(prefix, {'native': str(fixture), 'message_id': 3, 'prior_reports_by_message': {'2': [report]}})
    packet = json.loads(result[1]['content'].split('\n', 1)[1])
    assert packet['prior_reports'] == [report]
    assert packet['local_reports'] == [{'message_id': 1, 'text': 'Local earlier statement.'}]
    completed, failed = [event['results'][0] for event in packet['completion_events']]
    assert 'failure_context' not in completed
    assert failed['failure_context']['terminal_reason'] == 'failed'
    assert 'summary' not in failed['failure_context']
    assert 'summary' not in completed and 'summary' not in failed
    assert [report['summary'] for report in packet['agent_reports']] == ['Completed child claim.', 'Failed child claim.']
