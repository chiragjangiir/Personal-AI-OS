"""Native skill registration, tested promotion, repair and owner-requested rollback."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

REPO = Path(__file__).resolve().parents[2]
NATIVE = Path(os.environ.get('HERMES_NATIVE_SOURCE', REPO / '.scratch' / 'hermes-source'))


@pytest.fixture
def lifecycle(tmp_path, monkeypatch):
    if not (NATIVE / 'tools' / 'skill_manager_tool.py').exists():
        pytest.skip('Native Hermes checkout unavailable; run bash ci/install.sh hermes or set HERMES_NATIVE_SOURCE')
    monkeypatch.syspath_prepend(str(NATIVE))
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    token = set_hermes_home_override(tmp_path / 'production')
    spec = importlib.util.spec_from_file_location('tested_tool_lifecycle',
        REPO / 'integrations/hermes/personal_aios/tool_lifecycle.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    def verify(root):
        result = subprocess.run([sys.executable, '-B', str(root / 'scripts/run.py')],
            cwd=root, capture_output=True, text=True, timeout=5)
        return {'success': result.returncode == 0, 'stdout': result.stdout, 'stderr': result.stderr}
    try:
        yield module.ToolLifecycle(verify)
    finally:
        reset_hermes_home_override(token)


def package(value='original'):
    return {'SKILL.md': '---\nname: fixture-tool\ndescription: Run the fixture tool to verify the tool release lifecycle.\nadapter_modules: []\n---\n\nRun `python scripts/run.py`.\n',
            'scripts/run.py': f'print({value!r})\n'}


def release(lifecycle, files):
    candidate = lifecycle.stage('fixture-tool', files)['pending_id']
    assert lifecycle.test(candidate)['success']
    assert lifecycle.promote(candidate)['success']
    return candidate


def test_native_register_use_break_repair_and_revert(lifecycle):
    from tools.skills_tool import skill_view
    release(lifecycle, package())
    assert lifecycle.status('fixture-tool')['installed']
    assert 'scripts/run.py' in skill_view('fixture-tool')
    assert lifecycle.monitor('fixture-tool')['verification']['stdout'] == 'original\n'
    broken = package('broken')
    broken['scripts/run.py'] = 'raise RuntimeError("broken candidate")\n'
    candidate = lifecycle.stage('fixture-tool', broken)['pending_id']
    assert lifecycle.test(candidate)['success'] is False
    with pytest.raises(ValueError, match='pass testing'):
        lifecycle.promote(candidate)
    assert lifecycle.monitor('fixture-tool')['verification']['stdout'] == 'original\n'
    release(lifecycle, package('repaired'))
    assert lifecycle.monitor('fixture-tool')['verification']['stdout'] == 'repaired\n'
    assert lifecycle.revert('fixture-tool')['success']
    assert lifecycle.monitor('fixture-tool')['verification']['stdout'] == 'original\n'


def test_native_release_survives_process_restarts(tmp_path):
    if not (NATIVE / 'tools/skill_manager_tool.py').exists():
        pytest.skip('Native Hermes checkout unavailable; run bash ci/install.sh hermes or set HERMES_NATIVE_SOURCE')
    worker = tmp_path / 'lifecycle_worker.py'
    worker.write_text('''
import json, os, subprocess, sys
from pathlib import Path
sys.path[:0] = [sys.argv[1], sys.argv[2]]
from personal_aios.tool_lifecycle import ToolLifecycle
from tools.skills_tool import skill_view

def verify(root):
    result = subprocess.run([sys.executable, '-B', str(root / 'scripts/run.py')],
                            capture_output=True, text=True, timeout=5)
    return {'success': result.returncode == 0, 'stdout': result.stdout, 'stderr': result.stderr}

lifecycle = ToolLifecycle(verify)
action, payload = sys.argv[3:]
if action == 'stage':
    result = lifecycle.stage('fixture-tool', json.loads(payload))
elif action == 'promote':
    assert lifecycle.test(payload)['success']
    result = lifecycle.promote(payload)
elif action == 'reuse':
    assert 'scripts/run.py' in skill_view('fixture-tool')
    result = lifecycle.monitor('fixture-tool')['verification']
else:
    assert action == 'revert'
    result = lifecycle.revert()
print(json.dumps(result))
''')
    env = {**os.environ, 'HERMES_HOME': str(tmp_path / 'production'), 'PYTHONDONTWRITEBYTECODE': '1'}

    def process(action, payload=''):
        result = subprocess.run([sys.executable, '-B', str(worker), str(NATIVE),
            str(REPO / 'integrations/hermes'), action, payload], env=env,
            capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stdout + result.stderr
        return json.loads(result.stdout)

    for value in ('original', 'repaired'):
        candidate = process('stage', json.dumps(package(value)))['pending_id']
        assert process('promote', candidate)['success']
        assert process('reuse')['stdout'] == value + '\n'
    assert process('revert')['success']
    assert process('reuse')['stdout'] == 'original\n'


def test_initial_release_reverts_to_absence(lifecycle):
    release(lifecycle, package())
    assert lifecycle.revert('fixture-tool')['success']
    assert not lifecycle.status('fixture-tool')['installed']


def test_candidate_requires_test_and_rejects_production_drift(lifecycle):
    candidate = lifecycle.stage('fixture-tool', package())['pending_id']
    with pytest.raises(ValueError, match='pass testing'):
        lifecycle.promote(candidate)
    assert lifecycle.test(candidate)['success']
    release(lifecycle, package('concurrent'))
    with pytest.raises(ValueError, match='Production changed'):
        lifecycle.promote(candidate)


def test_build_result_cannot_overwrite_a_newer_registered_tool(lifecycle):
    baseline = package()
    release(lifecycle, baseline)
    release(lifecycle, package('concurrent'))
    with pytest.raises(ValueError, match='changed during build'):
        lifecycle.stage('fixture-tool', package('stale build'), expected_previous=baseline)
    assert lifecycle.monitor('fixture-tool')['verification']['stdout'] == 'concurrent\n'


def test_test_evidence_cannot_be_reused_for_edited_candidate(lifecycle):
    from tools import write_approval
    candidate = lifecycle.stage('fixture-tool', package())['pending_id']
    assert lifecycle.test(candidate)['success']
    record = write_approval.get_pending(write_approval.SKILLS, candidate)
    record['payload']['operations'][1]['file_content'] = 'print("untested")\n'
    lifecycle._save(record)
    with pytest.raises(ValueError, match='pass testing'):
        lifecycle.promote(candidate)


def test_failed_native_batch_preserves_production(lifecycle, monkeypatch):
    from tools import skill_manager_tool as manager
    release(lifecycle, package())
    candidate = lifecycle.stage('fixture-tool', package('next'))['pending_id']
    assert lifecycle.test(candidate)['success']
    monkeypatch.setattr(manager, '_security_scan_skill', lambda root: 'blocked')
    with pytest.raises(ValueError, match='blocked'):
        lifecycle.promote(candidate)
    assert lifecycle.monitor('fixture-tool')['verification']['stdout'] == 'original\n'


def test_revert_preserves_files_unchanged_by_release(lifecycle):
    initial = package()
    initial['references/retained.md'] = 'Retain this reference.\n'
    release(lifecycle, initial)
    repaired = dict(initial, **{'scripts/run.py': 'print("repaired")\n'})
    release(lifecycle, repaired)
    assert lifecycle.revert('fixture-tool')['success']
    root = Path(lifecycle.status('fixture-tool')['path'])
    assert (root / 'references/retained.md').read_text() == 'Retain this reference.\n'


def test_lifecycle_cannot_replace_native_owner_skill(lifecycle):
    import json
    from tools import skill_manager_tool as manager
    created = json.loads(manager.apply_skill_pending({'action': 'create', 'name': 'fixture-tool',
                                                       'content': package()['SKILL.md']}))
    assert created['success']
    with pytest.raises(ValueError, match='owns only'):
        lifecycle.stage('fixture-tool', package('replacement'))
    assert Path(manager._find_skill('fixture-tool')['path']).parent.name == 'skills'


def test_monitor_reports_live_failure_and_repair_uses_new_candidate(lifecycle):
    release(lifecycle, package())
    root = Path(lifecycle.status('fixture-tool')['path'])
    (root / 'scripts/run.py').write_text('raise RuntimeError("runtime failure")\n')
    assert lifecycle.monitor('fixture-tool')['verification']['success'] is False
    release(lifecycle, package('repaired'))
    assert lifecycle.monitor('fixture-tool')['verification']['stdout'] == 'repaired\n'


def test_revert_cannot_overwrite_recreated_removed_file(lifecycle):
    initial = package()
    initial['references/removed.md'] = 'Original reference.\n'
    release(lifecycle, initial)
    release(lifecycle, package('next'))
    root = Path(lifecycle.status('fixture-tool')['path'])
    (root / 'references').mkdir(exist_ok=True)
    (root / 'references/removed.md').write_text('Owner restored different text.\n')
    with pytest.raises(ValueError, match='Production changed'):
        lifecycle.revert('fixture-tool')
    assert (root / 'references/removed.md').read_text() == 'Owner restored different text.\n'


def test_unnamed_status_and_revert_use_latest_active_native_release(lifecycle):
    assert lifecycle.status('')['name'] == ''
    release(lifecycle, package())
    files = package('other')
    files['SKILL.md'] = files['SKILL.md'].replace('fixture-tool', 'other-tool')
    candidate = lifecycle.stage('other-tool', files)['pending_id']
    assert lifecycle.test(candidate)['success']
    assert lifecycle.promote(candidate)['success']
    assert lifecycle.status('')['name'] == 'other-tool'
    assert lifecycle.revert('')['success']
    assert lifecycle.status('')['name'] == 'fixture-tool'
    assert lifecycle.status('fixture-tool')['installed']
    with pytest.raises(ValueError, match='No active tool release'):
        lifecycle.revert('other-tool')
    assert lifecycle.revert('')['success']
    assert lifecycle.status('')['name'] == ''
    with pytest.raises(ValueError, match='No active tool release'):
        lifecycle.revert('')


def test_named_revert_can_step_back_to_previous_active_release(lifecycle):
    release(lifecycle, package())
    release(lifecycle, package('next'))
    assert lifecycle.revert('fixture-tool')['success']
    assert lifecycle.monitor('fixture-tool')['verification']['stdout'] == 'original\n'
    assert lifecycle.revert('fixture-tool')['success']
    assert not lifecycle.status('fixture-tool')['installed']
    with pytest.raises(ValueError, match='No active tool release'):
        lifecycle.revert('fixture-tool')


def budget_package(ratio, reason='The offline tool needs this reference fixture.'):
    files = package()
    if reason is not None:
        files['SKILL.md'] = files['SKILL.md'].replace('adapter_modules: []',
            'adapter_modules: []\nbudget_reason: ' + json.dumps(reason))
    files['references/fixture.txt'] = 'x' * int(131072 * ratio)
    return files


@pytest.mark.parametrize('ratio', [1.5, 2])
def test_reasoned_overrun_is_tested_released_recorded_and_reversible(lifecycle, ratio):
    from tools import write_approval, skill_ledger
    staged = lifecycle.stage('fixture-tool', budget_package(ratio))
    budget = staged['budget']
    assert budget['status'] == 'ready'
    assert budget['overruns'] == [{'metric': 'file_bytes', 'path': 'references/fixture.txt',
                                  'value': int(131072 * ratio), 'limit': 131072, 'ratio': ratio}]
    pending = staged['pending_id']
    assert lifecycle.test(pending)['success']
    record = write_approval.get_pending(write_approval.SKILLS, pending)
    assert record['tool_test']['candidate']['budget'] == budget
    released = lifecycle.promote(pending)
    assert released['budget'] == budget
    entry = next(row for row in skill_ledger.list_entries() if row['id'] == released['release_id'])
    assert entry['evidence']['budget'] == budget
    assert lifecycle.monitor('fixture-tool')['verification']['stdout'] == 'original\n'
    assert lifecycle.revert('fixture-tool')['success']
    assert not lifecycle.status('fixture-tool')['installed']


@pytest.mark.parametrize('reason', [None, '', '  '])
def test_overrun_without_a_written_reason_requests_one_without_staging(lifecycle, reason):
    staged = lifecycle.stage('fixture-tool', budget_package(1.5, reason))
    assert staged['status'] == 'needs_reason' and staged['success'] is False
    assert staged['budget']['overruns'][0]['ratio'] == 1.5
    assert not lifecycle.status('fixture-tool')['pending']
    assert not lifecycle.status('fixture-tool')['installed']


@pytest.mark.parametrize(('choice', 'ratio', 'metric'), [
    ('once', 2.5, 'file_bytes'), ('deny', 2.5, 'file_bytes'), ('once', 9, 'file_bytes'),
    ('once', 2.5, 'atomic_operations'), ('deny', 2.5, 'atomic_operations')])
def test_large_overrun_resumes_the_exact_pending_candidate_after_one_native_question(lifecycle, monkeypatch, choice, ratio, metric):
    from tools import approval, approval_context, write_approval, skill_ledger
    session, prompts = 'overlimit-owner-request', []
    monkeypatch.setattr(approval_context, 'get_current_session_key', lambda: session)
    def notify(data):
        prompts.append(data)
        assert data['allow_session'] is False and data['allow_permanent'] is False
        assert approval.resolve_gateway_approval(session, choice, request_id=data['request_id'])
    approval.register_gateway_notify(session, notify)
    try:
        files = budget_package(ratio if metric == 'file_bytes' else 0)
        if metric == 'atomic_operations':
            files.update({f'references/{i}.txt': 'fixture' for i in range(int(20 * ratio) - len(files))})
        staged = lifecycle.stage('fixture-tool', files)
        pending = staged['pending_id']
        assert staged['status'] == 'needs_approval' and staged['success'] is False
        overrun = next(item for item in staged['budget']['overruns'] if item['metric'] == metric)
        assert overrun['ratio'] == ratio
        with pytest.raises(ValueError, match='approval'):
            lifecycle.test(pending)
        approved = lifecycle.approve(pending)
        assert len(prompts) == 1 and pending in prompts[0]['pattern_key']
        assert str(overrun['value']) in prompts[0]['description'] and str(overrun['limit']) in prompts[0]['description']
        # The existing native run status projects only the first 200 characters to its card.
        assert staged['budget']['reason'] in prompts[0]['description'][:200]
        assert lifecycle.approve(pending) == approved and len(prompts) == 1
        if choice == 'once':
            assert approved['success'] and approved['status'] == 'approved'
            assert lifecycle.test(pending)['success']
            released = lifecycle.promote(pending)
            entry = next(row for row in skill_ledger.list_entries() if row['id'] == released['release_id'])
            assert entry['evidence']['budget']['approval']['request_id'] == prompts[0]['request_id']
            assert entry['evidence']['budget']['approval']['choice'] == 'once'
            # An allowance for this package/request never authorizes a fresh build.
            other = lifecycle.stage('fixture-tool', files)
            assert other['pending_id'] != pending and other['status'] == 'needs_approval'
        else:
            assert not approved['success'] and approved['status'] == 'denied'
            with pytest.raises(ValueError, match='denied'):
                lifecycle.test(pending)
            with pytest.raises(ValueError, match='denied'):
                lifecycle.promote(pending)
            assert not lifecycle.status('fixture-tool')['installed']
            assert skill_ledger.list_entries() == []
            assert write_approval.get_pending(write_approval.SKILLS, pending)['tool_candidate']['budget'] == approved['budget']
    finally:
        approval.unregister_gateway_notify(session)


def test_budget_approval_is_resumable_when_no_owner_surface_is_available(lifecycle, monkeypatch):
    from tools import approval
    monkeypatch.setattr(approval, '_gateway_notify_cb', lambda _: None)
    staged = lifecycle.stage('fixture-tool', budget_package(2.5))
    assert lifecycle.approve(staged['pending_id'])['status'] == 'needs_approval'
    assert lifecycle.status('fixture-tool')['pending'] == [staged['pending_id']]


@pytest.mark.parametrize('first_attempt', ['timeout', 'notify_failed', 'deny'])
def test_budget_approval_retries_only_unresolved_attempts_without_changing_the_candidate(lifecycle, monkeypatch, first_attempt):
    from copy import deepcopy
    from tools import approval, approval_context, approval_gateway_wait, write_approval
    session, prompts = 'retry-tool-budget-owner', []
    monkeypatch.setattr(approval_context, 'get_current_session_key', lambda: session)
    poll = approval_gateway_wait._poll_event
    def wait(*args, **kwargs):
        return 'timeout' if len(prompts) == 1 and first_attempt == 'timeout' else poll(*args, **kwargs)
    monkeypatch.setattr(approval_gateway_wait, '_poll_event', wait)
    def notify(data):
        prompts.append(data)
        if len(prompts) == 1 and first_attempt == 'notify_failed':
            raise RuntimeError('fixture notification failed')
        if len(prompts) > 1 or first_attempt == 'deny':
            choice = 'deny' if len(prompts) == 1 else 'once'
            assert approval.resolve_gateway_approval(session, choice, request_id=data['request_id'])
    approval.register_gateway_notify(session, notify)
    try:
        staged = lifecycle.stage('fixture-tool', budget_package(2.5))
        pending, budget = staged['pending_id'], deepcopy(staged['budget'])
        original = write_approval.get_pending(write_approval.SKILLS, pending)
        first = lifecycle.approve(pending)
        assert first['status'] == ('denied' if first_attempt == 'deny' else 'needs_approval')
        with pytest.raises(ValueError, match='approval'):
            lifecycle.test(pending)
        with pytest.raises(ValueError, match='approval'):
            lifecycle.promote(pending)
        retried = lifecycle.approve(pending)
        assert retried['status'] == ('denied' if first_attempt == 'deny' else 'approved')
        assert len(prompts) == (1 if first_attempt == 'deny' else 2)
        assert retried['pending_id'] == pending
        stored = write_approval.get_pending(write_approval.SKILLS, pending)
        assert stored['payload'] == original['payload']
        assert {key: value for key, value in stored['tool_candidate'].items() if key != 'budget'} == {
            key: value for key, value in original['tool_candidate'].items() if key != 'budget'}
        assert {key: stored['tool_candidate']['budget'][key] for key in budget if key != 'status'} == {
            key: value for key, value in budget.items() if key != 'status'}
        assert all(p['allow_session'] is False and p['allow_permanent'] is False for p in prompts)
        assert len({p['pattern_key'] for p in prompts}) == 1
        if first_attempt != 'deny':
            assert prompts[0]['request_id'] != prompts[1]['request_id']
            assert first['budget']['approval_attempt']['resolved'] is False
            assert 'approval' not in first['budget']
            assert lifecycle.test(pending)['success']
            assert lifecycle.promote(pending)['success']
        else:
            assert retried == first and not lifecycle.status('fixture-tool')['installed']
    finally:
        approval.unregister_gateway_notify(session)


def test_concurrent_budget_approval_retries_a_legacy_unresolved_attempt_once(lifecycle, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from contextvars import copy_context
    import threading
    from tools import approval, approval_context
    pending = lifecycle.stage('fixture-tool', budget_package(2.5))['pending_id']
    record = lifecycle._pending(pending)
    record['tool_candidate']['budget']['approval'] = {
        'request_id': 'expired-attempt', 'resolved': False, 'choice': None}
    lifecycle._save(record)
    prompts, readers = [], set()
    barrier, guard = threading.Barrier(2), threading.Lock()
    original = lifecycle._pending
    def read(candidate):
        record = original(candidate)
        with guard:
            first = threading.get_ident() not in readers
            readers.add(threading.get_ident())
        if first:
            barrier.wait(timeout=5)
        return record
    monkeypatch.setattr(lifecycle, '_pending', read)
    monkeypatch.setattr(approval_context, 'get_current_session_key', lambda: 'concurrent-owner')
    def notify(data):
        prompts.append(data)
        approval.resolve_gateway_approval('concurrent-owner', 'once', request_id=data['request_id'])
    approval.register_gateway_notify('concurrent-owner', notify)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(copy_context().run, lifecycle.approve, pending) for _ in range(2)]
            assert all(future.result(timeout=10)['status'] == 'approved' for future in futures)
        assert len(prompts) == 1
    finally:
        approval.unregister_gateway_notify('concurrent-owner')


@pytest.mark.parametrize('ratio', [1.5, 2.5])
def test_total_package_budget_counts_all_utf8_bytes(lifecycle, ratio):
    files = budget_package(0)
    remaining = int(524288 * ratio) - sum(len(text.encode()) for text in files.values())
    while remaining:
        size = min(131072, remaining)
        files[f'references/part-{len(files)}.txt'] = 'x' * size
        remaining -= size
    staged = lifecycle.stage('fixture-tool', files)
    assert staged['budget']['overruns'] == [
        {'metric': 'total_bytes', 'value': int(524288 * ratio), 'limit': 524288, 'ratio': ratio}]
    assert staged['status'] == ('ready' if ratio == 1.5 else 'needs_approval')
    if ratio == 1.5:
        assert lifecycle.test(staged['pending_id'])['success']
        assert lifecycle.promote(staged['pending_id'])['success']


def test_package_allowance_does_not_change_ordinary_native_skill_limits(lifecycle):
    from tools import skill_manager_tool as manager
    payload = {'operations': [
        {'action': 'create', 'name': 'ordinary-tool', 'content': package()['SKILL.md']},
        {'action': 'write_file', 'name': 'ordinary-tool', 'file_path': 'references/fixture.txt',
         'file_content': 'x' * 196608}]}
    assert not json.loads(manager.apply_skill_pending(payload))['success']
    release(lifecycle, budget_package(1.5))
    assert not json.loads(manager.apply_skill_pending(payload))['success']
    assert manager._find_skill('ordinary-tool') is None


@pytest.mark.parametrize('operations', [20, 21, 30, 40])
def test_reasoned_batch_overrun_uses_one_native_atomic_call(lifecycle, operations):
    from tools import skill_manager_tool as manager
    release(lifecycle, package('previous'))
    files = budget_package(0)
    files.update({f'references/{i}.txt': 'fixture' for i in range(operations - len(files))})
    staged = lifecycle.stage('fixture-tool', files)
    assert staged['status'] == 'ready' and staged['success']
    if operations > 20:
        assert {'metric': 'atomic_operations', 'value': operations, 'limit': 20,
                'ratio': operations / 20} in staged['budget']['overruns']
        ordinary = json.loads(manager.apply_skill_pending(lifecycle._pending(staged['pending_id'])['payload']))
        assert not ordinary['success'] and '20 ops' in ordinary['error']
        assert lifecycle.monitor('fixture-tool')['verification']['stdout'] == 'previous\n'
    if operations > 32:
        assert {'metric': 'file_count', 'value': operations, 'limit': 32,
                'ratio': operations / 32} in staged['budget']['overruns']
    assert lifecycle.test(staged['pending_id'])['success']
    released = lifecycle.promote(staged['pending_id'])
    assert released['operations_applied'] == operations
    assert lifecycle.monitor('fixture-tool')['verification']['stdout'] == 'original\n'
    assert lifecycle.revert('fixture-tool')['success']
    assert lifecycle.monitor('fixture-tool')['verification']['stdout'] == 'previous\n'


def test_large_atomic_batch_failure_restores_the_whole_previous_package(lifecycle, monkeypatch):
    from tools import skill_manager_tool as manager
    release(lifecycle, package())
    files = budget_package(0)
    files['scripts/run.py'] = 'print("next")\n'
    files.update({f'references/{i:02}.txt': 'fixture' for i in range(37)})
    pending = lifecycle.stage('fixture-tool', files)['pending_id']
    assert lifecycle.test(pending)['success']
    original = manager._skill_manage_from
    def apply(payload, **extra):
        if payload.get('file_path') == 'references/30.txt':
            return json.dumps({'success': False, 'error': 'late fixture failure'})
        return original(payload, **extra)
    monkeypatch.setattr(manager, '_skill_manage_from', apply)
    with pytest.raises(ValueError, match='late fixture failure.*all touched skills rolled back'):
        lifecycle.promote(pending)
    assert lifecycle.monitor('fixture-tool')['verification']['stdout'] == 'original\n'
    assert len(list(Path(lifecycle.status('fixture-tool')['path']).rglob('*.*'))) == 2
    assert len(lifecycle.status('fixture-tool')['releases']) == 1


def test_removed_files_count_toward_the_same_native_atomic_batch(lifecycle):
    old = package()
    old.update({f'references/old-{i}.txt': 'old' for i in range(18)})
    release(lifecycle, old)
    files = package('next')
    files['SKILL.md'] = files['SKILL.md'].replace('adapter_modules: []',
        'adapter_modules: []\nbudget_reason: Replace the obsolete offline references in one release.')
    files['references/new.txt'] = 'new'
    staged = lifecycle.stage('fixture-tool', files)
    assert staged['status'] == 'ready'
    assert staged['budget']['overruns'] == [
        {'metric': 'atomic_operations', 'value': 21, 'limit': 20, 'ratio': 1.05}]
    assert lifecycle.test(staged['pending_id'])['success']
    assert lifecycle.promote(staged['pending_id'])['operations_applied'] == 21
    assert lifecycle.monitor('fixture-tool')['verification']['stdout'] == 'next\n'


@pytest.mark.parametrize(('ratio', 'reason', 'status'), [
    (1, None, 'ready'), (1.5, None, 'needs_reason'),
    (1.5, 'The reference must work offline.', 'ready'),
    (2.5, 'The reference must work offline.', 'needs_approval')])
def test_builder_exports_a_structured_budget_outcome(lifecycle, tmp_path, monkeypatch, ratio, reason, status):
    monkeypatch.syspath_prepend(str(REPO / 'integrations/hermes'))
    from personal_aios import workshop_builder as builder
    root = tmp_path / 'export'
    files = budget_package(ratio, reason)
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    exported = builder.export_tool('fixture-tool', root)
    assert exported['budget']['status'] == status and exported['files'] == files


def test_main_agent_bridge_preserves_budget_and_resumes_without_another_build(lifecycle, monkeypatch):
    monkeypatch.syspath_prepend(str(REPO / 'integrations/hermes'))
    from personal_aios import workshop
    from hermes_cli import config
    from gateway import run_scope
    from hermes_constants import get_hermes_home, set_hermes_home_override, reset_hermes_home_override
    from tools import approval, approval_context
    from types import SimpleNamespace
    handlers, calls, prompts = {}, [], []
    files = budget_package(2.5)
    monkeypatch.setattr(config, 'load_config', lambda: {'personal_aios': {'builder_url': 'https://fixture.invalid'}})
    scope = ['build']
    monkeypatch.setattr(run_scope, 'current_scope', lambda: scope[0])
    monkeypatch.setattr(approval_context, 'get_current_session_key', lambda: 'bridge-owner')
    def remote(path, body, service):
        calls.append(path)
        if path == '/build':
            return {'name': 'fixture-tool', 'files': files, 'run_id': 'builder-run', 'output': 'Built with a reason.'}
        assert path == '/test'
        return {'success': True, 'stdout': 'original\n'}
    monkeypatch.setattr(workshop, 'builder_request', remote)
    workshop.register(SimpleNamespace(register_tool=lambda name, toolset, schema, fn: handlers.update({name: fn})))
    hub = lambda action, value, **args: json.loads(handlers['skills_hub']({'action': action, 'value': value, **args}))
    token = set_hermes_home_override(get_hermes_home() / 'workshop')
    try:
        staged = hub('build', 'Build this tool.', name='fixture-tool')
        pending = staged['pending_id']
        assert staged['status'] == 'needs_approval' and staged['run_id'] == 'builder-run'
        assert staged['output'] == 'Built with a reason.' and staged['budget']['reason']
        with pytest.raises(ValueError, match='owner conversation'):
            hub('approve', pending)
    finally:
        reset_hermes_home_override(token)
    scope[0] = 'owner'
    def notify(data):
        prompts.append(data)
        approval.resolve_gateway_approval('bridge-owner', 'once', request_id=data['request_id'])
    approval.register_gateway_notify('bridge-owner', notify)
    try:
        assert hub('approve', pending)['status'] == 'approved'
        assert hub('approve', pending)['status'] == 'approved' and len(prompts) == 1
    finally:
        approval.unregister_gateway_notify('bridge-owner')
    scope[0] = 'build'
    token = set_hermes_home_override(get_hermes_home() / 'workshop')
    try:
        assert hub('test', pending)['success']
        assert hub('promote', pending)['budget']['approval']['choice'] == 'once'
    finally:
        reset_hermes_home_override(token)
    assert calls == ['/build', '/test']


@pytest.mark.parametrize(('declaration', 'lines', 'success', 'error'), [
    (None, 232, False, 'adapter_modules'),
    (['scripts/parcel.py'], 232, False, '232'),
    (['scripts/parcel.py'], 200, True, ''),
    ([], 232, True, ''),
    (['scripts/missing.py'], 1, False, 'scripts/missing.py'),
    ('scripts/parcel.py', 1, False, 'adapter_modules'),
])
def test_adapter_module_contract_blocks_untested_release(lifecycle, declaration, lines, success, error):
    import yaml
    files = package()
    if declaration is None:
        files['SKILL.md'] = files['SKILL.md'].replace('adapter_modules: []\n', '')
    else:
        files['SKILL.md'] = files['SKILL.md'].replace('adapter_modules: []',
            'adapter_modules: ' + yaml.safe_dump(declaration, default_flow_style=True).strip())
    files['scripts/parcel.py'] = '# external response conversion\n' * lines
    pending = lifecycle.stage('fixture-tool', files)['pending_id']
    result = lifecycle.test(pending)
    assert result['success'] is success, result
    if success:
        assert lifecycle.promote(pending)['success']
    else:
        assert error in result['verification']['error']
        with pytest.raises(ValueError, match='pass testing'):
            lifecycle.promote(pending)
        assert lifecycle.status('fixture-tool')['installed'] is False


@pytest.mark.parametrize('action', ['build', 'install'])
def test_workshop_promotes_directly_to_production_and_reverts_without_staging(lifecycle, tmp_path, monkeypatch, action):
    from types import SimpleNamespace
    monkeypatch.syspath_prepend(str(REPO / 'integrations/hermes'))
    from personal_aios import workshop
    from hermes_cli import config
    from gateway import run_scope
    from hermes_constants import get_hermes_home, set_hermes_home_override, reset_hermes_home_override
    from tools import skill_ledger
    production = get_hermes_home()
    handlers, calls = {}, []
    files = package()
    monkeypatch.delenv('PAIOS_RELEASE_SPOOL', raising=False)
    monkeypatch.setattr(run_scope, 'current_scope', lambda: 'build')
    monkeypatch.setattr(config, 'load_config', lambda: {'personal_aios': {'builder_url': 'https://builder.invalid'}})

    def remote(route, body, service):
        calls.append(route)
        if route in {'/build', '/hub'}:
            if route == '/build':
                assert body['files'] == ({} if files == package() else package())
            else:
                assert body == {'action': 'install', 'value': 'fixture/fixture-tool'}
            return {'name': 'fixture-tool', 'files': files}
        assert route == '/test', 'Package release must not invoke the product-release pipeline'
        test_root = tmp_path / 'isolated-verifier'
        for name, content in body.items():
            target = test_root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        return lifecycle.verifier(test_root)

    monkeypatch.setattr(workshop, 'builder_request', remote)
    workshop.register(SimpleNamespace(register_tool=lambda name, toolset, schema, fn: handlers.update({name: fn})))
    def hub(operation, value, **extra):
        return json.loads(handlers['skills_hub']({'action': operation, 'value': value, **extra}))

    token = set_hermes_home_override(production / 'workshop')
    try:
        candidate = hub(action, 'Build the fixture.' if action == 'build' else 'fixture/fixture-tool', name='fixture-tool')
        pending = candidate['pending_id']
        root = production / 'skills/workshop/fixture-tool'
        assert candidate['promoted'] is False and not root.exists()
        with pytest.raises(ValueError, match='pass testing'):
            hub('promote', pending)
        assert hub('test', pending)['success'] and not root.exists()
        installed = hub('promote', pending)
        assert installed['success'] and (root / 'SKILL.md').read_text() == files['SKILL.md']
        assert hub('monitor', 'fixture-tool')['verification']['stdout'] == 'original\n'
        files = package('upgraded')
        changed = hub('build', 'Upgrade the fixture.', name='fixture-tool')['pending_id']
        assert hub('test', changed)['success']
        assert hub('promote', changed)['success']
        assert hub('monitor', 'fixture-tool')['verification']['stdout'] == 'upgraded\n'
        assert hub('revert', 'fixture-tool')['success']
        assert hub('monitor', 'fixture-tool')['verification']['stdout'] == 'original\n'
        assert hub('revert', 'fixture-tool')['success'] and not root.exists()
    finally:
        reset_hermes_home_override(token)
    assert not (production / 'workshop/skills').exists()
    assert not (tmp_path / 'staging').exists()
    assert calls == [('/build' if action == 'build' else '/hub'), '/test', '/test', '/build', '/test', '/test', '/test']
    assert [entry['action'] for entry in reversed(skill_ledger.list_entries())].count('tool-release') == 2
