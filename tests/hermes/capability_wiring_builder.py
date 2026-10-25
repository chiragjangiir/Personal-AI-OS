"""Opt-in builder transport fixture: source builder and real model, data-free namespace."""
import importlib.util
import json
import os
from pathlib import Path
import sys

from capability_model import configure

ROOT, HOME, REQUEST, OUTPUT = map(Path, sys.argv[1:5])
request = json.loads(REQUEST.read_text())
config = configure(HOME, os.environ['PAIOS_CAPABILITY_TEST_KEY_FILE'], {
    'agent': {'max_tool_calls': 40, 'api_max_retries': 1, 'auto_recovery_cycles': 0},
    'plugins': {'enabled': []}, 'terminal': {'backend': 'local', 'cwd': str(HOME)},
    'skills': {'external_dirs': [], 'guard_agent_created': True, 'tier1_advisory': False},
    'auxiliary': {'title_generation': {'enabled': False}, 'vision': {'enabled': False}},
})
import yaml
(HOME / 'workshop').mkdir(exist_ok=True)
(HOME / 'workshop/config.yaml').write_text(yaml.safe_dump(config))
os.environ['HERMES_WRITE_SAFE_ROOT'] = str(HOME)
from hermes_constants import set_hermes_home_override
set_hermes_home_override(HOME)
from hermes_cli.env_loader import install_profile_secret_source_values
for profile in (HOME, HOME / 'workshop'):
    install_profile_secret_source_values(profile, {'PAIOS_CAPABILITY_TEST_KEY': os.environ['PAIOS_CAPABILITY_TEST_KEY']})
from integrations.hermes.personal_aios import workshop_builder as builder
from tools.registry import registry
import tools.terminal_tool as terminal
import run_agent

# The only replaced service is the external task-budget service. The caller has a real build admission.
builder._admit_build = lambda: None
spec = importlib.util.spec_from_file_location('contract_driver', ROOT /
    '01-product-half-finished/backend/services/personal-aios-integration/src/capability/registry/runner.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


def execute(args, **kwargs):
    package = HOME / 'workshop/skills/workshop' / request['name']
    package.mkdir(parents=True, exist_ok=True)
    _, audit, code = driver.run(package, ['/bin/bash', '-c', 'cd /package && ' + args['command']], [])
    return json.dumps({'exit_code': code, 'output': audit['stdout'] + audit['stderr']})


registry.register(name='terminal', toolset='terminal', schema=terminal.TERMINAL_SCHEMA, handler=execute, override=True)
BaseAgent = run_agent.AIAgent


class CapturedAgent(BaseAgent):
    def run_conversation(self, *args, **kwargs):
        result = super().run_conversation(*args, **kwargs)
        (OUTPUT.parent / 'builder-transcript.json').write_text(json.dumps(result, ensure_ascii=False, default=str, indent=2))
        return result


run_agent.AIAgent = CapturedAgent
try:
    candidate = builder.build_capability(request)
    OUTPUT.write_text(json.dumps(candidate, ensure_ascii=False))
finally:
    from integrations.hermes.personal_aios.tool_lifecycle import _files
    package = HOME / 'workshop/skills/workshop' / request['name']
    if package.exists():
        (OUTPUT.parent / 'builder-draft.json').write_text(json.dumps({'name': request['name'], 'files': _files(package)}, ensure_ascii=False))
