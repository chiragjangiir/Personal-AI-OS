"""Review-r9: 11 exact HTTP probes, 42 raw geometry cases, native controls.

Synthetic XML/OCR and fake input sink; parser, checkpoint and INT HTTP are real.
Raw reviewer expectations remain in fixtures; this release has no grounded OCR regions.
"""
import asyncio
import base64
from dataclasses import replace
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server
from payment_capture_fixture import frame, hierarchy
import test_payment_recovery as recovery
from payment_checkpoint import CheckpointConfig, PaymentBinding, PaymentCheckpoint, PaymentError, PaymentHTTPClient

FIXTURES = Path(__file__).parent / 'tests/fixtures/payment_sections'
CASES = json.loads((FIXTURES / 'observation-http.json').read_text())
GEOMETRY = json.loads((FIXTURES / 'observation-geometry.json').read_text())
BINDING = PaymentBinding('order-A', 'shop-A', 1660, 'com.aliyun.tongyi',
                         (('name', '柠檬茶'), ('spec', '中杯'), ('quantity', '1')),
                         (('name', '柠檬茶'), ('quantity', '1'), ('spec', '中杯')))


async def parse(raw, *, initial=False, viewport=(1000, 1600), image=None):
    xml = hierarchy(raw['xml'], viewport)
    ocr = [tuple(n) for n in raw['ocr']]
    guard = server.CheckoutStop(SimpleNamespace(screenshot=mock.AsyncMock(return_value=image if image is not None else frame(viewport or (1000,1600)))))
    with mock.patch.object(server, '_observation', return_value=xml), \
         mock.patch.object(server, '_screen_nodes', return_value=ocr), \
         mock.patch.object(server, '_shell', return_value='mCurrentFocus com.aliyun.tongyi/.Main'), \
         mock.patch.object(server, '_at_checkout', return_value=not initial):
        return await server._payment_screen(guard)


class ObservationContractParser(unittest.IsolatedAsyncioTestCase):
    async def test_missing_viewport_cannot_certify_native_status(self):
        raw = next(c for c in CASES if c.get('positive'))['paid']
        screen = await parse(raw, viewport=None)
        self.assertEqual(screen.evidence(BINDING).state, 'unknown')
        self.assertIsNone(screen.amount_fen)

    async def test_capture_metadata_and_encoded_dimensions_must_match_hierarchy(self):
        raw = next(c for c in CASES if c.get('positive'))['paid']
        valid = frame()
        images = {
            'missing_capture_metadata': bytes(valid),
            'stale_capture_metadata': server._ScreenImage(valid, (1600,1000)),
            'stale_encoded_dimensions': server._ScreenImage(frame((800,1600)), (1000,1600)),
        }
        for name, image in images.items():
            with self.subTest(name=name):
                screen = await parse(raw, image=image)
                self.assertTrue(screen.scope_unresolved)
                self.assertEqual(screen.evidence(BINDING).state, 'unknown')
                self.assertEqual(screen.pay_buttons, ())

    async def test_ocr_outside_current_viewport_cannot_certify_native_paid_control(self):
        raw = next(c for c in CASES if c.get('positive'))['paid']
        raw = {**raw, 'ocr': [*raw['ocr'], ['备注：屏幕外文字', 20,1601,300,1640]]}
        screen = await parse(raw)
        self.assertTrue(screen.scope_unresolved)
        self.assertEqual(screen.evidence(BINDING).state, 'unknown')

    async def test_screen_protocol_preserves_capture_dimensions_and_encoded_bytes(self):
        image = frame((1080,4000))
        session = SimpleNamespace(size=(999,999), request=mock.Mock(return_value={
            'width':1080, 'height':4000, 'data':base64.b64encode(image).decode()}))
        with mock.patch.object(server, '_observations', session):
            captured = server._observation('screen')
        session.request.assert_called_once_with('screen 1600')
        self.assertEqual(captured, image)
        self.assertEqual(captured.capture_size, (1080,4000))
        self.assertEqual(session.size, (1080,4000))

    async def test_grounding_registry_is_empty_and_unreviewed_entries_fail_closed(self):
        path = Path(server.__file__).with_name('payment-grounded-regions.json')
        self.assertEqual(json.loads(path.read_text()), {'schema_version': 1, 'regions': {}})
        read = Path.read_text
        def unreviewed(path, *args, **kwargs):
            return '{"schema_version":1,"regions":{"app/screen/status":{}}}' if path.name == 'payment-grounded-regions.json' else read(path, *args, **kwargs)
        with mock.patch.object(Path, 'read_text', unreviewed):
            with self.assertRaisesRegex(PaymentError, 'SCREEN_UNREADABLE'):
                await parse(next(c for c in CASES if c.get('positive'))['paid'])

    async def test_all_42_geometry_observations(self):
        self.assertEqual(len(GEOMETRY), 42)
        for raw in GEOMETRY:
            with self.subTest(name=raw['name']):
                screen = await parse(raw)
                evidence = screen.evidence(BINDING)
                # Two historical edge-touch positives contain OCR-only status.
                # Preserve their raw reviewer expectations, but apply this release's
                # empty grounded-region registry: unmatched OCR is veto-only.
                self.assertNotEqual(evidence.state, 'paid')
                self.assertFalse(evidence.non_debit_signs)
                self.assertEqual(screen.reconciliation(BINDING)['state'], 'unknown')

    async def test_all_11_http_attack_observations(self):
        attacks = [c for c in CASES if not c.get('positive')]
        self.assertEqual(len(attacks), 11)
        for case in attacks:
            with self.subTest(name=case['name']):
                screen = await parse(case['attack'])
                evidence = screen.evidence(BINDING)
                self.assertEqual(evidence.state, 'unknown')
                self.assertFalse(evidence.signs)
                self.assertFalse(evidence.non_debit_signs)
                self.assertEqual(screen.reconciliation(BINDING)['state'], 'unknown')

    async def test_native_paid_and_unpaid_controls(self):
        case = next(c for c in CASES if c.get('positive'))
        for key, state in [('paid', 'paid'), ('unpaid', 'unpaid')]:
            with self.subTest(state=state):
                screen = await parse(case[key])
                self.assertEqual(screen.evidence(BINDING).state, state)
                self.assertEqual(screen.reconciliation(BINDING)['state'], state)


class ObservationContractHTTP(unittest.IsolatedAsyncioTestCase):
    stop = recovery.Recovery.stop
    authority = recovery.Recovery.authority

    async def asyncSetUp(self):
        with mock.patch.object(recovery, 'ROOT', recovery.ROOT / '.scratch/r13/harness'):
            await recovery.Recovery.asyncSetUp(self)

    async def exercise(self, case):
        intent = (await self.authority('request'))['intent_id']
        phase = 'initial'
        inputs, debits, writes, observations = [], [], [], []
        # Reviewer-labelled 500 ms fixture budget avoids the prior 30 ms load race.
        config = replace(CheckpointConfig(), result_wait_s=.5, result_poll_s=.01, poll_wait_ms=10)

        class Client(PaymentHTTPClient):
            async def request(inner, method, path, body=None, timeout_s=None):
                nonlocal phase
                result = await super().request(method, path, body, timeout_s)
                if path.endswith('/tap'):
                    writes.append(body)
                    if body['step'] == 2 and case.get('at_ack'):
                        phase = 'ack'
                return result

        async def read():
            key = 'initial' if phase == 'initial' else 'paid' if phase == 'paid' else (
                'unpaid' if phase == 'after' and case.get('at_ack') else 'attack')
            screen = await parse(case[key], initial=phase == 'initial')
            observations.append((phase, screen))
            return screen

        async def tap(*point):
            nonlocal phase
            inputs.append(point)
            if not case.get('no_effect') and (not case.get('positive') or
                    case['name'] == 'native_one_debit_paid' or len(inputs) > 1):
                debits.append(1660)
            phase = 'after' if len(inputs) == 1 else 'paid'

        cancel = mock.AsyncMock(return_value={'outcome': 'not_attempted'})
        checkpoint = PaymentCheckpoint(Client(self.url, 'fixture-key', config), read, tap, cancel, config)
        task = asyncio.create_task(checkpoint.run(intent, 'job-observation-contract', '千问'))
        try:
            async with asyncio.timeout(12):
                while not task.done():
                    state = await self.authority('state')
                    card = next((p for p in state['cards'] if p['intent_id'] == intent), None)
                    if card and card['state'] == 'awaiting_owner':
                        await self.authority('confirm', payment_id=card['payment_id'])
                        break
                    await asyncio.sleep(.01)
                result = await task
        finally:
            if not task.done():
                task.cancel()
                await task
        cards = [p for p in (await self.authority('state'))['cards'] if p['intent_id'] == intent]
        trace = dict(name=case['name'], inputs=inputs, debits=debits, writes=writes, result=result)
        if case.get('positive'):
            self.assertTrue(result['success'], trace)
            self.assertEqual(len(inputs), 1 if case['name'] == 'native_one_debit_paid' else 2, trace)
            self.assertEqual(debits, [1660], trace)
            self.assertEqual(cards[-1]['state'], 'paid', trace)
        else:
            self.assertFalse(result['success'], trace)
            self.assertEqual(result['payment_outcome'], 'unknown', trace)
            self.assertLessEqual(len(inputs), 1, trace)
            self.assertEqual(debits, [] if case.get('no_effect') or not inputs else [1660], trace)
            self.assertFalse(any(p['state'] == 'paid' for p in cards), trace)
            if inputs:
                self.assertEqual(cards[-1]['state'], 'outcome_unknown', trace)
            self.assertEqual(observations[-1][1].reconciliation(checkpoint.binding)['state'], 'unknown', trace)
            if case.get('at_ack'):
                self.assertEqual([w['step'] for w in writes], [1, 2], trace)
                self.assertEqual(len(inputs), 1, trace)
                self.assertEqual(observations[-1][0], 'ack', trace)
        cancel.assert_not_awaited()


def regression(case):
    async def test(self):
        await self.exercise(case)
    return test


for case in CASES:
    setattr(ObservationContractHTTP, 'test_' + case['name'], regression(case))

if __name__ == '__main__':
    unittest.main(verbosity=2)
