"""Synthetic backup gates and the offline orchestrator; owning-store readers have their own fixtures."""
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('reset_tool', Path(__file__).with_name('conversation_reset.py'))
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class ResetBackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data, self.home = self.root / 'owner', self.root / 'hermes'
        self.data.mkdir()
        self.home.mkdir()
        self.config = self.root / 'cloud.json'
        self.config.write_text('{}')
        self.dsn = self.root / 'dsn'
        self.dsn.write_text('postgresql://synthetic:DO_NOT_PRINT@localhost/fixture')
        self.args = SimpleNamespace(data_root=str(self.data), hermes_home=str(self.home),
                                    config=str(self.config), cutoff='2026-10-18T10:14:00Z',
                                    postgres_dsn_file=str(self.dsn), backup_marker=str(self.root / 'marker'),
                                    backup_bundle=str(self.root / 'bundle'), compose='compose.yaml', env_file='env')
        self.payload = tool.request(self.args)
        self.prepared = datetime.now(timezone.utc) - timedelta(seconds=2)
        self.marker = {'schema': 'paios.conversation-reset.backup.v1', 'target': tool.binding(self.payload),
                       'prepared_at': self.prepared.isoformat(), 'cold_pin': 'a' * 64}
        Path(self.args.backup_marker).write_text(json.dumps(self.marker))
        self.bundle = Path(self.args.backup_bundle)
        self.bundle.mkdir()
        self.manifest = {'format': 2, 'consistency': 'frozen', 'database': 'fixture', 'user': 'synthetic',
                         'conversation_reset': self.marker,
                         'excluded_owner_paths': [], 'archives': ['owner-data', 'hermes-home', 'secrets',
                         'models', 'desktop-in', 'desktop-out', 'workshop-data']}
        for name in ['postgres.dump', *[n + '.tar.gz' for n in self.manifest['archives']]]:
            (self.bundle / name).write_bytes(b'synthetic backup marker fixture')
        self.write_manifest()

    def write_manifest(self):
        (self.bundle / 'manifest.json').write_text(json.dumps(self.manifest))

    def test_valid_fresh_complete_frozen_backup_and_no_credentials_in_binding(self):
        self.assertEqual(tool.validate_backup(self.args, self.payload), 'a' * 64)
        self.assertNotIn('DO_NOT_PRINT', json.dumps(tool.binding(self.payload)))
        other = {**self.payload, 'postgres_endpoint': {'host': 'another-instance', 'port': 5432}}
        with self.assertRaises(ValueError):
            tool.validate_backup(self.args, other)

    def test_backup_gate_rejects_absent_stale_wrong_target_and_incomplete_artifact(self):
        original = json.dumps(self.marker)
        for mutation in ('stale', 'target', 'absent'):
            with self.subTest(mutation=mutation):
                marker = json.loads(original)
                if mutation == 'stale':
                    marker['prepared_at'] = (self.prepared - timedelta(hours=7)).isoformat()
                elif mutation == 'target':
                    marker['target']['data_root'] = '/different-owner'
                path = Path(self.args.backup_marker)
                path.write_text(json.dumps(marker))
                if mutation == 'absent':
                    path.unlink()
                with self.assertRaises((ValueError, FileNotFoundError)):
                    tool.validate_backup(self.args, self.payload)
        Path(self.args.backup_marker).write_text(original)
        (self.bundle / 'owner-data.tar.gz').unlink()
        with self.assertRaises(ValueError):
            tool.validate_backup(self.args, self.payload)

    def test_staging_excluded_or_pre_marker_snapshot_cannot_authorize_execution(self):
        for field, value in [('consistency', 'staging'), ('excluded_owner_paths', ['voiceprints']), ('format', 4)]:
            before = self.manifest[field]
            self.manifest[field] = value
            self.write_manifest()
            with self.assertRaises(ValueError):
                tool.validate_backup(self.args, self.payload)
            self.manifest[field] = before
        self.write_manifest()
        os.utime(self.bundle / 'manifest.json', (self.prepared.timestamp() - 1,) * 2)
        with self.assertRaises(ValueError):
            tool.validate_backup(self.args, self.payload)

    def test_an_unbound_backup_cannot_authorize_execution(self):
        self.manifest.pop('conversation_reset')
        self.write_manifest()
        with self.assertRaises(ValueError):
            tool.validate_backup(self.args, self.payload)

    def test_snapshot_source_volumes_are_checked_before_backup_writes(self):
        migration_spec = importlib.util.spec_from_file_location('reset_migrate', Path(__file__).with_name('migrate.py'))
        migration = importlib.util.module_from_spec(migration_spec)
        migration_spec.loader.exec_module(migration)
        definition = {'volumes': {'owner-data': {'name': 'owner'}, 'hermes-home': {'name': 'hermes'}},
                      'services': {'gateway': {'volumes': []}, 'postgres': {}}}
        config = SimpleNamespace(stdout=json.dumps(definition))
        wrong_volume = SimpleNamespace(stdout=json.dumps([{'Mountpoint': str(self.root / 'different-project')}]))
        args = SimpleNamespace(consistency='frozen', exclude_owner_path=[], reset_marker=self.args.backup_marker)
        with patch.object(migration, 'compose_cloud', return_value=['docker', 'compose']), \
             patch.object(migration, 'run', side_effect=[config, wrong_volume]) as runner:
            with self.assertRaisesRegex(ValueError, 'source volume'):
                migration._snapshot_cloud(args)
            self.assertEqual(runner.call_count, 2)

    def test_running_writers_block_mutation_but_infrastructure_can_remain(self):
        with patch.object(tool.subprocess, 'run', return_value=SimpleNamespace(stdout='postgres\nfront\ncold-webdav\n')):
            tool.require_stopped(self.args)
        with patch.object(tool.subprocess, 'run', return_value=SimpleNamespace(stdout='gateway\nhermes\npostgres\n')):
            with self.assertRaises(ValueError):
                tool.require_stopped(self.args)

    def test_default_empty_dry_run_never_checks_docker_or_writes_marker(self):
        argv = ['--cutoff', self.args.cutoff, '--data-root', str(self.data), '--hermes-home', str(self.home),
                '--config', str(self.config), '--postgres-dsn-file', str(self.dsn)]
        private_refs = {'native_session_ids': ['synthetic-private-session'], 'native_message_ids': ['1']}
        with patch.object(tool, 'native', return_value={'status': 'preview', 'blockers': [], '_reference_targets': private_refs}) as native, \
             patch.object(tool, 'node', return_value={'blockers': [], 'categories': []}) as worker, \
             patch.object(tool, 'require_stopped', side_effect=AssertionError('dry run must not inspect Docker')), \
             patch('builtins.print') as output:
            self.assertEqual(tool.main(argv), 0)
            self.assertEqual(native.call_count, 1)
            self.assertEqual(worker.call_args.args[1]['action'], 'preview')
            self.assertEqual(worker.call_args.args[1]['native_reference_targets'], private_refs)
            self.assertNotIn('DO_NOT_PRINT', output.call_args.args[0])
            self.assertNotIn('synthetic-private-session', output.call_args.args[0])
        self.assertEqual(list(self.data.iterdir()), [])
        self.assertEqual(list(self.home.iterdir()), [])

    def test_failed_pin_preflight_never_reaches_native_mutation(self):
        argv = ['--cutoff', self.args.cutoff, '--data-root', str(self.data), '--hermes-home', str(self.home),
                '--config', str(self.config), '--postgres-dsn-file', str(self.dsn), '--execute',
                '--backup-marker', self.args.backup_marker, '--backup-bundle', self.args.backup_bundle]
        with patch.object(tool, 'require_stopped'), \
             patch.object(tool, 'native', return_value={'status': 'preview', 'blockers': []}) as native, \
             patch.object(tool, 'node', side_effect=tool.ResetError('RESET_WORKER_FAILED:cold_backup_pin')):
            with self.assertRaisesRegex(tool.ResetError, 'cold_backup_pin'):
                tool.main(argv)
            self.assertEqual(native.call_count, 1)
            self.assertFalse(native.call_args.kwargs.get('execute', False))

    def test_untrusted_worker_error_is_redacted(self):
        args = SimpleNamespace(node='node', node_command_file=None)
        result = SimpleNamespace(returncode=1, stdout=json.dumps({'stage': 'DO_NOT_PRINT', 'code': 'DO_NOT_PRINT'}))
        with patch.object(tool.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(tool.ResetError, '^RESET_WORKER_FAILED:worker$'):
                tool.node(args, {})


if __name__ == '__main__':
    unittest.main()
