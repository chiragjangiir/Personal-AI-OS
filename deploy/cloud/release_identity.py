"""Observe release parity from current source, running images and native inventories.

Inventory digests describe installed bytes/metadata, not activation. Staging may disable
plugins and replace MCP transports while preserving the same installed inventory.
"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess

import release_checks
import release_transfer
from staging_config import contract_config

FIELDS = ('commit', 'native_tree', 'service_images', 'skill_catalog', 'package_registry', 'config_schema', 'snapshot_at')
SERVICES = {'gateway', 'hermes', 'front', 'workshop', 'workshop-link', 'release-watchdog', 'postgres', 'livekit'}

# Metadata-only native discovery: never call discover_plugins(), which executes packages.
NATIVE = r'''
import hashlib, importlib.metadata, json, subprocess
from pathlib import Path
from hermes_cli.config import check_config_version, load_config_readonly
from hermes_cli.plugins_discovery import collect_directory_manifests, discover_entrypoint_manifests, resolve_manifest_winners, scan_directory
from hermes_cli.plugins_manifest import manifest_key
from hermes_constants import get_hermes_home
from tools.skills_tool import skill_search_dirs
def digest(value):
 return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
manifests = collect_directory_manifests()
home = get_hermes_home()
import os
if os.environ.get('PAIOS_STAGE') == 'staging':
 manifests += scan_directory(home / '.paios-production-plugins', 'user')
keys = {manifest_key(m) for m in manifests}
manifests += [m for m in discover_entrypoint_manifests() if manifest_key(m) not in keys]
winners = resolve_manifest_winners(manifests)
plugins = {key: {field: getattr(m, field) for field in ('name', 'version', 'kind', 'portable', 'manifest_version', 'api_version', 'capabilities')}
           for key, m in winners.items()}
roots = [root for _tier, root in skill_search_dirs()[0]]
roots += [Path(winners[key].path) / 'skills' for key in sorted(winners) if winners[key].source != 'entrypoint']
skills = []
for index, root in enumerate(dict.fromkeys(map(Path, roots))):
 if not root.exists():
  continue
 for path in sorted(root.rglob('*')):
  relative = path.relative_to(root)
  if path.is_file() and not any(p.startswith('.') or p == '__pycache__' for p in relative.parts):
   skills.append([index, str(relative), hashlib.sha256(path.read_bytes()).hexdigest()])
config = load_config_readonly()
mcp_names = sorted(config.get('mcp_servers', {}))
if os.environ.get('PAIOS_STAGE') == 'staging':
 mcp_names = json.loads((home / '.paios-production-registry.json').read_text())['mcp_servers']
 if not isinstance(mcp_names, list) or not all(isinstance(name, str) for name in mcp_names) or mcp_names != sorted(set(mcp_names)):
  raise ValueError('INVALID_SNAPSHOT_MCP_REGISTRY')
current, latest = check_config_version(raise_on_parse_error=True)
print(json.dumps({'native_tree': subprocess.run(['git', '-C', '/opt/hermes', 'rev-parse', 'HEAD^{tree}'],
 check=True, capture_output=True, text=True).stdout.strip(), 'skill_catalog': digest(skills),
 'package_registry': digest({'plugins': plugins, 'mcp_names': mcp_names,
                            'mcp_software_version': importlib.metadata.version('mcp')}),
 'native_config_version': current, 'native_latest_config_version': latest}))
'''


def config_shape(config):
    """Ignore only the renderer's explicit staging-only structural differences."""
    value = contract_config(config)
    def shape(item):
        if isinstance(item, dict):
            return {key: shape(child) for key, child in sorted(item.items())}
        if isinstance(item, list):
            variants = {json.dumps(shape(child), sort_keys=True) for child in item}
            return {'array': [json.loads(child) for child in sorted(variants)]}
        return type(item).__name__
    return hashlib.sha256(json.dumps(shape(value), sort_keys=True).encode()).hexdigest()


def snapshot_time(host, current):
    if host.stage == 'staging':
        path = current / '.release/snapshot.json'
        if not path.exists():
            return None
    else:
        settings = json.loads(Path(host.config['snapshot_settings']).read_text())
        candidates = sorted(Path(settings['spool']).glob('snapshot-*.json'))
        if not candidates:
            raise ValueError('PRODUCTION_SNAPSHOT_RECEIPT_MISSING')
        path = candidates[-1]
    value = json.loads(path.read_text())['as_of']
    # Normalize equivalent timestamps; reject invalid timestamps at the receipt boundary.
    if not isinstance(value, str):
        raise ValueError('SNAPSHOT_TIMESTAMP_INVALID')
    timestamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if timestamp.tzinfo is None:
        raise ValueError('SNAPSHOT_TIMESTAMP_REQUIRES_TIMEZONE')
    return timestamp.astimezone(timezone.utc).isoformat()


def snapshot_failure():
    """Read only the failed capture invocation; never copy journal text into release state."""
    unit = 'paios-staging-snapshot.service'
    try:
        result = subprocess.run(['systemctl', 'show', unit, '--property=ActiveState,InvocationID'],
                                check=True, capture_output=True, text=True)
        properties = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        invocation = properties.get('InvocationID')
        if properties.get('ActiveState') != 'failed' or not invocation:
            return {}
        journal = subprocess.run(['journalctl', '--unit=' + unit, '_SYSTEMD_INVOCATION_ID=' + invocation,
                                  '--no-pager', '--output=cat', '--lines=80'],
                                 check=True, capture_output=True, text=True)
    except (OSError, subprocess.CalledProcessError):
        return {}
    for line in reversed(journal.stdout.splitlines()):
        if match := re.fullmatch(r'ValueError: (SNAPSHOT_[A-Z_]+):.*', line):
            return {'failure_class': match[1], 'failure_source': unit, 'invocation_id': invocation}
    return {}


def observe_snapshot(host, current, required):
    try:
        timestamp = snapshot_time(host, current)
    except (OSError, ValueError, KeyError, TypeError) as error:
        if required:
            raise
        reason = str(error) if str(error) in ('PRODUCTION_SNAPSHOT_RECEIPT_MISSING', 'SNAPSHOT_TIMESTAMP_INVALID',
                                             'SNAPSHOT_TIMESTAMP_REQUIRES_TIMEZONE') else type(error).__name__
        return {'snapshot_at': None, 'snapshot': {'status': 'unavailable', 'failure_class': reason,
                'receipt_failure_class': reason, **snapshot_failure()}}
    return {'snapshot_at': timestamp, 'snapshot': {'status': 'available' if timestamp else 'unavailable'}}


def capture(host, *, snapshot_required=True, roles_required=True):
    """Observe running images; parity/ship require all release roles, manual identity may record absence."""
    current = host.release('current')
    run = host.runner(current)
    definition = host.definition(current)
    suffix = host.suffix
    images, stopped, dormant_watchdog = {}, {}, {}
    for row in release_checks.containers(run):
        service = row['Config']['Labels']['com.docker.compose.service']
        if service not in definition['services'] or bool(service.endswith('-staging')) != bool(suffix):
            continue
        name = service.removesuffix('-staging')
        if not row['State']['Running']:
            stopped[name] = row['State']['Status']
            # Staging parity creates an unstarted watchdog to retain production's installed image.
            if suffix and name == 'release-watchdog':
                dormant_watchdog[name] = row['Image']
            continue
        if name in images and images[name] != row['Image']:
            raise ValueError('SERVICE_IMAGE_DRIFT: ' + name)
        images[name] = row['Image']
    role_images, inactive_roles = {}, {}
    for role in release_transfer.ROLES:
        name = 'release-watchdog' if role == 'watchdog' else role
        if name in images:
            role_images[role] = images[name]
            continue
        if name + suffix not in definition['services']:
            reason = 'not_defined_in_compose'
        elif name in stopped:
            reason = 'container_' + stopped[name]
        elif role == 'watchdog' and host.config.get('timing', False) is None:
            reason = 'not_started_timing_null'
        else:
            reason = 'no_running_container'
        inactive_roles[role] = {'running': False, 'reason': reason}
    missing = inactive_roles.keys() - ({'watchdog'} if dormant_watchdog else set())
    if roles_required and missing:
        raise ValueError('RELEASE_ROLE_NOT_RUNNING: ' + ', '.join(sorted(missing)))
    native = release_checks.inside(run, 'hermes' + suffix, release_checks.HERMES_PYTHON, NATIVE)
    gateway = definition['services']['gateway' + suffix]
    config_file = next(m['source'] for m in gateway['volumes'] if m['target'] == '/etc/paios/cloud.json')
    schema = {'native': native.pop('native_config_version'), 'native_latest': native.pop('native_latest_config_version'),
              'cloud_shape': config_shape(json.loads(Path(config_file).read_text()))}
    return {'schema': 'paios.production-state.v1', 'commit': host.commit(current), 'release': current.name,
            'images': role_images, 'inactive_roles': inactive_roles,
            'service_images': {name: image for name, image in sorted({**dormant_watchdog, **images}.items()) if name in SERVICES},
            'auxiliary_service_images': {name: image for name, image in sorted(images.items()) if name not in SERVICES},
            **native, 'config_schema': schema,
            'source': json.loads((current / '.release/source.json').read_text()),
            **observe_snapshot(host, current, snapshot_required), 'published_at': datetime.now(timezone.utc).isoformat()}


def compare(production, staging):
    differences = {field: {'production': production[field], 'staging': staging[field]}
                   for field in FIELDS if production[field] is None or staging[field] is None or production[field] != staging[field]}
    return {'equal': not differences, 'differences': differences}
