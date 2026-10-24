"""Stopped-profile cutoff cleanup through Hermes' native SQLite and deletion owners."""
import fcntl
import glob
import json
import math
import sqlite3
import shutil
import tempfile
import sys
from datetime import datetime
from contextlib import ExitStack, closing, contextmanager
from pathlib import Path


@contextmanager
def _snapshot(path):
    # SQLite mode=ro can create WAL sidecars. Read only a disposable offline copy.
    with tempfile.TemporaryDirectory(prefix='paios-reset-preview-') as directory:
        copy = Path(directory) / path.name
        shutil.copyfile(path, copy)
        wal = path.with_name(path.name + '-wal')
        if wal.exists():
            shutil.copyfile(wal, copy.with_name(copy.name + '-wal'))
        with closing(sqlite3.connect(copy.as_uri() + '?mode=ro', uri=True)) as conn:
            conn.row_factory = sqlite3.Row
            yield conn


def _read(path, query):
    with _snapshot(path) as conn:
        return [dict(row) for row in conn.execute(query)]


def reset_conversations(home, cutoff, execute=False, *, _include_reference_targets=False):
    """Read-only preview or stopped-profile reset; cutoff is exclusive UTC epoch seconds."""
    home = Path(home)
    if not home.is_absolute() or not home.is_dir() or home.is_symlink():
        raise ValueError('existing_absolute_hermes_home_required')
    home = home.resolve()
    if isinstance(cutoff, bool) or not isinstance(cutoff, (int, float)) or not math.isfinite(cutoff):
        raise ValueError('finite_epoch_seconds_cutoff_required')
    with ExitStack() as stack:
        if execute:
            owner = stack.enter_context((home / '.paios-vision.lock').open('a'))
            try:
                fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError('stop_and_drain_managed_hermes_before_reset') from exc
        report, plan = _plan(home, cutoff)
        if _include_reference_targets is True and not execute:
            report['_reference_targets'] = plan[-1]
        if execute and report['blockers']:
            return {**report, 'status': 'blocked'}
        if execute:
            _execute(home, cutoff, plan)
        return {**report, 'status': 'executed' if execute else 'preview'}


def _plan(home, cutoff):
    from hermes_state_sessions import _collect_delegate_child_ids
    from gateway.platforms.api_server_run_idempotency import TERMINAL_STATUSES
    blockers, sessions, messages = [], [], []
    state = home / 'state.db'
    for name in ('state.db', 'response_store.db', 'runs_idempotency.db', 'sessions'):
        if (home / name).is_symlink():
            raise ValueError('symlinked_hermes_store')
    if state.exists():
        sessions = _read(state, 'SELECT * FROM sessions')
        messages = _read(state, 'SELECT * FROM messages')
    old = [m for m in messages if m['timestamp'] < cutoff]
    recent = {m['session_id'] for m in messages if m['timestamp'] >= cutoff}
    eligible = {s['id'] for s in sessions if s['started_at'] < cutoff and s['id'] not in recent
                and (s['ended_at'] is None or s['ended_at'] < cutoff)
                and (s.get('last_activity_at') is None or s['last_activity_at'] < cutoff)}
    selections = {}
    if sessions:
        with _snapshot(state) as conn:
            for sid in sorted(eligible):
                targets = [sid, *_collect_delegate_child_ids(conn, [sid])]
                if set(targets) <= eligible:
                    selections[sid] = targets
    deleted = set().union(*(set(ids) for ids in selections.values())) if selections else set()
    affected = deleted | {m['session_id'] for m in old}
    known = {s['id'] for s in sessions}
    for path in (home / 'sessions').glob('*'):
        if path.suffix in ('.json', '.jsonl') and path.stem not in known and not any(
                path.name.startswith(f'request_dump_{sid}_') for sid in known):
            affected.add(path.stem)  # Orphan mirrors still need timestamp-based cleanup.
    files, removed_bytes = {}, 0
    for sid in affected:
        if Path(sid).name != sid or sid in ('.', '..'):
            blockers.append('unsafe_session_file_identifier')
            continue
        directory = home / 'sessions'
        paths = [directory / f'{sid}{suffix}' for suffix in ('.json', '.jsonl')]
        paths += list(directory.glob(f'request_dump_{glob.escape(sid)}_*.json'))
        for path in paths:
            if path.is_symlink():
                blockers.append('symlinked_session_mirror')
            elif path.is_file():
                raw = path.read_bytes()
                if sid in deleted:
                    files[path] = None
                    removed_bytes += len(raw)
                elif path.suffix == '.jsonl':
                    try:
                        lines = [(line, json.loads(line)) for line in raw.splitlines(keepends=True) if line.strip()]
                        if any(not isinstance(m, dict) or not isinstance(m.get('timestamp'), (int, float))
                               for _, m in lines):
                            raise ValueError()
                        kept = b''.join(line for line, m in lines if m['timestamp'] >= cutoff)
                        files[path] = kept
                        removed_bytes += len(raw) - len(kept)
                    except (ValueError, TypeError):
                        blockers.append('undated_session_mirror')
                else:
                    blockers.append('mixed_session_json_mirror')
    responses = _read(home / 'response_store.db', 'SELECT response_id,data FROM responses') if (home / 'response_store.db').exists() else []
    response_ids = []
    for row in responses:
        data = json.loads(row['data'])
        stamp = data.get('created_at')
        if not isinstance(stamp, (int, float)):
            blockers.append('undated_response_cache')
        elif stamp < cutoff:
            response_ids.append(row['response_id'])
    runs = _read(home / 'runs_idempotency.db', 'SELECT * FROM run_idempotency') if (home / 'runs_idempotency.db').exists() else []
    run_sessions, scrub = set(), []
    for row in runs:
        status = json.loads(row['status_json'])
        ids = {status.get('session_id'), status.get('conversation_session_id')} - {None}
        if ids & affected and status.get('error') != 'NATIVE_HISTORY_DELETED':
            if row['updated_at'] >= cutoff or status.get('status') not in TERMINAL_STATUSES:
                blockers.append('mixed_or_active_native_run')
            else:
                scrub.append(row)
                run_sessions.update(ids)
    # Native session scrub operates on every matching run. Never include a newer replay.
    for row in runs:
        status = json.loads(row['status_json'])
        if run_sessions.intersection((status.get('session_id'), status.get('conversation_session_id'))) and row not in scrub:
            if status.get('error') != 'NATIVE_HISTORY_DELETED':
                blockers.append('mixed_or_active_native_run')
    payload = lambda rows: sum(len(v.encode()) if isinstance(v, str) else len(v) if isinstance(v, bytes) else 0
                               for row in rows for v in row.values())
    mirrors = [p for p in (home / 'sessions').iterdir() if p.is_file() and not p.is_symlink()] if (home / 'sessions').is_dir() else []
    def counts(rows, selected):
        selected_ids = {id(row) for row in selected}
        kept = [r for r in rows if id(r) not in selected_ids]
        return {'delete': len(selected), 'keep': len(kept), 'delete_bytes': payload(selected), 'keep_bytes': payload(kept)}
    result = {'sessions': counts(sessions, [s for s in sessions if s['id'] in deleted]),
              'messages': counts(messages, old),
              'response_cache': counts(responses, [r for r in responses if r['response_id'] in response_ids]),
              'run_replays': {**counts(runs, scrub), 'scrub': len(scrub)},
              'transcripts': {'change': len(files), 'delete': sum(v is None for v in files.values()),
                              'keep': len(mirrors) - sum(v is None for v in files.values()), 'delete_bytes': removed_bytes,
                              'keep_bytes': sum(p.stat().st_size for p in mirrors) - removed_bytes},
              'blockers': sorted(set(blockers))}
    references = {'native_session_ids': sorted(deleted), 'native_message_ids': [str(m['id']) for m in old]}
    return result, (selections, files, response_ids, run_sessions, references)


def _execute(home, cutoff, plan):
    from hermes_state import SessionDB
    from gateway.platforms.api_server import ResponseStore
    from gateway.platforms.api_server_run_idempotency import RunIdempotencyStore
    selections, files, response_ids, run_sessions, _references = plan
    with ExitStack() as stack:
        db = SessionDB(home / 'state.db') if (home / 'state.db').exists() else None
        if db:
            stack.callback(db.close)
        responses = ResponseStore(db_path=str(home / 'response_store.db')) if response_ids else None
        if responses:
            stack.callback(responses.close)
            if not responses.durable:
                raise RuntimeError('native_response_store_unavailable')
        runs = RunIdempotencyStore(db_path=str(home / 'runs_idempotency.db')) if run_sessions else None
        if runs:
            stack.callback(runs.close)
            if not runs.durable:
                raise RuntimeError('native_run_store_unavailable')
            snapshot = runs.session_delete_snapshot(run_sessions)
            runs.purge_sessions(run_sessions, expected_snapshot=snapshot)
        if responses:
            for rid in response_ids:
                responses.delete(rid)
        if db:
            for sid, targets in sorted(selections.items(), key=lambda item: -len(item[1])):
                if db.get_session(sid) is not None and not db.delete_session(sid, sessions_dir=home / 'sessions', expected_delete_ids=targets):
                    raise RuntimeError('native_session_delete_conflict')
            def prune(conn):
                affected = [r[0] for r in conn.execute('SELECT DISTINCT session_id FROM messages WHERE timestamp < ?', (cutoff,))]
                conn.execute('DELETE FROM messages WHERE timestamp < ?', (cutoff,))
                for sid in affected:
                    remaining = list(conn.execute('SELECT tool_calls FROM messages WHERE session_id=? AND active=1', (sid,)))
                    tools = sum(len(json.loads(r[0])) for r in remaining if r[0])
                    conn.execute('UPDATE sessions SET message_count=?, tool_call_count=? WHERE id=?', (len(remaining), tools, sid))
            db._execute_write(prune)
        for path, kept in files.items():
            if kept is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(kept)
        if (home / 'state.db').exists() and _read(home / 'state.db', f'SELECT id FROM messages WHERE timestamp < {float(cutoff)!r}'):
            raise RuntimeError('native_reset_verification_failed')


if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
        cutoff = datetime.fromisoformat(request['cutoff'].replace('Z', '+00:00'))
        if cutoff.tzinfo is None or request['action'] not in ('preview', 'execute'):
            raise ValueError('invalid_reset_request')
        result = reset_conversations(request['hermes_home'], cutoff.timestamp(), request['action'] == 'execute',
                                     _include_reference_targets=request.get('include_reference_targets', False))
        print(json.dumps(result))
        raise SystemExit(1 if result['status'] == 'blocked' else 0)
    except Exception:
        print(json.dumps({'status': 'failed', 'code': 'HERMES_RESET_FAILED'}))
        raise SystemExit(1)
