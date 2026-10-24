"""Run the native Hermes tool loop against a fake model and execute its fixture tool."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

import pytest

ROOT = Path(__file__).parents[2]


@pytest.mark.parametrize('fixture_bytes', [0, 196608])
def test_fake_model_build_register_use_repair_revert(tmp_path, fixture_bytes):
    native = Path(os.environ['PAIOS_NATIVE_SOURCE_TEST_ROOT'])
    script = r'''
import importlib.util, json, os, subprocess, sys, threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
root, home = Path(sys.argv[1]), Path(sys.argv[2])
fixture_bytes = int(sys.argv[3])
sys.path.insert(0,str(root/'integrations/hermes/personal_aios'))
def module(name, path):
 spec=importlib.util.spec_from_file_location(name,path)
 value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
builder=module('workshop_builder',root/'integrations/hermes/personal_aios/workshop_builder.py')
lifecycle=module('tool_lifecycle',root/'integrations/hermes/personal_aios/tool_lifecycle.py')
init=module('builder_init',root/'deploy/cloud/workshop-builder-init.py')
state={'phase':0,'calls':0,'headers':[],'tools':[],'value':'original'}
class Model(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  assert body['model']=='fixture-model',body['model']
  state['instructions']='\n'.join(str(m.get('content','')) for m in body['messages'] if m.get('role')=='system')
  for msg in body['messages']:
   if msg.get('role')=='tool': print('fixture tool result:',msg.get('content'),flush=True)
  state['headers'].append(self.headers.get('x-opencode-session'))
  phase=state['phase'];state['phase']+=1;state['calls']+=1
  doc='---\nname: fixture-tool\ndescription: Run the fixture converter and its regression checks.\nadapter_modules: []\n---\nRun scripts/run.py; verify with scripts/test.py.\n'
  if fixture_bytes:
   doc=doc.replace('adapter_modules: []', 'adapter_modules: []\nbudget_reason: The offline converter needs its complete reference fixture.')
  value=state['value']
  code=f'print({value!r})\n'
  test='import subprocess,sys\nresult=subprocess.run([sys.executable,"scripts/run.py"],capture_output=True,text=True)\nassert result.returncode==0\nassert result.stdout=='+repr(value+'\n')+'\n'
  if phase==0: name,args='skills_hub',{'action':'search','value':'fixture converter'}
  elif phase==1:
   first={'action':'create','name':'fixture-tool','category':'workshop','content':doc} if value=='original' else {'action':'patch','name':'fixture-tool','content':doc}
   name,args='skill_manage',{'action':'create','name':'fixture-tool','operations':[first,{'action':'write_file','name':'fixture-tool','file_path':'scripts/run.py','file_content':code},{'action':'write_file','name':'fixture-tool','file_path':'scripts/test.py','file_content':test}]}
   if fixture_bytes:
    args['operations'].append({'action':'write_file','name':'fixture-tool','file_path':'references/fixture.txt','file_content':'x'*fixture_bytes})
  elif phase==2:
   name,args='terminal',{'command':'python scripts/test.py'}
  else:
   message={'role':'assistant','content':'Fixture found, built and tested.'}
   name=None
  if name:
   state['tools'].append(name)
   message={'role':'assistant','content':None,'tool_calls':[{'id':'call_'+str(phase),'type':'function','function':{'name':name,'arguments':json.dumps(args)}}]}
  response={'id':'fake','object':'chat.completion','created':1,'model':body['model'],'choices':[{'index':0,'message':message,'finish_reason':'tool_calls' if name else 'stop'}],'usage':{'prompt_tokens':200,'completion_tokens':30,'total_tokens':230}}
  if body.get('stream'):
   delta=dict(message)
   if name:delta['tool_calls']=[{**message['tool_calls'][0],'index':0}]
   chunk={'id':'fake','object':'chat.completion.chunk','created':1,'model':body['model'],'choices':[{'index':0,'delta':delta,'finish_reason':None}]}
   end={**chunk,'choices':[{'index':0,'delta':{},'finish_reason':'tool_calls' if name else 'stop'}]}
   data=('data: '+json.dumps(chunk)+'\n\ndata: '+json.dumps(end)+'\n\ndata: [DONE]\n\n').encode()
  else:data=json.dumps(response).encode()
  self.send_response(200);self.send_header('Content-Type','text/event-stream' if body.get('stream') else 'application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
server=ThreadingHTTPServer(('127.0.0.1',0),Model)
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
os.environ.update(HERMES_HOME=str(home),PAIOS_BUILDER_API_KEY='synthetic-not-a-secret',PAIOS_BUILDER_BASE_URL=f'http://127.0.0.1:{server.server_port}/v1',PAIOS_BUILDER_MODEL='fixture-model',HOME=str(home))
config=init.prepare_builder_home(home, home/'access')
import yaml
config['workshop']={'repair_model':'repair-only-fixture'}
config['compression']={'enabled':False}
for profile in (home,home/'workshop'):
 (profile/'config.yaml').write_text(yaml.safe_dump(config))
from hermes_cli import skills_hub
skills_hub.do_search=lambda query,console:console.print('Fixture discovery: no reusable tool')
# Replace only the external SSH boundary. Execute real fixture code in a private local directory.
import tools.terminal_tool as terminal
from tools.registry import registry
def execute(args,**kwargs):
 tool=home/'workshop/skills/workshop/fixture-tool'
 result=subprocess.run([sys.executable,'scripts/test.py'],cwd=tool,capture_output=True,text=True,timeout=10)
 return json.dumps({'exit_code':result.returncode,'output':result.stdout+result.stderr})
registry.register(name='terminal',toolset='terminal',schema=terminal.TERMINAL_SCHEMA,handler=execute,override=True)
try:
 candidate=builder.build_tool({'name':'fixture-tool','input':'Build a reusable fixture converter with synthetic data.'})
 assert candidate['budget']['status']=='ready'
 assert bool(candidate['budget']['overruns'])==bool(fixture_bytes)
 assert state['tools']==['skills_hub','skill_manage','terminal'],state
 assert 'adapter_modules' in state['instructions'] and '200 physical lines' in state['instructions']
 assert 'JSON／HTML／纯文本' in state['instructions']
 assert state['calls']==4 and len(set(state['headers']))==1 and state['headers'][0]
 from hermes_constants import set_hermes_home_override,reset_hermes_home_override
 token=set_hermes_home_override(home/'production')
 def verify(path):
  result=subprocess.run([sys.executable,'scripts/test.py'],cwd=path,capture_output=True,text=True,timeout=10)
  return {'success':result.returncode==0,'output':result.stdout+result.stderr}
 try:
  release=lifecycle.ToolLifecycle(verify)
  pending=release.stage(candidate['name'],candidate['files'])['pending_id']
  assert release.test(pending)['success'];assert release.promote(pending)['success']
  path=Path(release.status('fixture-tool')['path'])
  assert subprocess.check_output([sys.executable,path/'scripts/run.py'],text=True)=='original\n'
  # A real dependency-style outage is observable by the monitor; the tool itself stays unchanged.
  run=path/'scripts/run.py';saved=run.read_text();run.write_text('raise RuntimeError("outage")\n')
  assert release.monitor('fixture-tool')['verification']['success'] is False
  run.write_text(saved)
 finally:reset_hermes_home_override(token)
 state.update(phase=0,value='repaired',tools=[])
 # A fresh builder recovers reusable source from the production skill, without owner context.
 import shutil
 shutil.rmtree(home/'workshop/skills/workshop/fixture-tool')
 repaired=builder.build_tool({'name':'fixture-tool','input':'Repair the fixture converter with synthetic data.','files':candidate['files']})
 assert len(set(state['headers']))==2
 token=set_hermes_home_override(home/'production')
 try:
  pending=release.stage(repaired['name'],repaired['files'])['pending_id']
  assert release.test(pending)['success'];assert release.promote(pending)['success']
  assert subprocess.check_output([sys.executable,path/'scripts/run.py'],text=True)=='repaired\n'
  assert release.revert('fixture-tool')['success']
  assert subprocess.check_output([sys.executable,path/'scripts/run.py'],text=True)=='original\n'
 finally:reset_hermes_home_override(token)
 # Exercise the plugin bridge across build, production and scratch-test profile contexts.
 sys.path.insert(0,str(root/'integrations/hermes'))
 from personal_aios import workshop
 config['personal_aios']={'builder_url':'https://fixture.invalid','builder_token_file':'unused'}
 (home/'workshop/config.yaml').write_text(yaml.safe_dump(config))
 def remote(path,body,config=None):
  assert config['builder_url']=='https://fixture.invalid'
  if path=='/build':
   assert set(body)=={'input','name','files'} and body['files']=={}
   return candidate
  import tempfile
  with tempfile.TemporaryDirectory() as directory:
   folder=Path(directory)
   for name,content in body.items():
    path=folder/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(content)
   return verify(folder)
 workshop.builder_request=remote
 handlers={}
 workshop.register(SimpleNamespace(register_tool=lambda name,toolset,schema,fn:handlers.update({name:fn})))
 from gateway.run_scope import runtime_scope
 with runtime_scope('build'):
  hub=handlers['skills_hub']
  pending=json.loads(hub({'action':'build','name':'fixture-tool','value':'Build a fixture converter.'}))['pending_id']
  assert json.loads(hub({'action':'test','value':pending}))['success']
  assert json.loads(hub({'action':'promote','value':pending}))['success']
  assert json.loads(hub({'action':'monitor','value':'fixture-tool'}))['verification']['success']
  assert json.loads(hub({'action':'revert','value':''}))['success']
 # Execute the actual sandbox-verifier command at a local SSH seam, including failure propagation.
 def sandbox(command,stdin_data,**kwargs):
  assert len(command)<4096
  command=command.replace('dir="/workshop"','dir='+json.dumps(str(home)))
  result=subprocess.run(command,input=stdin_data,shell=True,capture_output=True,text=True,timeout=10)
  return {'returncode':result.returncode,'output':result.stdout+result.stderr}
 terminal.ensure_task_env=lambda task:SimpleNamespace(execute=sandbox)
 checked=builder.test_tool({**candidate['files'],'assets/payload.txt':'x'*131072})
 assert checked['success'],checked
 assert not builder.test_tool({**candidate['files'],'scripts/test.py':'assert False, "broken"\n'})['success']
 print('find-build-test-register-use-break-repair-revert passed')
finally:server.shutdown();server.server_close()
'''
    result = subprocess.run([sys.executable, '-B', '-c', script, str(ROOT), str(tmp_path / 'home'), str(fixture_bytes)],
        cwd=native, env={**os.environ, 'PYTHONPATH': str(native), 'PYTHONDONTWRITEBYTECODE': '1',
                         'HERMES_HOME': str(tmp_path / 'home'), 'HERMES_DISABLE_LAZY_INSTALLS': '1'},
        capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'find-build-test-register-use-break-repair-revert passed' in result.stdout


@pytest.mark.parametrize('workshop, expected_model, shallow', [(None, 'm', True), ({}, 'm', False),
    ({'repair_model': 'stronger-fixture'}, 'stronger-fixture', True)])
def test_product_repair_queues_the_committed_patch_on_the_accepted_base(tmp_path, monkeypatch,
                                                                      workshop, expected_model, shallow):
    sys.path.insert(0, str(ROOT / 'integrations/hermes/personal_aios'))
    import workshop_builder as builder
    import run_agent
    import hermes_cli.config as hermes_config
    import tools.terminal_tool as terminal
    import gateway.run_scope as run_scope
    from contextlib import nullcontext
    monkeypatch.setattr(run_scope, 'runtime_scope', lambda scope: nullcontext())
    spool = tmp_path / 'requests'
    spool.mkdir()
    source, fixture = tmp_path / 'source.git', tmp_path / 'fixture'
    subprocess.run(['git', 'init', '--bare', str(source)], check=True, capture_output=True)
    subprocess.run(['git', 'init', str(fixture)], check=True, capture_output=True)
    packages = ('phase0/gateway', 'services/personal-aios-integration', 'services/platform-data', 'services/qwen-embedded')
    for package in packages:
        file = fixture / '01-product-half-finished/backend' / package / 'fixture.txt'
        file.parent.mkdir(parents=True)
        file.write_text('accepted source\n')
    (fixture / '.gitignore').write_text('node_modules\n')
    subprocess.run(['git', '-C', str(fixture), 'add', '.'], check=True)
    subprocess.run(['git', '-C', str(fixture), '-c', 'user.name=fixture', '-c', 'user.email=f@paios.invalid',
                    'commit', '-m', 'accepted base'], check=True, capture_output=True)
    base = subprocess.check_output(['git', '-C', str(fixture), 'rev-parse', 'HEAD'], text=True).strip()
    subprocess.run(['git', '-C', str(source), 'fetch', str(fixture), 'HEAD:refs/paios/accepted'], check=True,
                   capture_output=True)
    if shallow:
        (source / 'shallow').write_text(base + '\n')
    (spool / 'base.json').write_text(json.dumps({'commit': base}))
    monkeypatch.setenv('PAIOS_RELEASE_REQUESTS', str(spool))
    monkeypatch.setenv('PAIOS_BUILDER_API_KEY', 'fixture')
    seen = {}
    class Agent:
        def __init__(self, **options):
            seen['options'] = options
        def run_conversation(self, text):
            seen['input'] = text
            prepare = seen['options']['ephemeral_system_prompt'].split('Prepare the source once: ', 1)[1].split('. Reproduce the failure first', 1)[0]
            prepare = prepare.replace('/srv/source.git', str(source))
            workspace = tmp_path / re.search(r'/workshop/(repair-[0-9a-f]+)', prepare).group(1)
            seen['workspace'] = workspace
            prepare = re.sub(r'/workshop/repair-[0-9a-f]+', str(workspace), prepare)
            execution = subprocess.run(prepare, shell=True, text=True, capture_output=True, timeout=15)
            assert execution.returncode == 0, execution.stdout + execution.stderr
            assert (workspace / '.git/shallow').exists() is shallow
            if shallow:
                assert (workspace / '.git/shallow').read_text() == base + '\n'
            assert (workspace / '.git/objects/info/alternates').read_text().strip() == str(source / 'objects')
            assert not list((workspace / '.git/objects/pack').glob('*'))
            assert (workspace / '01-product-half-finished/backend/phase0/gateway/fixture.txt').read_text() == 'accepted source\n'
            assert (workspace / 'node_modules').is_symlink()
            assert (workspace / '.gitignore').read_text() == (fixture / '.gitignore').read_text()
            ignored = subprocess.run(['git', '-C', str(workspace), '-c', 'core.excludesFile=/dev/null',
                                      'check-ignore', '--verbose', 'node_modules'],
                                     text=True, capture_output=True)
            assert ignored.returncode == 0 and ignored.stdout.startswith('.gitignore:'), ignored.stdout + ignored.stderr
            return {'completed': not seen.get('failed'), 'final_response': 'fixed the timestamp unit'}
        def close(self):
            pass
    patch_text = 'From 0000 Mon Sep 17 00:00:00 2001\n--- a/x.py\n+++ b/integrations/x.py\n@@ -1 +1 @@\n-a\n+b\n'
    class Environment:
        def execute(self, command, **options):
            if command.startswith('rm -rf -- '):
                shutil.rmtree(seen['workspace'])
                return {'returncode': 0, 'output': ''}
            seen['export'] = command
            return {'returncode': 1 if seen.get('export_fails') else 0, 'output': patch_text}
    monkeypatch.setattr(run_agent, 'AIAgent', Agent)
    config = {'model': {'default': 'm', 'provider': 'p', 'base_url': 'u'}, 'agent': {}}
    if workshop is not None:
        config['workshop'] = workshop
    monkeypatch.setattr(hermes_config, 'load_config', lambda: config)
    monkeypatch.setattr(terminal, 'ensure_task_env', lambda task: Environment())
    monkeypatch.setattr(terminal, '_evict_environment_for_task', lambda task: None)
    origin = {'kind': 'system_selfcheck', 'principal_id': 'owner-1', 'device_id': 'phone-1',
              'origin_processed_event_id': 'd:delegated-owner', 'failed_card': 'failed-child:0',
              'title': 'Read weather', 'evidence_ref': {'tool': 'session_search', 'session_id': 'failed-child'}}
    result = builder.repair_product({'input': '摄像头画面总是超时', 'origin': origin})
    assert not seen['workspace'].exists()
    assert seen['options']['model'] == expected_model
    assert (seen['options']['provider'], seen['options']['base_url'], seen['options']['api_key'],
            seen['options']['api_mode']) == ('p', 'u', 'fixture', 'chat_completions')
    assert config['model']['default'] == 'm'
    queued = spool / result['request_id']
    assert json.loads((queued / 'request.json').read_text())['base'] == base
    assert json.loads((queued / 'request.json').read_text())['origin'] == origin
    assert 'system self-check of failed-child:0' in seen['options']['ephemeral_system_prompt']
    assert "in the owner's words" not in seen['options']['ephemeral_system_prompt']
    assert (queued / 'candidate.patch').read_text() == patch_text and result['files'] == ['integrations/x.py']
    assert f'git checkout --detach {base}' in seen['options']['ephemeral_system_prompt']
    instructions = seen['options']['ephemeral_system_prompt']
    assert 'ln -s /opt/paios-test-deps/$package/node_modules' in instructions
    for package in ('phase0/gateway', 'services/personal-aios-integration', 'services/platform-data', 'services/qwen-embedded'):
        assert package in instructions
    assert 'node --test --test-concurrency=1' in instructions and 'Do not download Node' in instructions
    assert 'skills_hub' not in seen['options']['enabled_toolsets'] and seen['input'] == '摄像头画面总是超时'
    assert f'merge-base --is-ancestor {base} HEAD' in seen['export']
    assert builder.release_status({'request_id': result['request_id']})['status'] == 'queued'
    (queued / 'result.json').write_text(json.dumps({'steps': {'source': 'passed'}, 'failure': 'RuntimeError: SUITES_FAILED'}))
    assert builder.release_status({'request_id': result['request_id']})['failure'] == 'RuntimeError: SUITES_FAILED'
    for bad in ({'input': ''}, {'input': 'x', 'base': base}):
        try:
            builder.repair_product(bad)
        except builder.BuilderRefusal:
            continue
        raise AssertionError('accepted an invalid repair request')
    seen['export_fails'] = True
    try:
        builder.repair_product({'input': 'no change', 'origin': origin})
    except builder.BuilderRefusal as error:
        assert 'no committed change' in str(error)
    else:
        raise AssertionError('queued a repair without a committed change')
    assert not seen['workspace'].exists()
    seen['failed'] = True
    with pytest.raises(RuntimeError, match='Repair did not complete'):
        builder.repair_product({'input': 'repair failed', 'origin': origin})
    assert not seen['workspace'].exists()
    assert list(spool.glob('*/request.json')) == [queued / 'request.json']
