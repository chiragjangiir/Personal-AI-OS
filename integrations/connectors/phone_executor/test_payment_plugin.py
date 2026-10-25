"""Payment admission contract only; no server, phone or network.
Run ci/install.sh executor first, then use the executor interpreter:
python -I test_payment_plugin.py. PAIOS_NATIVE_SOURCE_TEST_ROOT can select a composed source.
"""
import importlib.util
import io
import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, os.environ.get("PAIOS_NATIVE_SOURCE_TEST_ROOT", str(ROOT / ".scratch/hermes-source")))
from gateway.session_context import clear_session_vars, set_session_vars

SOURCE = ROOT / "integrations/hermes/personal_aios/__init__.py"
SPEC = importlib.util.spec_from_file_location("payment_plugin_test", SOURCE,
                                            submodule_search_locations=[str(SOURCE.parent)])
plugin = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = plugin
SPEC.loader.exec_module(plugin)
NAMES = ("phone_task", "mcp__phone__phone_task")
LINEAGE = {"principal_id": "owner", "job_id": "server-job", "origin_processed_event_id": "server-origin"}


class PaymentPlugin(unittest.TestCase):
    def setUp(self):
        self.provider = SimpleNamespace(owner_mac_enabled=False, capability_enabled=lambda _: False, _request=mock.Mock(return_value={**LINEAGE, "allowed": True, "ride_allowed": True}))
        hooks, gates = {}, []
        sections = mock.Mock()
        ctx = SimpleNamespace(register_memory_provider=lambda _: None,
                              register_hook=lambda name, hook: hooks.__setitem__(name, hook),
                              register_system_prompt_section=sections)
        with mock.patch.object(plugin, "PersonalAIOSProvider", return_value=self.provider), \
                mock.patch.dict(sys.modules, {"payment_plugin_test.cron": SimpleNamespace(register=lambda *_: None),
                    "payment_plugin_test.self_tools": SimpleNamespace(register=lambda *_: None),
                    "payment_plugin_test.effects": SimpleNamespace(register=lambda *_: None, check_effect=lambda *_: None,
                        register_execution_gate=lambda ctx, gate: gates.append(gate))}), \
                mock.patch.dict("os.environ", {"PAIOS_WORKSHOP_HOST": ""}):
            plugin.register(ctx)
        reporting = [call for call in sections.call_args_list if call.args[0] == 'personal-aios.reporting']
        self.assertEqual(len(reporting), 1)
        content = reporting[0].args[1]
        self.assertIn('只报告记录支持的事实', content)
        self.assertLessEqual(len(content), reporting[0].kwargs['max_chars'])
        # This matrix tests payment/source directives; Hermes tests exercise the real dispatch middleware.
        self.hook = gates[0]
        effect_patch = mock.patch.dict(sys.modules, {"payment_plugin_test.effects": SimpleNamespace(check_effect=lambda *_: None)})
        effect_patch.start()
        self.addCleanup(effect_patch.stop)
        tokens = set_session_vars(platform="api_server", session_id="session-host", session_key="trusted-run")
        self.addCleanup(clear_session_vars, tokens)

    def call(self, name, args):
        return self.hook(name, args, session_id="session-host", run_id="forged-kwargs")

    def test_I1_legacy_limit_is_blocked_even_null_without_contacting_authority(self):
        for name in NAMES:
            for value in (None, 0, 30):
                with self.subTest(name=name, value=value):
                    result = self.call(name, {"pay_limit_yuan": value, "payment_intent": "pi-new"})
                    self.assertEqual(result, {"action": "block", "message":
                        "pay_limit_yuan 已取消：先调用 paios_payment(action=request)，再传 payment_intent"})
        self.provider._request.assert_not_called()

    def test_I1_intent_is_checked_against_trusted_run_for_both_tool_names(self):
        for name in NAMES:
            with self.subTest(name=name):
                self.assertEqual(self.call(name, {"payment_intent": "pi-order", "run_id": "forged-args", "principal_id": "forged-owner",
                                                  "job_id": "forged-job", "origin_processed_event_id": "forged-origin"}),
                    {"action": "modify", "args": LINEAGE})
                self.provider._request.assert_called_with("/internal/hermes/payment-source",
                    {"run_id": "trusted-run", "intent_id": "pi-order"})

    def test_I1_rejected_intent_and_transport_or_malformed_response_fail_closed(self):
        for response in ({"allowed": False}, {"allowed": "true"}, {}, None, []):
            with self.subTest(response=response):
                self.provider._request.return_value = response
                self.assertEqual(self.call(NAMES[0], {"payment_intent": "pi-other-run"})["action"], "block")
        for error in (URLError("offline"), TimeoutError(), ValueError("bad JSON"), OSError("key unreadable")):
            with self.subTest(error=type(error).__name__):
                self.provider._request.side_effect = error
                self.assertEqual(self.call(NAMES[0], {"payment_intent": "pi-order"})["action"], "block")

    def test_missing_session_binding_blocks_without_request(self):
        tokens = set_session_vars(platform="api_server", session_id="session-host", session_key="")
        try:
            self.assertEqual(self.call(NAMES[0], {"payment_intent": "pi-order"})["action"], "block")
            self.provider._request.assert_not_called()
        finally:
            clear_session_vars(tokens)

    def test_ride_semantics_remain_independent_and_combined_request_needs_both(self):
        for name in NAMES:
            for payment in (False, True):
                for allowed, ride_allowed in ((False, False), (True, False), (False, True), (True, True)):
                    with self.subTest(name=name, payment=payment, allowed=allowed, ride_allowed=ride_allowed):
                        self.provider._request.return_value = {**LINEAGE, "allowed": allowed, "ride_allowed": ride_allowed}
                        args = {"ride_ok": True, **({"payment_intent": "pi-order"} if payment else {})}
                        result = self.call(name, args)
                        self.assertEqual(result == {"action": "modify", "args": LINEAGE}, ride_allowed and (allowed or not payment))
                        self.provider._request.assert_called_with("/internal/hermes/payment-source",
                            {"run_id": "trusted-run", **({"intent_id": "pi-order"} if payment else {})})

    def test_unprotected_work_binds_principal_without_payment_authority(self):
        for name, args in ((NAMES[0], {}), (NAMES[1], {"payment_intent": None, "ride_ok": False})):
            self.provider._request.reset_mock()
            self.assertEqual(self.call(name, args), {"action": "modify", "args": LINEAGE})
            self.provider._request.assert_called_once_with("/internal/hermes/phone-task-context", {"context": {
                "run_id": "trusted-run", "session_id": "session-host", "tool_call_id": ""}})
        self.provider._request.reset_mock()
        self.assertIsNone(self.call("foreign_tool", {"pay_limit_yuan": 30, "payment_intent": "pi-order", "ride_ok": True}))
        self.provider._request.assert_not_called()

    def test_cloud_phone_lifecycle_steps_carry_request_lineage(self):
        for name in ("phone_start", "mcp__phone__phone_restore_apps", "phone_save_apps", "mcp__phone__phone_close"):
            self.provider._request.reset_mock()
            self.assertEqual(self.call(name, {"principal_id": "model-said"}), {"action": "modify", "args": LINEAGE})
            self.provider._request.assert_called_once_with("/internal/hermes/phone-task-context", {"context": {
                "run_id": "trusted-run", "session_id": "session-host", "tool_call_id": ""}})

    def test_capacity_409_codes_remain_distinct_in_model_tool_results(self):
        provider = plugin.PersonalAIOSProvider.__new__(plugin.PersonalAIOSProvider)
        for code in ("PAYMENT_CHECKPOINT_ACTIVE", "APPROVAL_BUSY"):
            with self.subTest(code=code):
                error = HTTPError("http://127.0.0.1/fixture", 409, "capacity", {},
                                  io.BytesIO(json.dumps({"error_code": code}).encode()))
                provider._request = mock.Mock(side_effect=error)
                result = json.loads(provider.handle_tool_call("paios_payment", {"action": "request"}, run_id="trusted-run"))
                self.assertEqual(result, {"status": "rejected", "error_code": code, "http_status": 409, "success": False, "error": code})
                provider._request.assert_called_once()


if __name__ == "__main__":
    unittest.main()
