"""Native hook consent transport; no real account, device, server or approval."""
import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[2] / 'hermes/personal_aios/effects.py'
SPEC = importlib.util.spec_from_file_location('effect_consent_test', SOURCE)
effects = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(effects)


class EffectConsent(unittest.TestCase):
    def setUp(self):
        self.wait = Mock(return_value={'resolved': True, 'choice': 'once'})
        self.modules = patch.dict(sys.modules, {
            'gateway.session_context': SimpleNamespace(get_api_run_id=lambda _: 'bound-run'),
            'tools.approval_context': SimpleNamespace(get_current_session_key=lambda: 'bound-run',
                _approval_tool_call_id=SimpleNamespace(get=lambda: 'bound-call')),
            'tools.approval': SimpleNamespace(_gateway_notify_cb=lambda _: lambda _: None),
            'tools.approval_gateway_wait': SimpleNamespace(_await_gateway_decision=self.wait)})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.provider = SimpleNamespace(_request=Mock())
        self.effect = {'kind': 'send', 'recipient': 'contact:li', 'task_type': 'wechat_message', 'requested': True}

    def invoke(self, args):
        return effects.check_effect(self.provider, 'phone_task', args, 'session', '')

    def test_missing_classification_cannot_start_phone_task(self):
        self.assertEqual(self.invoke({})['action'], 'block')
        self.provider._request.assert_not_called()

    def test_once_is_bound_to_source_scope_and_persisted_only_after_owner_answer(self):
        scope = {'principal_id': 'owner', **self.effect}
        confirmation = {'confirmation_id': 'c' * 64, 'confirmed_by': 'owner',
                        'confirmed_at': '2026-10-22T12:00:00Z',
                        'surface': {'device_id': 'owner-phone', 'device_type': 'phone'}}
        self.wait.return_value = {'resolved': True, 'choice': 'once', 'confirmation': confirmation}
        approval = {**confirmation, 'choice': 'once', 'reused': False}
        self.provider._request.side_effect = [{'status': 'confirmation_required', 'scope': scope}, {'status': 'allowed', 'approval': approval}]
        self.assertEqual(self.invoke({'effect': self.effect}), approval)
        prompt = self.wait.call_args.args[2]
        self.assertEqual(self.provider._request.call_args.args[1]['approval_request_id'], prompt['request_id'])
        self.assertIn('contact:li', prompt['description'])
        self.assertFalse(prompt['allow_session'])
        self.assertFalse(prompt['allow_permanent'])
        self.assertTrue(self.provider._request.call_args.args[1]['approved'])
        self.assertEqual(self.provider._request.call_args.args[1]['confirmation'], confirmation)
        self.assertIs(self.provider._request.call_args.args[1]['confirmation'], self.wait.return_value['confirmation'])
        self.assertEqual(self.provider._request.call_args.args[1]['context']['run_id'], 'bound-run')

    def test_only_exact_ride_flag_reaches_bound_authority(self):
        self.provider._request.return_value = {'status': 'allowed'}
        for flag in (True, False, 'true'):
            self.assertIsNone(self.invoke({'effect': {'kind': 'external', 'task_type': 'ride_request', 'requested': True}, 'ride_ok': flag}))
            self.assertIs(self.provider._request.call_args.args[1]['ride_ok'], flag is True)

    def test_denial_and_timeout_never_record_confirmation(self):
        for answer in ({'resolved': True, 'choice': 'deny'}, {'resolved': False, 'choice': None}):
            self.provider._request.reset_mock()
            self.provider._request.return_value = {'status': 'confirmation_required', 'scope': self.effect}
            self.wait.return_value = answer
            self.assertEqual(self.invoke({'effect': self.effect})['action'], 'block')
            self.assertEqual(self.provider._request.call_count, 1)


if __name__ == '__main__':
    unittest.main()
