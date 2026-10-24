"""Resolved owner decisions remain facts when a blocking tool returns or replays."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize('choice', ['once', 'deny'])
def test_release_waits_for_real_native_decision_and_replays_without_new_prompt(tmp_path, monkeypatch, choice):
    monkeypatch.syspath_prepend(str(Path(__file__).parents[2] / 'integrations/hermes'))
    from personal_aios.release_consent import release_decide
    from gateway import run_scope, session_context
    from tools import approval, approval_context
    monkeypatch.setattr(run_scope, 'current_scope', lambda: 'owner')
    monkeypatch.setattr(session_context, 'get_api_run_id', lambda _: 'run-owner')
    monkeypatch.setattr(approval_context, 'get_current_session_key', lambda: 'decision-test')
    token = approval_context._approval_tool_call_id.set('tool-owner')
    status = tmp_path / 'status/0123456789ab.json'
    status.parent.mkdir()
    status.write_text(json.dumps({'state': 'awaiting_owner', 'base': 'b' * 40, 'commit': 'c' * 40,
                                 'protected_paths': ['protected.py'], 'origin': {'principal_id': 'owner'}}))
    actor = {'confirmation_id': 'native-card', 'confirmed_by': 'owner', 'surface': None}
    calls = []
    def notify(card):
        calls.append(card)
        assert approval.resolve_gateway_approval('decision-test', choice, reason='actual-answer',
            request_id=card['request_id'], confirmation=actor) == 1
    monkeypatch.setattr(approval, '_gateway_notify_cb', lambda _: notify)
    provider = SimpleNamespace(_request=lambda *a: {'allow_owner_mutation': True, 'principal_id': 'owner'})
    try:
        fresh = release_decide(tmp_path, '0123456789ab', provider, 'session')
        assert fresh['confirmation_evidence'] == {'actor_type': 'authenticated_owner_principal',
            'physical_actor': 'unknown', 'card_rendering': 'unknown'}
        assert fresh['decision_status'] == 'resolved'
        assert fresh['decision'] == ('approved' if choice == 'once' else 'denied')
        assert fresh['decision_source'] == 'native_owner_confirmation'
        assert fresh['choice'] == choice and fresh['reason'] == 'actual-answer'
        assert fresh['lifecycle'] == 'waited_for_owner_decision' and fresh['reused'] is False
        assert fresh['surface'] is None and fresh['confirmed_by'] == 'owner'
        cached = release_decide(tmp_path, '0123456789ab', provider, 'session')
        assert cached == {**fresh, 'lifecycle': 'saved_decision_replay', 'reused': True}
        assert len(calls) == 1
        import sys
        from copy import deepcopy
        monkeypatch.syspath_prepend(str(Path(__file__).parents[2] / 'deploy/cloud/staging'))
        monkeypatch.setitem(sys.modules, 'narration_product', sys.modules['personal_aios'])
        monkeypatch.setitem(sys.modules, 'narration_product.release_consent', sys.modules['personal_aios.release_consent'])
        from narration_inputs import project_saved_decisions
        for produced in (fresh, cached):
            messages = [{'role': 'assistant', 'tool_calls': [{'id': 'decision', 'function': {
                'name': 'skills_hub', 'arguments': json.dumps({'action': 'release_decide', 'value': '0123456789ab'})}}]},
                {'role': 'tool', 'tool_call_id': 'decision', 'content': json.dumps(produced)}]
            assert project_saved_decisions(deepcopy(messages)) == messages
        legacy = {k: fresh[k] for k in ('request_id', 'base', 'commit', 'approved', 'principal_id', 'decided_at')}
        (tmp_path / 'decisions/0123456789ab.json').write_text(json.dumps(legacy))
        cached = release_decide(tmp_path, '0123456789ab', provider, 'session')
        assert cached['decision_source'] == 'release_decision_record'
        assert cached['decision_status'] == 'resolved'
        assert 'choice' not in cached and 'reason' not in cached
        assert cached['surface'] is None and cached['reused'] is True
    finally:
        approval_context._approval_tool_call_id.reset(token)


def test_completion_projects_same_resolved_contract_without_editing_child_summary():
    from gateway.platforms.api_run_reporting import confirmation_receipts, task_records
    decision = {'request_id': 'candidate', 'approved': False, 'decision_status': 'resolved',
                'decision': 'denied', 'decision_source': 'native_owner_confirmation',
                'choice': 'deny', 'reason': None, 'lifecycle': 'waited_for_owner_decision', 'reused': False,
                'confirmation_evidence': {'actor_type': 'authenticated_owner_principal',
                    'physical_actor': 'unknown', 'card_rendering': 'unknown'},
                'confirmation_id': 'card', 'confirmed_by': 'owner', 'confirmed_at': '2026-10-23T00:00:00Z', 'surface': None}
    messages = [{'role': 'assistant', 'tool_calls': [{'id': 'call', 'function': {
        'name': 'skills_hub', 'arguments': json.dumps({'action': 'release_decide', 'value': 'candidate'})}}]},
        {'role': 'tool', 'tool_call_id': 'call', 'content': json.dumps(decision)},
        {'role': 'assistant', 'content': 'No confirmation card appeared; clear the old decision.'}]
    assert task_records(messages)[0]['result'] == decision
    projected = confirmation_receipts(messages)[0]['confirmation']
    assert projected == {k: v for k, v in decision.items() if k not in ('request_id', 'approved')}
    assert messages[-1]['content'] == 'No confirmation card appeared; clear the old decision.'
