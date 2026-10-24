"""Cross-conversation reports enter the native completion from the existing OUT source."""
import json
from types import SimpleNamespace

from gateway.platforms.api_run_delegation import RunDelegation
from integrations.hermes.personal_aios import PersonalAIOSProvider


def test_native_completion_reads_job_bound_out_report_from_another_conversation(monkeypatch):
    from agent.memory_manager import MemoryManager
    from gateway.session_context import set_session_vars, clear_session_vars
    provider = PersonalAIOSProvider.__new__(PersonalAIOSProvider)
    reports = [{'job_id': 'job-a', 'source': {'session_id': 'conversation-a', 'run_id': 'run-a',
                'processed_event_id': 'd:a'}, 'status': 'sealed', 'reply_text': 'Exact earlier reply.',
                'generated': True, 'publication': {'published_text_through_seq': 1}, 'delivery_status': 'unknown'}]
    calls = []
    def request(path, body):
        calls.append((path, body))
        return {'prior_reports': reports}
    monkeypatch.setattr(provider, '_request', request)
    manager = MemoryManager.__new__(MemoryManager)
    manager._providers = [provider]
    agent = SimpleNamespace(session_id='transcript-b', _paios_tool_conversation='conversation-b',
        _paios_principal_id='owner', _memory_manager=manager, _interrupt_requested=False)
    bridge = RunDelegation(agent, lambda _: None)
    bridge.results.put({'delegation_id': 'delegate-b', 'goal': 'Report job-a', 'status': 'completed',
        'results': [{'status': 'completed', 'summary': 'A misleading child summary.', 'task_records': [
            {'tool': 'phone_status', 'request': {'job_id': 'job-a'}, 'result': {'job_id': 'job-a', 'status': 'completed'}}]}]})
    received = []
    token = set_session_vars(platform='api_server', session_id='transcript-b', session_key='run-b')
    try:
        bridge.resume({'messages': []}, lambda text, history: received.append(json.loads(text.split('\n', 1)[1])) or {'messages': history})
    finally:
        clear_session_vars(token)
    assert calls == [('/internal/hermes/errand-report-context', {
        'context': {'run_id': 'run-b', 'session_id': 'conversation-b'}, 'job_ids': ['job-a']})]
    assert received[0]['prior_reports'] == reports
    assert received[0]['prior_reports'][0]['delivery_status'] == 'unknown'


def test_generic_hermes_completion_does_not_require_personal_aios():
    bridge = RunDelegation(SimpleNamespace(_interrupt_requested=False), lambda _: None)
    bridge.results.put({'delegation_id': 'generic', 'goal': 'Generic', 'status': 'completed'})
    received = []
    bridge.resume({'messages': []}, lambda text, history: received.append(text) or {'messages': history})
    assert json.loads(received[0].split('\n', 1)[1])['prior_reports'] == []
