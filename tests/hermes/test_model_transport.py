"""Authority generations replace legacy transport; native secrets stay out of tools."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest
import yaml

ROOT = Path(__file__).parents[2]
NATIVE = Path(os.environ['PAIOS_NATIVE_SOURCE_TEST_ROOT'])
spec = importlib.util.spec_from_file_location('model_transport', ROOT / 'integrations/hermes/personal_aios/model_transport.py')
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


@pytest.fixture
def projection(tmp_path):
    value = {'environment_id': 'test', 'profile': 'owner', 'revision': 7, 'group': 'brain',
             'configured': True, 'config': {'model': {'default': 'test-model', 'provider': 'test-provider'},
             'providers': {'test-provider': {'api': 'https://test.invalid/v1', 'transport': 'chat_completions', 'key_env': 'TEST_MODEL_KEY'}},
             'fallback_providers': [], 'delegation': {}, 'auxiliary': {}, 'cron': {}},
             'credentials': [{'name': 'TEST_MODEL_KEY', 'handle': 'opaque-test-7'}]}
    path = tmp_path / 'projection.json'
    path.write_text(json.dumps(value))
    return path


def test_generation_replaces_all_legacy_transport_and_keeps_product_policy(projection):
    config = transport.projected_config({'model': {'default': 'legacy'}, 'fallback_model': {'model': 'legacy'},
        'custom_providers': [{'name': 'legacy'}], 'delegation': {'api_key': 'legacy'},
        'auxiliary': {'vision': {'model': 'legacy'}}, 'terminal': {'backend': 'ssh'}}, projection)
    for key, value in transport.read_projection(projection)['config'].items():
        assert config[key] == value
    assert not {'fallback_model', 'custom_providers'} & config.keys()
    assert config['terminal'] == {'backend': 'ssh'}
    assert config['secrets']['environment'] == 'profile'


def test_unconfigured_projection_fails_closed(projection):
    value = json.loads(projection.read_text())
    value['configured'] = False
    projection.write_text(json.dumps(value))
    with pytest.raises(ValueError, match='模型与密钥'):
        transport.read_projection(projection)


def test_native_source_stays_private_through_reload_and_subprocesses(tmp_path, projection):
    config = transport.projected_config({}, projection)
    (tmp_path / 'config.yaml').write_text(yaml.safe_dump(config))
    code = '''
import os,subprocess,sys,json
from pathlib import Path
from agent.secret_sources.base import SecretSource,FetchResult
from agent.secret_sources.registry import register_source
class Fixture(SecretSource):
 name='personal_aios';shape='bulk'
 def fetch(self,cfg,home):return FetchResult(secrets={'TEST_MODEL_KEY':'fixture-private-sentinel'})
register_source(Fixture())
from hermes_cli.env_loader import load_hermes_dotenv, reset_secret_source_cache
from agent.secret_scope import get_secret
for i in range(2):
 load_hermes_dotenv()
 assert get_secret('TEST_MODEL_KEY')=='fixture-private-sentinel'
 assert 'TEST_MODEL_KEY' not in os.environ
 from agent.redact import redact_sensitive_text
 assert 'fixture-private-sentinel' not in redact_sensitive_text('failure fixture-private-sentinel',force=True)
 output=subprocess.check_output([sys.executable,'-c','import os;print(dict(os.environ))'],text=True)
 assert 'fixture-private-sentinel' not in output
 reset_secret_source_cache(Path(os.environ['HERMES_HOME']))
print('private native source, reload and subprocess: PASS')
'''
    env = {**os.environ, 'HERMES_HOME': str(tmp_path), 'PYTHONPATH': str(NATIVE)}
    result = subprocess.run([sys.executable, '-c', code], env=env, text=True, capture_output=True)
    assert result.returncode == 0, result.stdout + result.stderr


def test_build_scope_never_inherits_owner_credentials(tmp_path, projection):
    owner = transport.projected_config({}, projection)
    owner['terminal'] = {'backend': 'ssh', 'ssh_isolated': True, 'ssh_host': 'fixture.invalid'}
    (tmp_path / 'config.yaml').write_text(yaml.safe_dump(owner))
    child = tmp_path / 'workshop'
    child.mkdir()
    build = {**owner, 'secrets': {'environment': 'profile', 'personal_aios': {'enabled': True}}}
    (child / 'config.yaml').write_text(yaml.safe_dump(build))
    code = '''
import os
from agent.secret_sources.base import SecretSource,FetchResult
from agent.secret_sources.registry import register_source
class Fixture(SecretSource):
 name='personal_aios';shape='bulk'
 def fetch(self,cfg,home):return FetchResult(secrets={'TEST_MODEL_KEY':'build-secret' if home.name=='workshop' else 'owner-secret'})
register_source(Fixture())
from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv()
from agent.secret_scope import get_secret
from gateway.run_scope import runtime_scope
assert get_secret('TEST_MODEL_KEY')=='owner-secret'
with runtime_scope('build'):
 assert get_secret('TEST_MODEL_KEY')=='build-secret'
 assert 'TEST_MODEL_KEY' not in os.environ
assert get_secret('TEST_MODEL_KEY')=='owner-secret'
print('build profile credential isolation: PASS')
'''
    result = subprocess.run([sys.executable, '-c', code], text=True, capture_output=True,
        env={**os.environ, 'HERMES_HOME': str(tmp_path), 'PYTHONPATH': str(NATIVE)})
    assert result.returncode == 0, result.stdout + result.stderr


def test_failed_activation_keeps_old_native_generation(tmp_path, projection, monkeypatch):
    monkeypatch.syspath_prepend(str(NATIVE))
    from hermes_cli.env_loader import install_profile_secret_source_values, get_secret_source_values
    config = transport.projected_config({'terminal': {'backend': 'ssh'}}, projection)
    current = tmp_path / 'config.yaml'
    current.write_text(yaml.safe_dump(config))
    old = current.read_bytes()
    install_profile_secret_source_values(tmp_path, {'TEST_MODEL_KEY': 'old-private'})
    proposed = json.loads(projection.read_text())
    proposed['revision'] = 8
    proposed['config']['model']['default'] = 'new-model'
    monkeypatch.setattr(transport, 'credential', lambda *args: (_ for _ in ()).throw(ValueError('missing credential')))
    with pytest.raises(ValueError, match='missing credential'):
        transport.activate(tmp_path, [proposed])
    assert current.read_bytes() == old
    assert get_secret_source_values(tmp_path) == {'TEST_MODEL_KEY': 'old-private'}
    monkeypatch.setattr(transport, 'credential', lambda *args: 'new-private')
    assert transport.activate(tmp_path, [proposed]) == {'status': 'effective', 'revision': 8}
    assert yaml.safe_load(current.read_text())['model']['default'] == 'new-model'
    assert get_secret_source_values(tmp_path) == {'TEST_MODEL_KEY': 'new-private'}



def test_native_context_rejection_keeps_active_config_and_key_snapshot(tmp_path, projection, monkeypatch):
    from hermes_cli.env_loader import install_profile_secret_source_values, get_secret_source_values
    current = tmp_path / 'config.yaml'
    current.write_text(yaml.safe_dump(transport.projected_config({}, projection)))
    old = current.read_bytes()
    install_profile_secret_source_values(tmp_path, {'TEST_MODEL_KEY': 'old-private'})
    proposed = json.loads(projection.read_text())
    proposed['revision'] = 8
    proposed['config']['model']['context_length'] = 4096
    monkeypatch.setattr(transport, 'credential', lambda *args: pytest.fail('Invalid generation fetched a key'))
    with pytest.raises(ValueError, match='native Hermes minimum'):
        transport.activate(tmp_path, [proposed])
    assert current.read_bytes() == old
    assert get_secret_source_values(tmp_path) == {'TEST_MODEL_KEY': 'old-private'}
    projection.write_text(json.dumps(proposed))
    with pytest.raises(ValueError, match='native Hermes minimum'):
        transport.projected_config({}, projection)

def test_native_read_file_uses_terminal_namespace_for_host_secret_path(tmp_path, monkeypatch):
    """The real file tool must use its SSH file backend, including an absolute host path."""
    monkeypatch.syspath_prepend(str(NATIVE))
    from types import SimpleNamespace
    from tools import file_tools
    from tools.file_operations_common import ReadResult
    sentinel = tmp_path / 'innocent.txt'
    sentinel.write_text('host-model-secret-sentinel')
    seen = []
    class RemoteFiles:
        env = SimpleNamespace(__class__=SimpleNamespace(__name__='SSHEnvironment'))
        def read_file(self, path, offset, limit):
            seen.append(path)
            return ReadResult(error='File not found: ' + path)
    remote = RemoteFiles()
    monkeypatch.setattr(file_tools, '_get_file_ops', lambda task: remote)
    monkeypatch.setattr(file_tools, '_file_ops_uses_host_paths', lambda ops: False)
    output = file_tools.read_file_tool(str(sentinel), task_id='model-isolation-read')
    assert seen == [str(sentinel)]
    assert 'File not found' in output and 'host-model-secret-sentinel' not in output


def test_native_isolated_terminal_never_forwards_credentials(monkeypatch):
    monkeypatch.syspath_prepend(str(NATIVE))
    from tools.environments import ssh
    environment = object.__new__(ssh.SSHEnvironment)
    environment.isolated = True
    environment._forward_credentials = False
    environment._remote_home = '/workshop'
    environment._sync_workshop_skills = True
    seen = {}
    def command(extra_args=None, send_env=()):
        assert not send_env
        return ['ssh', 'fixture']
    environment._build_ssh_command = command
    environment._scope_command = lambda value: value
    monkeypatch.setattr(ssh, '_popen_bash', lambda argv, stdin, **kwargs: seen.update(argv=argv, **kwargs))
    monkeypatch.setattr(ssh, 'resolve_passthrough_env', lambda **kwargs: pytest.fail('isolated SSH requested host credentials'))
    environment._run_bash('env; python3 -c "import os; print(dict(os.environ))"')
    assert '/usr/bin/env -i' in seen['argv'][-1]
    assert 'TEST_MODEL_KEY' not in json.dumps(seen)


def test_tool_namespace_has_no_authority_or_vault_mounts():
    definition = yaml.safe_load((ROOT / 'deploy/cloud/compose.yaml').read_text())
    for name in ('workshop', 'workshop-staging'):
        service = definition['services'][name]
        assert not any('model-settings' in mount or '/run/secrets' in mount or 'owner-data' in mount
                       for mount in service['volumes'])
    builder = yaml.safe_load((ROOT / 'deploy/cloud/compose.workshop-build.yaml').read_text())
    assert not any('/run/secrets' in mount or 'model-settings' in mount
                   for mount in builder['services']['workshop']['volumes'])


def test_native_same_provider_role_parameters_reach_agent_atomically(tmp_path):
    config = {'model': {'default': 'same-model', 'provider': 'same-provider', 'base_url': 'https://model.invalid/v1',
        'context_length': 128000, 'request_overrides': {'max_tokens': 32, 'temperature': .2,
        'extra_body': {'thinking': {'type': 'disabled'}}}},
        'providers': {'same-provider': {'api': 'https://model.invalid/v1', 'transport': 'chat_completions',
            'key_env': 'TEST_NATIVE_ROUTE_KEY', 'context_length': 262144, 'extra_body': {'max_tokens': 128}}},
        'fallback_providers': [], 'agent': {'api_max_retries': 0}, 'plugins': {'enabled': []},
        'platform_toolsets': {'api_server': []}, 'memory': {'memory_enabled': False, 'user_profile_enabled': False},
        'compression': {'enabled': False}, 'auxiliary': {'title_generation': {'enabled': False}},
        'delegation': {'provider': 'same-provider', 'model': 'same-model', 'base_url': 'https://model.invalid/v1',
            'key_env': 'TEST_NATIVE_ROUTE_KEY',
            'context_length': 64000, 'request_overrides': {'max_tokens': 16, 'temperature': .7,
            'extra_body': {'thinking': {'type': 'enabled'}}}, 'fallback_providers': []}}
    config['secrets'] = {'environment': 'profile', 'personal_aios': {'enabled': True}}
    config['model_settings'] = {'revision': 1, 'profile': 'owner', 'group': 'brain', 'environment_id': 'test'}
    config['cron'] = {**config['delegation'], 'model_provider': 'same-provider'}
    (tmp_path / 'config.yaml').write_text(yaml.safe_dump(config))
    code = '''
import os
from pathlib import Path
from agent.secret_sources.base import SecretSource,FetchResult
from agent.secret_sources.registry import register_source
class Fixture(SecretSource):
 name='personal_aios';shape='bulk'
 def fetch(self,cfg,home):return FetchResult(secrets={'TEST_NATIVE_ROUTE_KEY':'fixture-native-role-key-0123456789'})
register_source(Fixture())
from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv()
from hermes_cli.config import load_config
from gateway.run import _resolve_runtime_agent_kwargs
from tools.delegate_tool_config import _resolve_delegation_credentials
from run_agent import AIAgent
config=load_config()
kwargs=_resolve_runtime_agent_kwargs();kwargs.pop('model',None)
a=AIAgent(model='same-model',**kwargs,enabled_toolsets=[],skip_context_files=True,skip_memory=True,
 skip_background_review=True,quiet_mode=True,load_soul_identity=False)
try:
 assert a.max_tokens==32,(a.max_tokens,a.request_overrides)
 assert a._config_context_length==128000,a._config_context_length
 assert a.request_overrides['temperature']==.2
 assert a.request_overrides['extra_body']['thinking']=={'type':'disabled'}
 from cron.scheduler import _load_cron_job_config,_job_fallback_chain
 cron=_load_cron_job_config({'model':'legacy-job-model','provider':'legacy-provider'},'test','test')
 assert cron.model=='same-model'
 assert _job_fallback_chain({'model':'legacy-job-model'},config) is None
 child=_resolve_delegation_credentials(config['delegation'],a)
 b=AIAgent(model='same-model',provider=child['provider'],base_url=child['base_url'],api_key=child['api_key'],
  api_mode=child['api_mode'],request_overrides=child['request_overrides'],context_length=config['delegation']['context_length'],
  enabled_toolsets=[],skip_context_files=True,skip_memory=True,skip_background_review=True,quiet_mode=True,load_soul_identity=False)
 try:
  assert b.max_tokens==16,b.max_tokens
  assert b._config_context_length==64000,b._config_context_length
  assert b.request_overrides['temperature']==.7
  assert b.request_overrides['extra_body']['thinking']=={'type':'enabled'}
  assert a.max_tokens==32 and a._config_context_length==128000
 finally:b.close()
finally:a.close()
print('same provider/model roles: output/context/temperature/thinking are independent and atomic: PASS')
'''
    result = subprocess.run([sys.executable, '-c', code], env={**os.environ, 'HERMES_HOME': str(tmp_path),
        'PYTHONPATH': str(NATIVE)}, text=True, capture_output=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr


def test_native_delegate_children_take_the_projected_role_limit_at_every_depth(tmp_path):
    projected = {'model': {'default': 'brain-model', 'provider': 'route-provider', 'base_url': 'https://model.invalid/v1',
        'key_env': 'TEST_NATIVE_ROUTE_KEY', 'context_length': 128000, 'request_overrides': {'max_tokens': 32}},
        'providers': {'route-provider': {'api': 'https://model.invalid/v1', 'transport': 'chat_completions',
            'key_env': 'TEST_NATIVE_ROUTE_KEY'}}, 'fallback_providers': [],
        'delegation': {'enabled': True, 'provider': 'route-provider', 'model': 'child-model', 'base_url': 'https://model.invalid/v1',
            'key_env': 'TEST_NATIVE_ROUTE_KEY', 'api_mode': 'chat_completions', 'context_length': 64000,
            'request_overrides': {'max_tokens': 16}, 'fallback_providers': [], 'max_concurrent_children': 3,
            'max_spawn_depth': 2, 'oneshot_max_children': 0, 'child_timeout_seconds': 0}}
    config = transport.projected_config({'agent': {'api_max_retries': 0}, 'plugins': {'enabled': []},
        'platform_toolsets': {'api_server': []}, 'memory': {'memory_enabled': False, 'user_profile_enabled': False},
        'compression': {'enabled': False}}, _write_projection(tmp_path, projected))
    (tmp_path / 'config.yaml').write_text(yaml.safe_dump(config))
    code = """
from agent.secret_sources.base import SecretSource,FetchResult
from agent.secret_sources.registry import register_source
class Fixture(SecretSource):
 name='personal_aios';shape='bulk'
 def fetch(self,cfg,home):return FetchResult(secrets={'TEST_NATIVE_ROUTE_KEY':'fixture-native-role-key-0123456789'})
register_source(Fixture())
from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv()
from hermes_cli.config import load_config
from gateway.run import _resolve_runtime_agent_kwargs
from tools.delegate_tool import _build_children,_routes_for
from run_agent import AIAgent
config=load_config()
kwargs=_resolve_runtime_agent_kwargs();kwargs.pop('model',None)
parent=AIAgent(model='brain-model',**kwargs,enabled_toolsets=[],skip_context_files=True,skip_memory=True,
 skip_background_review=True,quiet_mode=True,load_soul_identity=False)
agents=[parent]
try:
 assert parent.max_tokens==32,parent.max_tokens
 for depth in (1,2):
  tasks=[{'goal':'synthetic task'}]
  routes,error=_routes_for(tasks,config['delegation'],None,agents[-1])
  assert error is None,error
  children,error=_build_children(tasks,[None],routes,top_role='leaf',max_iterations=8,
   parent_agent=agents[-1],live_deleg_id=None,live_writers=[])
  assert error is None,error
  child=children[0][-1];agents.append(child)
  assert child._delegate_depth==depth,child._delegate_depth
  assert (child.model,child.max_tokens,child._config_context_length)==('child-model',16,64000),(child.model,child.max_tokens,child._config_context_length)
 assert parent.max_tokens==32
finally:
 for agent in reversed(agents):agent.close()
print('PASS')
"""
    result = subprocess.run([sys.executable, '-c', code], env={**os.environ, 'HERMES_HOME': str(tmp_path),
        'PYTHONPATH': str(NATIVE)}, text=True, capture_output=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr


def _write_projection(tmp_path, config):
    path = tmp_path / 'projection.json'
    path.write_text(json.dumps({'environment_id': 'test', 'profile': 'owner', 'revision': 1, 'group': 'brain',
        'configured': True, 'config': config, 'credentials': [{'name': 'TEST_NATIVE_ROUTE_KEY', 'handle': 'opaque-route-1'}]}))
    return path


def test_managed_auxiliary_rejects_unknown_task_and_keeps_declared_role(monkeypatch):
    from agent import auxiliary_client
    from hermes_cli import config
    monkeypatch.setattr(config, 'load_config_readonly', lambda: {
        'model_settings': {'revision': 2}, 'auxiliary': {
            'call_intent': {'enabled': True, 'role_id': 'call.intent'}}})
    assert auxiliary_client._get_auxiliary_task_config('call_intent')['role_id'] == 'call.intent'
    with pytest.raises(auxiliary_client.AuxiliaryClientUnavailable, match='not configured'):
        auxiliary_client._get_auxiliary_task_config('unknown_paid_task')
    with pytest.raises(auxiliary_client.AuxiliaryClientUnavailable, match='require a configured task'):
        auxiliary_client._resolve_task_provider_model()


def test_inert_control_profile_installs_hooks_without_keys_then_only_brain_activates(tmp_path, projection):
    inert = {'environment_id': 'test', 'profile': 'owner', 'revision': 0, 'group': 'brain',
        'configured': False, 'config': {'model': {'enabled': False}, 'providers': {},
        'fallback_providers': [], 'delegation': {'enabled': False}, 'cron': {'enabled': False},
        'auxiliary': {'compression': {'enabled': False}}}, 'credentials': []}
    inactive = tmp_path / 'inert.json'
    inactive.write_text(json.dumps(inert))
    active = json.loads(projection.read_text())
    active['config']['model'].update(base_url='https://test.invalid/v1', key_env='TEST_MODEL_KEY',
        context_length=128000, request_overrides={'max_tokens': 16})
    projection.write_text(json.dumps(active))
    code = '''
import json, os
from pathlib import Path
import yaml
import model_transport as transport
home = Path(os.environ['HERMES_HOME'])
initial = Path(os.environ['PAIOS_MODEL_SETTINGS_PROJECTION'])
(home / 'config.yaml').write_text(yaml.safe_dump(transport.projected_config({}, initial)))
build = home / 'workshop'; build.mkdir()
value = json.loads(initial.read_text()); value.update(profile='workshop', group='build')
build_projection = home / 'build-inert.json'; build_projection.write_text(json.dumps(value))
(build / 'config.yaml').write_text(yaml.safe_dump(transport.projected_config({}, build_projection)))
os.environ['OPENAI_API_KEY'] = 'inherited-provider-key'
os.environ['PAIOS_MODEL_KEY_OLD'] = 'inherited-authority-key'
(home / '.env').write_text('PAIOS_MODEL_KEY_FILE_OLD=inherited-file-key\\n')
transport.credential = lambda *args: (_ for _ in ()).throw(AssertionError('Inert startup fetched a credential'))
transport.initialize_credentials(home)
assert 'OPENAI_API_KEY' not in os.environ and 'PAIOS_MODEL_KEY_OLD' not in os.environ
assert 'inherited-file-key' not in (home / '.env').read_text()
from agent import model_usage
from agent.process_bootstrap import _model_usage_observer
assert model_usage.new_task_admission is not None and _model_usage_observer is not None
from run_agent import AIAgent
try:
 AIAgent(model='forged', provider='custom', base_url='https://test.invalid/v1', api_key='forged')
 raise AssertionError('Inert main accepted an agent')
except ValueError as error:
 assert 'MODEL_SETTINGS_NOT_CONFIGURED' in str(error)
active = json.loads(Path(os.environ['FIXTURE_ACTIVE_PROJECTION']).read_text())
import asyncio, socket
from aiohttp import ClientSession
from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter
class ControlAPI(APIServerAdapter):
 async def activate_model_settings(self, request):
  return await transport.activation_request(self, request)
 def _http_route_table(self):
  return super()._http_route_table() + [('POST', '/api/model-settings/activate', self.activate_model_settings)]
async def activate_over_native_http():
 with socket.socket() as reservation:
  reservation.bind(('127.0.0.1', 0)); port = reservation.getsockname()[1]
 service_token = 'fixture-private-inference-service-token'
 service_file = home / 'service.key'; service_file.write_text(service_token)
 os.environ['PAIOS_MODEL_SETTINGS_TOKEN_FILE'] = str(service_file)
 adapter = ControlAPI(PlatformConfig(enabled=True, extra={
  'host': '127.0.0.1', 'port': port, 'key': 'fixture-native-control-api-token'}))
 assert await adapter.connect(), 'Inert native control API failed to connect'
 try:
  async with ClientSession() as client:
   async with client.get(f'http://127.0.0.1:{port}/health') as response:
    assert response.status == 200
   transport.credential = lambda *args: 'active-private-model-key'
   async with client.post(f'http://127.0.0.1:{port}/api/model-settings/activate',
    headers={'Authorization': 'Bearer ' + service_token},
    json={'revision': active['revision'], 'projections': [active]}) as response:
    assert response.status == 200, await response.text()
    assert await response.json() == {'status': 'effective', 'revision': active['revision']}
 finally:
  await adapter.disconnect()
asyncio.run(activate_over_native_http())
from gateway.run import _resolve_runtime_agent_kwargs
runtime = _resolve_runtime_agent_kwargs(); model = runtime.pop('model', active['config']['model']['default'])
runtime.pop('_fallback_notice', None)
agent = AIAgent(model=model, **runtime, enabled_toolsets=[], skip_memory=True,
 skip_background_review=True, skip_context_files=True, quiet_mode=True)
assert agent.model == 'test-model' and agent.max_tokens == 16
agent.close()
from gateway.run_scope import runtime_scope
with runtime_scope('build'):
 try:
  AIAgent(model='forged', provider='custom', base_url='https://test.invalid/v1', api_key='forged')
  raise AssertionError('Brain activation enabled the build agent')
 except ValueError as error:
  assert 'MODEL_SETTINGS_NOT_CONFIGURED' in str(error)
print('inert startup -> brain active / build inert: PASS')
'''
    result = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True,
        env={**os.environ, 'HERMES_HOME': str(tmp_path), 'PAIOS_MODEL_SETTINGS_PROJECTION': str(inactive),
             'FIXTURE_ACTIVE_PROJECTION': str(projection),
             'PYTHONPATH': os.pathsep.join((str(NATIVE), str(ROOT / 'integrations/hermes/personal_aios')))})
    assert result.returncode == 0, result.stdout + result.stderr
