"""Ordinary owner learning stays immediate; only workshop publication is reserved."""
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).parents[2]


@pytest.mark.parametrize('scenario', ['ordinary', 'background', 'workshop'])
def test_owner_skill_learning_and_workshop_boundary(tmp_path, scenario):
    native = Path(os.environ['PAIOS_NATIVE_SOURCE_TEST_ROOT'])
    script = r'''
import json, subprocess, sys
from pathlib import Path
import yaml
root, home, scenario = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
sys.path.insert(0, str(root/'integrations/hermes'))
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from tools.skill_manager_tool import skill_manage
from tools.skills_tool import skill_view
from tools.write_approval import list_pending, SKILLS
from tools.skill_provenance import BACKGROUND_REVIEW, set_current_write_origin, reset_current_write_origin
from gateway.run_scope import runtime_scope
for profile in (home, home/'workshop'):
 profile.mkdir(parents=True, exist_ok=True)
 (profile/'config.yaml').write_text(yaml.safe_dump({'skills': {
  'external_dirs': [], 'inline_shell': False, 'create_dir': '', 'guard_agent_created': True}}))
def doc(name):
 return '---\nname: '+name+'\ndescription: Use a learned method and verify its result.\nadapter_modules: []\n---\nFirst draft.\n'
def manage(action, name, **kwargs): return json.loads(skill_manage(action, name, **kwargs))
def created(name, **kwargs):
 result = manage('create', name, content=doc(name), **kwargs)
 assert result['success'] and not result.get('staged'), result
 return result
def refused(result):
 assert not result['success'] and 'skills_hub build, test and promote' in result['error'], result
 assert not result.get('staged'), result
token = set_hermes_home_override(home)
try:
 if scenario == 'ordinary':
  created('owner-howto')
  path = home/'skills/owner-howto/SKILL.md'
  assert path.exists()
  result = manage('patch', 'owner-howto', old_string='First draft.', new_string='Improved method.')
  assert result['success'] and not result.get('staged'), result
  assert 'Improved method.' in path.read_text()
 elif scenario == 'background':
  created('owner-howto')
  origin = set_current_write_origin(BACKGROUND_REVIEW)
  try:
   created('review-tip')
   path = home/'skills/review-tip/SKILL.md'
   result = manage('patch', 'review-tip', old_string='First draft.', new_string='Reviewed method.')
   assert not result['success'] and result.get('_read_before_write_required'), result
   assert 'First draft.' in skill_view('review-tip')
   result = manage('patch', 'review-tip', old_string='First draft.', new_string='Reviewed method.')
   assert result['success'] and not result.get('staged'), result
   assert 'Reviewed method.' in path.read_text()
   # Native curation ownership protection is preserved too.
   result = manage('patch', 'owner-howto', old_string='First draft.', new_string='Not permitted.')
   assert not result['success'] and 'not curator-managed' in result['error'], result
  finally: reset_current_write_origin(origin)
 else:
  from personal_aios.tool_lifecycle import ToolLifecycle
  def verify(path):
   result = subprocess.run([sys.executable, '-B', 'scripts/run.py'], cwd=path, capture_output=True, text=True)
   return {'success': result.returncode == 0, 'output': result.stdout}
  lifecycle = ToolLifecycle(verify)
  pending = lifecycle.stage('fixture-tool', {'SKILL.md': doc('fixture-tool'),
      'scripts/run.py': 'print("fixture ready")\n'})['pending_id']
  path = home/'skills/workshop/fixture-tool'
  assert not path.exists()
  try: lifecycle.promote(pending)
  except ValueError as error: assert 'pass testing' in str(error)
  else: raise AssertionError('Untested candidate promoted')
  assert lifecycle.test(pending)['success'] and not path.exists()
  assert lifecycle.promote(pending)['success']
  saved = (path/'SKILL.md').read_text()
  refused(manage('create', 'new-tool', category='workshop', content=doc('new-tool')))
  for name in ('fixture-tool', 'workshop/fixture-tool'):
   refused(manage('patch', name, old_string='First draft.', new_string='Bypass.'))
   refused(manage('write_file', name, file_path='scripts/run.py', file_content='print("bypass")\n'))
  refused(manage('create', 'unused', operations=[
   {'action': 'create', 'name': 'ordinary-before', 'content': doc('ordinary-before')},
   {'action': 'create', 'name': 'new-tool', 'category': 'workshop', 'content': doc('new-tool')}]))
  assert not (home/'skills/ordinary-before').exists()
  refused(manage('patch', 'fixture-tool', operations=[
   {'action': 'patch', 'old_string': 'First draft.', 'new_string': 'Batch bypass.'}]))
  assert (path/'SKILL.md').read_text() == saved
  assert lifecycle.monitor('fixture-tool')['verification']['output'] == 'fixture ready\n'
  with runtime_scope('build'):
   created('build-tool', category='workshop')
 assert list_pending(SKILLS) == []
 print(scenario + ' passed')
finally: reset_hermes_home_override(token)
'''
    result = subprocess.run([sys.executable, '-B', '-c', script, str(ROOT), str(tmp_path / 'home'), scenario],
        cwd=native, env={**os.environ, 'PYTHONPATH': str(native), 'PYTHONDONTWRITEBYTECODE': '1',
                         'HERMES_HOME': str(tmp_path / 'home'), 'HERMES_DISABLE_LAZY_INSTALLS': '1'},
        capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert scenario + ' passed' in result.stdout
