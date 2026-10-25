"""Offline staging transport isolation; all credentials are synthetic."""
import json
from pathlib import Path
import sys

import pytest

TOOLS = Path(__file__).parents[2] / 'deploy/cloud'
sys.path.insert(0, str(TOOLS))
import migrate
import staging_snapshot_data as data
import staging_model_settings as model_settings


@pytest.mark.parametrize('environment', ['staging-fixture', 'staging-secondary', 'staging-team.blue'])
def test_staging_authority_identity_is_deployment_configuration(environment):
    assert model_settings.staging_environment(environment) == environment


@pytest.mark.parametrize('environment', [None, '', 'production', 'staging', 'staging-../other',
    'staging-UPPER', 'staging-' + 'x' * 121])
def test_invalid_staging_identity_fails_before_projection_read(tmp_path, environment):
    with pytest.raises(ValueError, match='target staging model-settings environment'):
        model_settings.load_projection(tmp_path / 'absent.json', environment, tmp_path)


def test_snapshot_config_contains_no_executable_transport(tmp_path):
    source, target = tmp_path / 'production.yaml', tmp_path / 'stage.json'
    source.write_text('timezone: Asia/Shanghai\nmodel: production\nproviders: {production: {api_key: fake-production-key}}\n'
                      'delegation: {model: production}\ncron: {model: production}\n')
    data.home_config(source, target)
    assert json.loads(target.read_text()) == {'timezone': 'Asia/Shanghai'}


@pytest.mark.parametrize('relative', ['.env', 'profiles/build/.env', 'auth.json', 'auth/provider.json',
    'model-settings.sqlite3', 'model-settings.sqlite3-wal', 'model-settings-master.key',
    'transport-overrides.json', 'profiles/build/config.yaml', 'credentials/provider.json',
    'auth.json.corrupt', 'backups/config.yaml.old', '.credentials.json', 'model-settings/usage.sqlite',
    'model-projections/current.json'])
def test_both_snapshot_chains_exclude_model_authority_and_credentials(tmp_path, relative):
    source, target = tmp_path / 'source', tmp_path / 'target'
    path = source / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('fake-production-secret')
    data.copy_tree(source, target)
    assert not (target / relative).exists()
    assert path not in list(migrate.owner_paths(source, staging=True))


def test_migrate_staging_never_selects_production_secrets(tmp_path):
    for name in ('deepseek.key', 'siliconflow.key', 'tavily.key', 'postgres.password'):
        (tmp_path / name).write_text('fake-production-secret')
    assert migrate.staging_secret_names() == set()
    assert migrate.staging_secret_files(tmp_path) == []


@pytest.fixture
def projection(tmp_path):
    value = {'environment_id': 'staging-fixture', 'profile': 'owner', 'group': 'brain', 'revision': 3,
             'configured': True, 'config': {'model': {'default': 'fake-stage-model'}, 'fallback_providers': [],
             'delegation': {'enabled': False}}, 'credentials': [{'name': 'STAGE_KEY', 'handle': 'fake-stage-handle'}]}
    path = tmp_path / 'projection.json'
    path.write_text(json.dumps(value))
    return path, value


@pytest.mark.parametrize('environment,configured,error', [
    ('staging-secondary', True, 'target staging authority'), ('staging-fixture', False, 'credentials must be configured')])
def test_target_authority_identity_and_missing_key_fail_closed(tmp_path, projection, environment, configured, error):
    path, value = projection
    value['configured'] = configured
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError, match=error):
        model_settings.load_projection(path, environment, tmp_path)


def test_inert_control_projection_does_not_start_staging_models(tmp_path, projection):
    path, value = projection
    value.update(configured=False, credentials=[],
                 config={'model': {'enabled': False}, 'providers': {}, 'fallback_providers': []})
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError, match='credentials must be configured'):
        model_settings.load_projection(path, 'staging-fixture', tmp_path)


@pytest.mark.parametrize('missing', ['brain', 'build'])
def test_restore_requires_target_projection_before_docker_or_model_start(tmp_path, monkeypatch, projection, missing):
    (tmp_path / 'manifest.json').write_text('{}')
    monkeypatch.setattr(migrate, 'run', lambda *args, **kwargs: pytest.fail('Docker reached before authority preflight'))
    from types import SimpleNamespace
    with pytest.raises(ValueError, match='projection is required'):
        migrate.restore(SimpleNamespace(bundle=tmp_path, secrets_dir=tmp_path, staging=True,
            model_settings_environment='staging-fixture', model_settings_projection=None if missing == 'brain' else projection[0],
            model_settings_build_projection=None))


def test_target_projection_replaces_all_restored_transport(tmp_path, projection, monkeypatch):
    path, value = projection
    home = tmp_path / 'home'
    home.mkdir()
    (home / 'config.yaml').write_text('model: production\nauxiliary: {model: production}\ncron: {model: production}\n')
    monkeypatch.setattr(model_settings.os, 'chown', lambda *args: None)
    model_settings.install_projection(model_settings.load_projection(path, 'staging-fixture', tmp_path), home)
    assert json.loads((home / 'config.yaml').read_text()) == value['config']
    assert model_settings.receipt({'brain': value}) == {'brain': {key: value[key] for key in
        ('environment_id', 'profile', 'revision', 'group', 'configured')}}


def test_missing_or_cross_environment_build_projection_blocks_restore(tmp_path, projection):
    path, value = projection
    with pytest.raises(ValueError, match='projection is required'):
        model_settings.load_projections(path, None, 'staging-fixture', tmp_path)
    build = tmp_path / 'build.json'
    value.update(profile='workshop', group='build', environment_id='staging-secondary')
    build.write_text(json.dumps(value))
    with pytest.raises(ValueError, match='target staging authority'):
        model_settings.load_projections(path, build, 'staging-fixture', tmp_path)


def test_legacy_snapshot_vault_is_rejected_before_install(tmp_path):
    import sqlite3
    home = tmp_path / 'hermes-home'
    home.mkdir()
    with sqlite3.connect(home / 'state.db') as database:
        database.executescript('CREATE TABLE sessions(id TEXT); CREATE TABLE messages(session_id TEXT);')
    (tmp_path / 'owner-data').mkdir()
    (tmp_path / 'owner-data/model-settings.sqlite3').write_text('fake-production-vault')
    expected = data.inventory(tmp_path)
    with pytest.raises(ValueError, match='environment credentials or transport'):
        data.verify(tmp_path, expected)


def test_restore_installs_both_runtime_projection_paths(tmp_path, projection, monkeypatch):
    _, brain = projection
    build = {**brain, 'profile': 'workshop', 'group': 'build'}
    monkeypatch.setattr(model_settings.os, 'chown', lambda *args: None)
    directory = tmp_path / 'target-projection-volume'
    model_settings.install_projections({'brain': brain, 'build': build}, tmp_path / 'home', directory)
    assert not (tmp_path / 'home/model-settings').exists()
    for filename, expected in [('current.json', brain), ('build-current.json', build),
                               ('revisions/3/owner.json', brain), ('revisions/3/workshop.json', build)]:
        assert json.loads((directory / filename).read_text()) == expected
        assert (directory / filename).stat().st_mode & 0o777 == 0o400
