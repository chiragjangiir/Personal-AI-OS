"""The native lifecycle delegates package state to one platform authority."""
import importlib.util
import json
from pathlib import Path
import sys
import subprocess
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('package_lifecycle', ROOT / 'integrations/hermes/personal_aios/tool_lifecycle.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_package_lifecycle_uses_registry_candidates_and_no_native_skill_state():
    calls, candidate = [], 'a' * 64
    def request(action, body):
        calls.append((action, body))
        return {'success': True, 'candidate_id': candidate}
    lifecycle = module.ToolLifecycle(None, registry=request)
    staged = lifecycle.stage('sample', {'plugin.json': '{}'})
    assert staged['pending_id'] == candidate and not staged['promoted']
    lifecycle.test(candidate)
    lifecycle.promote(candidate)
    lifecycle.monitor('sample')
    lifecycle.status('sample')
    lifecycle.revert()
    assert [action for action, body in calls] == ['check', 'check', 'publish', 'monitor', 'status', 'rollback']
    assert calls[-1][1] == {'name': ''}
    with pytest.raises(ValueError, match='platform registry'):
        module.ToolLifecycle(None).stage('sample', {'plugin.json': '{}'})


def test_bound_workshop_build_publishes_and_rolls_back_via_same_registry(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / 'integrations/hermes'))
    from personal_aios import workshop, workshop_capability
    from hermes_cli import config
    from gateway import run_scope
    handlers, calls = {}, []
    candidate = 'b' * 64
    def request(action, body):
        calls.append((action, body))
        return {'success': True, 'candidate_id': candidate, 'files': {}}
    monkeypatch.setattr(workshop_capability, 'registry_client', lambda provider, kwargs: request)
    monkeypatch.setattr(config, 'load_config', lambda: {'personal_aios': {'builder_url': 'https://builder.invalid'}})
    monkeypatch.setattr(run_scope, 'current_scope', lambda: 'build')
    paths = []
    def build(path, *args):
        paths.append(path)
        return {'name': 'sample', 'files': {'plugin.json': '{}'}, 'run_id': 'builder'}
    monkeypatch.setattr(workshop, 'builder_request', build)
    workshop.register(SimpleNamespace(register_tool=lambda name, toolset, schema, fn: handlers.update({name: fn})),
                      object(), registry_factory=lambda kwargs: request)
    assert json.loads(handlers['capability_find']({'query': 'sample'}))['success']
    hub = handlers['skills_hub']
    assert json.loads(hub({'action': 'build', 'name': 'sample', 'value': 'Build sample'}))['pending_id'] == candidate
    assert json.loads(hub({'action': 'test', 'value': candidate}))['success']
    assert json.loads(hub({'action': 'promote', 'value': candidate}))['success']
    assert json.loads(hub({'action': 'revert', 'value': ''}))['success']
    assert [action for action, body in calls] == ['find', 'status', 'check', 'check', 'publish', 'rollback']
    assert paths == ['/capability-build']


def test_capability_export_requires_the_standard_package(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / 'integrations/hermes'))
    from personal_aios import workshop_builder
    monkeypatch.setattr(module, 'package_budget', lambda *args: {})
    (tmp_path / 'SKILL.md').write_text('---\nname: sample\nadapter_modules: []\n---\n')
    with pytest.raises(ValueError, match='standard capability package'):
        workshop_builder.export_tool('sample', tmp_path, capability=True)


def test_registration_bridge_gets_evidence_from_the_trusted_worker(tmp_path, monkeypatch):
    from contextlib import nullcontext
    monkeypatch.syspath_prepend(str(ROOT / 'integrations/hermes'))
    from personal_aios import workshop_sandbox
    from gateway import run_scope
    import tools.terminal_tool as terminal
    monkeypatch.setattr(run_scope, 'runtime_scope', lambda scope: nullcontext())
    template = ROOT / 'capability/templates/yimi-capability-template'
    files = {path.relative_to(template).as_posix(): path.read_text() for path in template.rglob('*') if path.is_file()}
    calls = []
    def execute(command, **kwargs):
        calls.append(command)
        assert command == 'python3 /opt/yimi/registration/runner.py --files'
        result = subprocess.run([sys.executable, str(ROOT /
            '01-product-half-finished/backend/services/personal-aios-integration/src/capability/registry/runner.py'), '--files'],
            input=kwargs['stdin_data'], capture_output=True, text=True, timeout=30)
        return {'returncode': result.returncode, 'output': result.stdout}
    monkeypatch.setattr(terminal, 'ensure_task_env', lambda task: SimpleNamespace(execute=execute))
    monkeypatch.setattr(terminal, '_evict_environment_for_task', lambda task: None)
    result = workshop_sandbox.check_capability(files)
    assert result['success'] and len(result['cases']) == 2
    assert all(not row['network'] and not row['writes'] for row in result['cases'])
    with pytest.raises(ValueError, match='portable'):
        workshop_sandbox.check_capability({**files, '../escape': 'not executed'})
    assert len(calls) == 1


def test_standard_package_editor_is_confined_to_the_build_draft(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / 'integrations/hermes'))
    from personal_aios.workshop_capability import draft_files
    from gateway import run_scope
    import hermes_constants
    monkeypatch.setattr(run_scope, 'current_scope', lambda: 'build')
    monkeypatch.setattr(hermes_constants, 'get_hermes_home', lambda: tmp_path / 'workshop')
    files = {'plugin.json': '{}', 'server/server.py': '# package code\n'}
    assert draft_files('fixture', files)['success']
    read = draft_files('fixture')['files']
    assert read['plugin.json'] == '{}' and 'SKILL.md' in read
    draft_files('fixture', {'server/server.py': '# updated\n'})
    assert draft_files('fixture')['files']['plugin.json'] == '{}'
    with pytest.raises(ValueError, match='Invalid draft'):
        draft_files('fixture', {'../outside': 'no'})
    assert not (tmp_path / 'outside').exists()
    monkeypatch.setattr(run_scope, 'current_scope', lambda: 'owner')
    with pytest.raises(ValueError, match='isolated build'):
        draft_files('fixture', files)
