"""Existing-spool ownership, exact shared fixture, terminal and fake lifecycle paths."""
import asyncio
import contextlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
import payment_lineage
import server

FIXTURE = json.loads('{"job_id":"job-0123456789ab","task":"从当前页面继续：只读核对订单","success":true,"answer":"【付款核对】未付款","finished_at":"2026-10-16T06:00:00Z","app":"千问","payment_reconciliation":{"of_job":"job-a1b2c3d4e5f6","intent_id":"pi-6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f","state":"unpaid"}}')
SCOPE = {"principal_id": "owner", "app": "千问"}
FIXTURE = {**FIXTURE, **SCOPE}
OWNER = {k:v for k,v in FIXTURE['payment_reconciliation'].items() if k != 'state'}

def seed(folder, binding=None, scope=None):
    scope = SCOPE if scope is None else scope
    record = {**scope, 'job_id': OWNER['of_job'], 'payment_intent': OWNER['intent_id'], 'task':'付款',
        'phone_started_at':'2026-10-16T05:00:00Z', 'payment_outcome':'unknown',
        'finished_at':'2026-10-16T05:01:00Z', 'payment_binding':binding}
    Path(folder, record['job_id'] + '.delivered.json').write_text(json.dumps(record))
    return payment_lineage.unresolved(folder, **scope)

class Lineage(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = self.tmp.name
        self.owner = seed(self.folder)
        self.enterContext(patch.object(server,'SPOOL',self.folder))
        self.enterContext(patch.object(server,'_jobs',{}))

    def test_capture_follows_each_gateway_rename(self):
        for previous, following in (('done','notified'), ('notified','delivered'),
                                    ('done','delivery-failed'), ('notified','delivery-failed'),
                                    ('delivery-failed','invalid')):
            with self.subTest(previous=previous):
                seed(self.folder)
                original = Path(self.folder, OWNER['of_job']+'.delivered.json')
                record = json.loads(original.read_text())
                record.update(success=False, answer='unknown', finished_at='2026-10-16T05:01:00.000Z',
                              delivery_failure={'error_code':'ERRAND_REPORT_NOT_DELIVERED', 'failed_at':'2026-10-16T05:02:00.000Z'})
                original.write_text(json.dumps(record))
                moving = original.with_name(OWNER['of_job']+'.'+previous+'.json')
                original.rename(moving)
                read = Path.read_text
                def rename_before_open(path, *args, **kwargs):
                    if path == moving:
                        path.rename(path.with_name(OWNER['of_job']+'.'+following+'.json'))
                    return read(path, *args, **kwargs)
                with patch.object(Path, 'read_text', rename_before_open):
                    self.assertEqual(payment_lineage.capture(self.folder, {**SCOPE, 'goal':FIXTURE['task']}), self.owner)

    def test_delivery_failure_preserves_owner_and_scoped_clear_facts(self):
        for state in ('delivery-failed', 'invalid'):
            with self.subTest(state=state):
                source = Path(self.folder, OWNER['of_job']+'.delivered.json')
                seed(self.folder)
                record = json.loads(source.read_text())
                record.update(success=False, answer='unknown', finished_at='2026-10-16T05:01:00.000Z',
                              delivery_failure={'error_code':'ERRAND_REPORT_NOT_DELIVERED', 'failed_at':'2026-10-16T05:02:00.000Z'})
                source.write_text(json.dumps(record))
                failed = source.with_name(OWNER['of_job']+'.'+state+'.json')
                source.rename(failed)
                server._recover_interrupted()
                self.assertEqual(payment_lineage.capture(self.folder, {**SCOPE, 'goal':FIXTURE['task']}), self.owner)
                for change in ({'payment_reconciliation':FIXTURE['payment_reconciliation']}, {'payment_page_left':True}):
                    clear = {**FIXTURE, **change, 'delivery_failure':record['delivery_failure'], 'finished_at':'2026-10-16T06:00:00.000Z'}
                    clear_path = Path(self.folder, FIXTURE['job_id']+'.'+state+'.json')
                    clear_path.write_text(json.dumps(clear))
                    self.assertIsNone(payment_lineage.capture(self.folder, {**SCOPE, 'goal':FIXTURE['task']}))
                    clear_path.unlink()
                failed.unlink()

    def test_unverified_quarantine_cannot_clear_payment_owner(self):
        Path(self.folder, FIXTURE['job_id']+'.invalid.json').write_text(json.dumps(FIXTURE))
        self.assertEqual(payment_lineage.capture(self.folder, {**SCOPE, 'goal':FIXTURE['task']}), self.owner)

    def test_malformed_quarantine_does_not_hide_valid_unknown_owner(self):
        path = Path(self.folder, FIXTURE['job_id']+'.invalid.json')
        for content in ('{broken', 'null', '42', '[]'):
            with self.subTest(content=content):
                path.write_text(content)
                self.assertEqual(payment_lineage.capture(self.folder, {**SCOPE, 'goal':FIXTURE['task']}), self.owner)

    def test_corrupted_delivery_failure_quarantine_fails_closed(self):
        record = {**FIXTURE, 'finished_at':'2026-10-16T06:00:00.000Z', 'success':'corrupted',
                  'delivery_failure':{'error_code':'ERRAND_REPORT_NOT_DELIVERED', 'failed_at':'2026-10-16T06:01:00.000Z'}}
        Path(self.folder, FIXTURE['job_id']+'.invalid.json').write_text(json.dumps(record))
        with self.assertRaisesRegex(ValueError, 'ERRAND_TERMINAL_UNREADABLE'):
            payment_lineage.capture(self.folder, {**SCOPE, 'goal':FIXTURE['task']})

    async def test_failed_delivery_dispatch_recaptures_and_checks_bound_order(self):
        from dataclasses import replace
        from payment_checkpoint import PaymentBinding
        from test_payment_checkpoint import CARD
        current = replace(CARD, payment_statuses=('支付状态：待支付',), page_title='订单详情')
        bound = PaymentBinding(current.order_id, current.payee, current.amount_fen,
                               current.order_namespace, current.item_identity, current.item_facts)
        @contextlib.asynccontextmanager
        async def lease():
            yield
        for state in ('delivery-failed', 'invalid'):
            with self.subTest(state=state), contextlib.ExitStack() as stack:
                owner = seed(self.folder, payment_lineage.remember(bound))
                source = Path(self.folder, OWNER['of_job']+'.delivered.json')
                record = json.loads(source.read_text())
                record.update(success=False, answer='unknown', finished_at='2026-10-16T05:01:00.000Z',
                              delivery_failure={'error_code':'ERRAND_REPORT_NOT_DELIVERED', 'failed_at':'2026-10-16T05:02:00.000Z'})
                source.write_text(json.dumps(record))
                failed = source.with_name(OWNER['of_job']+'.'+state+'.json')
                source.rename(failed)
                stack.callback(failed.unlink)
                jid = FIXTURE['job_id']
                job = {**SCOPE, 'goal':FIXTURE['task'], 'state':'waiting', 'tier':'deterministic'}
                stack.enter_context(patch.object(server, '_jobs', {jid:job}))
                token = server._job_id.set(jid)
                stack.callback(server._job_id.reset, token)
                for name, value in {'PHONE_PROVIDER':'adb', '_one_phone':asyncio.Lock(), '_device_lease':lease,
                        '_online':lambda *_:True, '_owner_active':lambda:False, '_preflight':lambda *_:None,
                        '_ensure_unlocked':lambda *_:None, '_ensure_cn_identity':lambda **_:None,
                        '_sleep_later':lambda:None, '_at_checkout':lambda:True}.items():
                    stack.enter_context(patch.object(server, name, value))
                shell = stack.enter_context(patch.object(server, '_shell', return_value='null'))
                stack.enter_context(patch.object(server, '_driver', AsyncMock(return_value=object())))
                stack.enter_context(patch.object(server, '_agent', AsyncMock(return_value={'success':True, 'answer':'done'})))
                screen = stack.enter_context(patch.object(server, '_payment_screen', AsyncMock(return_value=current)))
                result = await server._errand_task(FIXTURE['task'], 10, None, None, None, SCOPE['app'], 'fast')
                self.assertEqual(job['payment_owner'], owner)
                screen.assert_awaited_once()
                self.assertEqual(result['payment_reconciliation'], {**FIXTURE['payment_reconciliation'], 'state':'unpaid'})
                self.assertFalse(any(any(word in str(call) for word in ('BACK','HOME','monkey','force-stop')) for call in shell.call_args_list))

    def test_capture_follows_both_renames_and_keeps_clear_record(self):
        moving = Path(self.folder, FIXTURE['job_id']+'.done.json')
        moving.write_text(json.dumps(FIXTURE))
        Path(self.folder, FIXTURE['job_id']+'.running.json').write_text(json.dumps({**SCOPE,
            'job_id':FIXTURE['job_id'], 'started_at':'2026-10-16T06:00:00Z'}))
        read = Path.read_text
        def rename_before_open(path, *args, **kwargs):
            if path.name == FIXTURE['job_id']+'.done.json':
                path.rename(path.with_name(FIXTURE['job_id']+'.notified.json'))
            elif path.name == FIXTURE['job_id']+'.notified.json':
                path.rename(path.with_name(FIXTURE['job_id']+'.delivered.json'))
            return read(path, *args, **kwargs)
        with patch.object(Path, 'read_text', rename_before_open):
            self.assertIsNone(payment_lineage.capture(self.folder, {**SCOPE, 'goal':FIXTURE['task']}))
        self.assertTrue(Path(self.folder, FIXTURE['job_id']+'.delivered.json').exists())

    def test_vanished_terminal_never_downgrades_to_older_state(self):
        for state, older in (('done','running'), ('notified','done'), ('delivered','notified')):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as folder:
                jid = OWNER['of_job']
                terminal = Path(folder, jid+'.'+state+'.json')
                terminal.write_text(json.dumps({**SCOPE, 'job_id':jid, 'payment_intent':OWNER['intent_id'],
                    'phone_started_at':'2026-10-16T05:00:00Z', 'payment_outcome':'unknown'}))
                Path(folder, jid+'.'+older+'.json').write_text(json.dumps({**SCOPE, 'job_id':jid,
                    'payment_intent':OWNER['intent_id'], 'phone_started_at':None}))
                read = Path.read_text
                def disappear_before_open(path, *args, **kwargs):
                    if path == terminal:
                        path.unlink()
                    return read(path, *args, **kwargs)
                with patch.object(Path, 'read_text', disappear_before_open):
                    with self.assertRaises(FileNotFoundError):
                        payment_lineage.capture(folder, {**SCOPE, 'goal':FIXTURE['task']})

    def test_disappeared_unresolvable_job_fails_closed_with_bounded_relists(self):
        read, glob = Path.read_text, Path.glob
        relists = []
        def disappear_before_open(path, *args, **kwargs):
            path.unlink()
            return read(path, *args, **kwargs)
        def counted_glob(path, pattern):
            if pattern == OWNER['of_job']+'.*.json':
                relists.append(pattern)
            return glob(path, pattern)
        with patch.object(Path, 'read_text', disappear_before_open), patch.object(Path, 'glob', counted_glob):
            with self.assertRaises(FileNotFoundError):
                payment_lineage.capture(self.folder, {**SCOPE, 'goal':FIXTURE['task']})
        self.assertEqual(len(relists), 3)

    def test_lineage_capture_and_clears_are_scoped_by_principal_and_exact_app(self):
        foreign = {**SCOPE, 'principal_id':'other', 'job_id':'job-ffffffffffff',
            'payment_intent':'other-intent', 'phone_started_at':'2026-10-16T07:00:00Z',
            'payment_outcome':'unknown'}
        server._spool(foreign['job_id'], foreign, 'done')
        other = payment_lineage.unresolved(self.folder, 'other', SCOPE['app'])
        self.assertEqual(other['intent_id'], 'other-intent')
        task = {**SCOPE, 'goal':FIXTURE['task']}
        self.assertEqual(payment_lineage.capture(self.folder, task), self.owner)
        self.assertIsNone(payment_lineage.capture(self.folder, {**task, 'app':'微信'}))
        with self.assertRaises(KeyError):
            payment_lineage.capture(self.folder, {'goal':FIXTURE['task'], 'app':'千问'})
        with self.assertRaisesRegex(ValueError, 'ERRAND_PRINCIPAL_REQUIRED'):
            payment_lineage.unresolved(self.folder, '', '千问')
        for scope in ({**SCOPE, 'principal_id':'other'}, {**SCOPE, 'app':'微信'}):
            for change in ({'payment_page_left':True}, {'payment_intent':'foreign', 'payment_outcome':'paid'},
                           {'payment_reconciliation':FIXTURE['payment_reconciliation']}):
                server._spool('job-eeeeeeeeeeee', {**scope, 'job_id':'job-eeeeeeeeeeee',
                    'phone_started_at':'2026-10-16T08:00:00Z', **change}, 'done')
                self.assertEqual(payment_lineage.unresolved(self.folder, **SCOPE), self.owner)
        for rec in ({**FIXTURE['payment_reconciliation'], 'intent_id':'wrong-intent'},
                    {**FIXTURE['payment_reconciliation'], 'of_job':'job-000000000000'}):
            server._spool(FIXTURE['job_id'], {**FIXTURE, 'payment_reconciliation':rec}, 'done')
            self.assertEqual(payment_lineage.unresolved(self.folder, **SCOPE), self.owner)
        with self.assertRaisesRegex(ValueError, 'PAYMENT_LINEAGE_SCOPE'):
            payment_lineage.terminal({**SCOPE, 'payment_owner':other}, {})

    def test_exact_shared_fixture_and_clear_states(self):
        for state in ('paid','unpaid'):
            got = payment_lineage.terminal({**SCOPE, 'payment_owner':self.owner}, {'payment_observation':{'state':state,'order_id':'private'}})
            self.assertEqual(got, {'payment_reconciliation':{**FIXTURE['payment_reconciliation'],'state':state}})
            server._spool(FIXTURE['job_id'], {**FIXTURE, **got}, 'done')
            self.assertIsNone(payment_lineage.unresolved(self.folder, **SCOPE))
            Path(self.folder,FIXTURE['job_id']+'.done.json').unlink()

    def test_queued_preserves_owner_started_payment_and_leave_clear(self):
        queued = {**SCOPE, 'job_id':'job-ffffffffffff','started_at':'2026-10-16T07:00:00Z','state':'waiting','payment_intent':'new'}
        server._spool(queued['job_id'],queued,'running')
        self.assertEqual(payment_lineage.unresolved(self.folder, **SCOPE),self.owner)
        server._spool(queued['job_id'],{**queued,'phone_started_at':'2026-10-16T07:00:01Z','payment_outcome':'unpaid'},'done')
        self.assertIsNone(payment_lineage.unresolved(self.folder, **SCOPE))
        Path(self.folder,queued['job_id']+'.done.json').unlink()
        server._spool('job-eeeeeeeeeeee',{**SCOPE, 'job_id':'job-eeeeeeeeeeee','phone_started_at':'2026-10-16T08:00:00Z','payment_page_left':True},'done')
        self.assertIsNone(payment_lineage.unresolved(self.folder, **SCOPE))

    def test_legacy_running_terminal_and_waiting_across_restart(self):
        legacy = {**SCOPE, 'job_id':'job-ffffffffffff', 'started_at':'2026-10-16T07:00:00Z',
                  'payment_intent':OWNER['intent_id'], 'task':'legacy payment'}
        for state in ('running', 'waiting'):
            with self.subTest(state=state):
                server._spool(legacy['job_id'], {**legacy, 'state':state}, 'running')
                server._recover_interrupted()
                record = json.loads(Path(self.folder, legacy['job_id']+'.done.json').read_text())
                self.assertEqual(record['payment_outcome'], 'unknown' if state == 'running' else 'unpaid')
                owner = payment_lineage.unresolved(self.folder, **SCOPE)
                self.assertEqual(owner['of_job'], legacy['job_id'] if state == 'running' else self.owner['of_job'])
                Path(self.folder, legacy['job_id']+'.done.json').unlink()
        server._spool(legacy['job_id'], {**legacy, 'terminal_reason':'failed',
            'finished_at':'2026-10-16T07:01:00Z', 'success':False}, 'done')
        owner = payment_lineage.unresolved(self.folder, **SCOPE)
        self.assertEqual(owner['of_job'], legacy['job_id'])
        self.assertIsNone(payment_lineage.binding(owner))
        server._recover_interrupted()
        self.assertEqual(payment_lineage.unresolved(self.folder, **SCOPE), owner)

    async def test_offline_or_owner_busy_payment_does_not_supersede(self):
        @contextlib.asynccontextmanager
        async def lease():
            yield
        for online in (False, True):
            jid = 'job-ffffffffffff'
            job = {**SCOPE, 'goal':'new payment', 'payment_intent':'new', 'phone_started_at':None,
                'state':'waiting', 'tier':'deterministic', 'started_at':'2026-10-16T07:00:00Z'}
            server._jobs[jid] = job
            server._spool(jid, {**job, 'job_id':jid}, 'running')
            token = server._job_id.set(jid)
            try:
                with patch.object(server, '_one_phone', asyncio.Lock()), patch.object(server, '_device_lease', lease), \
                     patch.object(server, 'PHONE_PROVIDER', 'adb'), patch.object(server, '_online', return_value=online), \
                     patch.object(server, '_owner_active', return_value=True), patch.object(server, 'OWNER_WAIT_S', -1):
                    with self.assertRaises(RuntimeError):
                        async with server._errand(None, None, 'new'):
                            self.fail('offline/busy must not reach the phone')
                self.assertIsNone(job['phone_started_at'])
                self.assertEqual(payment_lineage.unresolved(self.folder, **SCOPE), self.owner)
            finally:
                server._job_id.reset(token)

    async def test_real_generic_continuation_has_no_payment_projection(self):
        Path(self.folder, OWNER['of_job']+'.delivered.json').unlink()
        @contextlib.asynccontextmanager
        async def lease(*args, **kwargs):
            yield
        screen = AsyncMock()
        with patch.object(server, '_errand', lease), patch.object(server, '_payment_screen', screen), \
             patch.object(server, '_agent', AsyncMock(return_value={'success':True, 'answer':'ordinary result'})):
            result = await server._errand_task('从当前页面继续：查看消息', 10, None, None, None, None, 'fast')
        self.assertNotIn('payment_reconciliation', result)
        self.assertNotIn('payment_observation', result)
        self.assertEqual(result['answer'], 'ordinary result')
        screen.assert_not_awaited()

    async def test_failed_home_keeps_owner_successful_home_clears(self):
        @contextlib.asynccontextmanager
        async def lease(*args, **kwargs):
            yield
        for failed in (True, False):
            jid = 'job-ffffffffffff'
            job = {**SCOPE, 'goal':'查看消息', 'state':'running', 'tier':'deterministic',
                   'phone_started_at':'2026-10-16T07:00:00Z'}
            server._jobs[jid] = job
            token = server._job_id.set(jid)
            try:
                with patch.object(server, '_errand', lease), patch.object(server, '_shell',
                        side_effect=RuntimeError('HOME failed') if failed else None), \
                     patch.object(server, '_driver', AsyncMock(side_effect=RuntimeError('stop after HOME'))), \
                     patch.object(server, '_preflight', return_value=False), \
                     patch.object(server.asyncio, 'sleep', AsyncMock()):
                    await server._errand_task('查看消息', 10, None, None, None, '千问', 'fast')
                server._spool(jid, {**job, 'job_id':jid}, 'done')
                self.assertEqual(bool(job.get('payment_page_left')), not failed)
                self.assertEqual(payment_lineage.unresolved(self.folder, **SCOPE) is None, not failed)
            finally:
                server._job_id.reset(token)
                Path(self.folder, jid+'.done.json').unlink(missing_ok=True)

    async def test_durable_handoff_and_binding_failure_prevent_phone_input(self):
        from types import SimpleNamespace
        import payment_checkpoint
        from test_payment_checkpoint import CARD
        @contextlib.asynccontextmanager
        async def lease():
            yield
        jid = 'job-ffffffffffff'
        job = {**SCOPE, 'goal':'付款', 'title':'付款', 'app':'千问', 'tier':'fast', 'state':'waiting',
            'since':0, 'started_at':'2026-10-16T07:00:00Z', 'phone_started_at':None,
            'payment_intent':OWNER['intent_id'], 'step':0, 'max_steps':10, 'written':0}
        server._jobs[jid] = job
        server._spool(jid, {**job,'job_id':jid}, 'running')
        token = server._job_id.set(jid)
        original = server._spool
        def fail_handoff(job_id, record, state):
            if record.get('phone_started_at'):
                raise OSError('isolated write failure')
            original(job_id, record, state)
        try:
            with patch.object(server, '_one_phone', asyncio.Lock()), patch.object(server, '_device_lease', lease), \
                 patch.object(server, 'PHONE_PROVIDER', 'adb'), patch.object(server, '_online', return_value=True), \
                 patch.object(server, '_owner_active', return_value=False), patch.object(server, '_shell') as shell, \
                 patch.object(server, '_spool', side_effect=fail_handoff):
                with self.assertRaises(OSError):
                    async with server._errand(None, None, OWNER['intent_id']):
                        self.fail('no phone operation may follow a failed handoff write')
                shell.assert_not_called()
            self.assertIsNone(job['phone_started_at'])
            self.assertEqual(payment_lineage.unresolved(self.folder, **SCOPE), self.owner)
            class Checkpoint:
                def __init__(self, client, read, tap, cancel, config):
                    self.read, self.tap = read, tap
                async def run(self, *args):
                    await self.read()
                    await self.tap(1, 2)
            guard = SimpleNamespace(payment_intent=OWNER['intent_id'], inner=SimpleNamespace(tap=AsyncMock()))
            with patch.object(payment_checkpoint, 'PaymentCheckpoint', Checkpoint), \
                 patch.object(payment_checkpoint.PaymentHTTPClient, 'from_env', return_value=object()), \
                 patch.object(server, '_payment_screen', AsyncMock(return_value=CARD)), \
                 patch.object(server, '_spool', side_effect=OSError('binding write failed')):
                with self.assertRaises(OSError):
                    await server._checkpoint_payment(guard, {}, '千问')
            guard.inner.tap.assert_not_awaited()
        finally:
            server._job_id.reset(token)

    def test_restart_preserves_item_facts_for_conflict_check(self):
        from dataclasses import replace
        from payment_checkpoint import PaymentBinding, PaymentCheckpoint
        from test_payment_checkpoint import CARD
        original = replace(CARD, item_identity=(('sku','sku-A'),), item_facts=(('name','tea'),),
                           payment_statuses=('支付状态：待支付',))
        bound = PaymentBinding(original.order_id, original.payee, original.amount_fen,
            original.order_namespace, original.item_identity, original.item_facts)
        checkpoint = PaymentCheckpoint(None, None, None, None)
        checkpoint.binding = bound
        result = checkpoint._answer(False, 'unknown', outcome='unknown')
        self.assertNotIn('item_facts', bound.wire())
        seed(self.folder, result['payment_binding'])
        server._recover_interrupted()
        restored = payment_lineage.binding(payment_lineage.unresolved(self.folder, **SCOPE))
        self.assertEqual(restored.item_facts, bound.item_facts)
        self.assertEqual(original.reconciliation(restored)['state'], 'unpaid')
        conflicting = replace(original, item_facts=(('name','another product'),))
        self.assertEqual(conflicting.reconciliation(restored)['state'], 'unknown')

    async def test_fake_reconciliation_failure_and_timeout_stay_private(self):
        from types import SimpleNamespace
        from test_fake_cashier import fake
        bound = {'order_id':'order-A', 'payee':'shop', 'amount_fen':1660,
                 'order_namespace':'fixture', 'item_identity':[['sku','tea']]}
        for error, reason in ((RuntimeError('fixture failure'), 'failed'), (TimeoutError(), 'timed_out')):
            seed(self.folder, bound)
            cashier = SimpleNamespace(status='unknown', scenario={}, read=AsyncMock(side_effect=error))
            with patch.dict(os.environ, PAIOS_ERRAND_SPOOL=self.folder), patch.object(fake, 'LOG', os.devnull), \
                 patch.object(fake, '_jobs', {}), patch.object(fake, '_cashier', cashier), \
                 patch.object(fake, '_cashier_scope', ('owner', '千问')):
                jid = (await fake.phone_task(FIXTURE['task'], app='千问', principal_id='owner', effect={"kind": "external", "task_type": "purchase_errand", "requested": True}))['job_id']
                await fake._jobs[jid]['task']
                record = json.loads(Path(self.folder, jid+'.done.json').read_text())
                self.assertEqual(record['terminal_reason'], reason)
                self.assertFalse(record['success'])
                self.assertEqual(record['payment_reconciliation']['state'], 'unknown')

    async def test_success_failure_timeout_cancel_have_typed_lineage(self):
        task = dict(goal=FIXTURE['task'],app='千问',tier='fast',payment_intent=None)
        for result in ({'success':True,'answer':'done'},{'success':False,'answer':'仍未完成'},RuntimeError('failure'),TimeoutError(),asyncio.CancelledError()):
            with self.subTest(result=result):
                jid=FIXTURE['job_id']; server._jobs[jid]={**SCOPE, 'payment_owner':self.owner, 'title':'只读核对订单'}
                call=AsyncMock(side_effect=result) if isinstance(result,BaseException) else AsyncMock(return_value=result)
                with patch.object(server,'_errand_task',call):
                    await server._job(jid,task)
                rec=json.loads(Path(self.folder,jid+'.done.json').read_text())
                self.assertEqual(rec['payment_reconciliation'],{**FIXTURE['payment_reconciliation'],'state':'unknown'})
                self.assertNotIn('payment_intent',rec)
                self.assertEqual(rec['title'],'只读核对订单')
                if isinstance(result, TimeoutError):
                    self.assertEqual(rec['terminal_reason'], 'timed_out')

    def test_restart_preserves_owner_and_interrupted_reconciliation(self):
        server._spool(FIXTURE['job_id'],{**SCOPE, 'job_id':FIXTURE['job_id'],'payment_owner':self.owner,'task':FIXTURE['task'],'started_at':'2026-10-16T06:00:00Z'},'running')
        server._recover_interrupted()
        rec=json.loads(Path(self.folder,FIXTURE['job_id']+'.done.json').read_text())
        self.assertEqual(rec['terminal_reason'],'interrupted')
        self.assertEqual(rec['payment_reconciliation']['state'],'unknown')
        self.assertEqual(payment_lineage.unresolved(self.folder, **SCOPE),self.owner)

    def test_fake_restart_keeps_typed_lineage(self):
        from test_fake_cashier import fake
        server._spool(FIXTURE['job_id'], {**SCOPE, 'job_id':FIXTURE['job_id'], 'payment_owner':self.owner,
            'task':FIXTURE['task'], 'started_at':'2026-10-16T06:00:00Z'}, 'running')
        with patch.dict(os.environ, PAIOS_ERRAND_SPOOL=self.folder):
            fake._recover_interrupted()
        rec = json.loads(Path(self.folder, FIXTURE['job_id']+'.done.json').read_text())
        self.assertEqual(rec['terminal_reason'], 'interrupted')
        self.assertEqual(rec['payment_reconciliation']['state'], 'unknown')
        self.assertEqual(payment_lineage.unresolved(self.folder, **SCOPE), self.owner)

    async def test_fake_queued_payment_cancel_preserves_existing_owner(self):
        from test_fake_cashier import fake
        scenario = Path(self.folder, 'cashier.json')
        scenario.write_text(json.dumps({'amount_fen':1660, 'payee':'shop', 'items':['tea']}))
        for entered in (False, True):
            lock = asyncio.Lock()
            await lock.acquire()
            with patch.dict(os.environ, PAIOS_ERRAND_SPOOL=self.folder, PAIOS_FAKE_CASHIER=str(scenario)), \
                 patch.object(fake, 'LOG', os.devnull), patch.object(fake, '_jobs', {}), \
                 patch.object(fake, '_one_phone', lock):
                jid = (await fake.phone_task('new payment', payment_intent=OWNER['intent_id'], app='千问', principal_id='owner', effect={"kind": "external", "task_type": "purchase_errand", "requested": True}))['job_id']
                if entered:
                    await asyncio.sleep(0)  # The coroutine now waits behind the current phone owner.
                await fake.phone_cancel(jid)
                record = json.loads(Path(self.folder, jid+'.done.json').read_text())
                self.assertIn('started_at', record)
                self.assertIn('phone_started_at', record)
                self.assertIsNone(record['phone_started_at'])
                self.assertEqual(record['payment_outcome'], 'unpaid')
                self.assertEqual(payment_lineage.unresolved(self.folder, **SCOPE), self.owner)
            lock.release()

    async def test_fake_prestart_cancel_and_generic_continuation(self):
        from test_fake_cashier import fake
        with patch.dict(os.environ,PAIOS_ERRAND_SPOOL=self.folder), patch.object(fake,'LOG',os.devnull), patch.object(fake,'_jobs',{}):
            jid=(await fake.phone_task(FIXTURE['task'],app='千问',principal_id='owner', effect={"kind": "external", "task_type": "purchase_errand", "requested": True}))['job_id']
            await fake.phone_cancel(jid)
            rec=json.loads(Path(self.folder,jid+'.done.json').read_text())
            self.assertEqual(rec['payment_reconciliation']['state'],'unknown')
            self.assertNotIn('payment_intent',rec)
            Path(self.folder,OWNER['of_job']+'.delivered.json').unlink()
            jid=(await fake.phone_task(FIXTURE['task'],app='千问',principal_id='owner', effect={"kind": "external", "task_type": "purchase_errand", "requested": True}))['job_id']
            await fake._jobs[jid]['task']
            rec=json.loads(Path(self.folder,jid+'.done.json').read_text())
            self.assertNotIn('payment_reconciliation',rec)
            self.assertFalse(rec['answer'].startswith('【付款核对】'))

if __name__=='__main__': unittest.main()
