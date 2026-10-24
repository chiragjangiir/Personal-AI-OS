"""Real native L2/SQLite/search acceptance in a temporary stopped profile."""
import fcntl
import importlib.util
import json
from pathlib import Path

import pytest
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from hermes_state import SessionDB
from tools.memory_tool import MemoryStore
from tools.session_search_tool import session_search


SOURCE = Path(__file__).parents[2] / 'integrations/hermes/personal_aios'
spec = importlib.util.spec_from_file_location('isolated_native_forget', SOURCE / 'native_forget.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


@pytest.fixture
def profile(tmp_path):
    token = set_hermes_home_override(tmp_path)
    db = SessionDB(tmp_path / 'state.db')
    db.create_session('source-session', 'api_server')
    db.append_message('source-session', 'user', 'obsolete_marker assertion:fixture-v1')
    db.create_session('unrelated', 'api_server')
    db.append_message('unrelated', 'user', 'unrelated_marker')
    store = MemoryStore()
    store.load_from_disk()
    assert store.add('memory', 'obsolete_marker assertion:fixture-v1')['success']
    assert store.add('memory', 'keep_marker')['success']
    assert store.add('user', 'obsolete_profile_marker')['success']
    store.load_from_disk()
    db.close()
    scope = {'authorization_ref': 'explicit-owner-request', 'retention_rule': 'erase selected projections',
        'l3_receipt_ref': 'fixture-central-delete-receipt', 'session_ids': ['source-session'],
        'l2_entries': [{'target': 'memory', 'entry': 'obsolete_marker assertion:fixture-v1'},
                       {'target': 'user', 'entry': 'obsolete_profile_marker'}]}
    try:
        yield tmp_path, scope, store
    finally:
        reset_hermes_home_override(token)


def test_scoped_native_forget_removes_l2_search_and_fresh_prompt(profile):
    home, scope, old = profile
    assert 'obsolete_marker' in old.format_for_system_prompt('memory')
    receipt = native.forget_native(home, scope)
    assert receipt['status'] == 'partial' and not receipt['strict_forget_complete']
    assert receipt['managed_runtime_stopped'] and receipt['clean_context_required']
    assert 'backups and exports' in receipt['residual_owners']
    assert receipt['deleted_session_ids'] == ['source-session']
    # Native frozen snapshots retain bytes; a file edit cannot clean a live run.
    assert 'obsolete_marker' in old.format_for_system_prompt('memory')
    fresh = MemoryStore()
    fresh.load_from_disk()
    assert 'obsolete_marker' not in (fresh.format_for_system_prompt('memory') or '')
    assert fresh.format_for_system_prompt('user') is None
    assert 'keep_marker' in fresh.format_for_system_prompt('memory')
    db = SessionDB(home / 'state.db')
    try:
        assert json.loads(session_search(query='obsolete_marker', db=db))['results'] == []
        assert 'unrelated_marker' in session_search(session_id='unrelated', db=db)
        assert db.get_session('source-session') is None
    finally:
        db.close()


def test_running_profile_and_stale_scope_cannot_delete(profile):
    home, scope, _ = profile
    with (home / '.paios-vision.lock').open('a') as owner:
        fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(RuntimeError, match='stop_and_drain'):
            native.forget_native(home, scope)
    scope['l2_entries'][0]['entry'] = 'obsolete_marker'  # substring is not an authorized whole entry
    receipt = native.forget_native(home, scope)
    assert receipt['status'] == 'failed' and receipt['error_code'] == 'l2_entry_scope_stale'
    assert receipt['deleted_session_ids'] == []
    db = SessionDB(home / 'state.db')
    try:
        assert db.get_session('source-session') is not None
    finally:
        db.close()


def test_ordinary_correction_keeps_native_history_and_requires_current_authority(profile):
    home, _, old = profile
    db = SessionDB(home / 'state.db')
    try:
        db.append_message('source-session', 'user', 'correction references assertion:fixture-v2')
        history = json.loads(session_search(session_id='source-session', db=db))
        assert 'assertion:fixture-v1' in json.dumps(history)
        assert 'assertion:fixture-v2' in json.dumps(history)
        # Historical text is retained. It cannot establish the current L3 head.
        assert 'obsolete_marker' in old.format_for_system_prompt('memory')
    finally:
        db.close()


def test_session_scope_removes_all_native_responses_and_conversation_mapping(profile):
    from gateway.platforms.api_server import ResponseStore
    home, scope, _ = profile
    responses = ResponseStore(db_path=str(home / 'response_store.db'))
    responses.put('resp-source', {'session_id': 'source-session',
        'conversation_history': [{'role': 'user', 'content': 'obsolete_marker'}]})
    responses.set_conversation('source-conversation', 'resp-source')
    responses.put('resp-unrelated', {'session_id': 'unrelated', 'conversation_history': []})
    responses.close()
    receipt = native.forget_native(home, scope)
    assert receipt['status'] == 'partial' and receipt['deleted_response_ids'] == ['resp-source']
    responses = ResponseStore(db_path=str(home / 'response_store.db'))
    try:
        assert responses.get('resp-source') is None
        assert responses.get_conversation('source-conversation') is None
        assert responses.get('resp-unrelated') is not None
    finally:
        responses.close()


def test_explicit_whole_response_cache_covers_legacy_cross_session_copies(profile):
    from gateway.platforms.api_server import ResponseStore
    home, scope, _ = profile
    responses = ResponseStore(db_path=str(home / 'response_store.db'))
    responses.put('resp-source', {'session_id': 'source-session', 'conversation_history': ['obsolete_marker']})
    responses.put('resp-copied', {'session_id': 'compressed-child', 'conversation_history': ['obsolete_marker']})
    responses.set_conversation('copied', 'resp-copied')
    responses.close()
    scope['response_cache_scope'] = 'all'
    receipt = native.forget_native(home, scope)
    assert receipt['status'] == 'partial'
    assert receipt['deleted_response_ids'] == ['resp-copied', 'resp-source']
    assert 'unattributed response chains' not in receipt['residual_owners']
    reopened = ResponseStore(db_path=str(home / 'response_store.db'))
    try:
        assert len(reopened) == 0 and reopened.get_conversation('copied') is None
    finally:
        reopened.close()


def test_native_run_payload_scrub_survives_restart_and_retains_replay_reservation(profile):
    from gateway.platforms.api_server_run_idempotency import RunIdempotencyStore
    home, scope, _ = profile
    path = str(home / 'runs_idempotency.db')
    runs = RunIdempotencyStore(db_path=path)
    runs.reserve('owner', 'request-key', 'fingerprint', 'run-source', {'status': 'completed',
        'conversation_session_id': 'source-session', 'output': 'obsolete_marker'})
    runs.reserve('owner', 'other-key', 'other-fingerprint', 'run-other', {'status': 'completed',
        'conversation_session_id': 'unrelated', 'output': 'keep_marker'})
    runs.close()
    receipt = native.forget_native(home, scope)
    assert not receipt['strict_forget_complete']
    assert receipt['scrubbed_run_ids'] == ['run-source']
    reopened = RunIdempotencyStore(db_path=path)
    try:
        status = reopened.status_for_run('owner', 'run-source')['status']
        assert status['status'] == 'cancelled' and 'output' not in status
        assert 'obsolete_marker' not in json.dumps(status)
        outcome, replay = reopened.lookup('owner', 'request-key', 'fingerprint')
        assert outcome == 'reused' and replay['status'] == status
        assert reopened.status_for_run('owner', 'run-other')['status']['output'] == 'keep_marker'
    finally:
        reopened.close()


def test_active_run_and_run_scope_cas_prevent_cleanup(profile):
    from gateway.platforms.api_server_run_idempotency import RunIdempotencyStore
    home, scope, _ = profile
    runs = RunIdempotencyStore(db_path=str(home / 'runs_idempotency.db'))
    runs.reserve('owner', 'key', 'fingerprint', 'run-source', {'status': 'completed',
        'session_id': 'source-session', 'output': 'obsolete_marker'})
    snapshot = runs.session_delete_snapshot(['source-session'])
    runs.update_status('run-source', {'status': 'completed', 'session_id': 'source-session', 'output': 'changed'})
    with pytest.raises(ValueError, match='scope_changed'):
        runs.purge_sessions(['source-session'], expected_snapshot=snapshot)
    runs.update_status('run-source', {'status': 'running', 'session_id': 'source-session'})
    runs.close()
    receipt = native.forget_native(home, scope)
    assert receipt['status'] == 'failed' and receipt['error_code'] == 'native_forget_run_not_terminal'
    assert receipt['deleted_session_ids'] == receipt['scrubbed_run_ids'] == []


def test_response_whole_scope_cas_rejects_new_member(tmp_path):
    from gateway.platforms.api_server import ResponseStore
    responses = ResponseStore(db_path=str(tmp_path / 'responses.db'))
    try:
        responses.put('one', {'session_id': 'selected'})
        snapshot = responses.session_delete_snapshot(['selected'], include_unattributed=True)
        responses.put('two', {'session_id': 'selected'})
        with pytest.raises(ValueError, match='scope_changed'):
            responses.delete_sessions(['selected'], expected_snapshot=snapshot, include_unattributed=True)
        assert len(responses) == 2
    finally:
        responses.close()


@pytest.mark.parametrize('delivery', ['accepted', 'refused', 'pending'])
def test_amendment_raw_text_is_not_retained_after_forget_or_ttl(profile, delivery):
    from gateway.platforms.api_run_amendment import amend
    from gateway.platforms.api_server_run_idempotency import RunIdempotencyStore
    home, scope, _ = profile
    path = str(home / 'runs_idempotency.db')
    runs = RunIdempotencyStore(path)
    for rid, sid in [('selected', 'source-session'), ('expired', 'unrelated'), ('keep', 'unrelated')]:
        runs.reserve('owner', rid, rid, rid, {'status': 'completed', 'session_id': sid})
        def deliver():
            if delivery == 'pending':
                raise RuntimeError('delivery interrupted')
            return {'accepted': True} if delivery == 'accepted' else {'error': 'steer_not_accepted'}
        if delivery == 'pending':
            with pytest.raises(RuntimeError, match='interrupted'):
                amend(runs, 'owner', rid, 'a', 'private-amendment-' + rid, deliver)
        else:
            amend(runs, 'owner', rid, 'a', 'private-amendment-' + rid, deliver)
    runs._conn.execute("UPDATE run_idempotency SET updated_at=0 WHERE run_id='expired'")
    runs._conn.commit()
    assert runs.lookup('owner', 'expired', 'expired')[0] == 'missing'
    runs.close()
    receipt = native.forget_native(home, scope)
    assert receipt['scrubbed_run_ids'] == ['selected']
    reopened = RunIdempotencyStore(path)
    try:
        rows = reopened._conn.execute('SELECT text FROM run_amendments').fetchall()
        assert all('private-amendment-' not in row[0] for row in rows)
        for rid in ('selected', 'expired'):
            result = amend(reopened, 'owner', rid, 'a', 'private-amendment-' + rid,
                           lambda: pytest.fail('deleted/expired amendment replayed'))
            assert result['error'] in {'amendment_history_deleted', 'amendment_history_expired'}
        assert reopened.status_for_run('owner', 'keep')['status']['session_id'] == 'unrelated'
        keep = reopened._conn.execute("SELECT receipt FROM run_amendments WHERE run_id='keep'").fetchone()[0]
        assert keep is None if delivery == 'pending' else json.loads(keep) == (
            {'accepted': True} if delivery == 'accepted' else {'error': 'steer_not_accepted'})
        assert reopened.lookup('owner', 'selected', 'selected')[0] == 'reused'
    finally:
        reopened.close()


def test_legacy_amendments_migrate_without_replaying_or_retaining_raw_text(tmp_path):
    import sqlite3
    from gateway.platforms.api_run_amendment import amend
    from gateway.platforms.api_server_run_idempotency import RunIdempotencyStore
    path = str(tmp_path / 'runs.db')
    with sqlite3.connect(path) as conn:
        conn.execute('CREATE TABLE run_amendments (scope TEXT, run_id TEXT, amendment_id TEXT, '
                     'text TEXT NOT NULL, receipt TEXT, PRIMARY KEY(scope,run_id,amendment_id))')
        for aid, receipt in [('accepted', '{"accepted":true}'), ('pending', None)]:
            conn.execute('INSERT INTO run_amendments VALUES(?,?,?,?,?)',
                         ('owner', 'orphan', aid, 'legacy private text', receipt))
    runs = RunIdempotencyStore(path)
    try:
        assert all('legacy private text' not in row[0] for row in runs._conn.execute('SELECT text FROM run_amendments'))
        assert amend(runs, 'owner', 'orphan', 'accepted', 'legacy private text',
                     lambda: pytest.fail('legacy accepted amendment replayed')) == {'accepted': True}
        assert amend(runs, 'owner', 'orphan', 'pending', 'legacy private text',
                     lambda: pytest.fail('legacy uncertain amendment replayed'))['error'] == 'amendment_delivery_uncertain'
        assert amend(runs, 'owner', 'orphan', 'accepted', 'different', lambda: None)['error'] == 'amendment_id_conflict'
    finally:
        runs.close()
