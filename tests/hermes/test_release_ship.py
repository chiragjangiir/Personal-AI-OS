"""依米's last mile: package transfer, production's idle auto-switch, owner notices and her 「改回去」.

Real Git, real tar archives and real files; Docker, Compose and the gateway are the fake boundary.
"""
import io
import json
import os
from pathlib import Path
import pwd
import tarfile
from types import SimpleNamespace

import pytest

from test_release import IMAGE, Stack, git, repo  # noqa: F401  (repo is a fixture; this import puts deploy/cloud on the path)
import release
import release_build
import release_checks
import release_transfer

REAL_NOTICE = release_checks.notice


def oci(path, members):
    with tarfile.open(path, 'w') as archive:
        for name, data in members.items():
            item = tarfile.TarInfo(name)
            item.size = len(data)
            archive.addfile(item, io.BytesIO(data))


def test_package_round_trip_reuses_production_layers_and_loads_only_verified_ids(tmp_path, repo, monkeypatch):
    """Build host: delta against production's images. Production: digest, merge from its own images, ID check."""
    (repo.work / 'integrations/tool.py').write_text('x = 3\n')
    git(repo.work, 'commit', '-q', '-am', 'fix the dropped reply')
    commit = git(repo.work, 'rev-parse', 'HEAD')
    git(repo.work, 'push', '-q', str(repo.bare), f'HEAD:refs/paios/candidates/0123456789ab')
    exchange = tmp_path / 'exchange'
    exchange.mkdir()
    production_images = {'gateway': 'sha256:' + '1' * 64}
    (exchange / 'production.json').write_text(json.dumps({'commit': repo.base, 'release': 'base', 'images': production_images}))
    cand = tmp_path / 'cand'
    (cand / '.release').mkdir(parents=True)
    release_build.write(cand / '.release/accepted.json', {'commit': commit, 'images': IMAGE})
    release_build.write(cand / '.release/build.json', {'images': {r: {'id': IMAGE[r], 'tag': f'paios-{r}:r-x'} for r in IMAGE}})
    shared, new = b'L' * 4096, b'N' * 512
    def fake_save(refs, output, guard):
        if refs == sorted(production_images.values()):
            oci(output, {'blobs/sha256/shared': shared, 'index.json': b'{"old":1}'})
        else:
            oci(output, {'blobs/sha256/shared': shared, 'blobs/sha256/new': new, 'index.json': b'{"new":1}'})
    monkeypatch.setattr(release_transfer, 'save', fake_save)
    monkeypatch.setattr(release_transfer, 'present', lambda image: image in production_images.values())
    config = {'exchange': str(exchange), 'exchange_owner': pwd.getpwuid(os.getuid()).pw_name, 'repo': str(repo.bare),
              'transfer_scratch': str(tmp_path / 'scratch')}
    result = {'request_id': '0123456789ab', 'commit': commit, 'base': repo.base, 'ready_for_production': True}
    exported = release_transfer.export(config, cand, result, 'fix the dropped reply')
    package = Path(exported['package'])
    assert exported['reused_bytes'] == len(shared)
    with tarfile.open(package / 'delta.tar') as delta:
        assert 'blobs/sha256/shared' not in delta.getnames() and 'blobs/sha256/new' in delta.getnames()
    assert not list(exchange.glob('candidates/.*')), 'a package appears atomically'
    with pytest.raises(ValueError, match='PRESERVE_EXISTING_PACKAGE'):
        release_transfer.export(config, cand, result, 'again')

    # Production side.
    loaded = io.BytesIO()
    class Load:
        def __init__(self, command, **options):
            assert command[-2:] == ['docker', 'load']
            self.stdin = SimpleNamespace(write=loaded.write, close=lambda: None)
        def wait(self):
            state['loaded'] = True
            return 0
    state = {'loaded': False}
    monkeypatch.setattr(release_transfer.subprocess, 'Popen', Load)
    monkeypatch.setattr(release_transfer, 'present', lambda image: image in production_images.values() or state['loaded'])
    assert release_transfer.load(config, package)['loaded'] is True
    loaded.seek(0)
    with tarfile.open(fileobj=loaded) as merged:
        assert {m.name: merged.extractfile(m).read() for m in merged} == {
            'blobs/sha256/shared': shared, 'blobs/sha256/new': new, 'index.json': b'{"new":1}'}
    # A changed byte, a forged manifest or a different loaded ID never passes.
    manifest = json.loads((package / 'manifest.json').read_text())
    (package / 'manifest.json').write_text(json.dumps({**manifest, 'images': {**IMAGE, 'gateway': 'sha256:' + 'f' * 64}}))
    with pytest.raises(ValueError, match='TRANSFER_MANIFEST_MISMATCH'):
        release_transfer.load(config, package)
    (package / 'manifest.json').write_text(json.dumps({**manifest, 'delta_sha256': '0' * 64}))
    with pytest.raises(ValueError, match='TRANSFER_DIGEST_MISMATCH'):
        release_transfer.load(config, package)
    (package / 'manifest.json').write_text(json.dumps(manifest))
    monkeypatch.setattr(release_transfer, 'present', lambda image: image != IMAGE['hermes'])
    monkeypatch.setattr(release_transfer, 'save', lambda refs, output, guard: oci(output, {'blobs/sha256/shared': shared}))
    with pytest.raises(ValueError, match='TRANSFER_ID_MISMATCH: hermes'):
        release_transfer.load(config, package)


class Production(Stack):
    """Production: current = old (on the repo's base commit), a spool 依米 writes to, and one incoming agent package."""
    def __init__(self, tmp_path, monkeypatch, repo, change='integrations/tool.py', ready=True, base=None):
        super().__init__(tmp_path, monkeypatch)
        release_build.write(self.root / 'releases/old/.release/source.json', {'commit': repo.base})
        self.spool = tmp_path / 'spool'
        for name in ('rollback', 'status'):
            (self.spool / name).mkdir(parents=True)
        self.host.config.update(repo=str(repo.bare), spool=str(self.spool), incoming=str(tmp_path / 'incoming'), auto_switch=True,
                                owner={'principal_id': 'owner', 'device_id': 'phone'})
        (repo.work / change).write_text('changed\n')
        git(repo.work, 'commit', '-q', '-am', 'fix the dropped reply')
        self.commit = git(repo.work, 'rev-parse', 'HEAD')
        self.package = tmp_path / 'incoming/candidates/0123456789ab'
        self.package.mkdir(parents=True)
        git(repo.work, 'update-ref', 'refs/paios/candidates/0123456789ab', self.commit)
        git(repo.work, 'bundle', 'create', str(self.package / 'source.bundle'), 'refs/paios/candidates/0123456789ab', '^' + repo.base)
        release_build.write(self.package / 'manifest.json', {'request_id': '0123456789ab', 'commit': self.commit,
                                                             'base': base or repo.base, 'images': IMAGE})
        release_build.write(self.package / 'accepted.json', {'commit': self.commit, 'images': IMAGE})
        release_build.write(self.package / 'result.json', {'ready_for_production': ready})
        (self.package / 'delta.tar').write_bytes(b'')
        self.idle = True
        monkeypatch.setattr(release, 'idle', lambda host: self.idle)
        monkeypatch.setattr(release_transfer, 'load', lambda config, package: {'loaded': True})
        self.delivered = []
        monkeypatch.setattr(release_checks, 'notice', lambda run, suffix, body: self.delivered.append(body))
        monkeypatch.setattr(release_checks, 'containers', lambda run: [
            {'Config': {'Labels': {'com.docker.compose.service': name}},
             'State': {'Running': True, 'Status': 'running', 'OOMKilled': False}, 'RestartCount': 0}
            for name in ('gateway', 'hermes')])

    def status(self, name='0123456789ab'):
        return json.loads((self.spool / 'status' / (name + '.json')).read_text())

    def ship(self):
        with open(self.host.state / 'release.lock', 'a') as lock:
            return release.ship_package(self.host, lock, self.package)


def test_production_switches_a_verified_agent_candidate_only_when_idle_and_tells_the_owner(tmp_path, monkeypatch, repo):
    prod = Production(tmp_path, monkeypatch, repo)
    prod.idle = False
    assert prod.ship() == 'waiting_idle'
    assert prod.status()['state'] == 'waiting_idle' and prod.package.exists() and prod.pointers() == ('old', None)
    assert 'stop' not in prod.events
    prod.idle = True
    assert prod.ship() == 'switched'
    target = prod.root / 'releases' / prod.commit[:8]
    assert prod.pointers() == (prod.commit[:8], 'old') and prod.events.index('prepare') < prod.events.index('arm')
    status = prod.status()
    assert status['state'] == 'switched' and status['summary'] == 'fix the dropped reply' and not prod.package.exists()
    assert json.loads((target / '.release/request.json').read_text())['request_id'] == '0123456789ab'
    notice = json.loads(next((prod.host.state / 'notices').glob('release-shipped-*.json')).read_text())
    assert notice['id'] == 'release-shipped:' + status['release_id']
    assert notice['text'] == ('系统消息：依米修好了「fix the dropped reply」，已在空闲时上线（修复单 0123456789ab）。'
                              '新版本有自动回退保护；不满意的话，跟依米说一声想用回之前的版本就行。')
    assert notice['system_event'] == {'type': 'release_shipped', 'release_id': status['release_id'],
                                      'request_id': '0123456789ab', 'commit': prod.commit}
    release.deliver_notices(prod.host)
    assert [body['id'] for body in prod.delivered] == [notice['id']] and not list((prod.host.state / 'notices').glob('*.json'))


@pytest.mark.parametrize('kind', ['not_ready', 'stale_base', 'operator_only'])
def test_production_never_switches_protected_unready_stale_or_operator_only_candidates(tmp_path, monkeypatch, repo, kind):
    prod = Production(tmp_path, monkeypatch, repo, change='deploy/cloud/build.sh' if kind == 'protected' else 'integrations/tool.py',
                      ready=kind != 'not_ready', base='b' * 40 if kind == 'stale_base' else None)
    if kind == 'operator_only':
        prod.host.config['auto_switch'] = False
    state = prod.ship()
    assert prod.pointers() == ('old', None) and 'stop' not in prod.events and 'prepare' not in prod.events
    expected = {'protected': 'refused', 'not_ready': 'refused', 'stale_base': 'stale_base', 'operator_only': 'automatic_switch_disabled'}[kind]
    assert state == expected and prod.status()['state'] == expected
    if kind == 'protected':
        assert 'PROTECTED_PATHS' in prod.status()['reason'] and 'deploy/cloud/build.sh' in prod.status()['reason']
    assert prod.package.exists() == (kind == 'operator_only')


def test_owner_notice_stays_queued_until_the_gateway_returns_its_receipt(tmp_path, monkeypatch, repo):
    prod = Production(tmp_path, monkeypatch, repo)
    release.notice(prod.host, 'release-reverted', 'r1', '系统消息：已按你的要求换回上一个版本。', commit='c' * 40)
    monkeypatch.setattr(release_checks, 'notice', lambda run, suffix, body: (_ for _ in ()).throw(ValueError('NOTICE_NOT_ACCEPTED')))
    release.deliver_notices(prod.host)
    assert list((prod.host.state / 'notices').glob('*.json'))
    # The real adapter accepts only the gateway's delivered receipt for this exact id.
    body = {'id': 'release-reverted:r1'}
    run = lambda args, **options: SimpleNamespace(stdout=json.dumps({'status': 'delivered', 'system_event_id': 'release-reverted:r1'}))
    assert REAL_NOTICE(run, '', body)['status'] == 'delivered'
    run = lambda args, **options: SimpleNamespace(stdout=json.dumps({'status': 'delivered'}))
    with pytest.raises(ValueError, match='NOTICE_NOT_ACCEPTED'):
        REAL_NOTICE(run, '', body)


def test_gai_hui_qu_rolls_back_the_latest_switch_at_idle_once_and_refuses_otherwise(tmp_path, monkeypatch, repo):
    prod = Production(tmp_path, monkeypatch, repo)
    assert prod.ship() == 'switched'
    (prod.spool / 'rollback/aaaaaaaaaaaa.json').write_text('{"reason": "改回去"}')
    prod.idle = False
    assert release.rollback_requests(prod.host) == 'waiting_idle'
    assert prod.status('rollback-aaaaaaaaaaaa')['state'] == 'waiting_idle' and (prod.spool / 'rollback/aaaaaaaaaaaa.json').exists()
    prod.idle = True
    assert release.rollback_requests(prod.host) == 'done'
    assert prod.pointers() == ('old', prod.commit[:8]) and not (prod.spool / 'rollback/aaaaaaaaaaaa.json').exists()
    shipped = prod.status()['release_id']
    assert prod.status('rollback-aaaaaaaaaaaa')['undone'] == shipped
    notice = json.loads((prod.host.state / 'notices' / f'release-reverted-{shipped}.json').read_text())
    assert notice['text'] == '系统消息：已按你的要求换回上一个版本。'
    assert notice['system_event'] == {'type': 'release_reverted', 'release_id': shipped, 'commit': repo.base, 'request_id': '0123456789ab'}
    # A second 「改回去」 would roll FORWARD: refused, and nothing moves.
    (prod.spool / 'rollback/bbbbbbbbbbbb.json').write_text('{}')
    assert release.rollback_requests(prod.host) == 'refused'
    assert prod.pointers() == ('old', prod.commit[:8]) and 'NOT_THE_LATEST_SWITCH' in prod.status('rollback-bbbbbbbbbbbb')['reason']
    # After a watchdog rollback the latest event is the watchdog's: also refused.
    with (prod.host.state / 'events.jsonl').open('a') as stream:
        stream.write(json.dumps({'event': 'switch_passed', 'candidate': str((prod.root / 'current').resolve())}) + '\n')
        stream.write(json.dumps({'event': 'rollback_started', 'release_id': 'x'}) + '\n')
    (prod.spool / 'rollback/cccccccccccc.json').write_text('{}')
    assert release.rollback_requests(prod.host) == 'refused'


def test_ship_runs_gai_hui_qu_and_notices_even_when_the_build_host_is_unreachable(tmp_path, monkeypatch, repo):
    prod = Production(tmp_path, monkeypatch, repo)
    assert prod.ship() == 'switched'
    (prod.spool / 'rollback/aaaaaaaaaaaa.json').write_text('{}')
    import subprocess
    monkeypatch.setattr(release_transfer, 'publish', lambda config, state: (_ for _ in ()).throw(
        subprocess.CalledProcessError(255, ['rsync'], stderr=b'ssh: connect timed out')))
    release.cmd_ship(prod.host, None)
    assert prod.pointers() == ('old', prod.commit[:8]) and prod.status('rollback-aaaaaaaaaaaa')['state'] == 'done'
    assert sorted(body['id'].split(':')[0] for body in prod.delivered) == ['release-reverted', 'release-shipped']
    events = [json.loads(line)['event'] for line in (prod.host.state / 'events.jsonl').read_text().splitlines()]
    assert 'exchange_unreachable' in events
