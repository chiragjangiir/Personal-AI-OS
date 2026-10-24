"""Review-r8: exact 41 heading-occurrence cases through parser/checkpoint/HTTP INT.

Only native XML, OCR and the input sink are synthetic. No review scratch is imported.
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

CASES = json.loads((sections.FIXTURES / 'heading-occurrences.json').read_text())


def observation(case,initial=False,receipt=False):
    if not case.get('mode'):
        return sections.observation(case,initial=initial,receipt=receipt)
    xml,_=sections.observation({},initial=initial,receipt=receipt)
    hierarchy=ET.fromstring(xml);root=hierarchy[0]
    mode=case['mode'];title='订单详情' if initial else '支付结果'
    status=case.get('status','支付状态：未支付')
    ocr=[]
    if mode in ('headless_nested','headless_foreign','deep_headless','deep_headed'):
        target=root
        for i in range(case.get('depth',1)):
            target=sections.node(target,container=True,identity=f'wrapper_{i}',bounds=(0,700,900,1060))
            if mode=='deep_headed':sections.node(target,title,(0,720,200,760))
        if mode=='headless_foreign':sections.node(target,'订单号：order-B',(0,730,200,770))
        sections.node(target,status,(0,810,200,850),identity='payment_status')
    elif mode in ('siblings','split_binding'):
        # Identical title strings, different native containers and screen columns.
        a=sections.node(root,container=True,identity='current_order',bounds=(0,0,480,1400))
        for leaf in list(root)[:-1]:root.remove(leaf);a.append(leaf)
        b=sections.node(root,container=True,identity='second_order',bounds=(500,0,1000,1060))
        sections.node(b,title,(500,0,700,40))
        if mode=='split_binding':
            for leaf in list(a):
                if leaf.get('text','').startswith(('收款方','商品名称')):
                    a.remove(leaf);b.append(leaf)
                    bounds=list(map(int,server.re.findall(r'-?\d+',leaf.get('bounds'))))
                    leaf.set('bounds',f'[{bounds[0]+500},{bounds[1]}][{bounds[2]+500},{bounds[3]}]')
        sections.node(b,status,(500,810,700,850),identity='payment_status')
    elif mode=='unicode_heading':
        card=sections.node(root,container=True,identity='related_order_card',bounds=(0,700,900,1060))
        sections.node(card,case['heading'],(0,720,250,760))
        sections.node(card,status,(0,810,200,850),identity='payment_status')
    elif mode in ('ocr_nested_broad_title','ocr_native_boundary_conflict','native_broad_title_current','broad_root_ocr'):
        # Native grouping text covers the whole outer card. OCR sees another
        # occurrence of the same heading inside an otherwise empty child card.
        if mode!='ocr_native_boundary_conflict':
            root.set('text',title)
            root.remove(root[0])
        if mode in ('ocr_nested_broad_title','ocr_native_boundary_conflict'):
            card=sections.node(root,container=True,identity='related_order_card',bounds=(0,700,900,1060))
            sections.node(card,'',(0,700,900,1060))  # Native container exists, but image text has no native leaves.
            ocr += [(title,0,720,200,760),(status,0,810,200,850)]
        elif mode=='native_broad_title_current':sections.node(root,status,(0,810,200,850),identity='payment_status')
        else:ocr += [(status,0,810,200,850)]
    elif mode=='tree_ocr_different_sections':
        card=sections.node(root,container=True,identity='related_order_card',bounds=(0,700,900,1060))
        sections.node(card,title,(0,720,200,760))
        sections.node(card,status,(0,810,200,850),identity='payment_status')
        ocr += [(status,0,610,200,650)]
    elif mode in ('merchant_boundary','merchant_container_markup'):
        card=sections.node(root,'备注：'+case.get('injection','支付结果'),container=True,
            identity='merchant_remark',bounds=(0,700,900,1060))
        sections.node(card,title,(0,720,200,760))
        sections.node(card,'支付状态：已支付',(0,810,200,850),identity='payment_status')
        if case.get('positive'):sections.node(root,status,(0,610,200,650),identity='payment_status')
    elif mode=='reorder_single_instance':
        sections.node(root,status,(0,810,200,850),identity='payment_status')
    if case.get('reverse'):
        for parent in list(hierarchy.iter('node')): parent[:]=list(reversed(list(parent)))
    shown=[(n.get('text'),*map(int,server.re.findall(r'-?\d+',n.get('bounds'))))
        for n in hierarchy.iter('node') if n.get('text')]
    if mode in ('ocr_nested_broad_title','native_broad_title_current','broad_root_ocr'):
        # OCR reports the actual outer heading glyph, not the broad native content-desc box.
        shown=[n for n in shown if not(n[0]==title and n[1:]==(0,0,1000,1400))]
        shown.insert(0,(title,0,0,200,40))
    shown += ocr
    return ET.tostring(hierarchy),shown


class HeadingOccurrences(unittest.IsolatedAsyncioTestCase):
    stop = recovery.Recovery.stop
    authority = recovery.Recovery.authority

    async def asyncSetUp(self):
        # Keep all temporary authority state beneath this round's scratch.
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

    async def exercise(self, case):
        # Keep exact r8 inputs. Image-only status awaits a frozen grounded region.
        future_grounded_candidate = case.get('mode') == 'broad_root_ocr'
        supported_positive = not future_grounded_candidate and bool(case.get('positive'))
        supported_one_tap = not future_grounded_candidate and bool(case.get('one_tap_positive'))
        intent = (await self.authority('request'))['intent_id']
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
            spec = {} if phase in ('initial','paid') else (
                {'status':'支付状态：未支付'} if phase == 'after' and case.get('at_ack') else case)
            screen = await self.parsed(spec, initial=phase == 'initial', receipt=phase == 'paid')
            observations.append(screen)
            return screen

        async def tap(*point):
            nonlocal phase
            inputs.append(point)
            if not case.get('no_effect') and (not case.get('positive') or len(inputs) > 1):
                debits.append(1660)
            phase = 'after' if len(inputs) == 1 else 'paid'

        cancel = mock.AsyncMock(return_value={'outcome':'done'})
        checkpoint = PaymentCheckpoint(Client(self.url,'fixture-key',config), read, tap, cancel, config)
        task = asyncio.create_task(checkpoint.run(intent,'job-heading-occurrences','千问'))
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
        if supported_positive or supported_one_tap:
            self.assertTrue(result['success'], trace)
            self.assertEqual(len(inputs), 1 if case.get('one_tap_positive') else 2, trace)
            self.assertEqual(debits, [1660], trace)
            self.assertEqual(cards[-1]['state'], 'paid')
            self.assertEqual(observations[-1].reconciliation(checkpoint.binding)['state'], 'paid')
        else:
            self.assertFalse(result['success'], trace)
            self.assertTrue(result['answer'].startswith('【付款结果不明】'), trace)
            self.assertEqual(len(inputs), 1, trace)
            self.assertEqual(debits, [] if case.get('no_effect') or case.get('positive') else [1660], trace)
            self.assertFalse(any(p['state'] == 'paid' for p in cards), trace)
            self.assertEqual(cards[-1]['state'], 'outcome_unknown', trace)
            self.assertEqual(observations[-1].reconciliation(checkpoint.binding)['state'], 'unknown', trace)
        expected_steps = [1, 2] if supported_positive or case.get('at_ack') else [1]
        self.assertEqual([write['step'] for write in writes], expected_steps, trace)
        cancel.assert_not_awaited()


def regression(case):
    async def test(self):
        await self.exercise(case)
    return test


for case in CASES:
    setattr(HeadingOccurrences, 'test_' + case['name'], regression(case))

if __name__ == '__main__':
    unittest.main(verbosity=2)
