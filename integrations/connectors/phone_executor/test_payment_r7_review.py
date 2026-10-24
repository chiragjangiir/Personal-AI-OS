"""Review-r4 raw continuation/evidence regressions, using the shared isolated HTTP authority."""
import asyncio
from dataclasses import replace
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_payment_checkpoint as harness
from payment_checkpoint import PaymentCheckpoint
import server


CONTINUATIONS = (
    ('positive_navigation_then_one_charge', {}, {}),
    ('one_tap_charged_next_surface_has_no_receipt', {}, {'first_charged': True}),
    ('one_tap_charged_partial_debit_text', {'status': '已扣'}, {'first_charged': True}),
    ('one_tap_charged_debit_success_text', {'status': '扣款成功'}, {'first_charged': True}),
    ('one_tap_charged_partial_result_field', {'status': '支付结果：未'}, {'first_charged': True}),
    ('same_id_changed_total', {'amount': '18.60'}, {}),
    ('same_id_changed_payee', {'payee': 'shop-B'}, {}),
    ('same_id_changed_item_same_price', {'item': '另一种商品'}, {}),
    ('coupon_amount_decrease', {'amount': '14.60', 'item': '优惠券 -¥2'}, {}),
    ('delivery_fee_increase', {'amount': '18.60', 'item': '配送费 ¥2'}, {}),
    ('relabel_same_surface', {'title': '订单详情', 'label': '确认付款'}, {}),
    ('back_to_prior_surface_after_one_tap', {}, {'first_charged': True, 'back': True}),
    ('second_order_in_other_page', {'order': 'order-B'}, {}),
    ('other_page_same_alias_and_price_changed_item', {'item': '第二页不同商品'}, {}),
    ('read_timeout_between_inputs', {}, {'timeout': True}),
    ('grant_expired_between_inputs', {}, {'grant_expired': True}),
    ('three_surfaces_bound_to_two_inputs', {}, {'three_pages': True}),
    ('paid_evidence_arrives_during_step2_ack', {}, {'ack_status': '支付状态：已支付', 'first_charged': True}),
    ('ambiguous_evidence_arrives_during_step2_ack', {}, {'ack_status': '支付结果：未', 'first_charged': True}),
    ('different_item_during_step2_ack', {}, {'ack_changes': {'item': 'ack-window replacement'}}),
    ('back_to_order_detail_before_second_input', {'title': '订单详情'},
     {'initial_changes': {'title': '支付结果'}, 'first_charged': True}),
    ('coupon_new_payable_lower_than_old_visible_total', {'extra': ('实付 ¥14.60', '优惠券 -¥2')},
     {'actual_amount': 1460}),
)
EVIDENCE = (
    ('paid_plus_debit_failed', ('支付成功', '扣款状态：失败')),
    ('paid_plus_debit_partial', ('支付成功', '扣款结果：未')),
    ('paid_plus_debit_processing', ('支付成功', '扣款中')),
    ('paid_plus_debit_failure_bare', ('支付成功', '扣款失败')),
    ('paid_plus_charge_status_partial', ('支付成功', '交易状态：扣款中')),
    ('paid_plus_bare_processing', ('支付成功', '处理中')),
    ('historical_status_scoped_wrong', ('历史支付状态：已支付',)),
    ('historical_result_scoped_wrong', ('历史支付结果：成功',)),
    ('paid_plus_order_closed_alias', ('支付成功', '订单已关闭')),
    ('paid_plus_order_cancel_alias', ('支付成功', '订单已取消')),
    ('paid_plus_order_status_cancel', ('支付成功', '订单状态：已取消')),
    ('paid_plus_payment_failed_split', ('支付成功', '支付结果', '失败')),
)


async def parsed(title='订单详情', order='order-A', payee='shop-A', amount='16.60',
                 item='柠檬茶', label='立即购买', status=None, cashier=False, extra=(), native=True):
    # Explicit item fields replace the original unlabeled product, preserving every product mutation.
    texts = [title, '订单号：' + order, '总计 ¥' + amount, '收款方：' + payee,
             '商品名称：' + item, '规格：中杯', '数量：1', *extra]
    if label:
        texts.append(label)
    if status:
        texts.extend(status if isinstance(status, (list, tuple)) else [status])
    nodes = [(text, 0, i * 100, 200, i * 100 + 50) for i, text in enumerate(texts)]
    # Keep the grant/binding regressions active on native facts; retain their
    # original image-only projection separately as a future grounded candidate.
    guard = harness.observed_guard(nodes, '|'.join(texts).encode())
    if not native:
        guard.native_nodes = []
        guard._seen = mock.AsyncMock(return_value=nodes)
    with mock.patch.object(server, '_at_checkout', return_value=cashier):
        return await server._payment_screen(guard)


class ReviewR7(unittest.IsolatedAsyncioTestCase):
    # Reuse authority lifecycle/HTTP semantics without inheriting the original test methods.
    asyncSetUp = harness.CheckpointHTTP.asyncSetUp
    handle = harness.CheckpointHTTP.handle
    clock = harness.CheckpointHTTP.clock

    async def test_image_only_future_grounded_candidates_are_unknown(self):
        result, inputs, debits, cancel = await self.scenario(legitimate=True, image_only=True)
        self.assertFalse(result['success'], result)
        self.assertTrue(result['answer'].startswith('【付款结果不明】'), result)
        self.assertEqual((inputs, debits, self.calls), ([], [], []))
        cancel.assert_not_awaited()

    async def scenario(self, changes=None, *, first_charged=False, ack_status=None, ack_changes=None,
                       back=False, timeout=False, grant_expired=False, three_pages=False,
                       initial_changes=None, actual_amount=None, evidence=None, legitimate=False, image_only=False):
        self.config = replace(self.config, result_wait_s=.015 if timeout else 1, result_poll_s=.005)
        initial = await parsed(native=not image_only, **(initial_changes or {}))
        next_args = dict(title='支付结果', label='确认付款')
        if legitimate:
            next_args.update(title='订单详情', cashier=True, status='支付状态：未支付')
        next_args.update(changes or {})
        second = await parsed(native=not image_only, **next_args)
        if evidence is not None:
            second = await parsed(label=None, status=evidence, native=not image_only)
        receipt_args = {k: next_args[k] for k in ('item', 'order', 'payee', 'amount', 'extra') if k in next_args}
        receipt = await parsed(title='付款结果', label=None, status='支付状态：已支付', native=not image_only, **receipt_args)
        visible, inputs, debits = initial, [], []
        after_ack = None
        if ack_status or ack_changes:
            ack_args = dict(next_args, **(ack_changes or {}))
            if ack_status:
                ack_args['status'] = ack_status
            after_ack = await parsed(native=not image_only, **ack_args)

        async def ack(step):
            nonlocal visible
            if step == 2 and after_ack is not None:
                visible = after_ack
        self.on_tap = ack
        if grant_expired:
            self.grant_ttl = 1000  # Reach input 1 reliably before testing expiry between inputs.

        async def read():
            if len(inputs) == 1 and timeout:
                await asyncio.sleep(.03)
            return visible

        async def tap(*point):
            nonlocal visible
            self.events.append('input')
            inputs.append((visible, point))
            if first_charged or len(inputs) > 1:
                debits.append(actual_amount if actual_amount is not None else visible.amount_fen)
            visible = second if len(inputs) == 1 else initial if back or three_pages else receipt
            if grant_expired and len(inputs) == 1:
                await asyncio.sleep(1.1)

        cancel = mock.AsyncMock(return_value={'outcome': 'done'})
        result = await PaymentCheckpoint(self.client, read, tap, cancel, self.config).run('pi-A', 'job-A', '千问')
        return result, inputs, debits, cancel

    def assert_stopped(self, result, inputs, debits, cancel, *, first_charged=False, ack_consumed=False):
        self.assertFalse(result['success'], result)
        self.assertTrue(result['answer'].startswith('【付款结果不明】'), result)
        self.assertEqual(len(inputs), 1)
        self.assertEqual(len(debits), int(first_charged), 'No second debit may occur')
        self.assertEqual(self.calls[-1][1]['outcome'], 'unknown')
        self.assertEqual([body['step'] for path, body in self.calls if path.endswith('/tap')],
                         [1, 2] if ack_consumed else [1])
        self.assertEqual(self.events.count('open'), 1)
        self.assertNotIn('amount-changed', self.events)
        cancel.assert_not_awaited()

    async def test_explicit_unpaid_forward_transition_then_one_charge(self):
        result, inputs, debits, cancel = await self.scenario(legitimate=True)
        self.assertTrue(result['success'], result)
        self.assertEqual(len(inputs), 2)
        self.assertEqual(debits, [1660])
        self.assertEqual(self.calls[-1][1]['outcome'], 'paid')
        cancel.assert_not_awaited()


def continuation_test(changes, options):
    async def test(self):
        values = await self.scenario(changes, **options)
        self.assert_stopped(*values, first_charged=options.get('first_charged', False))
    return test


def evidence_test(statuses):
    async def test(self):
        self.assert_stopped(*await self.scenario(evidence=statuses, first_charged=True), first_charged=True)
    return test


def ack_test(changes):
    async def test(self):
        self.assert_stopped(*await self.scenario(legitimate=True, **changes), ack_consumed=True)
    return test


for name, changes, options in CONTINUATIONS:
    setattr(ReviewR7, 'test_r4_' + name, continuation_test(changes, options))
for name, statuses in EVIDENCE:
    setattr(ReviewR7, 'test_r4_' + name, evidence_test(statuses))
for name, changes in (
        ('paid', {'ack_status': '支付状态：已支付'}),
        ('ambiguous', {'ack_status': '支付结果：未'}),
        ('item', {'ack_changes': {'item': 'ack-window replacement'}})):
    setattr(ReviewR7, 'test_unpaid_forward_ack_' + name, ack_test(changes))

if __name__ == '__main__':
    unittest.main(verbosity=2)
