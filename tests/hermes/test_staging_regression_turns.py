"""Regression adapters must execute the canonical client and reject incomplete evidence."""
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / 'deploy/cloud/staging'))
import regression_turns as turns


def configuration():
    paired = {'pairing': '/stage-private/resources/iphone-pairing.v1.json',
              'recipient_key': '/stage-private/recipient.jwk'}
    return {'turns': {'chat': paired, 'call': paired, 'speech': '/stage-private/speech.wav',
                      'bootstrap': {'root': '/stage-private', 'registration': '/stage-private/registration.json'}}}


def stack(output, *, stage=True):
    calls = []
    def run(args, **kw):
        calls.append((args, kw))
        value = output(args) if callable(output) else output
        return SimpleNamespace(stdout=json.dumps(value), stderr="", returncode=0)
    result = SimpleNamespace(stage=stage, definition={'services': {name + '-staging': {
        'environment': {'PAIOS_STAGE': 'staging'}} for name in ('gateway', 'hermes')}}, run=run)
    return result, calls


def receipt(kind):
    steps = [{'step': name, 'http': 200, 'status': expected} for name, expected in [
        ('bootstrap', 'bootstrap_accepted'), ('e2ee_key_resolve', 'key_resolved'),
        ('credential_refresh', 'credential_refreshed'), ('end_continuity', 'success')]]
    steps += [{'step': 'prompt_playback', 'status': 'rendered', 'event_id': 'event',
               'processed_event_id': 'processed', 'run_id': 'run'}] if kind == 'chat' else [
        {'step': 'speech_playback', 'status': 'played', 'sent_samples': 16000, 'audible_samples': 100},
        {'step': 'call', 'status': 'closed', 'call_id': 'call', 'turns': [1]}]
    return {'steps': steps}


def test_stage_guard_prevents_every_command():
    target, calls = stack({}, stage=False)
    with pytest.raises(ValueError, match='staging Stack'):
        turns.bootstrap(target, configuration())
    assert calls == []
    target.stage = True
    target.definition['services']['gateway-staging']['environment']['PAIOS_STAGE'] = 'production'
    with pytest.raises(ValueError, match='service guard'):
        turns.bootstrap(target, configuration())
    assert calls == []


def test_bootstrap_reuses_ledgered_migrator_and_pair_authority():
    target, calls = stack({'status': 'paired', 'device_id': 'device', 'pairing_file': '/stage-private/resources/iphone-pairing.v1.json'})
    result = turns.bootstrap(target, configuration())
    assert result['status'] == 'paired'
    commands = [args for args, _ in calls]
    assert all(command[2] == 'gateway-staging' and turns.GUARD in command for command in commands)
    assert 'migrate' in commands[0] and 'pair' in commands[1]
    assert all(turns.G + '/tools/mac-product-provision.ts' in command for command in commands)
    assert '--registration' in commands[1]


@pytest.mark.parametrize('kind', ['chat', 'call'])
def test_actual_canonical_client_command_and_private_evidence(tmp_path, kind):
    target, calls = stack(receipt(kind))
    value = turns.client(target, configuration(), kind, tmp_path)
    command, options = calls[0]
    assert turns.G + '/tools/mac-product-sim-client.ts' in command
    assert '--regression-evidence' in command
    if kind == 'call':
        # The dial call's unverified fixture speech is confirmed by the paired phone, as the owner would with Face ID.
        assert command[-5:] == ['--call', '--speech', '/stage-private/speech.wav', '--confirmation', 'approve']
        assert value['status'] == 'closed'
    else:
        assert '--prompt' in command
        assert value['processed_event_id'] == 'processed'
    assert options['timeout'] == 360
    evidence = tmp_path / (kind + '.client.json')
    assert json.loads(evidence.read_text()) == receipt(kind)
    assert evidence.stat().st_mode & 0o077 == 0


def test_closed_without_recorded_reply_fails(tmp_path):
    body = receipt('call')
    body['steps'] = [s for s in body['steps'] if s['step'] != 'speech_playback']
    target, _ = stack(body)
    with pytest.raises(ValueError, match='not played'):
        turns.client(target, configuration(), 'call', tmp_path)


def test_wrong_lifecycle_status_fails(tmp_path):
    body = receipt('chat')
    body['steps'][0]['http'] = 403
    target, _ = stack(body)
    with pytest.raises(ValueError, match='bootstrap'):
        turns.client(target, configuration(), 'chat', tmp_path)


def test_canonical_query_and_native_front_mirror_both_required():
    def output(args):
        return {'verified': [{'route': 'front_only', 'processed_event_id': 'd'}]} if args[2] == 'gateway-staging' else {'native_front_turns': 1}
    target, calls = stack(output)
    result = turns.persisted(target, 'call', {'call_id': 'real-call', 'turns': [1]})
    assert result['native_front_turns'] == 1
    assert calls[0][0][2] == 'gateway-staging'
    assert turns.VERIFY in calls[0][0]
    assert calls[1][0][2] == 'hermes-staging'
    assert turns.NATIVE in calls[1][0]


def test_failed_client_never_passes_timeline_or_settlement(tmp_path):
    target, calls = stack(lambda args: (_ for _ in ()).throw(subprocess.CalledProcessError(1, args)))
    checks = []
    def record(name, action):
        checks.append(name)
        try:
            return action()
        except subprocess.CalledProcessError:
            return None
    assert turns.run(target, configuration(), tmp_path, record) == {}
    assert checks == ['chat.accepted', 'call.playback']
    assert len(calls) == 2


def test_reject_relative_or_parent_fixture_paths():
    for path in ['private/pairing.json', '/private/../production/pairing.json']:
        with pytest.raises(ValueError, match='absolute'):
            turns.path(path)


@pytest.mark.parametrize('name', ['payment', 'message', 'phone_task', 'ride', 'login', 'email', 'watch'])
def test_effect_prompts_use_the_same_paired_client(tmp_path, name):
    body = receipt('chat')
    body['steps'].append({'step': 'native_approval', 'confirmation_id': 'confirmation', 'choice': 'approve'})
    target, calls = stack(body)
    confirmation = 'approve' if name not in ('payment', 'watch') else None
    result = turns.client(target, configuration(), name, tmp_path, prompt='fixture ' + name, confirmation=confirmation)
    command = calls[0][0]
    assert command[2] == 'gateway-staging'
    assert command[command.index('--prompt') + 1] == 'fixture ' + name
    assert ('--confirmation' in command) == (confirmation is not None)
    assert result['approvals'] == [body['steps'][-1]]
    assert (tmp_path / (name + '.client.json')).exists()


def test_nonzero_client_keeps_real_run_binding_and_complete_streams(tmp_path):
    body = {'steps': [{'step': 'playback', 'status': 'failed', 'event_id': 'fixture-event',
                       'processed_event_id': 'd:fixture', 'run_id': 'run_' + 'b' * 32}]}
    raw = json.dumps(body) + '\n'
    target, _ = stack(lambda args: (_ for _ in ()).throw(
        subprocess.CalledProcessError(1, args, output=raw, stderr='full playback failure\n')))
    with pytest.raises(subprocess.CalledProcessError):
        turns.client(target, configuration(), 'message', tmp_path)
    assert json.loads((tmp_path / 'message.client.json').read_text()) == body
    assert (tmp_path / 'message.client.stdout').read_text() == raw
    assert (tmp_path / 'message.client.stderr').read_text() == 'full playback failure\n'
    assert json.loads((tmp_path / 'message.client.status.json').read_text())['exit_code'] == 1


def test_canonical_verifier_executes_handoff_lineage_and_original_routes(tmp_path):
    source = tmp_path / 'canonical-verifier.mjs'
    source.write_text(turns.VERIFY)
    fixture = Path(__file__).with_name('staging-call-verifier.mjs')
    result = subprocess.run(['node', '--experimental-vm-modules', str(fixture), str(source)],
                            capture_output=True, text=True)
    print(result.stdout, end='')
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize('failure', ['verify', 'native'])
def test_configured_settlement_keeps_original_failure_streams(tmp_path, failure):
    def output(args):
        if turns.G + '/tools/mac-product-sim-client.ts' in args:
            return receipt('call' if '--call' in args else 'chat')
        if turns.VERIFY in args:
            if args[-2] == 'call' and failure == 'verify':
                raise subprocess.CalledProcessError(1, args, output='original verifier stdout\n',
                                                    stderr='full original verifier error\nNode.js v24.19.0\n')
            return {'verified': [{'route': 'front_only', 'processed_event_id': 'd'}]}
        raise subprocess.CalledProcessError(1, args, output='original native stdout\n', stderr='full native error\n')
    target, _ = stack(output)
    checks = {}
    def record(name, action):
        try:
            value = action(); checks[name] = 'passed'; return value
        except subprocess.CalledProcessError:
            checks[name] = 'failed'
    turns.run(target, configuration(), tmp_path, record)
    assert checks['call.playback'] == 'passed' and checks['call.closed'] == 'passed'
    assert checks['call.settlement'] == 'failed'
    prefix = 'call.settlement' + ('.native' if failure == 'native' else '')
    expected = 'full native error\n' if failure == 'native' else 'full original verifier error\nNode.js v24.19.0\n'
    assert (tmp_path / (prefix + '.stderr')).read_text() == expected
    assert (tmp_path / (prefix + '.stdout')).read_text().startswith('original ')
    assert json.loads((tmp_path / (prefix + '.status.json')).read_text())['exit_code'] == 1
