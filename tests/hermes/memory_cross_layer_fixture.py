"""Temporary native-store phases used by the real PostgreSQL/L3 acceptance test."""
import importlib.util
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, os.environ['PAIOS_NATIVE_SOURCE_TEST_ROOT'])
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from hermes_state import SessionDB
from tools.memory_tool import MemoryStore
from tools.session_search_tool import session_search

phase, home, marker, assertion_ref, original_value = sys.argv[1:6]
home = Path(home)
entry = f'{marker} {assertion_ref}'
token = set_hermes_home_override(home)
try:
    store = MemoryStore()
    store.load_from_disk()
    if phase == 'seed':
        db = SessionDB(home / 'state.db')
        try:
            db.create_session('memory-cross-layer', 'api_server')
            db.append_message('memory-cross-layer', 'user', original_value + ' ' + assertion_ref + ':v1')
            db.append_message('memory-cross-layer', 'assistant', 'correction ' + entry + ':v2')
            assert marker in session_search(query=marker, db=db)
        finally:
            db.close()
        assert store.add('memory', entry)['success']
        store.load_from_disk()
        assert marker in store.format_for_system_prompt('memory')
        print(json.dumps({'seeded': True, 'assertion_ref': assertion_ref}))
    elif phase == 'purge':
        l3_receipt = json.loads(sys.stdin.read())
        assert l3_receipt['status'] == 'committed' and l3_receipt['version'] == 2
        source = Path(__file__).parents[2] / 'integrations/hermes/personal_aios/native_forget.py'
        spec = importlib.util.spec_from_file_location('isolated_native_forget', source)
        native = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(native)
        receipt = native.forget_native(home, {
            'authorization_ref': 'explicit-cross-layer-owner-request',
            'retention_rule': 'selected native projections; audit retained',
            'l3_receipt_ref': l3_receipt['receipt_ref'],
            'session_ids': ['memory-cross-layer'],
            'l2_entries': [{'target': 'memory', 'entry': entry}]})
        assert receipt['status'] == 'partial' and not receipt['strict_forget_complete']
        assert receipt['deleted_session_ids'] == ['memory-cross-layer']
        assert marker in store.format_for_system_prompt('memory')  # frozen old context
        fresh = MemoryStore()
        fresh.load_from_disk()
        assert marker not in (fresh.format_for_system_prompt('memory') or '')
        db = SessionDB(home / 'state.db')
        try:
            assert json.loads(session_search(query=marker, db=db))['results'] == []
            assert db.get_session('memory-cross-layer') is None
        finally:
            db.close()
        print(json.dumps({'receipt': receipt, 'fresh_prompt_absent': True, 'search_empty': True}))
    else:
        raise ValueError('unknown_fixture_phase')
finally:
    reset_hermes_home_override(token)
