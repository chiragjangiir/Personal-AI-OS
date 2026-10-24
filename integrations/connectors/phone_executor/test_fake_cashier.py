"""Isolated fake-cashier screens, shared-client wiring and model-trace assertions; no phone or network."""
import asyncio
from contextlib import closing
import importlib.util
import inspect
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
STAGING = ROOT / 'integrations/hermes/personal_aios/staging'
sys.path.insert(0, str(Path(__file__).resolve().parent))


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, STAGING / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _ToolShell:
    """These tests exercise cashier logic; MCP registration belongs to the Hermes environment."""
    def __init__(self, name):
        pass

    def tool(self):
        return lambda function: function


with patch.dict(os.environ, PAIOS_FAKE_PHONE_LOG=os.devnull), \
     patch('mcp.server.MCPServer', _ToolShell, create=True):
    fake = load('payment_fake_phone', 'fake_phone.py')
runner = load('payment_scenario_runner', 'run_scenarios.py')


class FakeCashierTests(unittest.IsolatedAsyncioTestCase):
    async def test_read_only_reconciliation_can_be_cancelled_before_or_during_read(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        for started in (False, True):
            with self.subTest(started=started), tempfile.TemporaryDirectory() as tmp:
                from test_payment_lineage import seed
                seed(tmp, {"order_id":"order-A", "payee":"shop", "amount_fen":1660,
                    "order_namespace":"fixture", "item_identity":[["sku","tea"]]}, scope={"principal_id":"fixture-owner", "app":"千问"})
                entered = asyncio.Event()
                async def read():
                    entered.set()
                    await asyncio.Event().wait()
                cashier = SimpleNamespace(scenario={}, status='unknown', read=read, tap=AsyncMock())
                with patch.dict(os.environ, PAIOS_ERRAND_SPOOL=tmp), patch.object(fake, 'LOG', os.devnull), \
                     patch.object(fake, '_cashier', cashier), patch.object(fake, '_cashier_scope', ('fixture-owner', '千问')):
                    job = (await fake.phone_task('从当前页面继续：只读核对原订单', app='千问', principal_id='fixture-owner', effect={"kind": "read", "task_type": "read_app", "requested": True}))['job_id']
                    if started:
                        await asyncio.wait_for(entered.wait(), 1)
                    progress = json.loads((Path(tmp) / f'{job}.running.json').read_text())
                    self.assertEqual(progress['principal_id'], 'fixture-owner')
                    self.assertEqual(progress['state'], 'running' if started else 'waiting')
                    self.assertTrue(0 < len(progress['title']) <= 40)
                    self.assertEqual((progress['step'], progress['max_steps']), (0, 80))
                    await fake.phone_cancel(job)
                    result = json.loads((Path(tmp) / f'{job}.done.json').read_text())
                    self.assertEqual(result['terminal_reason'], 'cancelled_by_user')
                    self.assertNotIn('payment_intent', result)
                    self.assertEqual(result['payment_reconciliation']['state'], 'unknown')
                    self.assertNotIn(job, fake._jobs)
                    cashier.tap.assert_not_awaited()

    async def test_continuation_does_not_reuse_another_principals_same_app_order(self):
        from unittest.mock import AsyncMock
        cashier = fake.FakeCashier({'amount_fen': 1660, 'payee': '一点点', 'items': ['奶茶']})
        with tempfile.TemporaryDirectory() as tmp:
            scenario = Path(tmp) / 'cashier.json'
            scenario.write_text(json.dumps(cashier.scenario))
            from test_payment_lineage import seed
            owner = seed(tmp, {"order_id":"order-B", "payee":"shop-B", "amount_fen":1660,
                "order_namespace":"fixture", "item_identity":[["sku","tea"]]},
                scope={"principal_id":"owner-b", "app":"千问"})
            with patch.dict(os.environ, PAIOS_ERRAND_SPOOL=tmp, PAIOS_FAKE_CASHIER=str(scenario)), \
                 patch.object(fake, 'LOG', os.devnull), patch.object(fake, '_cashier', cashier), \
                 patch.object(fake, '_cashier_scope', ('owner-a', '千问')), \
                 patch.object(cashier, 'read', new_callable=AsyncMock) as read, \
                 patch.object(cashier, 'tap', new_callable=AsyncMock) as tap:
                for intent in (None, 'pi-owner-b'):
                    started = await fake.phone_task('从当前页面继续：核对原订单', payment_intent=intent,
                                                    app='千问', principal_id='owner-b', tier='careful', effect={"kind": "read", "task_type": "read_app", "requested": True})
                    job = started['job_id']
                    await fake._jobs[job]['task']
                    result = json.loads((Path(tmp) / f'{job}.done.json').read_text())
                    self.assertEqual((result['principal_id'], result['tier']), ('owner-b', 'careful'))
                    if intent is None:
                        self.assertEqual(result['payment_reconciliation'], {
                            'of_job':owner['of_job'], 'intent_id':owner['intent_id'], 'state':'unknown'})
                        self.assertNotIn('payment_intent', result)
                    else:
                        self.assertFalse(result['success'])
                        self.assertEqual(result['payment_intent'], intent)
                    self.assertNotIn(job, fake._jobs)
                read.assert_not_awaited()
                tap.assert_not_awaited()
                self.assertEqual(fake._cashier_scope, ('owner-a', '千问'))

    async def test_screen_changes_prompt_and_simulated_crash(self):
        cashier = fake.FakeCashier({'amount_fen': 1660, 'payee': '一点点', 'items': ['香柠养乐多'],
                                    'change_after_grant_to': 1860, 'verify_prompt_after_grant': True,
                                    'crash_after_tap': True, 'order_cancel_ok': False})
        first, after = await cashier.read(), await cashier.read()
        self.assertEqual((first.amount_fen, first.payee, first.items, first.verify), (1660, '一点点', ('香柠养乐多',), False))
        self.assertEqual((after.amount_fen, after.verify), (1860, True))
        self.assertNotEqual(first.screen_sha256, after.screen_sha256)
        self.assertTrue(first.order_id.startswith('fake-order-'))
        self.assertEqual(after.order_id, first.order_id)
        with self.assertRaisesRegex(RuntimeError, 'synthetic crash'):
            await cashier.tap(100, 200)
        self.assertEqual(cashier.taps, 1)
        self.assertEqual(await cashier.cancel_order(), {'outcome': 'failed'})

    async def test_background_shared_checkpoint_and_durable_spool(self):
        module = fake._checkpoint_module()
        entered, release = asyncio.Event(), asyncio.Event()
        class Checkpoint:
            def __init__(self, client, read, tap, cancel_order, config=None):
                self.read = read
                self.payment_id = 'pay-test'
            async def run(self, intent, job, app):
                self_screen = await self.read()
                assert (intent, app, self_screen.amount_fen) == ('pi-test', '千问', 1660)
                entered.set()
                await release.wait()
                return {'success': True, 'answer': '【已付款】¥16.6 一点点；点卡片'}
        with tempfile.TemporaryDirectory() as tmp:
            scenario = Path(tmp) / 'cashier.json'
            scenario.write_text(json.dumps({'amount_fen': 1660, 'payee': '一点点', 'items': ['香柠养乐多']}))
            log = Path(tmp) / 'fake-phone.jsonl'
            with patch.dict(os.environ, PAIOS_FAKE_CASHIER=str(scenario), PAIOS_ERRAND_SPOOL=tmp), patch.object(fake, 'LOG', str(log)), \
                 patch.object(module, 'PaymentCheckpoint', Checkpoint), \
                 patch.object(module.CheckpointConfig, 'from_env', return_value=object()), \
                 patch.object(module.PaymentHTTPClient, 'from_env', return_value=object()):
                started = await fake.phone_task('点「支付宝付款」付款', payment_intent='pi-test', app='千问', principal_id='owner', effect={"kind": "external", "task_type": "purchase_errand", "requested": True})
                job_id = started['job_id']
                task = fake._jobs[job_id]['task']
                waiting = Path(tmp) / f'{job_id}.running.json'
                self.assertEqual(json.loads(waiting.read_text())['state'], 'waiting')
                self.assertEqual(json.loads(waiting.read_text())['payment_intent'], 'pi-test')
                await entered.wait()
                running = Path(tmp) / f'{job_id}.running.json'
                self.assertEqual(json.loads(running.read_text())['state'], 'running')
                self.assertEqual(json.loads(running.read_text())['payment_intent'], 'pi-test')
                release.set()
                await task
                done = Path(tmp) / f'{job_id}.done.json'
                record = json.loads(done.read_text())
                self.assertEqual(set(record), {'principal_id', 'job_id', 'task', 'app', 'tier', 'success', 'answer', 'finished_at', 'terminal_reason', 'retryable', 'payment_intent', 'payment_binding', 'payment_outcome', 'phone_started_at', 'started_at'})
                self.assertEqual(record['payment_intent'], 'pi-test')
                self.assertEqual(record['principal_id'], 'owner')
                self.assertTrue(record['success'])
                self.assertEqual(done.stat().st_mode & 0o777, 0o600)
                self.assertFalse(running.exists())
                self.assertNotIn(job_id, fake._jobs)
                traces = [json.loads(line) for line in log.read_text().splitlines()]
                self.assertEqual(traces[0]['result'], {'status': 'started', 'job_id': job_id})
                self.assertEqual(traces[1]['args'], {'payment_intent': 'pi-test', 'job_id': job_id, 'app': '千问'})
                self.assertEqual(traces[1]['result'], {'checkpoint_reached': True, 'success': True,
                    'terminal_reason': 'completed', 'taps': 0, 'order_id': fake._cashier.order_id})
                self.assertNotIn('grant', json.dumps(traces))

    async def test_shared_workflow_cashier_outcomes(self):
        module = fake._checkpoint_module()
        for options, expected, taps in [({}, '【已付款】', 1),
                ({'change_after_grant_to': 1860}, '【已付款】', 1),
                ({'verify_prompt_after_grant': True}, '【没有付款】', 0),
                ({'crash_after_tap': True}, '【付款结果不明】', 1),
                ({'order_cancel_ok': False, 'cancelled': True}, '没取消成功', 0)]:
            with self.subTest(options=options):
                cashier = fake.FakeCashier({'amount_fen': 1660, 'payee': '一点点', 'items': ['香柠养乐多'], **options})
                events = []
                class Client:
                    async def request(self, method, path, body=None, timeout_s=None):
                        events.append((method, path, body))
                        if path == '/checkpoints':
                            return {'payment_id': 'pay-first', 'expires_at_ms': 10000, 'server_now_ms': 0}
                        if method == 'GET':
                            return {'payment_id': 'pay-next' if 'pay-next' in path else 'pay-first', 'state': 'cancelled' if options.get('cancelled') else 'granted',
                                    'version': 1, 'expires_at_ms': 10000, 'server_now_ms': 0, 'method': 'card',
                                    'grant': {'grant_id': 'grant-secret', 'amount_fen': 1860 if 'pay-next' in path else 1660,
                                              'expires_at_ms': 10000, 'max_taps': 2}}
                        if path.endswith('/amount-changed'):
                            assert cashier.taps == 0
                            return {'state': 'superseded', 'next': {'payment_id': 'pay-next', 'expires_at_ms': 10000}}
                        if path.endswith('/tap'):
                            assert body['read_amount_fen'] == (1860 if options.get('change_after_grant_to') else 1660)
                            assert cashier.taps == 0
                        if path.endswith('/result'):
                            return {'state': 'paid' if body['outcome'] == 'paid' else 'outcome_unknown'}
                        return {'ok': True}
                result = await module.PaymentCheckpoint(Client(), cashier.read, cashier.tap, cashier.cancel_order).run('pi-test', 'job-test', '千问')
                self.assertIn(expected, result['answer'])
                self.assertEqual(cashier.taps, taps)
                self.assertNotIn('grant-secret', result['answer'])
                if options.get('crash_after_tap'):
                    self.assertEqual([body['outcome'] for _, path, body in events if path.endswith('/result')], ['unknown'])
                if options.get('verify_prompt_after_grant'):
                    self.assertFalse(any(path.endswith('/order-cancel') for _, path, _ in events))

    async def test_terminal_provenance_on_failure_cancellation_and_prestart_stop(self):
        module = fake._checkpoint_module()
        for ending in ('failure', 'exception', 'cancel', 'prestart'):
            with self.subTest(ending=ending), tempfile.TemporaryDirectory() as tmp:
                scenario = Path(tmp) / 'cashier.json'
                scenario.write_text(json.dumps({'amount_fen': 1660, 'payee': '一点点', 'items': ['饮品']}))
                entered = asyncio.Event()
                class Checkpoint:
                    payment_id = None
                    def __init__(self, *args, **kwargs):
                        pass
                    async def run(self, intent, job, app):
                        entered.set()
                        if ending == 'exception':
                            raise RuntimeError('before checkpoint')
                        if ending == 'cancel':
                            await asyncio.Event().wait()
                        return {'success': False, 'answer': '失败', 'payment_intent': 'pi-forged'}
                with patch.dict(os.environ, PAIOS_FAKE_CASHIER=str(scenario), PAIOS_ERRAND_SPOOL=tmp), \
                     patch.object(module, 'PaymentCheckpoint', Checkpoint), \
                     patch.object(module.CheckpointConfig, 'from_env', return_value=object()), \
                     patch.object(module.PaymentHTTPClient, 'from_env', return_value=object()):
                    started = await fake.phone_task('测试付款', payment_intent='pi-owner', app='千问', principal_id='owner', effect={"kind": "external", "task_type": "purchase_errand", "requested": True})
                    jid = started['job_id']
                    job = fake._jobs[jid]
                    self.assertEqual(job['payment_intent'], 'pi-owner')
                    if ending == 'prestart':
                        await fake.phone_cancel(jid)
                        self.assertFalse(entered.is_set())
                    elif ending == 'cancel':
                        await entered.wait()
                        await fake.phone_cancel(jid)
                    else:
                        await job['task']
                    done = json.loads((Path(tmp) / f'{jid}.done.json').read_text())
                    self.assertEqual(done['payment_intent'], 'pi-owner')
                    self.assertEqual(done['principal_id'], 'owner')
                    self.assertFalse(done['success'])
                    self.assertNotIn('pi-forged', json.dumps(done))

    async def test_no_intent_preserves_nonpayment_fake(self):
        self.assertNotIn('pay_limit_yuan', inspect.signature(fake.phone_task).parameters)
        effect = inspect.signature(fake.phone_task).parameters['effect']
        self.assertEqual(effect.kind, inspect.Parameter.KEYWORD_ONLY)
        self.assertIs(effect.default, inspect.Parameter.empty)
        for goal in ('看看微信', '从当前页面继续：看看微信'):
            with patch.dict(os.environ, {}, clear=True):
                result = await fake.phone_task(goal, app='微信', principal_id='owner', effect={"kind": "read", "task_type": "read_app", "requested": True})
            self.assertEqual(result['status'], 'started')
            self.assertNotIn('task', fake._jobs.pop(result['job_id']))

    def test_payment_admission_requests_and_native_trace(self):
        from urllib.error import HTTPError
        requests = []
        session, event_id, run_id = 'staging-private', 'D/payment-source', 'run-admitted'
        accepted = {'processed_event': {'processed_event_id': event_id, 'device_type': 'phone',
                    'origin': 'explicit_user_prompt', 'content': {'text': '开免密'}}, 'admission': {'run_id': run_id}}
        result = {'schema_version': 'paios.result.v1', 'result_status': 'completed', 'run_id': run_id,
                  'session_id': session, 'processed_event_id': event_id, 'reply_text': '请在 iPhone 设置 → 支付与安全里改。'}
        def urlopen(request, timeout):
            requests.append((request.full_url, request.get_method(), request.data, request.get_header('Authorization'), timeout))
            if request.get_method() == 'POST':
                return io.StringIO(json.dumps(accepted))
            if len(requests) == 2:
                raise HTTPError(request.full_url, 409, 'pending', {}, io.BytesIO(b'{"error_code":"OUTPUT_NATIVE_NOT_TERMINAL"}'))
            return io.StringIO(json.dumps({'result': result}))
        config = {'request_timeout_s': 4, 'run_timeout_s': 10, 'poll_s': .01}
        binding = type('Binding', (), {'authority': 'http://127.0.0.1:19999', 'open': staticmethod(urlopen)})()
        with patch.object(runner.time, 'sleep'):
            lineage = runner._payment_turn(binding, 'paired-test-phone-key', session, '开免密', config)
        self.assertEqual(lineage, {'accepted': accepted, 'result': result})
        self.assertEqual(requests[0][:2], ('http://127.0.0.1:19999/v1/prompts', 'POST'))
        body = json.loads(requests[0][2])
        self.assertEqual(set(body), {'event_id', 'captured_at', 'text', 'session_id'})
        self.assertEqual((body['text'], body['session_id']), ('开免密', session))
        self.assertTrue(all('/v1/runs' not in url and auth == 'Bearer paired-test-phone-key' and timeout == 4
                            for url, _, _, auth, timeout in requests))
        self.assertIn('/v1/events/D%2Fpayment-source/result?session_id=staging-private', requests[-1][0])
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / 'state.db'
            with closing(sqlite3.connect(database)) as db, db:
                db.execute('CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,tool_call_id TEXT,tool_calls TEXT)')
                calls = [{'id': 'call-intent', 'function': {'name': 'paios_payment', 'arguments': '{"action":"request"}'}},
                         {'id': 'call-phone', 'function': {'name': 'phone_task', 'arguments': '{"payment_intent":"pi-admitted","app":"千问"}'}}]
                for i, call in enumerate(calls):
                    db.execute('INSERT INTO messages VALUES(?,?,?,?,?,?)', (2*i, session, 'assistant', '', None, json.dumps([call])))
                    receipt = {'status': 'accepted', 'intent_id': 'pi-admitted'} if i == 0 else {'status': 'started', 'job_id': 'job-test'}
                    db.execute('INSERT INTO messages VALUES(?,?,?,?,?,?)', (2*i+1, session, 'tool', json.dumps(receipt), call['id'], None))
            trace = runner._payment_trace(database, session)
            runner.assert_payment_scenario('payment-typed-order', trace, '开始办了', [
                {'tool': 'phone_task', 'args': {'payment_intent': 'pi-admitted', 'app': '千问'}, 'result': {'status': 'started', 'job_id': 'job-test'}},
                {'tool': 'payment_checkpoint', 'args': {'payment_intent': 'pi-admitted', 'app': '千问', 'job_id': 'job-test'},
                 'result': {'checkpoint_reached': True}}])
            self.assertEqual(trace[0]['result']['intent_id'], trace[1]['args']['payment_intent'])
        wrong_result = {**result, 'run_id': 'unbound-native-run'}
        with patch.object(binding, 'open', side_effect=[io.StringIO(json.dumps(accepted)),
                io.StringIO(json.dumps({'result': wrong_result}))]):
            with self.assertRaises(AssertionError):
                runner._payment_turn(binding, 'test-key', session, '开免密', config)

    def test_payment_model_trace_contracts(self):
        calls = [{'tool': 'paios_payment', 'args': {'action': 'request'},
                  'result': {'status': 'accepted', 'intent_id': 'pi-test'}},
                 {'tool': 'phone_task', 'args': {'payment_intent': 'pi-test', 'app': '千问'},
                  'result': {'status': 'started', 'job_id': 'job-test'}}]
        evidence = [{'tool': 'phone_task', 'args': {'payment_intent': 'pi-test', 'app': '千问'}, 'result': {'status': 'started', 'job_id': 'job-test'}},
                    {'tool': 'payment_checkpoint', 'args': {'payment_intent': 'pi-test', 'app': '千问', 'job_id': 'job-test'},
                     'result': {'checkpoint_reached': True}}]
        runner.assert_payment_scenario('payment-typed-order', calls, '开始办了', evidence)
        with self.assertRaises(AssertionError):
            runner.assert_payment_scenario('payment-typed-order', list(reversed(calls)), '')
        runner.assert_payment_scenario('payment-no-card', [], '现在没有待付款卡片。')
        with self.assertRaises(AssertionError):
            runner.assert_payment_scenario('payment-no-card', [], '付好了')
        runner.assert_payment_scenario('payment-settings', [], '请在 iPhone 设置 → 支付与安全里开启免密。')
        runner.assert_payment_scenario('payment-settings', [{'tool': 'paios_open_reply', 'args': {}}],
                                       '请在 iPhone 设置 → 支付与安全里开启免密。')
        with self.assertRaises(AssertionError):
            runner.assert_payment_scenario('payment-settings', calls[:1], '请去设置')


if __name__ == '__main__':
    unittest.main()
