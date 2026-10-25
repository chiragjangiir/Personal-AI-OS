"""First-run import uses the real model authority and preserves later settings."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).parents[2]
spec = importlib.util.spec_from_file_location('single_host_models', ROOT / 'deploy/cloud/single_host_models.py')
models = importlib.util.module_from_spec(spec)
spec.loader.exec_module(models)


def test_single_host_import_publishes_both_profiles_and_never_reimports(tmp_path, monkeypatch):
    for role in models.ROLES:
        monkeypatch.delenv('PAIOS_' + role.upper() + '_MODEL', raising=False)
    monkeypatch.setenv('PAIOS_BRAIN_MODEL', 'fixture-brain')
    monkeypatch.setenv('PAIOS_BRAIN_BASE_URL', 'https://model.example.com/v1')
    monkeypatch.setenv('PAIOS_BRAIN_CONTEXT_LIMIT', '32768')
    monkeypatch.setenv('PAIOS_BRAIN_MAX_OUTPUT_TOKENS', '128')
    monkeypatch.setenv('PAIOS_EXECUTOR_FAST_MODEL', 'fixture-executor')
    monkeypatch.setenv('PAIOS_EXECUTOR_FAST_BASE_URL', 'https://executor.example.com/v1')
    snapshot = tmp_path / 'import.json'
    snapshot.write_text(json.dumps(models.snapshot(models.configured_roles())))
    master = tmp_path / 'master.key'
    master.write_bytes(bytes(range(32)))
    master.chmod(0o600)
    output = tmp_path / 'projections'
    command = ['node', str(ROOT / 'deploy/cloud/model-settings-project.ts'),
               '--directory', str(tmp_path / 'authority'), '--master', str(master),
               '--environment', 'single-host', '--output', str(output), '--revision', 'current', '--publish']
    keys = {'single-host-brain': 'fixture-brain-credential'}
    brain = [*command, '--profile', 'owner', '--group', 'brain', '--import', str(snapshot),
             '--bootstrap', '--keys-stdin']
    imported = subprocess.run(brain, input=json.dumps(keys), capture_output=True, text=True)
    assert imported.returncode == 0, imported.stderr
    subprocess.run([*command, '--profile', 'workshop', '--group', 'build'], check=True, capture_output=True)
    current = (output / 'current.json').read_bytes()
    owner = json.loads(current)
    build = json.loads((output / 'build-current.json').read_text())
    assert owner['configured'] and build['configured']
    assert owner['config']['model']['default'] == build['config']['model']['default'] == 'fixture-brain'
    assert owner['config']['model']['context_length'] == 32768
    assert owner['config']['model']['request_overrides']['max_tokens'] == 128
    assert owner['config']['auxiliary']['compression']['model'] == 'fixture-brain'
    assert owner['config']['auxiliary']['call_intent']['model'] == 'fixture-brain'
    assert owner['config']['auxiliary']['title_generation']['enabled'] is False
    assert 'single-host-executor-fast' not in owner['config']['providers']
    assert (output / 'current.json').stat().st_mode & 0o777 == 0o400
    # A rerun cannot restore .env over the settings authority, even with invalid new import bytes.
    snapshot.write_text('this must not be read after the first import')
    repeated = subprocess.run(brain, input=json.dumps({'single-host-brain': ''}), capture_output=True, text=True)
    assert repeated.returncode == 0, repeated.stderr
    assert (output / 'current.json').read_bytes() == current
    for value in keys.values():
        assert value not in imported.stdout + imported.stderr + repeated.stdout + repeated.stderr
        for path in output.rglob('*.json'):
            assert value not in path.read_text()


def test_model_keys_are_emitted_only_for_stdin_from_protected_files(tmp_path, monkeypatch):
    environment = {name: value for name, value in os.environ.items() if not name.startswith('PAIOS_')}
    environment.update(PAIOS_BRAIN_MODEL='fixture', PAIOS_BRAIN_BASE_URL='https://model.example.com/v1')
    key = 'fixture-provider-credential'
    (tmp_path / 'role-brain.key').write_text(key + '\n')
    result = subprocess.run(['python3', str(ROOT / 'deploy/cloud/single_host_models.py'), '--keys', str(tmp_path)],
                            env=environment, check=True, capture_output=True, text=True)
    assert json.loads(result.stdout) == {'single-host-brain': key}
    assert not result.stderr


def test_optional_role_placeholder_accepts_its_first_key_and_preserves_nonempty_keys(tmp_path):
    environment = {name: value for name, value in os.environ.items() if not name.startswith('PAIOS_')}
    environment.update(PAIOS_BRAIN_API_KEY='fixture-key', PAIOS_PHONE_PROVIDER='off')
    secrets = tmp_path / 'secrets'
    command = ['python3', str(ROOT / 'deploy/cloud/prepare-secrets.py'), '--bootstrap',
               '--secrets-dir', str(secrets), '--public-host', 'localhost', '--public-ipv4', '127.0.0.1']
    subprocess.run(command, env=environment, check=True, capture_output=True)
    master = (secrets / 'model-settings-master.key').read_bytes()
    brain = (secrets / 'role-brain.key').read_bytes()
    executor = secrets / 'role-executor-fast.key'
    assert executor.read_bytes() == b''
    environment.update(PAIOS_BRAIN_API_KEY='replacement-key', PAIOS_EXECUTOR_FAST_MODEL='fixture-fast',
                       PAIOS_EXECUTOR_FAST_API_KEY='first-key')
    subprocess.run(command, env=environment, check=True, capture_output=True)
    assert executor.read_text() == 'first-key\n'
    environment['PAIOS_EXECUTOR_FAST_API_KEY'] = 'second-key'
    subprocess.run(command, env=environment, check=True, capture_output=True)
    assert executor.read_text() == 'first-key\n'
    assert (secrets / 'role-brain.key').read_bytes() == brain
    assert (secrets / 'model-settings-master.key').read_bytes() == master
    (secrets / 'role-brain.key').unlink()
    environment['PAIOS_BRAIN_API_KEY'] = ''
    subprocess.run(command, env=environment, check=True, capture_output=True)
    assert (secrets / 'role-brain.key').read_bytes() == b''
    assert (secrets / 'model-settings-master.key').read_bytes() == master
