"""Cutoff reset acceptance through real native readers on synthetic offline profiles."""
import fcntl
import importlib.util
import json
import os
import subprocess
import sys
import sqlite3
from pathlib import Path

import pytest
from hermes_state import SessionDB
from gateway.platforms.api_server import ResponseStore
from gateway.platforms.api_server_run_idempotency import RunIdempotencyStore

SOURCE = Path(__file__).parents[2] / 'integrations/hermes/personal_aios/conversation_reset.py'
spec = importlib.util.spec_from_file_location('isolated_conversation_reset', SOURCE)
reset = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reset)
CUTOFF = 2000


@pytest.fixture
def profile(tmp_path):
    db = SessionDB(tmp_path / 'state.db')
    for sid in ('old', 'mixed', 'new', 'ancestor', 'delegate'):
        db.create_session(sid, 'api_server')
        db.append_message(sid, 'user', sid + '_old_marker')
    db.append_message('mixed', 'assistant', 'mixed_new_marker')
    db._execute_write(lambda c: c.execute('UPDATE messages SET timestamp=1000'))
    db._execute_write(lambda c: c.execute('UPDATE messages SET timestamp=2000 WHERE content IN (?,?)',
                                        ('mixed_new_marker', 'new_old_marker')))
    db._execute_write(lambda c: c.execute('UPDATE sessions SET started_at=1000,last_activity_at=1000'))
    db._execute_write(lambda c: c.execute('UPDATE sessions SET parent_session_id=?,model_config=? WHERE id=?',
                                        ('ancestor', json.dumps({'_delegate_from': 'ancestor'}), 'delegate')))
    db._execute_write(lambda c: c.execute("UPDATE messages SET timestamp=2000 WHERE session_id='delegate'"))
    db.close()
    (tmp_path / 'sessions').mkdir()
    (tmp_path / 'sessions/old.jsonl').write_text('{"content":"old mirror"}\n')
    mixed = b'{"content":"old","timestamp":1000}\n{ "content":"retained", "timestamp":2000 }\n'
    (tmp_path / 'sessions/mixed.jsonl').write_bytes(mixed)
    for file in ('memories/MEMORY.md', 'memories/USER.md', 'config.yaml', 'cron/jobs.json', '.env'):
        path = tmp_path / file
        path.parent.mkdir(exist_ok=True)
        path.write_text('protected synthetic bytes\n')
    responses = ResponseStore(db_path=str(tmp_path / 'response_store.db'))
    responses.put('old-response', {'created_at': 1000, 'conversation_history': ['old']})
    responses.put('new-response', {'created_at': 2000, 'conversation_history': ['new']})
    responses.set_conversation('old-conversation', 'old-response')
    responses.set_conversation('new-conversation', 'new-response')
    responses.close()
    runs = RunIdempotencyStore(db_path=str(tmp_path / 'runs_idempotency.db'))
    runs.reserve('owner', 'key', 'fingerprint', 'old-run',
                 {'status': 'completed', 'conversation_session_id': 'old', 'output': 'old replay'})
    runs._conn.execute('UPDATE run_idempotency SET updated_at=1000')
    runs._conn.commit()
    runs.close()
    return tmp_path


def rows(home, query):
    with sqlite3.connect(home / 'state.db') as conn:
        return conn.execute(query).fetchall()


def test_preview_execute_native_restart_and_repeat(profile):
    before = rows(profile, 'SELECT * FROM messages WHERE timestamp>=2000 ORDER BY id')
    protected = {p: p.read_bytes() for p in [profile / n for n in ('memories/MEMORY.md', 'memories/USER.md', 'config.yaml', 'cron/jobs.json', '.env')]}
    preview = reset.reset_conversations(profile, CUTOFF)
    assert preview['messages']['delete'] == 3
    assert preview['sessions']['delete'] == 1 and preview['sessions']['keep'] == 4
    assert preview['blockers'] == []
    assert not (profile / '.paios-vision.lock').exists()
    assert len(rows(profile, 'SELECT id FROM messages')) == 6
    result = reset.reset_conversations(profile, CUTOFF, execute=True)
    assert result['status'] == 'executed'
    assert rows(profile, 'SELECT * FROM messages WHERE timestamp>=2000 ORDER BY id') == before
    assert all(path.read_bytes() == original for path, original in protected.items())
    assert not (profile / 'sessions/old.jsonl').exists()
    assert (profile / 'sessions/mixed.jsonl').read_bytes() == b'{ "content":"retained", "timestamp":2000 }\n'
    reopened = SessionDB(profile / 'state.db')
    try:
        assert reopened.get_session('old') is None
        assert reopened.get_session('ancestor') is not None
        assert reopened.get_session('delegate') is not None
        assert reopened.get_session('mixed')['message_count'] == 1
        assert reopened.get_messages_as_conversation('mixed')[0]['content'] == 'mixed_new_marker'
        assert not reopened.search_messages('mixed_old_marker')
    finally:
        reopened.close()
    previous = os.environ.get('HERMES_N_MINUS_ONE_ROOT')
    if previous:
        check = subprocess.run([sys.executable, '-c',
            'from hermes_state import SessionDB; import sys; from pathlib import Path; '
            'd=SessionDB(Path(sys.argv[1])); '
            'assert d.get_session("old") is None; '
            'assert d.get_messages_as_conversation("mixed")[0]["content"]=="mixed_new_marker"; '
            'assert not d.search_messages("mixed_old_marker"); d.close()', str(profile / 'state.db')],
            env={**os.environ, 'PYTHONPATH': previous}, capture_output=True, text=True, timeout=20)
        assert check.returncode == 0, check.stderr
    responses = ResponseStore(db_path=str(profile / 'response_store.db'))
    assert responses.get('old-response') is None
    assert responses.get_conversation('old-conversation') is None
    assert responses.get('new-response')['created_at'] == 2000
    responses.close()
    runs = RunIdempotencyStore(db_path=str(profile / 'runs_idempotency.db'))
    assert runs.lookup('owner', 'key', 'fingerprint')[0] == 'reused'
    assert 'output' not in runs.status_for_run('owner', 'old-run')['status']
    runs.close()
    repeat = reset.reset_conversations(profile, CUTOFF, execute=True)
    assert repeat['status'] == 'executed'
    assert repeat['messages']['delete'] == repeat['sessions']['delete'] == 0
    assert repeat['response_cache']['delete'] == repeat['run_replays']['scrub'] == 0


@pytest.mark.parametrize('kind', ['cache', 'mirror', 'run'])
def test_unknown_or_newer_derived_data_blocks_all_mutations(profile, kind):
    if kind == 'cache':
        responses = ResponseStore(db_path=str(profile / 'response_store.db'))
        responses.put('undated', {'conversation_history': ['unknown']})
        responses.close()
    elif kind == 'mirror':
        (profile / 'sessions/mixed.json').write_text('{"messages":["unknown"]}')
    else:
        with sqlite3.connect(profile / 'runs_idempotency.db') as conn:
            conn.execute('UPDATE run_idempotency SET updated_at=2000')
    before = rows(profile, 'SELECT * FROM messages ORDER BY id')
    assert reset.reset_conversations(profile, CUTOFF, execute=True)['status'] == 'blocked'
    assert rows(profile, 'SELECT * FROM messages ORDER BY id') == before
    assert (profile / 'sessions/old.jsonl').exists()


def test_runtime_lock_prevents_execute(profile):
    with (profile / '.paios-vision.lock').open('a') as owner:
        fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(RuntimeError, match='stop_and_drain'):
            reset.reset_conversations(profile, CUTOFF, execute=True)
    assert len(rows(profile, 'SELECT id FROM messages')) == 6


def test_old_delegate_deleted_with_parent_not_twice(tmp_path):
    db = SessionDB(tmp_path / 'state.db')
    for sid in ('z-parent', 'a-child'):
        db.create_session(sid, 'api_server')
        db.append_message(sid, 'user', 'old')
    db._execute_write(lambda c: c.execute('UPDATE messages SET timestamp=1000'))
    db._execute_write(lambda c: c.execute('UPDATE sessions SET started_at=1000,last_activity_at=1000'))
    db._execute_write(lambda c: c.execute('UPDATE sessions SET parent_session_id=?,model_config=? WHERE id=?',
                                        ('z-parent', json.dumps({'_delegate_from': 'z-parent'}), 'a-child')))
    db.close()
    assert reset.reset_conversations(tmp_path, CUTOFF, execute=True)['status'] == 'executed'
    assert rows(tmp_path, 'SELECT id FROM sessions') == []


def test_orphan_mirrors_are_filtered_or_blocked(tmp_path):
    directory = tmp_path / 'sessions'
    directory.mkdir()
    path = directory / 'orphan.jsonl'
    path.write_bytes(b'{"timestamp":1000,"content":"old"}\n{"timestamp":2000,"content":"new"}\n')
    assert reset.reset_conversations(tmp_path, CUTOFF, execute=True)['status'] == 'executed'
    assert path.read_bytes() == b'{"timestamp":2000,"content":"new"}\n'
    (directory / 'unknown.jsonl').write_text('{"content":"unknown"}\n')
    assert reset.reset_conversations(tmp_path, CUTOFF)['blockers'] == ['undated_session_mirror']


def test_json_stdin_cli_reports_aggregates_and_fixed_failure(tmp_path):
    env = {**os.environ}
    request = {'hermes_home': str(tmp_path), 'cutoff': '2026-10-18T00:00:00Z', 'action': 'preview'}
    good = subprocess.run([sys.executable, str(SOURCE)], input=json.dumps(request), capture_output=True,
                          text=True, env=env, timeout=20)
    assert good.returncode == 0 and json.loads(good.stdout)['status'] == 'preview'
    bad = subprocess.run([sys.executable, str(SOURCE)], input='private malformed secret', capture_output=True,
                         text=True, env=env, timeout=20)
    assert bad.returncode == 1
    assert json.loads(bad.stdout) == {'status': 'failed', 'code': 'HERMES_RESET_FAILED'}
    assert 'private' not in bad.stdout + bad.stderr


def test_preview_never_writes_closed_wal_profile_or_loses_wal_rows(profile):
    for name in ('state.db', 'response_store.db', 'runs_idempotency.db'):
        prepared = subprocess.run([sys.executable, '-c',
            'import sqlite3,sys,os; c=sqlite3.connect(sys.argv[1]); '
            'c.execute("PRAGMA journal_mode=WAL"); c.execute("PRAGMA wal_autocheckpoint=0"); '
            'c.execute("CREATE TABLE wal_preview_probe(value TEXT)"); '
            'c.execute("INSERT INTO wal_preview_probe VALUES (\'pending-wal\')"); '
            'c.commit(); os._exit(0)', str(profile / name)], capture_output=True, timeout=20)
        assert prepared.returncode == 0, prepared.stderr
        assert (profile / (name + '-wal')).stat().st_size > 0
        (profile / (name + '-shm')).unlink(missing_ok=True)
    inventory = lambda: {str(p.relative_to(profile)): p.read_bytes() for p in profile.rglob('*') if p.is_file()}
    before = inventory()
    preview = reset.reset_conversations(profile, CUTOFF)
    assert preview['status'] == 'preview' and preview['messages']['delete'] == 3
    for name in ('state.db', 'response_store.db', 'runs_idempotency.db'):
        assert reset._read(profile / name, 'SELECT value FROM wal_preview_probe') == [{'value': 'pending-wal'}]
    assert inventory() == before


def test_private_reference_transfer_uses_current_plan_and_default_stays_aggregate(profile, monkeypatch):
    default = reset.reset_conversations(profile, CUTOFF)
    assert '_reference_targets' not in default
    calls = []
    original = reset._plan
    def tracked(*args):
        calls.append(args)
        return original(*args)
    monkeypatch.setattr(reset, '_plan', tracked)
    private = reset.reset_conversations(profile, CUTOFF, _include_reference_targets=True)
    assert len(calls) == 1
    references = private.pop('_reference_targets')
    assert references == {'native_session_ids': ['old'], 'native_message_ids': [str(r[0]) for r in
        rows(profile, 'SELECT id FROM messages WHERE timestamp<2000 ORDER BY id')]}
    assert private == default
    request = {'hermes_home': str(profile), 'cutoff': '1970-01-01T00:33:20Z', 'action': 'preview',
               'include_reference_targets': True}
    completed = subprocess.run([sys.executable, str(SOURCE)], input=json.dumps(request), capture_output=True,
                               text=True, env=os.environ, timeout=20)
    assert completed.returncode == 0, completed.stderr
    transferred = json.loads(completed.stdout)
    assert transferred.pop('_reference_targets') == references
    assert transferred == default
    executed = reset.reset_conversations(profile, CUTOFF, execute=True, _include_reference_targets=True)
    assert '_reference_targets' not in executed
