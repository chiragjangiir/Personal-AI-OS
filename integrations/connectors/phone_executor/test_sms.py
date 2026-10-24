"""Deterministic SMS dry-run with fake MCP, shell and phone; stdlib only, no device access."""
import asyncio
import contextlib
import importlib.util
import json
import os
import sys
import tempfile
import threading
import types
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

class FakeMCP:
    def __init__(self, *args, **kwargs): pass
    def tool(self): return lambda fn: fn

spec = importlib.util.spec_from_file_location('sms_server', Path(__file__).with_name('server.py'))
server = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'mcp': types.ModuleType('mcp'), 'mcp.server': types.ModuleType('mcp.server'),
                            'mcp.server.fastmcp': types.SimpleNamespace(FastMCP=FakeMCP)}):
    spec.loader.exec_module(server)

sms_nodes = server._sms_nodes
preflight = server._preflight
device_lease = server._device_lease
shell_command = server._shell
ensure_unlocked = server._ensure_unlocked

TO, TEXT, JID = '13800000000', "紧急提醒：请联系我 '现在'", 'job-0123456789ab'

def nodes(text=TEXT, recipient=TO, enabled='true'):
    return [dict(zip(('resource-id', 'package', 'text', 'enabled', 'clickable', 'bounds'), values)) for values in [
        ('com.android.messaging:id/compose_message_text', 'com.android.messaging', text, 'true', 'true', '[0,0][10,10]'),
        ('com.android.messaging:id/recipient_text_view', 'com.android.messaging', recipient, 'true', 'true', '[0,0][10,10]'),
        ('com.android.messaging:id/send_message_button', 'com.android.messaging', '', enabled, 'true', '[20,20][40,40]')]]

class SMS(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.commands = []
        for p in [patch.object(server, 'SPOOL', self.tmp.name), patch.object(server, '_shell', self.shell),
                  patch.object(server, '_online', lambda *_: True), patch.object(server, '_owner_active', lambda: False),
                  patch.object(server, '_ensure_unlocked', lambda stop: None), patch.object(server, '_sms_nodes', nodes),
                  patch.object(server, '_preflight', lambda stop, typing=False, portal=True: False),
                  patch.object(server, '_device_lease', self.lease), patch.object(server, '_one_phone', asyncio.Lock()),
                  patch.object(server.time, 'sleep', lambda _: None)]:
            p.start(); self.addCleanup(p.stop)
        server._jobs.clear()
        self.addCleanup(server._jobs.clear)

    @contextlib.asynccontextmanager
    async def lease(self): yield

    def shell(self, command, check=False):
        self.commands.append(command)
        if command.startswith('content query'):
            return 'Row: 0 _id=1\nRow: 1 _id=9' if any(c.startswith('input tap') for c in self.commands) else 'Row: 0 _id=1'
        if command.startswith('input tap'):
            claim = json.loads((self.folder / f'{JID}.running.json').read_text())
            self.assertEqual(claim['sms_phase'], 'send_attempted')
        return ''

    async def dispatch(self, **fields):
        request = self.folder / f'{JID}.request.json'
        request.write_text(json.dumps(dict(principal_id="owner", job_id=JID, kind='sms', to=TO, text=TEXT,
                                          deadline_ms=int(server.time.time() * 1000) + 60_000) | fields))
        server._scan_requests()
        task = server._jobs.get(JID, {}).get('task')
        if task: await task
        return json.loads((self.folder / f'{JID}.done.json').read_text())

    async def test_send_verified_once_and_duplicate_restart(self):
        with patch.object(server, '_load_model', side_effect=AssertionError('model used')):
            result = await self.dispatch()
            self.assertTrue(result['success'])
            await self.dispatch()
        self.assertEqual(sum(c.startswith('input tap') for c in self.commands), 1)
        self.assertIn('android.intent.action.SENDTO', next(c for c in self.commands if c.startswith('am start')))
        self.assertFalse(result['retryable'])

    async def test_cloud_phone_refuses_sms_before_device_access_or_cancelling_errands(self):
        finish = asyncio.Event()
        task = asyncio.create_task(finish.wait())
        server._jobs['job-aaaaaaaaaaaa'] = dict(tier='fast', task=task)
        with patch.object(server, 'PHONE_PROVIDER', 'agentbay'), \
             patch.object(server, '_request_stop', side_effect=AssertionError('cloud SMS cancelled an errand')), \
             patch.object(server, '_device_lease', side_effect=AssertionError('cloud SMS accessed a phone')):
            result = await self.dispatch()
        self.assertFalse(result['success'])
        self.assertIn('没有真实 SIM', result['answer'])
        self.assertIn('真实手机', result['answer'])
        self.assertFalse(result['retryable'])
        self.assertEqual(self.commands, [])
        self.assertFalse(task.done())
        finish.set()
        await task

    async def test_verified_send_survives_cleanup_failure_or_cancellation(self):
        identity = f'sms-cleanup-{os.getpid()}'
        self.addCleanup((Path('/tmp') / f'paios-phone-sms_cleanup_{os.getpid()}.lock').unlink, missing_ok=True)
        for error in (BrokenPipeError('observation pipe closed'), asyncio.CancelledError()):
            with self.subTest(error=type(error).__name__), \
                 patch.object(server, 'PHONE_SERIAL', identity), patch.object(server, '_device_lease', device_lease), \
                 patch.object(server._Observations, 'close', side_effect=error):
                result = await self.dispatch()
                await self.dispatch()
            self.assertEqual((result['success'], result['terminal_reason'], result['retryable']), (True, 'completed', False))
            self.assertIn('已核验', result['answer'])
            self.assertIn('手机收尾', result['answer'])
            self.assertEqual(sum(c.startswith('input tap') for c in self.commands), 1)
            (self.folder / f'{JID}.done.json').unlink()
            self.commands.clear()

    async def test_wrong_recipient_body_or_disabled_control_never_sends(self):
        for kwargs in [dict(recipient='13900000000'), dict(text='wrong'), dict(enabled='false')]:
            with patch.object(server, '_sms_nodes', lambda: nodes(**kwargs)):
                self.assertFalse((await self.dispatch())['success'])
            (self.folder / f'{JID}.done.json').unlink()
        self.assertFalse(any(c.startswith('input tap') for c in self.commands))

    async def test_remote_xml_preserves_exact_sms_target_and_body_checks(self):
        for transport, recipient, success in (('remote.example:5555', TO, True), ('usb', TO, True), ('usb', '13900000000', False)):
            root = ET.Element('hierarchy', width='40', height='40')
            for n in nodes(recipient=recipient): ET.SubElement(root, 'node', n)
            with patch.object(server, 'SERIAL', transport), \
                 patch.object(server, '_sms_nodes', sms_nodes), \
                 patch.object(server, '_observation', return_value=ET.tostring(root)):
                self.assertEqual((await self.dispatch())['success'], success)
            self.assertEqual(sum(c.startswith('input tap') for c in self.commands), int(success))
            self.assertFalse(any('uiautomator' in c for c in self.commands))
            self.commands.clear()
            (self.folder / f'{JID}.done.json').unlink()

    async def test_unreadable_sent_provider_still_sends_once_and_reports_unverified(self):
        shell = self.shell
        for phase in ('before', 'after', 'both'):
            def denied(command, check=False):
                if command.startswith('content query'):
                    tapped = any(c.startswith('input tap') for c in self.commands)
                    if phase == 'both': return 'Error: Permission denial'
                    if (phase == 'after') == tapped: raise RuntimeError('Permission denial')
                return shell(command, check)
            with patch.object(server, '_shell', denied):
                result = await self.dispatch()
                await self.dispatch()
            self.assertEqual(sum(c.startswith('input tap') for c in self.commands), 1, phase)
            self.assertEqual((result['success'], result['terminal_reason'], result['retryable']), (False, 'interrupted', False))
            self.assertIn('未核验', result['answer'])
            self.assertIn('已发送记录无法读取', result['answer'])
            (self.folder / f'{JID}.done.json').unlink()
            self.commands.clear()

    async def test_unverified_send_and_restart_are_never_retryable(self):
        def pending_bubble():
            return nodes() + ([{'resource-id': 'com.android.messaging:id/message_text', 'text': TEXT}]
                              if any(c.startswith('input tap') for c in self.commands) else [])
        with patch.object(server, '_sms_sent', return_value=set()), patch.object(server, '_sms_nodes', pending_bubble):
            result = await self.dispatch()
        self.assertFalse(result['success'])
        self.assertIn('已尝试发送，但未核验到新的短信已发送记录', result['answer'])
        self.assertEqual((result['terminal_reason'], result['retryable']), ('interrupted', False))
        (self.folder / f'{JID}.done.json').unlink()
        server._spool(JID, dict(principal_id="owner", job_id=JID, kind='sms', task=TEXT, sms_phase='send_attempted'), 'running')
        server._recover_interrupted()
        result = json.loads((self.folder / f'{JID}.done.json').read_text())
        self.assertFalse(result['retryable'])
        await self.dispatch()
        self.assertEqual(sum(c.startswith('input tap') for c in self.commands), 1)

    async def test_transport_repair_after_send_retries_observation_without_sending_again(self):
        shell, disconnected = self.shell, False
        def lost_reply(command, check=False):
            nonlocal disconnected
            result = shell(command, check)
            if command.startswith('input tap'):
                disconnected = True
                raise RuntimeError('device offline after tap')
            return result
        def repair(stop, typing=False, portal=True):
            nonlocal disconnected
            if not disconnected: return False
            disconnected = False
            server._repair_note('ADB 连接已恢复。')
            return True
        with patch.object(server, '_shell', lost_reply), patch.object(server, '_preflight', repair):
            result = await self.dispatch()
        self.assertTrue(result['success'])
        self.assertEqual(sum(c.startswith('input tap') for c in self.commands), 1)
        self.assertEqual(sum(c.startswith('am start') for c in self.commands), 1)
        self.assertIn('ADB 连接已恢复', result['answer'])

    async def test_emergency_preflight_and_retry_ignore_broken_portal_ime_and_mock_location(self):
        for disconnected in (False, True):
            state = dict(connected=True, locked=True, failed=False)
            def shell(command, check=False):
                if command.startswith(('settings ', 'ime ', 'appops ', 'dumpsys accessibility')):
                    raise RuntimeError('Portal/IME/mock location cannot be repaired over LAN')
                if command == 'getprop ro.serialno':
                    if not state['connected']: raise RuntimeError('device offline')
                    return 'phone'
                if 'isKeyguardShowing' in command: return 'isKeyguardShowing=true' if state['locked'] else ''
                return self.shell(command, check)
            def online(*_):
                state['connected'] = True
                return True
            def capture():
                if disconnected and not state['failed']:
                    state.update(connected=False, locked=True, failed=True)
                    raise RuntimeError('device offline during observation')
                return nodes()
            with patch.object(server, '_shell', shell), patch.object(server, 'PHONE_SERIAL', 'phone'), \
                 patch.object(server, '_preflight', preflight), patch.object(server, '_online', online), \
                 patch.object(server, '_observations', None, create=True), patch.object(server, '_sms_nodes', capture), \
                 patch.object(server, '_ensure_unlocked', lambda stop: state.update(locked=False)):
                result = await self.dispatch()
            self.assertTrue(result['success'], result['answer'])
            self.assertEqual(sum(c.startswith('input tap') for c in self.commands), 1)
            self.assertIn('执行手机已解锁', result['answer'])
            if disconnected: self.assertIn('ADB 连接已恢复', result['answer'])
            (self.folder / f'{JID}.done.json').unlink()
            self.commands.clear()

    async def test_emergency_cancels_model_without_using_it(self):
        async def model():
            async with server._one_phone: await asyncio.Event().wait()
        task = asyncio.create_task(model())
        server._jobs['job-aaaaaaaaaaaa'] = dict(principal_id='owner', goal='model', title='model', app=None, tier='fast', state='running', task=task,
                                              written=0, started_at=server._now(), step=0, max_steps=1)
        await asyncio.sleep(0)
        result = await self.dispatch()
        self.assertTrue(result['success'])
        self.assertTrue(task.cancelled())

    async def test_poller_discovers_sms_while_repeated_cancel_cleanup_is_hung(self):
        running, cleaning, release, discovered = (asyncio.Event() for _ in range(4))
        calls = []
        async def cancel_run():
            calls.append('cleanup')
            cleaning.set()
            await release.wait()
        async def model(**_):
            async with server._one_phone:
                running.set()
                try: await asyncio.Event().wait()
                finally: await server._join_cleanup(cancel_run())
        sms_job = server._sms_job
        async def sms(job_id, request):
            discovered.set()
            await sms_job(job_id, request)
        with patch.object(server, '_errand_task', model), patch.object(server, '_sms_job', sms):
            jid = 'job-aaaaaaaaaaaa'
            server._start(jid, dict(principal_id='owner', goal='model', app=None, tier='fast', max_steps=1), 'model', 'owner')
            task = server._jobs[jid]['task']
            poller = asyncio.create_task(server._cancel_poller())
            marker = self.folder / f'{jid}.cancel'
            try:
                await asyncio.wait_for(running.wait(), 1)
                marker.write_text('')
                await asyncio.wait_for(cleaning.wait(), 2)
                marker.write_text('')
                (self.folder / f'{JID}.request.json').write_text(json.dumps(dict(
                    principal_id='owner', job_id=JID, kind='sms', to=TO, text=TEXT, deadline_ms=int(server.time.time() * 1000) + 60_000)))
                await asyncio.wait_for(discovered.wait(), 1.5)  # real one-second poll interval
                self.assertFalse(marker.exists())
                self.assertFalse((self.folder / f'{JID}.request.json').exists())
                marker.write_text('')
                await asyncio.sleep(1.1)
                self.assertFalse(marker.exists())
                self.assertEqual(calls, ['cleanup'])
                self.assertFalse(self.commands, 'the model retains the phone until cleanup finishes')
            finally:
                poller.cancel()
                await asyncio.gather(poller, return_exceptions=True)
                release.set()
                await task
                await asyncio.gather(*(job['task'] for job in list(server._jobs.values())))

    async def test_hung_model_keeps_lock_and_emergency_fails_without_input(self):
        finish = asyncio.Event()
        async def model():
            async with server._one_phone:
                try: await asyncio.Event().wait()
                except asyncio.CancelledError: await finish.wait()
        task = asyncio.create_task(model())
        server._jobs['job-aaaaaaaaaaaa'] = dict(principal_id='owner', goal='model', title='model', app=None, tier='fast', state='running', task=task,
                                              written=0, started_at=server._now(), step=0, max_steps=1)
        await asyncio.sleep(0)
        wait_for = asyncio.wait_for
        with patch.object(server.asyncio, 'wait_for', lambda work, timeout: wait_for(work, 0.01)):
            result = await self.dispatch()
        self.assertFalse(result['success'])
        self.assertFalse(self.commands)
        finish.set()
        await task

    async def test_deadline_passes_while_waiting_for_phone_lock(self):
        waiting = asyncio.Event()
        lock = server._one_phone
        await lock.acquire()
        acquire = lock.acquire
        async def wait():
            waiting.set()
            return await acquire()
        try:
            with patch.object(lock, 'acquire', wait):
                task = asyncio.create_task(self.dispatch(deadline_ms=int(server.time.time() * 1000) + 1000))
                await asyncio.wait_for(waiting.wait(), 1)
                result = await asyncio.wait_for(task, 2)
            self.assertEqual((result['success'], result['terminal_reason'], result['retryable']), (False, 'timed_out', False))
            self.assertIn('未发送', result['answer'])
            self.assertIn('期限已过', result['answer'])
            self.assertFalse(self.commands)
        finally:
            lock.release()

    async def test_expired_and_legacy_spool_requests_are_terminal_after_restart(self):
        expired = int(server.time.time() * 1000) - 1000
        for phase, deadline in [('request', expired), ('claimed', expired), ('claimed', None)]:
            with self.subTest(phase=phase, deadline=deadline):
                request = dict(principal_id="owner", job_id=JID, kind='sms', to=TO, text=TEXT, title='紧急短信')
                if deadline is not None: request['deadline_ms'] = deadline
                path = self.folder / f'{JID}.request.json'
                if phase == 'claimed':
                    server._spool(JID, dict(principal_id="owner", job_id=JID, kind='sms', task=TEXT, sms_phase='claimed', sms_request=request), 'running')
                else:
                    path.write_text(json.dumps(request))
                if phase == 'claimed' and deadline is not None:
                    (self.folder / f'{JID}.cancel').write_text('')
                server._recover_interrupted()
                server._scan_requests()
                await server._jobs[JID]['task']
                done = self.folder / f'{JID}.done.json'
                terminal = done.read_bytes()
                result = json.loads(terminal)
                self.assertEqual((result['success'], result['terminal_reason'], result['retryable']), (False, 'timed_out', False))
                self.assertIn('未发送', result['answer'])
                self.assertIn('期限已过', result['answer'])
                path.write_text(json.dumps(request | dict(deadline_ms=expired + 60_000)))
                server._recover_interrupted()
                server._scan_requests()
                self.assertFalse(path.exists())
                self.assertEqual(done.read_bytes(), terminal, 'a replay cannot replace the terminal result or send')
                self.assertFalse(self.commands)
                done.unlink()

    async def test_deadline_guards_unlock_composition_and_fsynced_barrier_but_allows_verification(self):
        for phase in ('unlock', 'compose', 'barrier', 'sent', 'repair'):
            clock, inputs = [1000.0], []
            def run(args, **_):
                command = args[-1]
                if command.startswith(('input ', 'am start ')): inputs.append((clock[0], command))
                output = 'phone' if command == 'getprop ro.serialno' else self.shell(command)
                if (phase == 'unlock' and command.startswith('input keyevent')) or (phase in ('sent', 'repair') and command.startswith('input tap')):
                    clock[0] = 1001.0
                    if phase == 'repair': raise RuntimeError('device offline after tap')
                    if phase == 'sent': threading.Event().wait(1.1)  # verification outlives the input deadline
                return types.SimpleNamespace(returncode=0, stdout=output, stderr='')
            def compose():
                if phase == 'compose': clock[0] = 1001.0
                return nodes()
            write = server._spool
            def spool(job_id, record, state):
                write(job_id, record, state)
                if phase == 'barrier' and record.get('sms_phase') == 'send_attempted': clock[0] = 1001.0
            with self.subTest(phase=phase), patch.object(server.time, 'time', lambda: clock[0]), \
                 patch.object(server, '_shell', shell_command), patch.object(server.subprocess, 'run', run), \
                 patch.object(server, 'PHONE_SERIAL', 'phone'), \
                 patch.object(server, '_preflight', preflight if phase == 'repair' else server._preflight), \
                 patch.object(server, '_ensure_unlocked', ensure_unlocked), \
                 patch.object(server, '_locked', side_effect=lambda: phase == 'repair' and any(c.startswith('input tap') for c in self.commands)), \
                 patch.object(server, '_sms_nodes', compose), patch.object(server, '_spool', spool):
                result = await self.dispatch(deadline_ms=1_001_000)
            self.assertTrue(all(when < 1001.0 for when, _ in inputs), inputs)
            self.assertEqual((result['success'], result['terminal_reason']), {'sent': (True, 'completed'), 'repair': (False, 'interrupted')}.get(phase, (False, 'timed_out')))
            self.assertEqual(sum(command.startswith('input tap') for _, command in inputs), int(phase in ('sent', 'repair')))
            if phase == 'repair': self.assertIn('发送状态未核验', result['answer'])
            if phase == 'barrier':
                done, delivered = self.folder / f'{JID}.done.json', self.folder / f'{JID}.delivered.json'
                terminal = done.read_bytes()
                done.replace(delivered)
                server._spool(JID, json.loads(terminal), 'running')  # crash before unlinking the old running marker
                server._recover_interrupted()
                self.assertFalse(done.exists(), 'recovery cannot publish a second terminal result')
                self.assertEqual(delivered.read_bytes(), terminal)
                delivered.replace(done)
            (self.folder / f'{JID}.done.json').unlink()
            self.commands.clear()

    async def test_two_emergencies_queue_before_model_timeout_and_ignore_owner_touch(self):
        second = 'job-abcdef012345'
        for job_id in (JID, second):
            (self.folder / f'{job_id}.request.json').write_text(json.dumps(dict(principal_id="owner", job_id=job_id, kind='sms', to=TO, text=TEXT,
                                                                            deadline_ms=int(server.time.time() * 1000) + 60_000)))
        entered, release = threading.Event(), threading.Event()
        sends = []
        def send(to, text, barrier, stop, evidence):
            barrier()
            sends.append(text)
            if len(sends) == 1:
                entered.set()
                if not release.wait(1): raise RuntimeError('test gate timeout')
        wait_for = asyncio.wait_for
        with patch.object(server, '_owner_active', side_effect=AssertionError('owner-idle guard used')), \
             patch.object(server, '_sms_send', send), \
             patch.object(server.asyncio, 'wait_for', lambda work, timeout: wait_for(work, 0.01)):
            server._scan_requests()
            tasks = [job['task'] for job in server._jobs.values()]
            await asyncio.to_thread(entered.wait, 1)
            await asyncio.sleep(0.03)  # longer than the model-lock deadline; second SMS must still be queued
            self.assertEqual(sends, [TEXT])
            self.assertFalse(tasks[1].done())
            release.set()
            await asyncio.gather(*tasks)
        self.assertEqual(sends, [TEXT, TEXT])
        for job_id in (JID, second):
            self.assertTrue(json.loads((self.folder / f'{job_id}.done.json').read_text())['success'])

    async def test_sent_ids_do_not_depend_on_host_device_clock(self):
        shell = self.shell
        def old_device_clock(command, check=False):
            if command.startswith('content query') and 'date' in command:
                return 'No result found.'  # phone timestamps precede the host clock
            return shell(command, check)
        with patch.object(server, '_shell', old_device_clock):
            self.assertTrue((await self.dispatch())['success'])

    async def test_restart_before_send_barrier_restores_exact_same_request(self):
        request = dict(principal_id="owner", job_id=JID, kind='sms', to=TO, text=TEXT, title='紧急短信', deadline_ms=int(server.time.time() * 1000) + 60_000)
        server._spool(JID, dict(principal_id="owner", job_id=JID, kind='sms', task=TEXT, sms_phase='claimed', sms_request=request), 'running')
        write = server._spool
        def check_order(job_id, record, state):
            self.assertTrue((self.folder / f'{JID}.running.json').exists(), 'claim stays until request is durable')
            write(job_id, record, state)
        with patch.object(server, '_spool', check_order):
            server._recover_interrupted()
        self.assertFalse((self.folder / f'{JID}.running.json').exists())
        self.assertFalse((self.folder / f'{JID}.done.json').exists())
        self.assertEqual(json.loads((self.folder / f'{JID}.request.json').read_text()), request)
        server._scan_requests()
        await server._jobs[JID]['task']
        self.assertTrue(json.loads((self.folder / f'{JID}.done.json').read_text())['success'])
        await self.dispatch()
        self.assertEqual(sum(c.startswith('input tap') for c in self.commands), 1)

    async def test_legacy_goal_is_rejected(self):
        (self.folder / f'{JID}.request.json').write_text(json.dumps(dict(principal_id="owner", job_id=JID, goal='send SMS')))
        server._scan_requests()
        self.assertFalse(self.commands)
        result = json.loads((self.folder / f'{JID}.done.json').read_text())
        self.assertFalse(result['success'])
        self.assertEqual(result['principal_id'], 'owner')

    async def test_unowned_request_and_corrupt_running_are_quarantined_intact(self):
        for state, raw in [('request', json.dumps(dict(job_id=JID, goal='send SMS'))), ('running', '{broken')]:
            with self.subTest(state=state):
                for path in self.folder.iterdir(): path.unlink()
                marker = self.folder / f'{JID}.{state}.json'
                marker.write_text(raw)
                server._scan_requests() if state == 'request' else server._recover_interrupted()
                self.assertFalse((self.folder / f'{JID}.done.json').exists())
                self.assertEqual((self.folder / f'{JID}.invalid.json').read_text(), raw)
                self.assertFalse(marker.exists())

    async def test_interrupted_owned_job_preserves_principal(self):
        server._spool(JID, dict(principal_id='owner', job_id=JID, task='read status'), 'running')
        server._recover_interrupted()
        self.assertEqual(json.loads((self.folder / f'{JID}.done.json').read_text())['principal_id'], 'owner')

if __name__ == '__main__': unittest.main()
