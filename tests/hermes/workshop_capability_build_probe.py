"""Opt-in real-model builder probe. Keys are read from files, never from product secrets."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import yaml

REPO, HOME, OUTPUT, DEPS = map(Path, sys.argv[1:5])
sys.path.insert(0, str(REPO / 'integrations/hermes'))
from personal_aios import workshop_builder as builder
from hermes_cli.env_loader import install_profile_secret_source_values
from hermes_constants import set_hermes_home_override
from tools.registry import registry
import tools.terminal_tool as terminal
import run_agent

HOME.mkdir(parents=True, exist_ok=True)
config = {
    'model': {'default': 'deepseek-v4.1-flash', 'provider': 'opendesign-test',
              'base_url': 'https://amr-link.open-design.ai/v1', 'context_length': 262144,
              'request_overrides': {'max_tokens': 8192, 'temperature': 0, 'extra_body': {'thinking': {'type': 'disabled'}}}},
    'providers': {'opendesign-test': {'api': 'https://amr-link.open-design.ai/v1',
                   'key_env': 'OPENDESIGN_TEST_KEY', 'transport': 'chat_completions'}},
    'agent': {'max_tool_calls': 80, 'max_tokens': 12000, 'api_max_retries': 1, 'auto_recovery_cycles': 0},
    'terminal': {'backend': 'local', 'cwd': str(HOME)},
    'skills': {'external_dirs': [], 'guard_agent_created': True, 'tier1_advisory': False},
    'memory': {'memory_enabled': False, 'user_profile_enabled': False},
    'compression': {'enabled': False}, 'tools': {'tool_search': {'enabled': 'off'}},
    'auxiliary': {'title_generation': {'enabled': False}, 'vision': {'enabled': False}, 'compression': {'enabled': False}},
    'fallback_providers': [], 'plugins': {'enabled': []},
}
(HOME / 'config.yaml').write_text(yaml.safe_dump(config))
(HOME / 'workshop').mkdir(exist_ok=True)
(HOME / 'workshop/config.yaml').write_text(yaml.safe_dump(config))
secret = Path(os.environ['PAIOS_CAPABILITY_TEST_KEY_FILE']).read_text().strip()
for profile in (HOME, HOME / 'workshop'):
    install_profile_secret_source_values(profile, {'OPENDESIGN_TEST_KEY': secret})
del secret
os.environ['HERMES_HOME'] = str(HOME)
os.environ['HERMES_WRITE_SAFE_ROOT'] = str(HOME)
set_hermes_home_override(HOME)
# The fixture replaces only the external task-budget/admission service, never the model.
builder._admit_build = lambda: None
spec = importlib.util.spec_from_file_location('contract_driver', REPO /
    '01-product-half-finished/backend/services/personal-aios-integration/src/capability/registry/runner.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


def execute(args, **kwargs):
    from tools.skill_manager_tool import _find_skill
    skill = _find_skill('pdf-batch')
    package = Path(skill['path']) if skill else HOME / 'workshop/skills/workshop/pdf-batch'
    package.mkdir(parents=True, exist_ok=True)
    # Actual model-authored commands execute in a data-free kernel namespace.
    _, audit, code = driver.run(package, ['/bin/bash', '-c', 'cd /package && ' + args['command']], [], dependencies=DEPS)
    return json.dumps({'exit_code': code, 'output': audit['stdout'] + audit['stderr']})


registry.register(name='terminal', toolset='terminal', schema=terminal.TERMINAL_SCHEMA, handler=execute, override=True)
BaseAgent = run_agent.AIAgent


class CapturedAgent(BaseAgent):
    def __init__(self, *args, **kwargs):
        progress = OUTPUT.parent / 'builder-progress.jsonl'
        progress.write_text('')
        def callback(*values, **fields):
            row = {'at': time.monotonic(), 'event': values[0] if values and isinstance(values[0], str) else 'tool',
                   'tool': values[1] if len(values) > 1 and isinstance(values[1], str) else '', 'fields': list(fields)}
            with progress.open('a') as stream:
                stream.write(json.dumps(row) + '\n')
        kwargs['tool_progress_callback'] = callback
        super().__init__(*args, **kwargs)

    def run_conversation(self, *args, **kwargs):
        result = super().run_conversation(*args, **kwargs)
        (OUTPUT.parent / 'builder-transcript.json').write_text(json.dumps(result, ensure_ascii=False, default=str, indent=2))
        return result


run_agent.AIAgent = CapturedAgent
request = json.loads((OUTPUT.parent / 'build-request.json').read_text())
try:
    candidate = builder.build_capability(request)
    OUTPUT.write_text(json.dumps(candidate, ensure_ascii=False))
except RuntimeError:
    # Preserve only model-authored draft files; no successful build or publication is claimed.
    from personal_aios.tool_lifecycle import _files
    draft = HOME / 'workshop/skills/workshop/pdf-batch'
    if draft.exists():
        (OUTPUT.parent / 'unverified-draft.json').write_text(json.dumps({'name': 'pdf-batch',
            'files': _files(draft), 'verified': False}, ensure_ascii=False))
    raise
