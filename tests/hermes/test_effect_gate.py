"""Public plugin hook/tool share the server's durable approval scope."""
import importlib.util
import json
from io import BytesIO
from http.client import IncompleteRead
from urllib.error import HTTPError
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

SOURCE = Path(__file__).parents[2] / 'integrations/hermes/personal_aios/effects.py'
spec = importlib.util.spec_from_file_location('effect_gate_under_test', SOURCE)
effects = importlib.util.module_from_spec(spec)
spec.loader.exec_module(effects)


@pytest.fixture
def gate(monkeypatch, tmp_path):
    import model_tools
    from gateway import session_context
    from hermes_cli import lifecycle, plugins
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from tools import approval_context, approval, approval_gateway_wait
    token = set_hermes_home_override(tmp_path)
    state = SimpleNamespace(run='run-one', owner=True, records={}, calls=[], tools={}, prompts=[])
    monkeypatch.setattr(session_context, 'get_api_run_id', lambda _: state.run)
    monkeypatch.setattr(approval_context, 'get_current_session_key', lambda: state.run)
    monkeypatch.setattr(approval, '_gateway_notify_cb', lambda _: lambda data: None)
    wait = Mock(side_effect=lambda key, notify, prompt: state.prompts.append(prompt) or {'resolved': True, 'choice': 'once', 'confirmation': {
        'confirmation_id': 'native:' + prompt['request_id'], 'confirmed_by': 'owner',
        'surface': {'device_id': 'owner-phone', 'device_type': 'phone'}, 'confirmed_at': '2026-10-21T00:00:00.000Z'}})
    monkeypatch.setattr(approval_gateway_wait, '_await_gateway_decision', wait)

    def request(path, body):
        assert path == '/internal/hermes/effect-consent'
        state.calls.append(body)
        if not state.owner:
            raise PermissionError('OWNER_REQUEST_REQUIRED')
        effect = body['effect']
        scope = {'principal_id': 'owner', **{key: effect[key] for key in ('kind', 'recipient', 'task_type')}}
        if not effect['requested']:
            scope.update(body['context'])
        key = json.dumps(scope, sort_keys=True)
        if key in state.records:
            return {'status': 'allowed', 'approval': {**state.records[key], 'reused': True}}
        if not body.get('approved'):
            return {'status': 'confirmation_required', 'scope': scope}
        assert body['confirmation']['confirmed_by'] == 'owner'
        state.records[key] = {**body['confirmation'], 'choice': 'once',
                              'decided_by': 'owner', 'decided_at': '2026-10-21T00:00:00.000Z', 'reused': False}
        return {'status': 'allowed', 'approval': state.records[key]}

    state.provider = SimpleNamespace(_request=Mock(side_effect=request))
    def register_tool(name, toolset, schema, handler, **kwargs):
        state.tools[name] = (schema, handler)
        return object()
    manager = plugins.PluginManager()
    effects.register(SimpleNamespace(register_tool=register_tool, register_middleware=lambda event, callback:
        manager._middleware.setdefault(event, []).append(callback)), state.provider)
    monkeypatch.setattr(plugins, '_delivery_manager', lambda: manager)
    monkeypatch.setattr(lifecycle, 'has_hook', lambda event: False)
    monkeypatch.setattr(lifecycle, 'invoke_hook', lambda *a, **k: [])
    monkeypatch.setattr(model_tools.registry, 'dispatch', lambda name, args, **kwargs: json.dumps({'args': args}))
    state.invoke = lambda name, args, session='session-one', call='call-one': json.loads(model_tools.handle_function_call(
        name, args, session_id=session, tool_call_id=call, skip_tool_request_middleware=True))
    state.hook = lambda args, session='session-one', call='call-one': state.invoke('send_message', args, session, call)
    state.explicit = lambda effect, session='session-one', call='call-one': json.loads(state.tools['paios_effect_check'][1]({'effect': effect}, session_id=session, tool_call_id=call))
    yield state
    reset_hermes_home_override(token)


@pytest.mark.parametrize('target', ['telegram:12345678', 'email:li@example.com'])
def test_first_send_fresh_session_new_person_and_type(gate, target):
    args = {'target': target, 'message': '周五交方案', 'requested': True}
    assert 'args' in gate.hook(args)
    assert len(gate.prompts) == len(gate.records) == 1
    assert gate.calls[-1]['approved'] is True
    assert gate.calls[-1]['effect']['recipient'] == target
    # The next run has no local approval state. Only the authority is retained.
    gate.run = 'run-fresh'
    assert 'args' in gate.hook({**args, 'message': '更新了方案'}, 'session-fresh')
    assert len(gate.prompts) == 1
    assert 'args' in gate.hook({**args, 'target': target.replace('12345678', '98765432').replace('li@', 'wang@')})
    assert len(gate.prompts) == 2
    assert 'args' in gate.hook({**args, 'action': 'react', 'emoji': '👍'})
    assert len(gate.prompts) == 3
    assert all(not prompt['allow_permanent'] and not prompt['allow_session'] for prompt in gate.prompts)
    assert '周五交方案' in gate.prompts[0]['description']
    assert ('邮件发送' if target.startswith('email:') else 'Telegram发送') in gate.prompts[0]['description']
    assert '{' not in gate.prompts[0]['description']
    assert '周五交方案' not in gate.prompts[0]['command']


@pytest.mark.parametrize('target', ['', 'telegram', 'telegram:妈妈', 'email:妈妈', 'email:12345', 'wecom:妈妈', 'dingtalk:12345678'])
def test_underivable_recipient_blocks_before_authority(gate, target):
    assert 'error' in gate.hook({'target': target, 'message': 'hello'})
    assert gate.calls == gate.prompts == []


def test_nickname_is_blocked_even_if_native_directory_would_guess(gate):
    from hermes_constants import get_hermes_home
    (get_hermes_home() / 'channel_directory.json').write_text(json.dumps({'platforms': {'wecom': [
        {'id': 'verified-user-1', 'name': '妈妈'}]}}))
    assert 'error' in gate.hook({'target': 'wecom:妈妈', 'message': 'hi'})
    assert gate.calls == []
    assert gate.hook({'target': 'wecom:verified-user-1', 'message': 'hi'})['args']['target'] == 'wecom:verified-user-1'
    assert gate.calls[-1]['effect']['recipient'] == 'wecom:verified-user-1'


def test_explicit_check_and_hook_share_exact_authority(gate):
    effect = {'kind': 'send', 'recipient': 'email:li@example.com', 'task_type': 'send_message:email:send', 'requested': True, 'summary': '短预览'}
    assert gate.explicit(effect)['allowed'] is True
    gate.run = 'new-run'
    assert 'args' in gate.hook({'target': effect['recipient'], 'message': 'other text', 'requested': True}, 'fresh')
    assert len(gate.prompts) == 1
    assert gate.explicit({**effect, 'task_type': 'desktop:dingtalk:send_message'})['allowed'] is True
    assert len(gate.prompts) == 2


@pytest.mark.parametrize('error', [ConnectionError('private detail'), RuntimeError('private detail')])
def test_unavailable_gateway_blocks_hook_and_explicit_tool(gate, error):
    gate.provider._request.side_effect = error
    assert 'error' in gate.hook({'target': 'email:li@example.com', 'message': 'hi'})
    result = gate.explicit({'kind': 'send', 'recipient': 'email:li@example.com', 'task_type': 'mail', 'requested': True})
    assert result['allowed'] is False and 'private detail' not in result['reason']
    assert gate.prompts == []


def test_unsolicited_sends_always_ask_and_denial_cannot_record(gate, monkeypatch):
    args = {'target': 'telegram:12345678', 'message': 'hi', 'requested': False}
    gate.hook(args)
    gate.hook(args, call='call-two')
    assert len(gate.prompts) == 2
    from tools import approval_gateway_wait
    for answer in ({'resolved': True, 'choice': 'session'}, {'resolved': True, 'choice': 'always'}, {'resolved': False}, {'resolved': True, 'choice': 'deny'}):
        monkeypatch.setattr(approval_gateway_wait, '_await_gateway_decision', lambda *a: answer)
        assert 'error' in gate.hook(args, call='call-denied')
    assert len(gate.records) == 2


def test_unverified_source_cannot_reuse_owner_consent(gate):
    args = {'target': 'email:li@example.com', 'message': 'hi', 'requested': True}
    gate.hook(args)
    gate.owner = False
    assert 'error' in gate.hook(args, 'guest-session')
    assert len(gate.prompts) == 1


def test_listing_and_unrelated_tools_have_no_effect(gate):
    assert gate.hook({'action': 'list'}) == {'args': {'action': 'list'}}
    assert gate.invoke('web_search', {}) == {'args': {}}
    assert gate.calls == []


def test_native_dispatch_does_not_reach_sender_after_block(gate, monkeypatch):
    import model_tools
    sender = Mock(return_value=json.dumps({'sent': True}))
    monkeypatch.setattr(model_tools.registry, 'dispatch', sender)
    def invoke(args):
        return json.loads(model_tools.handle_function_call('send_message', args, session_id='session',
                          skip_tool_request_middleware=True))
    assert invoke({'target': 'email:li@example.com', 'message': 'hi', 'requested': True})['sent'] is True
    sender.assert_called_once()
    sender.reset_mock()
    gate.provider._request.side_effect = ConnectionError('unavailable')
    result = invoke({'target': 'email:li@example.com', 'message': 'hi', 'requested': True})
    assert 'EFFECT_CONSENT_UNAVAILABLE' in str(result)
    sender.assert_not_called()


def test_gated_send_result_carries_the_server_approval_record(gate, monkeypatch):
    import model_tools
    monkeypatch.setattr(model_tools.registry, 'dispatch', Mock(return_value=json.dumps({'sent': True})))
    def invoke(args, call):
        return json.loads(model_tools.handle_function_call('send_message', args, session_id='session', tool_call_id=call,
                          skip_tool_request_middleware=True))
    args = {'target': 'email:li@example.com', 'message': 'hi', 'requested': True}
    first = invoke(args, 'call-first')
    # The card's own request id names the native decision the server recorded.
    assert gate.calls[-1]['approval_request_id'] == gate.prompts[0]['request_id']
    assert first == {'sent': True, 'approval': {'confirmation_id': 'native:' + gate.prompts[0]['request_id'], 'choice': 'once',
        'confirmed_by': 'owner', 'surface': {'device_id': 'owner-phone', 'device_type': 'phone'},
        'confirmed_at': '2026-10-21T00:00:00.000Z',
                                                'decided_by': 'owner', 'decided_at': '2026-10-21T00:00:00.000Z', 'reused': False}}
    again = invoke({**args, 'message': 'second'}, 'call-again')
    assert len(gate.prompts) == 1 and again['approval'] == {**first['approval'], 'reused': True}
    explicit = gate.explicit({'kind': 'send', 'recipient': 'email:li@example.com', 'task_type': 'send_message:email:send', 'requested': True})
    assert explicit == {'allowed': True, 'approval': {**first['approval'], 'reused': True}}


@pytest.mark.parametrize('approved', [False, True])
@pytest.mark.parametrize('explicit', [False, True])
def test_server_effect_rejection_keeps_typed_error(gate, approved, explicit):
    error = HTTPError('http://127.0.0.1', 403, 'private detail', {},
                      BytesIO(b'{"error_code":"OWNER_REQUEST_REQUIRED","detail":"private detail"}'))
    request = gate.provider._request.side_effect
    def reject(path, body):
        if bool(body.get('approved')) == approved:
            raise error
        return request(path, body)
    gate.provider._request.side_effect = reject
    if explicit:
        result = gate.explicit({'kind': 'send', 'recipient': 'email:li@example.com', 'task_type': 'mail', 'requested': True})
        assert result == {'allowed': False, 'reason': 'OWNER_REQUEST_REQUIRED'}
    else:
        result = gate.hook({'target': 'email:li@example.com', 'message': 'hi', 'requested': True})
        assert result == {'error_code': 'OWNER_REQUEST_REQUIRED', 'http_status': 403, 'error': 'OWNER_REQUEST_REQUIRED'}
    assert len(gate.prompts) == int(approved)


def test_internal_effect_failure_is_not_transport_unavailable(gate):
    gate.provider._request.side_effect = RuntimeError('private detail')
    assert gate.hook({'target': 'email:li@example.com', 'message': 'hi'})['error'] == 'EFFECT_CONSENT_FAILED: RuntimeError'


@pytest.mark.parametrize('error', [ConnectionResetError('private detail'), IncompleteRead(b'partial')])
def test_unreadable_http_refusal_body_still_blocks(gate, error):
    class BrokenBody(BytesIO):
        def read(self, *args):
            raise error
    gate.provider._request.side_effect = HTTPError('http://127.0.0.1', 403, 'private detail', {}, BrokenBody())
    result = effects.check_effect(gate.provider, 'phone_task', {'effect': {
        'kind': 'read', 'task_type': 'lookup', 'requested': True}}, 'session-one', 'call-one')
    assert result == {'action': 'block', 'error_code': 'internal_http_error',
                      'http_status': 403, 'message': 'internal_http_error'}
    assert gate.prompts == []


def test_resolved_answer_without_authoritative_actor_never_creates_consent(gate, monkeypatch):
    from tools import approval_gateway_wait
    monkeypatch.setattr(approval_gateway_wait, '_await_gateway_decision',
                        lambda *args: {'resolved': True, 'choice': 'once'})
    result = gate.explicit({'kind': 'send', 'recipient': 'email:li@example.com',
                            'task_type': 'mail', 'requested': True})
    assert result == {'allowed': False, 'reason': 'EFFECT_CONFIRMATION_RECEIPT_REQUIRED'}
    assert gate.records == {} and not any(call.get('approved') for call in gate.calls)
