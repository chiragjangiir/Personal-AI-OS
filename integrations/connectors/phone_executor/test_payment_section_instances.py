"""Review-r7: exact 19 structural attacks and 30 merchant controls through real INT.

Synthetic native XML/OCR only; current parser, executor and HTTP authority are real.
Case dictionaries retain the review bodies. No scratch review code is imported.
"""
import asyncio
from dataclasses import replace
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server
from payment_capture_fixture import frame
import test_payment_sections as sections
import test_payment_recovery as recovery
from payment_checkpoint import CheckpointConfig, PaymentCheckpoint, PaymentHTTPClient

CASES = json.loads((sections.FIXTURES / 'section-instances.json').read_text())


def observation(spec, initial=False, receipt=False):
    if not spec.get('attack'):
        return sections.observation(spec, initial=initial, receipt=receipt)
    xml, _ = sections.observation({}, initial=initial, receipt=receipt)
    hierarchy = ET.fromstring(xml)
    root = hierarchy[0]
    mode = spec['attack']
    title = '订单详情' if initial else '支付结果'
    status = spec.get('status', '支付状态：未支付')
    if mode in ('nested_supported_title', 'sibling_supported_title', 'straddled_ocr', 'native_container_title', 'straddled_ocr_padding'):
        if mode == 'sibling_supported_title':
            details = sections.node(root, container=True, identity='current_order_details')
            for leaf in list(root)[:-1]:
                root.remove(leaf)
                details.append(leaf)
        foreign = sections.node(root, container=True, identity='related_order_card', bounds=(0,700,900,1060))
        if mode == 'native_container_title':
            foreign.set('text', title)
        else:
            sections.node(foreign, title, (0,720,200,760))
        if mode not in ('straddled_ocr', 'straddled_ocr_padding'):
            sections.node(foreign, status, (0,810,200,850), identity='payment_status')
    elif mode == 'nested_complete_foreign':
        foreign = sections.node(root, container=True, identity='related_order_card', bounds=(500,0,1000,1060))
        for i, text in enumerate((title, *[t.replace('order-A','order-B') for t in sections.BASE], status)):
            sections.node(foreign, text, (500,i*90,950,i*90+40))
    elif mode == 'duplicate_flat_titles':
        sections.node(root, title, (0,720,200,760))
        sections.node(root, status, (0,810,200,850))
    elif mode == 'merchant_status':
        merchant = sections.node(root, container=True, identity='merchant_remark', bounds=(0,700,900,1060))
        sections.node(merchant, title, (0,720,200,760))
        sections.node(merchant, status, (0,810,200,850))
    elif mode == 'merchant_split':
        merchant = sections.node(root, container=True, identity='field_row', bounds=(0,700,900,1060))
        sections.node(merchant, '备注', (0,720,90,760))
        sections.node(merchant, status, (110,720,800,760))
    elif mode == 'merchant_label_container':
        merchant = sections.node(root, '备注：留言', container=True, identity='plain_wrapper', bounds=(0,700,900,1060))
        sections.node(merchant, status, (0,810,200,850), identity='payment_status')
        if spec.get('real_status') and not initial:
            sections.node(root, spec['real_status'], (0,1190,200,1230), identity='payment_status')
    elif mode == 'ocr_merchant_leaf_expanded':
        sections.node(root, status, (100,800,600,850), identity='merchant_remark')
    elif mode == 'ocr_merchant_prefix_crop':
        sections.node(root, '备注：' + status, (0,800,700,860))
    elif mode == 'foreign_heading':
        foreign = sections.node(root, container=True, identity='related_order_card', bounds=(0,700,900,1060))
        sections.node(foreign, '其他订单', (0,720,200,760))
        sections.node(foreign, status, (0,810,200,850))
    if spec.get('reverse_tree'):
        root[:] = list(reversed(list(root)))
    shown = [(n.get('text'), *map(int, server.re.findall(r'-?\d+', n.get('bounds'))))
             for n in hierarchy.iter('node') if n.get('text')]
    if mode in ('straddled_ocr', 'straddled_ocr_padding'):
        shown.append((status,0,1020,950,1080) if mode == 'straddled_ocr' else (status,0,690,950,710))
    if mode == 'ocr_merchant_leaf_expanded':
        shown.append((status,90,790,610,860))
    elif mode == 'ocr_merchant_prefix_crop':
        shown.append((status,120,810,600,850))
    return ET.tostring(hierarchy), shown


class SectionInstances(unittest.IsolatedAsyncioTestCase):
    stop = recovery.Recovery.stop
    authority = recovery.Recovery.authority

    async def asyncSetUp(self):
        # Reuse the authority while keeping temporary state beneath this round's scratch.
        with mock.patch.object(recovery, 'ROOT', recovery.ROOT / '.scratch/r13/harness'):
            await recovery.Recovery.asyncSetUp(self)

    async def parsed(self, spec=None, *, initial=False, receipt=False):
        xml, shown = observation(spec or {}, initial, receipt)
        guard = server.CheckoutStop(SimpleNamespace(screenshot=mock.AsyncMock(return_value=frame())))
        with mock.patch.object(server, '_observation', return_value=xml), \
             mock.patch.object(server, '_screen_nodes', return_value=shown), \
             mock.patch.object(server, '_shell', return_value='mCurrentFocus com.aliyun.tongyi/.Main'), \
             mock.patch.object(server, '_at_checkout', return_value=not initial):
            return await server._payment_screen(guard)

    async def test_merchant_label_container_positive(self):
        await self.exercise({'attack':'merchant_label_container', 'status':'支付状态：未支付',
                             'real_status':'支付状态：已支付'}, merchant_control=True)

    async def exercise(self, case, *, merchant_control=False):
        # Parse fixed synthetic surfaces outside the 30 ms simulated receipt window.
        screens = {}
        for phase in ('initial', 'after', 'paid', 'ack'):
            if merchant_control:
                spec = {k:v for k,v in case.items() if k != 'status'} if phase == 'initial' else case
            else:
                spec = {} if phase in ('initial','paid') else (
                    {'status':'支付状态：未支付'} if phase == 'after' and case.get('at_ack') else case)
            screens[phase] = await self.parsed(spec, initial=phase == 'initial', receipt=phase == 'paid')
        intent = (await self.authority('section-request'))['intent_id']
        phase = 'initial'
        inputs, debits, writes, observations = [], [], [], []
        config = replace(CheckpointConfig(), result_wait_s=.5, result_poll_s=.003, poll_wait_ms=10)

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
            screen = replace(screens[phase], read_at=server._now())
            observations.append(screen)
            return screen

        async def tap(*point):
            nonlocal phase
            inputs.append(point)
            if merchant_control or not case.get('no_effect') and (not case.get('positive') or len(inputs) > 1):
                debits.append(1660)
            phase = 'after' if len(inputs) == 1 else 'paid'

        cancel = mock.AsyncMock(return_value={'outcome':'done'})
        checkpoint = PaymentCheckpoint(Client(self.url,'fixture-key',config), read, tap, cancel, config)
        task = asyncio.create_task(checkpoint.run(intent,'job-section-instances','千问'))
        try:
            async with asyncio.timeout(8):
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
        trace = {'case':case, 'inputs':inputs, 'debits':debits, 'result':result, 'writes':writes}
        if merchant_control or case.get('positive'):
            self.assertTrue(result['success'], trace)
            self.assertEqual(len(inputs), 1 if merchant_control else 2, trace)
            self.assertEqual(debits, [1660], trace)
            self.assertEqual(cards[-1]['state'], 'paid')
            self.assertEqual(observations[-1].reconciliation(checkpoint.binding)['state'], 'paid')
            if merchant_control:
                self.assertEqual(observations[-1].evidence(checkpoint.binding).signs, ('支付状态：已支付',))
        else:
            self.assertFalse(result['success'], trace)
            self.assertTrue(result['answer'].startswith('【付款结果不明】'), trace)
            self.assertLessEqual(len(inputs), 1, trace)
            self.assertEqual(debits, [] if case.get('no_effect') or not inputs else [1660], trace)
            self.assertFalse(any(p['state'] == 'paid' for p in cards), trace)
            if inputs:
                self.assertEqual(cards[-1]['state'], 'outcome_unknown', trace)
            self.assertEqual(observations[-1].reconciliation(checkpoint.binding)['state'], 'unknown', trace)
            self.assertLessEqual(len(writes), 2 if case.get('at_ack') else len(inputs), trace)
        cancel.assert_not_awaited()



class CancellationSection(unittest.IsolatedAsyncioTestCase):
    parsed = SectionInstances.parsed

    async def test_unplaced_ocr_payee_cannot_certify_a_current_paid_receipt(self):
        xml, shown = observation({'attack':'straddled_ocr', 'status':'收款方：other-shop'})
        tree = ET.fromstring(xml)
        tree[0][-1][0].set('text', '订单详情')
        sections.node(tree[0], '支付状态：已支付', (0,600,200,640), identity='payment_status')
        shown = [(t if y != 720 else '订单详情', x,y,x1,y1) for t,x,y,x1,y1 in shown]
        shown.append(('支付状态：已支付',0,600,200,640))
        xml = ET.tostring(tree)
        guard = server.CheckoutStop(SimpleNamespace(screenshot=mock.AsyncMock(return_value=frame())))
        with mock.patch.object(server, '_observation', return_value=xml), \
             mock.patch.object(server, '_screen_nodes', return_value=shown), \
             mock.patch.object(server, '_shell', return_value='mCurrentFocus com.aliyun.tongyi/.Main'), \
             mock.patch.object(server, '_at_checkout', return_value=True):
            current = await server._payment_screen(guard)
        self.assertEqual(current.payee, 'shop-A')
        self.assertTrue(current.scope_unresolved)
        self.assertEqual(current.evidence().state, 'unknown')
        self.assertEqual(current.evidence().signs, ())

    async def test_duplicate_bound_cards_cannot_certify_cancellation(self):
        before = await self.parsed({}, initial=True)
        after = await self.parsed({'duplicate':True, 'status':'订单已取消'})
        self.assertEqual(before.order_id, 'order-A')
        self.assertIsNone(after.region)
        self.assertTrue(after.scope_unresolved)
        self.assertEqual(after.cancelled_signs, ())

        class Handler:
            def __await__(self):
                async def done():
                    return SimpleNamespace(success=True)
                return done().__await__()

        driver = SimpleNamespace(press_key_code=mock.AsyncMock())
        config = SimpleNamespace(agent=SimpleNamespace())
        with mock.patch.object(server, '_payment_screen', new=mock.AsyncMock(side_effect=[before, after])), \
             mock.patch.object(server, 'MobileAgent', return_value=SimpleNamespace(run=lambda:Handler()), create=True):
            result = await server._cancel_order(config, driver, CheckpointConfig(), 'order-A')
        self.assertEqual(result['outcome'], 'failed')
        driver.press_key_code.assert_awaited_once_with(4)


def regression(case, merchant_control=False):
    async def test(self):
        await self.exercise(case, merchant_control=merchant_control)
    return test


for case in [*CASES['structural'], *CASES['additional_structural']]:
    setattr(SectionInstances, 'test_structural_' + case['name'], regression(case))
for i, case in enumerate(CASES['merchant_controls']):
    setattr(SectionInstances, 'test_merchant_control_' + str(i) + '_' + case['merchant'], regression(case, True))

if __name__ == '__main__':
    unittest.main(verbosity=2)
