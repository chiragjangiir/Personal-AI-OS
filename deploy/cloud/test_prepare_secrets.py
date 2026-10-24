"""Host secret lifecycle checks with synthetic keys and temporary directories."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('prepare-secrets.py')
INTERNAL = ('postgres.password', 'proxy-attestation', 'livekit-api-key', 'livekit-api-secret',
            'hermes-api.key', 'hermes-internal.key', 'frp-token', 'payment-executor.key',
            'voiceprint.key', 'e2ee-root-key')
ROLES = ('BRAIN', 'VISION', 'EXECUTOR_FAST', 'EXECUTOR_THOROUGH', 'REALTIME', 'TTS', 'WORKSHOP_REPAIR')


class PrepareSecretsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.secrets = self.root / 'secrets'
        self.tls = self.root / 'tls'
        self.environment = {key: value for key, value in os.environ.items()
                            if not key.startswith('PAIOS_')}

    def run_prepare(self, *flags, **environment):
        return subprocess.run([sys.executable, str(SCRIPT), '--secrets-dir', str(self.secrets),
                               '--public-host', 'fixture.invalid', '--public-ipv4', '192.0.2.10',
                               *flags], env={**self.environment, **environment},
                              capture_output=True, text=True)

    def test_configured_optional_role_names_its_missing_key_before_writing(self):
        for role in ROLES[1:]:
            with self.subTest(role=role):
                result = self.run_prepare('--bootstrap', **{'PAIOS_BRAIN_API_KEY': 'k' * 32,
                    f'PAIOS_{role}_MODEL': 'configured-role'})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f'PAIOS_{role}_API_KEY', result.stderr)
                self.assertFalse(self.secrets.exists())

    def test_first_boot_preserves_credentials_and_permissions_across_restart(self):
        self.secrets.mkdir()
        preserved = b'synthetic-existing-token\r\n'
        (self.secrets / 'hermes-api.key').write_bytes(preserved)
        result = self.run_prepare('--bootstrap', PAIOS_BRAIN_API_KEY='synthetic-brain')
        self.assertEqual(result.returncode, 0, result.stderr)
        before = {path.name: path.read_bytes() for path in self.secrets.iterdir() if path.is_file()}
        self.assertEqual(before['hermes-api.key'], preserved)
        for name in INTERNAL:
            self.assertTrue(before[name])
        for name in ('payment-executor.key', 'voiceprint.key'):
            self.assertEqual(len(base64.b64decode(before[name])), 32)
        self.assertRegex(before['e2ee-root-key'].decode(), r'^[A-Za-z0-9_-]{43}$')
        self.assertEqual(len(before['e2ee-root-key']), 43)
        self.assertEqual(len(before['proxy-attestation']), 43)
        result = self.run_prepare('--bootstrap', PAIOS_BRAIN_API_KEY='x' * 32)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.secrets.iterdir() if path.is_file()})
        for path in self.secrets.iterdir():
            if path.is_file():
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertNotIn(path.read_text().strip() or 'not-a-secret', result.stdout + result.stderr)
        self.assertTrue((self.secrets / 'owner-mac').is_dir())
        self.assertEqual(json.loads((self.secrets / 'livekit.yaml').read_text())['turn'], {'enabled': False})

    def test_missing_brain_key_names_variable_and_does_not_generate_credentials(self):
        result = self.run_prepare('--bootstrap')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('PAIOS_BRAIN_API_KEY', result.stderr)
        self.assertFalse(self.secrets.exists())

    def test_role_keys_are_explicit_and_existing_key_satisfies_validation(self):
        environment = {f'PAIOS_{role}_API_KEY': f'synthetic-{role}' for role in ROLES}
        result = self.run_prepare('--bootstrap', **environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        for role in ROLES:
            path = self.secrets / ('role-' + role.lower().replace('_', '-') + '.key')
            self.assertEqual(path.read_text(), f'synthetic-{role}\n')
        result = self.run_prepare('--bootstrap')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_optional_role_can_be_added_after_first_boot(self):
        result = self.run_prepare('--bootstrap', PAIOS_BRAIN_API_KEY='synthetic-brain')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.secrets / 'role-vision.key').exists())
        result = self.run_prepare('--bootstrap', PAIOS_VISION_API_KEY='synthetic-vision')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.secrets / 'role-vision.key').read_text(), 'synthetic-vision\n')

    def test_explicit_uid_owns_new_files_and_directories(self):
        result = self.run_prepare('--bootstrap', '--uid', str(os.getuid()), '--tls-dir', str(self.tls),
                                  PAIOS_BRAIN_API_KEY='synthetic-brain')
        self.assertEqual(result.returncode, 0, result.stderr)
        for directory in (self.secrets, self.tls, self.secrets / 'owner-mac'):
            self.assertEqual(directory.stat().st_uid, os.getuid())
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            for path in directory.iterdir():
                self.assertEqual(path.stat().st_uid, os.getuid())

    def test_private_invocation_does_not_require_model_key_or_tls(self):
        result = self.run_prepare('--staging')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.tls.exists())
        self.assertFalse((self.secrets / 'role-brain.key').exists())
        self.assertFalse((self.secrets / 'agentbay.key').exists())

    def test_generated_tls_has_dns_ip_sans_and_keeps_bytes(self):
        result = self.run_prepare('--tls-dir', str(self.tls))
        self.assertEqual(result.returncode, 0, result.stderr)
        before = {path.name: path.read_bytes() for path in self.tls.iterdir()}
        cert = subprocess.run(['openssl', 'x509', '-in', str(self.tls / 'fullchain.pem'),
                               '-noout', '-text'], check=True, capture_output=True, text=True).stdout
        self.assertIn('DNS:fixture.invalid', cert)
        self.assertIn('IP Address:192.0.2.10', cert)
        self.assertIn('CA:FALSE', cert)
        self.assertIn('Digital Signature, Key Encipherment', cert)
        self.assertIn('TLS Web Server Authentication', cert)
        result = self.run_prepare('--tls-dir', str(self.tls))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.tls.iterdir()})
        for path in self.tls.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_ip_host_certificate_has_ip_san(self):
        result = self.run_prepare('--tls-dir', str(self.tls), '--public-host', '192.0.2.10')
        self.assertEqual(result.returncode, 0, result.stderr)
        cert = subprocess.run(['openssl', 'x509', '-in', str(self.tls / 'fullchain.pem'),
                               '-noout', '-text'], check=True, capture_output=True, text=True).stdout
        self.assertIn('IP Address:192.0.2.10', cert)
        self.assertNotIn('DNS:192.0.2.10', cert)

    def test_supplied_tls_preserves_bytes_and_rejects_incomplete_pair(self):
        self.tls.mkdir()
        (self.tls / 'fullchain.pem').write_bytes(b'synthetic supplied certificate\r\n')
        result = self.run_prepare('--tls-dir', str(self.tls))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('both fullchain.pem and privkey.pem', result.stderr)
        (self.tls / 'privkey.pem').write_bytes(b'synthetic supplied key\r\n')
        before = {path.name: path.read_bytes() for path in self.tls.iterdir()}
        result = self.run_prepare('--tls-dir', str(self.tls))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.tls.iterdir()})


if __name__ == '__main__':
    unittest.main()
