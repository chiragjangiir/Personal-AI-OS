"""Offline, explicitly scoped native projection cleanup; never a second L3 writer."""
import argparse
import fcntl
import json
from pathlib import Path


def forget_native(home, scope):
    """Run after the managed Hermes runtime has drained and stopped.

    Scope contains exact native session IDs and whole L2 entries. Optional
    response_cache_scope=all authorizes clearing the entire derived response cache
    to cover legacy cross-session copies. Backups, L3/L5 and provider caches remain residual.
    """
    home = Path(home)
    if not home.is_absolute():
        raise ValueError('isolated_existing_profile_required')
    home = home.resolve()
    if not home.is_dir() or home == (Path.home() / '.hermes').resolve():
        raise ValueError('isolated_existing_profile_required')
    required = {'authorization_ref', 'retention_rule', 'l3_receipt_ref', 'session_ids', 'l2_entries'}
    if not isinstance(scope, dict) or set(scope) not in (required, required | {'response_cache_scope'}):
        raise ValueError('explicit_forget_scope_required')
    if any(not isinstance(scope[key], str) or not scope[key].strip()
           for key in ('authorization_ref', 'retention_rule', 'l3_receipt_ref')):
        raise ValueError('authorization_retention_and_l3_receipt_required')
    sessions, entries = scope['session_ids'], scope['l2_entries']
    if (not isinstance(sessions, list) or len(sessions) > 100 or
            any(not isinstance(s, str) or not s or len(s) > 256 for s in sessions) or
            len(set(sessions)) != len(sessions) or not isinstance(entries, list) or len(entries) > 100):
        raise ValueError('invalid_native_forget_scope')
    if any(not isinstance(e, dict) or set(e) != {'target', 'entry'} or
           e['target'] not in ('memory', 'user') or not isinstance(e['entry'], str) or
           not e['entry'].strip() for e in entries):
        raise ValueError('exact_l2_entries_required')
    if not sessions and not entries:
        raise ValueError('empty_native_forget_scope')
    if len({(e['target'], e['entry']) for e in entries}) != len(entries):
        raise ValueError('duplicate_l2_scope')
    if sessions and not (home / 'state.db').is_file():
        raise ValueError('native_history_unavailable')
    if scope.get('response_cache_scope', 'selected_sessions') not in ('selected_sessions', 'all'):
        raise ValueError('invalid_response_cache_scope')
    # This is the same lifetime lock held by run_api. Never interrupt/delete from
    # inside the affected agent: its frozen L1/L2 could write the old bytes again.
    with (home / '.paios-vision.lock').open('a') as owner:
        try:
            fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError('stop_and_drain_managed_hermes_before_forget') from exc
        return _purge_stopped_profile(home, scope)


def _purge_stopped_profile(home, scope):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from hermes_state import SessionDB
    from tools.memory_tool import MemoryStore
    from gateway.session_context import set_session_vars, clear_session_vars
    override = set_hermes_home_override(home)
    tokens = set_session_vars(platform='api_server', session_id='native-forget-admin',
                              session_key='native-forget-admin')
    db, response_store, run_store = None, None, None
    receipt = {'status': 'partial', 'authorization_ref': scope['authorization_ref'],
        'retention_rule': scope['retention_rule'], 'l3_receipt_ref': scope['l3_receipt_ref'],
        'managed_runtime_stopped': True, 'deleted_session_ids': [], 'removed_l2_entries': [],
        'deleted_response_ids': [], 'scrubbed_run_ids': [],
        'response_cache_scope': scope.get('response_cache_scope', 'selected_sessions'),
        'clean_context_required': True, 'strict_forget_complete': False,
        'residual_owners': ['L3/L5 verification',
                            'backups and exports', 'provider caches', 'SQLite physical remnants',
                            'unscoped sessions and L2 entries', 'unmanaged native processes and workers']}
    if receipt['response_cache_scope'] != 'all':
        receipt['residual_owners'].append('unattributed response chains')
    try:
        store = MemoryStore()
        store.load_from_disk()
        # Validate the full explicit selection before the first mutation. No
        # substring matching, inferred sessions, or keyword-based content erasure.
        for item in scope['l2_entries']:
            values = store.memory_entries if item['target'] == 'memory' else store.user_entries
            if item['entry'] not in values:
                raise ValueError('l2_entry_scope_stale')
        db = SessionDB(home / 'state.db')
        selections = {}
        for sid in scope['session_ids']:
            if db.get_session(sid) is not None:
                selections[sid] = db.get_session_delete_targets(sid)
        selected_sessions = sorted(set(scope['session_ids']).union(*(set(ids) for ids in selections.values())))
        response_snapshot = run_snapshot = None
        if (home / 'response_store.db').is_file():
            from gateway.platforms.api_server import ResponseStore
            response_store = ResponseStore(db_path=str(home / 'response_store.db'))
            if not response_store.durable:
                raise RuntimeError('native_response_store_unavailable')
            response_snapshot = response_store.session_delete_snapshot(selected_sessions,
                include_unattributed=receipt['response_cache_scope'] == 'all')
        if (home / 'runs_idempotency.db').is_file():
            from gateway.platforms.api_server_run_idempotency import RunIdempotencyStore
            run_store = RunIdempotencyStore(db_path=str(home / 'runs_idempotency.db'))
            if not run_store.durable:
                raise RuntimeError('native_run_store_unavailable')
            run_snapshot = run_store.session_delete_snapshot(selected_sessions)
        if run_store is not None:
            receipt['scrubbed_run_ids'] = run_store.purge_sessions(selected_sessions, expected_snapshot=run_snapshot)
        if response_store is not None:
            receipt['deleted_response_ids'] = response_store.delete_sessions(selected_sessions,
                expected_snapshot=response_snapshot, include_unattributed=receipt['response_cache_scope'] == 'all')
        for sid, selected in selections.items():
            # A selected delegate can already have disappeared with its parent.
            if db.get_session(sid) is None:
                continue
            if not db.delete_session(sid, sessions_dir=home / 'sessions', expected_delete_ids=selected):
                raise RuntimeError('native_session_delete_conflict')
            receipt['deleted_session_ids'].extend(selected)
        for index, item in enumerate(scope['l2_entries']):
            result = store.remove(item['target'], item['entry'], matched_entry=item['entry'])
            if not result.get('success'):
                raise RuntimeError('native_l2_remove_failed')
            receipt['removed_l2_entries'].append({'scope_index': index, 'target': item['target']})
        fresh = MemoryStore()
        fresh.load_from_disk()
        if (any(db.get_session(s) is not None for s in receipt['deleted_session_ids']) or
                any(e['entry'] in (fresh.memory_entries if e['target'] == 'memory' else fresh.user_entries)
                    for e in scope['l2_entries'])):
            raise RuntimeError('native_forget_verification_failed')
        receipt['fresh_l2_snapshot_verified'] = True
        receipt['deleted_session_ids'] = sorted(set(receipt['deleted_session_ids']))
        return receipt
    except Exception as exc:
        # Mutations span native SQLite and L2 files; preserve partial progress.
        receipt.update(error_code=str(exc), status='failed')
        return receipt
    finally:
        if response_store is not None:
            response_store.close()
        if run_store is not None:
            run_store.close()
        if db is not None:
            db.close()
        clear_session_vars(tokens)
        reset_hermes_home_override(override)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', required=True)
    parser.add_argument('--scope', required=True, help='Authorized JSON scope file; not model arguments')
    args = parser.parse_args()
    result = forget_native(args.home, json.loads(Path(args.scope).read_text()))
    print(json.dumps(result, ensure_ascii=False))
    return 1 if result['status'] == 'failed' else 0


if __name__ == '__main__':
    raise SystemExit(main())
