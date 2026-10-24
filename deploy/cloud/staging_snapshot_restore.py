"""Restore and qualify the existing staging profile, then retain accepted envelopes."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from staging_snapshot_stack import Stack
from staging_snapshot_transfer import NAME, decrypt, retain

TARGETS = ('owner-data', 'hermes-home', 'errands', 'postgres')


def preflight(stack, settings):
    if settings.get('keep', 2) not in (1, 2):
        raise ValueError('Staging retention must keep one or two snapshots')
    services = stack.definition['services']
    secrets = Path(settings['staging_secrets']).resolve()
    production_secrets = {Path(m['source']).resolve() for service in services.values()
                          if 'production' in service.get('profiles', []) for m in service.get('volumes', [])
                          if m['target'].startswith('/run/secrets/')}
    for name in ('gateway', 'hermes', 'postgres', 'front', 'livekit', 'workshop'):
        service = services[name + '-staging']
        if 'staging' not in service.get('profiles', []) or 'production' in service['profiles']:
            raise ValueError('Restore services must belong only to the staging profile')
        if not re.search(r'(?:@sha256:|^sha256:)[a-f0-9]{64}$', service['image']):
            raise ValueError('Staging requires immutable candidate images: ' + name)
        for mount in service.get('volumes', []):
            if mount['target'].startswith('/run/secrets/'):
                source = Path(mount['source']).resolve()
                if not source.is_relative_to(secrets) or source in production_secrets:
                    raise ValueError('Staging must use separate staging_secrets mounts')
    for name in ('gateway', 'hermes'):
        if services[name + '-staging']['environment'].get('PAIOS_STAGE') != 'staging':
            raise ValueError('Existing staging effect isolation must be enabled')
    config = json.loads(Path(stack.config_mount()).read_text())
    resources = config['product_resources']
    if (not config['payment']['staging'] or not resources.get('staging_effect_sink_file')
            or any(key in resources for key in ('bark_device_file', 'bark_key_file', 'avatar_url', 'video_call', 'vidu_cleanup_key_file'))
            or config.get('archive_tiering')):
        raise ValueError('Use the existing staging renderer; external effects and production cold storage must be disabled')
    production = {v['name'] for key, v in stack.volumes.items() if not key.endswith('-staging')}
    stage = [stack.volume(name) for name in TARGETS]
    if len(set(stage)) != len(stage) or production.intersection(stage):
        raise ValueError('Staging target names must be distinct from every production volume')
    for name in TARGETS:
        volume = stack.volumes[name + '-staging']
        if (volume['name'] == stack.volumes[name]['name'] or volume.get('external') or volume.get('driver_opts')):
            raise ValueError('Restore requires separate local staging volumes')
    if not settings.get('regression_command'):
        raise ValueError('Configure the existing staging regression command before restore')


def restore(settings, snapshot, replace, lock=None):
    snapshot = Path(snapshot)
    if not NAME.fullmatch(snapshot.name) or snapshot.is_symlink():
        raise ValueError('Expected a complete snapshot-<UTC>.age envelope')
    snapshot = snapshot.resolve()
    stack = Stack(settings, stage=True)
    preflight(stack, settings)
    evidence = Path(settings['evidence']).resolve()
    evidence.mkdir(parents=True, exist_ok=True, mode=0o700)
    receipt = evidence / (snapshot.stem + '.json')
    with stack.maintenance(lock), tempfile.TemporaryDirectory(prefix='staging-restore-', dir=settings['scratch']) as temporary:
        work = Path(temporary)
        decrypt(snapshot, settings['identity_file'], work)
        manifest = json.loads((work / 'manifest.json').read_text())
        if (manifest['schema'] != 'paios.staging-snapshot.v1' or manifest['window_hours'] not in (0, 48)
                or manifest['consistency'] != 'all-application-writers-stopped'):
            raise ValueError('Unsupported cross-store snapshot contract')
        # Window 0 is the daytime structural cut: no raw L5 to verify.
        raw = manifest['window_hours'] == 48
        age = datetime.now(timezone.utc) - datetime.fromisoformat(manifest['as_of'].replace('Z', '+00:00'))
        if not 0 <= age.total_seconds() <= settings.get('max_snapshot_age_hours', 36) * 3600:
            raise ValueError('Snapshot is stale or from the future')
        stack.tools(['python3', '/opt/paios/deploy/cloud/staging_snapshot_data.py', 'verify'], work)
        if raw:
            stack.l5(work, 'verify')
        stack.tools(['-c', "from pathlib import Path; from tools.skill_product import check_local_collisions; "
                     "root=Path('/opt/paios/integrations/hermes/personal_aios'); "
                     "check_local_collisions(Path('/work/data/hermes-home/skills'), [root/'errands', root/'shared-skills'])"],
                    work, image=stack.definition['services']['hermes-staging']['image'],
                    entrypoint='/opt/hermes/.venv/bin/python')
        existing = []
        for name in TARGETS:
            result = subprocess.run(['docker', 'volume', 'inspect', stack.volume(name)], capture_output=True)
            if result.returncode == 0:
                existing.append(name)
        if existing and not replace:
            raise ValueError('Target staging volumes exist; preserve rollback envelope, then use --replace-staging')
        running = stack.run(['ps', '--status', 'running', '--services'], capture_output=True, text=True).stdout.split()
        stage_services = sorted(name for name, service in stack.definition['services'].items()
                                if name.endswith('-staging') and 'staging' in service.get('profiles', [])
                                and 'production' not in service['profiles'])
        stack.run(['stop'] + stage_services)
        stack.run(['rm', '--force'] + stage_services)
        for name in existing:
            subprocess.run(['docker', 'volume', 'rm', stack.volume(name)], check=True)
        for name in TARGETS:
            subprocess.run(['docker', 'volume', 'create', stack.volume(name)], check=True, stdout=subprocess.DEVNULL)
        mounts = [(stack.volume('hermes-home'), '/restore/home'), (stack.volume('owner-data'), '/restore/owner'),
                  (stack.volume('errands'), '/restore/owner/state/errands')]
        try:
            stack.tools(['python3', '/opt/paios/deploy/cloud/staging_snapshot_data.py', 'install'], work, mounts)
            stack.run(['up', '-d', '--no-build', '--pull', 'never', '--wait', 'postgres-staging'])
            with (work / 'postgres.dump').open('rb') as stream:
                stack.pg('restore', stream)
            restored_rows = stack.counts()
            if restored_rows != manifest['postgres_rows']:
                raise ValueError('Restored Postgres row counts differ from the common cut')
            actual = [(stack.volume('hermes-home'), '/work/data/hermes-home:ro'),
                      (stack.volume('owner-data'), '/work/data/owner-data:ro'),
                      (stack.volume('errands'), '/work/data/owner-data/state/errands:ro')]
            stack.tools(['python3', '/opt/paios/deploy/cloud/staging_snapshot_data.py', 'verify'], work, actual)
            if raw:
                stack.l5(work, 'verify', restored=actual)
            result = {**manifest, 'snapshot': snapshot.name, 'restored_postgres_rows': restored_rows,
                      'stores_verified': True, 'regression_passed': False,
                      'candidate_images': {name: stack.definition['services'][name + '-staging']['image']
                                           for name in ('gateway', 'hermes', 'postgres', 'front', 'livekit', 'workshop')}}
            receipt.write_text(json.dumps(result, indent=2))
            start = ['gateway-staging', 'livekit-staging', 'workshop-staging', 'workshop-link-staging']
            if 'release-watchdog-staging' in running:
                start.append('release-watchdog-staging')
            stack.run(['up', '-d', '--no-build', '--pull', 'never', '--wait'] + start)
            environment = {**os.environ, 'PAIOS_STAGE': 'staging', 'PAIOS_SNAPSHOT_RECEIPT': str(receipt)}
            subprocess.run(settings['regression_command'], check=True, env=environment)
            stack.tools(['node', '/opt/paios/deploy/cloud/staging_snapshot_visual.ts', 'ready',
                         '--dest', '/work/data/owner-data/central-storage/visual-memory'], work, actual)
            result['regression_passed'] = True
            receipt.write_text(json.dumps(result, indent=2))
        except BaseException:
            stack.run(['stop', 'gateway-staging', 'hermes-staging'])
            raise
    accepted = Path(settings['accepted']).resolve()
    accepted.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = accepted / snapshot.name
    if destination != snapshot:
        shutil.move(str(snapshot), destination)
    retain(accepted, settings.get('keep', 2), others=[settings['incoming']])
    print('Restore drill and existing staging regression passed; receipt: ' + str(receipt))
