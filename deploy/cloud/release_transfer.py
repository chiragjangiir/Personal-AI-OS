"""Candidate transfer between the build host and production through one restricted exchange.

Production opens every connection. Through a single rrsync-restricted account on the build host (the same pattern
as the snapshot account), it pushes `production.json` (its current commit and images) into the build host's
exchange directory and pulls ready candidate packages from it. The build host never reaches production. The
exchange is root/account-owned on the build host and is mounted into no container, so the coding workshop cannot
write a package.

A package is `candidates/<request_id>/`: manifest.json, accepted.json, result.json, source.bundle (base..commit) and
delta.tar, the content-addressed OCI layer delta against production's current images. Production checks the digest, rebuilds the full archive from its own images,
loads it and requires every image ID to equal accepted.json before anything may switch.
"""
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import tarfile
import tempfile

import release_build
import release_source

ROLES = ('gateway', 'hermes', 'front', 'workshop', 'watchdog')
SSH = ['-e', 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes']


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(16 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def present(image):
    found = subprocess.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', image], capture_output=True, text=True)
    return found.returncode == 0 and found.stdout.strip() == image


def delta(base_tar, candidate_tar, output):
    """Write the candidate's OCI archive minus every blob the base archive already holds; returns reused bytes."""
    with tarfile.open(base_tar) as base, tarfile.open(candidate_tar) as source:
        available = set(base.getnames())
        members = source.getmembers()
        blobs = [m for m in members if m.name.startswith('blobs/sha256/') and m.isfile()]
        if not blobs:
            raise ValueError('DOCKER_SAVE_NOT_OCI')
        meta = {'required': [m.name for m in members], 'reused_bytes': sum(m.size for m in blobs if m.name in available)}
        encoded = json.dumps(meta).encode()
        with open(output, 'xb') as out, tarfile.open(fileobj=out, mode='w|') as archive:
            item = tarfile.TarInfo('release-layer-delta.json')
            item.size = len(encoded)
            archive.addfile(item, io.BytesIO(encoded))
            for member in members:
                if not member.name.startswith('blobs/sha256/') or member.name not in available:
                    archive.addfile(member, source.extractfile(member) if member.isfile() else None)
    return meta['reused_bytes']


def merge(base_tar, delta_tar, stream):
    """Stream the complete candidate archive (delta members, the rest from the base) for docker load."""
    with tarfile.open(base_tar) as base, tarfile.open(delta_tar) as source:
        meta = json.load(source.extractfile('release-layer-delta.json'))
        changed = set(source.getnames())
        with tarfile.open(fileobj=stream, mode='w|') as archive:
            for name in meta['required']:
                origin = source if name in changed else base
                item = origin.getmember(name)
                archive.addfile(item, origin.extractfile(item) if item.isfile() else None)


def save(refs, output, guard):
    release_build.guarded(['docker', 'image', 'save', '-o', str(output), *refs], output.parent, release_build.clean_env(),
                          output.with_suffix('.log'), guard)


# ---------------------------------------------------------------- build host

def export(config, release, result, summary):
    """Package one staging-accepted agent candidate for production; the package appears atomically or not at all."""
    exchange = Path(config['exchange'])
    production = json.loads((exchange / 'production.json').read_text())
    accepted = json.loads((release / '.release/accepted.json').read_text())
    build = json.loads((release / '.release/build.json').read_text())
    request_id = result['request_id']
    target = exchange / 'candidates' / request_id
    partial = target.with_name('.' + request_id + '.partial')
    if target.exists():
        raise ValueError('PRESERVE_EXISTING_PACKAGE: ' + request_id)
    shutil.rmtree(partial, ignore_errors=True)
    partial.mkdir(parents=True, mode=0o750)
    base_images = sorted(set(production['images'].values()))
    if missing := [image for image in base_images if not present(image)]:
        raise ValueError('TRANSFER_BASE_MISSING: ' + ', '.join(missing))
    guard = config.get('disk_guard_bytes', 4_000_000_000)
    scratch = Path(config.get('transfer_scratch', exchange.parent / 'transfer-scratch'))
    scratch.mkdir(mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=scratch) as directory:
        work = Path(directory)
        save(base_images, work / 'base.tar', guard)
        save([build['images'][role]['tag'] for role in ROLES], work / 'new.tar', guard)
        reused = delta(work / 'base.tar', work / 'new.tar', partial / 'delta.tar')
    release_source.git(config['repo'], 'bundle', 'create', str(partial / 'source.bundle'),
                       'refs/paios/candidates/' + request_id, '^' + result['base'])
    shutil.copyfile(release / '.release/accepted.json', partial / 'accepted.json')
    release_build.write(partial / 'result.json', result)
    release_build.write(partial / 'manifest.json', {
        'schema': 'paios.release-package.v1', 'request_id': request_id, 'commit': result['commit'], 'base': result['base'],
        'summary': summary, 'images': accepted['images'], 'base_images': base_images, 'production_commit': production['commit'],
        'delta_sha256': sha256(partial / 'delta.tar'), 'delta_bytes': (partial / 'delta.tar').stat().st_size,
        'reused_bytes': reused, 'exported_at': datetime.now(timezone.utc).isoformat(),
        **{k: result[k] for k in ('origin', 'description', 'captured_at') if k in result}})
    for path in [partial, *partial.iterdir()]:
        path.chmod(0o750 if path.is_dir() else 0o640)
        shutil.chown(path, user=config['exchange_owner'], group=pwd.getpwnam(config['exchange_owner']).pw_gid)
    partial.rename(target)
    return {'package': str(target), 'delta_bytes': (target / 'delta.tar').stat().st_size, 'reused_bytes': reused}


def production_base(config):
    """The agent's repair base is what production runs, as production itself last published it."""
    return json.loads((Path(config['exchange']) / 'production.json').read_text())


# ---------------------------------------------------------------- production

def rsync(config, *args):
    limit = ['--bwlimit=%d' % config['transfer_bwlimit_kib']] if config.get('transfer_bwlimit_kib') else []
    subprocess.run(['rsync', *SSH, *limit, *args], check=True, capture_output=True)


def publish_requests(config):
    """Publish only a bounded derived inventory; request/result files remain the authorities."""
    rows = []
    fields = ('state', 'base', 'commit', 'started_at', 'finished_at', 'ready_for_production',
              'reason', 'failure', 'protected_paths')
    for path in sorted(Path(config['requests']).glob('*/request.json'), key=lambda p: p.stat().st_mtime)[-50:]:
        if path.parent.name.startswith('.'):
            continue
        spec = json.loads(path.read_text())
        result = path.with_name('result.json')
        result = json.loads(result.read_text()) if result.exists() else {}
        rows.append({'request_id': spec['request_id'], 'principal_id': spec.get('origin', {}).get('principal_id'),
                     **{k: spec[k] for k in ('origin',) if k in spec},
                     'state': 'queued', **{k: result[k] for k in fields if k in result}})
    path = Path(config['exchange']) / 'requests.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    release_build.write(path, rows)
    path.chmod(0o644)


def share_notices(config):
    """The restricted exchange account must be able to pull host-written notices."""
    if owner := config.get('exchange_owner'):
        directory = Path(config['exchange']) / 'notices'
        for path in (directory, *directory.glob('*.json')):
            shutil.chown(path, user=owner, group=pwd.getpwnam(owner).pw_gid)


def publish_decisions(config):
    """Only production's owner-confirmed decisions travel back to the held build request."""
    decisions = Path(config['spool']) / 'decisions'
    if not decisions.exists() or not any(decisions.glob('*.json')):
        return
    rsync(config, '-rt', '--delay-updates', str(decisions) + '/', config['exchange_remote'] + 'decisions/')


def publish(config, state):
    path = Path(config['incoming']) / 'production.json'
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    release_build.write(path, state)
    rsync(config, '-t', str(path), config['exchange_remote'] + 'production.json')


def fetch(config, done):
    """Pull every package not yet decided here; partial transfers resume on the next run."""
    excluded = [arg for request_id in sorted(done) for arg in ('--exclude', '/candidates/' + request_id + '/')]
    rsync(config, '-rt', '--partial-dir=.partial', '--delay-updates', '--exclude', '/.*', *excluded,
          '--include', '/notices/***', '--include', '/requests.json', '--include', '/candidates/***', '--exclude', '/*',
          config['exchange_remote'], str(Path(config['incoming'])) + '/')


def load(config, package):
    """Verify the package digest, load what production lacks and require the accepted image IDs."""
    manifest = json.loads((package / 'manifest.json').read_text())
    accepted = json.loads((package / 'accepted.json').read_text())
    if manifest['images'] != accepted['images']:
        raise ValueError('TRANSFER_MANIFEST_MISMATCH')
    if sha256(package / 'delta.tar') != manifest['delta_sha256']:
        raise ValueError('TRANSFER_DIGEST_MISMATCH')
    loaded = False
    if any(not present(image) for image in accepted['images'].values()):
        if missing := [image for image in manifest['base_images'] if not present(image)]:
            raise ValueError('TRANSFER_BASE_MISSING: ' + ', '.join(missing))
        with tempfile.TemporaryDirectory(dir=package) as directory:
            base = Path(directory) / 'base.tar'
            save(manifest['base_images'], base, config.get('disk_guard_bytes', 4_000_000_000))
            # Background I/O class: the load runs next to Postgres and the gateway.
            process = subprocess.Popen(['ionice', '-c3', 'nice', '-n19', 'docker', 'load'], stdin=subprocess.PIPE,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                merge(base, package / 'delta.tar', process.stdin)
            finally:
                process.stdin.close()
            if process.wait():
                raise RuntimeError('TRANSFER_LOAD_FAILED')
        loaded = True
    if mismatched := sorted(role for role, image in accepted['images'].items() if not present(image)):
        raise ValueError('TRANSFER_ID_MISMATCH: ' + ', '.join(mismatched))
    return {'loaded': loaded, 'images': accepted['images']}
