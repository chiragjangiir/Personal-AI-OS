#!/command/with-contenv /opt/hermes/.venv/bin/python
"""Attach the regression query to the existing staging fake phone after cloud init."""
import os
from pathlib import Path

import yaml

if os.environ.get('PAIOS_STAGE') != 'staging':
    raise SystemExit('Regression fixtures require staging')
if os.environ.get('PAIOS_PHONE_PROVIDER') == 'off':
    raise SystemExit(0)
path = Path(os.environ['HERMES_HOME']) / 'config.yaml'
config = yaml.safe_load(path.read_text())
phone = config['mcp_servers']['phone']
if phone['args'] != ['/opt/paios/integrations/hermes/personal_aios/staging/fake_phone.py']:
    raise SystemExit('Expected the existing staging fake phone')
phone['args'] = ['/stage-kit/regression_effects.py', '--fixture-config', '/stage-private/effects.json']
path.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False))
