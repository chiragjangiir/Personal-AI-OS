"""Native messaging outcomes, without treating transport failure as proof of non-delivery."""
import json

from capability.sdk.python.yimi_receipt import effect, receipt, unknown_fact


def mapped(raw, args):
    if isinstance(raw, str):
        raw = json.loads(raw)
    action = args.get('action', 'send')
    if action == 'list':
        if 'targets' in raw:
            return receipt('succeeded', content=[{'key': 'targets', 'text': str(raw['targets']), 'provenance': 'observed'}])
        return receipt('failed', status={'reason_code': 'DIRECTORY_UNAVAILABLE'})
    target = args['target']
    if raw.get('skipped'):
        return receipt('cancelled', status={'reason_code': 'DUPLICATE_DELIVERY_SKIPPED'})
    if raw.get('success') is True or raw.get('partial_success') is True:
        state = 'partial' if raw.get('partial_success') or raw.get('media_dropped') else 'succeeded'
        result = receipt(state, effects=[effect('send', target, action, 'service_ack',
            'native messaging transport acknowledged', str(raw['message_id']) if raw.get('message_id') else None)],
            unknowns=[unknown_fact('recipient_read', 'The transport does not attest that the recipient read the message.')])
        if raw.get('media_dropped'):
            result['unknowns'].append(unknown_fact('attachments', 'Some requested attachments were not delivered.'))
        return result
    return uncertain(target)


def uncertain(target, code='DELIVERY_OUTCOME_UNKNOWN'):
    return receipt('unknown', status={'reason_code': code},
        unknowns=[unknown_fact(target, 'No authoritative delivery acknowledgement is available.')],
        next={'retry': 'after_check', 'check_with': 'message_status', 'waiting_on': 'none'})
