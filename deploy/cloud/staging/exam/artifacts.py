"""Collect an Office fixture only from its native task's observed offline output scope."""
import json
from pathlib import Path
import re
import shutil


def collect(evidence, workshop_root, destination):
    destination = Path(destination)
    root = Path(workshop_root).resolve(strict=True)
    candidates = {}
    for call in evidence['tools']:
        if call['tool'] != 'terminal':
            continue
        first_command = call['args'].get('command', '').split(';', 1)[0].strip()
        if first_command not in {'echo "$OUT"', '''printf '%s\\n' "$OUT"'''}:
            continue
        if call['result'] is None:
            continue
        result = json.loads(call['result'])
        if result.get('exit_code') != 0 or result.get('error'):
            continue
        match = re.fullmatch(r'/owner/out/([0-9a-f]{32})', result['output'].partition('\n')[0])
        if not match:
            raise ValueError('Native terminal did not return an offline output scope')
        token = match.group(1)
        source = root / token / destination.name
        if not source.exists():
            continue
        if source.is_symlink() or not source.resolve().is_relative_to(root / token) or not source.is_file():
            raise ValueError('Office output must be a regular file in the observed task scope')
        candidates[token] = (source, call)
    if len(candidates) != 1:
        raise ValueError('Expected one Office output bound to this task; never select the newest file')
    source, call = next(iter(candidates.values()))
    shutil.copyfile(source, destination)
    return {'session_id': call['session_id'], 'tool_call_id': call['id'],
            'workshop_path': '/owner/out/' + source.parent.name + '/' + source.name,
            'retained_path': str(destination), 'bytes': destination.stat().st_size,
            'scope': 'offline workshop fixture; does not prove Mac or account delivery'}
