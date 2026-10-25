"""Release identities observe host authorities and compare only deployable facts."""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'deploy/cloud'))
import release_identity as identity


@pytest.fixture
def observed(tmp_path, monkeypatch):
    current = tmp_path / 'release'
    (current / '.release').mkdir(parents=True)
    (current / '.release/source.json').write_text('{"commit": "commit"}')
    (current / '.release/snapshot.json').write_text(json.dumps({'as_of': '2026-10-24T03:00:00Z'}))
    cloud = tmp_path / 'cloud.json'
    cloud.write_text(json.dumps({'payment': {'enabled': False, 'staging': True}, 'product_resources': {}}))
    services = ['gateway', 'hermes', 'front', 'workshop', 'release-watchdog', 'postgres', 'livekit']
    definition = {'services': {s + '-staging': {} for s in services}}
    definition['services']['gateway-staging']['volumes'] = [{'source': str(cloud), 'target': '/etc/paios/cloud.json'}]
    rows = [{'Config': {'Labels': {'com.docker.compose.service': s + '-staging'}}, 'Image': 'sha256:' + s,
             'State': {'Running': True, 'Status': 'running'}}
            for s in services]
    monkeypatch.setattr(identity.release_checks, 'containers', lambda run: rows)
    def inside(run, service, interpreter, code):
        assert service == 'hermes-staging'
        compile(code, '<native-identity>', 'exec')
        return {'native_tree': 'tree', 'skill_catalog': 'skills', 'package_registry': 'packages',
                'native_config_version': 46, 'native_latest_config_version': 46}
    monkeypatch.setattr(identity.release_checks, 'inside', inside)
    host = SimpleNamespace(stage='staging', suffix='-staging', config={}, release=lambda name: current,
                           commit=lambda release: 'commit', runner=lambda release: None,
                           definition=lambda release: definition)
    return host, current


def test_capture_reads_actual_service_images_and_snapshot_receipt(observed):
    host, _ = observed
    state = identity.capture(host)
    assert state['schema'] == 'paios.production-state.v1'
    assert state['images']['watchdog'] == 'sha256:release-watchdog'
    assert state['inactive_roles'] == {} and state['auxiliary_service_images'] == {}
    assert state['service_images']['postgres'] == 'sha256:postgres'
    assert state['native_tree'] == 'tree'
    assert state['config_schema']['native'] == 46
    assert state['snapshot_at'] == '2026-10-24T03:00:00+00:00'


def test_compare_equal_ignores_host_paths_and_publish_time(observed):
    state = identity.capture(observed[0])
    other = {**state, 'release': 'another-host-path', 'published_at': 'later',
             'auxiliary_service_images': {'frpc': 'another-host-image'}}
    assert identity.compare(state, other) == {'equal': True, 'differences': {}}


def test_staging_parity_retains_the_deliberately_disarmed_watchdog_inventory(observed):
    host, _ = observed
    running = identity.capture(host)
    row = next(row for row in identity.release_checks.containers(None)
               if row['Config']['Labels']['com.docker.compose.service'] == 'release-watchdog-staging')
    row['State'] = {'Running': False, 'Status': 'created'}
    disarmed = identity.capture(host)
    assert 'watchdog' not in disarmed['images']
    assert disarmed['inactive_roles'] == {'watchdog': {'running': False, 'reason': 'container_created'}}
    assert disarmed['service_images']['release-watchdog'] == row['Image']
    assert identity.compare(running, disarmed) == {'equal': True, 'differences': {}}


@pytest.mark.parametrize('field', identity.FIELDS)
def test_compare_reports_each_differing_authority(observed, field):
    state = identity.capture(observed[0])
    other = copy.deepcopy(state)
    other[field] = 'changed'
    result = identity.compare(state, other)
    assert result == {'equal': False, 'differences': {field: {'production': state[field], 'staging': 'changed'}}}


def test_production_snapshot_requires_real_manifest_sidecar(observed, tmp_path):
    host, current = observed
    host.stage = 'production'
    settings = tmp_path / 'snapshot-settings.json'
    settings.write_text(json.dumps({'spool': str(tmp_path / 'spool')}))
    host.config['snapshot_settings'] = str(settings)
    with pytest.raises(ValueError, match='PRODUCTION_SNAPSHOT_RECEIPT_MISSING'):
        identity.snapshot_time(host, current)
    (tmp_path / 'spool').mkdir()
    (tmp_path / 'spool/snapshot-20261024T030000Z.json').write_text(json.dumps({'as_of': '2026-10-24T03:00:00Z'}))
    assert identity.snapshot_time(host, current) == '2026-10-24T03:00:00+00:00'


def test_config_shape_ignores_values_and_explicit_isolation_boundaries():
    production = {'product_resources': {'avatar_url': 'external', 'postgres': {'host': 'prod'}},
                  'archive_tiering': {'enabled': True}, 'payment': {'enabled': True, 'staging': False}}
    staging = {'product_resources': {'staging_effect_sink_file': '/sink', 'postgres': {'host': 'stage'}},
               'payment': {'enabled': False, 'staging': True}}
    assert identity.config_shape(production) == identity.config_shape(staging)
    staging['payment']['new_contract_field'] = 1
    assert identity.config_shape(production) != identity.config_shape(staging)


def test_unknown_required_fields_never_claim_equal(observed):
    state = identity.capture(observed[0])
    for field in identity.FIELDS:
        unknown = {**state, field: None}
        assert field in identity.compare(unknown, unknown)['differences']
    host, current = observed
    (current / '.release/snapshot.json').unlink()
    assert identity.snapshot_time(host, current) is None


def test_native_inventory_executes_with_isolated_profiles(tmp_path):
    source = Path(os.environ.get('HERMES_NATIVE_SOURCE') or os.environ.get('PAIOS_NATIVE_SOURCE_TEST_ROOT') or
                  Path(__file__).resolve().parents[2] / '.scratch/hermes-composed')
    if not source.is_dir():
        pytest.skip('local composed native source is not present')
    prod, stage = tmp_path / 'production', tmp_path / 'staging'
    for home in (prod, stage):
        (home / 'skills/example').mkdir(parents=True)
        (home / 'skills/example/SKILL.md').write_text('---\nname: example\ndescription: fixture\n---\nRead me.\n')
        (home / 'config.yaml').write_text('_config_version: 46\nmcp_servers:\n  custom: {}\n')
    for name in ('zeta', 'alpha'):
        package = prod / 'plugins' / name
        package.mkdir(parents=True)
        (package / 'plugin.yaml').write_text(f'name: {name}\nversion: 1.0.0\ndescription: fixture\n')
        (package / '__init__.py').write_text('raise RuntimeError("metadata probe executed plugin")\n')
        (package / 'skills/helper').mkdir(parents=True)
        (package / 'skills/helper/SKILL.md').write_text(f'---\nname: {name}-helper\n---\nHelper\n')
    shutil.copytree(prod / 'plugins', stage / '.paios-production-plugins')
    (stage / '.paios-production-registry.json').write_text(json.dumps({'mcp_servers': ['custom']}))
    (stage / 'config.yaml').write_text('_config_version: 46\nmcp_servers:\n  fake: {}\nplugins:\n  enabled: []\n')
    code = identity.NATIVE.replace("'/opt/hermes'", repr(str(source)))
    results = []
    for home, mode in ((prod, 'production'), (stage, 'staging')):
        environment = {**os.environ, 'HERMES_HOME': str(home), 'PYTHONPATH': str(source),
                       'PAIOS_STAGE': mode, 'HERMES_ENABLE_PROJECT_PLUGINS': 'false'}
        process = subprocess.run([sys.executable, '-c', code], env=environment, cwd=tmp_path,
                                 capture_output=True, text=True)
        assert process.returncode == 0, process.stderr
        results.append(json.loads(process.stdout))
    assert results[0] == results[1]
    assert results[0]['native_config_version'] == 46
    (stage / '.paios-production-plugins/alpha/skills/helper/SKILL.md').write_text('Changed installed skill')
    process = subprocess.run([sys.executable, '-c', code], env=environment, cwd=tmp_path,
                             capture_output=True, text=True)
    assert process.returncode == 0, process.stderr
    assert json.loads(process.stdout)['skill_catalog'] != results[0]['skill_catalog']
