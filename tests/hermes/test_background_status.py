"""Current work comes from owner admissions, independently of chat history or cron completion."""
import importlib.util
import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace

import pytest

SOURCE = Path(__file__).parents[2] / 'integrations/hermes/personal_aios/self_tools.py'
spec = importlib.util.spec_from_file_location('background_plugin.self_tools', SOURCE)
self_tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(self_tools)


@pytest.fixture
def harness(monkeypatch):
    state = SimpleNamespace(scope='owner', allowed=True, calls=[], tools={}, jobs=[])
    def module(name, **values):
        value = ModuleType(name)
        value.__dict__.update(values)
        monkeypatch.setitem(sys.modules, name, value)
    module('gateway', __path__=[])
    module('gateway.run_scope', current_scope=lambda: state.scope)
    module('gateway.session_context', get_api_run_id=lambda session: 'probe-run')
    module('tools', __path__=[])
    module('tools.approval_context', _approval_tool_call_id=SimpleNamespace(get=lambda: 'call'))
    module('cron', __path__=[])
    module('cron.jobs', list_jobs=lambda **kwargs: state.jobs)
    # job_owner is the production destination decoder, not a second ownership map.
    owner_spec = importlib.util.spec_from_file_location('background_cron', SOURCE.with_name('cron.py'))
    cron = importlib.util.module_from_spec(owner_spec)
    owner_spec.loader.exec_module(cron)
    module('background_plugin', __path__=[])
    monkeypatch.setitem(sys.modules, 'background_plugin.cron', cron)
    state.target = cron.target
    def request(path, body):
        state.calls.append((path, body))
        if path.endswith('schedule-context'):
            return {'principal_id': 'owner', 'allow_owner_mutation': state.allowed}
        if state.failure:
            raise RuntimeError('admission unavailable')
        return {'tasks': [{'run_id': 'original-run', 'session_id': 'other-continuity', 'state': 'running', 'request': {'text': 'still working'}}], 'pending_amendments': []}
    state.failure = False
    def register_tool(name, toolset, schema, handler):
        state.tools[name] = handler
        return name
    self_tools.register(SimpleNamespace(register_hook=lambda *args: None, register_tool=register_tool), SimpleNamespace(_request=request))
    return state


def test_new_continuity_observes_running_run_even_when_cron_completed(harness):
    harness.jobs = [{'id': 'trigger', 'name': 'dispatch', 'state': 'completed', 'enabled': False,
                     'deliver': harness.target({'principal_id': 'owner'})},
                    {'id': 'private', 'name': 'other', 'state': 'scheduled',
                     'deliver': harness.target({'principal_id': 'other'})}]
    result = json.loads(harness.tools['paios_background_status']({}, session_id='new-continuity'))
    assert result['active_runs'][0]['run_id'] == 'original-run'
    assert result['active_runs'][0]['state'] == 'running'
    assert [job['id'] for job in result['scheduled_jobs']] == ['trigger']
    assert harness.calls[-1][1] == {'context': {'run_id': 'probe-run', 'session_id': 'new-continuity', 'tool_call_id': 'call'}, 'args': {'action': 'list'}}


@pytest.mark.parametrize('scope,allowed', [('guest', True), ('owner_uncertain', True), ('care', True), ('build', True), ('owner', False)])
def test_status_requires_current_owner_request(harness, scope, allowed):
    harness.scope, harness.allowed = scope, allowed
    with pytest.raises(ValueError):
        harness.tools['paios_background_status']({}, session_id='new-continuity')
    assert not any(path.endswith('paios_task_amend') for path, _ in harness.calls)


def test_unavailable_current_work_never_returns_success_zero(harness):
    harness.failure = True
    with pytest.raises(RuntimeError, match='admission unavailable'):
        harness.tools['paios_background_status']({}, session_id='new-continuity')


@pytest.mark.parametrize('missing', ['run_id', 'session_id', 'tool_call_id'])
def test_status_never_queries_without_native_binding(harness, monkeypatch, missing):
    if missing == 'run_id':
        monkeypatch.setattr(sys.modules['gateway.session_context'], 'get_api_run_id', lambda session: '')
    elif missing == 'tool_call_id':
        monkeypatch.setattr(sys.modules['tools.approval_context'], '_approval_tool_call_id', SimpleNamespace(get=lambda: ''))
    with pytest.raises(ValueError, match='SELF_RUN_BINDING_REQUIRED'):
        harness.tools['paios_background_status']({}, session_id='' if missing == 'session_id' else 'new-continuity')
    assert harness.calls == []


def test_cron_failure_does_not_turn_running_work_into_success_zero(harness, monkeypatch):
    def unavailable(**kwargs):
        raise RuntimeError('cron unavailable')
    monkeypatch.setattr(sys.modules['cron.jobs'], 'list_jobs', unavailable)
    with pytest.raises(RuntimeError, match='cron unavailable'):
        harness.tools['paios_background_status']({}, session_id='new-continuity')


@pytest.mark.parametrize('scope,allowed', [('owner', True), ('guest', False), ('owner_uncertain', False), ('care', False), ('build', False)])
def test_native_foreground_surface_and_dispatch_match_scope(monkeypatch, scope, allowed):
    from gateway import run_scope
    monkeypatch.setattr(run_scope, '_bind_delegated_toolsets', lambda agent: None)
    name = 'paios_background_status'
    agent = SimpleNamespace(_paios_delegate_toolsets=['memory'], _delegate_depth=0,
                            tools=[{'function': {'name': name}}, {'function': {'name': 'terminal'}}])
    run_scope.restrict_agent(agent, scope)
    assert (name in agent.valid_tool_names) is allowed
    assert (run_scope.tool_block(agent, name) is None) is allowed
    assert 'terminal' not in agent.valid_tool_names
