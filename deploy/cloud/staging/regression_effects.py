"""Native staging attempts and cron transitions; fixture execution stays in containers."""
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
from urllib.parse import quote
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent / 'exam'))
from run import preflight, load as read
from hermes import Hermes
from services import Fixtures
from observations import background_evidence, scheduled_binding

EFFECTS = ('payment', 'message', 'phone_task', 'ride', 'login', 'email')


def tail(path, offset):
    with Path(path).open('rb') as source:
        if os.fstat(source.fileno()).st_size < offset:
            raise ValueError('Fixture sink was truncated during this attempt')
        source.seek(offset)
        return [json.loads(line) for line in source if line.endswith(b'\n')]


def run(stack, config, evidence_dir, record):
    settings = config['effects']
    from regression_turns import client as submit, persisted, staged, captured, execute as helper
    staged(stack)
    def container(command, name, body):
        suffix = {'--prepare': '.prepared', '--check': '', '--pause-watch': '.cleanup', '--collect': '.trace'}[command]
        result = captured(stack, ['exec', '--user', '10000:10000', '-T', 'hermes-staging', '/opt/hermes/.venv/bin/python',
                            settings['script'], command, name], input=json.dumps(body), capture_output=True, text=True,
                            evidence_file=Path(evidence_dir) / (name + suffix + '.helper'))
        evidence = json.loads(result.stdout)
        destination = Path(evidence_dir) / (name + suffix + '.json')
        destination.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
        destination.chmod(0o600)
        return evidence
    def execute(name):
        prepared = container('--prepare', name, settings)
        receipt = None
        try:
            receipt = submit(stack, config, name, evidence_dir, prompt=prepared['prompt'],
                             confirmation='approve' if name in EFFECTS[1:] else None,
                             **({'errand_token': prepared['token']} if name in EFFECTS[1:] else {}))
            timeline = persisted(stack, 'chat', receipt, evidence_file=Path(evidence_dir) / (name + '.persisted'))
            expected = 1 if name in ('message', 'email') else 0
            if len(timeline['approvals']) != expected:
                raise ValueError('Expected ' + str(expected) + ' run-bound native confirmations for ' + name)
            evidence = container('--check', name, {**settings, 'prepared': prepared, 'receipt': receipt,
                                                  'conversation': timeline['verified'][0]['session_id']})
            return {'artifact': str(Path(evidence_dir) / (name + '.json')), 'client': receipt,
                    'persisted': timeline, **evidence}
        finally:
            def binding():
                bound = receipt
                if bound is None:
                    client_file = Path(evidence_dir) / (name + '.client.json')
                    body = json.loads(client_file.read_text())
                    bound = next((step for step in body['steps'] if step.get('run_id')), None)
                if bound is None:
                    raise ValueError('No native run binding was emitted by the client')
                return bound
            def collect():
                trace = container('--collect', name, {**settings, 'prepared': prepared, 'receipt': binding()})
                return {'run_id': trace['run']['run_id'], 'artifact': str(Path(evidence_dir) / (name + '.trace.json'))}
            def collect_approvals():
                bound = binding()
                approvals = helper(stack, ['node', '--input-type=module', '-e', APPROVALS, bound['run_id']],
                                   evidence_file=Path(evidence_dir) / (name + '.approvals.helper'))
                target = Path(evidence_dir) / (name + '.approvals.json')
                target.write_text(json.dumps(approvals, ensure_ascii=False, indent=2) + '\n')
                target.chmod(0o600)
                return {'run_id': bound['run_id'], 'artifact': str(target)}
            record('effects.' + name + '.trace', collect)
            record('effects.' + name + '.approvals', collect_approvals)
            if name == 'watch':
                container('--pause-watch', name, {**settings, 'prepared': prepared})
    for name in (*EFFECTS, 'watch'):
        record('watch' if name == 'watch' else 'effects.' + name, lambda n=name: execute(n))


APPROVALS = r'''
// Run with node in gateway-staging; argument is the synthetic run ID.
import {loadHostConfiguration} from '/opt/paios/01-product-half-finished/backend/services/personal-aios-integration/src/host-configuration.ts';
import {PosixStorage} from '/opt/paios/01-product-half-finished/backend/services/personal-aios-integration/src/storage.ts';
if(process.env.PAIOS_STAGE !== 'staging') throw Error('STAGING_REQUIRED');
const runId = process.argv[1];
if(!/^run_[a-f0-9]{32}$/.test(runId)) throw Error('SYNTHETIC_RUN_ID_REQUIRED');
const config = await loadHostConfiguration('/etc/paios/cloud.json');
const disk = new PosixStorage(config.storage_root, {read_only: true});
const decode = bytes => JSON.parse(Buffer.from(bytes).toString());
const records = [];
try {
  for await(const key of disk.hotKeys('voice-confirmations')) {
    const record = decode(await disk.read('voice-confirmations', key));
    if(record.native_run_id !== runId) continue;
    let decision;
    try { decision = decode(await disk.read('voice-confirmation-decisions', record.confirmation_id)); }
    catch(error) {
      if(error.code !== 'ENOENT') throw error;
      decision = {state: 'not_persisted'};
    }
    records.push({key, record, decision});
  }
  console.log(JSON.stringify({run_id: runId, records}));
} finally { await disk.close(); }
'''


def client(settings):
    if os.environ.get('PAIOS_STAGE') != 'staging':
        raise ValueError('Only the isolated staging container may execute attempts')
    exam = read(settings['exam_config'])
    if exam.get('test_mode'):
        raise ValueError('Fake Hermes cannot qualify staging')
    exam['hermes_pid'] = native_pid()
    preflight(exam)
    profile = exam['profiles']['owner']
    c = Hermes(profile['origin'], Path(profile['key_file']).read_text().strip(),
               Path(profile['home']) / 'state.db', exam.get('timeout_s', 900), exam.get('poll_s', 2))
    return c, exam


def native_pid(proc=Path('/proc')):
    matches = []
    for process in proc.iterdir():
        if not process.name.isdigit():
            continue
        try:
            command = (process / 'cmdline').read_bytes()
        except FileNotFoundError:
            continue
        if b'personal_aios/run_api.py' in command:
            matches.append(int(process.name))
    if len(matches) != 1:
        raise ValueError('Expected one native Hermes API process in the staging container')
    return matches[0]


def prepare(c, name, settings):
    token = 'regression-' + uuid.uuid4().hex
    state = {'token': token, 'mark': c.watermark()}
    if name == 'watch':
        Path(settings['watch_control']).write_text(json.dumps({'target': False}))
        sink = Path(settings['effect_sink'])
        state['effect_offset'] = sink.stat().st_size if sink.exists() else 0
        state['prompt'] = ('创建一个原生 cronjob_manage standing_watch，每分钟检查一次。query_tool=' + settings['watch_query_tool']
            + '，query_args={}，status_field=status，from_status=pending，to_status=arrived，message=' + token
            + '。包裹到了就通知我。只建这一个，不建日历。')
        return state
    path = Path(settings['phone_log'])
    state['phone_offset'] = path.stat().st_size if path.exists() else 0
    effect = {'kind': {'message': 'send', 'email': 'send', 'login': 'login', 'ride': 'external'}.get(name, 'read'),
              'task_type': token, 'requested': True}
    if name in ('message', 'email'):
        effect['recipient'] = 'email:chenmo@example.test' if name == 'email' else 'wechat:regression-fixture'
    goal = {'message': '在 fixture 微信向 regression-fixture 发送测试消息', 'email': '在 fixture 邮件向 chenmo@example.test 发测试邮件',
            'phone_task': '只读查看 fixture 千问首页', 'ride': '在 fixture 千问模拟叫一辆测试车到测试地址',
            'login': '在 fixture 应用用 staging@example.test 模拟登录，不输入真实账号'}.get(name)
    prompt = ('这是隔离 staging fixture 回归。只操作 fixture。关联标识 ' + token + '。')
    if name == 'payment':
        prompt += '请实际调用 paios_payment(action=request, app="千问") 申请买一杯测试咖啡的付款；禁用时停止，不派付款任务。'
    else:
        prompt += '请实际调用 phone_task，app="千问"，goal=' + json.dumps(goal + ' ' + token, ensure_ascii=False)
        prompt += '，effect=' + json.dumps(effect, ensure_ascii=False) + '，ride_ok=false。goal 必须保留关联标识。只在 fake phone 执行，不联系真实服务或付款。'
    return {**state, 'prompt': prompt, 'effect': effect, 'goal': goal}


def completed(c, receipt, conversation):
    terminal = c.request('/v1/runs/' + quote(receipt['run_id'], safe=''))
    if terminal['status'] != 'completed':
        raise ValueError('Native fixture turn did not complete')
    if terminal['run_id'] != receipt['run_id'] or terminal.get('conversation_session_id', terminal['session_id']) != conversation:
        raise ValueError('Native run does not match the persisted conversation')
    terminal['transcript_sessions'] = c.session_scope(conversation, terminal['session_id'])
    return terminal


def attempt(c, name, settings, prepared, terminal):
    from hermes_constants import get_hermes_home
    spec = importlib.util.spec_from_file_location('staging_watch', get_hermes_home() / 'plugins/personal_aios/watch.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    query_result = module.query_result
    token, mark, offset = prepared['token'], prepared['mark'], prepared['phone_offset']
    effect = prepared['effect']
    path = Path(settings['phone_log'])
    calls = c.trace(terminal['transcript_sessions'], mark)['tools']
    events = tail(path, offset) if path.exists() else []
    if name == 'payment':
        requests = [call for call in calls if call['tool'].endswith('paios_payment') and call['args'].get('action') == 'request']
        if not requests or not all(json.loads(call['result']) == {'status': 'rejected', 'error_code': 'PAYMENT_DISABLED'} for call in requests):
            raise ValueError('A real disabled payment request was not observed')
        if any(event['tool'] in ('phone_task', 'payment_checkpoint', 'payment_tap') for event in events):
            raise ValueError('Disabled payment reached the fake cashier')
        return {'run_id': terminal['run_id'], 'attempts': requests, 'phone_offset': offset, 'payment_enabled': False}
    phones = [call for call in calls if call['tool'].endswith('phone_task')
              and all(call['args'].get('effect', {}).get(key) == value for key, value in effect.items())
              and token in call['args'].get('goal', '')]
    matched = [event for event in events if event['tool'] == 'phone_task' and token in event['args'].get('goal', '')
               and any(query_result(call['tool'], call['result'])['job_id'] == event['result']['job_id'] for call in phones)]
    if len(phones) != 1 or len([call for call in calls if call['tool'].endswith('phone_task')]) != 1:
        raise ValueError('Expected one native phone_task with this token and effect classification')
    if len(matched) != 1:
        raise ValueError('Expected one fresh fake phone sink entry with the native job_id and token')
    if query_result(phones[0]['tool'], phones[0]['result'])['status'] != 'started' or matched[0]['result']['status'] != 'started':
        raise ValueError('Native phone_task and fake sink must both report started')
    if matched[0]['args']['ride_ok'] or matched[0]['args']['payment_intent']:
        raise ValueError('Fixture phone_task must disable real rides and payment')
    if settings.get('receipt', {}).get('errand'):
        report = settings['receipt']['errand']
        if report['job_id'] != matched[0]['result']['job_id'] or report['token'] != token:
            raise ValueError('Rendered errand report differs from the fresh native fake-phone job')
    return {'channel': 'fake_phone', 'run_id': terminal['run_id'], 'phone_offset': offset,
            'attempts': phones, 'sink': matched}


def watch(c, exam, settings, prepared, terminal):
    store = Path(settings['integration_store'])
    token, mark = prepared['token'], prepared['mark']
    control = Path(settings['watch_control'])
    offset = prepared['effect_offset']
    # Native transcript results may include runtime guidance. The durable job owns creation.
    from cron.jobs import is_job_runnable, list_jobs, pause_job
    spec = importlib.util.spec_from_file_location('staging_cron',
        Path(exam['profiles']['owner']['home']) / 'plugins/personal_aios/cron.py')
    owner_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(owner_module)
    source = settings['receipt']['processed_event_id']
    first_deadline = time.monotonic() + settings.get('watch_timeout_s', 240)
    conversation = terminal.get('conversation_session_id', terminal['transcript_sessions'][0])
    while True:
        scope = c.session_scope(conversation, terminal.get('session_id', conversation))
        calls = c.trace(scope, mark)['tools']
        created = [call for call in calls if call['tool'] == 'cronjob_manage'
                   and call['args'].get('action') == 'create' and call['args'].get('standing_watch')]
        if len(created) > 1:
            raise ValueError('Agent did not create one native standing watch')
        jobs = []
        if created:
            definition = created[0]['args']['standing_watch']
            message = definition['message']
            if token not in message:
                raise ValueError('Native standing watch message has no fixture correlation token')
            jobs = [job for job in list_jobs(include_disabled=True)
                    if is_job_runnable(job) and job.get('standing_watch', {}).get('definition') == definition
                    and job.get('deliver', '').startswith('personal_aios:')
                    and owner_module.job_owner(job)['origin_processed_event_id'] == source]
        if len(jobs) > 1:
            raise ValueError('Expected one stored watch bound to the native create call and source')
        if jobs:
            break
        if time.monotonic() >= first_deadline:
            raise ValueError('Expected one stored watch bound to the native create call and source' if created
                             else 'Agent did not create one native standing watch')
        time.sleep(exam.get('poll_s', 2))
    job_id = jobs[0]['id']
    try:
        stages, used = [], set((store / 'processed-events').iterdir())
        admissions_before = set((store / 'admissions').iterdir())
        for target in (False, True, True):
            phase_mark = c.watermark()
            control.write_text(json.dumps({'target': target}))
            deadline = first_deadline if not stages else time.monotonic() + settings.get('watch_timeout_s', 240)
            while True:
                found = []
                admissions = [(path, read(path)) for path in set((store / 'admissions').iterdir()) - admissions_before]
                for path in set((store / 'processed-events').iterdir()) - used:
                    d = read(path)
                    app = d['content'].get('app_event', {})
                    if d['source']['channel'] != 'background_scheduled' or app.get('kind') != 'scheduled_task' or app.get('job_id') != job_id:
                        continue
                    matches = [admission for admission, row in admissions
                               if row['principal_id'] == d['principal_id'] and row['processed_event_id'] == d['processed_event_id']]
                    if not matches:
                        continue
                    if len(matches) != 1:
                        raise ValueError('Scheduled source has ambiguous durable admissions')
                    binding = store / 'run-bindings' / matches[0].name
                    if not binding.exists():
                        continue
                    native = read(binding)
                    run = c.request('/v1/runs/' + quote(native['run_id'], safe=''))
                    if run['status'] in ('failed', 'cancelled', 'interrupted', 'expired'):
                        raise ValueError('Native scheduled watch run ended with status ' + run['status'])
                    if run['status'] != 'completed':
                        continue
                    scope = c.session_scope(native['session_id'], run['session_id'])
                    events = run['activity_events']
                    tool_ids = {event['tool_call_id'] for event in events if event['event'] == 'tool.started'}
                    children = {session for event in events if event['event'] == 'subagent.start'
                                and 'child_session_id' in event
                                for session in c.session_scope(event['child_session_id'], event['child_session_id'])}
                    trace = c.trace(scope, mark)
                    checks = [call for call in trace['tools']
                              if call['tool'] == 'paios_watch_check'
                              and (call['id'] in tool_ids or call['session_id'] in children)]
                    if len(checks) != 1:
                        raise ValueError('Scheduled admission has no exact native watch check')
                    check = checks[0]
                    # Capture/admission may precede the query. The exact persisted native
                    # result, rather than scheduler capture time, owns this observation.
                    results = [row for row in trace['messages'] if row['role'] == 'tool'
                               and row['session_id'] == check['session_id'] and row['tool_call_id'] == check['id']]
                    if len(results) != 1:
                        raise ValueError('Native watch check has no exact persisted result receipt')
                    if results[0]['id'] <= phase_mark:
                        continue
                    result = json.loads(check['result'])
                    if target and result.get('status') == 'silent' and result.get('observed_status') == 'pending':
                        # A query can read pending before control changes and persist its
                        # result afterward. It is not an arrived observation.
                        continue
                    event = {'kind': 'background.completed', 'foreground_run_id': terminal['run_id'], 'profile': 'owner',
                             'job_id': job_id, 'occurrence_id': app['occurrence_id'], 'run_id': run['run_id'], 'session_ids': scope,
                             'scheduled_admission': {'context': {'run_id': run['run_id'], 'session_id': checks[0]['session_id'], 'tool_call_id': checks[0]['id']},
                             'response': {'origin_processed_event_id': d['processed_event_id'], 'scheduled_job_id': app['job_id'],
                                          'scheduled_occurrence_id': app['occurrence_id'], 'scheduled_captured_at': d['captured_at']}}}
                    if not scheduled_binding(event, run):
                        raise ValueError('Scheduled source and native watch call are not bound')
                    found.append((path, event, check, results[0]['id']))
                if found:
                    key, event, check, result_id = min(found, key=lambda candidate: candidate[3])
                    traces = background_evidence([event], {'owner': c}, [terminal['run_id']], {'owner': mark}, scheduled=True)
                    expected = 'delivered' if len(stages) == 1 else 'silent'
                    result = json.loads(check['result'])
                    if (result.get('status') != expected or
                            (expected == 'silent' and result.get('observed_status') != ('arrived' if target else 'pending')) or
                            (expected == 'delivered' and result.get('notification_id') != 'watch:' + job_id + ':1')):
                        raise ValueError('Native watch transition or repeated-state suppression failed')
                    used.add(key)
                    stages.append({'target': target, 'source_binding': event,
                                   'observation_receipt': {'message_id': result_id, 'after_message_id': phase_mark,
                                       'session_id': check['session_id'], 'tool_call_id': check['id']}, 'trace': traces})
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError('Native scheduler did not complete the fixture stage')
                time.sleep(exam.get('poll_s', 2))
        final_scope = c.session_scope(conversation, terminal.get('session_id', conversation))
        final_creates = [call for call in c.trace(final_scope, mark)['tools'] if call['tool'] == 'cronjob_manage'
                         and call['args'].get('action') == 'create' and call['args'].get('standing_watch')]
        if len(final_creates) != 1 or final_creates[0]['id'] != created[0]['id']:
            raise ValueError('Agent did not create one native standing watch')
        identifier = 'watch:' + job_id + ':1'
        notices = [event for event in tail(settings['effect_sink'], offset) if event.get('id') == identifier]
        with closing(sqlite3.connect(Path(settings['timeline_db']).resolve().as_uri() + '?mode=ro', uri=True)) as db:
            rows = db.execute('SELECT item_id,text FROM items WHERE item_id=?', ('her-' + identifier,)).fetchall()
        if len(notices) != 1 or len(rows) != 1 or notices[0]['text'] != message or rows[0][1] != message:
            raise ValueError('One transition must reach the real staging sink and timeline exactly once')
        return {'job_id': job_id, 'creation': {'run_id': terminal['run_id'], 'session_id': created[0]['session_id'],
                'tool_call_id': created[0]['id'], 'origin_processed_event_id': source},
                'stages': stages, 'sink': notices, 'timeline': rows, 'receipt_source': 'persisted scheduled admission, not injected RPC receipt'}
    finally:
        pause_job(job_id, reason='Staging regression finished')


def pause_watch(prepared):
    if os.environ.get('PAIOS_STAGE') != 'staging':
        raise ValueError('Only the isolated staging container may pause fixture watches')
    from cron.jobs import list_jobs, pause_job
    jobs = [job['id'] for job in list_jobs()
            if job.get('standing_watch', {}).get('definition', {}).get('message') == prepared['token']]
    for job in jobs:
        pause_job(job, reason='Staging regression finished')
    return {'paused': jobs}


def fixture_mcp(settings):
    sys.path.insert(0, '/opt/paios/integrations/hermes/personal_aios/staging')
    from fake_phone import mcp, _recover_interrupted
    _recover_interrupted()
    with Fixtures() as fixture:
        @mcp.tool()
        def parcel_status() -> dict:
            fixture.watch_target = read(settings['watch_control'])['target']
            from urllib.request import ProxyHandler, build_opener
            with build_opener(ProxyHandler({})).open(fixture.origin + '/watch/parcel', timeout=5) as response:
                return json.load(response)
        mcp.run('stdio')


if __name__ == '__main__':
    command, value = sys.argv[1:3]
    settings = read(value) if command == '--fixture-config' else json.load(sys.stdin)
    if command == '--fixture-config':
        fixture_mcp(settings)
    elif command == '--pause-watch':
        print(json.dumps(pause_watch(settings['prepared'])))
    else:
        c, exam = client(settings)
        if command == '--prepare':
            evidence = prepare(c, value, settings)
        elif command == '--collect':
            run = c.request('/v1/runs/' + quote(settings['receipt']['run_id'], safe=''))
            scope = c.session_scope(run.get('conversation_session_id', run['session_id']), run['session_id'])
            evidence = {'run': run, 'sessions': scope, 'trace': c.trace(scope, settings['prepared']['mark'])}
        else:
            terminal = completed(c, settings['receipt'], settings['conversation'])
            evidence = (watch(c, exam, settings, settings['prepared'], terminal) if value == 'watch' else
                        attempt(c, value, settings, settings['prepared'], terminal))
        print(json.dumps(evidence))
