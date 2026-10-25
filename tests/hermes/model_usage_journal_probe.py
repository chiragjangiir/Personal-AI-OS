"""Fault probe: existing native journal commits before an offline Integration POST."""
import asyncio
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from urllib.error import URLError

import httpx

root, native, home = map(Path, sys.argv[1:])
sys.path.insert(0, str(native))
sys.path.insert(0, str(root / 'integrations/hermes/personal_aios'))
import model_usage as usage
from agent.model_usage import journal_context
from gateway.platforms.api_server_runs import _model_usage_journal, _publish_run_event, _native_run_body, _run_event
from gateway.platforms.api_server_run_idempotency import RunIdempotencyStore


async def main():
    home.mkdir()
    token = home / 'token'
    token.write_text('fake-service-only-token')
    os.environ.update(PAIOS_MODEL_SETTINGS_TOKEN_FILE=str(token), PAIOS_MODEL_SETTINGS_SERVICE_URL='http://127.0.0.1:1',
        PAIOS_MODEL_SETTINGS_PROJECTION='enabled', HERMES_HOME=str(home))
    status = {'run_id': 'journal-run', 'session_id': 'canonical-session', 'conversation_session_id': 'canonical-session',
        'status': 'running', 'granted_toolsets': []}
    db = home / 'runs.db'
    store = RunIdempotencyStore(str(db))
    store.reserve('fixture', 'admitted-key', 'fingerprint', 'journal-run', status)
    owner = SimpleNamespace(_run_statuses={'journal-run': status}, _run_idempotency_ids={'journal-run'},
        _run_idempotency_store=store, _run_streams={})
    run = SimpleNamespace(run_id='journal-run', put_event=lambda event: _publish_run_event(owner, 'journal-run', event))
    saved = journal_context.set(_model_usage_journal(owner, run, asyncio.get_running_loop()))
    count = {'wire_calls': 0, 'http_failures': 0}
    def offline(request, timeout):
        assert len(store.status_for_run('fixture', 'journal-run')['status']['activity_events']) == 1
        count['http_failures'] += 1
        raise URLError('fixture integration offline')
    def model(request):
        count['wire_calls'] += 1
        return httpx.Response(200, json={'usage': {'prompt_tokens': 9, 'completion_tokens': 2}})
    usage.urlopen = offline
    usage._context = lambda: {'run_id': 'journal-run', 'session_id': 'canonical-session', 'request_id': 'logical-request', 'role': 'brain'}
    usage._projection = lambda: {'environment_id': 'test', 'profile': 'owner', 'revision': 1, 'group': 'brain',
        'config': {'providers': {'fake-provider': {'api': 'https://models.invalid/v1'}}}}
    client = usage.instrument(httpx.Client(transport=httpx.MockTransport(model)))
    await asyncio.to_thread(client.post, 'https://models.invalid/v1/chat/completions', json={'model': 'fake-model'})
    client.close()
    journal_context.reset(saved)
    for index in range(40):
        _publish_run_event(owner, 'journal-run', _run_event('journal-run', 'tool.started', tool_call_id='same-tool', public_intent='fixture work'))
        _publish_run_event(owner, 'journal-run', _run_event('journal-run', 'tool.completed', tool_call_id='same-tool'))
    store.close()
    reopened = RunIdempotencyStore(str(db))
    recovered = reopened.status_for_run('fixture', 'journal-run')['status']
    assert sum(event['event'] == 'model.usage' for event in recovered['activity_events']) == 1
    recovered['status'] = 'completed'
    reopened.update_status('journal-run', recovered)
    body = _native_run_body(recovered, 'hermes.run.v2')
    reopened.close()
    print(json.dumps({'run': body, **count}))


asyncio.run(main())
