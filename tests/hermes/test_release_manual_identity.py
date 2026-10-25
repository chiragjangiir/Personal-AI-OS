"""Manual releases on a host without the self-repair exchange; Docker/systemd are the boundary."""
import json
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from pathlib import Path
import subprocess
from types import SimpleNamespace

import pytest

from test_release import IMAGE, repo  # noqa: F401
import release
import release_identity
import release_transfer
from watchdog_platform import point


@pytest.fixture
def production(tmp_path, monkeypatch, repo):
    root, state = tmp_path / 'paios', tmp_path / 'watchdog'
    source = {'schema': 'paios.release-source.v1', 'commit': repo.base,
              'tree': 'f' * 40, 'adopted_at': '2026-10-24T03:00:00Z'}
    for name in ('old', 'candidate'):
        folder = root / 'releases' / name / '.release'
        folder.mkdir(parents=True)
        release.release_build.write(folder / 'source.json', source)
        (folder / 'env').write_text('PAIOS_GATEWAY_IMAGE=old\n')
    candidate = root / 'releases/candidate'
    release.release_build.write(candidate / '.release/accepted.json', {'commit': repo.base, 'images': IMAGE})
    point(root, 'current', root / 'releases/old')
    settings = tmp_path / 'snapshot-settings.json'
    settings.write_text(json.dumps({'role': 'production', 'window_hours': 0, 'spool': str(tmp_path / 'snapshots')}))
    config = {'auto_switch': False, 'image_roles': ['gateway', 'hermes', 'workshop', 'watchdog'],
              'profiles': ['production', 'edge-forward'], 'project': 'paios', 'root': str(root),
              'stage': 'production', 'timing': None, 'repo': str(repo.bare), 'snapshot_settings': str(settings)}
    host = release.Host(config)
    cloud = tmp_path / 'cloud.json'
    cloud.write_text('{"product_resources": {}, "payment": {"enabled": true}}')
    services = {name: {} for name in ('gateway', 'hermes', 'front', 'workshop', 'workshop-link',
                                     'release-watchdog', 'postgres', 'livekit', 'frpc',
                                     'owner-mac-relay', 'owner-mac-visitor', 'cold-webdav')}
    services['gateway']['volumes'] = [{'source': str(cloud), 'target': '/etc/paios/cloud.json'}]
    services['hermes']['depends_on'] = {'gateway': {'condition': 'service_healthy'}}
    services['release-watchdog']['volumes'] = [{'source': str(state), 'target': '/watchdog'}]
    services['postgres'].update(command=['postgres', '-p', '5432'],
                                environment={'POSTGRES_USER': 'fixture', 'POSTGRES_DB': 'fixture'})
    calls = []
    def runner(selected):
        def run(args, **kwargs):
            calls.append((selected.name, args))
            return SimpleNamespace(stdout=json.dumps({'services': services}) if args[0] == 'config' else '')
        return run
    monkeypatch.setattr(host, 'runner', runner)
    images = {**IMAGE, 'release-watchdog': IMAGE['watchdog'], 'workshop-link': IMAGE['workshop'],
              **{name: 'sha256:' + str(index) * 64 for index, name in enumerate(
                  ('postgres', 'livekit', 'frpc', 'owner-mac-relay', 'owner-mac-visitor', 'cold-webdav'), 1)}}
    rows = [{'Config': {'Labels': {'com.docker.compose.service': name}}, 'Image': images[name],
             'State': {'Running': True, 'Status': 'running'}} for name in services]
    monkeypatch.setattr(release.release_checks, 'containers', lambda run: rows)
    monkeypatch.setattr(release.release_checks, 'inside', lambda *args: {
        'native_tree': 'native-tree', 'skill_catalog': 'skills', 'package_registry': 'packages',
        'native_config_version': 46, 'native_latest_config_version': 46})
    monkeypatch.setattr(release.release_checks, 'drain', lambda *args: {'passed': True})
    monkeypatch.setattr(release.release_checks, 'wait_health', lambda *args: {'health': 'ready'})
    monkeypatch.setattr(release.release_checks, 'native_ready', lambda *args: {'official_native_ready': True})
    monkeypatch.setattr(release.release_checks, 'postcheck', lambda *args, **kwargs: {'passed': True})
    monkeypatch.setattr(release.release_build, 'image_id', lambda image: image)
    monkeypatch.setattr(release, 'render', lambda *args: None)
    monkeypatch.setattr(release, 'front', lambda *args: {'changed': False})
    system_calls = []
    original_run = subprocess.run
    def system(command, **kwargs):
        if command[0] == 'git':
            return original_run(command, **kwargs)
        system_calls.append(command)
        if command[0] == 'systemctl':
            return SimpleNamespace(stdout='ActiveState=failed\nInvocationID=fixture-invocation\n', returncode=0)
        if command[0] == 'journalctl':
            assert '_SYSTEMD_INVOCATION_ID=fixture-invocation' in command
            return SimpleNamespace(stdout='ValueError: SNAPSHOT_CAPACITY: scratch bytes; fixture-private-detail\n',
                                   returncode=0)
        raise AssertionError(command)
    monkeypatch.setattr(subprocess, 'run', system)
    monkeypatch.setattr(release_transfer, 'save', lambda *args: pytest.fail('manual identity must not save images'))
    monkeypatch.setattr(release_transfer, 'rsync', lambda *args: pytest.fail('no exchange is bound'))
    return SimpleNamespace(host=host, state=state, source=source, candidate=candidate, calls=calls,
                           system_calls=system_calls, settings=settings, rows=rows, services=services, images=images)


@pytest.fixture
def production_no_watchdog(production):
    p = production
    p.rows[:] = [row for row in p.rows if row['Config']['Labels']['com.docker.compose.service'] != 'release-watchdog']
    release.release_build.write(p.host.release('current') / '.release/accepted.json',
                                {'commit': p.source['commit'], 'images': IMAGE})
    return p


@pytest.mark.parametrize('dry_run', [False, True])
def test_manual_identity_records_production_without_a_watchdog(production_no_watchdog, capsys, dry_run):
    p = production_no_watchdog
    assert len(p.host.config) == 9 and p.host.config['timing'] is None
    assert not list(Path(json.loads(p.settings.read_text())['spool']).glob('snapshot-*.json'))
    release.cmd_identity(p.host, SimpleNamespace(dry_run=dry_run))
    value = json.loads(capsys.readouterr().out)
    assert value['images'] == {role: image for role, image in IMAGE.items() if role != 'watchdog'}
    assert value['inactive_roles'] == {'watchdog': {'running': False, 'reason': 'not_started_timing_null'}}
    expected = {name: image for name, image in p.images.items() if name in p.services and name != 'release-watchdog'}
    assert value['service_images'] == {name: image for name, image in expected.items() if name in release_identity.SERVICES}
    assert value['auxiliary_service_images'] == {name: image for name, image in expected.items()
                                                if name not in release_identity.SERVICES}
    assert value['commit'] == p.source['commit'] and value['source'] == p.source
    assert value['snapshot_at'] is None and value['snapshot']['status'] == 'unavailable'
    assert 'sync' not in value and 'closed_requests' not in value
    path = p.state / 'production.json'
    if dry_run:
        assert not path.exists()
    else:
        assert json.loads(path.read_text()) == value and path.stat().st_mode & 0o777 == 0o600
    assert p.host.release('current').name == 'old' and not (p.host.root / 'previous').exists()


@pytest.mark.parametrize('status', ['created', 'exited'])
def test_manual_identity_never_reports_a_stopped_watchdog_image(production_no_watchdog, capsys, status):
    p = production_no_watchdog
    p.rows.append({'Config': {'Labels': {'com.docker.compose.service': 'release-watchdog'}},
                   'Image': IMAGE['watchdog'], 'State': {'Running': False, 'Status': status}})
    release.cmd_identity(p.host, SimpleNamespace(dry_run=False))
    value = json.loads(capsys.readouterr().out)
    assert 'watchdog' not in value['images'] and 'release-watchdog' not in value['service_images']
    assert value['inactive_roles'] == {'watchdog': {'running': False, 'reason': 'container_' + status}}


@pytest.mark.parametrize('timing', ['enabled', 'absent'])
def test_manual_identity_does_not_guess_why_a_watchdog_is_absent(production_no_watchdog, capsys, timing):
    p = production_no_watchdog
    if timing == 'enabled':
        p.host.config['timing'] = '/fixture/timing.json'
    else:
        del p.host.config['timing']
    release.cmd_identity(p.host, SimpleNamespace(dry_run=False))
    value = json.loads(capsys.readouterr().out)
    assert value['inactive_roles'] == {'watchdog': {'running': False, 'reason': 'no_running_container'}}


def test_manual_identity_lists_every_absent_role_and_scopes_container_observation(production_no_watchdog, capsys):
    p = production_no_watchdog
    p.rows[:] = [row for row in p.rows if row['Config']['Labels']['com.docker.compose.service'] != 'workshop']
    p.services['release-watchdog-staging'] = {}
    for name in ('release-watchdog-staging', 'unrelated'):
        p.rows.append({'Config': {'Labels': {'com.docker.compose.service': name}},
                       'Image': IMAGE['watchdog'], 'State': {'Running': True, 'Status': 'running'}})
    release.cmd_identity(p.host, SimpleNamespace(dry_run=False))
    value = json.loads(capsys.readouterr().out)
    assert value['inactive_roles'] == {'watchdog': {'running': False, 'reason': 'not_started_timing_null'},
                                       'workshop': {'running': False, 'reason': 'no_running_container'}}
    assert set(value['images']) == {'gateway', 'hermes', 'front'}
    assert 'unrelated' not in value['auxiliary_service_images']
    assert 'release-watchdog' not in value['service_images']


@pytest.mark.parametrize('stopped', [False, True])
def test_ship_still_refuses_a_missing_or_stopped_watchdog_with_all_bindings(production_no_watchdog, monkeypatch, capsys, stopped):
    p = production_no_watchdog
    if stopped:
        p.rows.append({'Config': {'Labels': {'com.docker.compose.service': 'release-watchdog'}},
                       'Image': IMAGE['watchdog'], 'State': {'Running': False, 'Status': 'exited'}})
    release.cmd_identity(p.host, SimpleNamespace(dry_run=False))
    capsys.readouterr()
    recorded = (p.state / 'production.json').read_bytes()
    p.host.config.update(spool=str(p.host.root / 'spool'), incoming=str(p.host.root / 'incoming'),
                         exchange_remote='fixture@builder:/exchange/', auto_switch=True)
    path = Path(json.loads(p.settings.read_text())['spool']) / 'snapshot-20261025T000000Z.json'
    path.parent.mkdir()
    path.write_text('{"as_of": "2026-10-25T00:00:00Z"}')
    monkeypatch.setattr(release, 'ship_package', lambda *args: pytest.fail('ship must refuse before switching'))
    monkeypatch.setattr(release_transfer, 'fetch', lambda *args: pytest.fail('ship must refuse before fetching'))
    with pytest.raises(ValueError, match='RELEASE_ROLE_NOT_RUNNING: watchdog'):
        release.cmd_ship(p.host, None)
    assert (p.state / 'production.json').read_bytes() == recorded
    assert p.host.release('current').name == 'old' and not (p.host.root / 'previous').exists()
    assert not any(args[0] in ('stop', 'up') for _, args in p.calls)


@pytest.mark.parametrize('dry_run', [False, True])
def test_manual_identity_records_actual_release_without_self_repair_bindings(production, capsys, dry_run):
    p = production
    release.cmd_identity(p.host, SimpleNamespace(dry_run=dry_run))
    value = json.loads(capsys.readouterr().out)
    assert value['commit'] == p.source['commit'] and value['release'] == 'old'
    assert value['images'] == IMAGE and value['source'] == p.source
    assert value['inactive_roles'] == {}
    assert value['snapshot_at'] is None
    assert value['snapshot']['status'] == 'unavailable'
    assert value['snapshot']['failure_class'] == 'SNAPSHOT_CAPACITY'
    assert value['snapshot']['receipt_failure_class'] == 'PRODUCTION_SNAPSHOT_RECEIPT_MISSING'
    assert 'fixture-private-detail' not in json.dumps(value)
    assert 'closed_requests' not in value and 'sync' not in value
    path = p.state / 'production.json'
    if dry_run:
        assert not path.exists()
    else:
        assert json.loads(path.read_text()) == value and path.stat().st_mode & 0o777 == 0o600
    assert p.host.release('current').name == 'old' and not (p.host.root / 'previous').exists()


def test_dry_run_has_same_facts_and_preserves_the_existing_record(production, capsys):
    p = production
    release.cmd_identity(p.host, SimpleNamespace(dry_run=False))
    actual = json.loads(capsys.readouterr().out)
    before = (p.state / 'production.json').read_bytes()
    release.cmd_identity(p.host, SimpleNamespace(dry_run=True))
    planned = json.loads(capsys.readouterr().out)
    assert {k: v for k, v in actual.items() if k != 'published_at'} == {
        k: v for k, v in planned.items() if k != 'published_at'}
    assert (p.state / 'production.json').read_bytes() == before


def test_manual_switch_and_rollback_need_only_production_keys(production, capsys):
    p = production
    release.cmd_switch(p.host, SimpleNamespace(release='candidate', accepted=None, front_sha=None, copy_secrets=False))
    receipt = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert receipt['watchdog'] is None
    assert p.host.release('current') == p.candidate and p.host.release('previous').name == 'old'
    release.cmd_rollback(p.host, None)
    assert p.host.release('current').name == 'old' and p.host.release('previous') == p.candidate
    assert [name for name, args in p.calls if args[0] == 'up' and args[-1] == 'gateway'] == ['candidate', 'old']
    assert not p.system_calls, 'timing=null must not read owner, units or invoke watchdog-record'
    assert any(args[:2] == ['stop', 'frpc'] for _, args in p.calls)


@pytest.mark.parametrize('missing', ['spool', 'incoming', 'exchange_remote', 'snapshot_settings', 'repo'])
def test_ship_still_refuses_missing_bindings_before_switch(production, monkeypatch, missing):
    p = production
    p.host.config.update(spool=str(p.host.root / 'spool'), incoming=str(p.host.root / 'incoming'),
                         exchange_remote='fixture@builder:/exchange/')
    if missing != 'snapshot_settings':
        settings = json.loads(p.settings.read_text())
        path = Path(settings['spool']) / 'snapshot-20261025T000000Z.json'
        path.parent.mkdir()
        path.write_text('{"as_of": "2026-10-25T00:00:00Z"}')
    del p.host.config[missing]
    monkeypatch.setattr(release, 'ship_package', lambda *args: pytest.fail('unbound ship must not switch'))
    # Stop at the image-save boundary only after real transfer code has read required bindings.
    monkeypatch.setattr(release_transfer, 'save', lambda refs, path, guard: path.write_bytes(b'fixture-archive'))
    monkeypatch.setattr(release_transfer.release_inventory, 'export', lambda *args: {'file': 'sync/inventory', 'sha256': 'x'})
    monkeypatch.setattr(release_transfer, 'rsync', lambda *args: None)
    with pytest.raises(KeyError, match=missing):
        release.cmd_ship(p.host, None)
    assert p.host.release('current').name == 'old' and not (p.host.root / 'previous').exists()
    assert not any(args[0] == 'stop' for _, args in p.calls)


@pytest.mark.parametrize('receipt', [None, '{"as_of": "bad"}', '{"as_of": 1}', '{"as_of": "2026-10-25T00:00:00"}'])
def test_ship_still_requires_valid_snapshot(production, receipt):
    p = production
    p.host.config.update(spool=str(p.host.root / 'spool'), incoming=str(p.host.root / 'incoming'),
                         exchange_remote='fixture@builder:/exchange/')
    if receipt:
        path = Path(json.loads(p.settings.read_text())['spool']) / 'snapshot-20261025T000000Z.json'
        path.parent.mkdir()
        path.write_text(receipt)
    with pytest.raises(ValueError):
        release.cmd_ship(p.host, None)
    assert p.host.release('current').name == 'old' and not any(args[0] == 'stop' for _, args in p.calls)


def test_publish_without_exchange_does_not_read_incoming(production):
    release_transfer.publish(production.host.config, {'commit': production.source['commit']})


def test_manual_identity_keeps_native_observation_failures_visible(production, monkeypatch):
    def failed(*args):
        raise ValueError('NATIVE_NOT_READY')
    monkeypatch.setattr(release_identity.release_checks, 'inside', failed)
    with pytest.raises(ValueError, match='NATIVE_NOT_READY'):
        release.cmd_identity(production.host, SimpleNamespace(dry_run=False))
    assert not (production.state / 'production.json').exists()


@pytest.mark.parametrize('age_hours', [37, -1])
def test_self_repair_restore_still_rejects_stale_or_future_snapshots(tmp_path, monkeypatch, age_hours):
    import staging_snapshot_restore as restore
    class Stack:
        def maintenance(self, lock):
            return nullcontext()
        def tools(self, *args, **kwargs):
            pytest.fail('invalid snapshot must not reach restore operations')
    monkeypatch.setattr(restore, 'Stack', lambda *args, **kwargs: Stack())
    monkeypatch.setattr(restore, 'preflight', lambda *args: {})
    def decrypt(snapshot, identity, work):
        release.release_build.write(work / 'manifest.json', {
            'schema': 'paios.staging-snapshot.v1', 'window_hours': 0,
            'consistency': 'all-application-writers-stopped',
            'as_of': (datetime.now(timezone.utc) - timedelta(hours=age_hours)).isoformat()})
    monkeypatch.setattr(restore, 'decrypt', decrypt)
    snapshot = tmp_path / 'snapshot-20261025T000000Z.age'
    snapshot.write_bytes(b'fixture-envelope')
    with pytest.raises(ValueError, match='Snapshot is stale or from the future'):
        restore.restore({'evidence': str(tmp_path / 'evidence'), 'scratch': str(tmp_path), 'identity_file': 'fixture'},
                        snapshot, True)


@pytest.mark.parametrize('failure', ['systemd_unavailable', 'unit_active'])
def test_manual_snapshot_does_not_invent_a_capture_failure(production, monkeypatch, capsys, failure):
    def system(command, **kwargs):
        if failure == 'systemd_unavailable':
            raise subprocess.CalledProcessError(1, command, stderr='fixture-private-detail')
        assert command[0] == 'systemctl', 'an active unit must not use a previous failed invocation'
        return SimpleNamespace(stdout='ActiveState=active\nInvocationID=current\n')
    monkeypatch.setattr(subprocess, 'run', system)
    release.cmd_identity(production.host, SimpleNamespace(dry_run=False))
    value = json.loads(capsys.readouterr().out)
    assert value['snapshot']['failure_class'] == 'PRODUCTION_SNAPSHOT_RECEIPT_MISSING'
    assert 'failure_source' not in value['snapshot'] and 'invocation_id' not in value['snapshot']
    assert 'fixture-private-detail' not in json.dumps(value)


def test_manual_identity_uses_valid_receipt_without_reading_the_service(production, capsys):
    path = Path(json.loads(production.settings.read_text())['spool']) / 'snapshot-20261025T000000Z.json'
    path.parent.mkdir()
    path.write_text('{"as_of": "2026-10-25T00:00:00Z"}')
    release.cmd_identity(production.host, SimpleNamespace(dry_run=False))
    value = json.loads(capsys.readouterr().out)
    assert value['snapshot'] == {'status': 'available'}
    assert value['snapshot_at'] == '2026-10-25T00:00:00+00:00'
    assert not production.system_calls


@pytest.mark.parametrize('dry_run', [False, True])
def test_manual_identity_does_not_create_a_missing_snapshot_binding(production, capsys, dry_run):
    del production.host.config['snapshot_settings']
    release.cmd_identity(production.host, SimpleNamespace(dry_run=dry_run))
    value = json.loads(capsys.readouterr().out)
    assert value['snapshot_at'] is None and value['snapshot']['status'] == 'unavailable'
    assert value['snapshot']['receipt_failure_class'] == 'KeyError'
    assert 'snapshot_settings' not in production.host.config and 'sync' not in value


@pytest.mark.parametrize('receipt', ['{', '{}', '{"as_of": 1}', '{"as_of": "private-invalid-date"}'])
def test_manual_identity_records_invalid_receipt_without_copying_its_contents(production, capsys, receipt):
    path = Path(json.loads(production.settings.read_text())['spool']) / 'snapshot-20261025T000000Z.json'
    path.parent.mkdir()
    path.write_text(receipt)
    release.cmd_identity(production.host, SimpleNamespace(dry_run=False))
    value = json.loads(capsys.readouterr().out)
    assert value['snapshot_at'] is None and value['snapshot']['status'] == 'unavailable'
    assert 'private-invalid-date' not in json.dumps(value)
