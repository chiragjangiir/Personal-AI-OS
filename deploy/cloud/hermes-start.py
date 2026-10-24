"""Load file-mounted credentials into Hermes' own process environment."""
import os
import json
from pathlib import Path
import subprocess

if os.environ.get('PAIOS_STAGE') == 'staging':
    os.environ.update(HERMES_SYNC_ENABLED='false', HERMES_ENABLE_PROJECT_PLUGINS='false')

subprocess.run(['node', '/opt/paios/integrations/hermes/verify-producer.mjs', '--check-running', '/opt/hermes'], check=True)
for name, file in [('API_SERVER_KEY', 'hermes-api.key'),
                   ('PAIOS_HERMES_INTERNAL_KEY', 'hermes-internal.key'),
                   ('PAIOS_DEEPSEEK_API_KEY', 'deepseek.key'),
                   ('PAIOS_SILICONFLOW_API_KEY', 'siliconflow.key')]:
    os.environ[name] = (Path('/run/secrets') / file).read_text().strip()
if os.environ.get('PAIOS_DEPLOYMENT') == 'single-host':
    for role, configuration in json.loads(Path('/etc/paios/models.json').read_text()).items():
        variable = f'PAIOS_{role.upper()}_API_KEY'
        value = Path(configuration['key_file']).read_text().strip()
        if not value:
            raise ValueError(f'{variable} requires a nonempty key_file')
        os.environ[variable] = value
if Path('/run/secrets/tavily.key').exists():
    tavily_key = Path('/run/secrets/tavily.key').read_text().strip()
    if tavily_key:
        os.environ['TAVILY_API_KEY'] = tavily_key
os.environ.update(API_SERVER_HOST='127.0.0.1', API_SERVER_PORT=os.environ['PAIOS_HERMES_PORT'], PYTHONPATH='/opt/hermes')
os.execv('/opt/hermes/.venv/bin/python', ['python', '/opt/paios/integrations/hermes/personal_aios/run_api.py'])
