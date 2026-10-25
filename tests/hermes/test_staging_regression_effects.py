"""Boundary tests for fresh fake-phone attempts; no model, HTTP server or device."""
import importlib.util
import asyncio
import json
from pathlib import Path
import tempfile
import shutil
import subprocess
import sqlite3
import sys
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'deploy/cloud/staging'))
sys.path.insert(0, str(ROOT / 'integrations/hermes'))
SPEC = importlib.util.spec_from_file_location('staging_regression_effects', ROOT / 'deploy/cloud/staging/regression_effects.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class NativeClient:
    def __init__(self, log, fault=None):
        self.log, self.fault, self.calls = log, fault, []

    def watermark(self):
        return 41

    def deliver(self, prompt):
        if 'paios_payment' in prompt:
            self.calls = [{'tool': 'paios_payment', 'args': {'action': 'request'},
                           'result': json.dumps({'status': 'rejected', 'error_code': 'PAYMENT_DISABLED'})}]
            if self.fault == 'payment_allowed':
                self.calls[0]['result'] = json.dumps({'status': 'allowed'})
            if self.fault == 'payment_dispatched':
                with self.log.open('a') as stream:
                    stream.write(json.dumps({'tool': 'phone_task'}) + '\n')
        else:
            effect = json.JSONDecoder().raw_decode(prompt.split('effect=', 1)[1])[0]
            goal = json.JSONDecoder().raw_decode(prompt.split('goal=', 1)[1])[0]
            args = {'effect': {**effect, 'summary': 'fixture preview'}, 'goal': '测试关联 ' + goal.rsplit(' ', 1)[-1]}
            result = {'status': 'started', 'job_id': 'native-job'}
            self.calls = [{'tool': 'mcp__phone__phone_task', 'args': args, 'result': json.dumps({'result': json.dumps(result)})}]
            sink = {'tool': 'phone_task', 'args': {'goal': args['goal'], 'ride_ok': False, 'payment_intent': None}, 'result': result}
            if self.fault == 'wrong_job':
                sink['result'] = {**result, 'job_id': 'different-job'}
            if self.fault == 'ride':
                sink['args']['ride_ok'] = True
            if self.fault == 'approval_mismatch':
                self.calls[0]['args']['effect'] = {**effect, 'recipient': 'someone-else'}
            if self.fault != 'missing':
                with self.log.open('a') as stream:
                    stream.write(json.dumps(sink) + '\n')
                    if self.fault == 'duplicate':
                        stream.write(json.dumps(sink) + '\n')
        return {'status': 'completed', 'run_id': 'native-run', 'session_id': 'native-session', 'transcript_sessions': ['native-session']}

    def session_scope(self, conversation, session):
        return [session]

    def trace(self, sessions, after=0):
        assert after == 41
        return {'tools': self.calls, 'messages': []}


class EffectsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        home = Path(self.tmp.name) / 'hermes'
        plugin = home / 'plugins/personal_aios'
        plugin.mkdir(parents=True)
        shutil.copyfile(ROOT / 'integrations/hermes/personal_aios/watch.py', plugin / 'watch.py')
        token = set_hermes_home_override(home)
        self.addCleanup(reset_hermes_home_override, token)
        self.path = Path(self.tmp.name) / 'fake-phone.jsonl'
        self.path.write_text(json.dumps({'tool': 'phone_task', 'args': {'goal': 'old-run'}, 'result': {'job_id': 'old'}}) + '\n')
        self.settings = {'phone_log': str(self.path)}

    def attempt(self, name, fault=None):
        c = NativeClient(self.path, fault)
        prepared = MODULE.prepare(c, name, self.settings)
        terminal = c.deliver(prepared['prompt'])
        return MODULE.attempt(c, name, self.settings, prepared, terminal)

    def test_rendered_report_must_match_native_job_and_fresh_sink(self):
        c = NativeClient(self.path)
        prepared = MODULE.prepare(c, 'phone_task', self.settings)
        terminal = c.deliver(prepared['prompt'])
        report = {'job_id': 'native-job', 'token': prepared['token']}
        settings = {**self.settings, 'receipt': {'errand': report}}
        self.assertEqual(MODULE.attempt(c, 'phone_task', settings, prepared, terminal)['sink'][0]['result']['job_id'], 'native-job')
        for wrong in ({**report, 'job_id': 'other-job'}, {**report, 'token': 'old-token'}):
            with self.subTest(report=wrong), self.assertRaisesRegex(ValueError, 'fresh native fake-phone job'):
                MODULE.attempt(c, 'phone_task', {**settings, 'receipt': {'errand': wrong}}, prepared, terminal)

    def test_five_effects_reach_existing_fake_sink_with_native_job_identity(self):
        for name in MODULE.EFFECTS[1:]:
            with self.subTest(name=name):
                result = self.attempt(name)
                self.assertEqual(result['run_id'], 'native-run')
                self.assertEqual(len(result['sink']), 1)
                self.assertGreater(result['phone_offset'], 0)
                self.assertEqual(result['channel'], 'fake_phone')

    def test_installed_plugin_loads_without_pythonpath_or_bare_package(self):
        import hermes_constants
        code = '''
import importlib.util, json, runpy, sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
assert importlib.util.find_spec('personal_aios') is None
m = runpy.run_path(sys.argv[2])
c = SimpleNamespace(trace=lambda *args: {'tools': [{'tool': 'paios_payment',
    'args': {'action': 'request'}, 'result': json.dumps({'status': 'rejected', 'error_code': 'PAYMENT_DISABLED'})}]})
result = m['attempt'](c, 'payment', {'phone_log': sys.argv[3]},
    {'token': 'fixture', 'mark': 0, 'phone_offset': Path(sys.argv[3]).stat().st_size, 'effect': {}},
    {'run_id': 'fixture', 'transcript_sessions': ['fixture']})
assert result['payment_enabled'] is False
assert importlib.util.find_spec('personal_aios') is None
print('installed plugin: payment passed without bare package')
'''
        env = {**MODULE.os.environ, 'HERMES_HOME': str(hermes_constants.get_hermes_home())}
        env.pop('PYTHONPATH', None)
        result = subprocess.run([sys.executable, '-I', '-B', '-c', code,
            str(Path(hermes_constants.__file__).resolve().parent),
            str(ROOT / 'deploy/cloud/staging/regression_effects.py'), str(self.path)],
            env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('payment passed without bare package', result.stdout)

    def test_real_phone_mcp_schema_results_and_persisted_transcript(self):
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        from tools.mcp_tool_handlers import _render_call_tool_result
        from agent.tool_dispatch_helpers import make_tool_result_message
        database = Path(self.tmp.name) / 'state.db'
        with sqlite3.connect(database) as db:
            db.execute('CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,tool_call_id TEXT,tool_calls TEXT)')
        c = MODULE.Hermes('http://127.0.0.1:18662', 'unused', database)
        async def exercise():
            env = {**MODULE.os.environ, 'PAIOS_FAKE_PHONE_LOG': str(self.path)}
            env.pop('PAIOS_ERRAND_SPOOL', None)
            server = StdioServerParameters(command=sys.executable, args=[str(ROOT / 'integrations/hermes/personal_aios/staging/fake_phone.py')], env=env)
            async with stdio_client(server) as (reader, writer), ClientSession(reader, writer) as session:
                await session.initialize()
                tools = await session.list_tools()
                schema = next(tool.input_schema for tool in tools.tools if tool.name == 'phone_task')
                self.assertIn('effect', schema['required'])
                for name in MODULE.EFFECTS[1:]:
                    prepared = MODULE.prepare(c, name, self.settings)
                    args = {'goal': 'fixture 测试 ' + prepared['token'], 'app': '千问',
                            'effect': {**prepared['effect'], 'summary': 'fixture preview'}, 'principal_id': 'fixture-owner'}
                    raw = await session.call_tool('phone_task', args)
                    result = _render_call_tool_result(raw, 'phone')
                    tool = {'id': name, 'function': {'name': 'mcp__phone__phone_task', 'arguments': json.dumps(args)}}
                    with sqlite3.connect(database) as db:
                        db.execute('INSERT INTO messages(session_id,role,tool_calls) VALUES (?,?,?)', ('fixture-session', 'assistant', json.dumps([tool])))
                        # Persist as native does: MCP output sits inside untrusted-data delimiters.
                        content = make_tool_result_message('mcp__phone__phone_task', result, name)['content']
                        self.assertTrue(content.startswith('<untrusted_tool_result'))
                        db.execute('INSERT INTO messages(session_id,role,tool_call_id,content) VALUES (?,?,?,?)', ('fixture-session', 'tool', name, content))
                    evidence = MODULE.attempt(c, name, self.settings, prepared,
                        {'run_id': 'fixture-run', 'transcript_sessions': ['fixture-session']})
                    self.assertEqual(len(evidence['sink']), 1)
        asyncio.run(exercise())

    def test_stale_missing_wrong_duplicate_and_ride_sinks_cannot_pass(self):
        for fault in ('missing', 'wrong_job', 'duplicate', 'ride'):
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                self.attempt('message', fault)

    def test_unrelated_effect_cannot_qualify_a_fixture_attempt(self):
        with self.assertRaisesRegex(ValueError, 'effect classification'):
            self.attempt('message', 'approval_mismatch')

    def test_native_payment_disabled_is_required_and_dispatch_is_forbidden(self):
        self.assertFalse(self.attempt('payment')['payment_enabled'])
        for fault in ('payment_allowed', 'payment_dispatched'):
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                self.attempt('payment', fault)

    def test_partial_last_row_does_not_satisfy_sink(self):
        self.path.write_bytes(b'{"tool":"phone_task"}')
        self.assertEqual(MODULE.tail(self.path, 0), [])

    def test_fake_hermes_is_rejected_before_authority_clients(self):
        with patch.dict(MODULE.os.environ, {'PAIOS_STAGE': 'staging'}), patch.object(MODULE, 'read', return_value={'test_mode': True}):
            with self.assertRaisesRegex(ValueError, 'Fake Hermes'):
                MODULE.client({'exam_config': 'unused', 'pairing': 'fixture-pairing.json'})

    def test_current_container_pid_replaces_the_pre_restore_pid(self):
        root = Path(self.tmp.name) / 'proc'
        for pid, command in [('31', b'python\0personal_aios/run_api.py\0'), ('32', b'python\0worker.py\0')]:
            (root / pid).mkdir(parents=True)
            (root / pid / 'cmdline').write_bytes(command)
        (root / 'exited-irrelevant').mkdir()
        (root / '33').mkdir()
        self.assertEqual(MODULE.native_pid(root), 31)
        (root / '32/cmdline').write_bytes(b'python\0personal_aios/run_api.py\0')
        with self.assertRaisesRegex(ValueError, 'one native'):
            MODULE.native_pid(root)


    def test_fixture_mcp_preserves_native_fake_restart_recovery(self):
        events = []
        fake = types.ModuleType('fake_phone')
        fake._recover_interrupted = lambda: events.append('recover')
        fake.mcp = types.SimpleNamespace(tool=lambda: lambda fn: fn, run=lambda transport: events.append(transport))
        fixture = types.SimpleNamespace()
        with patch.dict(MODULE.sys.modules, {'fake_phone': fake}), patch.object(MODULE, 'Fixtures') as fixtures:
            fixtures.return_value.__enter__.return_value = fixture
            MODULE.fixture_mcp({})
        self.assertEqual(events, ['recover', 'stdio'])


    def test_runner_prepares_then_submits_and_observes_the_product_run(self):
        import regression_turns as turns
        records, commands = [], []
        receipt = {'run_id': 'native-run', 'approvals': []}
        def container(args, **options):
            commands.append((args, options))
            name = args[-1]
            if 'gateway-staging' in args:
                return types.SimpleNamespace(stdout='{}', stderr='', returncode=0)
            if args[-2] == '--collect':
                return types.SimpleNamespace(stdout=json.dumps({'run': {'run_id': receipt['run_id']}}), stderr='', returncode=0)
            if args[-2] == '--prepare':
                self.assertEqual(json.loads(options['input']), self.settings)
                return types.SimpleNamespace(stdout=json.dumps({'prompt': name, 'mark': 41, 'token': 'fixture-token-' + name}), stderr='', returncode=0)
            if args[-2] == '--pause-watch':
                return types.SimpleNamespace(stdout=json.dumps({'paused': []}), stderr='', returncode=0)
            body = json.loads(options['input'])
            self.assertEqual(body['receipt'], receipt)
            self.assertEqual(body['conversation'], 'bound-conversation')
            return types.SimpleNamespace(stdout=json.dumps({'run_id': receipt['run_id']}), stderr='', returncode=0)
        stack = types.SimpleNamespace(stage=True, definition={'services': {name + '-staging': {
            'environment': {'PAIOS_STAGE': 'staging'}} for name in ('gateway', 'hermes')}}, run=container)
        self.settings['script'] = '/stage-kit/regression_effects.py'
        def submit(stack, config, name, directory, **kw):
            self.assertEqual(kw['prompt'], name)
            self.assertEqual(kw['confirmation'], 'approve' if name in MODULE.EFFECTS[1:] else None)
            self.assertEqual(set(kw), {'prompt', 'confirmation', 'errand_token'} if name in MODULE.EFFECTS[1:] else {'prompt', 'confirmation'})
            if name in MODULE.EFFECTS[1:]:
                prepared = json.loads((directory / (name + '.prepared.json')).read_text())
                self.assertEqual(kw['errand_token'], prepared['token'])
            return receipt
        def record(name, action):
            records.append((name, action()))
        with patch.object(turns, 'client', side_effect=submit) as client, patch.object(turns, 'persisted',
                side_effect=[{'verified': [{'session_id': 'bound-conversation'}],
                              'approvals': [{}] if name in ('message', 'email') else []}
                             for name in (*MODULE.EFFECTS, 'watch')]) as persisted:
            MODULE.run(stack, {'effects': self.settings}, Path(self.tmp.name), record)
        self.assertEqual([name for name, _ in records if not name.endswith(('.trace', '.approvals'))], ['effects.' + name for name in MODULE.EFFECTS] + ['watch'])
        self.assertEqual(client.call_count, 7)
        self.assertEqual(persisted.call_count, 7)
        self.assertEqual(len(commands), 29)
        self.assertTrue(all(args[:5] == ['exec', '--user', '10000:10000', '-T', 'hermes-staging'] for args, _ in commands if '--user' in args))
        self.assertEqual(json.loads((Path(self.tmp.name) / 'watch.json').read_text()), {'run_id': 'native-run'})


    def test_watch_cleanup_covers_client_and_timeline_failures(self):
        import regression_turns as turns
        for failure in ('client', 'persisted'):
            with self.subTest(failure=failure):
                commands = []
                def container(args, **options):
                    commands.append(args[-2])
                    return types.SimpleNamespace(stdout=json.dumps({'prompt': 'watch', 'token': 'fixture-token'}), stderr='', returncode=0)
                stack = types.SimpleNamespace(run=container)
                with patch.object(turns, 'staged'), patch.object(turns, 'client', return_value={}) as submit, \
                        patch.object(turns, 'persisted') as persisted, patch.object(MODULE, 'EFFECTS', ()):
                    {'client': submit, 'persisted': persisted}[failure].side_effect = ValueError('fixture failure')
                    self.settings['script'] = '/stage-kit/regression_effects.py'
                    with self.assertRaisesRegex(ValueError, 'fixture failure'):
                        MODULE.run(stack, {'effects': self.settings}, Path(self.tmp.name), lambda name, action: None if name.endswith(('.trace', '.approvals')) else action())
                self.assertEqual(commands, ['--prepare', '--pause-watch'])

    def test_cleanup_pauses_only_the_token_bound_active_watch(self):
        jobs = [{'id': 'fixture', 'standing_watch': {'definition': {'message': 'fixture-token'}}},
                {'id': 'other-watch', 'standing_watch': {'definition': {'message': 'other-token'}}},
                {'id': 'ordinary-cron'}]
        paused = []
        cron = types.ModuleType('cron.jobs')
        cron.list_jobs = lambda: jobs
        cron.pause_job = lambda job, reason: paused.append(job)
        with patch.dict(MODULE.sys.modules, {'cron.jobs': cron}), patch.dict(MODULE.os.environ, {'PAIOS_STAGE': 'staging'}):
            self.assertEqual(MODULE.pause_watch({'token': 'fixture-token'}), {'paused': ['fixture']})
        self.assertEqual(paused, ['fixture'])


class WatchTests(unittest.TestCase):
    def exercise(self, *, duplicate=False, missing_call=False, missing_token=False, sink_mismatch=False, timeline_mismatch=False,
                 decorated=False, wrong_source=False, wrong_definition=False, duplicate_job=False, paused_job=False,
                 late_prior_occurrence=False, crossing_admission=False, stale_pending=False,
                 missing_result=False, wrong_observed=False, wrong_notification=False, simultaneous=False,
                 async_creation=False, rejected_update=False, duplicate_create=False):
        import cron.jobs as jobs
        from personal_aios.cron import target
        from agent.tool_guardrails import ToolGuardrailDecision, append_toolguard_guidance
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            plugin = root / 'plugins/personal_aios'
            plugin.mkdir(parents=True)
            shutil.copyfile(ROOT / 'integrations/hermes/personal_aios/cron.py', plugin / 'cron.py')
            store = root / 'store'
            for name in ('admission-inputs', 'processed-events', 'admissions', 'run-bindings'):
                (store / name).mkdir(parents=True)
            control, sink, timeline = root / 'control.json', root / 'sink.jsonl', root / 'timeline.sqlite'
            sink.write_text('')
            with sqlite3.connect(timeline) as db:
                db.execute('CREATE TABLE items(item_id TEXT,text TEXT)')
            state = {'created': False, 'index': 0, 'token': None}
            original_write = Path.write_text
            def transition(path, text, *args, **kwargs):
                result = original_write(path, text, *args, **kwargs)
                if path != control or not state['created']:
                    return result
                i = state['index']
                d = {'principal_id': 'fixture-owner', 'source': {'channel': 'background_scheduled'}, 'captured_at': '2023-11-14T22:13:20Z', 'processed_event_id': 'd-' + str(i),
                     'content': {'app_event': {'kind': 'scheduled_task', 'job_id': state['job_id'], 'occurrence_id': 'tick-' + str(i)}}}
                if crossing_admission and i == 1:
                    d['captured_at'] = '2023-11-14T22:13:19Z'
                original_write(store / 'admission-inputs' / str(i), json.dumps({'d': d}))
                original_write(store / 'processed-events' / ('processed-' + str(i)), json.dumps(d))
                original_write(store / 'admissions' / ('admission-' + str(i)), json.dumps({
                    'principal_id': d['principal_id'], 'processed_event_id': d['processed_event_id']}))
                original_write(store / 'run-bindings' / ('admission-' + str(i)), json.dumps({'run_id': 'scheduled-' + str(i), 'session_id': 'cron-session-' + str(i)}))
                # Terminal finalization deletes pending input before the observer can poll it.
                (store / 'admission-inputs' / str(i)).unlink()
                if (i == 1 and stale_pending) or (i in (0, 1) and simultaneous):
                    extra_id = str(i + 10)
                    extra = {**d, 'processed_event_id': 'd-' + extra_id,
                             'content': {'app_event': {**d['content']['app_event'], 'occurrence_id': 'tick-' + extra_id}}}
                    original_write(store / 'processed-events' / ('processed-' + extra_id), json.dumps(extra))
                    original_write(store / 'admissions' / ('admission-' + extra_id), json.dumps({
                        'principal_id': d['principal_id'], 'processed_event_id': 'd-' + extra_id}))
                    original_write(store / 'run-bindings' / ('admission-' + extra_id), json.dumps({
                        'run_id': 'scheduled-' + extra_id, 'session_id': 'cron-session-' + extra_id}))
                if i == 1:
                    notices = [{'id': 'watch:' + state['job_id'] + ':1', 'text': 'different message' if sink_mismatch else state['message']}]
                    if duplicate:
                        notices *= 2
                    original_write(sink, ''.join(json.dumps(notice) + '\n' for notice in notices))
                    with sqlite3.connect(timeline) as db:
                        db.execute('INSERT INTO items VALUES (?,?)', ('her-watch:' + state['job_id'] + ':1', 'different message' if timeline_mismatch else state['message']))
                state['index'] += 1
                return result
            class WatchClient:
                def watermark(self):
                    return 41 + state['index'] * 10
                def deliver(self, prepared):
                    state.update(created=True, token=prepared['token'])
                    state['message'] = '包裹到了。' + ('' if missing_token else prepared['token'])
                    state['definition'] = {'query_tool': 'mcp__phone__parcel_status', 'query_args': {},
                        'status_field': 'status', 'from_status': 'pending', 'to_status': 'arrived', 'message': state['message']}
                    if not async_creation:
                        self.persist_watch()
                    return {'status': 'completed', 'run_id': 'foreground', 'transcript_sessions': ['foreground']}
                def persist_watch(self):
                    destination = target({'principal_id': 'fixture-owner', 'device_id': 'fixture-phone',
                        'origin_processed_event_id': 'other-d' if wrong_source else 'foreground-d'})
                    for _ in range(2 if duplicate_job else 1):
                        job = jobs.create_job(prompt='fixture watch', schedule='every 1m', deliver=destination)
                        saved = {**state['definition'], **({'to_status': 'other'} if wrong_definition else {})}
                        jobs.update_job(job['id'], {'standing_watch': {'definition': saved, 'last_status': None, 'sequence': 0}})
                        if paused_job:
                            jobs.pause_job(job['id'], reason='fixture paused before qualification')
                        state['job_id'] = job['id']
                def session_scope(self, conversation, session):
                    if conversation == 'foreground':
                        state['creation_polls'] = state.get('creation_polls', 0) + 1
                        if async_creation and state['creation_polls'] > 1:
                            if 'job_id' not in state:
                                self.persist_watch()
                            return [session, 'creation-child']
                        return [session]
                    if late_prior_occurrence and conversation.startswith('watch-child-'):
                        return [session]
                    if late_prior_occurrence:
                        return [session, session.replace('cron-session-', 'watch-child-'), 'prior-watch-child']
                    return [session]
                def request(self, path):
                    run_id = path.rsplit('/', 1)[1]
                    assert not list((store / 'admission-inputs').iterdir())
                    i = run_id.rsplit('-', 1)[1]
                    events = [{'event': 'subagent.start', 'child_session_id': 'watch-child-' + i}] if late_prior_occurrence else [
                        {'event': 'tool.started', 'tool_call_id': 'tool-' + i}]
                    return {'status': 'completed', 'run_id': run_id, 'session_id': run_id.replace('scheduled-', 'cron-session-'),
                            'activity_events': events}
                def trace(self, sessions, after):
                    if sessions[0] == 'foreground':
                        if async_creation and 'creation-child' not in sessions:
                            return {'tools': [], 'messages': []}
                        raw = json.dumps({'success': True, 'job_id': state['job_id']})
                        if decorated:
                            raw = append_toolguard_guidance(raw, ToolGuardrailDecision(
                                action='warn', code='same_tool_failure_warning', message='native runtime guidance', count=3))
                        calls = [{'id': 'create-watch', 'session_id': 'foreground', 'tool': 'cronjob_manage',
                                  'args': {'action': 'create', 'standing_watch': state['definition']}, 'result': raw}]
                        if rejected_update:
                            calls.append({'id': 'rejected-update', 'session_id': 'creation-child', 'tool': 'cronjob_manage',
                                'args': {'action': 'update', 'standing_watch': state['definition']},
                                'result': json.dumps({'success': False, 'error': 'Standing watches require a recurring reasoning job.'})})
                        if duplicate_create:
                            calls.append({**calls[0], 'id': 'duplicate-create'})
                    else:
                        i = int(sessions[0].rsplit('-', 1)[1])
                        assert after == 41, 'Resolve in-flight native calls from the original attempt watermark'
                        current_session = 'watch-child-' + str(i) if late_prior_occurrence else sessions[0]
                        status = {'status': 'delivered', 'notification_id': 'watch:' + state['job_id'] + ':1'} if i == 1 else {
                            'status': 'silent', 'observed_status': 'pending' if i in (0, 10) or (i == 11 and stale_pending) else 'arrived'}
                        if wrong_observed and i == 0:
                            status['observed_status'] = 'arrived'
                        if wrong_notification and i == 1:
                            status['notification_id'] = 'watch:wrong-job:1'
                        calls = [] if missing_call else [{'id': 'tool-' + str(i), 'session_id': current_session, 'tool': 'paios_watch_check',
                                  'result': json.dumps(status)}]
                        if late_prior_occurrence:
                            calls.insert(0, {'id': 'prior-tool', 'session_id': 'prior-watch-child', 'tool': 'paios_watch_check',
                                             'result': json.dumps({'status': 'delivered'})})
                    messages = [] if sessions[0] == 'foreground' or missing_result else [{
                        'id': {10: 43, 11: 53}.get(i, 42 + i * 10), 'role': 'tool', 'session_id': current_session,
                        'tool_call_id': 'tool-' + str(i)}]
                    return {'tools': calls, 'messages': messages}
            config = {'integration_store': str(store), 'watch_control': str(control), 'effect_sink': str(sink),
                      'timeline_db': str(timeline), 'watch_query_tool': 'mcp__phone__parcel_status', 'watch_timeout_s': 240 if async_creation else 0,
                      'receipt': {'processed_event_id': 'foreground-d'}}
            with jobs.use_cron_store(root), patch.object(Path, 'write_text', transition), patch.object(MODULE.time, 'time', return_value=1700000000), patch.object(MODULE.time, 'sleep'):
                try:
                    c = WatchClient()
                    prepared = MODULE.prepare(c, 'watch', config)
                    return MODULE.watch(c, {'profiles': {'owner': {'home': str(root)}}}, config, prepared, c.deliver(prepared))
                finally:
                    if not (wrong_source or wrong_definition or duplicate_job or missing_token or paused_job or duplicate_create) and (not decorated or state['index']):
                        self.assertEqual(jobs.get_job(state['job_id'])['state'], 'paused')

    def test_completed_sources_survive_pending_input_finalization_and_project_once(self):
        result = self.exercise()
        self.assertEqual(len(result['stages']), 3)
        self.assertEqual(len(result['sink']), 1)
        self.assertEqual(result['timeline'][0][0], 'her-watch:' + result['job_id'] + ':1')
        self.assertTrue(result['timeline'][0][1].startswith('包裹到了。regression-'))
        self.assertEqual(result['sink'][0]['text'], result['timeline'][0][1])

    def test_background_child_creation_after_main_completion_and_rejected_update_qualify(self):
        result = self.exercise(async_creation=True, rejected_update=True)
        self.assertEqual(result['creation']['tool_call_id'], 'create-watch')
        self.assertEqual([stage['target'] for stage in result['stages']], [False, True, True])

    def test_duplicate_native_create_calls_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'one native standing watch'):
            self.exercise(duplicate_create=True)

    def test_duplicate_notification_and_missing_native_check_fail_and_pause(self):
        for fault in ('duplicate', 'missing_call'):
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                self.exercise(**{fault: True})

    def test_late_prior_occurrence_does_not_count_as_current_native_watch(self):
        result = self.exercise(late_prior_occurrence=True)
        self.assertEqual([s['target'] for s in result['stages']], [False, True, True])
        self.assertEqual([s['source_binding']['scheduled_admission']['context']['tool_call_id']
                          for s in result['stages']], ['tool-0', 'tool-1', 'tool-2'])
        self.assertEqual(len(result['sink']), 1)
        self.assertEqual(len(result['timeline']), 1)

    def test_late_prior_occurrence_cannot_replace_a_missing_current_watch(self):
        with self.assertRaisesRegex(ValueError, 'exact native watch check'):
            self.exercise(late_prior_occurrence=True, missing_call=True)

    def test_prior_admission_can_own_a_query_completed_after_control_transition(self):
        result = self.exercise(crossing_admission=True, late_prior_occurrence=True)
        arrival = result['stages'][1]
        self.assertEqual(arrival['source_binding']['scheduled_admission']['context']['tool_call_id'], 'tool-1')
        self.assertEqual(arrival['source_binding']['scheduled_admission']['response']['scheduled_captured_at'],
                         '2023-11-14T22:13:19Z')
        for stage in result['stages']:
            receipt = stage['observation_receipt']
            self.assertGreater(receipt['message_id'], receipt['after_message_id'])

    def test_pending_query_completed_after_true_control_cannot_own_arrival(self):
        result = self.exercise(crossing_admission=True, stale_pending=True)
        self.assertEqual(result['stages'][1]['source_binding']['run_id'], 'scheduled-1')

    def test_simultaneous_candidates_keep_source_and_native_check_identity_together(self):
        # Arrival and its subsequent silent observation complete in one poll.
        # Persisted result order owns selection, independently of set order.
        result = self.exercise(simultaneous=True)
        for i, stage in enumerate(result['stages']):
            source = stage['source_binding']
            receipt = stage['observation_receipt']
            context = source['scheduled_admission']['context']
            self.assertEqual(source['run_id'], 'scheduled-' + str(i))
            self.assertEqual(receipt['message_id'], 42 + i * 10)
            self.assertEqual(receipt['session_id'], 'cron-session-' + str(i))
            self.assertEqual(receipt['tool_call_id'], 'tool-' + str(i))
            self.assertEqual((context['session_id'], context['tool_call_id']),
                             (receipt['session_id'], receipt['tool_call_id']))
            self.assertGreater(receipt['message_id'], receipt['after_message_id'])

    def test_result_receipt_and_exact_observation_and_notification_are_required(self):
        for fault in ('missing_result', 'wrong_observed', 'wrong_notification'):
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                self.exercise(**{fault: True})

    def test_message_requires_token_and_unchanged_delivery_to_both_projections(self):
        for fault in ('missing_token', 'sink_mismatch', 'timeline_mismatch'):
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                self.exercise(**{fault: True})

    def test_native_guidance_does_not_replace_authoritative_created_watch(self):
        result = self.exercise(decorated=True)
        self.assertEqual([stage['target'] for stage in result['stages']], [False, True, True])
        self.assertEqual(len(result['sink']), 1)

    def test_created_watch_requires_exact_definition_source_and_single_stored_job(self):
        for fault in ('wrong_source', 'wrong_definition', 'duplicate_job', 'paused_job'):
            with self.subTest(fault=fault), self.assertRaisesRegex(ValueError, 'stored watch'):
                self.exercise(decorated=True, **{fault: True})


if __name__ == '__main__':
    unittest.main()
