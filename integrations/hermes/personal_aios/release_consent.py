"""Owner identity and native confirmation for a single immutable release candidate."""
import json
import re
from datetime import datetime, timezone


def decision_receipt(saved, reused):
    """Project the saved owner decision and this call's return lifecycle."""
    return {'confirmed_by': saved['principal_id'], 'surface': None, 'confirmation_id': None,
            'confirmed_at': datetime.fromtimestamp(saved['decided_at'], timezone.utc).isoformat(), **saved,
            'confirmation_evidence': saved.get('confirmation_evidence', {
                'actor_type': 'authenticated_owner_principal', 'physical_actor': 'unknown', 'card_rendering': 'unknown'}),
            'decision_status': 'resolved', 'decision': 'approved' if saved['approved'] else 'denied',
            'decision_source': saved.get('decision_source', 'release_decision_record'), 'reused': reused,
            'lifecycle': 'saved_decision_replay' if reused else 'waited_for_owner_decision'}


def release_decide(spool, request_id, provider, session_id):
    """A native owner prompt is the only producer of baseline-change decisions."""
    from gateway.run_scope import current_scope
    from gateway.session_context import get_api_run_id
    from tools.approval_context import get_current_session_key, _approval_tool_call_id
    from tools.approval import _gateway_notify_cb
    from tools.approval_gateway_wait import _await_gateway_decision
    from utils import atomic_json_write
    if current_scope() != 'owner' or spool is None or not re.fullmatch(r'[0-9a-f]{12}', request_id):
        raise ValueError('Release confirmation requires the owner session and request id')
    from .release_status import read_status
    status = read_status(spool, request_id)
    context = {'run_id': get_api_run_id(session_id), 'session_id': session_id,
               'tool_call_id': _approval_tool_call_id.get()}
    if provider is None or not all(context.values()):
        raise ValueError('RELEASE_OWNER_CONTEXT_REQUIRED')
    owner = provider._request('/internal/hermes/schedule-context', {'context': context})
    if owner.get('allow_owner_mutation') is not True or owner['principal_id'] != status['origin']['principal_id']:
        raise ValueError('RELEASE_OWNER_MISMATCH')
    if status.get('state') != 'awaiting_owner':
        raise ValueError('Release is not awaiting owner confirmation')
    binding = {'request_id': request_id, 'base': status['base'], 'commit': status['commit']}
    path = spool / 'decisions' / (request_id + '.json')
    if path.exists():
        saved = json.loads(path.read_text())
        if all(saved[key] == value for key, value in binding.items()):
            return decision_receipt(saved, True)
        path.rename(path.with_name(request_id + '-' + saved['commit'] + '.json'))
    session_key = get_current_session_key()
    notify = _gateway_notify_cb(session_key)
    if notify is None:
        return {'request_id': request_id, 'state': 'awaiting_owner'}
    answer = _await_gateway_decision(session_key, notify, {
        'command': '确认产品修复 ' + request_id,
        'description': '这次修复涉及主人基线。是否同意此候选通过原测试、预发和空闲发布流程？\n' +
                       '\n'.join(status['protected_paths']),
        'pattern_key': 'paios_release:' + json.dumps(binding, sort_keys=True),
        'allow_permanent': False, 'allow_session': False})
    if not answer.get('resolved') or answer.get('choice') not in {'once', 'deny'} or answer.get('cancelled'):
        return {'request_id': request_id, 'state': 'awaiting_owner'}
    confirmation = answer.get('confirmation')
    if not confirmation:
        raise ValueError('RELEASE_CONFIRMATION_RECEIPT_REQUIRED')
    if confirmation['confirmed_by'] != owner['principal_id']:
        raise ValueError('RELEASE_OWNER_MISMATCH')
    decision = decision_receipt({**binding, **confirmation, 'approved': answer['choice'] == 'once',
                'choice': answer['choice'], 'reason': answer.get('reason'),
                'decision_source': 'native_owner_confirmation',
                'decided_at': datetime.fromisoformat(confirmation['confirmed_at'].replace('Z', '+00:00')).timestamp(),
                'principal_id': confirmation['confirmed_by']}, False)
    atomic_json_write(path, decision)
    return decision
