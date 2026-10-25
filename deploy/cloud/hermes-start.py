"""Load file-mounted credentials into Hermes' own process environment."""
import os
from pathlib import Path
import subprocess
import time
from urllib.error import URLError
from urllib.request import urlopen

if os.environ.get('PAIOS_STAGE') == 'staging':
    os.environ.update(HERMES_SYNC_ENABLED='false', HERMES_ENABLE_PROJECT_PLUGINS='false')

# This is bounded service bootstrap, before any provider request can be admitted.
deadline = time.monotonic() + 90
while True:
    try:
        with urlopen(os.environ['PAIOS_MODEL_SETTINGS_SERVICE_URL'].rstrip('/') + '/health', timeout=2) as response:
            if response.status == 200:
                break
    except (URLError, TimeoutError):
        pass
    if time.monotonic() >= deadline:
        raise RuntimeError('Model settings authority is unavailable during startup')
    time.sleep(1)

subprocess.run(['node', '/opt/paios/integrations/hermes/verify-producer.mjs', '--check-running', '/opt/hermes'], check=True)
for name, file in [('API_SERVER_KEY', 'hermes-api.key'),
                   ('PAIOS_HERMES_INTERNAL_KEY', 'hermes-internal.key')]:
    os.environ[name] = (Path('/run/secrets') / file).read_text().strip()
if Path('/run/secrets/tavily.key').exists():
    tavily_key = Path('/run/secrets/tavily.key').read_text().strip()
    if tavily_key:
        os.environ['TAVILY_API_KEY'] = tavily_key
os.environ.update(API_SERVER_HOST='127.0.0.1', API_SERVER_PORT=os.environ['PAIOS_HERMES_PORT'], PYTHONPATH='/opt/hermes:/opt/paios')
os.execv('/opt/hermes/.venv/bin/python', ['python', '/opt/paios/integrations/hermes/personal_aios/run_api.py'])
