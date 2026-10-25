"""The remote builder starts from a fresh profile and a separate SSH identity."""
import importlib.util
from pathlib import Path

import pytest
import yaml


CLOUD = Path(__file__).parents[2] / 'deploy/cloud'


def load_initializer():
    spec = importlib.util.spec_from_file_location('builder_init', CLOUD / 'workshop-builder-init.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(autouse=True)
def authority_projection(tmp_path, monkeypatch):
    import json
    value = {'environment_id': 'test-builder', 'profile': 'builder', 'revision': 3, 'group': 'build',
        'configured': True, 'config': {'model': {'default': 'fixture-build', 'provider': 'fixture-provider',
        'base_url': 'https://fixture.invalid/v1'}, 'providers': {'fixture-provider': {
        'base_url': 'https://fixture.invalid/v1', 'key_env': 'TEST_BUILDER_KEY', 'api_mode': 'chat_completions'}},
        'fallback_providers': [], 'workshop': {}},
        'credentials': [{'name': 'TEST_BUILDER_KEY', 'handle': 'build-only-handle'}]}
    path = tmp_path / 'projection.json'
    path.write_text(json.dumps(value))
    monkeypatch.setenv('PAIOS_MODEL_SETTINGS_PROJECTION', str(path))
    return path


def test_builder_consumes_only_revisioned_authority(tmp_path, monkeypatch, authority_projection):
    import json
    initializer = load_initializer()
    monkeypatch.setattr(initializer.os, 'geteuid', lambda: 10000)
    home, access = tmp_path / 'home', tmp_path / 'access'
    home.mkdir()
    (home / 'config.yaml').write_text('model: {default: stale-owner}\nmcp_servers: {owner: {command: owner-command}}\n')
    monkeypatch.setenv('PAIOS_BUILDER_MODEL', 'ignored-env-model')
    monkeypatch.setenv('PAIOS_BUILDER_BASE_URL', 'https://ignored.invalid/v1')
    config = initializer.prepare_builder_home(home, access)
    assert config['model'] == json.loads(authority_projection.read_text())['config']['model']
    assert config['model_settings']['revision'] == 3
    assert config['mcp_servers'] == {} and config['plugins'] == {'enabled': []}
    assert config['skills']['external_dirs'] == []
    assert config['memory'] == {'memory_enabled': False, 'user_profile_enabled': False}
    assert (config['agent']['max_tool_calls'], config['agent']['tool_call_milestone_interval']) == (120, 20)
    assert not {'max_turns', 'background_max_turns', 'run_budget_seconds'} & config['agent'].keys()
    key = home / 'workshop-ssh/id_ed25519'
    assert (access / 'authorized_keys').read_bytes() == (
        b'restrict,command="/usr/local/bin/workshop-scope" ' + key.with_suffix('.pub').read_bytes())
    public_key = key.with_suffix('.pub').read_bytes()
    assert initializer.prepare_builder_home(home, access) == config
    assert key.with_suffix('.pub').read_bytes() == public_key
    assert yaml.safe_load((home / 'workshop/config.yaml').read_text()) == config


def test_unconfigured_builder_fails_before_writing_home(tmp_path, monkeypatch, authority_projection):
    import json
    value = json.loads(authority_projection.read_text())
    value['configured'] = False
    authority_projection.write_text(json.dumps(value))
    with pytest.raises(ValueError, match='模型与密钥'):
        load_initializer().prepare_builder_home(tmp_path / 'home', tmp_path / 'access')
    assert not (tmp_path / 'home').exists()


def test_standalone_builder_has_no_owner_volumes_or_external_coding_cli():
    compose = yaml.safe_load((CLOUD / 'compose.workshop-build.yaml').read_text())
    assert set(compose['services']) == {'builder', 'workshop'}
    builder, workshop = compose['services']['builder'], compose['services']['workshop']
    assert builder['ports'] == ['${PAIOS_BUILDER_BIND:-127.0.0.1}:${PAIOS_BUILDER_PORT:-18664}:18664']
    # Docker forwards to the container interface; the host publication stays loopback-only.
    assert builder['environment']['PAIOS_BUILDER_BIND'] == '0.0.0.0'
    assert 'PAIOS_BUILDER_BIND=127.0.0.1' in (CLOUD / 'workshop-build.env.example').read_text().splitlines()
    assert 'PAIOS_BUILDER_MODEL' not in builder['environment']
    assert 'PAIOS_BUILDER_REPAIR_MODEL' not in builder['environment']
    assert builder['entrypoint'] == ['/opt/hermes/.venv/bin/python']
    assert builder['command'] == ['/opt/paios/integrations/hermes/personal_aios/workshop_builder.py']
    assert builder['volumes'] == ['workshop-access:/run/workshop-access',
        '${PAIOS_MODEL_SETTINGS_PROJECTION_DIR:?}:/etc/paios/model-settings:ro',
        '${PAIOS_SECRET_ROOT:?}/model-settings-service.key:/run/secrets/model-settings-service.key:ro',
        '${PAIOS_SECRET_ROOT:?}/workshop-builder.key:/run/secrets/workshop-builder.key:ro',
        '${PAIOS_SECRET_ROOT:?}/workshop-builder.crt:/run/secrets/workshop-builder.crt:ro',
        '${PAIOS_SECRET_ROOT:?}/workshop-builder.tls.key:/run/secrets/workshop-builder.tls.key:ro',
        '${PAIOS_RELEASE_REQUESTS:?}:/srv/release-requests']
    # Product repair reads the build host's source store; it never receives owner data, secrets or Docker.
    assert workshop['volumes'] == ['workshop-access:/run/workshop-access:ro',
        '${PAIOS_BUILDER_PUBLIC_IPV4_FILE:?}:/run/workshop-public-ipv4:ro', '${PAIOS_RELEASE_REPO:?}:/srv/source.git:ro']
    assert '/workshop' in workshop['tmpfs']
    assert '/srv/owner' in workshop['tmpfs']
    assert "'{}' > /srv/owner/config.json" in workshop['command'][0]
    assert 'PAIOS_BUILDER_PROVIDER' not in builder['environment']


def test_builder_and_both_clients_share_pinned_tls_certificate():
    builder = yaml.safe_load((CLOUD / 'compose.workshop-build.yaml').read_text())['services']['builder']
    cert = '/run/secrets/workshop-builder.crt'
    key = '/run/secrets/workshop-builder.tls.key'
    assert builder['environment']['PAIOS_BUILDER_TLS_CERT_FILE'] == cert
    assert builder['environment']['PAIOS_BUILDER_TLS_KEY_FILE'] == key
    clients = yaml.safe_load((CLOUD / 'compose.workshop-client.yaml').read_text())['services']
    for name, secret_dir in [('hermes', 'PAIOS_SECRETS_DIR'),
                             ('hermes-staging', 'PAIOS_STAGING_SECRETS_DIR')]:
        client = clients[name]
        assert client['environment']['PAIOS_BUILDER_CA_FILE'] == cert
        assert client['volumes'] == [
            '${' + secret_dir + ':?}/workshop-builder.key:/run/secrets/workshop-builder.key:ro',
            '${' + secret_dir + ':?}/workshop-builder.crt:' + cert + ':ro']
        assert all('workshop-builder.tls.key' not in mount for mount in client['volumes'])


def test_root_hands_each_directory_over_after_its_contents(tmp_path, monkeypatch):
    # The container's root has no CAP_DAC_OVERRIDE: once a 0700 parent belongs to 10000 it cannot reach the children.
    initializer = load_initializer()
    owned = []
    def chown(path, uid, gid):
        assert not any(Path(path).is_relative_to(parent) for parent in owned), path
        owned.append(Path(path))
    monkeypatch.setattr(initializer.os, 'geteuid', lambda: 0)
    monkeypatch.setattr(initializer.os, 'chown', chown)
    initializer.prepare_builder_home(tmp_path / 'home', tmp_path / 'access')
    assert owned[-1] == tmp_path / 'home'
