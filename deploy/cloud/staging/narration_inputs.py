"""Rebuild changed producer inputs from retained native records, without running actions."""
import copy
import importlib.util
import json
import os
import sys
from types import ModuleType, SimpleNamespace
from pathlib import Path
import tempfile
from datetime import datetime



def json_body(text):
    start = text.find('{')
    if start < 0:
        return None
    try:
        value, length = json.JSONDecoder().raw_decode(text[start:])
    except json.JSONDecodeError:
        return None
    return start, length, value


def replace_body(text, transform):
    decoded = json_body(text)
    if decoded is None:
        return text
    start, length, value = decoded
    return text[:start] + json.dumps(transform(value), ensure_ascii=False) + text[start+length:]


def observe_result(value, native, args):
    source = Path('/opt/paios/integrations/hermes/personal_aios/self_observe.py')
    spec = importlib.util.spec_from_file_location('replay_self_observe', source)
    observe_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(observe_module)
    observe = observe_module.observe
    if not isinstance(value, dict):
        return value
    if isinstance(value.get('result'), str):
        value['result'] = replace_body(value['result'], lambda v: observe_result(v, native, args))
        return value
    if value.get('source') not in ('release', 'errands') or 'hermes' not in value:
        return value
    old = value['hermes']
    with tempfile.TemporaryDirectory(prefix='narration-observe-') as folder:
        root = Path(folder)
        if value['source'] == 'release':
            (root / 'status').mkdir()
            (root / 'rollback').mkdir()
            if old.get('runtime') is not None:
                (root / 'status/runtime.json').write_text(json.dumps(old['runtime']))
            for request in old.get('pending_rollback_requests', []):
                (root / 'rollback' / (request + '.json')).write_text('{}')
            for record in old.get('records', []):
                (root / 'status' / (record['request_id'] + '.json')).write_text(json.dumps(record))
            key = 'PAIOS_RELEASE_SPOOL'
            principal = None
        else:
            raw = {r['record']['job_id']: r for r in native.get('spool', [])}
            principal = 'replay-owner'
            for record in old.get('records', []):
                job = record['job_id']
                source = raw.get(job)
                content = record
                if source and source['record'].get('finished_at') and value.get('as_of') is not None:
                    retained = source['record']
                    stamps = [retained['finished_at'], retained.get('delivery_failure', {}).get('failed_at')]
                    if all(datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() * 1000 <= value['as_of']
                           for stamp in stamps if stamp):
                        content = retained
                content = dict(content, principal_id=principal)
                state = record['spool_state']
                (root / (job + '.' + state + '.json')).write_text(json.dumps(content))
            key = 'PAIOS_ERRAND_SPOOL'
        previous = os.environ.get(key)
        os.environ[key] = folder
        try:
            value['hermes'] = observe(args, principal)
        finally:
            if previous is None:
                os.environ.pop(key)
            else:
                os.environ[key] = previous
    return value


def project_observations(messages, native):
    calls = {call['id']: call['function'] for row in messages for call in row.get('tool_calls') or []}
    for message in messages:
        call = calls.get(message.get('tool_call_id'))
        if message['role'] == 'tool' and call and call['name'] == 'mcp__self__runtime_query':
            args = json.loads(call['arguments'])
            message['content'] = replace_body(message.get('content') or '', lambda value: observe_result(value, native, args))
    return messages


def project_saved_decisions(messages):
    from gateway.platforms.api_run_reporting import tool_result_record
    from gateway import session_context
    from tools.approval_context import _approval_tool_call_id
    package = ModuleType('narration_product')
    package.__path__ = ['/opt/paios/integrations/hermes/personal_aios']
    sys.modules.setdefault('narration_product', package)
    from narration_product.release_consent import release_decide
    calls = {call['id']: call['function'] for row in messages for call in row.get('tool_calls') or []}
    for message in messages:
        call = calls.get(message.get('tool_call_id'))
        if message['role'] != 'tool' or not call or call['name'] != 'skills_hub':
            continue
        args = json.loads(call['arguments'])
        if args.get('action') != 'release_decide':
            continue
        saved = tool_result_record(message['content'])
        if not saved or not {'principal_id', 'decided_at', 'approved'} <= saved.keys():
            continue
        if saved.get('decision_status') == 'resolved' and saved.get('lifecycle') in ('waited_for_owner_decision', 'saved_decision_replay'):
            continue
        with tempfile.TemporaryDirectory(prefix='narration-decision-') as folder:
            root = Path(folder)
            (root / 'status').mkdir()
            (root / 'decisions').mkdir()
            request = args['value']
            status = {**saved, 'state': 'awaiting_owner', 'origin': {'principal_id': saved['principal_id']}}
            (root / 'status' / (request + '.json')).write_text(json.dumps(status))
            (root / 'decisions' / (request + '.json')).write_text(json.dumps(saved))
            bindings = [(session_context._SESSION_PLATFORM, 'api_server'),
                        (session_context._SESSION_ID, 'replay-saved-decision'),
                        (session_context._SESSION_KEY, 'replay-saved-decision'),
                        (_approval_tool_call_id, message['tool_call_id'])]
            tokens = [(variable, variable.set(value)) for variable, value in bindings]
            try:
                provider = SimpleNamespace(_request=lambda path, body: {
                    'allow_owner_mutation': True, 'principal_id': saved['principal_id']})
                result = release_decide(root, request, provider, 'replay-saved-decision')
            finally:
                for variable, token in reversed(tokens):
                    variable.reset(token)
            message['content'] = replace_body(message['content'], lambda value: result)
    return messages



def completion_from_resume(events, history, prior_reports=()):
    """Run native completion assembly with captured OUT responses and no delegated actions."""
    from gateway.platforms.api_run_delegation import RunDelegation
    provider = SimpleNamespace(errand_report_context=lambda context, jobs:
        [report for report in prior_reports if report['job_id'] in jobs])
    agent = SimpleNamespace(session_id='narration-fixture', _paios_principal_id='narration-fixture',
        _paios_tool_conversation='narration-fixture',
        _memory_manager=SimpleNamespace(get_provider=lambda name: provider))
    delegation = RunDelegation(agent, lambda busy: None)
    for event in events:
        delegation.results.put(event)
    captured = []
    def record(text, messages):
        captured.append(text)
        return {'messages': messages}
    delegation.resume({'messages': history}, record)
    if len(captured) != 1:
        raise ValueError('Native replay must assemble exactly one completion batch')
    return captured[0]


def adapt(prefix, case):
    from gateway.platforms.api_run_reporting import confirmation_receipts, task_records
    native = json.loads(Path(case['native']).read_text())
    native = native.get('native', native)
    rows = native['trace']['messages']
    for row in rows:
        if isinstance(row.get('tool_calls'), str):
            row['tool_calls'] = json.loads(row['tool_calls'])
    target = next(row for row in rows if row['id'] == case['message_id'])
    history = [dict(row, _row_id=row['id']) for row in rows
               if row['session_id'] == target['session_id'] and row['id'] < target['id']]
    updated = project_saved_decisions(project_observations(copy.deepcopy(prefix), native))
    for source_row, message in zip(history, updated):
        content = message.get('content') or ''
        if message['role'] != 'system' or not content.startswith('Native delegated work completed.'):
            continue
        body = content.split('\n', 1)[1]
        events, end = json.JSONDecoder().raw_decode(body)
        for event in events:
            for result in event.get('results', [event]):
                child = project_saved_decisions(project_observations(copy.deepcopy([row for row in rows
                    if row['session_id'] == result.get('session_id') and row['id'] < source_row['id']]), native))
                result['confirmation_receipts'] = confirmation_receipts(child)
                result['task_records'] = task_records(child)
                result.pop('failure_context', None)  # Rebuild native consumer metadata from the durable result.
        message['content'] = completion_from_resume(events, [row for row in history if row['id'] < source_row['id']],
            case.get('prior_reports_by_message', {}).get(str(source_row['id']), ()))
    return updated
