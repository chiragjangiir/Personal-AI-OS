"""synthetic XML/OCR observations → executor → actual INT HTTP authority.

The 27 recorded case dictionaries are unchanged. XML adds real ancestor containers,
not asserted context. Screenshots/OCR and Android focus are injected; no device is used.
No recorded real 千问/淘宝 cashier/result XML or JSON was found in the source tree.
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
from payment_checkpoint import CheckpointConfig, PaymentBinding, PaymentCheckpoint, PaymentHTTPClient
import test_payment_recovery as recovery

FIXTURES = Path(__file__).parent / 'tests/fixtures/payment_sections'
CASES = json.loads((FIXTURES / 'heading-cases.json').read_text())
BASE = ('订单号：order-A', '总计 ¥16.60', '收款方：shop-A',
        '商品名称：柠檬茶', '规格：中杯', '数量：1')


def node(parent, text='', bounds=(0, 0, 1000, 1400), *, identity='', container=False, clickable=False):
    x0, y0, x1, y1 = bounds
    return ET.SubElement(parent, 'node', {
        'text': text, 'content-desc': '', 'bounds': f'[{x0},{y0}][{x1},{y1}]',
        'class': 'android.view.ViewGroup' if container else 'android.widget.TextView',
        'resource-id': 'com.aliyun.tongyi:id/' + identity if identity else '',
        'package': 'com.aliyun.tongyi', 'enabled': 'true', 'visible-to-user': 'true',
        'clickable': 'true' if clickable else 'false'})


def observation(spec=None, *, initial=False, receipt=False):
    """Original review leaf bounds plus actual native container/section geometry."""
    spec = spec or {}
    hierarchy = ET.Element('hierarchy', rotation='0', width='1000', height='1600')
    root = node(hierarchy, container=True, identity='screen')
    parent = node(root, container=True, identity='current_order') if spec.get('nested') else root
    texts = ['订单详情' if initial else '支付结果', *BASE]
    if spec.get('merchant'):
        index = {'shop': 3, 'item': 4}.get(spec['merchant'])
        if index is not None:
            texts[index] = ('收款方：' if index == 3 else '商品名称：') + spec['injection']
    leaves = [(t, 0, i * 90, 200, i * 90 + 40) for i, t in enumerate(texts)]
    if spec.get('merchant') == 'remark':
        leaves.append(('备注：' + spec['injection'], 0, 650, 440, 690))
    if spec.get('header'):
        leaves.append((spec['header'], 0, 720, 200, 760))
    statuses = '支付状态：已支付' if receipt else spec.get('status')
    for i, text in enumerate(statuses if isinstance(statuses, list) else [statuses] if statuses else []):
        leaves.append((text, 0, 810 + i * 60, 200, 850 + i * 60))
    leaves.extend((t, 220, 720 + i * 60, 440, 760 + i * 60)
                  for i, t in enumerate(spec.get('extra', [])))
    if not receipt and (initial or spec.get('kind') != 'receipt'):
        leaves.append(('立即购买' if initial else '确认付款', 0, 1100, 200, 1150))
    foreign = None
    for text, *bounds in leaves:
        if spec.get('nested') and text == spec.get('header'):
            foreign = node(parent, container=True, identity='foreign_section', bounds=(0, 700, 900, 1060))
        target = foreign if foreign is not None and 700 <= bounds[1] < 1060 else parent
        if spec.get('split_rows') and '：' in text and text.startswith(('收款方', '商品名称', '规格', '数量')):
            label, value = text.split('：', 1)
            x0, y0, x1, y1 = bounds
            row = node(target, container=True, identity='field_row', bounds=(x0, y0, 440, y1))
            node(row, label, (x0, y0, 90, y1))
            node(row, value, (110, y0, 440, y1))
        else:
            merchant_status = bool(spec.get('unlabelled_merchant') and text == spec.get('status'))
            if merchant_status and spec.get('merchant_ancestor'):
                target = node(target, container=True, identity='merchant_remark', bounds=tuple(bounds))
            identity = 'merchant_remark' if text.startswith('备注：') or merchant_status and not spec.get('merchant_ancestor') else ''
            node(target, text, bounds, identity=identity,
                 clickable=bool(spec.get('clickable_header') and text == spec.get('header')))
    if spec.get('duplicate'):
        duplicate = node(root, container=True, identity='second_order', bounds=(500, 0, 1000, 1400))
        for text, x0, y0, x1, y1 in leaves:
            node(duplicate, text, (x0 + 500, y0, x1 + 500, y1))
    if spec.get('merchant_binding'):
        row = node(parent, container=True, identity='merchant_remark', bounds=(500, 0, 1000, 1300))
        node(row, '备注', (500, 0, 590, 40))
        for i, text in enumerate(('订单详情', *BASE, '支付状态：已支付')):
            node(row, text, (610, 50 + i * 90, 950, 90 + i * 90))
    shown = [(n.get('text'), *map(int, server.re.findall(r'-?\d+', n.get('bounds'))))
             for n in hierarchy.iter('node') if n.get('text')] if spec.get('split_rows') or spec.get('merchant_binding') else list(leaves)
    if spec.get('ocr_header'):
        shown.append((spec['ocr_header'], 0, 720, 200, 760))
    if spec.get('ocr_status'):
        shown.append((spec['ocr_status'], 0, 880, 200, 920))
    if spec.get('unmapped_ocr'):
        shown.append(('支付状态：已支付', 700, 1450, 950, 1490))
    if spec.get('ocr_only'):
        hierarchy = ET.Element('hierarchy', rotation='0', width='1000', height='1600')
    if spec.get('root_node'):
        root.set('width', '1000')
        root.set('height', '1600')
        hierarchy = root
    if spec.get('unidentified'):
        shown = [(text, *bounds) for text, *bounds in shown if not text.startswith('订单号：')]
    return ET.tostring(hierarchy), shown


class PaymentSections(unittest.IsolatedAsyncioTestCase):
    # Actual SQLite, signatures, grants, HTTP handler; no scripted authority.
    async def asyncSetUp(self):
        with mock.patch.object(recovery, 'ROOT', recovery.ROOT / '.scratch/r13/harness'):
            await recovery.Recovery.asyncSetUp(self)
    stop = recovery.Recovery.stop
    authority = recovery.Recovery.authority

    async def parsed(self, spec=None, *, initial=False, receipt=False):
        xml, shown = observation(spec, initial=initial, receipt=receipt)
        phone = SimpleNamespace(screenshot=mock.AsyncMock(return_value=frame()))
        guard = server.CheckoutStop(phone)
        with mock.patch.object(server, '_observation', return_value=xml), \
             mock.patch.object(server, '_screen_nodes', return_value=shown), \
             mock.patch.object(server, '_shell', return_value='mCurrentFocus com.aliyun.tongyi/.Main'), \
             mock.patch.object(server, '_at_checkout', return_value=not initial):
            screen = await server._payment_screen(guard)
        self.assertEqual(guard.shown, shown)
        self.assertTrue(hasattr(guard, 'native_nodes'), 'Real _seen must retain native containers')
        return screen

    async def scenario(self, case):
        # Parse every scripted surface before starting the short receipt deadline.
        # Thread scheduling in the real parser must not consume simulated UI wait time.
        specs = {'initial': case.get('initial_spec', {k: case[k] for k in
                 ('merchant', 'injection', 'ocr_only', 'split_rows', 'root_node') if k in case}),
                 'after': {'status': '支付状态：未支付'} if case['kind'] == 'ack' else case,
                 'paid': case, 'ack': case}
        screens = {phase: await self.parsed(spec, initial=phase == 'initial', receipt=phase == 'paid')
                   for phase, spec in specs.items()}
        requested = await self.authority('section-request')
        intent = requested['intent_id']
        inputs, debits, writes, observations = [], [], [], []
        phase = 'initial'
        config = replace(CheckpointConfig(), result_wait_s=.08, result_poll_s=.005, poll_wait_ms=10)

        class Client(PaymentHTTPClient):
            async def request(self, method, path, body=None, timeout_s=None):
                nonlocal phase
                result = await super().request(method, path, body, timeout_s)
                if path.endswith('/tap'):
                    writes.append(body)
                    if body['step'] == 2 and case['kind'] == 'ack':
                        phase = 'ack'
                return result

        async def read():
            screen = replace(screens[phase], read_at=server._now())
            observations.append(screen)
            return screen

        async def tap(*point):
            nonlocal phase
            inputs.append(point)
            if not case.get('no_effect') and (not case.get('safe_positive') or case['kind'] == 'receipt' or len(inputs) > 1):
                debits.append(1660)
            phase = 'after' if len(inputs) == 1 else 'paid'

        cancel = mock.AsyncMock(return_value={'outcome': 'done'})
        task = asyncio.create_task(PaymentCheckpoint(Client(self.url, 'fixture-key', config),
            read, tap, cancel, config).run(intent, 'job-sections', '千问'))
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
        binding = PaymentBinding(observations[0].order_id, observations[0].payee,
            observations[0].amount_fen, observations[0].order_namespace,
            observations[0].item_identity, observations[0].item_facts)
        self.assertEqual(observations[-1].reconciliation(binding)['state'],
                         'paid' if case.get('safe_positive') else 'unknown')
        state = await self.authority('state')
        cards = [p for p in state['cards'] if p['intent_id'] == intent]
        if case.get('safe_positive'):
            self.assertTrue(result['success'], result)
            self.assertEqual(len(inputs), 1 if case['kind'] == 'receipt' else 2)
            self.assertEqual(debits, [1660])
            self.assertEqual(cards[-1]['state'], 'paid')
        else:
            self.assertFalse(result['success'], result)
            self.assertTrue(result['answer'].startswith('【付款结果不明】'), result)
            self.assertEqual(len(inputs), 0 if case.get('initial_spec') or case.get('ocr_only') else 1)
            self.assertEqual(debits, [] if case.get('no_effect') or not inputs else [1660])
            if inputs:
                self.assertEqual(cards[-1]['state'], 'outcome_unknown')
            self.assertFalse(any(p['state'] == 'paid' for p in cards))
        self.assertEqual(len([w for w in writes if w['step'] == 1]), len(inputs) > 0)
        self.assertLessEqual(len(writes), 2 if case['kind'] == 'ack' else len(inputs))
        cancel.assert_not_awaited()
        return observations

    async def test_future_grounded_ocr_only_complete_binding_candidate_is_unknown(self):
        await self.scenario(dict(name='ocr_only', kind='continuation', ocr_only=True,
                                 status='支付状态：未支付', no_effect=True))

    async def test_native_root_node_empty_container_positive(self):
        await self.scenario(dict(kind='continuation', root_node=True,
                                 status='支付状态：未支付', safe_positive=True))

    async def test_native_split_rows_positive(self):
        await self.scenario(dict(kind='continuation', split_rows=True,
                                 status='支付状态：未支付', safe_positive=True))

    async def test_merchant_row_cannot_supply_entire_binding_or_paid_status(self):
        await self.scenario(dict(kind='receipt', merchant_binding=True, no_effect=True))

    async def test_unidentified_initial_status_has_zero_inputs(self):
        await self.scenario(dict(kind='receipt', no_effect=True,
                                 initial_spec={'header': '其他订单', 'status': '支付状态：未支付'}))

    async def test_duplicate_complete_regions_are_unknown(self):
        await self.scenario(dict(kind='receipt', nested=True, duplicate=True,
                                 status='支付状态：已支付', no_effect=True))

    async def test_unmapped_ocr_status_is_unknown(self):
        await self.scenario(dict(kind='receipt', nested=True, unmapped_ocr=True, no_effect=True))

    async def test_ocr_only_unidentified_region_is_unknown(self):
        await self.scenario(dict(kind='receipt', ocr_only=True, unidentified=True,
                                 status='支付状态：已支付', no_effect=True))


def regression(case):
    async def test(self):
        await self.scenario(case)
    return test


for case in CASES:
    setattr(PaymentSections, 'test_review_r6_' + case['name'], regression(case))
for heading in ('其他订单', '历史记录', '示例'):
    for kind in ('continuation', 'receipt', 'ack'):
        case = dict(kind=kind, nested=True, header=heading,
                    status='支付状态：已支付' if kind == 'receipt' else '支付状态：未支付',
                    no_effect=kind == 'receipt')
        setattr(PaymentSections, 'test_nested_' + kind + '_' + heading, regression(case))
for merchant in ('shop', 'item', 'remark'):
    for status in ('支付状态：已支付', '支付状态：未支付'):
        case = dict(kind='receipt', merchant=merchant, injection=status, no_effect=True)
        setattr(PaymentSections, 'test_merchant_' + merchant + '_' + status, regression(case))

for kind, status in (('continuation', '支付状态：未支付'), ('receipt', '支付状态：已支付')):
    case = dict(kind=kind, header='其他订单', clickable_header=True, status=status, no_effect=kind == 'receipt')
    setattr(PaymentSections, 'test_clickable_foreign_heading_' + kind, regression(case))
    for ancestor in (False, True):
        case = dict(kind=kind, status=status, unlabelled_merchant=True,
                    merchant_ancestor=ancestor, no_effect=kind == 'receipt')
        setattr(PaymentSections, 'test_unlabelled_merchant_' + ('ancestor_' if ancestor else 'leaf_') + kind, regression(case))

if __name__ == '__main__':
    unittest.main(verbosity=2)
