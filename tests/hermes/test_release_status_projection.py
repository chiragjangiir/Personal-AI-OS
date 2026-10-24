"""Source request outcomes reach the production receipt and native release tools."""
import json
from pathlib import Path
import shutil
from types import SimpleNamespace

import pytest

from test_release import release, release_build, release_source, git, repo
from test_release_ship import Production
from test_release_self_parity import ORIGIN


@pytest.fixture
def native_hub(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).parents[2] / 'integrations/hermes'))
    from personal_aios import workshop
    import hermes_cli.config
    import gateway.run_scope as scope
    import gateway.session_context as context
    import tools.approval as approval
    import tools.approval_gateway_wait as wait
    from tools.approval_context import _approval_tool_call_id
    monkeypatch.setattr(hermes_cli.config, 'load_config', lambda: {})
    monkeypatch.setattr(scope, 'current_scope', lambda: 'owner')
    monkeypatch.setattr(context, 'get_api_run_id', lambda session: 'owner-run')
    monkeypatch.setattr(approval, '_gateway_notify_cb', lambda key: lambda value: None)
    questions, choice, handlers = [], ['deny'], {}
    def answer(key, notify, question):
        questions.append(question)
        return {'resolved': True, 'choice': choice[0], 'confirmation': {
            'confirmation_id': 'native-release-card', 'confirmed_by': ORIGIN['principal_id'],
            'surface': {'device_id': 'owner-phone', 'device_type': 'phone'},
            'confirmed_at': '2026-10-22T00:00:00.000Z'}}
    monkeypatch.setattr(wait, '_await_gateway_decision', answer)
    monkeypatch.setattr(workshop, 'builder_request', lambda *a: pytest.fail('published result must be local'))
    provider = SimpleNamespace(_request=lambda *a: {'allow_owner_mutation': True, 'principal_id': ORIGIN['principal_id']})
    workshop.register(SimpleNamespace(register_tool=lambda name, group, schema, fn: handlers.update({name: fn})), provider)
    token = _approval_tool_call_id.set('release-confirmation')
    try:
        yield lambda action, value: json.loads(handlers['skills_hub'](
            {'action': action, 'value': value}, session_id='owner-session')), questions, choice
    finally:
        _approval_tool_call_id.reset(token)


def publish_inventory(config, prod):
    release.release_transfer.publish_requests(config)
    shutil.copyfile(Path(config['exchange']) / 'requests.json', Path(prod.host.config['incoming']) / 'requests.json')
    release.publish_runtime(prod.host)


@pytest.mark.parametrize('baseline_path', [
    'integrations/connectors/phone_executor/payment_guard.py', release_source.H + 'persona/yimi.md',
], ids=['guard-no', 'principle-no'])
def test_native_owner_no_closes_source_and_all_status_views(tmp_path, repo, monkeypatch, native_hub, baseline_path):
    prod = Production(tmp_path / 'production', monkeypatch, repo)
    monkeypatch.setenv('PAIOS_RELEASE_SPOOL', str(prod.spool))
    path = repo.work / baseline_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('最根本的一条：changed baseline。\n')
    git(repo.work, 'add', str(path))
    git(repo.work, 'commit', '-qm', 'baseline candidate')
    request = tmp_path / 'builder/requests/0123456789ab'
    request.mkdir(parents=True)
    release_build.write(request / 'request.json', {'request_id': request.name, 'base': repo.base, 'origin': ORIGIN})
    (request / 'candidate.patch').write_text(git(repo.work, 'format-patch', '--stdout', repo.base + '..HEAD'))
    host = release.Host({'root': str(tmp_path / 'builder'), 'stage': 'staging', 'repo': str(repo.bare),
                         'requests': str(request.parent), 'exchange': str(tmp_path / 'exchange')})
    host.state = tmp_path / 'builder'
    monkeypatch.setattr(release_build, 'build', lambda *a: pytest.fail('declined baseline cannot build'))
    waiting = release.candidate(host, request)
    shutil.copytree(tmp_path / 'exchange/notices', Path(prod.host.config['incoming']) / 'notices')
    release.import_request_notices(prod.host)
    hub, questions, choice = native_hub
    assert hub('release_status', request.name)['state'] == 'awaiting_owner'
    decision = hub('release_decide', request.name)
    assert decision['approved'] is False and len(questions) == 1
    shutil.copytree(prod.spool / 'decisions', tmp_path / 'exchange/decisions')
    result = release.candidate(host, request)
    assert result['state'] == 'refused' and result['commit'] == waiting['commit']
    publish_inventory(host.config, prod)
    assert prod.status()['state'] == 'refused'
    assert prod.status()['reason'] == 'OWNER_DECLINED_BASELINE_CHANGE'
    assert hub('release_status', request.name)['state'] == 'refused'
    assert prod.status('runtime')['requests'][0]['state'] == 'refused'
    from personal_aios.self_observe import observe
    record = observe({'source': 'release', 'request_id': request.name}, ORIGIN['principal_id'])['records'][0]
    assert record['state'] == 'refused' and record['reason'] == 'OWNER_DECLINED_BASELINE_CHANGE'
    choice[0] = 'once'
    with pytest.raises(ValueError, match='not awaiting owner'):
        hub('release_decide', request.name)
    assert len(questions) == 1
    release_build.write(tmp_path / 'exchange/decisions' / (request.name + '.json'), {**decision, 'approved': True})
    assert release.candidate(host, request) == result


@pytest.mark.parametrize('case', json.loads((Path(__file__).parent / 'fixtures/release_declined_status.json').read_text()),
                         ids=lambda case: case['case'])
def test_staging_declines_replay_through_normal_inventory(tmp_path, repo, monkeypatch, native_hub, case):
    prod = Production(tmp_path, monkeypatch, repo)
    monkeypatch.setenv('PAIOS_RELEASE_SPOOL', str(prod.spool))
    request_id = case['request_id']
    source = tmp_path / 'requests' / request_id
    source.mkdir(parents=True)
    release_build.write(source / 'request.json', {'request_id': request_id, 'origin': ORIGIN})
    release_build.write(source / 'result.json', case['source_result'])
    release_build.write(prod.spool / 'status' / (request_id + '.json'), case['projected_status'])
    hub, _, _ = native_hub
    assert hub('release_status', request_id)['state'] == 'awaiting_owner'
    publish_inventory({'requests': str(source.parent), 'exchange': str(tmp_path / 'exchange')}, prod)
    assert prod.status(request_id)['state'] == 'refused'
    assert hub('release_status', request_id)['reason'] == 'OWNER_DECLINED_BASELINE_CHANGE'


@pytest.mark.parametrize('state,ready', [('accepted', True), ('refused', False), ('failed', False), ('rolled_back', False)])
def test_all_finished_source_results_use_the_same_projection(tmp_path, repo, monkeypatch, state, ready):
    prod = Production(tmp_path, monkeypatch, repo)
    source = tmp_path / 'requests/0123456789ab'
    source.mkdir(parents=True)
    release_build.write(source / 'request.json', {'request_id': source.name, 'origin': ORIGIN})
    result = {'state': state, 'finished_at': '2026-10-22T19:46:52+00:00', 'ready_for_production': ready,
              'base': repo.base, 'commit': prod.commit, 'reason': 'source outcome', 'failure': 'source evidence'}
    release_build.write(source / 'result.json', result)
    release.set_status(prod.host, source.name, state='awaiting_owner')
    config = {'requests': str(source.parent), 'exchange': str(tmp_path / 'exchange')}
    publish_inventory(config, prod)
    assert all(prod.status()[key] == value for key, value in result.items())
    if ready:
        release.set_status(prod.host, source.name, state='waiting_idle')
        publish_inventory(config, prod)
        assert prod.status()['state'] == 'waiting_idle'


def test_native_terminal_result_wins_over_legacy_pending_receipt_and_late_notice(tmp_path, repo, monkeypatch, native_hub):
    import release_notice
    prod = Production(tmp_path, monkeypatch, repo)
    monkeypatch.setenv('PAIOS_RELEASE_SPOOL', str(prod.spool))
    request_id = '0123456789ab'
    release.set_status(prod.host, request_id, state='awaiting_owner', base=repo.base, commit=prod.commit, origin=ORIGIN)
    result = {'request_id': request_id, 'state': 'refused', 'reason': 'OWNER_DECLINED_BASELINE_CHANGE',
              'finished_at': '2026-10-22T19:46:52+00:00'}
    release_build.write(prod.spool / 'status/runtime.json', {'builder_requests': [result]})
    hub, questions, _ = native_hub
    assert hub('release_status', request_id)['state'] == 'refused'
    with pytest.raises(ValueError, match='not awaiting owner'):
        hub('release_decide', request_id)
    assert not questions
    release.set_status(prod.host, request_id, **result)
    body = release_notice.body({'request_id': request_id, 'origin': ORIGIN}, 'release-approval-required', '确认基线',
                               base=repo.base, commit=prod.commit, paths=['deploy/cloud/build.sh'])
    (tmp_path / 'incoming/notices').mkdir()
    release_build.write(tmp_path / 'incoming/notices/approval.json', body)
    release.import_request_notices(prod.host)
    assert prod.status()['state'] == 'refused'
