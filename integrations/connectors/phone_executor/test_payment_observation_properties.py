"""Seeded structural properties. The oracle owns facts before XML/OCR serialization.

No device, OCR engine, HTTP authority, or asynchronous screenshot orchestration is
exercised here. Actual _tree, _payment_screen, evidence and reconciliation are.
"""
import asyncio
from collections import Counter
from dataclasses import dataclass
import json
from pathlib import Path
import random
import re
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server
from payment_checkpoint import PaymentBinding
from payment_capture_fixture import frame, hierarchy

BASE = ('订单号：order-A', '总计 ¥16.60', '收款方：shop-A',
        '商品名称：柠檬茶', '规格：中杯', '数量：1')
MODES = ('plain', 'broad', 'headless', 'ocr_status', 'mixed_binding',
         'nested', 'flat_repeat', 'ambiguous_broad', 'siblings', 'split_binding',
         'disagreement', 'cross_source', 'partial_binding', 'crossing_status',
         'partial_heading', 'duplicate_binding', 'native_geometry_disagreement',
         'ocr_geometry_disagreement', 'split_row_heading',
         'zero_area_status', 'offviewport_status', 'incoherent_parent_status',
         'zero_area_binding', 'offviewport_binding', 'incoherent_parent_binding',
         'ocr_overlay_paid', 'ocr_overlay_unpaid')
CONTROL_MODES = tuple(f'control_{kind}_{placement}_{phase}'
                      for kind in ('zero', 'offscreen', 'incoherent', 'unbound', 'ocr')
                      for placement in ('only', 'extra') for phase in ('initial', 'result'))
VIEWPORT_MODES = ('override_offscreen', 'rotation_offscreen', 'override_coherent',
                  'rotation_coherent', 'capture_override_mismatch', 'capture_rotation_mismatch')
MODES += CONTROL_MODES + VIEWPORT_MODES
FIXTURE = Path(__file__).parent / 'tests/fixtures/payment_sections/generative-seeds.json'


@dataclass
class Case:
    seed: int
    mode: str
    xml: bytes
    ocr: list
    facts: list
    positive: bool
    charge_grounded: tuple = ()
    viewport: tuple = (1000, 1400)
    cached_size: tuple = (1000, 1400)
    capture_size: tuple = (1000, 1400)

    def oracle(self):
        # Ownership is assigned by the generator's conceptual section model,
        # never from parser containers, section keys, flags, or inferred identity.
        if not all(self.charge_grounded) or self.capture_size != self.viewport:
            return 'unknown'
        complete = [owner for owner in {f[0] for f in self.facts}
                    if all(any(o == owner and t == text and grounded
                               for o, t, grounded in self.facts) for text in BASE)]
        statuses = [(o, t) for o, t, _ in self.facts if t.startswith('支付状态：')]
        if any(not grounded for _, text, grounded in self.facts
               if text.startswith('支付状态：')):
            return 'unknown'
        if len(complete) != 1 or not statuses:
            return 'unknown'
        values = {t for _, t in statuses}
        if any(o != complete[0] for o, _ in statuses) or len(values) != 1:
            return 'unknown'
        return 'paid' if values == {'支付状态：已支付'} else 'unpaid'


def generate(seed):
    rng = random.Random(seed)
    mode = MODES[seed % len(MODES)]
    viewport = ((1000, 800) if mode == 'override_offscreen' else
                (1400, 1000) if mode in ('rotation_offscreen', 'rotation_coherent', 'capture_rotation_mismatch') else
                (1000, 1000) if mode in ('override_coherent', 'capture_override_mismatch') else (1000, 1400))
    cached_size = (1000, 1400)
    capture_size = cached_size if mode.startswith('capture_') else viewport
    h = ET.Element('hierarchy', width=str(viewport[0]), height=str(viewport[1]))
    def node(parent, text='', box=(0, 0, 1000, 1400), role=''):
        x, y, xx, yy = box
        return ET.SubElement(parent, 'node', text=text, bounds=f'[{x},{y}][{xx},{yy}]',
                             attrib={'resource-id': 'app:id/' + role if role else ''})
    root = node(h, box=(0, 0, max(1400 if mode.startswith('control_offscreen_') else 1000, viewport[0]), 1400))
    ocr, facts = [], []
    status = '支付状态：' + rng.choice(('已支付', '未支付'))
    heading = rng.choice(('支付结果', '付款结果', '订单详情'))
    broad = mode in ('broad', 'ambiguous_broad', 'partial_heading')
    if broad:
        root.set('text', heading)
        if mode != 'partial_heading':
            ocr.append((heading, 0, 0, 200, 40))
    else:
        node(root, heading, (0, 0, 200, 40))
        ocr.append((heading, 0, 0, 200, 40))
    def emit(parent, text, y, owner='A', source='both', x=0, box=None):
        box = box or (x, y, x + 220, y + 35)
        if source != 'ocr':
            node(parent, text, box, 'payment_status' if text.startswith('支付状态：') else '')
        if source != 'native':
            ocr.append((text, *box))
        # Grounding is part of the conceptual input model, independent of _tree.
        x0, y0, x1, y1 = box
        px0, py0, px1, py1 = map(int, re.findall(r'-?\d+', parent.get('bounds')))
        grounded = (source != 'ocr' and x1 > x0 and y1 > y0
                    and max(0, x0) < min(viewport[0], x1) and max(0, y0) < min(viewport[1], y1)
                    and px0 <= x0 <= x1 <= px1 and py0 <= y0 <= y1 <= py1)
        facts.append((owner, text, grounded))
    other = None
    if mode in ('siblings', 'split_binding', 'duplicate_binding'):
        other = node(root, box=(500, 0, 1000, 1300))
        node(other, heading, (500, 0, 720, 40))
        ocr.append((heading, 500, 0, 720, 40))
    missing = rng.randrange(len(BASE))
    for index, text in enumerate(BASE):
        if mode == 'partial_binding' and index == missing:
            continue
        split = mode == 'split_binding' and index >= 3
        source = rng.choice(('native', 'ocr', 'both')) if mode == 'mixed_binding' else 'both'
        parent, box = other if split else root, None
        if index == missing:
            if mode == 'zero_area_binding': box = (100, 200, 100, 200)
            if mode == 'offviewport_binding': box = (1100, 200, 1320, 235)
            if mode == 'incoherent_parent_binding':
                parent = node(root, box=(500, 0, 900, 600))
        emit(parent, text, 80 + index * 70,
             'B' if split else 'A', source, 500 if split else 0, box)
        if mode == 'duplicate_binding':
            emit(other, text, 80 + index * 70, 'B', x=500)
    target, owner, source, x = root, 'A', 'both', 0
    if mode == 'headless':
        for _ in range(rng.randrange(1, 8)):
            target = node(target, box=(0, 600, 450, 1000))
    if mode in ('nested', 'partial_heading'):
        target = root
        for _ in range(rng.randrange(1, 5)):
            target = node(target, box=(0, 600, 450, 1100))
        owner = 'B'
        if mode == 'nested':
            node(target, heading, (0, 650, 220, 690))
        ocr.append((heading, 0, 650, 220, 690))
    if mode in ('flat_repeat', 'ambiguous_broad', 'cross_source'):
        owner = 'B'
        source = 'ocr' if mode == 'cross_source' else 'both'
        if mode != 'cross_source':
            node(root, heading, (0, 650, 220, 690))
        ocr.append((heading, 0, 650, 220, 690))
    if mode in ('siblings', 'split_binding'):
        target, owner, x = other, 'B', 500
    if mode in ('native_geometry_disagreement', 'ocr_geometry_disagreement'):
        child = node(root, box=(0, 600, 450, 1000))
        node(child, heading, (0, 650, 220, 690))
        ocr.append((heading, 0, 650, 220, 690))
        owner, source = 'B', 'native' if mode == 'native_geometry_disagreement' else 'both'
    if mode == 'split_row_heading':
        # Label and value share a native row, but a visible heading separates them.
        for item in list(root):
            if item.get('text') == '收款方：shop-A':
                root.remove(item)
        ocr[:] = [item for item in ocr if item[0] != '收款方：shop-A']
        facts.remove(('A', '收款方：shop-A', True))
        row = node(root, box=(0, 200, 450, 590))
        node(row, '收款方', (0, 210, 90, 240))
        node(row, heading, (0, 260, 220, 290))
        node(row, 'shop-A', (110, 310, 330, 345))
        ocr.extend([('收款方', 0, 210, 90, 240), (heading, 0, 260, 220, 290),
                    ('shop-A', 110, 310, 330, 345)])
    if mode == 'broad':
        source = rng.choice(('native', 'ocr', 'both'))
    if mode == 'ambiguous_broad':
        ocr.append((heading, 0, 0, 200, 40))  # Duplicate image occurrence cannot manufacture a section.
    if mode == 'ocr_status':
        source = 'ocr'
    if mode == 'crossing_status':
        # A visible child section intersects, but does not contain, OCR status.
        child = node(root, box=(100, 600, 450, 1000))
        node(child, heading, (100, 650, 320, 690))
        ocr.append((heading, 100, 650, 320, 690))
        owner, source = 'unresolved', 'ocr'
    box = None
    if mode == 'zero_area_status': box = (100, 800, 100, 800)
    if mode == 'offviewport_status': box = (1100, 800, 1320, 835)
    if mode == 'incoherent_parent_status':
        target = node(root, box=(500, 700, 900, 1000))
    if mode.startswith('ocr_overlay_'):
        source = 'ocr'
        status = '支付状态：' + ('已支付' if mode.endswith('_paid') else '未支付')
    if mode == 'override_offscreen': box = (0, 1100, 220, 1135)
    if mode == 'rotation_offscreen': box = (0, 1100, 220, 1135)
    if mode == 'rotation_coherent': box = (1150, 800, 1370, 835)
    initial = mode in CONTROL_MODES and mode.endswith('_initial')
    if not initial:
        emit(target, status, 800 + rng.randrange(0, 4) * 10, owner, source, x, box)
    if mode == 'disagreement':
        emit(root, '支付状态：未支付' if status.endswith('已支付') else '支付状态：已支付',
             850, source='ocr')
    # These labels are known charge-capable inputs, assigned before parsing.
    # Their validity never comes from the implementation's recognizer or flags.
    controls = []
    if mode not in CONTROL_MODES or '_extra_' in mode:
        button_box = (0, min(viewport[1] - 60, 1200), 220, min(viewport[1] - 10, 1250))
        node(root, '确认付款', button_box)
        if rng.getrandbits(1):
            ocr.append(('确认付款', *button_box))
        controls.append(True)
    if mode in CONTROL_MODES:
        kind = mode.split('_')[1]
        label = rng.choice(('立即购买', '提交订单', '确认付款', '免密支付'))
        parent, bad_box = root, (500, 1100, 800, 1150)
        if kind == 'ocr' and '_extra_' in mode:
            label = rng.choice(('立即购买', '提交订单', '免密支付'))
            bad_box = (0, 1200, 220, 1250)  # Unbound visible overlay covers the native control.
        if kind == 'zero': bad_box = (500, 1100, 500, 1100)
        if kind == 'offscreen': bad_box = (1100, 1100, 1320, 1150)
        if kind == 'incoherent': parent = node(root, box=(0, 1000, 450, 1300))
        if kind == 'unbound':
            parent = node(root, box=(500, 1000, 950, 1300))
            node(parent, '订单详情', (500, 1010, 720, 1045))
        if kind != 'ocr': node(parent, label, bad_box)
        if kind == 'ocr' or rng.getrandbits(1):
            ocr.append((label, *bad_box))
        controls.append(False)
    # Tree order and OCR response order are independent of visible geometry.
    for parent in list(h.iter('node')):
        children = list(parent)
        rng.shuffle(children)
        parent[:] = children
    rng.shuffle(ocr)
    positive = mode in ('plain', 'broad', 'headless', 'mixed_binding',
                        'override_coherent', 'rotation_coherent') and all(f[2] for f in facts)
    return Case(seed, mode, ET.tostring(h), ocr, facts, positive, tuple(controls),
                viewport, cached_size, capture_size)


async def parse(case):
    viewport = getattr(case, 'viewport', (1000, 1400))
    with patch.object(server, '_observation', return_value=hierarchy(case.xml, viewport)):
        native = server._tree()
    async def seen():
        return native + case.ocr
    async def direct(function, *args):
        return function(*args)
    capture_size = getattr(case, 'capture_size', viewport)
    guard = SimpleNamespace(native_nodes=native, shown=case.ocr, png=frame(capture_size),
                            app_namespace='com.aliyun.tongyi',
                            size=getattr(case, 'cached_size', viewport),
                            capture_unresolved=capture_size != viewport, _seen=seen)
    with patch.object(server, '_at_checkout', return_value=True), \
         patch.object(server.asyncio, 'to_thread', direct):
        return await server._payment_screen(guard)


class PaymentObservationProperties(unittest.TestCase):
    def test_preserved_observations(self):
        async def run():
            for record in json.loads(FIXTURE.read_text()):
                case = SimpleNamespace(xml=record['xml'].encode(), ocr=[tuple(row) for row in record['ocr']],
                    **{key: tuple(record.get(key, (1000, 1400)))
                       for key in ('viewport', 'cached_size', 'capture_size')})
                screen = await parse(case)
                evidence = screen.evidence()
                self.assertEqual(evidence.state, record['expected'], record['seed'])
                if record['expected'] == 'unknown':
                    self.assertFalse(evidence.non_debit_signs, record['seed'])
                binding = PaymentBinding('order-A', 'shop-A', 1660, 'com.aliyun.tongyi',
                    (('name', '柠檬茶'), ('spec', '中杯'), ('quantity', '1')),
                    (('name', '柠檬茶'), ('quantity', '1'), ('spec', '中杯')))
                self.assertEqual(screen.reconciliation(binding)['state'], record['expected'], record['seed'])
        asyncio.run(run())

    def test_seeded_ownership_properties(self):
        async def run():
            counts, failures, positives = Counter(), [], 0
            fixtures = json.loads(FIXTURE.read_text()) if FIXTURE.exists() else []
            for seed in sorted(set(range(4096)) | {f['seed'] for f in fixtures}):
                case = generate(seed)
                screen = await parse(case)
                expected, evidence = case.oracle(), screen.evidence()
                binding = PaymentBinding('order-A', 'shop-A', 1660, 'com.aliyun.tongyi',
                                         (('name', '柠檬茶'), ('spec', '中杯'), ('quantity', '1')),
                                         (('name', '柠檬茶'), ('quantity', '1'), ('spec', '中杯')))
                result = screen.reconciliation(binding)['state']
                counts[case.mode] += 1
                positives += case.positive
                if case.mode in CONTROL_MODES or case.capture_size != case.viewport:
                    self.assertTrue(screen.scope_unresolved, (seed, case.mode))
                    self.assertEqual(evidence.state, 'unknown', (seed, case.mode))
                    self.assertFalse(evidence.non_debit_signs, (seed, case.mode))
                if any(text in BASE and not grounded for _, text, grounded in case.facts):
                    observed_binding = PaymentBinding(screen.order_id, screen.payee, screen.amount_fen,
                        screen.order_namespace, screen.item_identity, screen.item_facts)
                    self.assertFalse(observed_binding.complete, (seed, case.mode))
                unsafe = (evidence.state == 'paid' or bool(evidence.non_debit_signs) or result != 'unknown') and expected == 'unknown'
                lost = case.positive and (evidence.state != expected or result != expected)
                if unsafe or lost:
                    failures.append(dict(seed=seed, mode=case.mode, expected=expected,
                                         actual=evidence.state, reconciliation=result,
                                         xml=case.xml.decode(), ocr=case.ocr))
            self.assertEqual(len(failures), 0, json.dumps(failures[:5], ensure_ascii=False, indent=2))
            self.assertEqual(sum(counts.values()), 4096)
            self.assertEqual(len(counts), len(MODES))
            self.assertGreater(positives, 350)
        asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
