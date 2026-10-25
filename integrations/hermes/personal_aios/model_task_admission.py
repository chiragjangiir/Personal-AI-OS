"""New paid-task admission against the existing model usage budget authority."""
import json
import os
from contextlib import contextmanager
from pathlib import Path
from urllib.request import Request, urlopen


def preflight(role):
    if __package__:
        from .model_usage import _context, _projection
    else:
        from model_usage import _context, _projection
    projection = _projection()
    context = _context()
    body = {key: context[key] for key in ('run_id', 'session_id')}
    if context.get('source_context'):
        body['source_context'] = context['source_context']
    body.update(environment=projection['environment_id'], profile=projection['profile'], role=role)
    request = Request(os.environ['PAIOS_MODEL_SETTINGS_SERVICE_URL'].rstrip('/') + '/internal/model-settings/admission',
        data=json.dumps(body).encode(), headers={'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + Path(os.environ['PAIOS_MODEL_SETTINGS_TOKEN_FILE']).read_text().strip()})
    with urlopen(request, timeout=15) as response:
        result = json.loads(response.read(65536))
    return None if result['allowed'] else result


def require_new_task(role):
    if not os.environ.get('PAIOS_MODEL_SETTINGS_PROJECTION'):
        return
    refusal = preflight(role)
    if refusal:
        raise ValueError(json.dumps(refusal, ensure_ascii=False))


def install():
    from agent import model_usage
    model_usage.new_task_admission = preflight


def journal_remote(attempt):
    request = Request(os.environ['PAIOS_MODEL_SETTINGS_JOURNAL_URL'].rstrip('/') + '/api/model-settings/usage',
        data=json.dumps(attempt).encode(), headers={'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + Path(os.environ['PAIOS_MODEL_SETTINGS_TOKEN_FILE']).read_text().strip()})
    with urlopen(request, timeout=15) as response:
        response.read(65536)


@contextmanager
def remote_context(request):
    context = request.pop('_model_context', None)
    if not os.environ.get('PAIOS_MODEL_SETTINGS_PROJECTION'):
        yield
        return
    if (not isinstance(context, dict) or set(context) != {'run_id', 'session_id'}
            or any(not isinstance(value, str) or not value for value in context.values())):
        raise ValueError('MODEL_USAGE_ADMISSION_REQUIRED')
    from gateway.session_context import bind_api_run_conversation, reset_api_run_conversation
    token = bind_api_run_conversation(context['run_id'], context['session_id'])
    from agent.model_usage import journal_context
    journal_token = journal_context.set(journal_remote)
    try:
        yield
    finally:
        reset_api_run_conversation(token)
        journal_context.reset(journal_token)
