"""Recorded boundary attacks through parser, checkpoint and real INT HTTP.

Only screenshot/tree/input seams are synthetic. Reviewer XML/OCR is unchanged.
"""
import asyncio
from dataclasses import replace
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

import server
import test_payment_recovery as recovery
from payment_checkpoint import CheckpointConfig, PaymentCheckpoint, PaymentHTTPClient
from payment_capture_fixture import frame, hierarchy

FIXTURES = Path(__file__).parent / 'tests/fixtures/payment_sections'
CASES = [case for name in ('capture-charge.json', 'capture-viewport.json')
         for case in json.loads((FIXTURES / name).read_text())['cases']]


class CaptureContractHTTP(unittest.IsolatedAsyncioTestCase):
    stop = recovery.Recovery.stop
    authority = recovery.Recovery.authority

    async def asyncSetUp(self):
        with mock.patch.object(recovery, 'ROOT', recovery.ROOT / '.scratch/r13/capture'):
            await recovery.Recovery.asyncSetUp(self)

    async def exercise(self, case):
        intent = (await self.authority('request'))['intent_id']
        phase = 'initial'
        inputs, debits, writes, reads = [], [], [], []
        guard = server.CheckoutStop(SimpleNamespace(), intent)
        config = replace(CheckpointConfig(), result_wait_s=.5, result_poll_s=.01, poll_wait_ms=10)

        class Client(PaymentHTTPClient):
            async def request(inner, method, path, body=None, timeout_s=None):
                nonlocal phase
                value = await super().request(method, path, body, timeout_s)
                if path.endswith('/tap'):
                    writes.append(body)
                    if body['step'] == 2 and case['kind'] == 'ack':
                        phase = 'ack'
                return value

        async def read():
            raw = case['attack' if phase == 'ack' else phase]
            viewport = tuple(case['current_viewport']) if (
                case['kind'] == 'viewport' and phase != 'initial') else (1000, 1600)
            xml = hierarchy(raw['xml'], viewport)
            guard.inner = SimpleNamespace(screenshot=mock.AsyncMock(return_value=frame(viewport)))
            # Reproduce both stale wm cache and the reviewer's refreshed-size control.
            guard.size = tuple(case.get('cached_viewport', (1000, 1600))) if phase != 'initial' else (1000, 1600)
            with mock.patch.object(server, '_observation', return_value=xml), \
                 mock.patch.object(server, '_screen_nodes', return_value=[tuple(n) for n in raw['ocr']]), \
                 mock.patch.object(server, '_shell', return_value='mCurrentFocus com.aliyun.tongyi/.Main'), \
                 mock.patch.object(server, '_at_checkout', return_value=phase != 'initial'):
                screen = await server._payment_screen(guard)
            reads.append((phase, screen))
            return screen

        async def tap(*point):
            nonlocal phase
            inputs.append(point)
            kind = case['kind']
            if kind == 'overlay':
                debits.append(('order-B-overlay' if phase == 'initial' else 'order-A', 1660))
            elif kind == 'positive_direct' or (kind in ('positive_forward', 'ack') and len(inputs) == 2):
                debits.append(('order-A', 1660))
            phase = 'paid' if (kind == 'positive_direct' or len(inputs) == 2) else 'after'

        cancel = mock.AsyncMock(return_value={'outcome': 'done'})
        checkpoint = PaymentCheckpoint(Client(self.url, 'fixture-key', config), read, tap, cancel, config)
        task = asyncio.create_task(checkpoint.run(intent, 'job-capture-contract', '千问'))
        try:
            async with asyncio.timeout(12):
                while not task.done():
                    cards = (await self.authority('state'))['cards']
                    card = next((p for p in cards if p['intent_id'] == intent), None)
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
        trace = dict(name=case['name'], result=result, inputs=inputs, debits=debits,
                     writes=writes, cards=cards, phases=[p for p, _ in reads])
        self.assertEqual(cancel.await_count, 0, trace)
        if case['kind'].startswith('positive'):
            self.assertTrue(result['success'], trace)
            self.assertEqual(result['payment_outcome'], 'paid', trace)
            self.assertEqual(debits, [('order-A', 1660)], trace)
            self.assertEqual(len(inputs), 1 if case['kind'] == 'positive_direct' else 2, trace)
            self.assertEqual(cards[-1]['state'], 'paid', trace)
            return
        self.assertFalse(result['success'], trace)
        self.assertEqual(result['payment_outcome'], 'unknown', trace)
        self.assertEqual(debits, [], trace)
        self.assertFalse(any(p['state'] == 'paid' for p in cards), trace)
        self.assertEqual(reads[-1][1].reconciliation(checkpoint.binding)['state'], 'unknown', trace)
        if case['kind'] in ('initial', 'overlay'):
            self.assertEqual(inputs, [], trace)
            self.assertEqual(writes, [], trace)
            self.assertEqual(cards, [], trace)
        else:
            self.assertEqual(len(inputs), 1, trace)
            self.assertEqual(cards[-1]['state'], 'outcome_unknown', trace)
            self.assertEqual([w['step'] for w in writes], [1, 2] if case['kind'] == 'ack' else [1], trace)
            if case['kind'] == 'ack':
                self.assertEqual(reads[-1][0], 'ack', trace)


def regression(case):
    async def test(self):
        await self.exercise(case)
    return test


for case in CASES:
    setattr(CaptureContractHTTP, 'test_' + case['name'], regression(case))

if __name__ == '__main__':
    unittest.main(verbosity=2)
