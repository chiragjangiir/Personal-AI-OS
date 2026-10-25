"""The real release lifecycle with a recorded Compose boundary; fictional, content-free receipts only."""
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'deploy/cloud'))
import release
import release_build
import release_checks
from watchdog_platform import point
from watchdog_platform import Platform


@pytest.fixture
def stack(tmp_path, monkeypatch):
    calls = []
    host = release.Host({'root': str(tmp_path), 'stage': 'production', 'project': 'fictional', 'profiles': ['production']})
    host.state = tmp_path / 'state'
    host.state.mkdir()
    for name in ('old', 'candidate'):
        state = host.releases / name / '.release'
        state.mkdir(parents=True)
        (state / 'env').write_text('')
    old, candidate = host.releases / 'old', host.releases / 'candidate'
    (candidate / 'deploy/cloud').mkdir(parents=True)
    (candidate / 'deploy/cloud/release-hooks.json').write_bytes((ROOT / 'deploy/cloud/release-hooks.json').read_bytes())
    point(tmp_path, 'current', old)
    images = {role: 'sha256:' + str(index) * 64 for index, role in enumerate(('gateway', 'hermes', 'workshop', 'watchdog'), 1)}
    release_build.write(candidate / '.release/accepted.json', {'commit': 'a' * 40, 'images': images})
    definition = {'services': {
        'postgres': {'command': ['postgres', '-p', '5432'], 'environment': {'POSTGRES_USER': 'fixture', 'POSTGRES_DB': 'fixture'}},
        'hermes': {'depends_on': {'gateway': {}}, 'volumes': [{'type': 'volume', 'source': 'legacy', 'target': '/opt/data'}]},
        'gateway': {}}, 'volumes': {'legacy': {'name': 'fictional-old-home'}}}
    monkeypatch.setattr(host, 'definition', lambda target: definition)
    state = SimpleNamespace(host=host, calls=calls, old=old, candidate=candidate, fail_import=False, fail_projection=False, projection_status='projected')

    def runner(target):
        def run(args, **options):
            calls.append((target.name, args, host.release('current').name))
            result = {}
            if 'mac-product-provision.ts' in ' '.join(args):
                result = {'core_profile': {'status': 'completed', 'assertions': ['digest-id'], 'entries': 1, 'replayed': False}}
                if target == candidate and state.fail_import:
                    result = {'core_profile': {'status': 'failed', 'partial_import': {'assertions': ['digest-id'], 'checkpoint_written': False}}}
                    raise subprocess.CalledProcessError(1, args, output=json.dumps(result).encode())
            elif 'core-profile-release.ts' in ' '.join(args):
                result = {'status': state.projection_status, 'files': [], 'assertions': []}
                if state.fail_projection:
                    raise subprocess.CalledProcessError(1, args, output=b'{"status":"failed","code":"CORE_PROFILE_RELEASE_FAILED"}')
            return SimpleNamespace(stdout=json.dumps(result).encode())
        return run
    monkeypatch.setattr(host, 'runner', runner)
    monkeypatch.setattr(release_build, 'image_id', lambda image: image)
    monkeypatch.setattr(release, 'candidate_env', lambda *a: None)
    monkeypatch.setattr(release, 'render', lambda *a: None)
    monkeypatch.setattr(release, 'front', lambda *a: {'changed': False})
    monkeypatch.setattr(release, 'watchdog_record', lambda *a: None)
    monkeypatch.setattr(release_checks, 'drain', lambda *a: {'passed': True})
    monkeypatch.setattr(release_checks, 'wait_health', lambda *a: {'gateway_healthy': True})
    monkeypatch.setattr(release_checks, 'native_ready', lambda *a: {'official_native_ready': True})
    monkeypatch.setattr(release_checks, 'postcheck', lambda *a, **k: {'passed': True})
    return state


def matching(calls, fragment):
    return [index for index, (_, args, _) in enumerate(calls) if fragment in ' '.join(args)]


def test_switch_migrates_with_candidate_after_stop_and_flip_before_either_writer_starts(stack, tmp_path):
    with (tmp_path / 'lock').open('a') as lock:
        receipt = release.switch(stack.host, stack.candidate, lock)
    migration = matching(stack.calls, 'mac-product-provision.ts')[0]
    assert matching(stack.calls, 'stop -t 120 gateway hermes workshop workshop-link')[0] < migration
    assert stack.calls[migration][0::2] == ('candidate', 'candidate')
    assert migration < matching(stack.calls, 'up -d --no-deps --no-build --pull never gateway')[0]
    assert migration < matching(stack.calls, '--wait hermes')[0]
    assert receipt['migration']['core_profile']['assertions'] == ['digest-id']
    assert not matching(stack.calls, 'core-profile-release.ts')


@pytest.mark.parametrize('projection_status', ['projected', 'preserved'])
def test_import_failure_keeps_partial_evidence_and_projects_before_immediate_old_start(stack, tmp_path, projection_status):
    stack.projection_status = projection_status
    stack.fail_import = True
    with (tmp_path / 'lock').open('a') as lock, pytest.raises(subprocess.CalledProcessError):
        release.switch(stack.host, stack.candidate, lock)
    assert stack.host.release('current') == stack.old
    projected = matching(stack.calls, 'core-profile-release.ts')[0]
    assert stack.calls[projected][0::2] == ('candidate', 'candidate')
    assert 'fictional-old-home:/opt/paios-rollback-native:rw' in stack.calls[projected][1]
    assert stack.calls[projected][1][stack.calls[projected][1].index('--user') + 1] == '0:0'
    assert projected < matching(stack.calls, 'mac-product-provision.ts')[1]
    receipt = json.loads(next((stack.candidate / '.release').glob('switch-*.json')).read_text())
    assert receipt['migration']['core_profile']['partial_import']['assertions'] == ['digest-id']
    assert receipt['immediate_rollback']['memory_projection']['status'] == projection_status
    assert any(name == 'old' and args[0] == 'up' and 'hermes' in args for name, args, _ in stack.calls)


def test_manual_rollback_uses_newer_projection_and_older_start_and_skips_releases_without_declaration(stack):
    stack.host.flip(stack.candidate)
    receipt = release.rollback(stack.host, 'manual')
    assert receipt['memory_projection']['status'] == 'projected'
    assert matching(stack.calls, 'core-profile-release.ts')[0] < matching(stack.calls, 'mac-product-provision.ts')[0]
    stack.calls.clear()
    release.rollback(stack.host, 'manual')
    assert not matching(stack.calls, 'core-profile-release.ts')


def test_projection_failure_keeps_pointers_and_old_writers_stopped_and_persists_switch_failure(stack, tmp_path):
    stack.fail_import = stack.fail_projection = True
    with (tmp_path / 'lock').open('a') as lock, pytest.raises(subprocess.CalledProcessError):
        release.switch(stack.host, stack.candidate, lock)
    assert stack.host.release('current') == stack.candidate
    assert not any(name == 'old' and args[0] == 'up' for name, args, _ in stack.calls)
    receipt = json.loads(next((stack.candidate / '.release').glob('switch-*.json')).read_text())
    assert receipt['migration']['core_profile']['partial_import']['assertions'] == ['digest-id']
    assert receipt['immediate_rollback']['memory_projection']['status'] == 'failed'
    assert (stack.candidate / '.release/rollback-failed.json').exists()


def test_pre_flip_failure_restarts_old_without_projection_or_candidate_import(stack, tmp_path, monkeypatch):
    stop = release.stop_writers
    def interrupted(host, run):
        stop(host, run)
        raise RuntimeError('FICTIONAL_STOP_FAILED')
    monkeypatch.setattr(release, 'stop_writers', interrupted)
    with (tmp_path / 'lock').open('a') as lock, pytest.raises(RuntimeError, match='FICTIONAL_STOP_FAILED'):
        release.switch(stack.host, stack.candidate, lock)
    assert stack.host.release('current') == stack.old
    assert not matching(stack.calls, 'core-profile-release.ts')
    assert all(name == 'old' for name, args, _ in stack.calls if 'mac-product-provision.ts' in ' '.join(args))


@pytest.mark.parametrize('fails', [False, True])
def test_watchdog_stops_writers_and_uses_the_same_declared_projection_before_any_pointer_swap(stack, tmp_path, monkeypatch, fails):
    stack.host.flip(stack.candidate)
    calls, executed = [], []
    def compose(command, **options):
        calls.append(command)
        assert stack.host.release('current') == stack.candidate
        if 'config' in command:
            return SimpleNamespace(stdout=json.dumps(stack.host.definition(stack.old)))
        if 'core-profile-release.ts' in ' '.join(command):
            assert 'fictional-old-home:/opt/paios-rollback-native:rw' in command
            assert command[command.index('--env-file') + 1] == str(stack.candidate / '.release/env')
            if fails:
                raise subprocess.CalledProcessError(1, command, output=b'{"status":"failed","code":"CORE_PROFILE_RELEASE_FAILED"}')
        return SimpleNamespace(stdout=b'{"status":"projected"}')
    monkeypatch.setattr(release.subprocess, 'run', compose)
    monkeypatch.setattr(release.os, 'execvpe', lambda *args: executed.append(args))
    record = {'root': str(tmp_path), 'candidate_release': str(stack.candidate), 'previous_release': str(stack.old),
              'project': 'fictional', 'profile': 'production', 'profiles': ['production', 'edge-forward'],
              'previous_compose': str(stack.old / '.release/prepared.json'), 'services': [{'service': 'gateway'}]}
    platform = Platform(tmp_path)
    with (tmp_path / 'lock').open('a') as lock:
        platform.lock = lock
        if fails:
            with pytest.raises(subprocess.CalledProcessError):
                platform.rollback(record)
        else:
            platform.rollback(record)
    assert matching([('', command, '') for command in calls], 'stop -t 120 gateway hermes workshop workshop-link')[0] < matching(
        [('', command, '') for command in calls], 'core-profile-release.ts')[0]
    assert not matching([('', command, '') for command in calls], 'stop frpc')
    assert stack.host.release('current') == (stack.candidate if fails else stack.old)
    assert len(executed) == (0 if fails else 1)
    result = json.loads((stack.candidate / '.release/watchdog-memory-projection.json').read_text())
    assert result['memory_projection']['status'] == ('failed' if fails else 'projected')
