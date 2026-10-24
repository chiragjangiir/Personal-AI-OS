"""Fake SDK/adb checks for session ownership, persisted app data and release failures; no network."""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agentbay_phone as provider


def result(**kw):
    return NS(success=True, error_message="", code="", **kw)


class AgentBayPhone(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / "state.json"
        key = Path(self.tmp.name) / "key"
        key.write_text("fake-key")
        Path(str(key) + ".pub").write_text("fake-public-key")
        self.session = mock.Mock(session_id="new")
        self.session.get_status.return_value = result(status="RUNNING")
        self.session.info.return_value = result(data=NS(resource_url="https://view.example/phone"))
        self.session.mobile.get_adb_url.return_value = result(data="adb connect cloud:1234")
        self.session.keep_alive.return_value = result()
        self.session.context.sync.side_effect = AssertionError("SDK sync can accept a stale task generation")
        self.session.context.bind.return_value = result()
        self.client = mock.Mock(api_key="fake-key")
        self.sync_response = NS(body=NS(success=True, code="", message=""))
        self.sync_generation = 0
        self.sync_history = {}
        self.client.client.sync_context.side_effect = self.sync_request
        self.session.context.info.side_effect = self.context_info
        self.client.get.return_value = result(session=self.session)
        self.client.delete.return_value = result()
        self.client.context.get.side_effect = lambda name, **_: result(context=NS(id=name))
        self.client.create.side_effect = self.create
        self.commands = []
        provider._client = None
        self.addCleanup(setattr, provider, "_client", None)
        for p in (mock.patch.dict(os.environ, {"PAIOS_AGENTBAY_KEY_FILE": str(key), "PAIOS_AGENTBAY_ADBKEY": str(key),
                                              "PAIOS_AGENTBAY_STATE": str(self.state), "PAIOS_ADB": "fake-adb"}),
                  mock.patch.object(provider, "AgentBay", return_value=self.client),
                  mock.patch.object(provider.phone_apps, "install", return_value={"install_s": 0, "installed": [], "cache_changed": False}),
                  mock.patch.object(provider.subprocess, "run", side_effect=self.adb)):
            p.start()
            self.addCleanup(p.stop)

    def sync_request(self, request):
        if self.sync_response.body.success:
            self.sync_generation += 1
            key = (request.context_id, request.path, request.mode)
            self.sync_history[key] = NS(context_id=request.context_id, path=request.path,
                task_type=request.mode, start_time=self.sync_generation, status="Success", error_message="")
        return self.sync_response

    def context_info(self, context_id, path, task_type):
        item = self.sync_history.get((context_id, path, task_type))
        return result(context_status_data=[item] if item else [])

    def sync_calls(self):
        return [(call.args[0].context_id, call.args[0].path, call.args[0].mode)
                for call in self.client.client.sync_context.call_args_list]

    def create(self, params):
        return result(session=self.session)

    def adb(self, command, **kw):
        self.assertEqual(kw["env"]["ADB_VENDOR_KEYS"], os.environ["PAIOS_AGENTBAY_ADBKEY"])
        self.commands.append(command)
        return NS(stdout="1", returncode=0)

    async def test_create_then_warm_reuse_after_restart(self):
        first = await provider.lease()
        self.client.client.sync_context.reset_mock()
        await provider.release(first)
        provider._client = None  # executor restarted; only the record survives
        second = await provider.lease()
        self.assertEqual((first.session_id, second.session_id, second.serial), ("new", "new", "cloud:1234"))
        self.assertEqual(provider.status()["view_url"], "https://view.example/phone")
        self.client.create.assert_called_once()
        self.client.get.assert_called_once_with("new")
        self.assertEqual(self.sync_calls(), [("paios-app-" + p, root + p, "upload")
                          for p in provider.APP_PACKAGES for root in provider.phone_apps.ROOTS])
        self.client.delete.assert_not_called()
        self.assertNotIn(["fake-adb", "disconnect", "cloud:1234"], self.commands)
        await provider.release(second, keep_warm=False)
        self.client.delete.assert_called_once_with(self.session, sync_context=False)
        self.assertIn(["fake-adb", "disconnect", "cloud:1234"], self.commands)
        self.assertFalse(self.state.exists())

    async def test_dead_record_is_replaced(self):
        self.state.write_text(json.dumps(dict(session_id="expired", serial="old:1234")))
        self.client.get.return_value = NS(success=False, code="InvalidMcpSession.NotFound", error_message="gone")
        phone = await provider.lease()
        self.assertEqual(phone.session_id, "new")
        self.client.create.assert_called_once()
        self.assertIn(["fake-adb", "disconnect", "old:1234"], self.commands)
        await provider.release(phone, keep_warm=False)

    async def test_dead_record_is_replaced_when_adb_already_forgot_its_serial(self):
        self.state.write_text(json.dumps(dict(session_id="expired", serial="old:1234")))
        self.client.get.return_value = NS(success=False, code="InvalidMcpSession.NotFound", error_message="gone")
        def adb(command, **kw):
            if command[1:] == ["disconnect", "old:1234"]:
                self.commands.append(command)
                raise subprocess.CalledProcessError(1, command)
            return self.adb(command, **kw)
        with mock.patch.object(provider.subprocess, "run", side_effect=adb):
            phone = await provider.lease()
        self.assertEqual(phone.session_id, "new")
        self.client.create.assert_called_once()
        self.assertIn(["fake-adb", "disconnect", "old:1234"], self.commands)
        await provider.release(phone, keep_warm=False)

    async def test_unreachable_running_phone_is_deleted_before_replacement(self):
        self.state.write_text(json.dumps(dict(session_id="old", serial="old:1234", ready=True, created_at=time.time())))
        old = mock.Mock(session_id="old")
        old.context.info.side_effect = self.context_info
        old.get_status.return_value = result(status="RUNNING")
        old.mobile.get_adb_url.return_value = result(data="adb connect old:1234")
        self.client.get.return_value = result(session=old)
        def adb(command, **kw):
            if "old:1234" in command and "wait-for-device" in command:
                raise subprocess.TimeoutExpired(command, 60)
            return self.adb(command, **kw)
        with mock.patch.object(provider.subprocess, "run", side_effect=adb):
            phone = await provider.lease()
        self.client.delete.assert_called_once_with(old, sync_context=False)
        self.assertEqual(phone.session_id, "new")
        await provider.release(phone, keep_warm=False)

    async def test_sync_failure_preserves_record_and_does_not_delete(self):
        phone = await provider.lease()
        self.sync_response = NS(body=NS(success=False, code="SyncFailed", message="upload failed"))
        for warm in (True, False):
            with self.assertRaisesRegex(RuntimeError, "upload failed"):
                await provider.release(phone, keep_warm=warm)
            self.assertEqual(json.loads(self.state.read_text())["session_id"], phone.session_id)
            self.client.delete.assert_not_called()
        self.sync_response = NS(body=NS(success=True, code="", message=""))
        await provider.release(phone, keep_warm=False)

    async def test_app_contexts_and_one_root_repair_command_per_app(self):
        phone = await provider.lease()
        syncs = [*self.client.create.call_args.args[0].context_syncs, *self.session.context.bind.call_args.args]
        repairs = [c[-1] for c in self.commands if "chown -R" in c[-1]]
        self.assertEqual(len(repairs), len(provider.APP_PACKAGES))
        for package, command in zip(provider.APP_PACKAGES, repairs):
            expected = {root + package for root in ("/data/data/", "/data/user_de/0/", "/sdcard/Android/data/")}
            self.assertEqual({s.path for s in syncs if s.context_id == "paios-app-" + package}, expected)
            self.assertTrue(all(s.policy.upload_policy.upload_mode.value == "File"
                                for s in syncs if s.context_id == "paios-app-" + package))
            self.assertIn('test "$(id -u)" = 0', command)
            self.assertIn('pm list packages -U --user 0 ' + package, command)
            self.assertIn('[ -n "$uid" ] || exit 1', command)
            self.assertIn('chown -R "$uid:$uid" "$p" && restorecon -RF "$p"', command)
            self.assertTrue(all(path in command for path in expected))
        await provider.release(phone, keep_warm=False)

    async def test_install_precedes_restore_and_a_failed_install_cannot_upload(self):
        events = []
        def installed(*_):
            events.append("installed")
            return {"install_s": 1, "installed": ["com.aliyun.tongyi"], "cache_changed": False}
        def synced(request):
            events.append(request.mode)
            return self.sync_request(request)
        with mock.patch.object(provider.phone_apps, "install", side_effect=installed):
            self.client.client.sync_context.side_effect = synced
            self.session.context.bind.side_effect = lambda *args: (events.append("bound"), result())[1]
            phone = await provider.lease()
        self.assertEqual(events, ["download", "installed", "bound", *(["download"] * 12)])
        self.assertIn("create_ready_s", phone.timings)
        await provider.release(phone, keep_warm=False)
        self.client.client.sync_context.reset_mock()
        self.session.context.bind.reset_mock()
        self.client.delete.reset_mock()
        with mock.patch.object(provider.phone_apps, "install", side_effect=RuntimeError("bad signer")):
            with self.assertRaisesRegex(RuntimeError, "bad signer"):
                await provider.lease()
        self.assertEqual(self.sync_calls(), [("paios-phone-apks", "/data/local/tmp/apks", "download")])
        self.client.delete.assert_called_once_with(self.session, sync_context=False)
        self.session.context.bind.assert_not_called()

    async def test_apk_cache_uploads_only_when_changed_and_not_during_release(self):
        with mock.patch.object(provider.phone_apps, "install", return_value={"install_s": 1,
                               "installed": ["com.aliyun.tongyi"], "cache_changed": True}):
            phone = await provider.lease()
        self.assertIn(("paios-phone-apks", "/data/local/tmp/apks", "upload"), self.sync_calls())
        self.client.client.sync_context.reset_mock()
        await provider.release(phone, keep_warm=False)
        self.assertEqual(self.sync_calls(),
                         [("paios-app-" + p, root + p, "upload")
                          for p in provider.APP_PACKAGES for root in provider.phone_apps.ROOTS])

    async def test_image_config_change_replaces_the_warm_phone(self):
        phone = await provider.lease()
        await provider.release(phone)
        with mock.patch.dict(os.environ, {"PAIOS_AGENTBAY_IMAGE": "custom-image"}):
            replacement = await provider.lease()
        self.assertEqual(self.client.create.call_args.args[0].image_id, "custom-image")
        self.assertEqual(self.client.create.call_count, 2)
        self.client.delete.assert_called_once_with(self.session, sync_context=False)
        await provider.release(replacement, keep_warm=False)

    async def test_login_uses_manual_release_and_cannot_be_left_idle(self):
        phone = await provider.lease("login")
        self.assertTrue(self.client.create.call_args.args[0].lifecycle_policy.manual_release)
        await provider.release(phone)
        self.client.delete.assert_called_once_with(self.session, sync_context=False)
        self.assertFalse(self.state.exists())

    async def test_reclaimed_login_does_not_upload_or_delete_again(self):
        phone = await provider.lease("login")
        self.client.client.sync_context.reset_mock()
        self.client.get.return_value = NS(success=False, code="InvalidMcpSession.NotFound", error_message="gone")
        await provider.release(phone, keep_warm=False)
        self.client.client.sync_context.assert_not_called()
        self.client.delete.assert_not_called()
        self.assertFalse(self.state.exists())

    async def test_failed_delete_reconciles_exact_session_after_lost_response(self):
        phone = await provider.lease("login")
        self.client.delete.return_value = NS(success=False, error_message="response lost")
        with self.assertRaisesRegex(RuntimeError, "response lost"):
            await provider.release(phone, keep_warm=False)
        self.assertTrue(self.state.exists())
        self.client.client.sync_context.reset_mock()
        self.session.get_status.return_value = result(status="FINISH")
        await provider.release(phone, keep_warm=False)
        self.client.get.assert_called_with(phone.session_id)
        self.client.client.sync_context.assert_not_called()
        self.client.delete.assert_called_once_with(self.session, sync_context=False)
        self.assertFalse(self.state.exists())

    async def test_release_never_removes_a_replacement_record(self):
        phone = await provider.lease("login")
        replacement = dict(session_id="replacement", serial="other:1234", purpose="login", ready=True)
        self.state.write_text(json.dumps(replacement))
        await provider.release(phone, keep_warm=False)
        self.client.delete.assert_called_once_with(self.session, sync_context=False)
        self.assertEqual(json.loads(self.state.read_text()), replacement)

    async def test_failed_restore_cannot_overwrite_saved_data(self):
        self.sync_response = NS(body=NS(success=False, code="SyncFailed", message="download failed"))
        with self.assertRaisesRegex(RuntimeError, "download failed"):
            await provider.lease()
        self.assertEqual(self.sync_calls(), [("paios-phone-apks", "/data/local/tmp/apks", "download")])
        self.client.delete.assert_called_once_with(self.session, sync_context=False)
        self.assertFalse(self.state.exists())
        self.assertTrue(all(not s.policy.upload_policy.auto_upload for s in self.client.create.call_args.args[0].context_syncs))

    async def test_warm_phone_near_max_runtime_is_replaced_before_an_errand(self):
        self.state.write_text(json.dumps(dict(session_id="old", ready=True, created_at=time.time() - 3540)))
        old = mock.Mock(session_id="old")
        old.context.info.side_effect = self.context_info
        old.get_status.return_value = result(status="RUNNING")
        self.client.get.return_value = result(session=old)
        phone = await provider.lease()
        self.client.delete.assert_called_once_with(old, sync_context=False)
        self.assertEqual(phone.session_id, "new")
        await provider.release(phone, keep_warm=False)

    async def test_repeated_cancellation_joins_sdk_create_and_delete(self):
        entered, unblock = threading.Event(), threading.Event()
        def blocked_create(params):
            entered.set()
            unblock.wait(5)
            return self.create(params)
        self.client.create.side_effect = blocked_create
        task = asyncio.create_task(provider.lease())
        self.assertTrue(await asyncio.to_thread(entered.wait, 2))
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        unblock.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.client.delete.assert_called_once_with(self.session, sync_context=False)
        self.assertFalse(self.state.exists())

        phone = await provider.lease()
        entered.clear(); unblock.clear()
        def blocked_delete(*_, **kw):
            entered.set()
            unblock.wait(5)
            return result()
        self.client.delete.side_effect = blocked_delete
        task = asyncio.create_task(provider.release(phone, keep_warm=False))
        self.assertTrue(await asyncio.to_thread(entered.wait, 2))
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        unblock.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(self.state.exists())

    async def test_payment_checkpoint_budget_replaces_a_warm_phone_before_lifecycle_end(self):
        self.state.write_text(json.dumps(dict(session_id="old", ready=True, created_at=time.time() - 2500)))
        old = mock.Mock(session_id="old")
        old.context.info.side_effect = self.context_info
        old.get_status.return_value = result(status="RUNNING")
        self.client.get.return_value = result(session=old)
        phone = await provider.lease(extra_budget_s=1000)
        self.client.delete.assert_called_once_with(old, sync_context=False)
        self.assertEqual(phone.session_id, "new")
        await provider.release(phone, keep_warm=False)

    async def test_login_left_by_a_dead_executor_is_deleted_without_upload_but_a_warm_errand_phone_is_kept(self):
        self.state.write_text(json.dumps(dict(session_id="new", serial="cloud:1234", purpose="login", ready=True)))
        self.assertTrue(await asyncio.to_thread(provider.reap_login))
        self.client.client.sync_context.assert_not_called()
        self.client.delete.assert_called_once_with(self.session, sync_context=False)
        self.assertFalse(self.state.exists())
        self.state.write_text(json.dumps(dict(session_id="new", serial="cloud:1234", purpose="errand", ready=True)))
        self.assertFalse(await asyncio.to_thread(provider.reap_login))
        self.client.delete.assert_called_once()
        self.assertTrue(self.state.exists())
        self.assertTrue(await asyncio.to_thread(provider.reap_login, force=True))
        self.assertEqual(self.client.delete.call_count, 2)
        self.assertFalse(self.state.exists())

    async def test_login_does_not_restore_or_save_unselected_app_data(self):
        with mock.patch.object(provider.phone_apps, "sync_apps") as sync:
            phone = await provider.lease("login")
            sync.assert_not_called()
            await provider.release(phone, keep_warm=False)
            sync.assert_not_called()

    async def test_partial_restore_stays_blocked_for_save_across_restart(self):
        phone = await provider.lease("login")
        package = provider.APP_PACKAGES[0]
        with mock.patch.object(provider.phone_apps, "sync_apps", side_effect=RuntimeError("download failed")):
            with self.assertRaisesRegex(RuntimeError, "download failed"):
                await asyncio.to_thread(provider.sync_data, phone, (package,), "download")
        recovered = await asyncio.to_thread(provider._recorded)
        with self.assertRaisesRegex(RuntimeError, "恢复未完成"):
            await asyncio.to_thread(provider.sync_data, recovered, (package,), "upload")
        await provider.release(recovered, keep_warm=False)
        self.client.delete.assert_called_once()

    async def test_save_only_uploads_the_selected_app(self):
        phone = await provider.lease("login")
        self.client.client.sync_context.reset_mock()
        package = provider.APP_PACKAGES[1]
        await asyncio.to_thread(provider.sync_data, phone, (package,), "upload")
        self.assertEqual(self.sync_calls(), [
            ("paios-app-" + package, root + package, "upload")
            for root in provider.phone_apps.ROOTS])
        await provider.release(phone, keep_warm=False)

    async def test_timeout_longer_than_lifecycle_cannot_start_an_errand(self):
        with mock.patch.dict(os.environ, {"PAIOS_PHONE_TASK_TIMEOUT": "3600"}):
            with self.assertRaisesRegex(ValueError, "60-minute lifecycle"):
                await provider.lease()
        self.client.create.assert_not_called()


class AdbInputBoundary(unittest.TestCase):
    def test_noninteractive_adb_cannot_consume_mcp_input(self):
        script = ("import agentbay_phone as p; "
                  "print(repr(p._adb('-c', 'import sys; print(sys.stdin.read())')))")
        child = subprocess.run([sys.executable, "-c", script], cwd=Path(provider.__file__).parent,
                               input='{"jsonrpc":"2.0","id":1}\n', capture_output=True, text=True, check=True,
                               env=os.environ | {"PAIOS_ADB": sys.executable, "PAIOS_AGENTBAY_ADBKEY": "unused"})
        self.assertEqual(child.stdout.strip(), "''")


if __name__ == "__main__":
    unittest.main()
