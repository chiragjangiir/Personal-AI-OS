"""Project source request results into the existing production release receipts."""
import json


def project_result(receipt, result):
    """A closed source request wins; an accepted package keeps production's later progress."""
    if not result:
        return receipt
    closed = result.get('finished_at') and not result.get('ready_for_production')
    pending = receipt and receipt.get('state') in ('queued', 'awaiting_owner', 'approved', 'stale_base', 'rebuilding')
    completed_pending = pending and result.get('finished_at')
    approval_required = receipt and receipt.get('state') == 'queued' and result.get('state') == 'awaiting_owner'
    if closed or not receipt or completed_pending or approval_required:
        return {**(receipt or {}), **result}
    return receipt


def read_status(spool, request_id):
    """Read the same published result even when an older per-ID receipt remains on disk."""
    folder = spool / 'status'
    path = folder / (request_id + '.json')
    receipt = json.loads(path.read_text()) if path.exists() else None
    runtime = folder / 'runtime.json'
    inventory = json.loads(runtime.read_text()).get('builder_requests') if runtime.exists() else None
    result = next((row for row in inventory or [] if row['request_id'] == request_id), None)
    return project_result(receipt, result)
