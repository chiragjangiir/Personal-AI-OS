"""Failed synthetic effects retain their current run and raw native evidence."""
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / 'deploy/cloud/staging'))
import regression_effects as effects
import regression_turns as turns


@pytest.mark.parametrize('failure', ['approval', 'check', 'client'])
def test_effect_failure_still_collects_current_recursive_trace_and_approvals(tmp_path, monkeypatch, failure):
    run = 'run_' + 'a' * 32
    rows, commands = [], []
    receipt = {'run_id': run, 'approvals': []}
    def command(args, **options):
        commands.append(args)
        if 'gateway-staging' in args:
            value = {'run_id': run, 'records': [{'record': {'native_run_id': run}}]}
        elif args[-2] == '--prepare':
            value = {'prompt': 'synthetic', 'mark': 41}
        elif args[-2] == '--collect':
            assert json.loads(options['input'])['receipt']['run_id'] == run
            value = {'run': {'run_id': run}, 'sessions': ['root', 'child'],
                     'trace': {'messages': [{'content': 'complete native result'}], 'tools': []}}
        else:
            assert args[-2] == '--check'
            if failure == 'check':
                raise subprocess.CalledProcessError(3, args, output='full helper output\n', stderr='classification mismatch\n')
            value = {'run_id': run}
        return SimpleNamespace(stdout=json.dumps(value), stderr='complete stderr\n', returncode=0)
    stack = SimpleNamespace(stage=True, definition={'services': {name + '-staging': {
        'environment': {'PAIOS_STAGE': 'staging'}} for name in ('gateway', 'hermes')}}, run=command)
    def submit(*args, **kwargs):
        if failure == 'client':
            (tmp_path / 'message.client.json').write_text(json.dumps({'steps': [
                {'step': 'playback', 'status': 'failed', 'run_id': run}]}))
            raise subprocess.CalledProcessError(1, ['sim'], output='client failed', stderr='timeout')
        return receipt
    def record(name, action):
        if name == 'watch':
            return None
        try:
            rows.append((name, 'passed', action()))
        except (ValueError, subprocess.SubprocessError) as error:
            rows.append((name, 'failed', str(error)))
    monkeypatch.setattr(effects, 'EFFECTS', ('message',))
    monkeypatch.setattr(turns, 'client', submit)
    monkeypatch.setattr(turns, 'persisted', lambda *a, **k: {
        'verified': [{'session_id': 'conversation'}], 'approvals': [] if failure == 'approval' else [{}]})
    effects.run(stack, {'effects': {'script': '/stage-kit/regression_effects.py'}}, tmp_path, record)
    assert next(row for row in rows if row[0] == 'effects.message')[1] == 'failed'
    assert next(row for row in rows if row[0] == 'effects.message.trace')[1] == 'passed'
    assert next(row for row in rows if row[0] == 'effects.message.approvals')[1] == 'passed'
    trace = json.loads((tmp_path / 'message.trace.json').read_text())
    assert trace['sessions'] == ['root', 'child']
    assert trace['trace']['messages'][0]['content'] == 'complete native result'
    if failure == 'check':
        assert (tmp_path / 'message.helper.stdout').read_text() == 'full helper output\n'
        assert (tmp_path / 'message.helper.stderr').read_text() == 'classification mismatch\n'
        assert json.loads((tmp_path / 'message.helper.status.json').read_text())['exit_code'] == 3


@pytest.mark.parametrize('error', [subprocess.CalledProcessError(9, ['helper'], output='all stdout\n', stderr='all stderr\n'),
                                 subprocess.TimeoutExpired(['helper'], 1, output=b'all stdout\n', stderr=b'all stderr\n')])
def test_capture_retains_full_failed_and_timeout_streams_before_raise(tmp_path, error):
    def fail(*args, **kwargs):
        raise error
    with pytest.raises(type(error)):
        turns.captured(SimpleNamespace(run=fail), ['helper'], tmp_path / 'capture')
    assert (tmp_path / 'capture.stdout').read_bytes() == b'all stdout\n'
    assert (tmp_path / 'capture.stderr').read_bytes() == b'all stderr\n'
    assert json.loads((tmp_path / 'capture.status.json').read_text())['error_type'] == type(error).__name__
