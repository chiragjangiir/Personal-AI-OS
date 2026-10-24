"""Read bounded diagnostics from this Hermes profile; never traverse host paths."""
import json
import os
from pathlib import Path
import re
import stat
from itertools import islice
from datetime import datetime


def tail(path, budget=65536):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('SELF_SOURCE_NOT_FILE')
        start = max(0, info.st_size - budget)
        stream.seek(start)
        data = stream.read(budget)
    text = data.decode('utf-8', errors='replace')
    return (text.split('\n', 1)[-1] if start else text), bool(start)


def scrub(text):
    from agent.redact import redact_sensitive_text
    text = re.sub(r'(?i)(["\']?(?:password|secret|token|api[_-]?key|access_token|refresh_token)["\']?\s*[:=]\s*)(?:"[^" ]*(?: [^" ]*)*"|\'[^\']*\'|[^\s&,}]+)', r'\1[redacted]', text)
    text = re.sub(r'(?i)Bearer\s+[^\s"\']+', 'Bearer [redacted]', text)
    text = re.sub(r'\A.*?-----END [^-]*PRIVATE KEY-----', '[redacted private key]', text, flags=re.S) if '-----BEGIN' not in text and re.search(r'-----END [^-]*PRIVATE KEY-----', text) else text
    text = re.sub(r'(?m)^[A-Za-z0-9+/=]{24,}$', '[redacted encoded block]', text)
    text = redact_sensitive_text(text, force=True, redact_url_credentials=True)
    text = re.sub(r'-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|\Z)', '[redacted private key]', text, flags=re.S)
    return text


def scrub_value(value):
    if isinstance(value, dict):
        return {k: '[redacted]' if re.search(r'password|secret|token|api[_-]?key', k, re.I) else scrub_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub_value(v) for v in value]
    return scrub(value) if isinstance(value, str) else value


def resources(root=Path('/sys/fs/cgroup')):
    result = {}
    for name in ('cpu.stat', 'cpu.max', 'memory.current', 'memory.max', 'memory.events'):
        try:
            result[name] = (root / name).read_text()[:2048]
        except FileNotFoundError:
            result[name] = None
    return {'source': 'own container cgroup v2', 'values': result}


def observe(args, principal=None):
    from hermes_constants import get_hermes_home
    source, limit = args.get('source', 'metrics'), args.get('limit', 50)
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError('SELF_LIMIT_INVALID')
    logs = {'hermes_agent': 'agent.log', 'hermes_errors': 'errors.log', 'mcp_stderr': 'mcp-stderr.log'}
    since, until = args.get('since'), args.get('until')
    if any(type(v) not in (int, float) or v < 0 for v in (since, until) if v is not None) or since is not None and until is not None and since > until:
        raise ValueError('SELF_TIME_RANGE_INVALID')
    service, level, search = args.get('service'), args.get('level'), args.get('text', '')
    from hermes_cli.logs import _parse_line_timestamp, _extract_level, _extract_logger_name, _LEVEL_ORDER
    def in_window(at):
        return (since is None and until is None) or at is not None and (since is None or at >= since) and (until is None or at <= until)
    if source in logs:
        try:
            text, truncated = tail(get_hermes_home() / 'logs' / logs[source])
        except FileNotFoundError:
            return {'source': source, 'status': 'unavailable'}
        # Scrub the complete bounded block before selecting lines: PEM and JSON
        # secrets may span lines. Reuse Hermes' vault and credential redactor.
        text = scrub(text)
        records, unknown = [], 0
        for line in text.splitlines():
            stamp, severity, logger = _parse_line_timestamp(line), _extract_level(line), _extract_logger_name(line)
            at = stamp.timestamp() * 1000 if stamp else None
            if at is None or severity is None or logger is None:
                unknown += 1
            if service == 'gateway' or not in_window(at) or level is not None and (severity is None or _LEVEL_ORDER[severity] < _LEVEL_ORDER[level]) or search.lower() not in line.lower():
                continue
            records.append({'at': at, 'level': severity, 'logger': logger, 'service': 'hermes', 'message': line})
        return {'source': source, 'records': records[-limit:],
                'metadata_unknown': unknown, 'truncated': truncated or len(records) > limit, 'scope': 'Filtered retained tail; missing metadata is unknown'}
    if source == 'errands':
        spool = os.environ.get('PAIOS_ERRAND_SPOOL', '/var/lib/paios/state/errands')
        records, scanned, truncated = [], 0, False
        try:
            entries = os.scandir(spool)
        except FileNotFoundError:
            return {'source': source, 'status': 'unavailable'}
        with entries:
            for entry in entries:
                scanned += 1
                if scanned > 1000 or len(records) >= limit:
                    truncated = True
                    break
                match = re.fullmatch(r'job-[0-9a-f]{12}\.(running|request|done|notified|delivered|delivery-failed|invalid|parked)\.json', entry.name)
                if not match:
                    continue
                text, cut = tail(entry.path)
                if cut:
                    raise ValueError('SELF_ERRAND_RECORD_TOO_LARGE')
                try:
                    value = json.loads(text)
                except json.JSONDecodeError:
                    records.append({'state': match[1], 'status': 'unreadable_owner_unknown'})
                    continue
                if value.get('principal_id') != principal:
                    continue
                stamp = value.get('finished_at', value.get('started_at'))
                at = datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() * 1000 if stamp else None
                if not in_window(at):
                    continue
                keys = ('job_id', 'state', 'title', 'app', 'tier', 'started_at', 'finished_at', 'step', 'max_steps', 'success', 'terminal_reason', 'self_check_of', 'report_absorbed', 'delivery_failure', 'trace', 'execution', 'delivery', 'task_retry_allowed')
                record = {'spool_state': match[1], **scrub_value({k: value[k] for k in keys if k in value})}
                if search.casefold() not in json.dumps(record, ensure_ascii=False).casefold():
                    continue
                records.append(record)
                if len(json.dumps(records).encode()) > 65536:
                    records.pop(); truncated = True; break
        return {'source': 'executor retained spool', 'records': records, 'truncated': truncated,
                'scope': 'Retained owner records; trace is producer-supplied, absent for legacy jobs'}
    if source == 'resources':
        return resources()
    if source == 'release':
        spool = os.environ.get('PAIOS_RELEASE_SPOOL')
        if not spool:
            return {'source': source, 'status': 'unavailable'}
        request_id = args.get('request_id')
        if request_id is not None and not re.fullmatch(r'(rollback-)?[0-9a-f]{12}', request_id):
            raise ValueError('SELF_RELEASE_REQUEST_INVALID')
        folder = Path(spool) / 'status'
        runtime = None
        try:
            text, cut = tail(folder / 'runtime.json')
            if cut:
                raise ValueError('SELF_RELEASE_RUNTIME_TOO_LARGE')
            value = json.loads(text)
            runtime = {k: value[k] for k in ('current', 'previous', 'recent', 'health', 'updated_at', 'requests', 'builder_requests') if k in value}
            if runtime.get('builder_requests') is not None:
                runtime['builder_requests'] = [r for r in runtime['builder_requests'] if r.get('principal_id') == principal][:limit]
            for key in ('recent', 'requests'):
                if key in runtime:
                    runtime[key] = runtime[key][:limit]
            runtime = scrub_value(runtime)
        except FileNotFoundError:
            pass
        rows = []
        if request_id:
            text, cut = tail(folder / (request_id + '.json'))
            if cut:
                raise ValueError('SELF_RELEASE_RECORD_TOO_LARGE')
            value = json.loads(text)
            stamp = value.get('updated_at', value.get('finished_at'))
            at = datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() * 1000 if isinstance(stamp, str) else stamp * 1000 if stamp is not None else None
            keys = ('request_id', 'state', 'steps', 'commit', 'base', 'ready_for_production', 'summary',
                    'updated_at', 'finished_at', 'reason', 'failure', 'from', 'to', 'undone')
            if in_window(at):
                rows = [scrub_value({k: value[k] for k in keys if k in value})]
        pending = [p.stem for p in islice((p for p in (Path(spool) / 'rollback').glob('*.json')
                   if re.fullmatch(r'[0-9a-f]{12}\.json', p.name)), limit + 1)]
        # Only the selected rollback receipt describes its outcome. A spool file
        # is consumer input; its presence does not prove a blocker or an effect.
        rollback_receipt = rows[0] if request_id and request_id.startswith('rollback-') and rows else {}
        facts = {'runtime_status_scope': 'runtime_projection_publication',
                 'current_version': 'observed' if runtime is not None and runtime.get('current') is not None else 'unknown',
                 'previous_version': 'observed' if runtime is not None and runtime.get('previous') is not None else 'unknown',
                 'rollback_effect': 'recorded_done' if rollback_receipt.get('state') == 'done' else 'unknown',
                 'rollback_blocking_reason': rollback_receipt.get('reason', 'unknown'),
                 'pending_rollback_requests_scope': 'request_files_only',
                 'pending_queue_clear_required': False}
        return {'source': 'production release spool/status', 'records': rows, 'truncated': len(pending) > limit,
                'runtime': runtime, 'runtime_status': 'published' if runtime is not None else 'not_published',
                'pending_rollback_requests': pending[:limit], 'observation_facts': facts,
                'scope': 'Runtime projection publication, observed pointers and selected receipts; missing pointers and rollback effects are unknown. Pending files are consumer input, not blockers. Null builder_requests means exchange not yet published'}
