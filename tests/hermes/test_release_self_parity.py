"""Release baseline consent and host failure handoff use the existing request and notice spool."""
import json
from pathlib import Path
import sys
import pytest

sys.path.insert(0, str(Path(__file__).parent))
from test_release import release, release_source, release_build, git, repo
from test_release_ship import Production

ORIGIN = {'kind': 'system_selfcheck', 'principal_id': 'real-owner', 'device_id': 'real-phone',
          'origin_processed_event_id': 'event-original'}


def test_runtime_projection_publishes_own_container_health_without_docker_credentials(tmp_path, monkeypatch, repo):
    prod = Production(tmp_path, monkeypatch, repo)
    state = {'Running': True, 'OOMKilled': False, 'Status': 'running', 'Health': {'Status': 'healthy'}}
    rows = [{'Config': {'Labels': {'com.docker.compose.service': name}, 'Env': ['TOKEN=never-publish']},
             'State': state, 'RestartCount': 2} for name in ('gateway', 'hermes', 'postgres')]
    monkeypatch.setattr(release.release_checks, 'containers', lambda run: rows)
    release.publish_runtime(prod.host)
    value = prod.status('runtime')
    assert set(value['health']) == {'gateway', 'hermes'}
    assert value['health']['hermes'] == {'running': True, 'status': 'running', 'oom_killed': False,
                                        'health': 'healthy', 'restarts': 2}
    assert 'never-publish' not in json.dumps(value)


def test_nonbaseline_executor_and_persona_can_ship(repo):
    paths = ['integrations/connectors/phone_executor/models.json', release_source.H + 'persona/yimi.md',
             release_source.H + 'shared-skills/engineering-handbook/SKILL.md', release_source.H + 'workshop.py']
    for path in paths:
        target = repo.work / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('最根本的一条：自己学习。\n\nordinary persona\n' if 'persona' in path else 'ordinary\n')
    git(repo.work, 'add', '.')
    git(repo.work, 'commit', '-qm', 'establish persona')
    base = git(repo.work, 'rev-parse', 'HEAD')
    for path in paths:
        with (repo.work / path).open('a') as output:
            output.write('changed ordinary text\n')
    git(repo.work, 'commit', '-qam', 'ordinary improvements')
    assert release_source.protected_changes(repo.work, base, 'HEAD') == []
    (repo.work / paths[1]).write_text('最根本的一条：stop learning。\n\nordinary persona\n')
    git(repo.work, 'commit', '-qam', 'change baseline')
    assert release_source.protected_changes(repo.work, base, 'HEAD') == [paths[1]]


def test_executor_budget_is_open_but_switching_its_model_requires_owner(repo):
    path = 'integrations/connectors/phone_executor/mobilerun-config.example.yaml'
    target = repo.work / path
    target.parent.mkdir(parents=True)
    before = 'llm_profiles:\n  thorough:\n    provider: OpenAILike\n    model: same-model\n    base_url: https://same.invalid\n    kwargs: {thinking_budget: 1024}\n'
    target.write_text(before)
    git(repo.work, 'add', str(target));git(repo.work, 'commit', '-qm', 'model selection')
    base = git(repo.work, 'rev-parse', 'HEAD')
    target.write_text(before.replace('1024', '768'));git(repo.work, 'commit', '-qam', 'reasoning budget')
    assert release_source.protected_changes(repo.work, base, 'HEAD') == []
    target.write_text(before.replace('same-model', 'different-model'));git(repo.work, 'commit', '-qam', 'model switch')
    assert release_source.protected_changes(repo.work, base, 'HEAD') == [path]


@pytest.mark.parametrize('baseline_path', ['integrations/connectors/phone_executor/payment_guard.py',
                                        release_source.I + 'effect-consent.ts'])
def test_baseline_candidate_waits_for_bound_owner_decision_before_build(tmp_path, repo, monkeypatch, baseline_path):
    guard = repo.work / baseline_path
    guard.parent.mkdir(parents=True)
    guard.write_text('def payment_guard(): return "guarded"\n')
    git(repo.work, 'add', str(guard))
    git(repo.work, 'commit', '-qam', 'baseline change')
    request = tmp_path / 'requests/0123456789ab'
    request.mkdir(parents=True)
    release_build.write(request / 'request.json', {'request_id': request.name, 'base': repo.base, 'origin': ORIGIN})
    (request / 'candidate.patch').write_text(git(repo.work, 'format-patch', '--stdout', repo.base + '..HEAD'))
    host = release.Host({'stage': 'staging', 'root': str(tmp_path), 'repo': str(repo.bare),
                         'exchange': str(tmp_path / 'exchange')})
    host.state = tmp_path
    (tmp_path / 'exchange').mkdir()
    release_build.write(tmp_path / 'exchange/production.json', {'commit': repo.base})
    monkeypatch.setattr(release.release_parity, 'ensure', lambda selected, lock: {'commit': repo.base})
    monkeypatch.setattr(release_build, 'build', lambda *a: pytest.fail('unapproved baseline must not execute'))
    result = release.candidate(host, request)
    assert result['state'] == 'awaiting_owner' and 'finished_at' not in result
    assert not (tmp_path / 'releases').exists()
    notice = json.loads(next((tmp_path / 'exchange/notices').glob('*.json')).read_text())
    assert notice['principal_id'] == ORIGIN['principal_id']
    assert notice['system_event']['origin_processed_event_id'] == ORIGIN['origin_processed_event_id']
    decisions = tmp_path / 'exchange/decisions'
    decisions.mkdir()
    release_build.write(decisions / (request.name + '.json'), {'request_id': request.name, 'base': repo.base,
                                                              'commit': result['commit'], 'approved': False})
    assert release.candidate(host, request)['state'] == 'refused'


def test_switch_failure_queues_one_logical_task_failure_with_original_owner(tmp_path, monkeypatch, repo):
    prod = Production(tmp_path, monkeypatch, repo)
    manifest = json.loads((prod.package / 'manifest.json').read_text())
    manifest['origin'] = ORIGIN
    release_build.write(prod.package / 'manifest.json', manifest)
    monkeypatch.setattr(release, 'switch', lambda *a: (_ for _ in ()).throw(RuntimeError('fixture failure')))
    assert prod.ship() == 'switch_failed'
    messages = list((prod.host.state / 'notices').glob('task-failure-*.json'))
    assert len(messages) == 1
    body = json.loads(messages[0].read_text())
    assert body['principal_id'] == ORIGIN['principal_id']
    event = body['system_event']
    assert event['type'] == 'task_failure' and event['origin_processed_event_id'] == 'event-original'
    assert event['failure']['terminal_reason'] == 'failed'
    assert event['failure']['evidence_ref'] == {'tool': 'skills_hub', 'action': 'release_status', 'request_id': '0123456789ab'}


@pytest.mark.parametrize('failed_step', ['build', 'suites', 'staging', 'transfer', None])
def test_host_failures_return_to_original_main_and_accepted_baseline_resumes_same_candidate(tmp_path, repo, monkeypatch, failed_step):
    from watchdog_platform import point
    path = repo.work / 'integrations/connectors/phone_executor/payment_guard.py'
    path.parent.mkdir(parents=True)
    path.write_text('def payment_guard(): return "guarded"\n')
    git(repo.work, 'add', str(path))
    git(repo.work, 'commit', '-qam', 'baseline repair')
    request = tmp_path / 'requests/0123456789ab'
    request.mkdir(parents=True)
    spec = {'request_id': request.name, 'base': repo.base, 'origin': ORIGIN,
            'captured_at': '2026-10-21T10:00:00.000Z', 'description': 'A repair requiring owner baseline consent'}
    release_build.write(request / 'request.json', spec)
    (request / 'candidate.patch').write_text(git(repo.work, 'format-patch', '--stdout', repo.base + '..HEAD'))
    old, _ = release_source.materialize(repo.bare, repo.base, repo.releases)
    point(tmp_path, 'current', old)
    host = release.Host({'stage': 'staging', 'root': str(tmp_path), 'repo': str(repo.bare),
                         'exchange': str(tmp_path / 'exchange')})
    host.state = tmp_path
    (tmp_path / 'exchange').mkdir()
    release_build.write(tmp_path / 'exchange/production.json', {'commit': repo.base})
    monkeypatch.setattr(release.release_parity, 'ensure', lambda selected, lock: {'commit': repo.base})
    first = release.candidate(host, request)
    decisions = tmp_path / 'exchange/decisions'
    decisions.mkdir()
    release_build.write(decisions / (request.name + '.json'), {'request_id': request.name, 'base': repo.base,
                                                              'commit': first['commit'], 'approved': True})
    seen = []
    def step(name, value):
        seen.append(name)
        if name == failed_step:
            raise RuntimeError('token=fixture-secret-must-not-leak')
        return value
    monkeypatch.setattr(host, 'model_source', lambda: 'fixture-models')
    monkeypatch.setattr(release_build, 'build', lambda config, target: step('build', {}))
    monkeypatch.setattr(release_build, 'suites', lambda *a, **k: step('suites', {'passed': True, 'suites': {}}))
    monkeypatch.setattr(release, 'stage', lambda *a: step('staging', {}))
    monkeypatch.setattr(release.release_transfer, 'export', lambda *a: step('transfer', {}))
    if failed_step is None:
        result = release.candidate(host, request)
        assert result['state'] == 'accepted' and result['ready_for_production'] and result['finished_at']
        assert result['commit'] == first['commit'] and result['owner_decision']['approved']
        assert seen == ['build', 'suites', 'staging', 'transfer']
        assert not list((tmp_path / 'exchange/notices').glob('task-failure-*.json'))
        return
    with pytest.raises(RuntimeError, match='fixture-secret'):
        release.candidate(host, request)
    result = json.loads((request / 'result.json').read_text())
    assert result['commit'] == first['commit'] and result['owner_decision']['approved']
    notices = list((tmp_path / 'exchange/notices').glob('task-failure-*.json'))
    assert len(notices) == 1
    body = json.loads(notices[0].read_text())
    assert 'fixture-secret' not in notices[0].read_text()
    assert body['captured_at'] == spec['captured_at']
    assert body['system_event']['failure']['answer'] == failed_step + ': RuntimeError'
    assert len(body['system_event']['failure']['title']) <= 40
    assert release.candidate(host, request) == result


def test_imported_approval_notice_is_queued_once_and_owner_decision_is_bound(tmp_path, monkeypatch, repo):
    import release_notice
    prod = Production(tmp_path, monkeypatch, repo)
    incoming = tmp_path / 'incoming/notices'
    incoming.mkdir()
    spec = {'request_id': '0123456789ab', 'origin': ORIGIN}
    body = release_notice.body(spec, 'release-approval-required', '确认基线', base=repo.base,
                               commit=prod.commit, paths=['deploy/cloud/build.sh'])
    release_build.write(incoming / 'release-approval-required-0123456789ab.json', body)
    release.set_status(prod.host, spec['request_id'], state='queued')
    release.import_request_notices(prod.host)
    assert prod.status()['state'] == 'awaiting_owner'
    release.deliver_notices(prod.host)
    release.import_request_notices(prod.host)
    assert len(prod.delivered) == 1 and not list((prod.host.state / 'notices').glob('*.json'))
    decisions = prod.spool / 'decisions'
    decisions.mkdir()
    release_build.write(decisions / '0123456789ab.json', {'request_id': '0123456789ab', 'base': repo.base,
                                                        'commit': 'f' * 40, 'approved': True})
    with pytest.raises(ValueError, match='CANDIDATE_MISMATCH'):
        release.owner_decision(decisions, '0123456789ab', repo.base, prod.commit)


def test_rollback_and_watchdog_failures_reuse_same_task_failure_id(tmp_path, monkeypatch, repo):
    from watchdog_platform import Platform
    prod = Production(tmp_path, monkeypatch, repo)
    manifest = json.loads((prod.package / 'manifest.json').read_text())
    manifest.update(origin=ORIGIN, captured_at='2026-10-21T10:00:00.000Z')
    release_build.write(prod.package / 'manifest.json', manifest)
    assert prod.ship() == 'switched'
    (prod.spool / 'rollback/aaaaaaaaaaaa.json').write_text('{}')
    monkeypatch.setattr(release, 'rollback', lambda *a: (_ for _ in ()).throw(RuntimeError('fixture')))
    with pytest.raises(RuntimeError):
        release.rollback_requests(prod.host)
    path = prod.host.state / 'notices/task-failure-0123456789ab.json'
    original = json.loads(path.read_text())
    platform = Platform(prod.host.state)
    record = {'release_id': 'r1', 'candidate_release': str(prod.host.release('current'))}
    platform.save(record, {'phase': 'verifying'})
    assert json.loads(path.read_text()) == original
    path.unlink()
    platform.save(record, {'phase': 'failed'})
    replay = json.loads(path.read_text())
    assert replay['id'] == original['id'] and replay['captured_at'] == original['captured_at']


def test_native_release_confirmation_asks_once_and_persists_actual_owner_choice(tmp_path, monkeypatch):
    sys.path.insert(0, str(Path(__file__).parents[2] / 'integrations/hermes'))
    from personal_aios.release_consent import release_decide
    import gateway.run_scope as scope
    import tools.approval as approval
    import tools.approval_gateway_wait as wait
    status = tmp_path / 'status/0123456789ab.json'
    status.parent.mkdir()
    release_build.write(status, {'state': 'awaiting_owner', 'base': 'b' * 40, 'commit': 'c' * 40,
                                'protected_paths': ['deploy/cloud/release.py'], 'origin': ORIGIN})
    monkeypatch.setattr(scope, 'current_scope', lambda: 'owner')
    monkeypatch.setattr(approval, '_gateway_notify_cb', lambda key: lambda value: None)
    questions = []
    def answer(key, notify, question):
        questions.append(question)
        return {'resolved': True, 'choice': 'once', 'confirmation': {
            'confirmation_id': 'native-card-1', 'confirmed_by': ORIGIN['principal_id'],
            'surface': {'device_id': 'owner-phone', 'device_type': 'phone'},
            'confirmed_at': '2026-10-22T00:00:00.000Z'}}
    monkeypatch.setattr(wait, '_await_gateway_decision', answer)
    from types import SimpleNamespace
    import gateway.session_context as session_context
    import tools.approval_context as approval_context
    monkeypatch.setattr(session_context, 'get_api_run_id', lambda sid: 'run-original')
    token = approval_context._approval_tool_call_id.set('confirm-call')
    provider = SimpleNamespace(_request=lambda *a: {'allow_owner_mutation': True, 'principal_id': ORIGIN['principal_id']})
    first = release_decide(tmp_path, '0123456789ab', provider, 'session-original')
    assert first['approved'] is True and first['principal_id'] == ORIGIN['principal_id']
    assert first['confirmed_by'] == ORIGIN['principal_id']
    assert first['surface'] == {'device_id': 'owner-phone', 'device_type': 'phone'}
    assert first['confirmed_at'] == '2026-10-22T00:00:00.000Z'
    assert first['confirmation_id'] == 'native-card-1'
    assert release_decide(tmp_path, '0123456789ab', provider, 'session-original') == {
        **first, 'reused': True, 'lifecycle': 'saved_decision_replay'} and len(questions) == 1
    rebased = {**json.loads(status.read_text()), 'base': 'd' * 40, 'commit': 'e' * 40}
    release_build.write(status, rebased)
    second = release_decide(tmp_path, '0123456789ab', provider, 'session-original')
    assert second['commit'] == rebased['commit'] and not second['reused'] and len(questions) == 2
    assert (tmp_path / ('decisions/0123456789ab-' + first['commit'] + '.json')).exists()
    provider._request = lambda *a: {'allow_owner_mutation': True, 'principal_id': 'different-owner'}
    with pytest.raises(ValueError, match='RELEASE_OWNER_MISMATCH'):
        release_decide(tmp_path, '0123456789ab', provider, 'session-original')
    assert questions[0]['allow_session'] is False and questions[0]['allow_permanent'] is False
    provider._request = lambda *a: {'allow_owner_mutation': True, 'principal_id': ORIGIN['principal_id']}
    (tmp_path / 'decisions/0123456789ab.json').unlink()
    for choice in ('once', 'deny'):
        monkeypatch.setattr(wait, '_await_gateway_decision', lambda *a: {'resolved': True, 'choice': choice})
        with pytest.raises(ValueError, match='RELEASE_CONFIRMATION_RECEIPT_REQUIRED'):
            release_decide(tmp_path, '0123456789ab', provider, 'session-original')
    assert not (tmp_path / 'decisions/0123456789ab.json').exists()
    approval_context._approval_tool_call_id.reset(token)


def test_native_ordinary_patch_and_lock_metadata_do_not_require_owner_baseline_consent(repo):
    patch = repo.work / release_source.H / 'native-context.patch'
    lock = repo.work / release_source.H / 'producer.lock.json'
    patch.parent.mkdir(parents=True, exist_ok=True)
    baseline = 'diff --git a/gateway/run_scope.py b/gateway/run_scope.py\n--- a/gateway/run_scope.py\n+++ b/gateway/run_scope.py\n@@ -1 +1 @@\n-old boundary\n+owner boundary\n'
    patch.write_text(baseline)
    release_build.write(lock, {'upstream': {'commit': 'b' * 40}, 'patch': {'path': 'native-context.patch'}, 'result_tree': 'old'})
    git(repo.work, 'add', '.')
    git(repo.work, 'commit', '-qm', 'native baseline')
    base = git(repo.work, 'rev-parse', 'HEAD')
    patch.write_text(baseline + 'diff --git a/agent/prompt_builder.py b/agent/prompt_builder.py\n@@ -1 +1 @@\n-old prompt\n+new prompt\n')
    release_build.write(lock, {'upstream': {'commit': 'b' * 40}, 'patch': {'path': 'native-context.patch'}, 'result_tree': 'new'})
    git(repo.work, 'commit', '-qam', 'ordinary native feature')
    assert release_source.protected_changes(repo.work, base, 'HEAD') == []
    patch.write_text(patch.read_text().replace('+owner boundary', '+changed owner boundary'))
    git(repo.work, 'commit', '-qam', 'native authority change')
    assert release_source.protected_changes(repo.work, base, 'HEAD') == ['native:gateway/run_scope.py']


def test_production_ignores_candidate_claimed_consent_and_ships_only_bound_owner_yes(tmp_path, monkeypatch, repo):
    prod = Production(tmp_path, monkeypatch, repo, change='deploy/cloud/build.sh')
    manifest = json.loads((prod.package / 'manifest.json').read_text())
    manifest.update(origin=ORIGIN, owner_decision={'approved': True})
    release_build.write(prod.package / 'manifest.json', manifest)
    assert prod.ship() == 'awaiting_owner'
    assert prod.pointers() == ('old', None) and prod.package.exists()
    assert len(list((prod.host.state / 'notices').glob('release-approval-required-*.json'))) == 1
    decisions = prod.spool / 'decisions'
    decisions.mkdir()
    release_build.write(decisions / '0123456789ab.json', {'request_id': '0123456789ab', 'base': repo.base,
                                                        'commit': prod.commit, 'approved': True})
    prod.idle = False
    assert prod.ship() == 'waiting_idle'
    prod.idle = True
    assert prod.ship() == 'switched'
