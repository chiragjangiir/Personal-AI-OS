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


@pytest.mark.parametrize('repair_environment', [None, ''])
def test_builder_profile_never_inherits_owner_configuration(tmp_path, monkeypatch, repair_environment):
    monkeypatch.delenv('PAIOS_BUILDER_REPAIR_MODEL', raising=False)
    if repair_environment is not None:
        monkeypatch.setenv('PAIOS_BUILDER_REPAIR_MODEL', repair_environment)
    initializer = load_initializer()
    monkeypatch.setattr(initializer.os, 'geteuid', lambda: 10000)
    home, access = tmp_path / 'home', tmp_path / 'access'
    home.mkdir()
    (home / 'config.yaml').write_text('mcp_servers: {owner: {command: owner-command}}\n')
    config = initializer.prepare_builder_home(home, access)
    assert yaml.safe_load((home / 'config.yaml').read_text()) == config
    assert yaml.safe_load((home / 'workshop/config.yaml').read_text()) == config
    assert config['model'] == {'default': 'deepseek-v4.1-flash', 'provider': 'paios-builder',
                              'base_url': 'https://opencode.ai/zen/go/v1'}
    assert config['custom_providers'][0]['api_mode'] == 'chat_completions'
    assert config['custom_providers'][0]['key_env'] == 'PAIOS_BUILDER_API_KEY'
    assert config['workshop'] == {}
    assert config['mcp_servers'] == {}
    assert config['plugins'] == {'enabled': []}
    assert config['skills']['external_dirs'] == []
    assert config['memory'] == {'memory_enabled': False, 'user_profile_enabled': False}
    # Builds follow the product budget rule: a shared tool-call cap, no turn or time limit.
    assert (config['agent']['max_tool_calls'], config['agent']['tool_call_milestone_interval']) == (120, 20)
    assert not {'max_turns', 'background_max_turns', 'run_budget_seconds'} & config['agent'].keys()
    key = home / 'workshop-ssh/id_ed25519'
    assert config['terminal']['ssh_key'] == str(key)
    assert (access / 'authorized_keys').read_bytes() == (
        b'restrict,command="/usr/local/bin/workshop-scope" ' + key.with_suffix('.pub').read_bytes())
    public_key = key.with_suffix('.pub').read_bytes()
    initializer.prepare_builder_home(home, access)
    assert key.with_suffix('.pub').read_bytes() == public_key
    monkeypatch.setenv('PAIOS_BUILDER_PROVIDER', 'owner-builder')
    monkeypatch.setenv('PAIOS_BUILDER_MODEL', 'owner-model')
    monkeypatch.setenv('PAIOS_BUILDER_BASE_URL', 'https://model.example/v1')
    changed = initializer.prepare_builder_home(home, access)
    assert changed['model'] == {'provider': 'owner-builder', 'default': 'owner-model',
                                'base_url': 'https://model.example/v1'}
    assert changed['workshop'] == {}


@pytest.mark.parametrize('repair_environment', [None, ''])
def test_builder_preserves_only_repair_model_override(tmp_path, monkeypatch, repair_environment):
    monkeypatch.delenv('PAIOS_BUILDER_REPAIR_MODEL', raising=False)
    if repair_environment is not None:
        monkeypatch.setenv('PAIOS_BUILDER_REPAIR_MODEL', repair_environment)
    initializer = load_initializer()
    monkeypatch.setattr(initializer.os, 'geteuid', lambda: 10000)
    home = tmp_path / 'home'
    home.mkdir()
    (home / 'config.yaml').write_text(yaml.safe_dump({
        'workshop': {'repair_model': 'stronger-fixture', 'owner_data': 'excluded'},
        'model': {'default': 'owner-model'}, 'mcp_servers': {'owner': {}},
    }))
    config = initializer.prepare_builder_home(home, tmp_path / 'access')
    assert config['workshop'] == {'repair_model': 'stronger-fixture'}
    assert config['model']['default'] == 'deepseek-v4.1-flash'
    assert config['mcp_servers'] == {}
    monkeypatch.setenv('PAIOS_BUILDER_REPAIR_MODEL', 'benchmark-fixture')
    changed = initializer.prepare_builder_home(home, tmp_path / 'access')
    assert changed['workshop'] == {'repair_model': 'benchmark-fixture'}
    assert changed['model'] == config['model']
    assert changed['custom_providers'] == config['custom_providers']
    assert yaml.safe_load((home / 'workshop/config.yaml').read_text()) == changed


def test_builder_rejects_native_opencode_provider_before_writing(tmp_path, monkeypatch):
    monkeypatch.setenv('PAIOS_BUILDER_PROVIDER', 'opencode-go')
    with pytest.raises(ValueError, match='custom provider name'):
        load_initializer().prepare_builder_home(tmp_path / 'home', tmp_path / 'access')
    assert not (tmp_path / 'home').exists()


@pytest.mark.parametrize('repair_model', ['', '   ', 123, {'provider': 'other'}])
def test_builder_rejects_invalid_repair_model_without_replacing_profile(tmp_path, monkeypatch, repair_model):
    initializer = load_initializer()
    home = tmp_path / 'home'
    home.mkdir()
    path = home / 'config.yaml'
    saved = yaml.safe_dump({'workshop': {'repair_model': repair_model}})
    path.write_text(saved)
    with pytest.raises(ValueError, match='nonempty model name'):
        initializer.prepare_builder_home(home, tmp_path / 'access')
    assert path.read_text() == saved
    assert not (home / 'workshop-ssh').exists()


def test_builder_rejects_whitespace_environment_before_writing(tmp_path, monkeypatch):
    monkeypatch.setenv('PAIOS_BUILDER_REPAIR_MODEL', '   ')
    with pytest.raises(ValueError, match='nonempty model name'):
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
    assert builder['environment']['PAIOS_BUILDER_REPAIR_MODEL'] == '${PAIOS_BUILDER_REPAIR_MODEL:-}'
    assert builder['entrypoint'] == ['/opt/hermes/.venv/bin/python']
    assert builder['command'] == ['/opt/paios/integrations/hermes/personal_aios/workshop_builder.py']
    assert builder['volumes'] == ['workshop-access:/run/workshop-access',
        '${PAIOS_SECRET_ROOT:?}/opencode.key:/run/secrets/opencode.key:ro',
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
    assert builder['environment']['PAIOS_BUILDER_PROVIDER'] != 'opencode-go'


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
