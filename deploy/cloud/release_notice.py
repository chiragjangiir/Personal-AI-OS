"""Project host failures into the existing TaskFailure notice contract and spool."""
from datetime import datetime, timezone
from pathlib import Path

from watchdog_platform import atomic_json


def body(spec, kind, text, **event):
    origin, request_id = spec['origin'], spec['request_id']
    return {**{key: origin[key] for key in ('principal_id', 'device_id')},
            'id': kind + ':' + request_id, 'text': text,
            'captured_at': spec.get('captured_at') or datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'),
            'system_event': {'type': kind.replace('-', '_'), 'request_id': request_id,
                             'origin_processed_event_id': origin['origin_processed_event_id'], **event}}


def failure(spec, stage, error):
    request_id = spec['request_id']
    title = spec.get('description') or spec.get('summary') or '产品修复 ' + request_id
    return body(spec, 'task-failure', '产品修复未完成，依米需要检查发布证据。', failure={
        'failure_source': 'workshop', 'job_id': request_id, 'title': title[:40], 'task': title[:4000],
        'terminal_reason': 'failed', 'answer': (stage + ': ' + error)[:4000],
        'evidence_ref': {'tool': 'skills_hub', 'action': 'release_status', 'request_id': request_id}})


def queue(directory, value):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o750)
    path = directory / (value['id'].replace(':', '-') + '.json')
    if not path.exists():
        atomic_json(path, value, mode=0o644)
