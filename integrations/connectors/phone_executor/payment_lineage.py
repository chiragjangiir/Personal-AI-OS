"""Executor-owned unresolved payment lineage, carried only by existing job spool records.

Queued jobs capture privacy provenance but do not supersede the phone's current order.
A payment that starts on the phone supersedes the old owner. Unknown outcomes survive
restart/delivery. Scoped paid/unpaid reconciliation or leaving the page clears ownership.
There is no timer and no separate payment ledger.
"""
import json
from pathlib import Path
from errand_status import TERMINAL_STATES, _terminal_record


def started(record):
    # A present null is the current producer's explicit pre-handoff marker.
    # Legacy terminal/running spools have no outcome contract: retain unknown,
    # except a durable waiting marker which proves no phone handoff occurred.
    if 'phone_started_at' in record:
        return bool(record['phone_started_at'])
    return record.get('state') != 'waiting' and bool(record.get('started_at') or record.get('finished_at'))


_SPOOL_STATES = tuple(TERMINAL_STATES[key] for key in
                      ('quarantined', 'delivered', 'delivery_failed', 'notified', 'pending')) + ('running',)


def _read_record(path):
    quarantined = path.name.endswith('.' + TERMINAL_STATES['quarantined'] + '.json')
    try:
        record = json.loads(path.read_text())
    except json.JSONDecodeError:
        if quarantined:
            return None
        raise
    if quarantined:
        # Only validated delivery failures retain executor facts after quarantine.
        # Malformed quarantines cannot establish or clear payment ownership.
        if not isinstance(record, dict) or not isinstance(record.get('delivery_failure'), dict):
            return None
        _, verified_record, verified = _terminal_record(path.parent, path.name.split('.')[0], 0, recent_only=False)
        if not verified or verified_record != record:
            raise ValueError('ERRAND_TERMINAL_UNREADABLE')
    return record


def _read_spool_job(path):
    """GW may rename a terminal record while this snapshot is being read."""
    try:
        return _read_record(path)
    except FileNotFoundError as missing:
        vanished = missing
    job_id = path.name.split('.')[0]
    eligible = _SPOOL_STATES[:_SPOOL_STATES.index(path.suffixes[-2][1:]) + 1]
    # Re-list the same job after each lost open. Two normal GW transitions can
    # race this reader; a bounded third pass also covers the running→done handoff.
    for _ in range(3):
        listed = {p.name: p for p in path.parent.glob(job_id + '.*.json')}
        for state in eligible:
            candidate = listed.get(f'{job_id}.{state}.json')
            if candidate is None:
                continue
            try:
                return _read_record(candidate)
            except FileNotFoundError as missing:
                vanished = missing
                break  # Re-list after a newer state moves; do not fall back to a stale running marker.
    raise vanished  # A lost owner/clear record must never become an ordinary continuation.


def unresolved(folder, principal_id, app):
    if not principal_id:
        raise ValueError("ERRAND_PRINCIPAL_REQUIRED")
    if not folder:
        return None
    records = {}
    for path in Path(folder).glob('job-*.json'):
        if path.suffixes[-2:] not in [['.' + state, '.json'] for state in _SPOOL_STATES]:
            continue
        record = _read_spool_job(path)
        if record is None:
            continue
        if record.get('principal_id') != principal_id or record.get('app') != app:
            continue
        jid = record['job_id']
        if jid not in records or record.get('finished_at'):
            records[jid] = record
    owner = None
    for record in sorted(records.values(), key=lambda r: (r.get('phone_started_at') or r.get('started_at') or r.get('finished_at', ''), r['job_id'])):
        if record.get('payment_page_left'):
            owner = None
        if record.get('payment_intent') and started(record):
            owner = ({'principal_id': principal_id, 'app': app, 'of_job': record['job_id'], 'intent_id': record['payment_intent'],
                      'binding': record.get('payment_binding')} if record.get('payment_outcome', 'unknown') == 'unknown' else None)
        rec = record.get('payment_reconciliation')
        if owner and rec and rec['of_job'] == owner['of_job'] and rec['intent_id'] == owner['intent_id'] and rec['state'] in ('paid', 'unpaid'):
            owner = None
    return owner


def capture(folder, task):
    return unresolved(folder, task["principal_id"], task.get("app")) if not task.get('payment_intent') and task.get('goal', task.get('task', '')).startswith('从当前页面继续') else None


def terminal(record, result):
    """Project exact public provenance even when cancellation prevented any screen read."""
    owner = record.get('payment_owner')
    lineage = {}
    if owner:
        if (owner['principal_id'], owner['app']) != (record['principal_id'], record.get('app')):
            raise ValueError('PAYMENT_LINEAGE_SCOPE')
        observation = result.get('payment_observation', {})
        state = observation.get('state', 'unknown')
        lineage['payment_reconciliation'] = {'of_job': owner['of_job'], 'intent_id': owner['intent_id'],
            'state': state if state in ('paid', 'unpaid') else 'unknown'}
    for key in ('payment_outcome', 'payment_binding'):
        if key in result:
            lineage[key] = result[key]
    if record.get('payment_intent') and 'payment_outcome' not in lineage:
        lineage['payment_outcome'] = 'unknown' if started(record) else 'unpaid'
    return lineage


def remember(bound):
    """Internal recovery snapshot; authority/public wire intentionally omits these facts."""
    return {**bound.wire(), 'item_facts': [list(pair) for pair in bound.item_facts]}


def binding(owner):
    from payment_checkpoint import PaymentBinding
    value = owner.get('binding') if owner else None
    if not value:
        return None
    return PaymentBinding(value['order_id'], value['payee'], value['amount_fen'], value['order_namespace'],
                          tuple(tuple(p) for p in value['item_identity']),
                          tuple(tuple(p) for p in value.get('item_facts', ())))
