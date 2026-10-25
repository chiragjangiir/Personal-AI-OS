"""Selfcheck source evidence survives independently of the child's interpretation."""
import json
import pytest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

from gateway.platforms.api_run_delegation import RunDelegation
from tools.delegate_tool_child_run import _build_result_entry, _SchemaOutcome


def result_entry(child, index=0, **result):
    return _build_result_entry(child, {'completed': True, 'final_response': 'The original task failed.', **result},
                               index, 0.1, _SchemaOutcome(None, None, [], 0))


def test_failure_selfcheck_completion_preserves_original_execution_and_delivery(monkeypatch, tmp_path):
    from tools import delegate_tool
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    token = set_hermes_home_override(tmp_path)
    completions = []
    def dispatch(**kwargs):
        child = SimpleNamespace(_paios_failure_context=kwargs.get('failure_context'))
        completions.append(result_entry(child))
        return '{"status":"dispatched"}'
    monkeypatch.setattr(delegate_tool, 'delegate_task', dispatch)
    event = {'delegation_id': 'job-original', 'source': 'errand', 'goal': 'Read the requested page',
             'status': 'failed', 'execution': {'success': True, 'terminal_reason': 'completed'},
             'delivery': {'status': 'body_sent_without_ack', 'body_complete': True}, 'task_retry_allowed': False,
             'evidence_ref': {'tool': 'phone_status', 'job_id': 'job-original'}}
    try:
        bridge = RunDelegation(SimpleNamespace(_paios_delegate_toolsets=['file']), lambda _: None)
        bridge._start_failure_selfchecks([event])
    finally:
        reset_hermes_home_override(token)
    expected = {**RunDelegation.failure_metadata(event, event), 'request_context': []}
    assert completions[0]['source_failure'] == expected
    assert completions[0]['source_failure']['execution']['success'] is True
    assert completions[0]['summary'] == 'The original task failed.'
    resumed = []
    parent = RunDelegation(SimpleNamespace(_interrupt_requested=False), lambda _: None)
    parent.results.put({'delegation_id': 'selfcheck', 'goal': 'Check the report', 'results': completions})
    parent.resume({'messages': []}, lambda text, history: resumed.append(json.loads(text.split('\n', 1)[1])) or {'messages': history})
    entry = resumed[0]['completion_events'][0]['results'][0]
    assert entry['source_failure'] == expected
    assert 'failure_context' not in entry


def test_internal_delegation_context_is_isolated_for_parallel_children(monkeypatch):
    from tools import delegate_tool, delegation_live_log
    children = [SimpleNamespace(), SimpleNamespace()]
    monkeypatch.setattr(delegate_tool, 'is_spawn_paused', lambda: False)
    monkeypatch.setattr(delegate_tool, '_load_config', lambda: {})
    monkeypatch.setattr(delegate_tool, '_resolve_delegation_credentials', lambda *_: {'model': 'fixture', 'provider': 'fixture'})
    monkeypatch.setattr(delegate_tool, '_announce_batch', lambda *_: None)
    monkeypatch.setattr(delegation_live_log, 'create_live_transcripts', lambda *a, **kw: (None, [], []))
    monkeypatch.setattr(delegate_tool, '_build_children', lambda tasks, *a, **kw: (
        [(i, tasks[i]['goal'], child) for i, child in enumerate(children)], None))
    def run(batch, background):
        with ThreadPoolExecutor(max_workers=2) as pool:
            return json.dumps(list(pool.map(lambda item: result_entry(item[2], item[0]), batch.children)))
    monkeypatch.setattr(delegate_tool, '_run_batch', run)
    source = {'id': 'job:0', 'execution': {'success': True}, 'delivery': {'status': 'unknown'}}
    output = json.loads(delegate_tool.delegate_task(tasks=[{'goal': 'Inspect the first report'}, {'goal': 'Inspect the second report'}],
        parent_agent=SimpleNamespace(), failure_context=source))
    assert isinstance(output, list), output
    assert [row['source_failure'] for row in output] == [source, source]
    children[0]._paios_failure_context['execution']['success'] = False
    assert children[1]._paios_failure_context == source
    assert output[0]['source_failure'] == source


def test_ordinary_delegate_keeps_terminal_failure_and_model_cannot_supply_source_context(monkeypatch):
    from tools import delegate_tool
    entry = result_entry(SimpleNamespace(), failed=True, error='Real provider failure')
    assert entry['status'] == 'failed' and entry['error'] == 'Real provider failure'
    assert 'source_failure' not in entry
    assert 'failure_context' not in delegate_tool.DELEGATE_TASK_SCHEMA['parameters']['properties']
    calls = []
    monkeypatch.setattr(delegate_tool, 'delegate_task', lambda **kwargs: calls.append(kwargs) or '{}')
    delegate_tool.registry.get_entry('delegate_task').handler({'goal': 'Ordinary', 'failure_context': {'fake': True}},
                                                            parent_agent=SimpleNamespace())
    assert 'failure_context' not in calls[0]


@pytest.mark.parametrize('status', ['timed_out', 'error', 'interrupted'])
def test_fabricated_selfcheck_terminal_result_keeps_original_source_facts(status):
    from tools.delegate_tool_child_run import _fabricated_entry
    source = {'id': 'original:0', 'execution': {'success': True},
              'delivery': {'status': 'body_sent_without_ack'}, 'task_retry_allowed': False}
    child = SimpleNamespace(_paios_failure_context=source)
    entry = _fabricated_entry(0, status, 'Selfcheck did not finish', child, 12.5)
    assert entry['status'] == status and entry['error'] == 'Selfcheck did not finish'
    assert entry['source_failure'] == source
    source['execution']['success'] = False
    assert entry['source_failure']['execution']['success'] is True
    assert entry['source_failure']['task_retry_allowed'] is False


@pytest.mark.parametrize('child', [None, SimpleNamespace()])
def test_fabricated_ordinary_delegate_has_no_source_failure(child):
    from tools.delegate_tool_child_run import _fabricated_entry
    entry = _fabricated_entry(0, 'error', 'Ordinary failure', child)
    assert entry['status'] == 'error' and entry['error'] == 'Ordinary failure'
    assert 'source_failure' not in entry
