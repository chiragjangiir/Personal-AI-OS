"""Repeated dispatch, structured endings, unreadable screens, effective tier and the cross-process phone lease."""
import asyncio
import fcntl
import importlib.util
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402
from payment_capture_fixture import frame

GOAL = "在千问里点一杯香柠养乐多"


def native(nodes=(), viewport=(1264,2780)):
    read = server._NativeRead(viewport)
    read.extend(nodes)
    return read


class Errands(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.spool = Path(self.dir.name)
        for patch in (mock.patch.object(server, "SPOOL", str(self.spool)), mock.patch.object(server, "_online", lambda *_: True)):
            patch.start()
            self.addCleanup(patch.stop)
        self.addCleanup(self.dir.cleanup)
        self.addCleanup(server._jobs.clear)

    async def run_job(self, result, stop=False, intent=None):
        gate = asyncio.Event()

        async def fake(**_):
            await gate.wait()
            return result

        with mock.patch.object(server, "_errand_task", fake):
            res = await server.phone_task(GOAL, app="千问", repeat=True, payment_intent=intent, principal_id="owner", effect={"kind": "external", "task_type": "purchase_errand", "requested": True})
            job_id = res["job_id"]
            if stop:
                server._jobs[job_id]["state"] = "stopping"
            gate.set()
            await server._jobs[job_id]["task"]
        return json.loads((self.spool / f"{job_id}.done.json").read_text())

    async def test_fast_prompt_loads_from_executor_cwd_and_preserves_upstream_contract(self):
        from mobilerun.config_manager import ConfigLoader
        from mobilerun.config_manager.path_resolver import PathResolver
        from mobilerun.config_manager.prompt_loader import PromptLoader

        executor = Path(__file__).resolve().parent
        # The MCP process starts here; prompt paths are relative to cwd, not YAML.
        with mock.patch("os.getcwd", return_value=str(executor)):
            config = ConfigLoader.load(str(executor / "mobilerun-config.example.yaml"))
            prompt_path = Path(config.agent.get_fast_agent_system_prompt_path())
            self.assertEqual(prompt_path, executor / "fast_agent_system.jinja2")
            upstream_path = PathResolver.get_project_root() / "config/prompts/fast_agent/system.jinja2"
            prompt, upstream = prompt_path.read_text(), upstream_path.read_text()
            start = prompt.index("{# codebatch-v1:")
            end = prompt.index("- **Before navigating away", start)
            self.assertEqual(prompt[:start] + prompt[end:], upstream)
            overlay = prompt[start:end]
            self.assertEqual(sum(line.startswith("- ") for line in overlay.splitlines()), 7)
            for screenshot_only, parallel_tools in ((True, True), (False, False)):
                with self.subTest(screenshot_only=screenshot_only, parallel_tools=parallel_tools):
                    variables = dict(platform="android", screenshot_only=screenshot_only,
                        parallel_tools=parallel_tools, vision=True, available_tools=["click"],
                        tool_descriptions="TEST_TOOL", available_secrets=["test_secret_id"],
                        output_schema={"description": "TEST_OUTPUT", "required": ["shop"],
                            "properties": {"shop": {"type": "string", "description": "TEST_SHOP"}}})
                    rendered = await PromptLoader.load_prompt(str(prompt_path), variables)
                    original = await PromptLoader.load_prompt(str(upstream_path), variables)
                    rendered_overlay = PromptLoader.render_template(overlay, variables)
                    self.assertEqual(rendered.replace(rendered_overlay + "\n", "", 1), original)
                    self.assertIn("pending / attempted / changed_unverified / claimed_verified / blocked", rendered)
                    self.assertIn("After the first failed attempt", rendered)
                    self.assertIn("explicit stop conditions", rendered)
                    self.assertIn("current relevant verified readings and unfinished items", rendered)

    async def test_endings_are_structured(self):
        done = await self.run_job({"success": True, "answer": "已下单"})
        self.assertEqual((done["terminal_reason"], done["retryable"]), ("completed", False))
        stopped = await self.run_job({"success": False, "answer": server.STOPPED}, stop=True)
        self.assertEqual((stopped["terminal_reason"], stopped["retryable"]), ("cancelled_by_user", False))
        failed = await self.run_job({"success": False, "answer": "执行手机出错：RuntimeError"})
        self.assertEqual((failed["terminal_reason"], failed["retryable"]), ("failed", True))

    async def test_login_required_survives_the_async_result_wire(self):
        done = await self.run_job({"success": False, "status": "APP_LOGIN_REQUIRED",
            "error_code": "APP_LOGIN_REQUIRED", "login_app": "淘宝", "answer": "APP_LOGIN_REQUIRED: 淘宝"})
        self.assertEqual((done["error_code"], done["login_app"], done["retryable"]),
                         ("APP_LOGIN_REQUIRED", "淘宝", False))

    async def test_midrun_login_stops_a_workflow_that_swallows_driver_errors(self):
        for intent in (None, "pi-owner"):
            with self.subTest(payment_intent=intent):
                inner = SimpleNamespace(get_ui_tree=mock.AsyncMock(side_effect=server._AppLoginRequired("淘宝")),
                                        input_text=mock.AsyncMock())
                swallowed, cancelled, joined = asyncio.Event(), asyncio.Event(), asyncio.Event()

                class Handler:
                    def __init__(self, driver):
                        self.driver = driver

                    def __await__(self):
                        async def run():
                            try:
                                try:
                                    await self.driver.get_ui_tree()
                                except RuntimeError:
                                    swallowed.set()  # Mobilerun logs state errors and continues with stale state.
                                try:
                                    await self.driver.input_text("stale-state input")
                                except server._AppLoginRequired:
                                    pass
                                await asyncio.Event().wait()
                            finally:
                                joined.set()
                        return run().__await__()

                    async def cancel_run(self):
                        cancelled.set()

                config = SimpleNamespace(device=SimpleNamespace(), agent=SimpleNamespace(), llm_profiles={})
                checkpoint = mock.AsyncMock()
                with mock.patch.object(server, '_load_model'), \
                     mock.patch.object(server, 'ConfigLoader', SimpleNamespace(load=lambda _: config), create=True), \
                     mock.patch.object(server, 'MobileAgent', side_effect=lambda **kw: SimpleNamespace(run=lambda: Handler(kw['driver'])), create=True), \
                     mock.patch.object(server, '_count_steps', new=mock.AsyncMock()), \
                     mock.patch.object(server, '_screen_signs', new=mock.AsyncMock(return_value=set())), \
                     mock.patch.object(server, '_checkpoint_payment', new=checkpoint):
                    outcome = await asyncio.wait_for(server._agent(GOAL, 10, intent, driver=inner), 1)
                self.assertTrue(swallowed.is_set())
                self.assertTrue(cancelled.is_set())
                self.assertTrue(joined.is_set())
                inner.input_text.assert_not_awaited()
                checkpoint.assert_not_awaited()
                done = await self.run_job(outcome, intent=intent)
                self.assertEqual((done['status'], done['error_code'], done['login_app'], done['retryable']),
                                 ('APP_LOGIN_REQUIRED', 'APP_LOGIN_REQUIRED', '淘宝', False))

    def test_login_screen_identifies_the_actual_app(self):
        for app in ("千问", "淘宝"):
            root = server.ET.fromstring(f'<hierarchy><node package="{server.APPS[app]}" text="手机号登录"/></hierarchy>')
            with self.assertRaises(server._AppLoginRequired) as raised:
                server._check_app_login(root)
            self.assertEqual(raised.exception.app, app)
        root = server.ET.fromstring('<hierarchy><node package="com.aliyun.tongyi" text="输入手机号"/>'
                                    '<node package="com.aliyun.tongyi" text="下一步"/></hierarchy>')
        with self.assertRaises(server._AppLoginRequired):
            server._check_app_login(root)
        server._check_app_login(server.ET.fromstring('<hierarchy><node package="com.aliyun.tongyi" text="生活帮手"/></hierarchy>'))
        with self.assertRaises(server._AppLoginRequired):
            server._check_app_login(server.ET.fromstring('<hierarchy><node package="com.aliyun.tongyi" text="立即登录，解锁更多功能"/></hierarchy>'))
        root = server.ET.fromstring('<hierarchy><node package="com.aliyun.tongyi" text="生活帮手"/>'
                                    '<node package="com.taobao.taobao" text="手机号登录"/></hierarchy>')
        with self.assertRaises(server._AppLoginRequired) as raised:
            server._check_app_login(root)
        self.assertEqual(raised.exception.app, "淘宝")

    async def test_terminal_payment_provenance_is_owned_by_the_task(self):
        for success, answer, stop in ((True, "已下单", False), (False, "失败", False), (False, server.STOPPED, True)):
            with self.subTest(success=success, stop=stop):
                done = await self.run_job({"success": success, "answer": answer, "payment_intent": "pi-forged"},
                                          stop=stop, intent="pi-owner")
                self.assertEqual(done["payment_intent"], "pi-owner")
                self.assertFalse(done["retryable"])
        legacy = await self.run_job({"success": False, "answer": "失败", "payment_intent": "pi-forged"})
        self.assertNotIn("payment_intent", legacy)

    async def test_payment_failure_and_prestart_cancel_keep_provenance(self):
        task = dict(goal=GOAL, app="千问", tier="fast", max_steps=1, latitude=None, longitude=None,
                    payment_intent="pi-owner", ride_ok=False)
        jid = "job-0123456789ab"
        with mock.patch.object(server, "_errand_task", side_effect=RuntimeError("before checkpoint")):
            server._start(jid, task, "付款测试", "owner")
            await server._jobs[jid]["task"]
        failed = json.loads((self.spool / f"{jid}.done.json").read_text())
        self.assertEqual((failed["payment_intent"], failed["terminal_reason"]), ("pi-owner", "failed"))
        async def wait(**_):
            await asyncio.Event().wait()
        with mock.patch.object(server, "_errand_task", wait):
            server._start(jid, task, "付款测试", "owner")
            await server.phone_cancel(jid)  # No event-loop yield before cancellation is requested.
        stopped = json.loads((self.spool / f"{jid}.done.json").read_text())
        self.assertEqual((stopped["payment_intent"], stopped["terminal_reason"]), ("pi-owner", "cancelled_by_user"))

    async def test_I3_I8_I10_payment_restart_reports_unknown_without_retry_or_phone_input(self):
        jid = "job-0123456789ab"
        task = dict(goal=GOAL, app="千问", tier="fast", max_steps=80, payment_intent="pi-owner")
        with mock.patch.object(server, "_job", new=mock.AsyncMock()), mock.patch.object(server, "_shell") as inputs:
            server._start(jid, task, "付款测试", "owner")
            await server._jobs[jid]["task"]
            marker = json.loads((self.spool / f"{jid}.running.json").read_text())
            self.assertEqual(marker["payment_intent"], "pi-owner")
            server._jobs.clear()  # A new process has only the durable marker.
            server._recover_interrupted()
        done = json.loads((self.spool / f"{jid}.done.json").read_text())
        self.assertEqual(done["payment_intent"], "pi-owner")
        self.assertFalse(done["retryable"])
        self.assertTrue(done["answer"].startswith("【付款结果不明】"))
        self.assertIn("未尝试取消", done["answer"])
        self.assertNotIn("grant", json.dumps(done))
        inputs.assert_not_called()

    async def test_real_phone_staging_refuses_a_ride_before_device_input(self):
        with mock.patch.dict(os.environ, {"PAIOS_STAGE": "staging"}), \
             mock.patch.object(server, "_shell", side_effect=AssertionError("device input in staging ride")):
            result = await server.phone_task("帮我叫车回家", ride_ok=True, repeat=True, principal_id="owner", effect={"kind": "external", "task_type": "ride_request", "requested": True})
            await server._jobs[result["job_id"]]["task"]
        done = json.loads((self.spool / f"{result['job_id']}.done.json").read_text())
        self.assertFalse(done["success"])
        self.assertIn("测试环境不能真的叫车", done["answer"])

    async def test_the_same_request_is_not_dispatched_twice(self):
        gate = asyncio.Event()

        async def fake(**_):
            await gate.wait()
            return {"success": True, "answer": "已下单，实付 16.6 元"}

        with mock.patch.object(server, "_errand_task", fake):
            first = await server.phone_task(GOAL, app="千问", principal_id="owner", effect={"kind": "external", "task_type": "purchase_errand", "requested": True})
            again = await server.phone_task(GOAL + "  ", app="千问", principal_id="owner", effect={"kind": "external", "task_type": "purchase_errand", "requested": True})
            self.assertEqual((again["status"], again["job_id"]), ("already_running", first["job_id"]), "running: same job")
            gate.set()
            await server._jobs[first["job_id"]]["task"]
            self.assertEqual((await server.phone_task(GOAL, app="千问", principal_id="owner", effect={"kind": "external", "task_type": "purchase_errand", "requested": True}))["status"], "duplicate", "just finished")
            self.assertEqual((await server.phone_task(GOAL, app="千问", repeat=True, principal_id="owner", effect={"kind": "external", "task_type": "purchase_errand", "requested": True}))["status"], "started", "explicit repeat")
            await asyncio.gather(*(j["task"] for j in list(server._jobs.values())))

    async def test_a_user_stop_is_not_redone_but_a_failure_may_be_retried(self):
        await self.run_job({"success": False, "answer": server.STOPPED}, stop=True)
        self.assertEqual((await server.phone_task(GOAL, app="千问", principal_id="owner", effect={"kind": "external", "task_type": "purchase_errand", "requested": True}))["status"], "cancelled_recently")
        for path in self.spool.glob("*.done.json"):
            path.unlink()
        await self.run_job({"success": False, "answer": "执行手机出错"})
        with mock.patch.object(server, "_errand_task", lambda **_: asyncio.sleep(0, {"success": True, "answer": "ok"})):
            self.assertEqual((await server.phone_task(GOAL, app="千问", principal_id="owner", effect={"kind": "external", "task_type": "purchase_errand", "requested": True}))["status"], "started")
            await asyncio.gather(*(j["task"] for j in list(server._jobs.values())))

    async def test_old_results_no_longer_count_as_the_same_request(self):
        done = await self.run_job({"success": True, "answer": "已下单"})
        old = time.time() - server.RECENT_S - 5
        done["finished_at"] = datetime.fromtimestamp(old, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        (self.spool / f"{done['job_id']}.done.json").write_text(json.dumps(done))
        self.assertIsNone(server._same_errand(GOAL, "千问", "owner"))

    async def test_unreadable_owner_activity_stops_before_unlocking(self):
        with mock.patch.object(server, '_device_lease', lambda: asyncio.Lock()), \
             mock.patch.object(server, '_shell', return_value='unreadable power state'), \
             mock.patch.object(server, '_ensure_unlocked') as unlock:
            result = await server.phone_task(GOAL, repeat=True, principal_id="owner", effect={"kind": "external", "task_type": "purchase_errand", "requested": True})
            await server._jobs[result['job_id']]['task']
            done = json.loads((self.spool / f"{result['job_id']}.done.json").read_text())
            self.assertFalse(done['success'])
            self.assertIn('无法确认主人', done['answer'])
            unlock.assert_not_called()

    async def test_unlock_timeout_reports_failure_without_disclosing_the_pin(self):
        pin = self.spool / 'unlock.pin'; pin.write_text('987654')
        def run(args, **_):
            command = args[-1]
            if command.startswith('input text '): raise subprocess.TimeoutExpired(args, 15)
            output = 'isKeyguardShowing=true' if 'isKeyguardShowing' in command else 'Physical size: 1264x2780'
            return subprocess.CompletedProcess(args, 0, stdout=output, stderr='')
        with mock.patch.object(server, '_device_lease', lambda: asyncio.Lock()), \
             mock.patch.object(server, '_owner_active', return_value=False), mock.patch.object(server.time, 'sleep'), \
             mock.patch.object(server, 'UNLOCK_FILE', str(pin)), mock.patch.object(server.subprocess, 'run', run):
            result = await server.phone_task(GOAL, repeat=True, principal_id="owner", effect={"kind": "external", "task_type": "purchase_errand", "requested": True})
            await server._jobs[result['job_id']]['task']
        done = json.loads((self.spool / f"{result['job_id']}.done.json").read_text())
        self.assertFalse(done['success'])
        self.assertIn('input（15 s）', done['answer'])
        self.assertNotIn(pin.read_text(), json.dumps(done))

    async def test_known_phone_failures_repair_once_preserve_owner_settings_and_report_progress(self):
        from mobilerun_core_local.driver.android.portal import PORTAL_PACKAGE_NAME, portal_a11y_service, portal_ime_id
        from mobilerun_core_local.driver.base import DeviceDisconnectedError
        service, ime = portal_a11y_service(PORTAL_PACKAGE_NAME), portal_ime_id(PORTAL_PACKAGE_NAME)
        other, owner = 'other/.Accessibility', 'owner/.Keyboard'
        for failure in ('healthy', 'disabled', 'crashed', 'locked', 'during', 'geometry', 'grant', 'permission'):
            with self.subTest(failure=failure):
                state = dict(services=other if failure == 'disabled' else service + ':' + other, bound=failure != 'crashed',
                             crashed=failure == 'crashed', locked=failure == 'locked', keyboard=True, default=owner,
                             allowed=False, connected=True, location=False)
                commands, progress, inputs, real_shell = [], [], [], server._shell
                original = state['services']
                def shell(command, check=False):
                    commands.append(command)
                    if command == 'wm size': return 'Physical size: 1264x2780'
                    if 'isKeyguardShowing' in command: return 'isKeyguardShowing=true' if state['locked'] else ''
                    if command == 'getprop ro.serialno':
                        if not state['connected']: raise RuntimeError('device offline')
                        return 'phone'
                    if command == 'dumpsys accessibility':
                        return ('Bound services:{' + ('Service[label=Mobilerun Portal, feedbackType=generic]' if state['bound'] else '')
                                + '}\nEnabled services:{' + state['services'] + '}\nBinding services:{}\nCrashed services:{' + (service if state['crashed'] else '') + '}')
                    if command == 'settings get secure enabled_accessibility_services': return state['services']
                    if command.startswith('settings put secure enabled_accessibility_services '):
                        state['services'] = shlex.split(command)[-1]
                        state.update(bound=service in state['services'], crashed=False)
                    if command == 'ime list -s': return owner + ('\n' + ime if state['keyboard'] else '')
                    if command == 'settings get secure default_input_method': return state['default']
                    if command.startswith('ime enable '): state['keyboard'] = True
                    if command.startswith('ime set '): state['default'] = shlex.split(command)[-1]
                    if command.startswith('appops get '): return 'MOCK_LOCATION: allow' if state['allowed'] else 'MOCK_LOCATION: ignore'
                    if command.startswith('am start-foreground-service '): state['location'] = True
                    if command.startswith('am stopservice '): state['location'] = False
                    if command.startswith('dumpsys activity services '): return '  * ServiceRecord{4d40eaf u0 io.appium.settings/.LocationService}' if state['location'] else ''
                    if command.startswith('appops set '):
                        if failure == 'permission':
                            denied = subprocess.CompletedProcess([], 1, stdout='', stderr="Exception occurred while executing 'set':\njava.lang.SecurityException: uid 2000 does not have android.permission.MANAGE_APP_OPS_MODES.")
                            with mock.patch.object(server.subprocess, 'run', return_value=denied):
                                return real_shell(command, check)
                        state['allowed'] = True
                    return ''
                def online(*_):
                    state['connected'] = True
                    return True
                geometry_reads = 0
                def read_native():
                    nonlocal geometry_reads
                    geometry_reads += 1
                    if failure == 'geometry' and geometry_reads == 1:
                        state['connected'] = False
                        raise DeviceDisconnectedError('device offline during geometry read')
                    return native()
                class Driver:
                    async def screenshot(self): return frame((1264,2780))
                    async def tap(self, *args): inputs.append('tap')
                    async def input_text(self, *args, **kwargs):
                        inputs.append('typing')
                        if failure == 'during':
                            state.update(bound=False, crashed=True, connected=False, keyboard=False, default=owner)
                            return False
                        return True
                async def agent(*args, **kwargs):
                    if failure == 'during': await server.CheckoutStop(Driver()).input_text('你好')
                    if failure == 'geometry': await server.CheckoutStop(Driver()).tap(5, 5)
                    return dict(success=True, answer='home read', steps=1)
                real_spool = server._spool
                def spool(jid, record, phase):
                    if phase == 'running': progress.append(record['title'])
                    real_spool(jid, record, phase)
                with mock.patch.object(server, 'PHONE_SERIAL', 'phone'), mock.patch.object(server, '_shell', shell), \
                     mock.patch.object(server, '_online', online), mock.patch.object(server, '_owner_active', return_value=False), \
                     mock.patch.object(server, '_device_lease', lambda: asyncio.Lock()), mock.patch.object(server, '_observations', None, create=True), \
                     mock.patch.object(server, '_ensure_unlocked', side_effect=lambda stop: state.update(locked=False)), mock.patch.object(server, '_ensure_cn_identity'), \
                     mock.patch.object(server, '_driver', new=mock.AsyncMock(return_value=Driver())), \
                     mock.patch.object(server, '_screen_nodes', return_value=[('首页', 0, 0, 10, 10)]), mock.patch.object(server, '_tree', side_effect=read_native), \
                     mock.patch.object(server, '_agent', agent), mock.patch.object(server, '_spool', spool):
                    location = dict(latitude=31.2, longitude=121.5) if failure in ('grant', 'permission') else {}
                    result = await server.phone_task('读取首页', repeat=True, **location, principal_id="owner", effect={"kind": "read", "task_type": "read_app", "requested": True})
                    await server._jobs[result['job_id']]['task']
                done = json.loads((self.spool / f"{result['job_id']}.done.json").read_text())
                self.assertEqual(done['success'], failure not in ('during', 'permission'))
                self.assertEqual(state['default'], owner)
                self.assertEqual(state['services'], original if failure != 'disabled' else other + ':' + service)
                self.assertEqual(len(inputs), 1 if failure in ('during', 'geometry') else 0)
                if failure == 'healthy':
                    self.assertFalse(any(c.startswith(('settings put', 'ime ', 'appops set')) and c != 'ime list -s' for c in commands))
                    self.assertNotIn('手机自修复', done['answer'])
                else:
                    self.assertIn('手机自修复', done['answer'])
                    self.assertTrue(any('手机自修复' in title for title in progress))
                if failure == 'permission': self.assertIn('需要插线授权一次', done['answer'])
                if not location: self.assertFalse(any(c.startswith('appops ') for c in commands))
                if failure == 'during': self.assertIn('输入结果未知', done['answer'])

    async def test_cleanup_checks_location_state_and_preserves_work_result(self):
        identity = f'cleanup-test-{os.getpid()}'
        self.addCleanup((Path('/tmp') / f'paios-phone-cleanup_test_{os.getpid()}.lock').unlink, missing_ok=True)
        real_shell = server._shell
        for case in ('stopped255', 'absent255', 'running', 'ime', 'cancelled cleanup', 'pipe', 'work failed'):
            with self.subTest(case=case):
                state = dict(ime='owner/.Keyboard', running=False)
                commands = []
                def shell(command, check=False):
                    commands.append(command)
                    if command == 'settings get secure default_input_method': return state['ime']
                    if command.startswith('ime set '):
                        if case in ('ime', 'work failed'): raise RuntimeError('IME restore rejected')
                        if case == 'cancelled cleanup': state['loop'].call_soon_threadsafe(state['task'].cancel)
                        state['ime'] = shlex.split(command)[-1]
                    if command.startswith('appops get '): return 'MOCK_LOCATION: allow'
                    if command.startswith('am start-foreground-service '): state['running'] = True
                    if command.startswith('dumpsys activity services '): return '  * ServiceRecord{4d40eaf u0 io.appium.settings/.LocationService}' if state['running'] else '  Destroying services:\n  * Destroy ServiceRecord{4d40eaf u0 io.appium.settings/.LocationService}'
                    if command.startswith('am stopservice '):
                        message = 'Service stopped' if state['running'] else 'Service not stopped: was not running.'
                        state['running'] = case in ('running', 'work failed')
                        reply = subprocess.CompletedProcess([], 255, stdout='', stderr=message)
                        with mock.patch.object(server.subprocess, 'run', return_value=reply): return real_shell(command, check)
                    return ''
                async def agent(*args, **kwargs):
                    state.update(loop=asyncio.get_running_loop(), task=asyncio.current_task())
                    state['ime'] = 'portal/.Keyboard'
                    if case == 'absent255': state['running'] = False
                    return dict(success=case != 'work failed', answer='业务报告：24.1元，未叫车', steps=4)
                close = mock.Mock(side_effect=BrokenPipeError('observation pipe closed') if case == 'pipe' else None)
                with mock.patch.object(server, 'PHONE_SERIAL', identity), mock.patch.object(server, '_shell', shell), \
                     mock.patch.object(server, '_owner_active', return_value=False), mock.patch.object(server, '_preflight', return_value=False), \
                     mock.patch.object(server, '_ensure_unlocked'), mock.patch.object(server, '_ensure_cn_identity'), \
                     mock.patch.object(server, '_at_checkout', return_value=False), mock.patch.object(server, '_sleep_later'), \
                     mock.patch.object(server._Observations, 'close', close), mock.patch.object(server, '_agent', agent), \
                     mock.patch.object(server, 'SPOOL', None if case in ('stopped255', 'absent255', 'running') else str(self.spool)):
                    result = await server.phone_task('查打车价格，不叫车', latitude=30.2, longitude=120.1, repeat=True, principal_id="owner", effect={"kind": "read", "task_type": "read_app", "requested": True})
                    if 'job_id' in result:
                        await server._jobs[result['job_id']]['task']
                        result = json.loads((self.spool / f"{result['job_id']}.done.json").read_text())
                        self.assertEqual((result['terminal_reason'], result['retryable']),
                                         ('failed', True) if case == 'work failed' else ('completed', False))
                    else:
                        self.assertEqual(result['steps'], 4)
                self.assertEqual(result['success'], case != 'work failed')
                self.assertTrue(result['answer'].startswith('业务报告：24.1元，未叫车'))
                self.assertEqual(sum(c.startswith('am stopservice ') for c in commands), 1)
                if case in ('stopped255', 'absent255'): self.assertNotIn('手机收尾', result['answer'])
                if case in ('running', 'work failed'): self.assertIn('模拟定位服务仍在运行', result['answer'])
                if case in ('ime', 'cancelled cleanup', 'work failed'): self.assertIn('默认键盘恢复未确认完成', result['answer'])
                if case == 'pipe': self.assertIn('观测连接关闭未确认完成', result['answer'])

    async def test_lost_input_replies_require_observation_without_replay(self):
        for action, args in [('tap', (5, 5)), ('swipe', (1, 2, 3, 4)), ('drag', (1, 2, 3, 4)),
                             ('input_text', ('你好',)), ('press_button', ('back',)), ('press_key_code', (4,))]:
            inputs = []
            async def apply(*args):
                inputs.append(args)
                raise RuntimeError('reply lost after input applied')
            image = frame((1264,2780), b'screen after input')
            driver = mock.Mock(screenshot=mock.AsyncMock(return_value=image))
            setattr(driver, action, apply)
            guard = server.CheckoutStop(driver)
            with mock.patch.object(server, '_shell', return_value='Physical size: 1264x2780'), \
                 mock.patch.object(server, '_screen_nodes', return_value=[('首页', 0, 0, 10, 10)]), \
                 mock.patch.object(server, '_tree', return_value=native()), mock.patch.object(server, '_at_checkout', return_value=False), \
                 mock.patch.object(server, '_locked', return_value=False), mock.patch.object(server, '_keyboard', return_value=False), \
                 mock.patch.object(server, '_preflight', return_value=True), \
                 mock.patch.object(server, '_driver', new=mock.AsyncMock(return_value=driver)):
                with self.assertRaisesRegex(RuntimeError, '输入结果未知.*先重新观察屏幕'):
                    await getattr(guard, action)(*args)
                self.assertEqual(await guard.screenshot(), image)
            self.assertEqual(inputs, [args], action)

    async def test_restart_requires_app_state_check_before_continuation(self):
        jid = 'job-0123456789ab'
        server._spool(jid, dict(principal_id="owner", job_id=jid, task=GOAL, app='千问', state='running'), 'running')
        server._recover_interrupted()
        done = json.loads((self.spool / f'{jid}.done.json').read_text())
        self.assertEqual((done['success'], done['terminal_reason'], done['retryable']), (False, 'interrupted', True))
        self.assertIn('操作结果未知；先只读核对 App 的订单、行程或消息状态', done['answer'])
        self.assertIn('不要盲目重新下单、叫车或发消息', done['answer'])

    async def test_restart_routes_lifecycle_to_cloud_phone_without_errand_retry(self):
        jid = 'job-0123456789ab'
        server._spool(jid, dict(principal_id="owner", job_id=jid, task="保存千问", tier="lifecycle", state="running"), 'running')
        server._recover_interrupted()
        done = json.loads((self.spool / f'{jid}.done.json').read_text())
        self.assertEqual((done['tier'], done['terminal_reason'], done['retryable']), ('lifecycle', 'interrupted', False))
        self.assertIn('phone_status', done['answer'])
        self.assertNotIn('核对 App 的订单', done['answer'])

    async def test_repeated_cancel_and_lost_caller_wait_for_cleanup_and_keep_phone_lease(self):
        identity = f'cancel-test-{os.getpid()}'
        lock = Path('/tmp') / f'paios-phone-cancel_test_{os.getpid()}.lock'
        self.addCleanup(lock.unlink, missing_ok=True)
        for route in ('agent', 'ride cancellation'):
            running, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
            self.addCleanup(release.set)
            calls = []
            class Handler:
                def __await__(self):
                    async def wait():
                        running.set()
                        await asyncio.Event().wait()
                    return wait().__await__()
                async def cancel_run(self):
                    calls.append('cleanup')
                    cleaning.set()
                    await release.wait()
            handler, driver = Handler(), mock.Mock()
            config = SimpleNamespace(device=SimpleNamespace(), agent=SimpleNamespace(), llm_profiles={})
            async def ride(*args, **kwargs):
                return dict(success=False, answer=await server._cancel_ride(config, driver))
            with mock.patch.object(server, 'PHONE_SERIAL', identity), mock.patch.object(server, '_one_phone', asyncio.Lock()), \
                 mock.patch.object(server, '_load_model'), \
                 mock.patch.object(server, 'ConfigLoader', SimpleNamespace(load=lambda _: config), create=True), \
                 mock.patch.object(server, 'MobileAgent', return_value=SimpleNamespace(run=lambda: handler), create=True), \
                 mock.patch.object(server, '_agent', server._agent if route == 'agent' else ride), \
                 mock.patch.object(server, '_driver', new=mock.AsyncMock(return_value=driver)), \
                 mock.patch.object(server, '_count_steps', new=mock.AsyncMock()), \
                 mock.patch.object(server, '_screen_signs', new=mock.AsyncMock(return_value=set())), \
                 mock.patch.object(server, '_shell', return_value='owner-ime'), mock.patch.object(server, '_owner_active', return_value=False), \
                 mock.patch.object(server, '_preflight', return_value=False), mock.patch.object(server, '_ensure_unlocked'), \
                 mock.patch.object(server, '_ensure_cn_identity'), mock.patch.object(server, '_at_checkout', return_value=False), \
                 mock.patch.object(server, '_sleep_later'):
                jid = (await server.phone_task(GOAL, repeat=True, principal_id="owner", effect={"kind": "external", "task_type": "purchase_errand", "requested": True}))['job_id']
                await asyncio.wait_for(running.wait(), 1)
                first = asyncio.create_task(server.phone_cancel(jid))
                await asyncio.wait_for(cleaning.wait(), 1)
                second = asyncio.create_task(server.phone_cancel(jid))
                await asyncio.sleep(0)
                self.assertFalse(first.done(), route)
                self.assertFalse(second.done(), route)
                first.cancel()  # an RPC caller going away cannot cancel the job's cleanup again
                with self.assertRaises(asyncio.CancelledError): await first
                self.assertFalse(second.done(), route)
                with lock.open() as contender:
                    with self.assertRaises(BlockingIOError): fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    release.set()
                    stopped = await asyncio.wait_for(second, 1)
                    fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertEqual(stopped['stopped'], [jid])
                self.assertEqual(calls, ['cleanup'], route)
                done = json.loads((self.spool / f'{jid}.done.json').read_text())
                self.assertEqual((done['success'], done['terminal_reason']), (False, 'cancelled_by_user'))

    async def test_observed_windows_produce_indexed_tappable_mobilerun_state_on_usb_and_lan(self):
        from mobilerun.tools.filters.concise_filter import ConciseFilter
        from mobilerun.tools.formatters.indexed_formatter import IndexedFormatter
        from mobilerun.tools.ui.provider import AndroidStateProvider
        from mobilerun_core_local.driver.android import AndroidDriver
        xml = '''<hierarchy width="1080" height="2400">
          <node package="com.aliyun.tongyi" bounds="[0,0][1080,2400]">
            <node text="生活帮手" class="android.widget.Button" clickable="true" enabled="true" bounds="[900,2000][1080,2080]"/>
          </node>
          <node text="推荐问题" bounds="[0,100][1080,200]"/>
        </hierarchy>'''
        for serial in ('phone', '192.0.2.7:5555'):
            with mock.patch.object(server, 'SERIAL', serial), \
                 mock.patch.object(server, 'CONFIG', str(Path(__file__).with_name('mobilerun-config.example.yaml'))), \
                 mock.patch.object(server, '_observation', return_value=xml), \
                 mock.patch.object(AndroidDriver, 'connect', new=mock.AsyncMock()):
                driver = await server._driver(repair=False)
                state = await AndroidStateProvider(driver, ConciseFilter(), IndexedFormatter()).get_state()
            self.assertIn('com.aliyun.tongyi', state.formatted_text)
            self.assertIn('推荐问题', state.formatted_text)
            button = next(state.get_element(i) for i in range(1, 10)
                          if state.get_element(i) and state.get_element(i).get('text') == '生活帮手')
            self.assertEqual(state.get_element_coords(button['index']), (990, 2040))


class PostRunChecks(unittest.IsolatedAsyncioTestCase):
    """Without ride/pay authority the executor re-reads the screen after the run; unreadable is never "nothing happened"."""

    async def run_agent(self, signs):
        class Handler:
            def __await__(self):
                async def done():
                    return SimpleNamespace(success=True, reason="停在付款页", steps=3)
                return done().__await__()
        config = SimpleNamespace(device=SimpleNamespace(), agent=SimpleNamespace(), llm_profiles={})
        reads = mock.AsyncMock(side_effect=signs)
        with mock.patch.object(server, '_load_model'), \
             mock.patch.object(server, 'ConfigLoader', SimpleNamespace(load=lambda _: config), create=True), \
             mock.patch.object(server, 'MobileAgent', return_value=SimpleNamespace(run=lambda: Handler()), create=True), \
             mock.patch.object(server, '_count_steps', new=mock.AsyncMock()), \
             mock.patch.object(server, '_screen_signs', new=reads):
            return await server._agent(GOAL, 10, None, driver=mock.Mock()), reads.await_count

    async def test_unreadable_after_a_second_look_is_reported_unverified(self):
        outcome, reads = await self.run_agent([set(), set(), None, None, None, None])
        self.assertFalse(outcome['success'])
        self.assertTrue(outcome['answer'].startswith('【有没有叫到车、有没有下单付款无法核验】'), outcome['answer'])
        self.assertEqual(reads, 6)

    async def test_a_redraw_that_reads_on_the_second_look_is_clean(self):
        outcome, reads = await self.run_agent([set(), set(), None, set(), set()])
        self.assertTrue(outcome['success'])
        self.assertEqual(outcome['answer'], '停在付款页')


class ConfiguredTiers(unittest.IsolatedAsyncioTestCase):
    """Models and endpoints are configuration: the thorough tier runs the config's `thorough` profile for every role,
    with the key file named by the profile's variable."""

    async def test_thorough_tier_uses_the_configured_profile_and_key(self):
        class Handler:
            def __await__(self):
                async def done():
                    return SimpleNamespace(success=True, reason="看完了", steps=1)
                return done().__await__()
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, 'key').write_text('configured-key\n')
            thorough = SimpleNamespace(model='any-vision-model', kwargs={'is_chat_model': True, 'api_key_file_env': 'PAIOS_TEST_KEY_FILE'})
            config = SimpleNamespace(device=SimpleNamespace(), agent=SimpleNamespace(fast_agent=SimpleNamespace()),
                                     llm_profiles={'thorough': thorough, **{role: SimpleNamespace(kwargs={}) for role in server.ROLES}})
            with mock.patch.dict(os.environ, {'PAIOS_TEST_KEY_FILE': str(Path(tmp, 'key'))}), \
                 mock.patch.object(server, '_load_model'), \
                 mock.patch.object(server, 'ConfigLoader', SimpleNamespace(load=lambda _: config), create=True), \
                 mock.patch.object(server, 'MobileAgent', return_value=SimpleNamespace(run=lambda: Handler()), create=True), \
                 mock.patch.object(server, '_count_steps', new=mock.AsyncMock()), \
                 mock.patch.object(server, '_screen_signs', new=mock.AsyncMock(return_value=set())):
                outcome = await server._agent(GOAL, 10, None, tier='thorough', driver=mock.Mock())
        self.assertTrue(outcome['success'], outcome)
        self.assertTrue(all(config.llm_profiles[role] is thorough for role in server.ROLES))
        self.assertEqual(thorough.kwargs['api_key'], 'configured-key')
        self.assertNotIn('api_key_file_env', thorough.kwargs)
        self.assertTrue(config.agent.fast_agent.vision)


class Guard(unittest.TestCase):
    def test_a_screen_without_any_readable_text_is_not_tapped(self):
        class Blank:
            taps = []

            async def screenshot(self):
                return frame((1080,2400))

            async def tap(self, x, y):
                self.taps.append((x, y))

        guard = server.CheckoutStop(Blank())
        with mock.patch.object(server, "_screen_nodes", lambda *_: []), mock.patch.object(server, "_tree", lambda: native([("", 0, 0, 10, 10)], (1080,2400))):
            with self.assertRaises(RuntimeError) as refused:
                asyncio.run(guard.tap(100, 100))
        self.assertIn("读不到任何文字", str(refused.exception))
        self.assertEqual(Blank.taps, [])


class Lease(unittest.IsolatedAsyncioTestCase):
    async def test_a_second_holder_of_the_same_phone_waits_and_then_gives_up(self):
        self.addCleanup((Path('/tmp') / f'paios-phone-test_{os.getpid()}.lock').unlink, missing_ok=True)
        with mock.patch.object(server, "PHONE_SERIAL", f"test-{os.getpid()}"), mock.patch.object(server, "OWNER_WAIT_S", 1):
            async with server._device_lease():
                with mock.patch.object(server, "SERIAL", "192.0.2.2:5555"), self.assertRaises(RuntimeError) as busy:
                    async with server._device_lease():
                        pass
            self.assertIn("另一个执行器", str(busy.exception))
            async with server._device_lease():  # released: the next holder gets it
                pass


class DeviceSelection(unittest.IsolatedAsyncioTestCase):
    async def test_errands_use_usb_then_verified_lan_then_connected_network_and_refuse_wrong_phones(self):
        for usb, lan, network, expected, peers in [(True, 'phone', 'phone', 'phone', []), (False, 'phone', 'phone', '10.1.2.3:5555', []),
                                                   (False, 'wrong', 'phone', '100.64.1.2:5555', []), (False, 'wrong', 'wrong', None, []),
                                                   (False, 'wrong', 'phone', '10.1.2.7:5555', ['10.1.2.7:5555'])]:
            inputs, connections = [], []
            def run(args, **kwargs):
                if args[0] == '/sbin/route': output = 'gateway: 10.1.2.3\ninterface: en0'
                elif args[-1] == 'devices': output = 'List of devices attached\n' + ('phone\tdevice\n' if usb else '') + '100.64.1.2:5555\tdevice\n'
                elif args[1] == 'connect': connections.append(args[2]); output = 'connected'
                elif args[-1] == 'getprop ro.serialno': output = lan if args[2] == '10.1.2.3:5555' else 'phone' if args[2] in peers else network
                else:
                    if args[-1].startswith('input '): inputs.append(args[2])
                    output = ''
                return subprocess.CompletedProcess(args, 0, stdout=output, stderr='')
            def unlock(_):
                server._shell('input keyevent KEYCODE_WAKEUP', check=True)
                raise RuntimeError('device selection reached unlock')
            with mock.patch.object(server, 'PHONE_SERIAL', 'phone'), mock.patch.object(server, 'SPOOL', None), \
                 mock.patch.object(server, '_device_lease', lambda: asyncio.Lock()), \
                 mock.patch.object(server.subprocess, 'run', run), mock.patch.object(server, '_owner_active', return_value=False), \
                 mock.patch.object(server, '_preflight', return_value=False), \
                 mock.patch.object(server, '_ensure_unlocked', unlock), mock.patch.object(server, '_lan_peers', lambda _: peers):
                result = await server.phone_task(GOAL, repeat=True, principal_id="owner", effect={"kind": "external", "task_type": "purchase_errand", "requested": True})
            self.assertFalse(result['success'])
            self.assertEqual(inputs, [expected] if expected else [])
            self.assertTrue(all(c == '10.1.2.3:5555' or c in peers for c in connections), 'LAN only: no VPN activation or network connect')


class CloudExecutor(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('cloud_executor', Path(__file__).with_name('server.py'))
        self.s = importlib.util.module_from_spec(spec)
        with mock.patch.dict(os.environ, {'PAIOS_PHONE_PROVIDER': 'agentbay', 'PAIOS_PHONE_SERIAL': ''}):
            spec.loader.exec_module(self.s)
        self.phone = SimpleNamespace(session_id='session-1', serial='cloud.example:5555',
                                     view_url=mock.Mock(return_value='https://view.example/login'))
        self.provider = SimpleNamespace(lease=mock.AsyncMock(return_value=self.phone), release=mock.AsyncMock(),
                                        session_exists=mock.Mock(return_value=True))
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.lock = Path(self.dir.name) / 'agentbay.lock'
        real_open = os.open
        def local_open(path, *args):
            return real_open(self.lock if str(path) == '/tmp/paios-phone-agentbay.lock' else path, *args)
        for p in (mock.patch.dict(sys.modules, {'agentbay_phone': self.provider}), mock.patch.object(self.s, 'SPOOL', None),
                  mock.patch.object(self.s, 'CONFIG', str(Path(self.dir.name) / 'config.yaml')),
                  mock.patch.object(self.s.os, 'open', local_open),
                  mock.patch.object(self.s, '_owner_active', side_effect=AssertionError('physical owner guard')),
                  mock.patch.object(self.s, '_ensure_unlocked', side_effect=AssertionError('physical PIN unlock')),
                  mock.patch.object(self.s, '_sleep_later', side_effect=AssertionError('physical sleep')),
                  mock.patch.object(self.s, '_portal_problem', return_value=''), mock.patch.object(self.s, '_keyboard', return_value=False),
                  mock.patch.object(self.s, '_at_checkout', return_value=False)):
            p.start(); self.addCleanup(p.stop)

    async def test_cloud_errands_keep_the_leased_transport_and_repair_only_that_session(self):
        for case in ('healthy', 'lost', 'fresh', 'work failed', 'early failure'):
            with self.subTest(case=case):
                calls, connected, placed, lost = [], True, False, False
                def run(args, **kwargs):
                    nonlocal connected, placed, lost
                    calls.append(args)
                    if args[1] == 'connect':
                        self.assertEqual(args[2], self.phone.serial)
                        connected = True
                    else:
                        self.assertEqual(args[:3], [self.s.ADB, '-s', self.phone.serial])
                    command, output = args[-1], ''
                    if command == 'get-state':
                        return subprocess.CompletedProcess(args, 0 if connected else 1, stdout='device' if connected else '', stderr='')
                    if 'ro.serialno' in command: raise AssertionError('cloud identity must be the leased session')
                    if command == 'settings get secure default_input_method':
                        if case == 'early failure' or (case == 'lost' and not lost):
                            connected, lost = False, True
                            raise subprocess.TimeoutExpired(args, 15)
                        output = 'owner/.Keyboard'
                    if command.startswith('if [ -f '): output = '' if case == 'fresh' else 'ready'
                    if command == 'pm list packages':
                        output = '' if case == 'fresh' else 'package:com.mobilerun.portal\npackage:io.appium.settings'
                    if command == 'getprop gsm.sim.operator.iso-country': output = 'cn'
                    if command.startswith('appops get '): output = 'MOCK_LOCATION: allow'
                    if command.startswith('am start-foreground-service '): placed = True
                    if command.startswith('am stopservice '): placed = False
                    if command.startswith('dumpsys activity services ') and placed:
                        output = '  * ServiceRecord{abc u0 io.appium.settings/.LocationService}'
                    return subprocess.CompletedProcess(args, 0, stdout=output, stderr='')
                async def work(*args, **kwargs):
                    self.assertTrue(placed)
                    if case == 'work failed': raise RuntimeError('work failed')
                    return {'success': True, 'answer': 'ok', 'steps': 1}
                with mock.patch.object(self.s.subprocess, 'run', run), mock.patch.object(self.s, '_agent', work):
                    result = await self.s.phone_task('读取首页', latitude=31.2, longitude=121.5, principal_id="owner", effect={"kind": "read", "task_type": "read_app", "requested": True})
                self.assertEqual(result['success'], case not in ('work failed', 'early failure'))
                self.provider.lease.assert_awaited_once_with('errand')
                self.provider.release.assert_awaited_once_with(self.phone, keep_warm=True)
                self.assertFalse(placed)
                installs = [c[-1] for c in calls if 'install' in c]
                self.assertEqual([Path(p).name for p in installs],
                                 [])
                self.assertTrue(all(Path(p).parent == Path(self.s.CONFIG).parent / 'apk' for p in installs))
                self.assertEqual(sum('push' in c for c in calls), int(case == 'fresh'))
                self.assertEqual(sum(c[1] == 'connect' for c in calls), int(case in ('lost', 'early failure')))
                self.provider.lease.reset_mock(); self.provider.release.reset_mock()

    async def test_startup_reaper_retries_and_respects_a_live_process_lease(self):
        self.provider.reap_login = mock.Mock(side_effect=[RuntimeError('upload unavailable'), True])
        with mock.patch.object(self.s, 'LOGIN_RETRY_S', 0.01):
            await asyncio.wait_for(self.s._reap_login(), 1)
        self.assertEqual(self.provider.reap_login.call_count, 2)
        self.provider.reap_login.reset_mock()
        with self.lock.open() as owner:
            fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
            await self.s._reap_login()
        self.provider.reap_login.assert_not_called()

    async def test_shutdown_joins_reaper_and_holds_lease_until_sdk_finishes(self):
        import threading
        entered, finish = threading.Event(), threading.Event()
        self.addCleanup(finish.set)
        def reap():
            entered.set()
            if not finish.wait(2):
                raise RuntimeError('fake SDK gate timed out')
            raise RuntimeError('upload unavailable')
        self.provider.reap_login = mock.Mock(side_effect=reap)
        poller_stopped = asyncio.Event()
        async def poller():
            try:
                await asyncio.Event().wait()
            finally:
                poller_stopped.set()
        with mock.patch.object(self.s, '_cancel_poller', poller), mock.patch.object(self.s, 'LOGIN_RETRY_S', 0.01):
            lifespan = self.s._lifespan(None)
            await lifespan.__aenter__()
            self.assertTrue(await asyncio.to_thread(entered.wait, 1))
            shutdown = asyncio.create_task(lifespan.__aexit__(None, None, None))
            await asyncio.wait_for(poller_stopped.wait(), 1)
            await asyncio.sleep(0)
            self.assertFalse(shutdown.done())
            with self.lock.open() as contender:
                with self.assertRaises(BlockingIOError): fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finish.set()
                await asyncio.wait_for(shutdown, 1)
                fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
            await asyncio.sleep(0.03)
        self.provider.reap_login.assert_called_once()

    async def test_cancelled_errand_keeps_the_provider_lock_until_context_sync_finishes(self):
        running, syncing, finish = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def work(*args, **kwargs):
            running.set()
            await asyncio.Event().wait()
        async def release(*args, **kwargs):
            syncing.set()
            await finish.wait()
        self.provider.release.side_effect = release
        with mock.patch.object(self.s, '_online', return_value=True), mock.patch.object(self.s, '_shell', return_value='cn'), \
             mock.patch.object(self.s, '_preflight', return_value=False), mock.patch.object(self.s, '_agent', work):
            task = asyncio.create_task(self.s.phone_task(GOAL, principal_id="owner", effect={"kind": "external", "task_type": "purchase_errand", "requested": True}))
            await asyncio.wait_for(running.wait(), 1)
            task.cancel()
            await asyncio.wait_for(syncing.wait(), 1)
            task.cancel()
            await asyncio.sleep(0)
            self.assertFalse(task.done())
            with self.lock.open() as contender:
                with self.assertRaises(BlockingIOError): fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finish.set()
                with self.assertRaises(asyncio.CancelledError): await task
                fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.provider.release.assert_awaited_once_with(self.phone, keep_warm=True)


if __name__ == "__main__":
    unittest.main()
