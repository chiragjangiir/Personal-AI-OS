"""Raw UI scopes through the parser, evidence authority and HTTP workflow."""
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_payment_checkpoint as harness
from payment_checkpoint import CheckpointConfig, PaymentBinding, PaymentCheckpoint, PaymentError, PaymentHTTPClient


PARSER_CASES = (
    ('other_order_paid', ('其他订单支付状态：已支付',)),
    ('previous_transaction_paid', ('上笔交易状态：成功',)),
    ('order_B_scoped_paid', ('order-B支付状态：已支付',)),
    ('preview_example_paid', ('示例支付状态：已支付',)),
    ('historical_paid', ('历史支付状态：已支付',)),
    ('paid_debit_processing', ('支付成功', '扣款中')),
    ('two_payable_totals', ('支付成功', '实付 ¥14.60')),
    ('second_order_id', ('支付成功', '订单号：order-B')),
    ('conflicting_item_sku', ('支付成功', 'SKU：sku-B')),
    ('changed_item_quantity', ('支付成功', '数量：2')),
    ('paid_and_partial_debit', ('支付成功', '已扣')),
    ('empty_payment_field', ('支付成功', '支付状态：')),
    ('paid_and_unpaid', ('支付成功', '支付状态：未支付')),
    ('paid_and_unknown_order_field', ('支付成功', '订单状态：未知')),
    ('current_plain_paid', ('支付状态：已支付',)),
)
BRIDGE_CASES = (
    ('other_order_unpaid', ('其他订单支付状态：未支付',)),
    ('not_this_order_unpaid', ('非本单付款状态：未付款',)),
    ('other_order_order_state', ('另一订单订单状态：待付款',)),
    ('historical_previous_order_paid', ('前一单支付状态：已支付',)),
    ('historical_prior_transaction_paid', ('上笔支付结果：成功',)),
    ('partial_paid_word', ('支付状态：未支付', '已支')),
)


async def parsed(extra=(), *, title='订单详情', cashier=False, label='确认付款'):
    texts = [title, '订单号：order-A', '收款方：shop-A', '总计 ¥16.60',
             'SKU：sku-A', '数量：1', *extra]
    if label:
        texts.append(label)
    return await harness.parsed_screen(texts, cashier=cashier)


def binding(screen):
    return PaymentBinding(screen.order_id, screen.payee, screen.amount_fen,
                          screen.order_namespace, screen.item_identity, screen.item_facts)


class PaymentScope(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = harness.CheckpointHTTP.asyncSetUp
    handle = harness.CheckpointHTTP.handle
    clock = harness.CheckpointHTTP.clock

    async def scenario(self, statuses, *, continuation=False, ack_foreign=False, before=False, first_debited=True):
        self.config = replace(self.config, result_wait_s=.025, result_poll_s=.002)
        initial = await parsed()
        after = await parsed(statuses, title='支付结果' if continuation else '订单详情',
                             cashier=continuation, label='确认付款' if continuation else None)
        receipt = await parsed(('支付状态：已支付',), title='付款结果', label=None)
        current, inputs, debits = after if before else initial, [], []

        async def ack(step):
            nonlocal current
            if step == 2 and ack_foreign:
                current = await parsed(('其他订单支付状态：未支付',), title='支付结果', cashier=True)
        self.on_tap = ack

        async def read():
            return replace(current, read_at=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'))

        async def tap(*point):
            nonlocal current
            inputs.append(point)
            # Unsafe cases model a first tap which already debited. Positive controls open a cashier.
            if len(inputs) > 1 or (first_debited and (ack_foreign or not continuation or statuses != ('支付状态：未支付',))):
                debits.append(1660)
            current = after if len(inputs) == 1 else receipt

        cancel = mock.AsyncMock(return_value={'outcome': 'done'})
        result = await PaymentCheckpoint(self.client, read, tap, cancel, self.config).run('pi-A', 'job-A', '千问')
        self.assertEqual(cancel.await_count, 0, (result, self.calls))
        writes = [body['step'] for path, body in self.calls if path.endswith('/tap')]
        return result, inputs, debits, writes

    def assert_unknown(self, values, *, writes=(1,), inputs=1, debits=1):
        result, attempts, effects, consumed = values
        self.assertFalse(result['success'], result)
        self.assertTrue(result['answer'].startswith('【付款结果不明】'), result)
        self.assertEqual(len(attempts), inputs)
        self.assertEqual(len(effects), debits, 'No second debit may occur')
        self.assertEqual(consumed, list(writes))
        if inputs:
            self.assertEqual(self.calls[-1][1]['outcome'], 'unknown')
        else:
            self.assertEqual(self.calls, [])

    async def test_ack_valid_unpaid_becomes_foreign_after_both_write_aheads(self):
        self.assert_unknown(await self.scenario(('支付状态：未支付',), continuation=True, ack_foreign=True),
                            writes=(1, 2), debits=1)

    async def test_unresolved_before_first_write_ahead_dispatches_nothing(self):
        self.assert_unknown(await self.scenario(('其他订单支付状态：未支付',), before=True),
                            writes=(), inputs=0, debits=0)

    async def test_supported_current_scopes_and_plain_values(self):
        screen = await parsed()
        for title in ('订单详情', '支付结果', '付款结果'):
            for text in ('支付状态：已支付', '本单支付结果：成功', '当前订单付款状态：已付款', '支付成功'):
                with self.subTest(title=title, text=text):
                    evidence = replace(screen, page_title=title, payment_statuses=(text,), status_fields=None).evidence(binding(screen))
                    self.assertEqual(evidence.state, 'paid')
                    self.assertEqual(evidence.signs, (text,))
            for text in ('支付状态：未支付', '本单付款状态：未付款', '当前订单订单状态：待付款', '待支付'):
                with self.subTest(title=title, text=text):
                    evidence = replace(screen, page_title=title, payment_statuses=(text,), status_fields=None).evidence()
                    self.assertEqual(evidence.state, 'unpaid')
                    self.assertEqual(evidence.non_debit_signs, (text,))

    async def test_supported_unpaid_forward_transition_then_one_debit(self):
        result, inputs, debits, writes = await self.scenario(('支付状态：未支付',), continuation=True)
        self.assertTrue(result['success'], result)
        self.assertEqual((len(inputs), len(debits), writes), (2, 1, [1, 2]))
        self.assertEqual(self.calls[-1][1]['outcome'], 'paid')

    async def test_complete_original_binding_required_with_receipt_omissions(self):
        screen = await parsed(('支付状态：已支付',))
        original = binding(screen)
        receipt = replace(screen, payee=None, amount_fen=None, item_identity=(), item_facts=())
        self.assertEqual(receipt.evidence(original).state, 'unknown')
        self.assertEqual(receipt.evidence().state, 'unknown')
        for field, empty in (('order_id', None), ('order_namespace', None), ('payee', None),
                             ('amount_fen', None), ('item_identity', ())):
            with self.subTest(field=field):
                self.assertEqual(screen.evidence(replace(original, **{field: empty})).state, 'unknown')
        for changes in ({'order_id': 'order-B'}, {'order_namespace': 'other.app'}, {'payee': 'shop-B'},
                        {'amount_fen': 1460}, {'item_identity': (('sku', 'sku-B'),)},
                        {'page_title': '订单历史'}, {'payee_conflict': True}, {'amount_conflict': True},
                        {'item_conflict': True}):
            with self.subTest(changes=changes):
                self.assertEqual(replace(screen, **changes).evidence(original).state, 'unknown')

    async def test_unknown_prefixes_and_truncations_never_gain_positive_scope(self):
        screen = await parsed()
        # Novel prefixes prevent a finite history denylist from satisfying the contract.
        for prefix in ('陌生字段/7:', 'Zeta-42 ', '任意备注→', '当前订单示例', '本单以外'):
            for value in ('支付状态：已支付', '付款结果：成功', '支付状态：未支付'):
                text = prefix + value
                with self.subTest(text=text):
                    evidence = replace(screen, payment_statuses=(text,), status_fields=None).evidence()
                    self.assertEqual(evidence.state, 'unknown')
                    self.assertEqual((evidence.signs, evidence.non_debit_signs), ((), ()))
                    self.assertIn(text, evidence.statuses)
        for fragment in ('已支', '已付', '已扣', '支付状', '付款结'):
            with self.subTest(fragment=fragment):
                evidence = replace(screen, payment_statuses=('支付状态：未支付', fragment), status_fields=None).evidence()
                self.assertEqual(evidence.state, 'unknown')
                self.assertEqual(evidence.non_debit_signs, ())


def parser_case(name, statuses):
    async def test(self):
        screen = await parsed(statuses, label=None)
        evidence = screen.evidence()
        if name == 'current_plain_paid':
            self.assertEqual(evidence.state, 'paid')
            result, inputs, debits, writes = await self.scenario(statuses, first_debited=False)
            self.assertTrue(result['success'], result)
            self.assertEqual((len(inputs), len(debits), writes), (1, 0, [1]))
            self.assertEqual(self.calls[-1][1]['outcome'], 'paid')
        else:
            self.assertEqual(evidence.state, 'unknown')
            self.assertEqual((evidence.signs, evidence.non_debit_signs), ((), ()))
            self.assert_unknown(await self.scenario(statuses, first_debited=False), debits=0)
    return test


def bridge_case(statuses):
    async def test(self):
        self.assert_unknown(await self.scenario(statuses, continuation=True))
    return test


for name, statuses in PARSER_CASES:
    setattr(PaymentScope, 'test_parser_' + name, parser_case(name, statuses))
for name, statuses in BRIDGE_CASES:
    setattr(PaymentScope, 'test_bridge_' + name, bridge_case(statuses))


class ActualAuthorityScope(unittest.IsolatedAsyncioTestCase):
    """Reuse the recovery test's real INT HTTP fixture; never duplicate its authority."""
    scenario = PaymentScope.scenario
    assert_unknown = PaymentScope.assert_unknown

    async def asyncSetUp(self):
        import test_payment_recovery
        self.recovery = test_payment_recovery.Recovery
        await self.recovery.asyncSetUp(self)
        self.config = replace(CheckpointConfig(), poll_wait_ms=10)

    def stop(self):
        self.recovery.stop(self)

    async def authority(self, operation, **body):
        return await self.recovery.authority(self, operation, **body)

    async def test_raw_foreign_and_truncated_scope_cases_through_current_authority(self):
        owner = self
        class Client(PaymentHTTPClient):
            async def request(self, method, path, body=None, timeout_s=None):
                if path == '/checkpoints':
                    body = dict(body, intent_id=owner.intent)
                try:
                    value = await super().request(method, path, body, timeout_s)
                except PaymentError as exc:
                    owner.fail((exc.code, path, body))
                owner.calls.append((path, body))
                if path == '/checkpoints':
                    await owner.authority('confirm', payment_id=value['payment_id'])
                if path.endswith('/tap'):
                    await owner.on_tap(body['step'])
                return value
        self.client = Client(self.url, 'fixture-key', self.config)
        for name, statuses, continuation, ack in [
                *((name, texts, True, False) for name, texts in BRIDGE_CASES),
                *((name, texts, False, False) for name, texts in PARSER_CASES),
                ('ack_foreign', ('支付状态：未支付',), True, True)]:
            with self.subTest(case=name):
                self.calls = []
                self.intent = (await self.authority('request'))['intent_id']
                values = await self.scenario(statuses, continuation=continuation, ack_foreign=ack,
                                             first_debited=continuation)
                if name == 'current_plain_paid':
                    self.assertTrue(values[0]['success'], values)
                    self.assertEqual((len(values[1]), values[3]), (1, [1]))
                else:
                    self.assert_unknown(values, writes=(1, 2) if ack else (1,),
                                        debits=0 if not continuation else 1)
                state = await self.authority('state')
                payment = next(p for p in state['cards'] if p['intent_id'] == self.intent)
                self.assertEqual(payment['state'], 'paid' if name == 'current_plain_paid' else 'outcome_unknown')

if __name__ == '__main__':
    unittest.main(verbosity=2)
