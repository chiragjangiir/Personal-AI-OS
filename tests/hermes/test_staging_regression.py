"""The restore gate must fail closed and keep actionable per-check evidence."""
import json
import os
from pathlib import Path
import subprocess
import sys
import runpy
from types import SimpleNamespace

import pytest

STAGING = Path(__file__).parents[2] / 'deploy/cloud/staging'
sys.path.insert(0, str(STAGING))
import regression
import regression_turns


def test_dry_run_needs_no_files_environment_or_docker(tmp_path):
    result = subprocess.run([sys.executable, str(STAGING / 'regression.py'), '--dry-run',
                             '--settings', str(tmp_path / 'absent'), '--config', str(tmp_path / 'absent')],
                            env={**os.environ, 'PATH': ''}, capture_output=True, text=True)
    assert result.returncode == 0
    assert json.loads(result.stdout)['effects'] == ['payment', 'message', 'phone_task', 'ride', 'login', 'email']
    assert list(tmp_path.iterdir()) == []


def test_container_probe_requires_all_core_services():
    stack = SimpleNamespace(run=lambda *a, **k: SimpleNamespace(stdout='gateway-staging hermes-staging'))
    with pytest.raises(ValueError):
        regression.containers(stack, {})


def test_health_failure_writes_failed_receipt_and_does_not_run_turns(tmp_path, monkeypatch):
    receipt = tmp_path / 'snapshot-20261017T190500Z.json'
    receipt.write_text('{}')
    monkeypatch.setattr(regression, 'Stack', lambda *a, **k: SimpleNamespace(run=lambda *a, **k: None))
    monkeypatch.setattr(regression, 'isolation', lambda *a: {'stage': 'staging'})
    monkeypatch.setattr(regression, 'isolation_evidence', lambda *a: {'containers': 7})
    monkeypatch.setattr(regression_turns, 'bootstrap', lambda *a: {'pairing_file': '/stage-private/pair.json'})
    def health(stack, config, record):
        record('gateway.healthz', lambda: (_ for _ in ()).throw(subprocess.CalledProcessError(
            1, 'secret', stderr='Traceback (most recent call last):\nValueError: fixture token mismatch')))
        record('front.nginx', lambda: {'exit_code': 0})
    monkeypatch.setattr(regression, 'health', health)
    config = {'turns': {'chat': {}, 'call': {}}, 'effects': {}}
    previous = receipt.with_suffix('.regression')
    previous.mkdir()
    (previous / 'message.json').write_text('{"run_id":"old-success"}')
    assert regression.execute({}, config, receipt) == 1
    assert not (previous / 'message.json').exists()
    archived = list(tmp_path.glob(previous.name + '.previous-*'))
    assert len(archived) == 1
    assert json.loads((archived[0] / 'message.json').read_text())['run_id'] == 'old-success'
    result = json.loads(receipt.with_suffix('.regression.json').read_text())
    assert not result['passed']
    statuses = {row['name']: row['status'] for row in result['checks']}
    assert statuses['gateway.healthz'] == 'failed' and statuses['front.nginx'] == 'passed'
    assert all(statuses[name] == 'not_run' for name in regression.BUSINESS)
    assert 'secret' not in json.dumps(result)
    row = next(row for row in result['checks'] if row['name'] == 'gateway.healthz')
    assert row['reason'] == 'ValueError: fixture token mismatch'
    assert row['error_type'] == 'CalledProcessError' and row['evidence']['exit_code'] == 1


def test_failure_reason_keeps_last_line_caps_bytes_and_redacts_credentials():
    error = subprocess.CalledProcessError(1, ['never-copy-command'], stderr=(
        'never-copy-earlier-lines\nValueError: credential mismatch Authorization: Bearer abc123 '
        'api_key="key-value" password=secret-value https://user:pass@example.test/?token=private'))
    reason = regression.failure_reason(error)
    assert reason.startswith('ValueError: credential mismatch')
    assert all(secret not in reason for secret in ('abc123', 'key-value', 'secret-value', 'user:pass', 'private', 'never-copy'))
    assert len(regression.failure_reason(subprocess.CalledProcessError(1, 'secret', stderr='ValueError: ' + '错' * 2048)).encode()) <= 2048
    assert regression.failure_reason(ValueError('Fixture sink was truncated')) == 'Fixture sink was truncated'


def test_enabled_payment_fails_isolation(tmp_path, monkeypatch):
    monkeypatch.setattr(regression, 'preflight', lambda *a: None)
    cloud = tmp_path / 'cloud.json'
    cloud.write_text(json.dumps({'payment': {'enabled': True, 'staging': True}}))
    services = {name + '-staging': {'image': name, 'environment': {'PAIOS_STAGE': 'staging'}}
                for name in ('gateway', 'hermes')}
    stack = SimpleNamespace(settings={}, definition={'services': services}, config_mount=lambda: cloud)
    with pytest.raises(ValueError, match='Payment'):
        regression.isolation(stack, {'stores_verified': True, 'candidate_images':
                             {name: service['image'] for name, service in services.items()}})


@pytest.mark.parametrize('provider', ['agentbay', 'off'])
def test_fixture_hook_preserves_model_and_existing_fake_phone_environment(tmp_path, monkeypatch, provider):
    import yaml
    original = {'model': {'default': 'unchanged'}, 'providers': {'example': {'key_env': 'EXAMPLE_KEY'}},
                'mcp_servers': {'phone': {'command': '/opt/hermes/.venv/bin/python',
                    'args': ['/opt/paios/integrations/hermes/personal_aios/staging/fake_phone.py'],
                    'env': {'PAIOS_FAKE_PHONE_LOG': '/opt/data/fake-phone.jsonl'}}}}
    path = tmp_path / 'config.yaml'
    path.write_text(yaml.safe_dump(original))
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setenv('PAIOS_STAGE', 'production')
    with pytest.raises(SystemExit):
        runpy.run_path(str(STAGING / 'regression-init.py'))
    assert yaml.safe_load(path.read_text()) == original
    monkeypatch.setenv('PAIOS_STAGE', 'staging')
    monkeypatch.setenv('PAIOS_PHONE_PROVIDER', provider)
    if provider == 'off':
        original['mcp_servers'].pop('phone')
        path.write_text(yaml.safe_dump(original))
        with pytest.raises(SystemExit) as stopped:
            runpy.run_path(str(STAGING / 'regression-init.py'))
        assert stopped.value.code == 0
        assert yaml.safe_load(path.read_text()) == original
        return
    runpy.run_path(str(STAGING / 'regression-init.py'))
    actual = yaml.safe_load(path.read_text())
    assert actual['mcp_servers']['phone'].pop('args') == [
        '/stage-kit/regression_effects.py', '--fixture-config', '/stage-private/effects.json']
    original['mcp_servers']['phone'].pop('args')
    assert actual == original


def test_effect_observer_uses_native_key_without_a_device_bearer(tmp_path, monkeypatch):
    import regression_effects
    key, config = tmp_path / 'hermes.key', tmp_path / 'exam.json'
    key.write_text('fixture-native-key')
    profiles = {'owner': {'origin': 'http://127.0.0.1:18662', 'home': str(tmp_path), 'key_file': str(key)}}
    config.write_text(json.dumps({'profiles': profiles, 'timeout_s': 20, 'poll_s': 1}))
    monkeypatch.setenv('PAIOS_STAGE', 'staging')
    monkeypatch.setattr(regression_effects, 'native_pid', lambda: 42)
    checked = []
    monkeypatch.setattr(regression_effects, 'preflight', lambda exam: checked.append(exam['hermes_pid']))
    client, exam = regression_effects.client({'exam_config': str(config)})
    assert checked == [42]
    assert client.origin == profiles['owner']['origin'] and client.key == 'fixture-native-key'
    assert client.gateway_origin is None and client.device_key is None
    assert {path.name for path in tmp_path.iterdir()} == {'exam.json', 'hermes.key'}


@pytest.mark.parametrize('production_key', ['vidu.key', 'bark-key', 'bark-device'])
def test_isolation_evidence_is_captured_from_the_running_stack_for_this_run(tmp_path, monkeypatch, production_key):
    private, secrets = tmp_path / 'private', tmp_path / 'staging-secrets'
    private.mkdir()
    secrets.mkdir()
    (secrets / 'hermes-internal.key').write_text('k')
    (private / 'exam.json').write_text(json.dumps({'isolation_receipt': '/stage-private/isolation.json'}))
    (private / 'isolation.json').write_text(json.dumps({'expires_at': '2000-01-01T00:00:00+00:00', 'exam_id': 'x',
        'network_evidence': '/stage-private/network.txt', 'observer_evidence': '/stage-private/observer.txt'}))
    cloud = tmp_path / 'staging.json'
    cloud.write_text(json.dumps({'payment': {'enabled': False, 'staging': True},
                                 'product_resources': {'staging_effect_sink_file': '/sink.jsonl'}}))
    stack = SimpleNamespace(definition={'name': 'paios-n-stg', 'services': {'hermes-staging': {'volumes': [
        {'source': str(private), 'target': '/stage-private'}]}}}, config_mount=lambda: str(cloud))
    container = {'Config': {'Labels': {'com.docker.compose.service': 'gateway-staging'}, 'Env': ['PAIOS_STAGE=staging']},
                 'Image': 'sha256:' + 'a' * 64, 'HostConfig': {'NetworkMode': 'service:front-staging'},
                 'NetworkSettings': {'Ports': {}, 'Networks': {}},
                 'Mounts': [{'Source': str(secrets / 'hermes-internal.key'), 'Destination': '/run/secrets/hermes-internal.key'}]}
    def docker(command, **options):
        return SimpleNamespace(stdout='c1\n' if command[1] == 'ps' else json.dumps([container]))
    monkeypatch.setattr(subprocess, 'run', docker)
    monkeypatch.setattr(os, 'chown', lambda *a: None)
    config = {'effects': {'exam_config': '/stage-private/exam.json'}}
    evidence = regression.isolation_evidence(stack, config, {'candidate_images': {'gateway': container['Image']}})
    receipt = json.loads((private / 'isolation.json').read_text())
    assert receipt['expires_at'] == evidence['expires_at'] > '2026' and receipt['exam_id'] == 'x'
    assert 'gateway-staging image=sha256:' in (private / 'network.txt').read_text()
    (secrets / production_key).write_text('production only')
    with pytest.raises(ValueError, match='production-only'):
        regression.isolation_evidence(stack, config, {'candidate_images': {}})
