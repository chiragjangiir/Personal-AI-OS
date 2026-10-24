#!/usr/bin/env python3
"""Offline owner conversation reset. Preview is the default; never start a service."""
import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import secrets
import subprocess
import sys
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]


class ResetError(ValueError):
    pass


def stamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ResetError('cutoff_requires_timezone')
    return parsed.astimezone(timezone.utc)


def request(args):
    roots = [Path(args.data_root), Path(args.hermes_home)]
    if any(not p.is_absolute() or p.is_symlink() or not p.is_dir() for p in roots):
        raise ResetError('existing_absolute_data_roots_required')
    data, home = [p.resolve() for p in roots]
    if data == home or data in home.parents or home in data.parents:
        raise ResetError('data_roots_must_be_separate')
    dsn = Path(args.postgres_dsn_file).read_text().strip()
    parsed = urlsplit(dsn)
    if parsed.scheme not in ('postgres', 'postgresql') or not parsed.hostname or not parsed.path[1:] or not parsed.username:
        raise ResetError('postgres_dsn_required')
    return {'cutoff': stamp(args.cutoff).isoformat(), 'data_root': str(data), 'hermes_home': str(home),
            'config': str(Path(args.config).resolve()), 'postgres_dsn': dsn,
            'postgres_identity': {'database': unquote(parsed.path[1:]), 'user': unquote(parsed.username)},
            'postgres_endpoint': {'host': parsed.hostname, 'port': parsed.port or 5432}}


def node(args, payload):
    entry = ROOT / '01-product-half-finished/backend/services/personal-aios-integration/tools/conversation-reset.ts'
    command = json.loads(Path(args.node_command_file).read_text()) if args.node_command_file else [args.node, str(entry)]
    result = subprocess.run(command, input=json.dumps(payload), text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        # Native exceptions can contain row values, SQL or connection secrets.
        # The runner emits only a fixed stage/code envelope.
        try:
            failure = json.loads(result.stdout)
        except ValueError:
            failure = {'stage': 'node_runtime', 'code': 'RESET_WORKER_FAILED'}
        stage = failure.get('stage')
        allowed = {'request', 'cold_backup', 'cold_backup_pin', 'archive_inventory', 'integration_inventory',
                   'postgres_inventory', 'postgres_apply', 'integration_apply', 'archive_apply', 'legacy_corpus_apply'}
        raise ResetError('RESET_WORKER_FAILED:' + (stage if stage in allowed else 'worker'))
    return json.loads(result.stdout)


def native(args, payload, execute=False):
    entry = ROOT / 'integrations/hermes/personal_aios/conversation_reset.py'
    command = json.loads(Path(args.native_command_file).read_text()) if args.native_command_file else [sys.executable, str(entry)]
    result = subprocess.run(command, input=json.dumps({**payload, 'action': 'execute' if execute else 'preview',
                                                     'include_reference_targets': not execute}),
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    parsed = json.loads(result.stdout)
    if result.returncode and parsed.get('status') != 'blocked':
        raise ResetError('HERMES_RESET_FAILED')
    return parsed


def binding(payload):
    return {key: payload[key] for key in ('cutoff', 'data_root', 'hermes_home', 'config', 'postgres_identity', 'postgres_endpoint')}


def require_stopped(args):
    if not args.compose or not args.env_file:
        raise ResetError('mutation_requires_compose_and_env_file')
    result = subprocess.run(['docker', 'compose', '--env-file', args.env_file, '-f', args.compose,
                             'ps', '--status', 'running', '--services'], text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    allowed = {'postgres', 'postgres-staging', 'cold-webdav', 'cold-webdav-staging', 'front', 'front-staging'}
    if set(result.stdout.split()) - allowed:
        raise ResetError('stop_all_compose_writers_before_reset')


def validate_backup(args, payload):
    if not args.backup_marker or not args.backup_bundle:
        raise ResetError('execute_requires_backup_marker_and_bundle')
    marker_path = Path(args.backup_marker)
    if marker_path.is_symlink():
        raise ResetError('unsafe_backup_marker')
    marker = json.loads(marker_path.read_text())
    if marker.get('schema') != 'paios.conversation-reset.backup.v1' or marker.get('target') != binding(payload):
        raise ResetError('backup_marker_target_mismatch')
    age = (datetime.now(timezone.utc) - stamp(marker['prepared_at'])).total_seconds()
    if not 0 <= age <= 6 * 3600:
        raise ResetError('backup_marker_not_fresh')
    bundle = Path(args.backup_bundle).resolve()
    if any(bundle == Path(payload[key]) or Path(payload[key]) in bundle.parents
           for key in ('data_root', 'hermes_home')):
        raise ResetError('backup_must_be_outside_reset_roots')
    manifest_path = bundle / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    identity = payload['postgres_identity']
    if (manifest.get('format') != 2 or manifest.get('consistency') != 'frozen'
            or manifest.get('conversation_reset') != marker
            or manifest.get('excluded_owner_paths') != []
            or any(manifest.get(k) != v for k, v in identity.items())
            or manifest_path.stat().st_mtime < stamp(marker['prepared_at']).timestamp()):
        raise ResetError('fresh_complete_frozen_backup_required')
    required = {'owner-data', 'hermes-home', 'secrets', 'models', 'desktop-in', 'desktop-out', 'workshop-data'}
    if not required <= set(manifest.get('archives', [])):
        raise ResetError('backup_owner_volumes_incomplete')
    for name in ['postgres.dump', *[f'{name}.tar.gz' for name in manifest['archives']]]:
        path = bundle / name
        if path.is_symlink() or not path.is_file() or not path.stat().st_size:
            raise ResetError('backup_artifact_missing')
    return marker['cold_pin']


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cutoff', required=True)
    parser.add_argument('--data-root', required=True, help='owner-data mount, e.g. /var/lib/paios')
    parser.add_argument('--hermes-home', required=True, help='Hermes volume mount, e.g. /opt/data')
    parser.add_argument('--postgres-dsn-file', required=True, help='0600 file; DSN never printed')
    parser.add_argument('--config', required=True, help='rendered cloud config with existing cold authority')
    parser.add_argument('--backup-marker')
    parser.add_argument('--backup-bundle')
    parser.add_argument('--node', default='node')
    parser.add_argument('--compose', help='target Compose file; mandatory for mutation')
    parser.add_argument('--env-file', help='target Compose env file; mandatory for mutation')
    parser.add_argument('--node-command-file', help='JSON argv for isolated gateway-image worker; no shell')
    parser.add_argument('--native-command-file', help='JSON argv for isolated Hermes-image worker; no shell')
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--prepare-backup', action='store_true', help='pin cold dependencies before frozen backup')
    action.add_argument('--execute', action='store_true')
    args = parser.parse_args(argv)
    os.umask(0o077)
    payload = request(args)
    if args.prepare_backup or args.execute:
        require_stopped(args)
    if args.prepare_backup:
        if not args.backup_marker:
            raise ResetError('prepare_requires_backup_marker')
        marker_path = Path(args.backup_marker)
        if marker_path.exists():
            raise ResetError('backup_marker_already_exists')
        for key in ('data_root', 'hermes_home'):
            root = Path(payload[key])
            if marker_path.resolve() == root or root in marker_path.resolve().parents:
                raise ResetError('marker_must_be_outside_reset_roots')
        pin = secrets.token_hex(32)
        result = node(args, {**payload, 'action': 'prepare_backup', 'cold_pin': pin})
        marker = {'schema': 'paios.conversation-reset.backup.v1', 'prepared_at': datetime.now(timezone.utc).isoformat(),
                  'target': binding(payload), 'cold_pin': pin}
        with marker_path.open('x') as stream:
            json.dump(marker, stream)
            stream.flush()
            os.fsync(stream.fileno())
        print(json.dumps({'status': 'backup_prepared', 'cold_dependencies': result}))
        return 0
    pin = validate_backup(args, payload) if args.execute else None
    hermes = native(args, payload)
    native_refs = hermes.pop('_reference_targets', {})
    # Preview every owner before any cross-store destructive operation.
    integration = node(args, {**payload, 'action': 'preview', 'native_reference_targets': native_refs,
                              **({'cold_pin': pin} if pin else {})})
    blockers = hermes['blockers'] + integration.get('blockers', [])
    report = {'status': 'blocked' if blockers else 'preview', 'hermes': hermes, 'stores': integration,
              'blockers': sorted(set(blockers)), 'bytes_basis': 'logical record/object bytes; not reclaimed filesystem space'}
    if args.execute and not blockers:
        # Each owning worker claims its native lifetime lock; all writers stay stopped.
        applied_native = native(args, payload, execute=True)
        if applied_native['status'] == 'blocked':
            report.update(status='blocked', blockers=applied_native['blockers'])
        else:
            report['applied'] = node(args, {**payload, 'action': 'execute', 'cold_pin': pin})
            report['status'] = 'executed'
    print(json.dumps(report, ensure_ascii=False))
    return 1 if report['status'] == 'blocked' else 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        # Only locally constructed error codes can be printed; native errors may contain private data.
        code = str(error) if isinstance(error, ResetError) else 'RESET_FAILED_KEEP_SERVICES_STOPPED'
        print(json.dumps({'status': 'failed', 'code': code}))
        raise SystemExit(1)
