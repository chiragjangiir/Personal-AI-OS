"""Prepare self core changes on the production source and qualify the existing staging stack."""
from datetime import datetime, timezone
import fcntl
import json
from pathlib import Path
from urllib.parse import urlsplit

import release_build
import release_identity
import release_source
import release_transfer
import staging_config
import staging_snapshot_restore
from watchdog_platform import atomic_json

ACTIONS = ['load_production_source_and_images', 'render_staging_config', 'restore_latest_production_snapshot',
           'reapply_staging_transport_and_effect_isolation', 'compare_again']


def publish_report(host, report):
    atomic_json(host.lock_path().parent / 'parity.json', report, mode=0o644)
    atomic_json(Path(host.config['exchange']) / 'parity.json', report, mode=0o644)


def inspect(host, production):
    receipt = host.release('current') / '.release/snapshot.json'
    if not receipt.exists() or not json.loads(receipt.read_text()).get('release_parity'):
        return {'equal': False, 'differences': {'snapshot_at': {'production': production['snapshot_at'], 'staging': None}}}
    return release_identity.compare(production, release_identity.capture(host))


def sync(host, production, lock):
    """Reuse the release inputs, renderer and snapshot restore; no production services are changed."""
    import release
    cloud, inventory = release_transfer.production_inputs(host.config, production)
    host.parity_inventory = inventory
    target = host.releases / production['commit'][:8]
    if not target.exists():
        target, _ = release_source.materialize(host.config['repo'], production['commit'], host.releases)
    release.candidate_env(host, target, production['images'])
    env_file = release.release_files(target)['env_file']
    pinned = {**production['images'], **{role: production['service_images'][role] for role in ('postgres', 'livekit')}}
    release.write_env(env_file, release.read_env(env_file), {f'PAIOS_{role.upper()}_IMAGE': image for role, image in pinned.items()})
    release.render(host, target)
    definition = host.definition(target)['services']
    # Include infrastructure images; source/tag defaults may have moved since production was built.
    overlay = {'services': {name + '-staging': {'image': image}
                           for name, image in production['service_images'].items()
                           if name + '-staging' in definition}}
    release_build.write(target / '.release/parity.compose.json', overlay)
    gateway = definition['gateway-staging']
    config_file = Path(next(m['source'] for m in gateway['volumes'] if m['target'] == '/etc/paios/cloud.json'))
    stage = json.loads(config_file.read_text())
    stage_config = stage['product_resources']
    builder = stage.get('model_settings', {}).get('build_activation_url')
    config_file.write_text(json.dumps(staging_config.render(cloud, urlsplit(stage_config['public_api_url']).netloc,
                                                           stage_config['livekit_api_url'], builder), indent=2) + '\n')
    old = host.flip(target) if target != host.release('current') else None
    try:
        settings = json.loads(Path(host.config['snapshot_settings']).read_text())
        settings['parity_compose'] = str(target / '.release/parity.compose.json')
        settings['disarm_watchdog'] = True
        snapshot = release_build.newest_snapshot(settings)
        expected_stamp = datetime.fromisoformat(production['snapshot_at']).strftime('snapshot-%Y%m%dT%H%M%SZ.age')
        if snapshot.name != expected_stamp:
            raise ValueError('PRODUCTION_SNAPSHOT_NOT_DELIVERED')
        with Path(settings['lock']).open('a') as snapshot_lock:
            fcntl.flock(snapshot_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            staging_snapshot_restore.restore(settings, snapshot, True, lock=lock, inventory=inventory)
        receipt = json.loads((Path(settings['evidence']) / (snapshot.stem + '.json')).read_text())
        atomic_json(target / '.release/snapshot.json', {**receipt, 'release_parity': True})
        run = host.runner(target)
        if 'release-watchdog' in production['service_images']:
            run(['up', '--no-start', '--no-deps', '--no-build', '--pull', 'never', 'release-watchdog-staging'], capture_output=True)
    except BaseException:
        if old is not None:
            host.unflip(old)
        raise
    return release_identity.capture(host)


def ensure(host, lock, dry_run=False):
    production = release_transfer.production_base(host.config)
    report = inspect(host, production)
    report['base'] = production['commit']
    report['actions'] = [] if report['equal'] else ACTIONS
    if dry_run:
        return report
    publish_report(host, report)
    if not report['equal']:
        staged = sync(host, production, lock)
        report = {**release_identity.compare(production, staged), 'base': production['commit'],
                  'before': report['differences'], 'synced': True}
        publish_report(host, report)
    if not report['equal']:
        raise ValueError('STAGING_PARITY_MISMATCH: ' + ', '.join(report['differences']))
    host.parity_inventory = Path(host.config['exchange']) / production['sync']['files'][3]
    return production


def prepare_requests(host):
    """The builder asks through its existing spool before opening a product workspace."""
    for path in sorted(Path(host.config['requests']).glob('*.prepare')):
        value = json.loads(path.read_text())
        result = {'request_id': value['request_id']}
        try:
            with host.locked(wait=True) as lock:
                production = ensure(host, lock)
                result.update(base=production['commit'], parity={'equal': True})
        except Exception as error:
            result.update(failure=type(error).__name__)
        atomic_json(path.with_suffix('.prepared'), result, mode=0o644)
        path.unlink()
