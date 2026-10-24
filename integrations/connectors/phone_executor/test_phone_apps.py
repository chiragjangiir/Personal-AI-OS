"""APK trust and cold/warm image provisioning; no device or downloads."""
import io
import json
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest import mock

import phone_apps


class PhoneApps(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads(Path(phone_apps.__file__).with_name("phone-apks.json").read_text())

    def test_preinstalled_custom_image_needs_no_download_or_install(self):
        calls = []
        def adb(*args, **_):
            calls.append(args[-1])
            return "\n".join("package:" + e["package"] + " versionCode:" + str(e["version_code"]) for e in self.manifest)
        self.assertEqual(phone_apps.install("phone", adb, mock.Mock())["installed"], [])
        self.assertFalse(any("curl" in c or "pm install" in c for c in calls))

    def test_system_image_installs_the_verified_context_cache(self):
        calls = []
        def adb(*args, **_):
            command = args[-1]
            calls.append(command)
            if "sha256sum" in command:
                entry = next(e for e in self.manifest if phone_apps._filename(e) in command)
                return entry["sha256"] + "  cached.apk"
            return "Success" if command.startswith("pm install") else ""
        result = phone_apps.install("phone", adb, mock.Mock())
        self.assertEqual(result["installed"], [e["package"] for e in self.manifest])
        self.assertFalse(any("curl" in c for c in calls))

    def test_custom_image_older_app_is_upgraded_from_cache(self):
        def adb(*args, **_):
            command = args[-1]
            if command == "pm list packages --show-versioncode":
                return "\n".join("package:" + e["package"] + " versionCode:" +
                    str(e["version_code"] - (1 if e["package"] == "com.aliyun.tongyi" else 0)) for e in self.manifest)
            if "sha256sum" in command:
                return self.manifest[0]["sha256"] + "  cached.apk"
            return "Success" if command.startswith("pm install") else ""
        self.assertEqual(phone_apps.install("phone", adb, mock.Mock())["installed"], ["com.aliyun.tongyi"])

    def test_selective_install_keeps_executor_support_apks(self):
        calls = []
        def adb(*args, **_):
            command = args[-1]
            calls.append(command)
            if "sha256sum" in command:
                entry = next(e for e in self.manifest if phone_apps._filename(e) in command)
                return entry["sha256"] + "  cached.apk"
            return "Success" if command.startswith("pm install") else ""
        selected = ("com.aliyun.tongyi",)
        result = phone_apps.install("phone", adb, mock.Mock(), packages=selected)
        self.assertEqual(result["installed"], ["com.aliyun.tongyi", "com.mobilerun.portal", "io.appium.settings"])
        self.assertEqual([c for c in calls if c.startswith("am force-stop")], ["am force-stop com.aliyun.tongyi"])

    def test_binding_policy_never_downloads_login_implicitly(self):
        client = mock.Mock()
        client.context.get.return_value.context.id = "ctx"
        with mock.patch.dict(phone_apps.os.environ, {"PAIOS_AGENTBAY_CONTEXT_PREFIX": "isolated-"}), \
             mock.patch.dict(phone_apps.RESOURCE_EXCLUSIONS, {"com.aliyun.tongyi": ("cache/measured",)}):
            syncs = phone_apps.contexts(client, lambda result: result, packages=("com.aliyun.tongyi",))
        self.assertEqual(client.context.get.call_args_list, [
            mock.call("isolated-com.aliyun.tongyi", create=True), mock.call("paios-phone-apks", create=True)])
        for sync in syncs:
            policy = sync.policy.__dict__()
            self.assertFalse(policy["downloadPolicy"]["autoDownload"])
            self.assertFalse(policy["uploadPolicy"]["autoUpload"])
        self.assertEqual(syncs[0].policy.__dict__()["bwList"]["whiteLists"], [{
            "path": "",
            "excludePaths": ["/cache/measured"],
            "isPathRegex": False, "isExcludeRegex": False}])
        self.assertEqual(syncs[1].policy.__dict__()["bwList"]["whiteLists"][0]["excludePaths"], [])

    def test_selective_sync_reports_progress(self):
        session, client, progress = mock.Mock(), mock.Mock(), mock.Mock()
        client.context.get.return_value.context.id = "ctx"
        selected = ("com.xiaomi.smarthome",)
        with mock.patch.object(phone_apps, "sync_context") as sync:
            phone_apps.sync_apps(session, client, lambda result: result, "download", packages=selected, progress=progress)
        self.assertEqual(sync.call_args_list, [mock.call(session, client, mock.ANY, "ctx", root + selected[0], "download")
                                              for root in phone_apps.ROOTS])
        self.assertEqual(progress.call_count, 6)

    def test_sync_waits_for_requested_direction_and_new_generation(self):
        session, client = mock.Mock(session_id="session"), mock.Mock(api_key="test-key")
        def task(start, mode="download", status="Success", context="ctx", path="/data/app"):
            return SimpleNamespace(context_id=context, path=path, task_type=mode,
                                   start_time=start, status=status, error_message="")
        session.context.info.side_effect = [SimpleNamespace(success=True, context_status_data=items) for items in (
            [task(100)],
            [task(200, mode="upload"), task(100), task(300, context="other"), task(300, path="/other")],
            [task(101, status="Running")], [task(101)])]
        client.client.sync_context.return_value.body.success = True
        with mock.patch.object(phone_apps.time, "sleep") as sleep:
            phone_apps.sync_context(session, client, lambda result: result, "ctx", "/data/app", "download")
        self.assertEqual(sleep.call_count, 3)
        self.assertEqual(sleep.call_args_list[0], mock.call(1.01))
        request = client.client.sync_context.call_args.args[0]
        self.assertEqual(request.to_map(), {"Authorization": "Bearer test-key", "SessionId": "session",
                                           "ContextId": "ctx", "Path": "/data/app", "Mode": "download"})
        self.assertTrue(all(call.kwargs["task_type"] == "download" for call in session.context.info.call_args_list))
        session.context.sync.assert_not_called()

    def test_existing_generation_delay_precedes_native_request(self):
        session, client = mock.Mock(session_id="session"), mock.Mock(api_key="test-key")
        def task(start):
            return SimpleNamespace(context_id="ctx", path="/data/app", task_type="upload", start_time=start,
                                   status="Success", error_message="")
        session.context.info.side_effect = [SimpleNamespace(context_status_data=[task(start)]) for start in (100, 101)]
        client.client.sync_context.return_value.body.success = True
        order = mock.Mock()
        order.attach_mock(client.client.sync_context, "request")
        with mock.patch.object(phone_apps.time, "sleep") as sleep:
            order.attach_mock(sleep, "sleep")
            phone_apps.sync_context(session, client, lambda result: result, "ctx", "/data/app", "upload")
        self.assertEqual(order.mock_calls[0], mock.call.sleep(1.01))
        self.assertEqual(order.mock_calls[1][0], "request")
        self.assertEqual(sleep.call_count, 1)

    def test_sync_propagates_new_generation_failure(self):
        session, client = mock.Mock(), mock.Mock(api_key="test-key")
        failed = SimpleNamespace(context_id="ctx", path="/data/app", task_type="upload", start_time=1,
                                 status="Failed", error_message="storage unavailable")
        session.context.info.side_effect = [SimpleNamespace(context_status_data=[]), SimpleNamespace(context_status_data=[failed])]
        client.client.sync_context.return_value.body.success = True
        with self.assertRaisesRegex(RuntimeError, "storage unavailable"):
            phone_apps.sync_context(session, client, lambda result: result, "ctx", "/data/app", "upload")

    def test_sync_rejects_api_failure_without_polling(self):
        session, client = mock.Mock(), mock.Mock(api_key="test-key")
        session.context.info.return_value.context_status_data = []
        client.client.sync_context.return_value.body = SimpleNamespace(success=False, code="Rejected", message="sync denied")
        with self.assertRaisesRegex(RuntimeError, "Rejected.*sync denied"):
            phone_apps.sync_context(session, client, lambda result: result, "ctx", "/data/app", "upload")
        self.assertEqual(session.context.info.call_count, 1)

    def test_sync_times_out_when_no_new_task_appears(self):
        session, client = mock.Mock(), mock.Mock(api_key="test-key")
        session.context.info.return_value.context_status_data = []
        client.client.sync_context.return_value.body.success = True
        with mock.patch.object(phone_apps.time, "monotonic", side_effect=[0, 0, 750, 750]), \
             mock.patch.object(phone_apps.time, "sleep"):
            with self.assertRaisesRegex(TimeoutError, "no completed new sync generation"):
                phone_apps.sync_context(session, client, lambda result: result, "ctx", "/data/app", "download")

    def test_changed_official_download_stops_before_upload_or_install(self):
        session = mock.Mock()
        calls = []
        def adb(*args, **_):
            calls.append(args[-1])
            return ""
        with mock.patch.object(phone_apps, "_manifest", return_value=[self.manifest[4]]), \
             mock.patch.object(phone_apps.urllib.request, "urlopen", return_value=io.BytesIO(b"changed")):
            with self.assertRaisesRegex(RuntimeError, "package/signer pin no longer applies"):
                phone_apps.install("phone", adb, session)
        session.file_system.upload_file.assert_not_called()
        self.assertFalse(any("pm install" in c for c in calls))
