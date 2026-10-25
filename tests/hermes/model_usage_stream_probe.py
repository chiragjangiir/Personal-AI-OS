"""Native client factory -> real SDK -> observer -> Integration HTTP usage records."""
import json
import os
from pathlib import Path
import sys

root, native, home = map(Path, sys.argv[1:4])
request = json.loads(Path(sys.argv[4]).read_text())
sys.path[:0] = [str(native), str(root / 'integrations/hermes/personal_aios')]
home.mkdir()
os.environ.update(HERMES_HOME=str(home), PAIOS_MODEL_SETTINGS_PROJECTION=str(home / 'projection.json'),
    PAIOS_MODEL_SETTINGS_TOKEN_FILE=request['token_file'], PAIOS_MODEL_SETTINGS_SERVICE_URL=request['service_url'],
    NO_PROXY='127.0.0.1,localhost,::1', no_proxy='127.0.0.1,localhost,::1')
import yaml
(home / 'config.yaml').write_text(yaml.safe_dump({'secrets': {'personal_aios': {'projection': str(home / 'projection.json')}}}))
(home / 'projection.json').write_text(json.dumps(request['projection']))

import model_usage
from agent.model_usage import journal_context, usage_role
from agent.process_bootstrap import build_keepalive_http_client
from gateway.session_context import bind_api_run_conversation, reset_api_run_conversation
from openai import OpenAI

model_usage.install()
facts, sdk_usage = [], []
journal = journal_context.set(facts.append)
binding = bind_api_run_conversation('observer-run', 'observer-session')
try:
    with OpenAI(api_key='fake-provider-key', base_url=request['base_url'], max_retries=0,
                http_client=build_keepalive_http_client(request['base_url'], verify=request['ca_file'])) as sdk:
        for index, role in enumerate(('brain', 'delegation', 'auxiliary.compression')):
            with usage_role(role, f'observer-request-{index}'):
                with sdk.chat.completions.create(model='fake-model', messages=[{'role': 'user', 'content': 'test'}],
                        stream=True, stream_options={'include_usage': True}) as stream:
                    chunks = list(stream)
                    sdk_usage.append(chunks[-1].usage.model_dump(exclude_none=True))
    assert len(facts) == 3
    for fact, provider in zip(facts, sdk_usage):
        assert fact['status'] == 'completed'
        assert (fact['input_tokens'], fact['output_tokens']) == (provider['prompt_tokens'], provider['completion_tokens'])
    print(json.dumps({'attempts': facts, 'sdk_usage': sdk_usage}))
finally:
    reset_api_run_conversation(binding)
    journal_context.reset(journal)
